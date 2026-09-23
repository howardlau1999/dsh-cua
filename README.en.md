# dsh-cua — Computer Use for DeepSeek Harness

English | [中文](README.md)

Let a model see and operate the local desktop: read the UI control tree of
foreground and background applications, take screenshots, synthesize mouse and
keyboard input, and drive applications directly.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
package: twelve `cua_*` tools over a native engine.

Both **macOS** (Accessibility + ScreenCaptureKit + Quartz Event Services + Apple
Events) and **Windows** (UI Automation + SendInput + GDI screen capture + Shell)
are implemented. The engine's JSON-RPC protocol and the plugin's tool layer are
platform-independent: the two backends implement the same methods, the same
response fields, and the same error codes, so the tool surface does not change
at all. How the Windows backend differs from macOS — and the reason for each
difference — is in [docs/windows-backend.md](packages/dsh-plugin-cua/docs/windows-backend.md);
the engine's complete wire contract is in
[docs/engine-contract.md](packages/dsh-plugin-cua/docs/engine-contract.md).

## Repository layout

```
cua/
└── packages/dsh-plugin-cua/
    ├── src/                          # TypeScript plugin (DSH side, platform-independent)
    │   ├── index.ts                  # entry point: registers the tools + system prompt guidance
    │   ├── engine-client.ts          # engine subprocess client (NDJSON over stdio)
    │   ├── approval.ts               # write authorization gate (reads free / writes gated)
    │   ├── config.ts                 # configuration schema (schemastery)
    │   ├── platform.ts               # picks tool descriptions and prompt wording per host platform
    │   ├── shared.ts                 # result normalization and rendering helpers
    │   ├── tools-observe.ts          # cua_status / cua_displays / cua_apps / cua_windows / cua_tree / cua_screenshot
    │   ├── tools-interact.ts         # cua_click / cua_type / cua_key / cua_element
    │   └── tools-app.ts              # cua_app
    ├── native/cua-engine/            # macOS native engine (Swift)
    │   └── Sources/CuaEngine/
    │       ├── Engine.swift          # protocol dispatch loop + stdio service
    │       ├── Protocol.swift        # request/response/error codes + the PlatformHost interface
    │       ├── MacHost.swift         # macOS backend: permissions, applications, windows, tree
    │       ├── MacHost+Actions.swift # macOS backend: pointer, keyboard, element actions, capture, application control
    │       ├── Tree.swift            # tree walk (budgets, filters, outline rendering)
    │       ├── Capture.swift         # ScreenCaptureKit capture and coordinate conversion
    │       ├── Pointer.swift         # CGEvent mouse events
    │       ├── Keyboard.swift        # CGEvent keys / Unicode text / virtual keycode table
    │       ├── AppleEvents.swift     # AppleScript and NSWorkspace application control
    │       ├── AX.swift, AXArray.swift, JSONValue.swift, JSONReader.swift
    │       └── main.swift            # CLI entry point (serve / --probe / --call)
    ├── native/cua-engine-win/        # Windows native engine (C# / .NET 9)
    │   ├── CuaEngine.csproj
    │   ├── app.manifest              # per-monitor DPI awareness v2
    │   └── src/
    │       ├── Program.cs            # STA entry point + stdio loop + CLI
    │       ├── Protocol.cs           # the same envelope and error codes as the Swift side
    │       ├── Params.cs             # strictly typed parameter reading
    │       ├── PlatformHost.cs       # the PlatformHost interface + dispatch
    │       └── Win/
    │           ├── Native.cs         # Win32 / DWM / GDI / Shell interop
    │           ├── Discovery.cs      # displays, windows, processes
    │           ├── Keymap.cs         # key name → virtual key code
    │           ├── WinHost.cs        # permissions, displays, applications, windows
    │           ├── WinHost.Tree.cs   # UIA walk, outline, element snapshots
    │           ├── WinHost.Capture.cs / Input.cs / Element.cs / App.cs
    ├── scripts/
    │   ├── build-engine.mjs          # build the engine with the toolchain process.platform selects
    │   ├── smoke.mjs                 # end-to-end smoke test (real engine, real system)
    │   └── check-schemas.mjs         # validate tool schemas with the harness's own validator
    ├── docs/                         # engine wire contract + Windows backend notes
    └── lib/                          # build output: index.js + bin/cua-engine (a single file on macOS, a directory on Windows)
```

## Two-layer design

**The native engine (`cua-engine`)** is the only process holding
operating-system capabilities. It is a long-lived subprocess speaking one JSON
object per line over stdin/stdout:

```json
{"id":1,"method":"tree.dump","params":{"app":"Finder","maxDepth":4}}
{"id":1,"result":{"app":"Finder","pid":642,"nodes":[...],"text":"[0] AXApplication …"}}
{"id":2,"error":{"code":"permission_denied","message":"…","settingsPane":"…"}}
```

It is a separate process for three practical reasons:

1. **There is a clear thing to authorize.** macOS grants Accessibility and
   Screen Recording to a process (and its responsible process), and a small
   dedicated binary is easier to audit and to grant than a whole Electron
   application.
