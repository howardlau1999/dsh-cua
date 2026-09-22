/**
 * Write authorization for operating-system actions.
 *
 * The plugin draws one line: **reads are free, writes are gated**. A read
 * (status, app and window listing, accessibility tree, screenshot) only observes
 * the machine, is already gated by macOS itself, and gating it would make the
 * perceive/act loop unusable. A write — synthesizing pointer or keyboard input,
 * performing an accessibility action, or driving another application — changes
 * state on the user's desktop, so it passes through `ctx.approval` first.
 *
 * The gate fails closed: a missing approval service, a rejected answer, or a
 * withdrawn request all block the action.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { WriteApprovalMode } from './config.ts'

/**
 * The slice of the approval service this plugin calls.
 *
 * Declared locally rather than imported: the plugin depends on the approval
 * *capability*, reached through `ctx.get`, so a deployment without it must fail
 * closed at runtime instead of failing to load at all. The shape is the
 * documented `ApprovalService.request` contract.
 */
interface ApprovalCapability {
  request(request: {
    readonly agent: NonNullable<ToolExecution['agent']>
    readonly toolName: string
    readonly callId?: ToolExecution['callId']
    readonly reason?: string
    readonly signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** One session's granted write tools, keyed by session and tool name. */
const sessionGrants = new WeakMap<object, Set<string>>()

/** Operations the plugin treats as writes, for documentation and gating. */
export const WRITE_OPERATIONS: readonly string[] = [
  'cua_click',
  'cua_type',
  'cua_key',
  'cua_element',
  'cua_app',
]

/** What one approval decision was based on, for the audit trail. */
export interface WriteGateOptions {
  /** Configured mode. */
  readonly mode: WriteApprovalMode
  /** The plugin context, used to reach the approval service. */
  readonly ctx: Context
  /** The executing tool call. */
  readonly exec: ToolExecution
  /** One sentence the user sees, naming the concrete action and its target. */
  readonly reason: string
}

/**
 * Authorize one write, or throw a model-visible refusal.
 *
 * @param options - mode, context, execution, and the human-readable reason.
 * @throws Error when the action is not authorized; the message is written for
 * the model, so it says what was refused and what would unblock it.
 */
export async function requireWriteApproval(options: WriteGateOptions): Promise<void> {
  const { mode, ctx, exec, reason } = options
  if (mode === 'never') return

  const agent = exec.agent
  if (agent === undefined) {
    // No agent means no session to ask, so there is no one to authorize it.
    throw new Error(`refused to run ${exec.name}: no session is attached to this call, so its write cannot be authorized`)
  }

  if (mode === 'session') {
    const granted = sessionGrants.get(agent)
    if (granted?.has(exec.name) === true) return
  }

  const approval = ctx.get('approval') as ApprovalCapability | undefined
  if (approval === undefined) {
    throw new Error(
      `refused to run ${exec.name}: no approval service is mounted, so this write cannot be authorized. `
        + 'Set writeApproval: "never" in the plugin configuration to run writes without asking.',
    )
  }

  const outcome = await approval.request({
    agent,
    toolName: exec.name,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome === 'allowed-once') {
    if (mode === 'session') {
      const granted = sessionGrants.get(agent) ?? new Set<string>()
      granted.add(exec.name)
      sessionGrants.set(agent, granted)
    }
    return
  }

  const explanation = outcome === 'rejected'
    ? 'the user rejected it'
    : outcome === 'cancelled'
      ? 'the request was withdrawn'
      : 'no approver was available to answer'
  throw new Error(
    `refused to run ${exec.name}: ${explanation}. `
      + 'The operating system was not touched. If the session cannot prompt, set writeApproval: "never" '
      + 'in the plugin configuration to run writes without asking.',
  )
}
