/**
 * Application-level tools: lifecycle, direct GUI messaging, and menu invocation.
 *
 * This is the "drive the app, not the mouse" surface. Activating, hiding,
 * quitting, opening a URL, and invoking a menu item are ordinary API calls the
 * engine makes itself, so they work without moving the pointer and without
 * stealing focus mid-task. Sending another application an Apple event is the
 * same idea taken further: the app performs the work it already knows how to do.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { requireWriteApproval } from './approval.ts'
import type { WriteApprovalMode } from './config.ts'
import { arr, bool, num, str, text, type ToolContext } from './shared.ts'
import { copy } from './platform.ts'

/** Write-capable application actions; the rest are plain reads. */
const WRITE_ACTIONS: readonly string[] = ['activate', 'focus', 'hide', 'unhide', 'quit', 'launch', 'openURL', 'reveal', 'script', 'menu']

/** Application tools contributed by the Computer Use plugin. */
export function applicationTools(ctx: Context, tools: ToolContext, mode: WriteApprovalMode): ToolDefinition[] {
  return [appTool(ctx, tools, mode)]
}

/** `cua_app`: lifecycle, messaging, and menu invocation. */
function appTool(ctx: Context, tools: ToolContext, mode: WriteApprovalMode): ToolDefinition {
  return defineTool({
    name: 'cua_app',
    description: 'Control one application directly instead of through the pointer and keyboard. '
      + 'Actions: activate (bring the app and one window to the front), hide, unhide, quit, '
      + `${copy.launchHelp}, openURL (hand a URL to an app or the default handler), ${copy.revealHelp}, `
      + 'menu (invoke a menu path such as ["File","Save"] without touching the mouse), '
      + `and ${copy.scriptHelp}. `
      + `menu and activate need accessibility access; the other actions need none. `
      + 'Prefer this over synthesizing clicks whenever the app exposes the operation.',
    parameters: {
      action: { type: 'string', required: true, enum: ['activate', 'hide', 'unhide', 'quit', 'launch', 'openURL', 'reveal', 'menu', 'script'], description: 'What to do.' },
      app: { type: 'string', description: `Target application name or ${copy.appIdNoun}. Defaults to the frontmost application for actions that need a target.` },
      pid: { type: 'integer', description: 'Target process id; wins over app.' },
      bundleId: { type: 'string', description: `Target ${copy.appIdHelp}; used by launch, openURL, and script.` },
      windowTitle: { type: 'string', description: 'With activate: bring the window whose title contains this text to the front.' },
      path: { type: 'array', items: { type: 'string' }, description: `For action=menu: menu titles from the menu bar inward, such as ["File","Save"]. For action=reveal: a single filesystem path.` },
      url: { type: 'string', description: 'For action=openURL: the URL to open.' },
      script: { type: 'string', description: `For action=script: ${copy.scriptHelp.replace(/^script \(/, '').replace(/\)$/, '')}.` },
      timeoutSeconds: { type: 'integer', description: 'For action=script: how long the target may take (default 30).' },
      force: { type: 'boolean', description: 'For action=quit: force-kill instead of asking the app to quit.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          app: { type: 'string' },
          pid: { type: 'integer' },
          raised: { type: 'boolean' },
          result: { type: 'string' },
          path: { type: 'array', items: { type: 'string' } },
          url: { type: 'string' },
          reason: { type: 'string' },
          timeout: { type: 'boolean' },
        },
      },
      render: (_args, value) => text(renderApp(value)),
    },
    async execute(args, exec) {
      const action = args.action
      if (!WRITE_ACTIONS.includes(action)) {
        throw new Error(`unknown action "${action}"; expected one of ${WRITE_ACTIONS.join(', ')}`)
      }
      if (action === 'launch' && args.bundleId === undefined) {
        throw new Error('action=launch needs bundleId; find it with cua_apps')
      }
      if (action === 'openURL' && args.url === undefined) {
        throw new Error('action=openURL needs url')
      }
      if (action === 'reveal' && (args.path ?? []).length !== 1) {
        throw new Error('action=reveal needs path with exactly one filesystem path')
      }
      if (action === 'menu' && (args.path ?? []).length === 0) {
        throw new Error('action=menu needs a non-empty path such as ["File","Save"]')
      }
      if (action === 'script' && args.script === undefined) {
        throw new Error('action=script needs script')
      }

      await requireWriteApproval({
        mode,
        ctx,
        exec,
        reason: describeWrite(action, args),
      })

      const params: Record<string, unknown> = { action }
      if (args.app !== undefined) params.app = args.app
      if (args.pid !== undefined) params.pid = args.pid
      if (args.bundleId !== undefined) params.bundleId = args.bundleId
      if (args.windowTitle !== undefined) params.windowTitle = args.windowTitle
      if (args.path !== undefined) params.path = args.path
      if (args.url !== undefined) params.url = args.url
      if (args.script !== undefined) params.script = args.script
      if (args.timeoutSeconds !== undefined) params.timeoutSeconds = args.timeoutSeconds
      if (args.force !== undefined) params.force = args.force

      const raw = await tools.engine.request<Record<string, unknown>>({
        method: 'app',
        params,
        // A script may legitimately take its whole budget, and the engine adds
        // its own deadline on top, so the transport deadline must be longer.
        timeoutMs: action === 'script' ? (args.timeoutSeconds ?? 30) * 1_000 + 20_000 : 30_000,
        signal: exec.signal,
      })

      const reason = str(raw.reason)
      const path = arr(raw.path).map(entry => str(entry))
      return {
        action,
        ok: appOutcome(action, raw),
        ...str(raw.name) === '' ? {} : { app: str(raw.name) },
        ...typeof raw.pid === 'number' ? { pid: num(raw.pid, -1) } : {},
        ...typeof raw.raised === 'boolean' ? { raised: bool(raw.raised) } : {},
        ...str(raw.result) === '' ? {} : { result: str(raw.result) },
        ...path.length === 0 ? {} : { path },
        ...str(raw.url) === '' ? {} : { url: str(raw.url) },
        ...reason === '' ? {} : { reason },
        ...typeof raw.timeout === 'boolean' ? { timeout: bool(raw.timeout) } : {},
      }
    },
  })
}