2. **Crash isolation.** When a target application stops responding, the
   accessibility calls stall with it — the engine is what hangs, not the
   harness.
3. **State lives where it gets reused.** Element snapshots (addressed by index),
   window ids, and timeout budgets live inside the engine rather than being
   rebuilt on every call.

**The TypeScript plugin** does three things: registers the tools, turns engine
results into text a model can read, and puts writes through the authorization
gate. Every platform-specific phrase in the tool descriptions and the system
prompt comes from `src/platform.ts`, so a Windows session never reads "press
cmd+s to open it" or "turn on Accessibility in System Settings" — sentences that
are not true on that machine.

## Tools

| Tool | Purpose | Permission |
|---|---|---|
| `cua_status` | Engine state, and exactly how to fix what is missing (a pure read) | — |
| `cua_request_permissions` | Ask for anything still missing, and return the same report; macOS raises the system dialog, Windows has nothing to grant | — |
| `cua_displays` | Display layout: each display's id, rectangle, pixel density, and the total desktop bounds | — |
| `cua_apps` | Running or installed applications (name, application id, pid, whether frontmost) | — |
| `cua_windows` | On-screen windows: `windowId`, owning application, title, screen rectangle | Accessibility (macOS) |
| `cua_tree` | The control tree, one indexed element per line; filterable by role, interactivity, geometry | Accessibility (macOS) |
| `cua_screenshot` | Window, display, or region capture written to PNG/JPEG, returning path + region + scale | Screen Recording (macOS) |
| `cua_click` | Click, double-click, right-click, drag, scroll; `route:post` uses the window server (macOS) / SendInput (Windows), `route:pid` goes direct-to-process / posts window messages | Accessibility (macOS) |
| `cua_type` | Type text (Unicode rides the event payload, so any keyboard layout, CJK, and emoji all work) | Accessibility (macOS) |
| `cua_key` | Named keys and chords (`cmd+shift+t`, `return`, `left`, `f5`) | Accessibility (macOS) |
| `cua_element` | Let an element perform its own action: `press`/`setValue`/`focus`/`scrollToVisible`/`menu`/`list` | Accessibility (macOS) |
| `cua_app` | Application lifecycle and direct control: `activate`/`quit`/`launch`/`openURL`/`reveal`/`menu`/`script` | Accessibility (macOS); `script` additionally needs Automation on macOS, and is off by default on Windows |

### Role vocabulary

A `role` in the tree is **the platform's own vocabulary**: macOS reports
`AXButton`, Windows reports the UI Automation control type `Button`. The `roles`
filter accepts **both** — an `AX`-prefixed name is stripped and mapped onto the
matching type (`AXTextField` → `Edit`, `AXStaticText` → `Text`, `AXLink` →
`Hyperlink`, and so on), so a model that learned the macOS names can still filter
on Windows. The reverse mapping is deliberately not done: making the Windows
outline pretend to speak AX vocabulary would only fall apart at the first
control type that has no AX counterpart.

`cua_element` results follow the same rule: macOS reports `AXPress`, Windows
reports the pattern it actually executed (`Invoke`/`Toggle`/`Select`/`Expand`),
because the latter says more.

### Coordinate system

One convention end to end: **top-left-origin screen points**, consistent with
`cua_windows`' `frame`, `cua_tree` geometry, and `cua_screenshot`'s `region`.
Quartz events are bottom-left-origin; the conversion happens inside the engine,
once.

A capture additionally returns `scale` (image pixels / screen points), so an
image pixel `(px, py)` is at screen point
`(region.x + px/scale, region.y + py/scale)`.

### Multiple displays

This is the part that goes wrong most easily, so it gets its own section.

**Coordinates**: globally top-left-origin screen points. The primary display's
top-left corner is `(0,0)`; a secondary display **above** the primary has a
negative y, and one to the **left** has a negative x. `cua_displays` lists each
display's rectangle and the total desktop bounds directly.

A capture rectangle is clipped to the one display it overlaps, and `region`
reports the area actually captured rather than the area requested — otherwise
`region x scale` would describe pixels that are not in the image. An untargeted
capture means the main display, not the bounding box of all displays, because
that box spans the gaps between them and belongs to no single display.

**Failures are explicit, never silent.** A coordinate outside every display is
rejected instead of being clamped to a screen edge; a stale element index fails
closed instead of addressing whatever now occupies it; a malformed coordinate
errors instead of degrading to "click the element's centre"; an ungranted
permission reports `permission_denied` with the System Settings pane rather than
returning an empty window list.

There is a real API trap here: `NSScreen.frame` is **bottom-left-origin**, while
`SCDisplay.frame` (ScreenCaptureKit) and `CGWindowListCopyWindowInfo` are
**top-left-origin**. Mix the two and any secondary display sitting above or to
the left of the primary is silently the wrong screen. Every geometric decision
inside the engine uses the latter space only; AppKit geometry takes part in none
of them.

**Pixel density is not a constant.** The same display reports different
pixel-per-point ratios to different calls:

