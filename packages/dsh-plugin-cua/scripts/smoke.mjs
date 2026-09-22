/**
 * Load the built plugin the way the harness does, then exercise every tool.
 *
 * This is the plugin's end-to-end check: it imports the real bundle, satisfies
 * the two services the plugin injects with recording doubles, validates the
 * configuration schema, and invokes each registered tool against the real
 * engine. It deliberately does not start a harness, so it can run in CI and
 * during development without a session.
 *
 * Usage: `node scripts/smoke.mjs [--write]`
 *   --write  also run a pointer move and a text-free key press; harmless but
 *            visible, so it is opt-in.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const allowWrites = process.argv.includes('--write')

// The runtime validates every canonical value against the tool's declared
// output schema before it reaches the model, so the smoke test does the same:
// a value the schema rejects is a tool that fails in production but not here.
const { validateJsonSchemaValue } = await import(
  createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools')
)

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

/** A stand-in for a Cordis service that records every registration. */
function recordingService(name) {
  const calls = []
  const service = new Proxy({}, {
    get(_target, property) {
      if (property === 'calls') return calls
      if (typeof property !== 'string') return undefined
      if (property === 'then') return undefined
      return (...args) => {
        calls.push([property, args])
        if (property === 'section') return () => {}
        return undefined
      }
    },
  })
  Object.defineProperty(service, 'serviceName', { value: name })
  return service
}

/** A minimal context exposing exactly what the plugin injects. */
function fakeContext() {
  const tools = recordingService('tools')
  const systemPrompt = recordingService('systemPrompt')
  const effects = []
  const serviceMap = new Map([['tools', tools], ['systemPrompt', systemPrompt]])
  return {
    tools,
    systemPrompt,
    effects,
    get: key => serviceMap.get(key),
    effect: factory => { effects.push(factory) },
    logger: {
      info: message => process.stdout.write(`  [plugin] ${message}\n`),
      warn: message => process.stdout.write(`  [plugin:warn] ${message}\n`),
      error: message => process.stdout.write(`  [plugin:error] ${message}\n`),
      debug: () => {},
    },
  }
}

/**
 * Call one registered tool and return its canonical value.
 *
 * `arguments` is set to the same object the tool reads, which is what the real
 * runtime does: `defineTool` validates `exec.arguments` and passes that parsed
 * value to `execute`. A double that omits it makes tools take a different path
 * than production, which is exactly the class of bug this test exists to catch.
 */