/** The one sentence the user sees before a write is authorized. */
function describeWrite(action: string, args: {
  app?: string
  bundleId?: string
  url?: string
  script?: string
  path?: string[]
  force?: boolean
  windowTitle?: string
}): string {
  const target = args.app ?? args.bundleId ?? 'the frontmost application'
  switch (action) {
    case 'activate':
      return `Computer Use wants to bring ${target}${args.windowTitle === undefined ? '' : ` window "${args.windowTitle}"`} to the front of your screen.`
    case 'hide':
      return `Computer Use wants to hide ${target}.`
    case 'unhide':
      return `Computer Use wants to unhide ${target}.`
    case 'quit':
      return `Computer Use wants to ${args.force === true ? 'force-quit' : 'quit'} ${target}.`
    case 'launch':
      return `Computer Use wants to launch ${args.bundleId ?? 'an application'}.`
    case 'openURL':
      return `Computer Use wants to open ${args.url ?? 'a URL'}${args.bundleId === undefined ? '' : ` in ${args.bundleId}`}.`
    case 'reveal':
      return `Computer Use wants to reveal ${args.path?.[0] ?? 'a path'} in ${copy.osName === 'Windows' ? 'File Explorer' : 'Finder'}.`
    case 'menu':
      return `Computer Use wants to invoke the menu path ${(args.path ?? []).join(' → ')} in ${target}.`
    case 'script': {
      const source = args.script ?? ''
      const preview = source.length > 120 ? `${source.slice(0, 120)}…` : source
      return copy.osName === 'Windows'
        ? `Computer Use wants to run this PowerShell script on your desktop: ${preview}`
        : `Computer Use wants to send ${target} this Apple event script: ${preview}`
    }
    default:
      return `Computer Use wants to run "${action}" on ${target}.`
  }
}

/**
 * Whether an application action succeeded.
 *
 * The engine reports a differently named flag per action, and several actions
 * legitimately report partial success — `activate` can raise the window while
 * the process declines to become frontmost — so this reads the flags from most
 * to least specific and keeps the nuance instead of flattening it.
 */
function appOutcome(action: string, raw: Record<string, unknown>): boolean {
  const flag = (name: string): boolean | undefined =>
    typeof raw[name] === 'boolean' ? raw[name] as boolean : undefined
  switch (action) {
    case 'activate':
    case 'focus':
      return flag('raised') === true || flag('activated') === true
    case 'hide':
      return flag('hidden') ?? false
    case 'unhide':
      return flag('unhidden') ?? false
    case 'quit':
      return flag('terminated') ?? false
    case 'launch':
      return flag('launched') ?? false
    case 'openURL':
      return flag('opened') ?? false
    case 'reveal':
      return flag('revealed') ?? false
    case 'script':
      return flag('executed') ?? false
    case 'menu':
      return flag('performed') ?? flag('requested') ?? false
    default:
      return false
  }
}

/** Render one application action for a model. */
function renderApp(value: {
  action: string
  ok: boolean
  app?: string
  pid?: number
  raised?: boolean
  result?: string
  path?: string[]
  url?: string
  reason?: string
  timeout?: boolean
}): string {
  const detail = value.reason === undefined ? '' : ` ${value.reason}`
  if (!value.ok) {
    return `Action "${value.action}" did not succeed.${detail}`.trim()
  }
  switch (value.action) {
    case 'activate':
    case 'focus':
      return `Brought ${value.app ?? 'the application'} to the front${value.raised === true ? ' and raised its window' : ''}.`
        + (value.raised === false ? ' The window could not be raised; it may be minimized.' : '')
    case 'quit':
      return `Asked ${value.app ?? 'the application'} to quit.`
    case 'launch':
      return `Launched ${value.app ?? 'the application'}${value.pid === undefined ? '' : ` (pid ${String(value.pid)})`}.`
    case 'openURL':
      return `Opened ${value.url ?? 'the URL'}.`
    case 'reveal':
      return `Revealed ${value.path?.[0] ?? 'the path'} in ${copy.osName === 'Windows' ? 'File Explorer' : 'Finder'}.`
    case 'script':
      return `The application ran the script.${value.result === undefined || value.result === '' ? ' It returned no value.' : ` Result: ${value.result}`}`
    case 'menu':
      return `Invoked the menu path ${(value.path ?? []).join(' → ')}.`
    default:
      return `Ran "${value.action}"${value.app === undefined ? '' : ` on ${value.app}`}.`
  }
}