- `SCDisplay.width / frame.width` reports 1.0 for the primary display on this
  machine while it actually renders at 2x — the ratio cannot be trusted.
- `captureImage(in:)` **silently switches density** with the region size: on one
  display a 400×300 region comes back at 2x and an 800×600 region at 1x.

So the engine **calibrates** a display the first time it is used — one native
full-screen grab, the true density measured from it and cached — and from then
on every region, window, and full-screen capture sets its output size explicitly
from that density. Each display's density is therefore constant and
reproducible:

```
primary   (1512x982 points)  -> 400x300-point region = 508x381 pixels  scale=1.270
secondary (1920x1080 points) -> 400x300-point region = 400x300 pixels  scale=1.000
```

And the `scale` of every capture is **measured from the image that came back**,
never assumed — a window capture carries the window's own backing scale, which
differs from a region capture on the same display. A model must use the `scale`
in the result it just received, not a remembered one: a capture's `region` +
`scale` always describe exactly the image it got.

**Out of bounds is rejected**: a point on no display is an outright error
carrying the actual desktop bounds, rather than letting the window server clamp
the cursor to a screen edge and deliver the event anyway — which turns one
arithmetic mistake into a click somewhere else.

**Display attribution**: `cua_screenshot` returns a `displayId`, and `window.list`
matches windows to displays by largest overlap. A window spanning displays goes
to the display holding the largest share of it.

### Coordinates on Windows

The same conventions, except that **one point is one physical pixel**. The engine
declares per-monitor DPI awareness v2, so UI Automation rectangles, `SendInput`
coordinates, `GetMonitorInfo` rectangles, and capture regions are all one space
with no conversion needed — a 150%-scaled laptop panel included.

`scale` on Windows is therefore always `1`, unless the caller asks for
downscaling with `maxWidth`/`maxHeight`; after downscaling it is still measured
from the image that came back. The macOS problem of densities needing
calibration does not exist on Windows.

Out-of-bounds rejection and cross-display attribution behave exactly as on
macOS.

### Reliability ladder

The plugin's system prompt asks the model to pick from this list in order,
preferring the higher rungs over the lower ones:

1. `cua_app` — `activate` / `menu` / `openURL` / `quit` / `hide`: direct API
   calls that never touch the pointer (on macOS, optionally `script` on top: the
   target application does the work itself)
2. `cua_element` — the element performs its own action, so there is no way to
   mis-click
3. `cua_type` with `element` — focus that control, then type: an explicit target
4. `cua_click`, `cua_type` without an element, `cua_key` — synthesized input
   aimed at whatever is frontmost, for when there is no accessibility interface
   to use

### Operating background applications

This is a **first-class case**, and it changes which mechanism is the right one:

**Reads do not depend on focus at all.** `cua_tree`, `cua_screenshot`,
`cua_windows`, and per-window capture all address a background application
directly. A window on another display, or covered by another window, still
captures — on Windows a window capture goes through `PrintWindow`, with the
window drawing itself, which holds even when it is occluded.

**`cua_element` is the background-safe way to act, on both platforms.** The
action is performed by the target application through its own accessibility
interface: no window needs to be frontmost, and focus is never taken from the
user.

**`cua_type` behaves differently per platform**, and this is measured rather than
assumed:

| Call | macOS, background window | Windows, background window |
|---|---|---|
| `cua_element` + `setValue` | ✅ the write succeeds, frontmost application unchanged | ✅ the write succeeds (`ValuePattern`), frontmost application unchanged |
| `cua_type` + `element` | ✅ the write succeeds (the engine focuses the element via AX first, then posts by pid) | ⚠️ the window is brought to the foreground before typing (Windows has no way to post keystrokes to a process) |
| `cua_type` with no element | ❌ reports `delivered=true`, but the **background application drops the text** | ❌ likewise only lands on whatever is frontmost |

On macOS the element-less call still posts by pid; the application simply
ignores it, unless its own accessibility focus is already on the target control.
Windows has no counterpart to `CGEventPostToPid` at all, so synthesized
keystrokes have exactly one path — and the `route` reported in a result is always
the one actually used.

**Do not activate an application in order to read it.** Bringing it forward
changes what the user is looking at, and no read requires it.

**`cua_click`'s `route: "pid"`** is the path that leaves the visible cursor alone
on both platforms, by different mechanisms: macOS posts to the process, Windows
posts window messages in client-area coordinates. Classic Win32 controls honour
the latter; applications that read the real cursor position (Chromium, UWP, most
canvas UIs) do not, and the result says so.

## Build

```sh
cd packages/dsh-plugin-cua
pnpm install
pnpm run build          # native engine + bundled plugin
```

`build-engine.mjs` picks the toolchain from `process.platform`: SwiftPM on macOS,
`dotnet publish` on Windows, and on anything else it skips the engine and prints
an explanation (the plugin still loads and reports `unsupported_platform`
truthfully).

Output:

- `lib/bin/cua-engine` (macOS, a single file) or `lib/bin/cua-engine/cua-engine.exe`
  (Windows, a directory)
