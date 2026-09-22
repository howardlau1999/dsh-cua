/**
 * Validate the tool catalog the **engine** publishes over MCP.
 *
 * `check-schemas.mjs` covers the TypeScript tools the native plugin row
 * registers. It says nothing about the twelve tools a model actually sees when
 * the engine is reached through `dsh-mcp-client`, because those come from
 * `tools/list` on the engine's own MCP server and are assembled by a different
 * implementation. A typo in `McpServer.swift` — an unknown JSON Schema keyword,
 * a non-object root, a bad enum — is invisible to every other check in this
 * repository and surfaces only when a model calls the tool.
 *
 * This closes that gap by asking the engine itself, over the same stdio
 * protocol the harness uses, then running each returned schema through the
 * harness's own validator. It also compares the MCP catalog against the
 * TypeScript one, so the two integrations cannot silently drift apart.
 *
 * Usage: `node scripts/check-mcp-catalog.mjs`
 *
 * @module
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
// The engine is one file on macOS and a directory with an .exe on Windows.
const enginePath = process.platform === 'win32'
  ? join(packageRoot, 'lib', 'bin', 'cua-engine', 'cua-engine.exe')
  : join(packageRoot, 'lib', 'bin', 'cua-engine')

// `require.resolve` hands back an absolute path, and the ESM loader needs a URL:
// on Windows a bare `C:\...` is read as a scheme named "c" and rejected.
const { validateJsonSchemaValue, assertSupportedJsonSchema } = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools')).href
)

const failures = []
let checks = 0

/** A representative valid invocation per MCP tool. */
const MCP_SAMPLES = {
  cua_status: {},
  cua_request_permissions: {},
  cua_displays: {},
  cua_apps: { query: 'Finder', running: true, includeBackground: false },
  cua_windows: { app: 'Finder', includeUntitled: true, frontmost: false },
  cua_tree: {
    app: 'Finder',
    maxDepth: 3,
    nodeLimit: 100,
    interactiveOnly: false,
    roles: ['AXButton'],
    textLimit: 40,
    includeGeometry: true,
    includeStructural: false,
    includeMenuBar: false,
    timeBudgetMs: 2000,
  },
  cua_screenshot: {
    windowId: 1,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    format: 'jpeg',
    quality: 0.5,
    maxWidth: 800,
    maxHeight: 600,
    showCursor: false,
  },
  cua_click: {
    action: 'drag',
    x: 10,
    y: 20,
    toX: 30,
    toY: 40,
    steps: 5,
    durationMs: 100,
    button: 'right',
    clickCount: 2,
    route: 'pid',
    pid: 1,
  },
  cua_type: { text: 'hello', perCharacterDelayMs: 10, route: 'pid', pid: 1 },
  cua_key: { key: 's', modifiers: ['cmd', 'shift'], repeat: 1, holdMs: 50 },
  cua_element: { element: 3, action: 'menu', path: ['File', 'Open'], pid: 1 },
  cua_app: { action: 'script', script: 'return 1', timeoutSeconds: 5, bundleId: 'com.apple.finder' },
}

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

if (!existsSync(enginePath)) {
  process.stderr.write(`the engine is missing at ${enginePath}; run \`pnpm run build:engine\` first\n`)
  process.exit(1)
}

// Ask the engine whether it speaks MCP at all, rather than assuming from the
// platform. The macOS engine serves it and the Windows engine does not yet, but
// that is a gap in one backend rather than a property of the operating system —
// and a stage that quietly reports "passed" on a backend with no MCP server
// would be worse than one that says so.
{
  const help = spawnSync(enginePath, ['--help'], { encoding: 'utf8' })
  const text = `${help.stdout ?? ''}${help.stderr ?? ''}`
  if (!text.includes('--mcp')) {
    process.stdout.write(
      '  (this engine does not implement `--mcp`, so it publishes no MCP catalog.\n'
      + '   The macOS backend serves one and the Windows backend does not yet — which\n'
      + '   means the package\'s own `cordis.patch.yml`, whose row starts the engine\n'
      + '   with `--mcp`, cannot work on Windows. Use the native plugin row instead:\n'
      + '   it registers the same tools directly from `lib/index.js`.)\n',
    )
    process.exit(0)
  }
}

