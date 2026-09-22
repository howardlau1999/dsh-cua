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

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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


/** Cordis identity for the Computer Use plugin. */
export const name = 'dsh-plugin-cua'

/** Services the plugin registers against and reads the session prompt from. */
export const inject = ['tools', 'systemPrompt']

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
  const enginePath = resolveEnginePath(config, ctx)
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

  for (const tool of observationTools(ctx, tools)) ctx.tools.register(tool)
  for (const tool of interactionTools(ctx, tools, mode)) ctx.tools.register(tool)
  for (const tool of applicationTools(ctx, tools, mode)) ctx.tools.register(tool)

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