- `lib/index.js` — the single-file ESM plugin bundle (`@deepseek-ai/dsh-tools`,
  `@deepseek-ai/cordis`, and `@deepseek-ai/schemastery` stay external and are
  resolved by the harness at runtime, which keeps service instances identical)
- `lib/types/*.d.ts` — type declarations

Building the Windows engine needs the .NET 9 SDK. The default publish is a
**directory** (237 files, about 126 MB) with no .NET runtime required on the
target machine. That default is an **antivirus** decision rather than a packaging
preference: `PublishSingleFile`, together with the
`IncludeNativeLibrariesForSelfExtract` that WPF requires, makes the executable
write native DLLs into `%TEMP%\.net\` on every start and load them from there —
which is what a dropper does. Three shapes are available:

| Build | Result | Trade-off |
|---|---|---|
| default | a `lib/bin/cua-engine/` directory | 237 files |
| `CUA_ENGINE_WIN_FRAMEWORK_DEPENDENT=1` | one 0.3 MB exe | the target must already have the .NET 9 desktop runtime |
| `CUA_ENGINE_WIN_SINGLE_FILE=1` | one ~120 MB exe | **self-extracts into `%TEMP%` on every start** |

### About antivirus software

The plugin synthesizes keyboard and mouse input, reads other processes' UI trees,
and captures the screen — **behaviourally indistinguishable from a remote-access
trojan**. Every endpoint protection product notices that, and it is not a code
quality problem. What can be reduced is the incidental signal from how the engine
is packaged, plus signing.

The only block measured on this machine was `Trojan:Win32/PowhidSubExec.B`, and it
hit the **command line** rather than the binary (the detection's `Resources` field
reads `CmdLine:_…`, and an on-demand scan of the 120 MB executable produced no
detection at all). The plugin's production path spawns the engine directly
(`node → cua-engine.exe`, see `EngineClient.ensureChild`) and **does not go through
PowerShell**; the only PowerShell in the product is `cua_app` with `action=script`,
which is off by default. That block came from driving the engine by hand through a
PowerShell tool call.

With a code-signing certificate configured, the build signs what it produces:

```powershell
$env:CUA_ENGINE_SIGN_PFX = 'C:\path\to\codesign.pfx'
$env:CUA_ENGINE_SIGN_PASSWORD = '…'
pnpm run build:engine
```

If the engine is falsely flagged, the right move is to file a developer
false-positive report at <https://www.microsoft.com/en-us/wdsi/filesubmission>
rather than to add an exclusion — the report fixes it for everyone. The full
analysis is in
[docs/windows-backend.md](packages/dsh-plugin-cua/docs/windows-backend.md#antivirus-smartscreen-and-being-mistaken-for-malware).

Checks:

```sh
pnpm run typecheck       # tsc --noEmit
pnpm run check:schemas   # validate every tool's input/output schema with the harness's validator
pnpm run validate:patch -- <cordis.patch.yml>   # validate a patch file with the harness's own loader, before it reaches a profile
pnpm run smoke           # end-to-end: load the plugin and call the real engine
pnpm run smoke:writes    # additionally moves the pointer and presses shift (visible side effects)
```

## Install

The package declares `dsh.bundle`, so the plugin manager can install it. In the
application: the sidebar's **Plugins** page (`ui-plugin-manager`) — the list under
Settings → Plugins is read-only — then the package's absolute directory:

```
/path/to/packages/dsh-plugin-cua
```

The manager installs into the **current profile**, which is the one the
application boots, and adds the package there as a bundle layer. The package's
`cordis.patch.yml` contributes one row: the plugin itself, with the engine
resolved from inside the package. There is no path to edit, and that is the
point — an absolute path would be wrong on every machine but the one it was
written on, and one path could not be right for both platforms anyway, since the
Windows engine is a directory (`lib/bin/cua-engine/cua-engine.exe`) while the
macOS engine is a single file (`lib/bin/cua-engine`).

The tools reach a model as `cua_*`. Restart the application after installing.

### Known behaviour: tools are absent from pre-existing sessions

Tools are registered when the host boots. A session created before that boot and
restored afterwards does not see them; a new session does. Measured: one host,
one session that predated the boot could not call the tools while a session
created after it could.

This is a property of anything mounted at the profile or bundle layer, not of
this package. **When the tools appear to be missing, open a new session first** —
see [`docs/case-study-tool-visibility.md`](docs/case-study-tool-visibility.md)
for the full diagnosis, including the four wrong conclusions reached before it.

### Manual wiring, without the plugin manager

**First establish which profile to install into.** Every directory under
`~/.dsh/profiles/` is a profile and the desktop application boots exactly one of
them. A plugin installed into another one loads perfectly, registers all twelve
tools and is never reached — and because the failure is "the tools do not exist",
it looks exactly like a plugin that failed to load. Read the answer off the
running host process rather than guessing:

- Windows: `Get-NetTCPConnection -LocalPort 19387 -State Listen |
  Select-Object -ExpandProperty OwningProcess` for the pid, then
  `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" |
  Select-Object -ExpandProperty CommandLine` — the profile directory is the
  argument after the packaged dsh directory on the `dsh-desktop-host` command
  line (that process's `process.argv[3]`). Measured on the machine this
  repository was last built on: `C:\Users\howar\.dsh\profiles\desktop`.
- macOS: `lsof -p <host pid> | grep profiles`.

`dsh --profile desktop …` is refused on both platforms (`profile "desktop" is
managed exclusively by the Electron application`), so this answer can only come
from the process, never from the CLI.

Then install the package into that profile yourself:

1. Put it in the profile's dependencies
   (`~/.dsh/profiles/<profile>/package.json`):

   ```json
   { "dependencies": { "@deepseek-ai/dsh-plugin-cua": "link:/path/to/cua/packages/dsh-plugin-cua" } }
   ```

   Then run `dsh plugin --profile <profile> add <package path>` — the same pnpm
   forwarder the plugin manager uses, run in the profile directory. When the
   profile is the application's own (`desktop`, which the CLI refuses), make the
   link yourself instead: `node_modules/@deepseek-ai/dsh-plugin-cua` pointing at
   the package directory, matching how that profile links everything else. The
   application only removes links aimed at its own older projection directory
   (`.dsh-module-fallback`) on startup, so a hand-made link survives.

2. Append to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: cua
         name: '@deepseek-ai/dsh-plugin-cua'
         config:
           writeApproval: always       # always | session | never
           idleShutdownMs: 600000
           allowedScript: false        # Windows: may cua_app's script run PowerShell
           # screenshotDir: /absolute/path/to/cua-screenshots
   ```

   Nothing here needs a path into the package. The row names it, and the plugin
   finds the engine inside it — `lib/bin/cua-engine/cua-engine.exe` on Windows,
   `lib/bin/cua-engine` on macOS. Set `enginePath` only to point somewhere else,
   such as a build straight out of the source tree.

