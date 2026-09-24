/**
 * Computer Use for DeepSeek Harness.
 *
 * The plugin is a thin, typed seam over {@link EngineClient}: it owns tool
 * registration, the write-approval gate, and the model-facing guidance, while
 * every operating-system capability lives in the `cua-engine` helper. That split
 * is deliberate — it keeps the process that holds the Accessibility and Screen
 * Recording grants small and auditable, and it is what let a second platform
 * backend arrive without touching the tool surface.
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
import { registerComputerUse, PROVIDER_NAME } from './computer-use.ts'
import { type ToolContext } from './shared.ts'
import { copy, platform } from './platform.ts'

export { Config } from './config.ts'
export type { Config as CuaPluginConfig, WriteApprovalMode } from './config.ts'
export { EngineClient, EngineError } from './engine-client.ts'
export { registerComputerUse, PROVIDER_NAME } from './computer-use.ts'


/** Cordis identity for the Computer Use plugin. */
export const name = 'dsh-plugin-cua'

/** Services the plugin registers against and reads the session prompt from. */
export const inject = ['tools', 'systemPrompt']

/**
 * Where the guidance section goes when the host will not say.
 *
 * The harness publishes one order for computer-use guidance, and its own
 * providers ask for it rather than naming a number. This plugin hardcoded 900,
 * and the table has since moved past that value: 900 is `FILE_REFERENCE` today,
 * and it sits *before* every tool section rather than after them the way the
 * comment that used to sit here claimed. The number below is the harness's
 * `TOOL_COMPUTER_USE`, used only when the host does not answer.
 */
const FALLBACK_GUIDANCE_ORDER = 3000

/**
 * The slice of the prompt service this plugin asks for an order.
 *
 * Declared locally, like the approval and computer-use slices, because the host
 * type this package compiles against lags the host's own table: the union
 * `getSectionOrder` accepts has no `TOOL_COMPUTER_USE` in it, while the running
 * host defines that name — measured on the shipped application, whose table reads
 * `TOOL_COMPUTER_USE: 3000`. Asking through a narrow local slice is right on
 * both: an unknown name yields `undefined`, and the fallback covers it.
 */
interface PromptOrderCapability {
  getSectionOrder?: (name: string) => number | undefined
}

/**
 * The engine executable's name inside the package's `lib/bin`.
 *
 * The two backends are separate builds of separate programs — a Swift binary
 * and a .NET executable — and Windows only runs an executable it finds by its
 * full name, extension included.
 */
const ENGINE_EXECUTABLE = platform === 'windows' ? 'cua-engine.exe' : 'cua-engine'

/**
 * Where the compiled engine sits inside an installed plugin package.
 *
 * Windows has two layouts, because the build can publish either way: a folder
 * (`lib/bin/cua-engine/cua-engine.exe`, the default — it ships its dependencies
 * beside the executable and self-extracts nothing) or a single file at the top
 * of `lib/bin`. macOS always installs a single file named `cua-engine`.
 */
const ENGINE_RELATIVE_PATHS = platform === 'windows'
  ? [join('lib', 'bin', 'cua-engine', 'cua-engine.exe'), join('lib', 'bin', 'cua-engine.exe')]
  : [join('lib', 'bin', 'cua-engine')]

/**
 * The guidance a session gets whenever the plugin is loaded.
 *
 * This is prompt content, not documentation: it states the rules that keep the
 * loop efficient and the coordinate conventions that make a click land where the
 * model thinks it will.
 */
