/**
 * Validate every registered tool's schemas against the harness's own validator.
 *
 * The smoke test calls tools through their `execute` bodies, which skips the
 * layer the real runtime applies first: `defineTool` converts the parameter DSL
 * into JSON Schema and validates model arguments against it before `execute`
 * runs. A tool whose DSL does not survive that conversion — an unsupported
 * keyword, an enum on the wrong node type — would pass the smoke test and fail
 * in production, so this asserts the conversion and a representative
 * invocation for every tool.
 *
 * Usage: `node scripts/check-schemas.mjs`
 *
 * @module
 */

import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
// `require.resolve` returns a native path, and a bare `C:\…` string is not a
// URL the ESM loader accepts: on Windows it reads the drive letter as a scheme.
const { validateJsonSchemaValue } = await import(
  pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href
)

const plugin = await import('../lib/index.js')

/** The engine file name this host builds, matching `build-engine.mjs`. */

/** The application and role vocabulary of the backend this host will drive. */
const WINDOWS = process.platform === 'win32'
const SAMPLE_APP = WINDOWS ? 'explorer' : 'Finder'
const SAMPLE_ROLE = WINDOWS ? 'Button' : 'AXButton'

const registered = []
const sections = []
const service = {
  register: definition => { registered.push(definition); return () => {} },
  section: section => { sections.push(section); return () => {} },
}
const ctx = {
  tools: service,
  systemPrompt: service,
  get: key => (key === 'tools' || key === 'systemPrompt') ? service : undefined,
  effect: () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}
plugin.apply(ctx, plugin.Config({}))

const failures = []
let checks = 0

/** Record one assertion. */
function check(condition, label, detail = '') {
  checks += 1
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
}

/** A representative valid invocation per tool, used to prove the schema accepts real calls. */
const SAMPLES = {
  cua_status: [{ request: false }],
  cua_displays: [{}],
  cua_apps: [{ query: SAMPLE_APP, running: true }],
  cua_windows: [{ app: SAMPLE_APP, includeUntitled: true }],
  cua_tree: [{ app: SAMPLE_APP, maxDepth: 3, roles: [SAMPLE_ROLE], includeGeometry: true }],
  cua_screenshot: [{ windowId: 1, format: 'png', maxWidth: 800 }],
  cua_click: [{ action: 'click', x: 10, y: 20, button: 'right', clickCount: 2 }],
  cua_type: [{ text: 'hello', perCharacterDelayMs: 10 }],
  cua_key: [{ key: 's', modifiers: WINDOWS ? ['ctrl', 'shift'] : ['cmd', 'shift'] }],
  cua_element: [{ element: 3, action: 'setValue', text: 'x' }],
  cua_app: [{ action: 'openURL', url: 'https://example.com' }],
}

process.stdout.write('tool schema validation\n')
check(registered.length === Object.keys(SAMPLES).length, 'every registered tool has a sample', `${String(registered.length)} tools`)

for (const definition of registered) {
  const sample = SAMPLES[definition.name]
  if (sample === undefined) {
    check(false, `${definition.name} has a sample invocation`)
    continue
  }
  // `schemas()` is what the system prompt assembly reads; it must succeed and
  // must expose only the model-facing fields.
  let schema
  try {
    schema = definition.output.schema
  } catch (error) {
    check(false, `${definition.name} exposes an output schema`, String(error))
    continue
  }
  check(typeof schema === 'object' && schema !== null, `${definition.name} declares an output schema`)

  // `defineTool` already converted the parameter DSL to JSON Schema at
  // registration — that conversion is where an unsupported keyword throws — so
  // the registered `parameters` is the exact schema the runtime validates
  // model arguments against.
  const jsonSchema = definition.parameters
  check(
    typeof jsonSchema === 'object' && jsonSchema !== null && jsonSchema.type === 'object',
    `${definition.name} registered an object parameter schema`,
  )

  for (const args of sample) {
    let errors = []
    try {
      errors = validateJsonSchemaValue(jsonSchema, args, '') ?? []
    } catch (error) {
      errors = [String(error)]
    }
    check(errors.length === 0, `${definition.name} accepts ${JSON.stringify(args)}`, errors.join('; '))
  }

  // A representative invalid call must be rejected rather than silently coerced.
  const invalid = invalidSample(definition.name)
  if (invalid !== undefined) {
    let errors = []
    try {
      errors = validateJsonSchemaValue(jsonSchema, invalid, '') ?? []
    } catch {
      errors = ['threw']
    }
    check(errors.length > 0, `${definition.name} rejects ${JSON.stringify(invalid)}`, 'no error reported')
  }
}

check(sections.length === 1 && sections[0].name === 'cua:guidance', 'contributes exactly one prompt section')
check(typeof sections[0].text === 'string' && sections[0].text.includes('cua_tree'), 'guidance names the tools')

/** One deliberately invalid invocation per tool, where the schema constrains it. */
function invalidSample(name) {
  switch (name) {
    case 'cua_click': return { action: 'teleport' }
    case 'cua_type': return { text: 42 }
    case 'cua_key': return { modifiers: ['cmd'] }
    case 'cua_element': return { action: 'press' }
    case 'cua_app': return { action: 'explode' }
    case 'cua_screenshot': return { format: 'bmp' }
    case 'cua_tree': return { roles: 'AXButton' }
    default: return undefined
  }
}

process.stdout.write(`\n${String(checks - failures.length)}/${String(checks)} checks passed\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