3. Restart the harness and open a new session. The row is applied at boot, and on
   macOS the engine path and the system grants are fixed then too; Windows has no
   grants to fix, but the boot is what registers the tools.

`writeApproval` gates writes on top of whatever the operating system already
enforces: `always` asks before every write, `session` asks once per write tool per
session, and `never` leaves the OS as the only gate. In a session whose approval
policy is `never` — a refused approval blocks the action outright — `never` is the
only usable value, because a plugin-level gate would refuse every write rather
than gate it.

#### Exposing the catalog over MCP instead

The engine also speaks the Model Context Protocol on stdio, so the harness's own
MCP client can expose the same twelve tools as `mcp__cua__<name>`:

```yaml
- insert:
    - id: mcp-cua
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: cua
        transport: stdio
        command: /absolute/path/to/cua/packages/dsh-plugin-cua/lib/bin/cua-engine
        args: [--mcp]
        toolCallTimeoutMs: 120000
        failOnStartupError: false
        reconnect: { enabled: true }
```

This route does need an absolute path, and the path differs per platform: a
directory ending in `cua-engine.exe` on Windows, the single file `cua-engine` on
macOS. Use one row or the other, not both — together they put two identical
catalogs of twelve tools in front of the model.

The two differ in three ways, all in the plugin layer rather than in what the
tools can do: the native row names its tools `cua_*` instead of `mcp__cua__*`;
`writeApproval` applies **only** to the native row; and the `ctx.computerUse`
provider registration happens **only** on the native row. Both of the latter are
because a plugin's `apply()` runs only when the plugin is loaded, and
`dsh-mcp-client` is a sibling row rather than a loader for it.
## Permissions (macOS)

The state the engine reports comes from `AXIsProcessTrusted()` and
`CGPreflightScreenCaptureAccess()`, and `cua_status` tells you outright what is
missing and where to turn it on.

| Permission | Covers | Granted to |
|---|---|---|
| Accessibility | control trees, clicks, typing, element actions, window operations | the process hosting the engine (`DeepSeek Harness`, or the terminal application when launched from a terminal) |
| Screen Recording | screenshots | the same |
| Automation | `cua_app`'s `script` (an Apple event) | per controlled application, prompted on first use |

Worth knowing:

- Grants attach to the **responsible process**. The engine is a child of the
  harness and inherits the host application's grants, so the application to tick
  in System Settings is the host, not `cua-engine`.
- After a grant changes, the host application must be **quit and restarted**
  before it takes effect.
- An ungranted permission is never a silent empty result: `window.list` /
  `tree.dump` report `permission_denied` explicitly (otherwise AX hands back
  empty attribute sets, which look like "there are no windows on this machine").
- `cua_app`'s `script` runs on its own queue under a hard timeout. The first call
  may raise the Automation dialog; if nobody answers it, the engine does not pile
  later requests up behind that thread — it returns "a script is still running".

## Permissions (Windows)

