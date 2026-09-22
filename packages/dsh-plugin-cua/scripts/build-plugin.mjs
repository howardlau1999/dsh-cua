/**
 * Bundle the TypeScript plugin and emit its type declarations.
 *
 * The harness's own packages stay external on purpose. A plugin is loaded into
 * a live Cordis container, and services are identified by module instance, so a
 * bundled second copy of `@deepseek-ai/dsh-tools` would register tools into a
 * registry nothing else can see. Everything else is inlined, which keeps the
 * installed package to one JavaScript file plus the native engine.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const nodeModulesBin = join(packageRoot, 'node_modules', '.bin')

/**
 * Packages the harness must own, because their identity is the service identity.
 *
 * `@deepseek-ai/cordis` is listed for completeness — every one of its imports is
 * type-only, so nothing of it reaches the bundle — but a future runtime import
 * would silently get a second copy without this entry.
 */
const EXTERNALS = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
]

/** Run one local binary, reporting a missing install instead of a stack trace. */
function run(binary, args) {
  const path = join(nodeModulesBin, binary)
  if (!existsSync(path)) {
    process.stderr.write(
      `cua: ${binary} is not installed in ${nodeModulesBin}.\n`
      + 'Run `pnpm install` in the plugin package first.\n',
    )
    process.exit(1)
  }
  const result = spawnSync(path, args, { cwd: packageRoot, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

process.stdout.write('cua: emitting type declarations…\n')
run('tsc', ['-p', 'tsconfig.build.json'])

process.stdout.write('cua: bundling the plugin…\n')
run('esbuild', [
  'src/index.ts',
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node22',
  '--outfile=lib/index.js',
  // `--external:<name>` form: esbuild reads a space-separated `--external @scope/x`
  // as the flag followed by a positional argument, and the scoped name is then
  // rejected as an invalid flag value.
  ...EXTERNALS.map(name => `--external:${name}`),
])

process.stdout.write(`cua: wrote ${join(packageRoot, 'lib', 'index.js')}\n`)
