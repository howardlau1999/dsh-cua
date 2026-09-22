/**
 * Computer Use for DeepSeek Harness.
 *
 * The plugin is a thin, typed seam over {@link EngineClient}: it owns tool
 * registration, the write-approval gate, and the model-facing guidance, while
 * every operating-system capability lives in the `cua-engine` helper. That split
 * is deliberate — it keeps the process that holds the Accessibility and Screen
 * Recording grants small and auditable, and it lets a second platform backend
 * arrive without touching the tool surface.
 *
 * @module
 */

import { appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { EngineClient } from './engine-client.ts'
import { Config, type Config as CuaConfig, type WriteApprovalMode } from './config.ts'
import { observationTools } from './tools-observe.ts'
import { interactionTools } from './tools-interact.ts'
import { applicationTools } from './tools-app.ts'
import { type ToolContext } from './shared.ts'

export { Config } from './config.ts'
export type { Config as CuaPluginConfig, WriteApprovalMode } from './config.ts'
export { EngineClient, EngineError } from './engine-client.ts'


/**
 * Boot log for diagnosing whether the plugin is reached at all.
 *
 * Module-scope on purpose: `apply` runs only after every injected service
 * exists, so a plugin that never applies looks exactly like a plugin that never
 * imported. This line is written when the module is evaluated, which happens
 * first, and again from `apply`, so the two failures can be told apart from
 * outside the host.
 */
const BOOT_LOG = process.env.DSH_CUA_BOOT_LOG ?? `${tmpdir()}/dsh-cua-boot.log`

function bootLog(stage: string, detail = ''): void {
  try {
    appendFileSync(BOOT_LOG, `${new Date().toISOString()} pid=${String(process.pid)} ${stage} ${detail}\n`)
  } catch {
    // A diagnostic must never be the reason a plugin fails to load.
  }
}

bootLog('module-evaluated', `execPath=${process.execPath}`)

/** Cordis identity for the Computer Use plugin. */
export const name = 'dsh-plugin-cua'

/** Services the plugin registers against and reads the session prompt from. */
export const inject = ['tools', 'systemPrompt']

/** How many tools the last apply registered, for the boot log. */
let TOOL_COUNT = 0

/** Section order: after the harness's own tool guidance, before trailing context. */
const PROMPT_SECTION_ORDER = 900

/** Where the compiled engine sits inside an installed plugin package. */
const ENGINE_RELATIVE_PATH = join('lib', 'bin', 'cua-engine')

/**
 * The guidance a session gets whenever the plugin is loaded.
 *
 * This is prompt content, not documentation: it states the rules that keep the
 * loop efficient and the coordinate conventions that make a click land where the
 * model thinks it will.
 */
const GUIDANCE = `## Computer Use

You can see and operate the macOS desktop through the \`cua_*\` tools. They drive
the user's real machine: a click moves their pointer, typing lands in whatever
has focus, and an Apple event can change another application's documents.

### Perceive before acting, and re-perceive after

Read the UI before you touch it, and verify after. Two independent ways to see:

- \`cua_tree\` — the accessibility tree, one line per element with an index,
  role, title, value, and state. Prefer this: it is text, it is cheap, it names
  elements you can target by index, and it exposes state a picture cannot
  (disabled, focused, selected, placeholder). It is always truncated by a
  budget; the result says which one, so narrow the query rather than assuming
  the view was complete.
- \`cua_screenshot\` — pixels, saved to a file. Use it for canvas content,
  images, rendered layout, and anything the tree does not expose. The result
  carries the path (read it with \`read_image\` to actually see it), plus the
  captured \`region\` in screen points and \`scale\` (image pixels per screen
  point). A feature at image pixel (px, py) is at screen point
  \`(region.x + px/scale, region.y + py/scale)\`.

### Prefer the highest-level mechanism that can do the job

In descending order of reliability:

1. \`cua_app\` with a \`script\` action — the target application performs the
   work itself. Best for any scriptable app.
2. \`cua_app\` with \`activate\`, \`menu\`, \`openURL\`, \`quit\` — direct API calls,
   no pointer involved.
3. \`cua_element\` — ask an element to perform its own action (\`press\`,
   \`setValue\`, \`focus\`). Works on background windows and cannot miss.
5. \`cua_click\` / \`cua_type\` without an element / \`cua_key\` — synthesized input
   aimed at whatever is frontmost. Necessary for canvas apps and anything with
   no accessibility surface, but it depends on window positions and focus.

Coordinates everywhere are **top-left-origin screen points**: the same space
\`cua_windows\` frames and \`cua_tree\` geometry use, and the space screenshots
convert into. A right-click needs \`button: "right"\`; a shortcut needs
\`cua_key\` (\`cua_type\` would type the characters literally).

On a machine with more than one display, call \`cua_displays\` before doing
coordinate arithmetic. Secondary displays can sit at negative x or y, each may
have a different pixel density, and a point outside every display is rejected
rather than clamped. Take the pixel-to-point scale from the screenshot result in
hand — it is measured per capture, not a constant.

### Permissions

\`cua_status\` reports exactly which macOS permissions are granted and what to do
about the rest. Accessibility covers trees, input, and element actions; Screen
Recording covers screenshots. When a tool reports a permission problem, call
\`cua_status\` and relay its remediation to the user — do not retry the same call
hoping for a different result.

### Authorization

Reads run without asking. Writes — anything that moves the pointer, types,
performs an element action, or drives another application — pass through the
session's approval gate first. If the user or the session policy refuses, the
action never reaches the operating system; report the refusal instead of working
around it.`

/**
 * Register the Computer Use tools.
 *
 * @param ctx - plugin context; `tools` and `systemPrompt` are guaranteed ready.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: CuaConfig = {}): void {
  bootLog('apply-enter', `config=${JSON.stringify(config)}`)
  let enginePath: string
  try {
    enginePath = resolveEnginePath(config, ctx)
  } catch (error) {
    bootLog('apply-failed', `resolveEnginePath: ${String(error)}`)
    throw error
  }
  const mode: WriteApprovalMode = config.writeApproval ?? 'always'

  const engine = new EngineClient({
    executablePath: enginePath,
    ...config.idleShutdownMs === undefined ? {} : { idleShutdownMs: config.idleShutdownMs },
  })
  // One process per host, torn down with the plugin fiber rather than leaked.
  ctx.effect(() => () => { engine.close() })

  const tools: ToolContext = {
    engine,
    maxCaptureDimension: config.maxCaptureDimension ?? 1568,
    screenshotDir: config.screenshotDir,
  }

  ctx.systemPrompt.section({
    name: 'cua:guidance',
    order: PROMPT_SECTION_ORDER,
    text: GUIDANCE,
  })

  const registered = [
    ...observationTools(ctx, tools),
    ...interactionTools(ctx, tools, mode),
    ...applicationTools(ctx, tools, mode),
  ]
  for (const tool of registered) ctx.tools.register(tool)
  TOOL_COUNT = registered.length

  // Diagnostics: two probe tools that differ only in how they are declared. If
  // one reaches the model and the other does not, the difference is the
  // declaration path rather than anything about this plugin's behaviour.
  ctx.tools.register({
    name: 'cua_probe_raw',
    description: 'Diagnostic probe registered with a raw JSON Schema definition (no defineTool). '
      + 'Its presence or absence in the model tool list isolates whether the tool declaration path is at fault.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: () => [{ type: 'text', text: 'cua_probe_raw reached the model.' }],
    },
    async execute() { return 'cua_probe_raw reached the model.' },
  })
  bootLog('probe-raw-registered')

  // Read the registry back from the service the tools were registered into.
  // A registration that lands in a different registry than the agent reads is
  // indistinguishable from one that never happened, so the count is taken from
  // the service itself rather than from the loop.
  try {
    const runtime = ctx.tools as unknown as { schemas?: (scope?: unknown) => { name: string }[] }
    const visible = typeof runtime.schemas === 'function' ? runtime.schemas() : undefined
    bootLog('registry', visible === undefined
      ? `schemas() unavailable; shapes=${Object.keys(runtime).join(',')}`
      : `count=${String(visible.length)} cua=${String(visible.filter(t => t.name.startsWith('cua_')).length)} names=${visible.map(t => t.name).join(',')}`)
  } catch (error) {
    bootLog('registry-failed', String(error))
  }
  bootLog('apply-done', `tools=${String(TOOL_COUNT)} engine=${enginePath}`)

  // Re-read the registry later. A tool registered during host boot and a tool
  // registered after the first session mounts are both supposed to be visible,
  // but only one of those is observed to work here, so the count is sampled over
  // time to tell "never registered" from "registered and then lost".
  const sample = (label: string): void => {
    try {
      // The decisive reading: a Context carrying a scope tag registers into that
      // scope's private layer, which only that scope and its descendants can see.
      // The global layer is the one every agent inherits. The tag symbol is
      // module-private, so the package's own accessor is the only way to ask —
      // reached through createRequire because a bundled ESM module has no `require`.
      let tagged = 'unknown'
      try {
        const { scopeOf } = createRequire(import.meta.url)('@deepseek-ai/dsh-scope') as {
          scopeOf: (c: unknown) => unknown
        }
        tagged = String(scopeOf(ctx) !== undefined)
      } catch (error) {
        tagged = `unreadable: ${String(error).slice(0, 80)}`
      }
      bootLog(`${label}-scope`, `tagged=${tagged}`)
      const runtime = ctx.tools as unknown as { schemas?: (scope?: unknown) => { name: string }[] }
      const visible = runtime.schemas?.()
      bootLog(label, visible === undefined
        ? 'schemas() unavailable'
        : `count=${String(visible.length)} cua=${String(visible.filter(t => t.name.startsWith('cua_')).length)}`)
    } catch (error) {
      bootLog(label, `failed: ${String(error)}`)
    }
  }
  const timer = setInterval(() => { sample('registry-later') }, 5000)
  // Never hold the process open for a diagnostic.
  timer.unref?.()
  ctx.effect(() => () => { clearInterval(timer) })
  ctx.logger.info(
    `dsh-plugin-cua ready: engine ${enginePath}, write approval "${mode}"`,
  )
}

/**
 * Resolve the engine executable.
 *
 * Order: explicit configuration, then the binary shipped inside this package,
 * then a debug build from a source checkout. The last one keeps the plugin
 * usable during development without a packaging step, and every failure names
 * the exact command that produces the missing file.
 *
 * @param config - plugin configuration.
 * @param ctx - plugin context, used for the diagnostic message.
 * @returns an absolute path to the engine executable.
 * @throws Error when no candidate exists.
 */
export function resolveEnginePath(config: CuaConfig, ctx?: Pick<Context, 'logger'>): string {
  // `src/index.ts` and the built `lib/index.js` sit at the same depth.
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const candidates = [
    ...config.enginePath === undefined ? [] : [config.enginePath],
    join(packageRoot, ENGINE_RELATIVE_PATH),
    join(packageRoot, 'native', 'cua-engine', '.build', 'out', 'Products', 'Debug', 'cua-engine'),
    join(packageRoot, 'native', 'cua-engine', '.build', 'out', 'Products', 'Release', 'cua-engine'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate)
  }
  const searched = candidates.map(candidate => `  - ${candidate}`).join('\n')
  const message = [
    'the cua-engine executable was not found. Searched:',
    searched,
    'Build it with `pnpm run build:engine` inside the plugin package, or set enginePath in the plugin configuration.',
  ].join('\n')
  ctx?.logger.warn(message)
  throw new Error(message)
}
