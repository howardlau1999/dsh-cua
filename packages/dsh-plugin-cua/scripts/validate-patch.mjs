/**
 * Validate a patch file with the harness's own loader, before it is allowed to
 * touch a profile.
 *
 * A YAML file that parses is not a patch the loader will accept. A
 * `text.includes('…')` check is not a validation either — one once passed a file
 * holding two YAML documents and cost the user their profile configuration. The
 * only agreement that means anything is the loader's own, and it is callable
 * directly:
 *
 *   node packages/dsh-plugin-cua/scripts/validate-patch.mjs ~/.dsh/profiles/<p>/cordis.patch.yml
 *
 * The loader is imported from the first place that has one: this package's own
 * resolution (an installed copy), else the harness source checkout the plugin's
 * development links already point into, else whatever `DSH_CUA_APP_BOOT` names.
 * Nothing here is an absolute path belonging to one machine beyond that override.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Import `loadOverlayPatches` from the first loader that resolves.
 * @returns the loaded `loadOverlayPatches` function.
 * @throws when no candidate provides one.
 */
async function loadLoader() {
  const candidates = [
    ...process.env.DSH_CUA_APP_BOOT === undefined ? [] : [process.env.DSH_CUA_APP_BOOT],
    '@deepseek-ai/dsh-app-boot',
    // The plugin's own devDependencies link into the checkout at this depth.
    resolve(packageRoot, '..', '..', '..', 'deepseek-harness', 'apps', 'cli', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
  ]
  const failures = []
  for (const candidate of candidates) {
    const bare = !candidate.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(candidate)
    if (!bare && !existsSync(candidate)) {
      failures.push(`${candidate}: not found`)
      continue
    }
    try {
      const specifier = bare ? candidate : pathToFileURL(candidate).href
      const loaded = await import(specifier)
      if (typeof loaded.loadOverlayPatches === 'function') return loaded.loadOverlayPatches
      failures.push(`${candidate}: resolved but exports no loadOverlayPatches`)
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error([
    'no harness loader available to validate a patch. Tried:',
    ...failures.map(failure => `  - ${failure}`),
    'Set DSH_CUA_APP_BOOT to an app-boot entry point, e.g.',
    `  ${join('<install>', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')}`,
  ].join('\n'))
}

/**
 * Validate one patch file and report the rows it contributes.
 * @param path - the patch file to validate.
 * @returns a process exit code: 0 valid, 1 invalid or unreadable.
 */
export async function validatePatch(path) {
  if (typeof path !== 'string' || path === '') {
    process.stderr.write('usage: validate-patch.mjs <path/to/cordis.patch.yml>\n')
    return 1
  }
  if (!existsSync(path)) {
    process.stderr.write(`validate-patch: no such file: ${path}\n`)
    return 1
  }
  let loadOverlayPatches
  try {
    loadOverlayPatches = await loadLoader()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  try {
    const documents = loadOverlayPatches('validate-patch', path)
    const entries = documents.flat()
    const inserted = entries.flatMap(entry => entry.insert ?? [])
    process.stdout.write(`${JSON.stringify({
      file: resolve(path),
      // More than one document is the defect this check exists for.
      documents: documents.length,
      patchEntries: entries.length,
      insertedRows: inserted.map(row => ({ id: row.id, name: row.name, config: row.config ?? null })),
      overrides: entries.filter(entry => entry.insert === undefined).map(entry => ({ id: entry.id, disabled: entry.disabled ?? null })),
    }, undefined, 2)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`validate-patch: the loader rejected ${path}\n`)
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await validatePatch(process.argv[2])