**There is nothing to grant.** Windows opens UI Automation, screen capture, and
synthesized input to every process: no accessibility switch, no Screen Recording
prompt, and no settings pane for `cua_status` to send a user to. It reports
exactly that — `accessibility` and `screenRecording` are constantly `true` while
the session is unlocked.

The one real limit is **elevation**, and getting it right took measuring. The
intuitive model — "Windows refuses and tells you" — is wrong on both halves.
`cua_status` carries `elevated` as its own field on this backend, so the model can
tell which side of the integrity boundary the engine is on *before* a window turns
out to be out of reach. It is deliberately absent on macOS, where no such boundary
exists between two processes of the same user: a `false` invented there would read
as a measurement. Measured against an administrator-elevated Notepad, from an
unelevated engine:

| Operation | Result |
|---|---|
| `cua_screenshot` / `cua_windows` / `cua_app activate` | ✅ fine — none of them are integrity-gated |
| `cua_tree` | ⚠️ the window shell only; Windows withholds the children (the result carries a `note` saying so) |
| `cua_type` / `cua_click` / `route:pid` | ❌ **discarded, with no error at all** |

That last row is the important one: **`SendInput` returns the number of events it
*queued*, not the number that reached a window**. UIPI discards them further down
and reports it nowhere (stderr was empty for the whole experiment), so "send, then
check the return value" cannot work — and it made the two most-used write tools
claim success while doing nothing.

The engine therefore **asks before sending, because it cannot ask afterwards**:

- **Pointer** — the window under the point, for `click`/`down`/`up`/`drag`/`scroll`.
  A bare `move` is not checked: moving the cursor over an elevated window is allowed.
- **Keyboard** — the **foreground** window. This is the easy thing to get wrong:
  Windows has no per-process key delivery, so keystrokes follow the focus wherever
  it is, and checking only which process the *element* belongs to is not enough.
  After `SetFocus` the engine also verifies where the focus actually landed, and
  refuses when it did not move — otherwise the text goes into a different
  application while the result claims it was delivered.
- **`cua_tree`** — a tree that is nothing but its root carries a `note` explaining
  why, so it does not read as "this application has no UI".

One consequence is worth knowing: **while an elevated window holds the foreground,
typing is refused everywhere** — an unelevated engine cannot take the foreground
back, so every keystroke would be discarded. The engine reports that honestly on
each call, but the practical remedy is a human click.

Three ways out: run the harness elevated (which hands the model administrator
rights — a real trade-off); use **UIAccess**, the mechanism Windows provides for
exactly this, where a signed, `%ProgramFiles%`-installed binary with
`uiAccess="true"` drives elevated windows *without* being elevated, at the cost of
code signing; or stay with the windows the engine is allowed to reach.

### The boundary is not symmetric, and it cost someone a window

Refusing input across the integrity boundary is only half the guard. **UIPI
restricts window messages and injected input; it places no restriction on process
access at all.** Process access is governed by the object's DACL, and a process
owned by the same user passes its own DACL whatever its integrity level. Measured
on the development machine:

```
pid=21664  TrafficMonitor        elevated, PROCESS_TERMINATE GRANTED
pid=20872  ArmourySocketServer   elevated, PROCESS_TERMINATE GRANTED
```

A keystroke aimed at an elevated window is discarded, while `TerminateProcess`
against one **succeeds**. The engine refused the first and happily did the second,
and that asymmetry destroyed a window: a smoke test that meant to close the
Notepad it had launched ran `cua_app quit app=notepad force=true`, the name match
landed on an administrator-elevated Notepad the user had open for this
investigation, and the kill went through.

Both causes are fixed.

**The scope of a lifecycle action was every process sharing an executable image.**
That rule existed so `quit` would end a whole application rather than one of its
processes — Notepad runs a helper, a browser a broker plus a renderer per tab —
but "shares an image" also matches a second copy the user launched independently,
and no caller can see that coming. The scope is now one *instance*: the named
process plus the processes connected to it by parent/child links that share its
executable. Notepad's helper is its **parent** and a browser's renderers are its
**children**, so the walk goes both ways — and it stops at the image boundary,
which is what keeps a separate launch out.

**Lifecycle actions had no integrity guard.** They do now, and it fails closed: if
any process the call would touch runs at a higher integrity level than the engine,
`quit`, `hide`, and `unhide` refuse with a reason. Terminating a process the user
deliberately elevated is a privilege escalation performed on the model's behalf,
and it is not recoverable.

The guard is *not* a claim that the operation would fail. It would succeed, which
is exactly why it has to be refused.

Two further measured findings are worth writing down:

- **`WTSSessionInfoEx`'s `SessionFlags` is unusable.** Its documented
  `0 = locked / 1 = unlocked` does not hold for an ordinary interactive process —
  on an unlocked machine it returns 0 just the same. Lock detection therefore
  uses `OpenInputDesktop`, with retries: the two error directions are not
  symmetric, and a false "unlocked" only makes one screenshot look odd, while a
  false "locked" sets `ready` to false and stops every capture.
- **Read a window title with `GetWindowText`**, not with a `WM_GETTEXT` round
  trip. For a top-level window owned by another process it returns the window
  manager's cached title without sending a message at all, so it is both faster
  and immune to the target process hanging.

