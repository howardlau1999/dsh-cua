/**
 * Shared helpers for turning engine results into model-facing tool output.
 *
 * Every tool follows the same two-layer contract: `output.schema` declares the
 * canonical value a program can read, and `output.render` writes the prose a
 * model reads. Keeping the prose here means one place decides how a tree, a
 * window list, or a captured image is described.
 *
 * @module
 */

import type { EngineClient } from './engine-client.ts'

/**
 * The one content block this plugin produces.
 *
 * Declared structurally instead of imported: `dsh-tools` owns the tool
 * contract but does not re-export the LLM content vocabulary, and a text block
 * is the whole of what these tools emit — the model reads screenshots through
 * the harness's own image reader, not through a tool block.
 */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Render one plain-text tool result. */
export function text(block: string): TextBlock[] {
  return [{ type: 'text', text: block }]
}

/** A JSON object as the engine reports it. */
export type EngineObject = Record<string, unknown>

/** Read a string field without trusting the shape. */
export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Read a number field without trusting the shape. */
export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Read a boolean field without trusting the shape. */
export function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Read an array field without trusting the shape. */
export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Read an object field without trusting the shape. */
export function obj(value: unknown): EngineObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as EngineObject
    : {}
}

/** One row of `app.list`. */
export interface AppRow {
  name: string
  bundleId: string
  pid: number
  active: boolean
  hidden: boolean
  policy: string
  path: string
}

/** One row of `window.list`. */
export interface WindowRow {
  title: string
  app: string
  pid: number
  windowId: number | null
  frame: number[] | null
  main: boolean
  focused: boolean
  minimized: boolean
}

/** Normalize one application row. */
export function toAppRow(value: unknown): AppRow {
  const row = obj(value)
  return {
    name: str(row.name),
    bundleId: str(row.bundleId),
    pid: num(row.pid, -1),
    active: bool(row.active),
    hidden: bool(row.hidden),
    policy: str(row.policy, 'regular'),
    path: str(row.path),
  }
}

/** Normalize one window row. */
export function toWindowRow(value: unknown): WindowRow {
  const row = obj(value)
  const frame = Array.isArray(row.frame) ? row.frame.map(entry => num(entry)) : null
  return {
    title: str(row.title),
    app: str(row.app),
    pid: num(row.pid, -1),
    windowId: typeof row.windowId === 'number' ? row.windowId : null,
    frame: frame !== null && frame.length === 4 ? frame : null,
    main: bool(row.main),
    focused: bool(row.focused),
    minimized: bool(row.minimized),
  }
}

/** Normalize the `permissions` object from `engine.status`. */
export interface PermissionReport {
  platform: string
  platformVersion: string
  accessibility: boolean
  screenRecording: boolean
  /** True only when every permission is granted AND the console is unlocked. */
  ready: boolean
  missing: string[]
  /** The console session is locked, which blocks capture and makes input unreliable. */
  sessionLocked: boolean
  hint: string
  executablePath: string
  processId: number
  /**
   * Whether the engine holds an elevated token, when the backend reports it.
   *
   * Windows-only, and optional on purpose: macOS has no equivalent — there is no
   * integrity boundary between two processes owned by the same user — so the
   * field is absent there rather than defaulted to a value that would read as a
   * measurement. Windows reports it because UIPI silently discards input aimed
   * at an elevated window and withholds that window's contents from a tree, and
   * "the window cannot be reached" is a very different report to the user than
   * "the engine is broken".
   */
  elevated?: boolean
}

/** Normalize a permission report. */
export function toPermissionReport(value: unknown): PermissionReport {
  const row = obj(value)
  return {
    platform: str(row.platform),
    platformVersion: str(row.platformVersion),
    accessibility: bool(row.accessibility),
    screenRecording: bool(row.screenRecording),
    ready: bool(row.ready),
    missing: arr(row.missing).map(entry => str(entry)).filter(entry => entry !== ''),
    sessionLocked: bool(row.sessionLocked),
    hint: str(row.hint),
    executablePath: str(row.executablePath),
    processId: num(row.processId, -1),
    // Carried through only when the backend actually reported it. `bool()` would
    // turn macOS's absent field into `false`, which is indistinguishable from a
    // measured "not elevated" and would put a Windows-only claim in a macOS
    // report.
    ...(typeof row.elevated === 'boolean' ? { elevated: row.elevated } : {}),
  }
}

/** The client plus the resolved configuration a tool module needs. */
export interface ToolContext {
  readonly engine: EngineClient
  readonly maxCaptureDimension: number
  readonly screenshotDir: string | undefined
}

/** Render a window row as one outline line. */
export function formatWindow(row: WindowRow): string {
  const id = row.windowId === null ? 'id=?' : `id=${row.windowId}`
  const focus = row.focused ? ' focused' : row.main ? ' main' : ''
  const minimized = row.minimized ? ' minimized' : ''
  const size = row.frame === null ? '' : ` at ${row.frame[0]},${row.frame[1]} ${row.frame[2]}x${row.frame[3]}`
  const title = row.title === '' ? '(untitled)' : row.title
  return `${id} [${row.app}] ${title}${size}${focus}${minimized}`
}

/**
 * Whether an engine failure is a permission problem the user must fix.
 *
 * Kept here so every tool reports the same remediation instead of each one
 * inventing its own phrasing for the same macOS condition.
 */
export function permissionMessage(message: string, hint: string): string {
  return hint === '' ? message : `${message}\n\n${hint}`
}

/** One accessibility element as the tree tool reports it. */
export interface TreeNode {
  depth: number
  role: string
  title: string
  value: string
  description: string
  placeholder: string
  actionable: boolean
  enabled: boolean
  focused: boolean
  selected: boolean
  /** Present only when the engine was asked for geometry and the element has a frame. */
  frame?: number[]
}

/**
 * Normalize one engine tree node.
 *
 * The engine already applies the text cap and omits empty fields; this projects
 * the result onto the declared contract so the canonical value has one exact
 * shape regardless of which attributes an application chose to expose.
 */
export function toTreeNode(value: unknown): TreeNode {
  const row = obj(value)
  const frame = Array.isArray(row.frame) ? row.frame.map(entry => num(entry)) : null
  return {
    depth: num(row.depth),
    role: str(row.role),
    title: str(row.title),
    value: str(row.value),
    description: str(row.description),
    placeholder: str(row.placeholder),
    actionable: bool(row.actionable),
    // Absent `AXEnabled` means the application does not expose the state; an
    // element that omits it is not disabled, so the honest default is enabled.
    enabled: row.enabled === undefined ? true : bool(row.enabled),
    focused: bool(row.focused),
    selected: bool(row.selected),
    ...frame !== null && frame.length === 4 ? { frame } : {},
  }
}
