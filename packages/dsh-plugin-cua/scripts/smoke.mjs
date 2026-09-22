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
async function callTool(definitions, name, args, options = {}) {
  const definition = definitions.find(entry => entry.name === name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const validate = options.validate ?? true
  const value = await definition.execute(args, {
    callId: `smoke-${name}`,
    name,
    arguments: args,
    signal: options.signal ?? new AbortController().signal,
    // Writes fail closed without a session; the runtime always supplies one.
    ...options.agent === undefined ? {} : { agent: options.agent },
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
  names.join(',') === 'cua_app,cua_apps,cua_click,cua_displays,cua_element,cua_key,cua_request_permissions,cua_screenshot,cua_status,cua_tree,cua_type,cua_windows',
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

  // A role filter must actually narrow the tree, and must be asserted on an
  // application that has something to narrow: a filter returning nothing is
  // correct for an app with no buttons, so asserting on whatever happens to be
  // frontmost would be flaky in both directions.
  const filterRoles = new Set(['AXButton', 'AXTextField', 'AXTextArea', 'AXLink', 'AXCheckBox', 'AXPopUpButton'])
  const structural = new Set(['AXGroup', 'AXWindow', 'AXSheet', 'AXDialog', 'AXUnknown', 'AXSplitGroup',
    'AXScrollArea', 'AXList', 'AXTable', 'AXRow', 'AXOutline', 'AXBrowser', 'AXColumn', 'AXGrid',
    'AXSection', 'AXLayoutArea', 'AXLayoutItem', 'AXLandmarkRegion', 'AXLandmarkGroup'])
  let filtered = undefined
  for (const candidate of apps.apps.slice(0, 8)) {
    const attempt = await callTool(definitions, 'cua_tree', { pid: candidate.pid, roles: [...filterRoles], maxDepth: 12 })
    if (attempt.value.nodeCount > 0) {
      filtered = attempt.value
      break
    }
  }
  if (filtered === undefined) {
    process.stdout.write('  (no probed application exposes a filterable control; skipping role-filter checks)\n')
  } else {
    const roles = filtered.nodes.map(node => node.role)
    check(
      roles.every(role => filterRoles.has(role) || structural.has(role)),
      'cua_tree roles= emits only matching roles plus structural anchors',
      `roles present: ${[...new Set(roles)].join(',')}`,
    )
    check(
      roles.some(role => filterRoles.has(role)),
      'cua_tree roles= keeps the matches it found',
      `${String(roles.filter(role => filterRoles.has(role)).length)} matching of ${String(roles.length)} nodes`,
    )

    const limited = await callTool(definitions, 'cua_tree', { pid: filtered.pid, maxDepth: 12, nodeLimit: 4 })
    check(limited.value.truncatedBy === 'node_limit', 'cua_tree names the budget that truncated it', String(limited.value.truncatedBy))
  }

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
  await captureChecks()
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

/**
 * Assert capture behaviour against the real screen.
 *
 * Skipped by default when this script is not running inside the host's process
 * tree, because macOS attributes the Screen Recording grant to the application
 * responsible for the process — the host application, not `cua-engine`. An
 * engine spawned from a terminal therefore has no capture attribution at all,
 * and its first ScreenCaptureKit call does not fail: it stops answering. The
 * engine's own watchdog turns that into a stopped engine after 12 s (verified by
 * `check-capture-deadline.mjs`), which is a correct engine and a useless test.
 *
 * So the capture assertions run where capture actually works: through the MCP
 * row, from a session hosted by the application that holds the grant. Run this
 * script with `DSH_CUA_CAPTURE=1` to force them on anyway — useful when this
 * script is itself launched from inside the host.
 */
async function captureChecks() {
  if (process.env.DSH_CUA_CAPTURE !== '1') {
    process.stdout.write(
      '  (capture checks need the host process tree: an engine started from a terminal has no\n'
      + '   Screen Recording attribution, so its first capture call never returns. Set\n'
      + '   DSH_CUA_CAPTURE=1 if this script already runs inside the host. Skipping.)\n',
    )
    return
  }

  const { value: shot } = await callTool(definitions, 'cua_screenshot', {})
  check(existsSync(shot.path), 'cua_screenshot wrote a file', shot.path)
  check(shot.pixelWidth > 0 && shot.pixelHeight > 0, 'cua_screenshot reports dimensions', `${String(shot.pixelWidth)}x${String(shot.pixelHeight)}`)
  check(shot.region.length === 4, 'cua_screenshot reports the captured screen region', JSON.stringify(shot.region))
  check(shot.scale > 0, 'cua_screenshot reports pixels per point', String(shot.scale))

  // `region` plus `scale` is the contract a caller converts image pixels into
  // clicks with, so it must reproduce the image it came with. A region reported
  // from the request rather than from what was captured fails this.
  const ratioX = shot.pixelWidth / shot.region[2]
  const ratioY = shot.pixelHeight / shot.region[3]
  check(
    Math.abs(ratioX - shot.scale) < 0.02 && Math.abs(ratioY - shot.scaleY) < 0.02,
    'region x scale reproduces the captured pixel size',
    `pixels ${String(shot.pixelWidth)}x${String(shot.pixelHeight)} region ${String(shot.region[2])}x${String(shot.region[3])} scale ${String(shot.scale)}/${String(shot.scaleY)}`,
  )
  check(typeof shot.clipped === 'boolean', 'cua_screenshot states whether the request was clipped')

  // A window capture must pick the window, not the first entry of AXWindows:
  // that ordering puts the menu bar first on a real desktop, which makes an
  // unqualified capture return a 33-point strip instead of the window.
  const { value: front } = await callTool(definitions, 'cua_screenshot', { frontmost: true, maxWidth: 600 })
  check(
    front.region[3] > 200 && front.region[2] > 200,
    'a frontmost-window capture selects a real window, not the menu bar',
    `region ${JSON.stringify(front.region)}`,
  )
  check(front.windowId !== undefined && front.windowId !== null, 'a window capture reports its windowId', String(front.windowId))

  // `app` must name the application that owns the captured window, not whichever
  // application is frontmost when the capture finishes. The two differ as soon as
  // focus moves mid-capture, which a perceive/act loop does constantly, and the
  // caller has no other way to tell which application it is looking at.
  const windowsForOwner = await callTool(definitions, 'cua_windows', { includeUntitled: true })
  const owner = windowsForOwner.value.windows.find(window => window.windowId === front.windowId)
  if (owner !== undefined) {
    check(
      front.app === owner.app,
      'a window capture names the application that owns the window',
      `reported "${String(front.app)}" for window ${String(front.windowId)} owned by "${String(owner.app)}"`,
    )
  }

  // A rectangle that only partly overlaps a display, and one spanning the gap
  // between two: both must capture the overlap and say so, not fail and not
  // report the un-clipped request.
  if (displays.count > 1) {
    const primary = displays.displays.find(display => display.main) ?? displays.displays[0]
    const spanning = {
      x: Math.round(primary.frame[0] - 200),
      y: Math.round(primary.frame[1] - 200),
      width: Math.round(primary.frame[2] + 400),
      height: 300,
      maxWidth: 800,
    }
    const { value: crossed } = await callTool(definitions, 'cua_screenshot', spanning)
    check(existsSync(crossed.path), 'a rectangle spanning two displays still captures', crossed.path)
    check(crossed.clipped === true, 'a partly-off-display rectangle is reported as clipped', JSON.stringify(crossed.region))
    check(
      crossed.region[2] <= spanning.width && crossed.region[3] <= spanning.height,
      'the reported region never exceeds what was requested',
      JSON.stringify(crossed.region),
    )
    const crossedRatio = crossed.pixelWidth / crossed.region[2]
    check(
      Math.abs(crossedRatio - crossed.scale) < 0.02,
      'a clipped capture reports a scale matching its own region',
      `${String(crossed.pixelWidth)} px over ${String(crossed.region[2])} points at scale ${String(crossed.scale)}`,
    )
  }

  // Every display must be capturable on its own, including one at negative
  // coordinates.
  for (const display of displays.displays) {
    const { value: one } = await callTool(definitions, 'cua_screenshot', { displayId: display.displayId, maxWidth: 400 })
    check(
      one.pixelWidth > 0 && one.displayId === display.displayId,
      `cua_screenshot captures display ${String(display.displayId)}`,
      `${String(one.pixelWidth)}x${String(one.pixelHeight)}`,
    )
  }
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

  // Names callers guess must resolve to the same key as the canonical spelling.
  for (const alias of ['downarrow', 'pgdn', 'del', 'esc']) {
    const { value } = await callTool(writeDefinitions, 'cua_key', { key: alias })
    check(value.delivered === true, `cua_key resolves the alias "${alias}"`, String(value.reason ?? ''))
  }
  let unknownRejected = false
  try {
    await callTool(writeDefinitions, 'cua_key', { key: 'definitely-not-a-key' })
  } catch (error) {
    unknownRejected = /unknown key/u.test(String(error.message))
  }
  check(unknownRejected, 'cua_key rejects an unknown key name')
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
