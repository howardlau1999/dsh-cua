/**
 * Client for the `cua-engine` native helper.
 *
 * The engine is a long-lived child process speaking one JSON object per line in
 * both directions. It is kept alive between calls because each request may need
 * state from the previous one — an accessibility snapshot addressed by index, a
 * window id discovered a moment ago — and because process start plus first AX
 * query dominates the latency of a small action.
 *
 * @module
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

/** One request to the engine. */
export interface EngineRequest {
  readonly method: string
  readonly params?: Record<string, unknown>
  /** Per-call deadline in milliseconds. */
  readonly timeoutMs?: number
  /** Cancellation from the tool pipeline. */
  readonly signal?: AbortSignal
}

/** A structured engine failure, preserving the engine's own error code. */
export class EngineError extends Error {
  /** Protocol error code such as `permission_denied` or `not_found`. */
  readonly code: string
  /** Extra engine-supplied fields, such as the System Settings pane to open. */
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.details = details
  }
}

/** A pending request awaiting its response line. */
interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  cleanup(): void
}

/** How long an idle engine stays resident before it exits on its own. */
const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60_000

/** Default per-call deadline; a hung accessibility query must not hang the turn. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Client options resolved from plugin configuration. */
export interface EngineClientOptions {
  /** Absolute path to the engine executable. */
  readonly executablePath: string
  /** Extra arguments passed at startup. */
  readonly args?: readonly string[]
  /** Idle shutdown window; `0` keeps the engine alive for the whole session. */
  readonly idleShutdownMs?: number
}

/**
 * Owns one engine child process and multiplexes requests over its stdio.
 *
 * Requests are strictly request/response on a single pipe: two calls in flight
 * would interleave responses, so a `chain` serializes them. That matches the
 * engine's own model — it answers on the main thread, one request at a time —
 * and means a slow accessibility walk delays the next call rather than
 * corrupting the stream.
 */
export class EngineClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private pending = new Map<string, Pending>()
  private nextId = 0
  private chain: Promise<unknown> = Promise.resolve()
  private idleTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(private readonly options: EngineClientOptions) {}

  /** The configured executable path, for diagnostics. */
  get executablePath(): string {
    return this.options.executablePath
  }

  /** Whether a live child process currently exists. */
  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed
  }

  /**
   * Send one request and await its result.
   *
   * @param request - method, params, and an optional deadline.
   * @returns the engine's `result` payload.
   * @throws EngineError for an engine-reported failure, or a plain Error when
   * the process cannot be started or dies mid-request.
   */
  async request<T = Record<string, unknown>>(request: EngineRequest): Promise<T> {
    if (this.closed) throw new Error('the cua engine client is closed')
    if (request.signal?.aborted) throw new Error('the cua engine request was aborted before it started')
    const run = this.chain.then(
      () => this.dispatch<T>(request),
      () => this.dispatch<T>(request),
    )
    // Keep the chain reject-free so one failed call cannot poison later ones.
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Terminate the child process and reject anything still in flight. */
  close(): void {
    this.closed = true
    this.clearIdleTimer()
    const child = this.child
    this.child = undefined
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`the cua engine exited before answering request ${id}`))
    }
    this.pending.clear()
    child?.kill('SIGTERM')
  }

  private async dispatch<T>(request: EngineRequest): Promise<T> {
    const child = this.ensureChild()
    const id = `r${this.nextId++}`
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const payload = JSON.stringify({ id, method: request.method, params: request.params ?? {} })

    const result = new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.settle(id, () => reject(new Error(`the cua engine call "${request.method}" was cancelled`)))
      }
      const timer = setTimeout(() => {
        this.settle(id, () => reject(new Error(
          `the cua engine did not answer "${request.method}" within ${timeoutMs}ms`,
        )))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
        cleanup: () => request.signal?.removeEventListener('abort', onAbort),
      })
      request.signal?.addEventListener('abort', onAbort, { once: true })
    })

    this.clearIdleTimer()
    child.stdin.write(`${payload}\n`)
    try {
      return await result
    } finally {
      this.scheduleIdleShutdown()
    }
  }

  /** Resolve one pending request exactly once and drop its listeners. */
  private settle(id: string, settle: (pending: Pending) => void): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.cleanup()
    settle(pending)
  }

  /** Start the child process if it is not already running. */
  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.running) return this.child as ChildProcessWithoutNullStreams
    if (!existsSync(this.options.executablePath)) {
      throw new Error(
        `the cua engine binary is missing at ${this.options.executablePath}; `
          + 'build it with `pnpm run build:engine` inside the plugin package',
      )
    }
    const child = spawn(this.options.executablePath, [...(this.options.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // The engine talks to AppKit and the window server; inheriting the host's
      // environment is what makes it inherit the host's TCC grants.
      env: process.env,
    })
    this.child = child

    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => this.handleLine(line))

    const errors = createInterface({ input: child.stderr })
    errors.on('line', line => {
      if (line.trim() !== '') process.stderr.write(`[dsh-cua] engine: ${line}\n`)
    })

    child.on('error', error => this.failAll(new Error(`the cua engine could not be started: ${error.message}`)))
    child.on('exit', (code, signal) => {
      this.child = undefined
      const detail = signal === null ? `exit code ${code}` : `signal ${signal}`
      this.failAll(new Error(`the cua engine stopped (${detail})`))
    })
    return child
  }

  /** Route one response line to its pending request. */
  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    let decoded: { id?: unknown, result?: unknown, error?: { code?: unknown, message?: unknown } }
    try {
      decoded = JSON.parse(trimmed) as typeof decoded
    } catch {
      process.stderr.write(`[dsh-cua] ignoring unparsable engine line: ${trimmed.slice(0, 200)}\n`)
      return
    }
    const id = typeof decoded.id === 'string' ? decoded.id : undefined
    if (id === undefined) return
    if (decoded.error !== undefined) {
      const code = typeof decoded.error.code === 'string' ? decoded.error.code : 'unknown'
      const message = typeof decoded.error.message === 'string' ? decoded.error.message : 'the cua engine reported a failure'
      const details: Record<string, unknown> = { ...decoded.error }
      delete details.code
      delete details.message
      this.settle(id, pending => pending.reject(new EngineError(code, message, details)))
      return
    }
    this.settle(id, pending => pending.resolve(decoded.result))
  }

  /** Reject every in-flight request; used when the process goes away. */
  private failAll(error: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.settle(id, () => pending.reject(error))
    }
  }

  private scheduleIdleShutdown(): void {
    const idle = this.options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS
    if (idle <= 0 || this.pending.size > 0) return
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      // Nothing is in flight by construction: any request clears this timer.
      this.child?.kill('SIGTERM')
      this.child = undefined
    }, idle)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }
}
