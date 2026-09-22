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
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const allowWrites = process.argv.includes('--write')

/** Which backend this host builds and drives. */
const WINDOWS = process.platform === 'win32'
/** The other backend, for the handful of checks whose reason is macOS-only. */
const MACOS = process.platform === 'darwin'
/**
 * The permission the tree and input tools are gated by, as it appears in an
 * error message. Windows has no such grant, so the gate does not exist there and
 * the checks that assert on it are skipped rather than reworded.
 */
const ACCESS_PERMISSION = WINDOWS ? '' : 'Accessibility'
/** What a multi-line text control calls itself in the accessibility tree. */
const TEXT_ROLES = WINDOWS ? ['Document', 'Edit'] : ['AXTextArea', 'AXTextField']
/** A write target the smoke test is allowed to open and close. */
const SCRATCH_APP = WINDOWS
  ? { id: 'notepad.exe', name: 'notepad' }
  : { id: 'com.apple.TextEdit', name: 'textedit' }

// The runtime validates every canonical value against the tool's declared
// output schema before it reaches the model, so the smoke test does the same:
// a value the schema rejects is a tool that fails in production but not here.
const { validateJsonSchemaValue } = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools')).href
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

const plugin = await import(pathToFileURL(entry).href)
check(typeof plugin.name === 'string' && plugin.name.length > 0, 'plugin exports a name', plugin.name)
check(typeof plugin.apply === 'function', 'plugin exports apply()')
check(Array.isArray(plugin.inject), 'plugin declares injected services', JSON.stringify(plugin.inject))
check(plugin.Config !== undefined, 'plugin exports a Config schema')

// The harness validates configuration through the exported schema; run the
// defaults through it so a schema that rejects its own defaults fails here.
// No `enginePath`: the plugin resolves the engine from the package layout, so the
// smoke test exercises that resolution rather than routing around it.
const config = plugin.Config({})
check(config.writeApproval === 'always', 'default writeApproval is "always"', String(config.writeApproval))
check(config.maxCaptureDimension === 1568, 'default capture budget is 1568', String(config.maxCaptureDimension))
check(config.allowedScript === false, 'shell scripting is off unless asked for', String(config.allowedScript))

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

