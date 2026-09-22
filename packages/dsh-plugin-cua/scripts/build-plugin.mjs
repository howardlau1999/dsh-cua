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

/**
 * The two local tools, by their JavaScript entry points.
 *
 * Driven through `node <entry>` rather than through `node_modules/.bin/<name>`:
 * on Windows the shim there is a `.cmd` or a `.ps1`, and `spawnSync` cannot
 * execute either without a shell. Going straight to the entry point works
 * identically on every platform and needs no shell quoting.
 */
const TOOLS = {
  tsc: join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  esbuild: join(packageRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
}

/** Run one local tool, reporting a missing install instead of a stack trace. */
function run(tool, args) {
  const entry = TOOLS[tool]
  if (entry === undefined) throw new Error(`unknown tool ${tool}`)
  if (!existsSync(entry)) {
    process.stderr.write(
      `cua: ${tool} is not installed at ${entry}.\n`
      + 'Run `pnpm install` in the plugin package first.\n',
    )
    process.exit(1)
  }
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: packageRoot, stdio: 'inherit' })
  if (result.error !== undefined) {
    process.stderr.write(`cua: ${tool} could not be started: ${result.error.message}\n`)
    process.exit(1)
  }
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