## Write authorization

The plugin draws one line: **reads are free, writes go through the gate**.

- **Reads** (`cua_status` / `cua_apps` / `cua_windows` / `cua_tree` /
  `cua_screenshot`, plus `cua_element action:list`) ask nothing extra — they only
  observe the machine, and the operating system already gates them itself.
- **Writes** (`cua_click` / `cua_type` / `cua_key` / `cua_element`'s mutating
  actions / `cua_app`) go through `ctx.approval` first and fail closed.

`writeApproval` has three settings:

| Setting | Behaviour | Use when |
|---|---|---|
| `always` | ask before every write | the default choice when the session can prompt |
| `session` | ask once per write tool per session, then reuse the grant | fewer interruptions |
| `never` | do not ask; the operating system's grants are the only gate | the **only usable** setting when the session's approval policy is `never` (nobody to answer), since a refused approval would fail every write |

### `script` is off by default on Windows

macOS's `cua_app action=script` sends an Apple event, and the system scopes the
Automation grant **to one named target application**. The Windows equivalent is
a PowerShell snippet, which is scoped to nothing — it can do anything the user
can do. It is therefore controlled by the `allowedScript` config key, `false` by
default; once enabled, the plugin passes `--allow-script` to the engine. While it
is off, a result explains how to turn it on instead of failing silently.

## Engine CLI

The engine is usable without the plugin, which is how it gets debugged:

```sh
ENGINE=lib/bin/cua-engine              # Windows: lib/bin/cua-engine/cua-engine.exe
$ENGINE --probe                                            # print one status and exit
$ENGINE --call tree.dump --params '{"app":"Finder"}'       # a single call
$ENGINE --version
$ENGINE --help

# Stateful: within one process, read a tree and then click it by index.
printf '%s\n' \
  '{"id":1,"method":"tree.dump","params":{"app":"Finder","maxDepth":4}}' \
  '{"id":2,"method":"element.action","params":{"element":5,"action":"list"}}' \
  | $ENGINE
```

## Protocol reference

Methods: `engine.status`, `engine.permissions`, `engine.request_permissions`,
`app.list`, `window.list`, `display.list`, `tree.dump`, `capture.screenshot`,
`pointer`, `keyboard`, `element.action`, `app`.

Error codes: `invalid_request`, `unknown_method`, `not_found`,
`permission_denied`, `operation_failed`, `unsupported_platform`. The plugin
branches on `EngineError.code`, and `permission_denied` carries repair guidance.

Design rules:

- A mistyped `params` value is always an error, never a silent downgrade. A
  coordinate passed as a string is rejected rather than degrading to "click the
  element's centre", which would click the wrong thing.
- An unknown parameter name is an error too, listing what this call does accept.
  Misspell `maxDepth` as `maxdepth` and you should get one error, not a default
  tree with the budget quietly ignored.
- A point must lie on some display, or the call errors and gives the actual
  desktop bounds.
- One concept, one field. A capture region once existed as two equivalent fields
  in the request shape (`region` and `sourceRect`); a caller filling in only one
  of them got a `region` of `[0,0,0,0]` every time. Only `region` remains.
- A call that addresses by index fails explicitly when the snapshot is gone or
  the index is out of range, saying to re-run `cua_tree`; a stale index is never
  applied to whatever now occupies it.
- A documented field is always present in a result (`null` when it has no value),
  so a caller never needs an `in` check.

## Testing

```sh
cd packages/dsh-plugin-cua
pnpm run check          # types + schemas + smoke (no visible side effects)
pnpm run smoke:writes   # additionally does real pointer moves, key presses, and a background read/write
```

On macOS, `smoke:writes` really launches TextEdit, yields the foreground to
another application, writes and reads back **in the background**, and asserts
that the frontmost application was not stolen. On Windows it launches Notepad,
writes and reads back with `cua_element` and with `cua_type` separately, then
closes it and restores the previous foreground window; the background-typing
assertion is macOS-only and Windows prints an explicit note saying why — Windows
has no way to post keystrokes to a process.

## Known limitations

- **Only the macOS and Windows backends exist.** Other platforms load the plugin,
  but every engine call returns `unsupported_platform`.
- **A region spanning displays goes to a single display, by overlap.** Such a
  region is not stitched into one image: it is captured from the display with the
  largest overlap, and the part beyond that display is blank or black. Capture
  the two displays separately when you need the whole span.
- **Unavailable while the screen is locked.** On macOS ScreenCaptureKit fails
  with `-3811` and the frontmost application becomes `loginwindow`; on Windows
  the session switches to the lock desktop. Both backends report
  `the screen is locked` explicitly, and `cua_status` marks `sessionLocked` true
  and `ready` false, rather than handing the underlying error to the model.
- **The control tree is always truncated by a budget.** Browser and Electron
  trees reach tens of thousands of nodes, so the defaults are 1200 nodes, depth
  8, and an 8s time budget. `truncatedBy` in the result says which budget fired;
  narrow the query from there instead of assuming you saw everything.