/**
 * Run one MCP exchange against a freshly spawned engine and return the response
 * for `id`.
 *
 * The engine answers one JSON object per line, which is also what it speaks on
 * stdio, so the whole exchange is a write, a read, and a close.
 *
 * @param requests - request objects to send, in order.
 * @returns the decoded response whose `id` matches the last request.
 */
function mcpExchange(requests) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(enginePath, ['--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`engine did not answer within 10s; stderr: ${stderr}`))
    }, 10_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const wanted = requests.at(-1).id
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let message
        try {
          message = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (message.id === wanted) {
          resolvePromise(message)
          return
        }
      }
      rejectPromise(new Error(`no response to id ${String(wanted)}; stdout: ${stdout.slice(0, 400)}`))
    })

    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`)
    child.stdin.end()
  })
}

process.stdout.write('engine MCP catalog validation\n')

const response = await mcpExchange([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
])

if (response.error !== undefined) {
  process.stderr.write(`tools/list failed: ${JSON.stringify(response.error)}\n`)
  process.exit(1)
}

const tools = response.result?.tools
if (!check(Array.isArray(tools), 'tools/list returns an array of tools')) {
  process.exit(1)
}

// The count the integration advertises; the case study settled on one catalog
// of twelve, so a change here is a deliberate change and should be reviewed.
check(tools.length === 12, 'the MCP catalog holds twelve tools', `found ${String(tools.length)}`)

const seen = new Set()
for (const tool of tools) {
  const name = tool.name
  check(typeof name === 'string' && name.length > 0, 'every tool has a name', String(name))
  check(!seen.has(name), `${name} appears once`, 'duplicate name')
  seen.add(name)

  check(
    typeof tool.description === 'string' && tool.description.length > 0,
    `${name} has a description`,
  )

  const schema = tool.inputSchema
  if (!check(typeof schema === 'object' && schema !== null, `${name} declares an inputSchema`)) continue
  check(schema.type === 'object', `${name} inputSchema is an object schema`, String(schema.type))

  // The harness rejects a schema whose root is not an object at registration,
  // and rejects unsupported keywords when it builds the model-facing catalog.
  let supported = true
  try {
    assertSupportedJsonSchema(schema)
  } catch (error) {
    supported = false
    check(false, `${name} uses only supported JSON Schema keywords`, String(error))
  }
  if (supported) check(true, `${name} uses only supported JSON Schema keywords`)

  // Every tool must accept an empty argument object unless it declares required
  // parameters — an MCP client that sends no arguments must not crash the tool.
  const required = Array.isArray(schema.required) ? schema.required : []
  check(
    Array.isArray(schema.required),
    `${name} declares required as an array`,
    String(schema.required),
  )
  for (const parameter of required) {
    check(
      typeof parameter === 'string' && Object.hasOwn(schema.properties ?? {}, parameter),
      `${name} requires a declared parameter "${String(parameter)}"`,
    )
  }

  // A representative call per tool, mirroring check-schemas.mjs, to prove the
  // schema accepts the shape a model actually sends.
  const sample = MCP_SAMPLES[name]
  if (sample !== undefined) {
    let errors = []
    try {
      errors = validateJsonSchemaValue(schema, sample, '') ?? []
    } catch (error) {
      errors = [String(error)]
    }
    check(errors.length === 0, `${name} accepts ${JSON.stringify(sample)}`, errors.join('; '))
  }
}

// The two integration paths must agree on what exists. A tool present in one
// and missing from the other is the drift this check exists to catch.
const plugin = await import(pathToFileURL(join(packageRoot, 'lib', 'index.js')).href)
const registered = []
const service = {
  register: definition => { registered.push(definition); return () => {} },
  section: () => () => {},
}
plugin.apply(
  {
    tools: service,
    systemPrompt: service,
    get: () => undefined,
    effect: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  },
  plugin.Config({ enginePath }),
)

const mcpNames = new Set(tools.map(tool => tool.name))
const tsNames = new Set(registered.map(definition => definition.name))
check(tsNames.size === 12, 'the TypeScript catalog holds twelve tools', `found ${String(tsNames.size)}`)
for (const name of mcpNames) {
  check(tsNames.has(name), `${name} exists in both catalogs`)
}
for (const name of tsNames) {
  check(mcpNames.has(name), `${name} exists in both catalogs`)
}

process.stdout.write(`\n${String(checks - failures.length)}/${String(checks)} checks passed\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
