/**
 * Run the plugin's whole verification sequence in order.
 *
 * Each stage catches a different class of defect, and they are ordered cheapest
 * first: types, then the schemas the harness will validate against, then the
 * real engine.
 *
 * 0. `swift test` — the engine's pure decision logic: coordinate conversion,
 *    region clipping, and application ranking. No permissions, no desktop.
 *    macOS only: there is no Swift toolchain for the Windows backend.
 * 1. `tsc --noEmit` — the plugin's own types.
 * 2. `check-schemas` — every tool's parameter and output schema, validated with
 *    the harness's own validator.
 * 3. `check-mcp-catalog` — the catalog the engine publishes over MCP, validated
 *    the same way, and compared against the TypeScript one so the two
 *    integration paths cannot drift.
 * 4. `capture deadline` — a wedged screen capture aborts the engine instead of
 *    hanging it forever, which is the one failure that takes the machine's
 *    whole capture path down with it. macOS only: the wedge is a
 *    ScreenCaptureKit behaviour, and the Windows engine has no such watchdog
 *    because GDI capture does not stop answering.
 * 5. `smoke` — the built bundle loaded and every tool invoked against the real
 *    engine.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Stage shape: label, command, args, and the platform it applies to. */
const STAGES = [
  ['engine unit tests', process.execPath, [join(packageRoot, 'scripts', 'test-swift.mjs')], 'darwin'],
  ['types', process.execPath, [join(packageRoot, 'scripts', 'typecheck.mjs')]],
  ['tool schemas', process.execPath, [join(packageRoot, 'scripts', 'check-schemas.mjs')]],
  ['engine MCP catalog', process.execPath, [join(packageRoot, 'scripts', 'check-mcp-catalog.mjs')]],
  ['capture deadline', process.execPath, [join(packageRoot, 'scripts', 'check-capture-deadline.mjs')], 'darwin'],
  ['end-to-end smoke', process.execPath, [join(packageRoot, 'scripts', 'smoke.mjs')]],
]

let failed = 0
let skipped = 0
for (const [label, command, args, platform] of STAGES) {
  process.stdout.write(`\n=== ${label} ===\n`)
  if (platform !== undefined && process.platform !== platform) {
    process.stdout.write(
      `  (skipped: this stage exercises ${platform === 'darwin' ? 'macOS' : platform} only,\n`
      + `   and this host is ${process.platform})\n`,
    )
    skipped += 1
    continue
  }
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: 'inherit' })
  if (result.status !== 0) {
    failed += 1
    process.stdout.write(`=== ${label}: FAILED ===\n`)
  }
}

if (failed > 0) {
  process.stderr.write(`\n${String(failed)} of ${String(STAGES.length)} stages failed\n`)
  process.exit(1)
}
process.stdout.write(
  `\nall ${String(STAGES.length - skipped)} stages passed`
  + (skipped > 0 ? ` (${String(skipped)} skipped on this platform)\n` : '\n'),
)