const GUIDANCE = `## Computer Use

You can see and operate the ${copy.osName} desktop through the \`cua_*\` tools. They
drive the user's real machine: a click moves their pointer, typing lands in whatever
has focus, and an application action can change another program's state.

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
  captured \`region\` in screen coordinates and \`scale\` (image pixels per screen
  unit). A feature at image pixel (px, py) is at screen point
  \`(region.x + px/scale, region.y + py/scale)\`.

### Prefer the highest-level mechanism that can do the job

In descending order of reliability:

1. \`cua_app\` — activate, menu, openURL, quit, hide: direct API calls, no
   pointer involved.${platform === 'macos' ? ' On macOS a \`script\` action goes further still: the application performs the work itself through an Apple event.' : ''}
2. \`cua_element\` — ask an element to perform its own action (\`press\`,
   \`setValue\`, \`focus\`). Works on background windows and cannot miss.
3. \`cua_type\` with an \`element\` — focus a specific control and type into it.
4. \`cua_click\` / \`cua_type\` without an element / \`cua_key\` — synthesized input
   aimed at whatever is frontmost. Necessary for canvas apps and anything with
   no accessibility surface, but it depends on window positions and focus.

Coordinates everywhere are **top-left-origin screen coordinates**: the same space
\`cua_windows\` frames and \`cua_tree\` geometry use, and the space screenshots
convert into. A right-click needs \`button: "right"\`; a shortcut needs
\`cua_key\` (\`cua_type\` would type the characters literally).

On a machine with more than one display, call \`cua_displays\` before doing
coordinate arithmetic. Secondary displays can sit at negative x or y, and a point
outside every display is rejected rather than clamped. Take the pixel-to-point
scale from the screenshot result in hand — it is measured per capture, not a
constant.

### Permissions

\`cua_status\` reports exactly what this machine grants the engine and what to do
about the rest.${platform === 'macos'
    ? ' Accessibility covers trees, input, and element actions; Screen Recording covers screenshots.'
    : ' Windows grants UI Automation, screen capture, and input synthesis to every process, so nothing has to be enabled; the one limit is elevation, which cua_status reports.'}
When a tool reports a permission problem, call
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
    // Capability flags the engine cannot infer. On macOS this list is empty and
    // `cua_app script` is always available; on Windows it is what turns a
    // PowerShell escape hatch on.
    args: platform === 'windows' && config.allowedScript === true ? ['--allow-script'] : [],
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
    // The host's own order for computer-use guidance, so this section lands where
    // the harness expects tool guidance rather than at a number this package
    // picked and the harness later moved past. See FALLBACK_GUIDANCE_ORDER.
    order: (ctx.systemPrompt as unknown as PromptOrderCapability).getSectionOrder?.('TOOL_COMPUTER_USE')
      ?? FALLBACK_GUIDANCE_ORDER,
    text: GUIDANCE,
  })

  for (const tool of observationTools(ctx, tools)) ctx.tools.register(tool)
  for (const tool of interactionTools(ctx, tools, mode)) ctx.tools.register(tool)
  for (const tool of applicationTools(ctx, tools, mode)) ctx.tools.register(tool)

  // Claim the harness's computer-use slot when that capability is mounted. The
  // tools are already registered at this point, matching the built-in
  // providers, which reserve the slot only once their catalog is ready.
  const claimed = registerComputerUse(ctx)

  ctx.logger.info(
    `dsh-plugin-cua ready: engine ${enginePath} (${platform}), write approval "${mode}"`
      + (claimed ? `, computer use provider "${PROVIDER_NAME}"` : ', no computer-use service mounted'),
  )
}

/**
 * Resolve the engine executable.
 *
 * Order: explicit configuration, then the binary shipped inside this package,
 * then a debug build from a source checkout. The last ones keep the plugin
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
    ...ENGINE_RELATIVE_PATHS.map(relative => join(packageRoot, relative)),
    // A SwiftPM build is macOS-only, and a `dotnet build` is Windows-only; each
    // is listed so a source checkout works without a packaging step.
    join(packageRoot, 'native', 'cua-engine', '.build', 'out', 'Products', 'Debug', 'cua-engine'),
    join(packageRoot, 'native', 'cua-engine', '.build', 'out', 'Products', 'Release', 'cua-engine'),
    join(packageRoot, 'native', 'cua-engine-win', 'bin', 'Release', 'net9.0-windows', 'cua-engine.exe'),
    join(packageRoot, 'native', 'cua-engine-win', 'bin', 'Debug', 'net9.0-windows', 'cua-engine.exe'),
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
