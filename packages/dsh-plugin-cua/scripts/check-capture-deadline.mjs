/**
 * Prove that a wedged screen capture cannot hang the engine forever.
 *
 * ScreenCaptureKit's worst failure is not an error: the call stops answering
 * and never returns. Measured on macOS 26.6.2, one such capture blocked every
 * subsequent capture in every process on the machine — the host's long-lived
 * engine and a freshly spawned one alike — until the wedged process was killed,
 * with the engine spinning at ~19% CPU meanwhile.
 *
 * The real wedge cannot be provoked on demand, so the engine simulates one when
 * `CUA_ENGINE_SIMULATE_WEDGED_CAPTURE` is set: it behaves exactly like the
 * wedged call by never returning. This asserts the engine's watchdog fires,
 * within the advertised bound plus a margin, and that it exits with the
 * documented status instead of hanging.
 *
 * Usage: `node scripts/check-capture-deadline.mjs`
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const enginePath = join(packageRoot, 'lib', 'bin', 'cua-engine')

/** The engine exits with this status when the capture watchdog fires (`_exit(75)`). */
const ABORT_STATUS = 75

/** The engine's own advertised bound, padded for process startup and scheduling. */
const EXPECTED_ABORT_MS = 12_000
const MARGIN_MS = 8_000

const failures = []
let checks = 0

/** Record one assertion. */
function check(condition, label, detail = '') {
  checks += 1
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return true
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
  return false
}

if (!existsSync(enginePath)) {
  process.stderr.write(`the engine is missing at ${enginePath}; run \`pnpm run build:engine\` first\n`)
  process.exit(1)
}

process.stdout.write('capture deadline check\n')

/** Run one wedged capture and report how long the engine took to stop. */
function wedgedCapture() {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now()
    const child = spawn(enginePath, ['--call', 'capture.screenshot', '--params', '{"maxWidth":200}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CUA_ENGINE_SIMULATE_WEDGED_CAPTURE: '1' },
    })
    let stderr = ''
    // A bound well past the watchdog: if this fires, the watchdog did not.
    const hardStop = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`the engine was still running after ${String(Date.now() - started)}ms — the watchdog never fired`))
    }, EXPECTED_ABORT_MS + MARGIN_MS + 20_000)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(hardStop); rejectPromise(error) })
    child.on('close', (code, signal) => {
      clearTimeout(hardStop)
      resolvePromise({ elapsedMs: Date.now() - started, code, signal, stderr })
    })
  })
}

let outcome
try {
  outcome = await wedgedCapture()
} catch (error) {
  check(false, 'a wedged capture stops the engine', String(error))
  process.stdout.write(`\n${String(checks - failures.length)}/${String(checks)} checks passed\n`)
  process.exit(1)
}

check(outcome.signal === null, 'the engine stops by itself rather than being killed', `signal ${String(outcome.signal)}`)
check(
  outcome.code === ABORT_STATUS,
  `the engine exits with the documented watchdog status ${String(ABORT_STATUS)}`,
  `exit code ${String(outcome.code)}`,
)
check(
  outcome.elapsedMs < EXPECTED_ABORT_MS + MARGIN_MS,
  'the watchdog fires within the advertised bound',
  `took ${String(outcome.elapsedMs)}ms for a ${String(EXPECTED_ABORT_MS)}ms bound`,
)
check(
  outcome.elapsedMs >= EXPECTED_ABORT_MS / 2,
  'the watchdog does not fire early',
  `took ${String(outcome.elapsedMs)}ms`,
)
check(
  outcome.stderr.includes('ScreenCaptureKit stopped responding')
    || outcome.stderr.includes('did not finish within'),
  'the engine explains why it stopped, on stderr',
  outcome.stderr.trim().slice(0, 200),
)

process.stdout.write(`\n${String(checks - failures.length)}/${String(checks)} checks passed\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