async function callTool(definitions, name, args, signal = new AbortController().signal, validate = true) {
  const definition = definitions.find(entry => entry.name === name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const value = await definition.execute(args, {
    callId: `smoke-${name}`,
    name,
    arguments: args,
    signal,
  })
  if (validate) {
    const errors = validateJsonSchemaValue(definition.output.schema, value, '') ?? []
    if (errors.length > 0) {
      throw new Error(`${name} returned a value its own output schema rejects: ${errors.join('; ')}`)
    }
  }
  return { definition, value }
}

process.stdout.write('dsh-plugin-cua smoke test\n')

// ---------------------------------------------------------------- load plugin

const entry = join(packageRoot, 'lib', 'index.js')
if (!existsSync(entry)) {
  process.stderr.write(`the plugin bundle is missing at ${entry}; run \`pnpm run build:plugin\` first\n`)
  process.exit(1)
}

const plugin = await import(entry)
check(typeof plugin.name === 'string' && plugin.name.length > 0, 'plugin exports a name', plugin.name)
check(typeof plugin.apply === 'function', 'plugin exports apply()')
check(Array.isArray(plugin.inject), 'plugin declares injected services', JSON.stringify(plugin.inject))
check(plugin.Config !== undefined, 'plugin exports a Config schema')

// The harness validates configuration through the exported schema; run the
// defaults through it so a schema that rejects its own defaults fails here.
const config = plugin.Config({ enginePath: join(packageRoot, 'lib', 'bin', 'cua-engine') })
check(config.writeApproval === 'always', 'default writeApproval is "always"', String(config.writeApproval))
check(config.maxCaptureDimension === 1568, 'default capture budget is 1568', String(config.maxCaptureDimension))

const ctx = fakeContext()
plugin.apply(ctx, config)

const definitions = ctx.tools.calls.filter(([method]) => method === 'register').map(([, args]) => args[0])
const names = definitions.map(definition => definition.name).sort()
check(definitions.length >= 8, 'registered the Computer Use tool set', `${String(definitions.length)} tools`)
check(
  names.join(',') === 'cua_app,cua_apps,cua_click,cua_displays,cua_element,cua_key,cua_screenshot,cua_status,cua_tree,cua_type,cua_windows',
  'registered exactly the documented tools',
  names.join(','),
)
check(
  ctx.systemPrompt.calls.some(([method, args]) => method === 'section' && args[0]?.name === 'cua:guidance'),
  'contributed the guidance prompt section',
)
check(ctx.effects.length === 1, 'registered one disposal effect for the engine process')

// Every tool needs a runnable identity and a declared output contract.
for (const definition of definitions) {
  const problems = []
  if (typeof definition.description !== 'string' || definition.description.length < 40) problems.push('thin description')
  if (definition.parameters === undefined) problems.push('no parameters schema')
  if (definition.output?.schema === undefined) problems.push('no output schema')
  if (typeof definition.output?.render !== 'function') problems.push('no renderer')
  check(problems.length === 0, `${definition.name} declares a complete contract`, problems.join(', '))
}

// ------------------------------------------------------------- engine status

process.stdout.write('\nengine and permissions\n')
const { value: status } = await callTool(definitions, 'cua_status', {})
check(typeof status.engineVersion === 'string', 'cua_status reports an engine version', status.engineVersion)
check(typeof status.accessibility === 'boolean', 'cua_status reports Accessibility state', String(status.accessibility))
check(typeof status.screenRecording === 'boolean', 'cua_status reports Screen Recording state', String(status.screenRecording))
check(status.hint.length > 0, 'cua_status explains how to fix missing permissions')
check(
  status.eligibleTools.includes('cua_tree') === status.accessibility,
  'cua_status lists cua_tree only when Accessibility is granted',
)

// ------------------------------------------------------- observation tools

process.stdout.write('\nobservation\n')
const { value: displays } = await callTool(definitions, 'cua_displays', {})
check(displays.count > 0, 'cua_displays lists displays', `${String(displays.count)} found`)
check(
  displays.displays.every(display => display.frame.length === 4 && display.reportedDensity >= 1),
  'cua_displays rows carry geometry and density',
)
check(displays.desktop.length === 4, 'cua_displays reports the desktop bounding box', JSON.stringify(displays.desktop))

const { value: apps } = await callTool(definitions, 'cua_apps', {})
check(apps.count > 0, 'cua_apps lists running applications', `${String(apps.count)} found`)
check(apps.apps.every(app => typeof app.name === 'string' && typeof app.bundleId === 'string'), 'cua_apps rows are well formed')

const frontmost = apps.apps.find(app => app.active)
if (frontmost !== undefined) {
  process.stdout.write(`  (frontmost application: ${frontmost.name})\n`)
}

if (status.accessibility) {
  const { value: windows } = await callTool(definitions, 'cua_windows', {})
  check(windows.count >= 0, 'cua_windows returns a list', `${String(windows.count)} windows`)

  const { value: tree } = await callTool(definitions, 'cua_tree', { maxDepth: 3, nodeLimit: 40 })
  check(tree.nodeCount > 0, 'cua_tree returns nodes', `${String(tree.nodeCount)} nodes`)
  check(typeof tree.outline === 'string', 'cua_tree renders an outline')
  check(tree.pid > 0, 'cua_tree reports the pid it read', String(tree.pid))

  // Index 0 is the application element itself; index 1 is the first real node.
  // Both the snapshot lookup and this pair of calls depend on `element: 0`
  // being treated as a supplied value rather than as "absent".
  const { value: pressed } = await callTool(definitions, 'cua_element', { element: 1, action: 'list' })
  check(
    pressed.performed === true && Array.isArray(pressed.attributes),
    'cua_element list reports actions and attributes',
    `${String(pressed.actions?.length ?? 0)} actions`,
  )
  let rootRefused = false
  try {
    await callTool(definitions, 'cua_element', { element: 0, action: 'list' })
  } catch (error) {
    rootRefused = /element 0 is the application itself/u.test(String(error.message))
  }
  check(rootRefused, 'element index 0 is refused with an explanation')

  // A stale index must fail closed rather than act on whatever it finds now.
  let staleMessage = ''
  try {
    await callTool(definitions, 'cua_element', { element: 100_000, action: 'list' })
  } catch (error) {
    staleMessage = String(error.message)
  }
  // Both "index out of range" and "no snapshot at all" must say how to recover.
  check(/re-run cua_tree/u.test(staleMessage), 'a stale element index fails closed', staleMessage.slice(0, 160))
} else {
  process.stdout.write('  (Accessibility is not granted; skipping tree and element checks)\n')
  let gated = false
  try {
    await callTool(definitions, 'cua_tree', {})
  } catch (error) {
    gated = /Accessibility/u.test(String(error.message))
  }
  check(gated, 'cua_tree refuses without Accessibility permission')
}

if (status.screenRecording && !status.sessionLocked) {
  const { value: shot } = await callTool(definitions, 'cua_screenshot', {})
  check(existsSync(shot.path), 'cua_screenshot wrote a file', shot.path)
  check(shot.pixelWidth > 0 && shot.pixelHeight > 0, 'cua_screenshot reports dimensions', `${String(shot.pixelWidth)}x${String(shot.pixelHeight)}`)
  check(shot.region.length === 4, 'cua_screenshot reports the captured screen region', JSON.stringify(shot.region))
  check(shot.scale > 0, 'cua_screenshot reports pixels per point', String(shot.scale))
} else if (status.sessionLocked) {
  // A locked console fails every capture; the tool must say so rather than
  // relaying ScreenCaptureKit's opaque stream error.
  process.stdout.write('  (the screen is locked; asserting the locked-session error instead of capturing)\n')
  let reported = false
  try {
    await callTool(definitions, 'cua_screenshot', {})
  } catch (error) {
    reported = /screen is locked/u.test(String(error.message))
  }
  check(reported, 'cua_screenshot names the locked session instead of a stream error')
  check(status.ready === false, 'cua_status reports not-ready while the screen is locked')
} else {
  process.stdout.write('  (Screen Recording is not granted; skipping capture checks)\n')
  let gated = false
  try {
    await callTool(definitions, 'cua_screenshot', {})
  } catch (error) {
    gated = /Screen Recording/u.test(String(error.message))
  }
  check(gated, 'cua_screenshot refuses without Screen Recording permission')
}

// The engine outlives one tool call, so an index from one call must address the
// same element in the next: that is what makes cua_tree -> cua_element a pair.
if (status.accessibility) {
  const { value: tree } = await callTool(definitions, 'cua_tree', { maxDepth: 3, nodeLimit: 10 })
  const { value: listed } = await callTool(definitions, 'cua_element', { element: 1, action: 'list' })
  check(tree.nodeCount > 1 ? Array.isArray(listed.actions) : true, 'an element index survives across tool calls')
}

// ------------------------------------------------------- background operation

// Operating an application the user is not looking at is a core guarantee, and
// it is the one place where the obvious mechanism (synthesized input aimed at
// whatever is frontmost) silently does nothing. It runs with --write only,
// because proving it means really typing into a real application.
if (allowWrites && status.accessibility) {
  process.stdout.write('\nbackground operation (--write)\n')
  const writeCtx = fakeContext()
  writeCtx.get = key => key === 'approval' ? { request: async () => 'allowed-once' } : ctx.get(key)
  plugin.apply(writeCtx, { ...config, writeApproval: 'never' })
  const writeTools = writeCtx.tools.calls
    .filter(([method]) => method === 'register')
    .map(([, args]) => args[0])

  const frontmostName = async () => {
    const { value } = await callTool(writeTools, 'cua_apps', {})
    return value.apps.filter(app => app.active).map(app => app.name)
  }

  await callTool(writeTools, 'cua_app', { action: 'launch', bundleId: 'com.apple.TextEdit' })
  await new Promise(resolve => setTimeout(resolve, 2000))
  // Hand the foreground to something else so TextEdit is genuinely in the
  // background for the rest of this block.
  const before = await frontmostName()
  const other = apps.apps.find(app => app.active && app.bundleId !== 'com.apple.TextEdit')
  if (other !== undefined) {
    await callTool(writeTools, 'cua_app', { action: 'activate', app: other.bundleId })
    await new Promise(resolve => setTimeout(resolve, 1200))
  }

  const tree = await callTool(writeTools, 'cua_tree', { app: 'textedit', interactiveOnly: true })
  const field = tree.value.nodes.findIndex(node => node.role === 'AXTextArea')
  check(field > 0, 'the background window is still readable through cua_tree', `index ${String(field)}`)

  if (field > 0) {
    const marker = `bg-${Date.now().toString(36)}`
    await callTool(writeTools, 'cua_element', { element: field, action: 'setValue', text: marker })
    const reread = await callTool(writeTools, 'cua_tree', { app: 'textedit' })
    const got = reread.value.nodes.filter(node => (node.value ?? '').includes(marker))
    check(got.length > 0, 'cua_element writes into a BACKGROUND application', JSON.stringify(got.map(node => node.value)))

    const typed = `+${marker}`
    await callTool(writeTools, 'cua_type', { element: field, text: typed })
    const reread2 = await callTool(writeTools, 'cua_tree', { app: 'textedit' })
    const got2 = reread2.value.nodes.some(node => (node.value ?? '').includes(typed))
    check(got2, 'cua_type with element= types into a BACKGROUND application')

    const after = await frontmostName()
    check(
      after.join(',') === before.join(',') || after.join(',') === (other === undefined ? before.join(',') : [other.name].join(',')),
      'background work did not steal focus',
      `before ${before.join(',')} / after ${after.join(',')}`,
    )
  }

  await callTool(writeTools, 'cua_app', { action: 'script', bundleId: 'com.apple.TextEdit', script: 'quit saving no' })
}

// ---------------------------------------------------------------- write gate

process.stdout.write('\nauthorization\n')
{
  // With no approval service mounted, `always` must refuse before the OS is
  // touched. Reaching the engine would be the bug this asserts against.
  const click = definitions.find(definition => definition.name === 'cua_click')
  let refused = false
  try {
    await click.execute({ action: 'move', x: 1, y: 1 }, {
      callId: 'smoke-gate',
      name: 'cua_click',
      arguments: {},
      signal: new AbortController().signal,
      agent: { session: { id: 'smoke-session' } },
    })
  } catch (error) {
    refused = /no approval service is mounted/u.test(String(error.message))
  }
  check(refused, 'a write is refused when no approver is mounted')
}

if (allowWrites && status.accessibility) {
  process.stdout.write('\nwrites (--write)\n')
  const permissive = fakeContext()
  permissive.get = key => key === 'approval'
    ? { request: async () => 'allowed-once' }
    : key === 'tools' || key === 'systemPrompt' ? permissive[key] : undefined
  const writeCtx = fakeContext()
  const approval = { request: async () => 'allowed-once' }
  const originalGet = writeCtx.get
  writeCtx.get = key => key === 'approval' ? approval : originalGet(key)
  plugin.apply(writeCtx, { ...config, writeApproval: 'never' })
  const writeDefinitions = writeCtx.tools.calls
    .filter(([method]) => method === 'register')
    .map(([, args]) => args[0])

  const { value: moved } = await callTool(writeDefinitions, 'cua_click', { action: 'move', x: 40, y: 40 })
  check(moved.delivered === true, 'cua_click moves the pointer', JSON.stringify(moved))
  const { value: chord } = await callTool(writeDefinitions, 'cua_key', { key: 'shift' })
  check(chord.delivered === true, 'cua_key delivers a modifier', JSON.stringify(chord))
}

// ------------------------------------------------------------------- summary

process.stdout.write(`\n${String(checks - failures.length)}/${String(checks)} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('failures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`smoke test passed (plugin at ${resolve(entry)})\n`)
process.exit(0)
