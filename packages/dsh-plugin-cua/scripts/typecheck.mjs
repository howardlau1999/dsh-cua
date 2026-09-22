/**
 * Type-check the plugin with the local TypeScript.
 *
 * Wrapped rather than spelled as a bare `tsc` so the check does not depend on
 * the caller having `node_modules/.bin` on PATH — the harness runs its own Node
 * and does not put package binaries there.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tsc = join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  process.stderr.write('cua: typescript is not installed; run `pnpm install` in the plugin package\n')
  process.exit(1)
}

const result = spawnSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json'), '--noEmit'], {
  cwd: packageRoot,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
