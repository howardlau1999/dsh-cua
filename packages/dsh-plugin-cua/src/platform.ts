/**
 * Platform copy for the tool surface.
 *
 * @module
 */

/**
 * Which backend this plugin is talking to.
 *
 * Read from `process.platform` rather than probed from the engine: the engine is
 * a child process on this same machine, so the host's platform *is* the engine's
 * platform, and knowing it synchronously is what lets the tool descriptions be
 * accurate at registration time instead of after the first call.
 */
export type PlatformKind = 'macos' | 'windows' | 'other'

/** The backend this host will run. */
export const platform: PlatformKind =
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'other'

/**
 * The sentences that differ between backends.
 *
 * These are prompt content, not cosmetics: a tool that promises an Apple event
 * on a Windows machine, or asks for a "bundle id" when the identifier in play is
 * an Application User Model ID, teaches the model to call things that do not
 * exist. Everything platform-specific in a description comes from here so there
 * is one place to check.
 */
export interface PlatformCopy {
  /** Human-readable OS name. */
  readonly osName: string
  /** How the tree and input tools are gated. */
  readonly treePermission: string
  /** How the capture tool is gated. */
  readonly capturePermission: string
  /** What the status tool raises when `request` is true. */
  readonly requestHelp: string
  /** How to describe the per-application identifier. */
  readonly appIdNoun: string
  /** Where that identifier comes from. */
  readonly appIdHelp: string
  /** Example role names for the tree filter. */
  readonly roleExamples: string
  /** Modifier vocabulary for `cua_key`. */
  readonly modifiers: string
  /** What `route: "pid"` actually does. */
  readonly routeHelp: string
  /** How a background window can be typed into. */
  readonly backgroundTyping: string
  /** What `cua_element` press does under the hood. */
  readonly pressHelp: string
  /** What `cua_app` script does. */
  readonly scriptHelp: string
  /** What `cua_app` reveal does. */
  readonly revealHelp: string
  /** What `cua_app` launch takes. */
  readonly launchHelp: string
}

const MACOS: PlatformCopy = {
  osName: 'macOS',
  treePermission: 'Requires Accessibility permission.',
  capturePermission: 'Requires Screen Recording permission.',
  requestHelp: 'Raise the macOS permission prompts for anything still missing. The user still has to confirm in System Settings.',
  appIdNoun: 'bundle id',
  appIdHelp: 'a macOS bundle identifier such as "com.apple.TextEdit"',
  roleExamples: '["AXButton","AXTextField"]',
  modifiers: 'cmd, shift, alt (option), ctrl, fn',
  routeHelp: '"post" (the default) sends events through the window server exactly like a physical mouse, which moves the visible cursor and reaches whatever is frontmost; "pid" delivers straight to one process, leaving the cursor alone.',
  backgroundTyping: 'the engine focuses it and delivers the keystrokes straight to that application, which is the only way to type into a BACKGROUND window the user is not looking at',
  pressHelp: 'press (AXPress, falling back to a click at the element center)',
  scriptHelp: 'script (send the application an Apple event — the app performs the work itself, which is the most reliable way to drive a scriptable app)',
  revealHelp: 'reveal (show a path in Finder)',
  launchHelp: 'launch (start an installed app by bundle id)',
}

const WINDOWS: PlatformCopy = {
  osName: 'Windows',
  treePermission: 'Requires no permission: Windows grants UI Automation to every process. An unelevated engine cannot reach a window owned by an elevated process, which is the one limit and the one cua_status reports.',
  capturePermission: 'Requires no permission: Windows grants screen capture to every process.',
  requestHelp: 'There is nothing to grant on Windows — UI Automation and screen capture are available to every process and no prompt exists. The call still reports the current state and the elevation situation.',
  appIdNoun: 'app id',
  appIdHelp: 'an Application User Model ID, an executable path, or a Start-menu shortcut path — whichever cua_apps reported',
  roleExamples: '["Button","Edit"]',
  modifiers: 'win, shift, alt, ctrl',
  routeHelp: '"post" (the default) synthesizes input through SendInput exactly like a physical mouse, which moves the visible cursor and reaches whatever is frontmost; "pid" posts window messages straight to a background window, leaving the cursor alone — classic Win32 controls honour them, but applications that read the real cursor position (browsers, UWP) do not.',
  backgroundTyping: 'the engine focuses it first and then types; Windows has no per-process key delivery, so unlike macOS this brings the target window to the front',
  pressHelp: 'press (whichever of Invoke, Toggle, Select, or Expand the control exposes, falling back to a click at the element center)',
  scriptHelp: 'script (run a PowerShell snippet — Windows has no Apple-event equivalent, and because a script is not scoped to one application it is disabled unless the plugin sets allowedScript)',
  revealHelp: 'reveal (show a path in File Explorer)',
  launchHelp: 'launch (start an app by its app id or path from cua_apps)',
}

const OTHER: PlatformCopy = {
  ...MACOS,
  osName: 'this platform',
}

/** The copy for the platform this host runs on. */
export const copy: PlatformCopy =
  platform === 'macos' ? MACOS : platform === 'windows' ? WINDOWS : OTHER
