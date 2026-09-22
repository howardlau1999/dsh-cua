/**
 * Run the plugin's whole verification sequence in order.
 *
 * Each stage catches a different class of defect, and they are ordered cheapest
 * first: types, then the schemas the harness will validate against, then the
 * real engine.
 *
 * 1. `tsc --noEmit` — the plugin's own types.
 * 2. `check-schemas` — every tool's parameter and output schema, validated with
 *    the harness's own validator.
 * 3. `smoke` — the built bundle loaded and every tool invoked against the real
 *    macOS engine.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const STAGES = [
  ['types', process.execPath, [join(packageRoot, 'scripts', 'typecheck.mjs')]],
  ['tool schemas', process.execPath, [join(packageRoot, 'scripts', 'check-schemas.mjs')]],
  ['end-to-end smoke', process.execPath, [join(packageRoot, 'scripts', 'smoke.mjs')]],
]

let failed = 0
for (const [label, command, args] of STAGES) {
  process.stdout.write(`\n=== ${label} ===\n`)
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
process.stdout.write(`\nall ${String(STAGES.length)} stages passed\n`)