- **`cua_type` uses synthesized events**, and some applications drop input that
  arrives too fast; use `perCharacterDelayMs` to slow it down when needed.
  Without an `element` it does not reach a background application (see the table
  above).
- **A `route: "pid"` synthetic click** may or may not reach a background window
  depending on the application, and carries no guarantee; use `cua_element` when
  a background operation has to be reliable.
- **Window titles need Screen Recording**, a macOS constraint rather than an
  implementation choice.
- **Element indices from `element.action` are valid only within one engine
  session.** The engine exits after 10 minutes idle; afterwards the indices are
  stale and the tree must be read again.
- **Rapid consecutive captures fail intermittently.** ScreenCaptureKit reports
  `-3811` on and off under fast repeated capture, and the engine retries those a
  limited number of times (3, with increasing backoff) before reporting them.
- **On macOS, screen capture works only inside the host's process tree.** The
  Screen Recording grant is attributed to the process responsible for the engine,
  so an engine started from a terminal has no capture attribution — and its first
  ScreenCaptureKit call does not fail, it stops answering. A watchdog stops the
  engine after 12 s rather than letting it hang, and the MCP client reconnects
  onto a fresh one; a hung engine otherwise blocks capture for every process on
  the machine. Trees, windows, and application lists are unaffected, which is why
  the CLI above remains the way to debug those. Windows has no such attribution
  and captures from anywhere.
- **Scrolling on Windows is quantised.** The tools describe `dx`/`dy` in pixels
  while the Windows wheel moves in 120-pixel detents; the engine executes the
  nearest whole number of detents and **reports the delta actually applied**,
  rather than telling the model a scroll happened that did not.
- **Windows tree role names are UI Automation control types** (`Button`, `Edit`),
  not AX role names. The `roles` filter accepts both, but what appears in a
  result is the platform's own vocabulary.
- **`cua_apps`' installed list on Windows comes from Start menu shortcuts plus
  the uninstall registry.** Packaged applications covered by neither (some Store
  apps) appear under `running=true` only once they are running; they can still be
  launched by Application User Model ID.
- **An elevated window is out of reach on Windows, and the failure is silent.**
  `cua_screenshot` / `cua_windows` / `activate` work, but the control tree yields
  only the shell and input is discarded by UIPI. The engine now checks the
  integrity level before sending, so it refuses outright instead of claiming
  success — see the table above and
  [docs/windows-backend.md](packages/dsh-plugin-cua/docs/windows-backend.md).
- **While an elevated window holds the foreground, typing is refused entirely.**
  Keystrokes follow the foreground window and an unelevated engine cannot take the
  foreground back, so this is not a state code can work around — it needs a human
  click, or a harness running elevated.
- **`quit` / `hide` / `unhide` refuse to act on an elevated process** when the
  engine is unelevated, even though the system would allow it. UIPI does not cover
  process access, so terminating an elevated process **succeeds**; the engine
  declines because that is a privilege escalation on the caller's behalf and a
  closed window is not recoverable. For the same reason `quit` targets one
  *instance* — the named process plus the same-image parent/child chain — not
  every process sharing an image, which would catch a second copy the user
  launched independently.
- **A `cua_app` name or `bundleId` that matches several running instances is
  refused rather than guessed at.** Every `cua_app` action changes state, and
  "whichever has the lower pid" is a decision the caller neither made nor can see
  — `quit` least of all, since it is unrecoverable. The refusal lists the
  candidate pids and window titles, and `pid` names one. Note that a single
  instance of a multi-process application is **not** ambiguous: Notepad is two
  processes and a browser dozens, so the question is asked of instances rather
  than of processes.
- **The engine is unsigned, and endpoint protection will notice it.** A tool that
  synthesizes input, captures the screen, and reads other processes' UI trees is
  behaviourally a remote-access trojan, and no code change removes that. The build
  side has removed the largest incidental signal (it no longer self-extracts into
  `%TEMP%`) and now fills in a real file identity; the actual fix is code signing
  — see
  [docs/windows-backend.md](packages/dsh-plugin-cua/docs/windows-backend.md#antivirus-smartscreen-and-being-mistaken-for-malware).
- **`includeBackground: true` returns several dozen system helper processes**
  (NVContainer, Runtime Broker, input-method components, …). The default listing
  is unaffected. This is the price of making `hide` reversible: the application
  lookup has to include processes with hidden windows, or an application that was
  hidden can never be found again.
- **`cua_apps` groups by executable image, one row per application rather than per
  process.** A browser, an Electron app, and Notepad are all several processes; an
  ungrouped listing shows the same application repeatedly (measured on a real
  desktop: 59 rows for 51 distinct applications). The grouping key is the same one
  `cua_app` uses to decide what "one application" means for `hide` and `quit`, so
  the listing and the lifecycle actions agree. A process whose image cannot be read
  — `dwm`, SYSTEM-level services, unreadable from an unelevated engine — stands
  alone with a blank `bundleId` rather than being guessed at.