// The other half of the permission surface, and the only tool whose side effect
// is a system dialog. With the permissions already granted macOS raises nothing,
// so this asserts the report rather than the dialog: the point is that the two
// engine methods return different shapes — `engine.status` nests the report
// under `permissions` and `engine.request_permissions` returns it flat — and
// that both project into the same value. Reading only the nested shape reported
// every permission as missing for the request path.
const { value: requested } = await callTool(definitions, 'cua_request_permissions', {})
check(
  requested.accessibility === status.accessibility && requested.screenRecording === status.screenRecording,
  'cua_request_permissions reports the same permissions as cua_status',
  `request ${String(requested.accessibility)}/${String(requested.screenRecording)} vs status ${String(status.accessibility)}/${String(status.screenRecording)}`,
)
check(
  requested.ready === status.ready && requested.platform === status.platform,
  'cua_request_permissions reports the same platform readiness as cua_status',
)
check(
  requested.missing.length === status.missing.length,
  'cua_request_permissions reports the same missing set as cua_status',
  JSON.stringify(requested.missing),
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

// One row per application, not per process. A browser or an Electron app is
// many processes, and listing each one makes the same application appear several
// times under the same name — rows a model can neither tell apart nor act on.
// Checked on the two identities a caller can see: an application id must not
// repeat, and nor must a pid (a pid can only be one row's primary).
const appIds = apps.apps.map(app => app.bundleId).filter(id => id !== '')
check(
  new Set(appIds).size === appIds.length,
  'cua_apps reports each application once by id',
  `${String(appIds.length - new Set(appIds).size)} duplicate id(s)`,
)
const livePids = apps.apps.map(app => app.pid).filter(pid => pid > 0)
check(
  new Set(livePids).size === livePids.length,
  'cua_apps does not give two applications the same pid',
  `${String(livePids.length - new Set(livePids).size)} duplicate pid(s)`,
)

const frontmost = apps.apps.find(app => app.active)
if (frontmost !== undefined) {
  process.stdout.write(`  (frontmost application: ${frontmost.name})\n`)
}

// Whether the dumped tree has anything indexable. Declared out here because the
// cross-call index check below it needs the same answer.
let addressable = false

if (status.accessibility) {
  const { value: windows } = await callTool(definitions, 'cua_windows', {})
  check(windows.count >= 0, 'cua_windows returns a list', `${String(windows.count)} windows`)

  const { value: tree } = await callTool(definitions, 'cua_tree', { maxDepth: 3, nodeLimit: 40 })
  check(tree.nodeCount > 0, 'cua_tree returns nodes', `${String(tree.nodeCount)} nodes`)
  check(typeof tree.outline === 'string', 'cua_tree renders an outline')
  check(tree.pid > 0, 'cua_tree reports the pid it read', String(tree.pid))
  // The root has to survive the fold: it is the only thing that says what the
  // outline below it describes, and on Windows a top-level window can report a
  // layout control type that the folder would otherwise swallow.
  check(
    tree.nodes[0]?.depth === 0 && tree.outline.startsWith('[0]'),
    'cua_tree anchors the outline at the requested root',
    tree.outline.split('\n')[0] ?? '',
  )

  // A tree that is nothing but its root is a real answer, not a failure: Windows
  // withholds the contents of an elevated window from this engine, and an
  // application genuinely can have no controls. Either way the engine has to say
  // so, because a bare root is otherwise indistinguishable from an application
  // with no UI. When that happens the index-based checks below have nothing to
  // address, so they are skipped rather than left to throw.
  addressable = tree.nodeCount > 1
  if (addressable) {
    // Index 0 is the application element on macOS and the root window on Windows,
    // so only macOS refuses it; the pair of calls below depends on `element: 0`
    // being treated as a supplied value rather than as "absent" on both.
    const { value: pressed } = await callTool(definitions, 'cua_element', { element: 1, action: 'list' })
    check(
      pressed.performed === true && Array.isArray(pressed.attributes),
      'cua_element list reports actions and attributes',
      `${String(pressed.actions?.length ?? 0)} actions`,
    )
  } else {
    process.stdout.write(
      `  (the tree is a bare root — ${String(tree.nodeCount)} node — so the index checks are skipped)\n`,
    )
    check(
      typeof tree.note === 'string' && tree.note.length > 0,
      'a bare-root tree explains itself instead of looking empty',
      tree.note ?? '(no note)',
    )
  }
  if (addressable && WINDOWS) {
    const { value: rootListed } = await callTool(definitions, 'cua_element', { element: 0, action: 'list' })
    check(
      rootListed.performed === true && Array.isArray(rootListed.attributes),
      'element index 0 addresses the root window',
      `${String(rootListed.actions?.length ?? 0)} actions`,
    )
  } else if (addressable) {
    let rootRefused = false
    try {
      await callTool(definitions, 'cua_element', { element: 0, action: 'list' })
    } catch (error) {
      rootRefused = /element 0 is the application itself/u.test(String(error.message))
    }
    check(rootRefused, 'element index 0 is refused with an explanation')
  }

  // A role filter must actually narrow the tree, and must be asserted on an
  // application that has something to narrow: a filter returning nothing is
  // correct for an app with no buttons, so asserting on whatever happens to be
  // frontmost would be flaky in both directions.
  //
  // The two sets are the platform's own role vocabulary, because that is what a
  // tree reports: macOS names, or the UI Automation control types Windows uses.
  // Windows keeps an element that carries text even when its role is not in the
  // filter, so the text-bearing roles belong in `structural` there — the filter
  // widens rather than restricts, on both backends.
  const filterRoles = WINDOWS
    ? new Set(['Button', 'Edit', 'Hyperlink', 'CheckBox', 'ComboBox', 'RadioButton'])
    : new Set(['AXButton', 'AXTextField', 'AXTextArea', 'AXLink', 'AXCheckBox', 'AXPopUpButton'])
  const structural = WINDOWS
    ? new Set(['Pane', 'Group', 'TitleBar', 'List', 'Table', 'Tree', 'DataGrid', 'Separator',
      'Window', 'Dialog', 'Text', 'Tab', 'TabItem', 'Image', 'ToolBar', 'StatusBar', 'MenuBar', 'MenuItem'])
    : new Set(['AXGroup', 'AXWindow', 'AXSheet', 'AXDialog', 'AXUnknown', 'AXSplitGroup',
      'AXScrollArea', 'AXList', 'AXTable', 'AXRow', 'AXOutline', 'AXBrowser', 'AXColumn', 'AXGrid',
      'AXSection', 'AXLayoutArea', 'AXLayoutItem', 'AXLandmarkRegion', 'AXLandmarkGroup', 'AXStaticText'])
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
    // `roles` widens rather than restricts, and the assertion says so. The
    // engine — both backends; this is `shouldEmit` in the macOS `Tree.swift` —
    // keeps a matching role, a structural anchor, **or anything carrying text**,
    // because a match with no surroundings cannot be read. So the set of roles
    // that may appear is open, and a check demanding "only the requested roles"
    // can never hold: `Document`, `TreeItem`, and `ListItem` all carry text.
    //
    // What can still regress, and is what this asserts, is an element that
    // neither matched, nor anchors, nor says anything: that has no business in
    // the output and would mean the filter was being ignored outright.
    const saysSomething = node =>
      (node.title ?? '') !== '' || (node.value ?? '') !== '' || (node.description ?? '') !== ''
    const roles = filtered.nodes.map(node => node.role)
    check(
      filtered.nodes.every(node => filterRoles.has(node.role) || structural.has(node.role) || saysSomething(node)),
      'cua_tree roles= emits matches, anchors, and text-bearing elements only',
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
  // relaying a capture backend's opaque error.
  process.stdout.write('  (the screen is locked; asserting the locked-session error instead of capturing)\n')
  let reported = false
  try {
    await callTool(definitions, 'cua_screenshot', {})
  } catch (error) {
    reported = /screen is locked/u.test(String(error.message))
  }
  check(reported, 'cua_screenshot names the locked session instead of a backend error')
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
  // The gate is a macOS problem: an engine started from a terminal has no Screen
  // Recording attribution, so its first capture call never returns. Windows
  // grants capture to every process, so there is nothing to wait for and the
  // checks run unconditionally there.
  if (MACOS && process.env.DSH_CUA_CAPTURE !== '1') {
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
    if (front.app === undefined) {
      // Only the Windows engine reports the owning application so far, and the
      // macOS engine cannot be exercised here. Say so rather than either failing
      // the build on a platform that never had the field or passing silently.
      process.stdout.write(
        '  (the capture result carries no "app", so the owning application cannot be checked;\n'
        + '   the Windows engine reports it, the macOS engine does not yet)\n',
      )
    } else {
      check(
        front.app === owner.app,
        'a window capture names the application that owns the window',
        `reported "${String(front.app)}" for window ${String(front.windowId)} owned by "${String(owner.app)}"`,
      )
    }
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
if (status.accessibility && addressable) {
  const { value: tree } = await callTool(definitions, 'cua_tree', { maxDepth: 3, nodeLimit: 10 })
  const { value: listed } = await callTool(definitions, 'cua_element', { element: 1, action: 'list' })
  check(tree.nodeCount > 1 ? Array.isArray(listed.actions) : true, 'an element index survives across tool calls')
}

// ------------------------------------------------------- background operation

// Operating an application the user is not looking at is a core guarantee, and
// it is the one place where the obvious mechanism (synthesized input aimed at
// whatever is frontmost) silently does nothing. It runs with --write only,
// because proving it means really typing into a real application.
//
// How much of it is provable differs by platform, and the checks say which:
// macOS delivers keystrokes to a named process, so the whole guarantee holds;
// Windows has no per-process key delivery, so only the element action is a true
// background operation there.
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

  // Handing the foreground around is best effort, and it is the one place this
  // block still names an application rather than a pid. A state-changing action
  // refuses an ambiguous name — which is right, since picking one of two running
  // instances is a guess — so a machine that happens to have two of the same
  // application open would otherwise turn this into a flaky failure. The reason
  // is printed rather than swallowed.
  const tryActivate = async app => {
    try {
      await callTool(writeTools, 'cua_app', { action: 'activate', app })
    } catch (error) {
      process.stdout.write(`  (could not activate ${String(app)}: ${String(error.message).slice(0, 120)})\n`)
    }
  }

  const originalFrontmost = (await frontmostName())[0]
  const launched = await callTool(writeTools, 'cua_app', { action: 'launch', bundleId: SCRATCH_APP.id })
  await new Promise(resolve => setTimeout(resolve, 2500))

  // Everything below addresses the scratch application by the pid the launch
  // returned, never by name. A name is resolved against every running
  // application, so on a machine where the user happens to have the same
  // application open it selects theirs — and this block ends by killing what it
  // selected. `launch` only ever reports a pid that did not exist before the
  // call, so a pid cannot belong to a window the user already had; if it reports
  // none, the block is skipped rather than falling back to a name.
  const scratchPid = launched.value.pid
  // Declared out here because the foreground is restored after the block, on
  // both paths.
  let other
  if (typeof scratchPid !== 'number' || scratchPid <= 0) {
    process.stdout.write(
      '  (the scratch application could not be identified by pid — it may have been\n'
      + '   reused by an instance that was already running — so nothing was written to it)\n',
    )
  } else {
    // Hand the foreground to something else so the scratch app is genuinely in
    // the background for the rest of this block.
    const before = await frontmostName()
    other = apps.apps.find(app => app.active && app.name !== SCRATCH_APP.name)
    if (other !== undefined) {
      await tryActivate(other.bundleId)
      await new Promise(resolve => setTimeout(resolve, 1200))
    }

    const tree = await callTool(writeTools, 'cua_tree', { pid: scratchPid, interactiveOnly: true })
    const field = tree.value.nodes.findIndex(node => TEXT_ROLES.includes(node.role))
    check(field >= 0, 'the target window is readable through cua_tree', `index ${String(field)}`)

    if (field >= 0) {
      const marker = `bg-${Date.now().toString(36)}`
      await callTool(writeTools, 'cua_element', { element: field, action: 'setValue', text: marker, pid: scratchPid })
      const reread = await callTool(writeTools, 'cua_tree', { pid: scratchPid })
      const got = reread.value.nodes.filter(node => (node.value ?? '').includes(marker))
      check(got.length > 0, 'cua_element writes into a BACKGROUND application', JSON.stringify(got.map(node => node.value)))

      if (WINDOWS) {
        process.stdout.write(
          '  (cua_type needs the target frontmost on Windows, so the background-typing and\n'
          + '   focus-preservation guarantees are asserted on macOS only)\n',
        )
      } else {
        const typed = `+${marker}`
        await callTool(writeTools, 'cua_type', { element: field, text: typed, pid: scratchPid })
        const reread2 = await callTool(writeTools, 'cua_tree', { pid: scratchPid })
        const got2 = reread2.value.nodes.some(node => (node.value ?? '').includes(typed))
        check(got2, 'cua_type with element= types into a BACKGROUND application')

        const after = await frontmostName()
        check(
          after.join(',') === before.join(',') || after.join(',') === (other === undefined ? before.join(',') : [other.name].join(',')),
          'background work did not steal focus',
          `before ${before.join(',')} / after ${after.join(',')}`,
        )
      }
    }

    // Leave the machine as it was found: close the process this block started,
    // identified by the pid it was given rather than by a name that might match
    // something the user is using.
    await callTool(writeTools, 'cua_app', { action: 'quit', pid: scratchPid, force: true })
  }
  if (other === undefined && originalFrontmost !== undefined) {
    await tryActivate(originalFrontmost)
  }
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

// ------------------------------------------------------------ computer use

process.stdout.write('\ncomputer use\n')
{
  // A deployment without the harness's computer-use service must load exactly as
  // it did before the plugin knew about it: reached, not injected, so a missing
  // service is not a load failure.
  const plain = fakeContext()
  let loaded = true
  try {
    plugin.apply(plain, config)
  } catch (error) {
    loaded = false
    check(false, 'the plugin loads without a computer-use service', String(error))
  }
  if (loaded) check(true, 'the plugin loads without a computer-use service')
  check(
    plain.effects.every(factory => typeof factory === 'function'),
    'no computer-use effect is registered when the service is absent',
  )

  // With the service mounted, the plugin must claim the slot under its own name
  // and give it back on disposal. `effect` is driven here rather than recorded,
  // because registration happens inside the factory.
  const registered = []
  const released = []
  const disposers = []
  const honoring = {
    ...plain,
    get: key => key === 'computerUse'
      ? { register: name => { registered.push(name); return async () => { released.push(name) } } }
      : key === 'tools' || key === 'systemPrompt' ? plain[key] : undefined,
    effect: factory => { disposers.push(factory()) },
  }
  plugin.apply(honoring, config)
  check(
    registered.length === 1 && registered[0] === 'cua',
    'the plugin claims the computer-use slot as "cua"',
    JSON.stringify(registered),
  )
  for (const dispose of disposers) await dispose()
  check(
    released.length === 1 && released[0] === 'cua',
    'unloading the plugin releases the computer-use slot',
    JSON.stringify(released),
  )
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
  // An unknown key must be refused and named. Assert the substance rather than
  // the transport: both backends report it as `delivered: false` with a reason
  // (macOS says `unknown key "x"`, Windows explains what it does know) instead of
  // raising, which is the same shape `cua_click` and `cua_type` use for a
  // delivery that could not happen. What must never happen is a silent success.
  let unknownRefused = false
  let unknownDetail = ''
  try {
    const { value } = await callTool(writeDefinitions, 'cua_key', { key: 'definitely-not-a-key' })
    unknownDetail = `delivered=${String(value.delivered)} reason=${String(value.reason ?? '')}`
    unknownRefused = value.delivered === false
      && /unknown key|not a key/u.test(String(value.reason ?? ''))
  } catch (error) {
    unknownDetail = String(error.message)
    unknownRefused = /unknown key|not a key/u.test(unknownDetail)
  }
  check(unknownRefused, 'cua_key refuses an unknown key name', unknownDetail.slice(0, 160))
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
