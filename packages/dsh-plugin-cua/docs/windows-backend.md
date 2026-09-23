# The Windows backend

The engine's second platform. It speaks the [same protocol](engine-contract.md)
as the macOS backend — same methods, same response fields, same error codes — so
the plugin and its tool surface are unchanged. What follows is what is *different*
about Windows, why each difference exists, and where a port had to choose.

```
packages/dsh-plugin-cua/
├── native/cua-engine/        # macOS: Swift, SwiftPM
├── native/cua-engine-win/    # Windows: C#, .NET 9
│   ├── CuaEngine.csproj
│   ├── app.manifest          # per-monitor DPI awareness
│   └── src/
│       ├── Program.cs        # STA entry point, stdio loop, CLI
│       ├── Protocol.cs       # request/response envelope, error vocabulary
│       ├── McpServer.cs      # the second envelope: MCP over the same dispatch
│       ├── Params.cs         # strict typed parameter access
│       ├── PlatformHost.cs   # the backend interface + dispatch
│       ├── Json.cs
│       └── Win/
│           ├── Native.cs         # Win32 / DWM / GDI / shell interop
│           ├── Native.Input.cs   # SendInput, PostMessage, cursor read-back
│           ├── Discovery.cs      # displays, windows, processes
│           ├── Keymap.cs         # key names → virtual keys
│           ├── WinHost.cs        # permissions, displays, apps, windows
│           ├── WinHost.Tree.cs   # UIA traversal, outline, element snapshot
│           ├── WinHost.Capture.cs
│           ├── WinHost.Input.cs
│           ├── WinHost.Element.cs
│           └── WinHost.App.cs
└── scripts/build-engine.mjs  # picks the toolchain from `process.platform`
```

## Why C#

The three capabilities a computer-use engine needs on Windows — UI Automation,
synthetic input, and screen capture — are all reachable from any language through
Win32 and COM. C# was chosen because it is the only option that reaches all three
**without a dependency the build has to fetch**: `System.Windows.Automation` is
the managed UI Automation client, `SendInput` and the GDI capture path are
plain P/Invoke, and `System.Windows.Media.Imaging` (pulled in by `UseWPF`) ships
the PNG and JPEG encoders plus a resampler. `System.Drawing.Common` is *not* part
of the shared framework, which is why the imaging stack is WPF's and why the
project sets `UseWPF` for a program that has no UI at all.

The one thing that costs is size: the engine publishes as a single
self-contained executable, which is about 120 MB against the macOS binary's 2 MB.
`CUA_ENGINE_WIN_FRAMEWORK_DEPENDENT=1` produces a 0.3 MB build instead for a
machine that already has the .NET 9 desktop runtime.

## Process shape

The engine runs on a single **STA** thread (`[STAThread]` on `Main`). This is not
incidental: the managed UI Automation client is a COM apartment object, and every
call into it — including every COM automation an application action performs on
the engine's behalf — has to happen on the apartment that created it. Requests
are answered in order, which is what keeps a click from overtaking the tree read
that produced its target.

`app.manifest` declares **per-monitor DPI awareness v2**, and that is
load-bearing rather than cosmetic. Everything the engine exchanges is a physical
pixel: UI Automation reports bounding rectangles in physical pixels, `SendInput`
takes physical pixels, and `GetMonitorInfo` returns physical pixels — but only
for a process that has told the window manager it understands per-monitor
scaling. Without it, a 150 %-scaled laptop panel silently makes every coordinate
wrong by a factor of 1.5.

## Coordinates

There is exactly one space: **physical pixels, origin at the top-left of the
primary display**, with a display to its left or above at negative x or y. That
is the same convention the macOS backend uses for screen points, so the
arithmetic the model performs is identical on both platforms.

The practical difference is that Windows never introduces a scale factor of its
own. macOS has to calibrate pixels-per-point per display because `SCDisplay` and
`captureImage(in:)` disagree about density; on Windows a point *is* a pixel, so
`scale` is `1` unless the caller's `maxWidth`/`maxHeight` explicitly downscaled
the image — and then it is measured from the delivered image, exactly as the
contract requires.

A point that is not on any display is **rejected with the desktop bounds** rather
than clamped. Windows would otherwise happily deliver the event at the nearest
screen edge, turning one arithmetic mistake into a click on something the caller
never named.

## Vocabulary: UI Automation control types, not AX roles

macOS reports `AXButton`; Windows reports `Button`. The tree emits UI Automation
control type names, and the `roles` filter **accepts either vocabulary** — a
leading `AX` is stripped and the common AX names are mapped onto their UI
Automation counterparts (`AXTextField` → `Edit`, `AXStaticText` → `Text`,
`AXLink` → `Hyperlink`, and so on), so a model that has learned the macOS names
still gets a working filter on Windows.

Emitting the platform's own names is deliberate. The alternative — mapping UIA
control types back onto AX role names for cosmetic consistency — would make the
outline claim a vocabulary the platform does not have, and the first UIA control
type with no AX counterpart would expose the fiction.

The same reasoning applies to `element.action` results: where macOS reports
`AXPress`, Windows reports the pattern that actually ran (`Invoke`, `Toggle`,
`Select`, `Expand`, or `DoDefaultAction`), which tells the caller more than a
translated name would.

## The tree

The traversal reproduces the macOS algorithm: breadth-first with a per-sibling
priority, layout wrappers folded without consuming a depth level, three
independent budgets (`nodeLimit`, a fixed 40 000-element visit cap, and
`timeBudgetMs`), indices assigned at emission time, and the same byte-level
outline grammar including the `—` separator and the `⏎` newline substitution.

Four things are Windows-specific:

**The root is never folded and never filtered out.** On macOS an application
element always carries an `AXTitle` and survives on its own. A Windows top-level
window can have no accessible name at all — the desktop's `Progman` is one — and
Chromium reports the *browser window itself* as a `Pane`, which the structural
folder would otherwise swallow, leaving an outline with no visible root and no
way to tell what was dumped.

**Properties are read through a cache request.** A UI Automation property read is
a cross-process call; reading a dozen properties per node individually makes a
browser window take minutes. The cache request turns each level of the walk into
a single round trip — a 430-node Chromium window dumps in about 150 ms. Note that
patterns have to be added to the request *as patterns*: `GetCachedPattern` only
succeeds for a pattern the request asked for, and adding only a pattern's
properties silently loses every value and selection state in the dump.

**`actionable` also consults pattern availability.** Control type alone is not
enough — list rows, custom widgets, and provider-authored elements expose an
action while reporting a generic type — so an element is actionable when its
control type is interactive *or* it exposes Invoke, Toggle, SelectionItem, or
ExpandCollapse. `ScrollItem` is deliberately excluded: bringing an element into
view is something done *to* it, not by it, and every text node in a browser
exposes it, which would mark a whole page actionable.

**Text is read from whichever pattern exposes it.** macOS has one place to look
(`AXValue`). UI Automation splits it: an edit field publishes `ValuePattern`,
while a document control — which is what a WinForms text box, a rich edit, and a
browser's content area all report — publishes `TextPattern` instead. Reading only
the first would leave the model unable to verify that the text it just typed
arrived, which the tool's own guidance tells it to do.

### Element indices

Indices are 0-based and address the same nodes the outline numbers, with one
deviation: **index 0 is addressable on Windows**, because the root is a real
window rather than a macOS application element that cannot be acted on. Indices
remain per-process and are replaced wholesale by the next dump of that process;
a stale index fails with a message naming `cua_tree` as the remedy rather than
falling back to a remembered element.

## Capture

Two paths, because neither covers everything:

- A **window** is captured with `PrintWindow` and `PW_RENDERFULLCONTENT`, which
  asks the window to draw itself and therefore works even when another window
  covers it — the property the tools promise. When the window declines (some
  GPU-composited and hardware-protected surfaces return nothing), the engine
  detects the blank result and falls back to the screen path rather than
  returning a black rectangle.
- Everything else is a straight `BitBlt` from the screen, which is exact and fast
  but can only see what is actually displayed.

`showCursor` composites the cursor into the same device context that already
holds the pixels, offset by the icon's hotspot, so the arrow tip lands on the
point rather than the bitmap's corner.

## Input

**Pointer.** `SendInput` is the equivalent of the macOS window-server route and
moves the visible cursor. An absolute move maps the desktop onto 0…65535, which
rounds; the engine **reads the cursor back** and corrects with `SetCursorPos`, and
reports where the pointer actually landed rather than where it was aimed. When a
process has captured the mouse neither works, and the result says the pointer did
not arrive.

`route: "pid"` is genuinely different rather than a re-labeling of the same
mechanism. Windows has no `CGEventPostToPid`, so this route **posts window
messages** (`WM_LBUTTONDOWN` and friends, in client coordinates) straight to the
background window. That leaves the cursor alone and works on classic Win32
controls — verified against a `RichEditD2DPT` text box, where a posted click
placed the caret at exactly the same column as a synthesized one; applications
that read the real cursor position — Chromium, UWP, most canvas UIs — ignore it,
and the result says so.

`action: "down"` and `"up"` send **only their own half** — press and hold, then
release. They used to fall through to the click branch and each send a complete
press-and-release pair, which turned a hand-composed drag into two clicks: a
`down` at one point followed by an `up` at another left the caret where the second
click landed and selected nothing. Verified afterwards by reading the button state
back: pressed after `down`, released after `up`, released after `click`.

Composing a drag out of separate `down` / `move` / `up` calls does work, but it
undershoots — an 80-pixel travel selected 4 characters where the atomic `drag`
selected 10, because consecutive `move` requests are coalesced. That is what
`action: "drag"` is for.

Scrolling is quantised: the tools describe `dx`/`dy` in pixels, and the Windows
wheel works in 120-pixel detents. The engine applies the nearest whole detent and
**reports the delta it actually applied**, so the model is never told a scroll
happened that did not.

**Keyboard.** `SendInput` is the only path — there is no per-process key
delivery on Windows. Text is delivered as `KEYEVENTF_UNICODE` payloads, one
event pair per UTF-16 code unit, which is layout-independent and handles CJK,
emoji (as surrogate pairs), and combining marks; this was verified byte-exact
against a WinForms text box across Latin, CJK, Greek, Hebrew, and an astral
emoji.

The consequences are stated rather than hidden:

| Behaviour | macOS | Windows |
|---|---|---|
| `cua_element` `setValue` on a background window | works | **works** (`ValuePattern`) |
| `cua_type` with `element` on a background window | works | **focuses the window first**, then types |
| `cua_type` without `element` | frontmost only | frontmost only |
| `route: "pid"` for keyboard | delivers to a process | not available; the result reports the route actually used |

The key vocabulary is the macOS names plus the Windows ones — `return`/`enter`,
`delete`/`backspace`, `escape`/`esc`, `win`/`cmd`, `option`/`alt` — and a chord
may be written either as `key: "ctrl+a"` or as `key: "a"` with
`modifiers: ["ctrl"]`. `fn` is refused with a reason instead of being dropped: a
chord that silently loses a modifier does something other than what was asked.

## Applications

macOS has a bundle identifier. Windows has two things that play that role, and
`bundleId` reports whichever applies: the **Application User Model ID** for a
packaged or AppUserModel-registered app, and the **executable path** for a classic
Win32 binary. Either is a valid target for `cua_app launch` and for the `app`
parameter of the other tools.

`cua_apps running=true` enumerates the processes that own a window that is
actually on screen — the broad set, not the Alt-Tab set, so the shell is included
and the desktop stays targetable. `running=false` indexes the **Start menu** (a
shortcut is itself a perfectly good `ShellExecute` target, so `path` is the `.lnk`
file) plus the uninstall registry keys for applications that never put a shortcut
there. Packaged Store apps with neither are still launchable by their Application
User Model ID.

`cua_windows` reports the Alt-Tab set: what a user would call a window. A list
that also carried the taskbar, the desktop, every tray icon host, and the ~500
invisible message-only windows a real desktop has would be unreadable. Shell
infrastructure stays reachable through `cua_tree` and `cua_screenshot`, which
address a process rather than a window list.

Behind `window.list` sit two wider enumerations, and the difference between them
matters:

- **Application windows** are the visible top-level windows *plus* hidden ones
  that are titled and not tool windows. This is what answers "is this application
  running" and "where is its window". Deriving the application list from visible
  windows alone makes `hide` **irreversible** — the application disappears from
  `cua_apps` and can never be found again in order to be shown, which is exactly
  what happened the first time it was tested. The extra rows are all reported as
  `hidden`, so they stay out of the default `cua_apps` listing and appear only
  when a caller asks for background applications or names one directly.
- **Processes by image** back the lifecycle actions. A Windows application is
  frequently several processes — Notepad ships a separate helper, a browser ships
  one per tab plus a broker, an Electron app ships a renderer per window — and
  the process that has to end for the application to be gone is usually the one
  with no window at all. So `quit`, `hide`, and `unhide` act on every process
  sharing the resolved application's executable image, not just on the one that
  happened to own the matched window.

`activate` deliberately does *not* widen: raising the main window is the request,
and raising every window of a multi-window application would be a different one.

### An ambiguous name is refused, not guessed

A name or id query is a substring match against every running application, and a
machine can have two independent instances of one program. Resolving that to the
first match means acting on whichever happens to have the lower pid — not a
decision the caller made, and not one they can see. Every action this resolver
serves changes state, and the sharpest of them is not recoverable, so the engine
refuses and names the candidates:

```json
{"error":{"code":"invalid_request","message":"\"notepad\" matches 2 running applications:
 pid 21948 (\"notes.txt - Notepad\"), pid 43436 (\"Untitled - Notepad\"). This action
 changes state, so choosing between them is not something to guess at; the call was
 refused instead. Repeat it with `pid` to name the one you meant."}}
```

`pid` is tried before any query, so the escape hatch always exists. Note what is
*not* ambiguous: a single instance of a multi-process application. Notepad
contributes two processes and a browser dozens, so the question is asked of
instances, not of processes.

Getting that distinction right took two attempts, and the first was wrong in a way
worth recording. Counting **connected components** over the union of the
candidates' images lets a process of one program bridge two instances of another:
launching two copies of a program from the same shell makes both children of that
shell, so a shared parent joins them into one component and the ambiguity silently
disappears — measured, with a `quit app=powershell` that matched two form windows
*plus the shell itself*, reported one instance, and closed the shell it had
matched. An instance cannot span two executables, so components are now computed
**per image**, and `pwsh.exe` can no longer be the bridge between two
`powershell.exe` instances.

### `cua_apps` reports applications, not processes

The same fact that makes the lifecycle actions widen — one application is many
processes — makes a per-process listing wrong. Before grouping, a real desktop
produced four identical `Windows Subsystem for Linux` rows, three `nvcontainer`,
two `Slack`, two `Runtime Broker`, and two `ASUS NodeJS Web Framework`: 59 rows
for 51 distinct applications. Every duplicate names the same thing, so a model can
neither tell them apart nor pick between them.

The listing therefore groups by **executable image path**, which is the same
identity `cua_app` uses to decide the scope of `hide` and `quit` — so the listing
and the lifecycle actions agree about what one application is. macOS reaches the
same place by de-duplicating on bundle id.

The surviving row keeps a pid a caller can actually use: the process that owns the
foreground window, else one with a window on screen, else a windowless one. Where
processes of one image are registered under different Application User Model IDs —
Windows hosts several unrelated things in `RuntimeBroker.exe` — the row reports one
of the ids rather than a path, because an id is what `launch` takes.

Two details are deliberate:

- **A process whose image cannot be read stands alone** rather than being merged
  with something it merely resembles. `dwm`, `NVDisplay.Container`, and the
  SYSTEM-level `nvcontainer` are not readable from an unelevated engine — Windows
  access control, not a bug — and they surface as extra rows with a blank
  `bundleId`. Guessing would fuse two unrelated applications into one row, which is
  worse than an extra line.
- **`RunningApps` stays per-process.** `tree.dump pid=…` and the `pid` parameter of
  every other tool still address a specific process even when its application is
  shown as one row, so grouping the listing costs no reach.

`launch` resolves four shapes: an existing path, an explicit `shell:` target, a
bare executable name (which `ShellExecute` resolves through `PATH` and the
`App Paths` key), and anything else as an Application User Model ID under
`shell:AppsFolder`. The launched process is then discovered by polling, because
the shell returns as soon as it has handed the request on.

### `script` is opt-in

On macOS `cua_app action=script` sends an Apple event, which the automation
permission scopes to one named target application. The Windows equivalent is a
PowerShell snippet, and it is **not** scoped to anything — it can do whatever the
user can. It is therefore disabled unless the plugin is configured with
`allowedScript: true`, at which point `--allow-script` is passed to the engine.
When disabled the result explains how to enable it rather than failing silently.

## Permissions

Windows grants UI Automation, screen capture, and input synthesis to every
process: there is no Accessibility switch, no Screen Recording prompt, and
nothing for `cua_status` to ask the user to turn on. The report says exactly that,
and `accessibility`/`screenRecording` are `true` whenever the session is
unlocked.

The one real limit is **elevation**, and it took measuring to get right. The
intuitive model — "Windows refuses and tells you" — is wrong on both halves.

### What an elevated window actually does, measured

Against an administrator-elevated Notepad, from an unelevated engine, on the
development machine:

| Operation | Engine reported (before the fix) | What actually happened |
|---|---|---|
| `cua_windows`, `cua_screenshot` | correct | ✅ both work — GDI capture and window enumeration are not integrity-gated |
| `cua_app activate` | `activated: true` | ✅ works — `SetForegroundWindow` is not integrity-gated |
| `cua_tree` | 1 node, no explanation | ⚠️ the window shell only; the children are withheld |
| `cua_type` (`SendInput`) | **`delivered: true`, `characters: 18`** | ❌ **discarded** — the document stayed at `0 characters` |
| `cua_click` (`SendInput`) | **`delivered: true`** | ❌ **discarded** — the click never arrived |
| `cua_click` `route: pid` (`PostMessage`) | **`delivered: true`** | ❌ **discarded** — UIPI blocks posted messages too |

**There is no error to detect.** `SendInput` returns the number of events it
*queued*, not the number that reached a window; the discard happens further down
and is reported nowhere. A `stderr` log across the whole experiment was empty.
So the previous design — send, then check the return value — could not have
worked, and it made the two most-used write tools claim success while doing
nothing at all.

### The rule the engine follows instead

**Ask before sending, because you cannot ask afterwards.** Every path that
delivers an event now checks the integrity of the window that will receive it
first and refuses with a reason rather than pretending:

- **Pointer** — the window under the point (`WindowFromPoint`), for `click`,
  `down`, `up`, `drag`, and `scroll`. A bare `move` is *not* gated: moving the
  cursor over an elevated window works, so it is left alone.
- **Mouse in `route: pid`** — the window the messages are posted to.
- **Keyboard** — the **foreground** window, and this is the subtle part: there is
  no per-process key delivery on Windows, so keystrokes follow the focus wherever
  it is, not the element that was named. Checking the *element's* process is
  therefore not enough, and the first version of this fix had exactly that hole —
  it let the typing through and the text went into a different application.

That hole is closed by **verifying where focus actually went**. After `SetFocus`,
the engine compares the foreground process with the element's; if they differ, the
keystrokes would land somewhere else entirely, so the call fails with that
explanation instead of typing into the wrong window. This also catches the
ordinary case of a window that simply will not come forward:

> element #1 could not take the keyboard focus: its process is pid 10068, but pid
> 37772 still holds it. Windows refuses foreground changes from a process the user
> is not interacting with, and keystrokes follow the foreground window — so the
> text was not sent rather than delivered into another application. Activate the
> window first, or use cua_element with action=setValue, which writes through the
> accessibility API and needs no focus.

A tree that is nothing but its root now carries a `note` saying why, because a
bare root is otherwise indistinguishable from an application that has no UI.

### The consequence worth knowing

An elevated window in the foreground **blocks typing everywhere**, not just into
itself: an unelevated engine cannot take the foreground back (`AttachThreadInput`
to an elevated thread fails as well), so every keystroke would be discarded. The
engine says so on each call rather than failing silently, but the practical
remedy is a human click.

The three ways out are: run the harness elevated (which grants the model
administrator rights over everything, a real trade-off); use **UIAccess**, the
mechanism Windows provides for exactly this — a signed, `%ProgramFiles%`-installed
binary with `uiAccess="true"` can drive elevated windows *without* being elevated,
at the cost of code signing; or stay with windows the engine is allowed to reach.

### The boundary is not symmetric, and that cost someone a window

Refusing input across the integrity boundary is only half the guard. **UIPI
restricts window messages and injected input; it places no restriction on process
access at all.** Process access is governed by the object's DACL, and a process
owned by the same user passes its own DACL whatever its integrity level. Measured
on the development machine:

```
pid=21664  TrafficMonitor        elevated, PROCESS_TERMINATE GRANTED
pid=20872  ArmourySocketServer   elevated, PROCESS_TERMINATE GRANTED
```

So a keystroke aimed at an elevated window is discarded, while `TerminateProcess`
against one **succeeds**. The engine refused the first and happily did the second,
and that asymmetry destroyed a window: a smoke test that meant to close the
Notepad it had launched ran `cua_app quit app=notepad force=true`, the name match
landed on an administrator-elevated Notepad the user had open for this
investigation, and the kill went through.

Two things were wrong, and both are now fixed.

**The scope of a lifecycle action was every process sharing an executable image.**
That rule was written to make `quit` end a whole application rather than one of
its processes — Notepad runs a helper, a browser runs a broker and a renderer per
tab — but "shares an image" also matches a second copy the user launched
independently, and no caller can see that coming. The scope is now one
*instance*: the named process plus the processes connected to it by parent/child
links that share its executable. Notepad's helper is its **parent**, a browser's
renderers are its **children**, so the walk goes in both directions — and it stops
at the image boundary, which is what keeps a separate launch out of it. Verified:
with three `notepad.exe` processes present, two forming the windowed instance's
chain and one an unrelated launch, `quit` ended exactly the two and left the third.

**Lifecycle actions had no integrity guard.** They do now, and they fail closed:
if any process the call would act on runs at a higher integrity level than the
engine, `quit`, `hide`, and `unhide` refuse with a reason rather than proceeding.
Terminating a process the user deliberately elevated is a privilege escalation
performed on the model's behalf, and it is not recoverable — a closed window with
unsaved work is gone.

Note what this guard is *not*: it is not a claim that the operation would fail.
It would succeed, which is exactly why it needs refusing.

Two further findings are worth recording because both were measured, not assumed:

- **`WTSSessionInfoEx`'s `SessionFlags` is not usable.** Its documented
  `0 = locked / 1 = unlocked` contract does not hold for a normal interactive
  process, which sees `0` on an unlocked workstation. The lock check uses
  `OpenInputDesktop` instead, retried, because the two failure directions are not
  symmetric: a false "unlocked" makes one capture look odd, while a false
  "locked" reports the engine not-ready and stops every capture.
- **`GetWindowText` is the right way to read a title**, not a `WM_GETTEXT`
  round trip: for a top-level window owned by another process it returns the
  caption the window manager already holds and never sends a message, so it is
  both faster and immune to a hung target.

## Antivirus, SmartScreen, and being mistaken for malware

This is worth reading before filing a bug about the engine "being detected as a
virus". A tool whose entire job is to synthesize keyboard and mouse input, read
other processes' UI trees, enumerate windows, and capture the screen is
**behaviourally indistinguishable from a remote-access trojan**. Every endpoint
protection product is built to notice exactly this pattern, and no amount of code
quality changes that. What can be reduced is the *incidental* signal — the parts
that have nothing to do with what the engine does and everything to do with how
it was packaged.

### What actually happened here

Measured on the development machine, with Microsoft Defender:

```
ThreatName : Trojan:Win32/PowhidSubExec.B
Resources  : CmdLine:_…\DeepSeek Harness.exe … -- pwsh.exe -NoLogo -NoProfile
             -NonInteractive -Command … & .\lib\bin\cua-engine.exe --call app.list …
ActionSuccess : True
```

Three things are worth pulling out of that:

1. **The detection is on the command line, not on the binary.** The engine
   executable was never quarantined — `Get-MpThreat` reports the resource as
   `CmdLine:_…`, and an on-demand `Start-MpScan` over the 120 MB executable
   produced no detection at all.
2. **`PowhidSubExec` is a PowerShell heuristic**, not a file verdict. What it saw
   was PowerShell launching an unsigned, freshly built, unknown-reputation
   executable — and it killed the *PowerShell process*. That is why the symptom
   is an inexplicable `spawn EPERM` in the middle of a script rather than a
   missing file.
3. **The production path does not go through PowerShell.** The plugin spawns the
   engine directly (`node → cua-engine.exe`, see `EngineClient.ensureChild`), so
   this heuristic does not apply to normal use. The only PowerShell in the product
   is `cua_app` with `action=script`, which is off by default. The detections came
   from driving the engine by hand through a PowerShell tool call.

### What the build does about it

**The engine publishes as a folder, not a single file.** This is the largest
incidental signal and it was self-inflicted. `PublishSingleFile` with
`IncludeNativeLibrariesForSelfExtract` — which WPF requires, because it has native
libraries — makes the executable write `D3DCompiler_47_cor3.dll`,
`PresentationNative_cor3.dll`, `wpfgfx_cor3.dll`, `vcruntime140_cor3.dll`, and
`PenImc_cor3.dll` into `%TEMP%\.net\cua-engine\<hash>\` on **every start**, and
load them from there. That is what a dropper does, it leaves a fresh directory
behind on every build, and it made a 120 MB self-extracting stub out of what is
really a 155 KB program. A folder publish has none of that behaviour, and it still
needs no .NET runtime installed.

```
lib/bin/cua-engine/
├── cua-engine.exe        155 KB — the actual program
├── cua-engine.dll
├── cua-engine.runtimeconfig.json
└── … 234 framework files, 126 MB total
```

Two opt-ins exist for callers who want a different shape, both documented as
trade-offs rather than improvements:

| Build | Result | Trade-off |
|---|---|---|
| default | `lib/bin/cua-engine/` | 237 files; nothing to sign but the one executable |
| `CUA_ENGINE_WIN_FRAMEWORK_DEPENDENT=1` | one 0.3 MB `lib/bin/cua-engine.exe` | needs the .NET 9 desktop runtime installed |
| `CUA_ENGINE_WIN_SINGLE_FILE=1` | one ~120 MB `lib/bin/cua-engine.exe` | **self-extracts into `%TEMP%` on every start** |

**The executable identifies itself.** An unsigned binary whose every version
resource says `cua-engine`, with no company and no copyright, is the shape of a
packed payload rather than of a program someone is willing to put their name on.
`CuaEngine.csproj` now fills in `Company`, `Product`, `Description`,
`Copyright`, and a real `FileVersion`.

### What only you can do

**Sign it.** Code signing is the only thing that removes the "unknown publisher"
verdict rather than reducing it, and it is the difference between SmartScreen
warning the user and not. The build signs automatically when told to:

```powershell
$env:CUA_ENGINE_SIGN_PFX = 'C:\path\to\codesign.pfx'
$env:CUA_ENGINE_SIGN_PASSWORD = '…'   # omit for a passwordless pfx
pnpm run build:engine
```

It uses `Set-AuthenticodeSignature` with SHA-256 and a public timestamp server,
so no Windows SDK is required. An OV certificate removes SmartScreen's warning
after it accumulates reputation; an EV certificate removes it immediately.

**Report the false positive.** If Defender flags the engine, submit it at
<https://www.microsoft.com/en-us/wdsi/filesubmission> as a software developer
false positive. This is the correct channel, it gets the signature re-tuned for
everyone rather than just for this machine, and it is what the detection is
actually asking for.

**Verify what you are running.** The engine is built from source in this
repository and nowhere else. Compare the hash before trusting a binary you did not
build:

```powershell
Get-FileHash lib\bin\cua-engine\cua-engine.exe -Algorithm SHA256
# the build this document was last measured against:
# 8632D404B1AD57A52B911597E631881B5D28655E48F582EEB74B43302F6FE1F1
```

The hash is per build — a rebuild changes it, and it changed between the two
Windows builds measured here — so treat the line above as a record of the
artifact the measurements in this document describe, not as a value to compare
against. What a reader can actually check is where the binary came from: this
repository, at the commit they checked out, through `pnpm run build:engine`.

**If you add a Defender exclusion, add it to the build output, not to `%TEMP%`.**
Excluding a temporary directory is how malware persists; excluding
`packages\dsh-plugin-cua\lib\bin` is excluding a directory you compile yourself,
which is a defensible thing for a developer to do on their own machine. It
suppresses the symptom on that machine only and fixes nothing for anyone else —
prefer the false-positive report.

### What none of this fixes

A signed, well-identified engine that synthesizes input and captures the screen
will still be classified by **behavioural** endpoint protection — CrowdStrike,
SentinelOne, Carbon Black and their peers — as a remote-access or automation tool,
because that is what it is. Those products generally do not offer a
false-positive channel for a binary like this; they offer an administrative
allowlist, and using it is a decision for whoever administers the fleet. The
honest summary is: this plugin is a legitimate developer tool with the same
capabilities as a RAT, and on a managed endpoint that is a conversation with IT,
not a code change.

## `--mcp`: the same dispatch, a second envelope

`cua-engine --mcp` serves the Model Context Protocol on stdio, so the harness's
own MCP client can expose the catalog as `mcp__cua__<name>`. Reaching it takes a
row of its own in a profile patch — see the README's manual wiring — because it
needs a `command` pointing at the engine, and that path differs per platform: a
directory ending in `cua-engine.exe` on Windows, the single file `cua-engine` on
macOS. The package's own `cordis.patch.yml` therefore names the plugin rather
than the engine, which needs no path at all.

Nothing in that layer is platform-specific, and `src/McpServer.cs` sits beside
`Protocol.cs` rather than under `Win/` to make that plain. The engine's own
protocol and MCP are two envelopes around one operation:

```
Engine.Execute(EngineRequest) -> EngineOutcome        <- decides nothing about the envelope
        |                                             <- the dispatch, shared
        +-- {"id":1,"result":{...}}                   <- the engine's own protocol
        +-- {"jsonrpc":"2.0","id":1,"result":{         <- MCP
               "content":[{"type":"text","text":"{...}"}]}}
```

`initialize`, `notifications/initialized`, `notifications/cancelled`, `ping`,
`tools/list`, and `tools/call` are the whole surface; a notification is answered
with silence, and an engine failure becomes `isError: true` carrying
`code: message` rather than a JSON-RPC error, because the call itself succeeded.

Two things do differ from the macOS catalog, and both are deliberate:

**The descriptions are written for Windows.** They are what a model reads, and a
sentence about the Accessibility grant or an Apple event would be false here.
This is the same rewrite `src/platform.ts` performs on the plugin's own copy of
the catalog, for the same reason. The *schemas* are identical, because they
describe the same twelve operations — and `scripts/check-mcp-catalog.mjs`
enforces exactly that: the names must match the TypeScript catalog, and every
schema must validate with the harness's own validator.

**A capture is materialized to a file.** MCP hands a tool result back as a text
block, and a screenshot is megabytes of base64 that would spend the model's whole
budget on an unreadable blob — so the bytes are written beside the session
(`$DSH_CUA_SCREENSHOT_DIR`, defaulting to `~/.dsh/cua-screenshots`) and the path
is returned instead. The filename uses a colon-free timestamp, because a colon is
legal in a Windows path only as a drive separator.

## Deliberate deviations from the macOS contract

Each of these is a place where reproducing macOS exactly would have meant
reproducing a bug or a platform artefact.

| Area | macOS | Windows | Why |
|---|---|---|---|
| `element: 0` | refused (the application element is not a control) | addressable (the root is a real window) | There is no "application element" on Windows; refusing index 0 would refuse the window the caller asked for. |
| Multi-level `menu` paths | the submenu is read with the single-element accessor, so a path of length ≥ 2 fails | the items are found by title anywhere in the window, so multi-level paths work | The macOS behaviour is a defect, not a contract. Getting this right took two attempts: the first looked for a `Menu` element, which is what a classic Win32 popup is, while Windows 11's WinUI menus put theirs in a `PopupWindowSiteBridge` pane holding a plain `Window` named "Popup" — so single-level paths worked and every longer one reported "has no submenu". |
| `pointer` `down` / `up` | press and release, as named | press and release, as named | They previously behaved as `click`, each sending a full pair, so a hand-composed drag silently became two clicks. |
| Shell paths | `NSWorkspace` APIs take a URL | `ShellExecute` and `explorer.exe /select` | `reveal` asked for `explorer.exe` in `Environment.SystemDirectory`, which is `System32` — the file is one level up, in the Windows directory — so every reveal reported "shell error 2" (`ERROR_FILE_NOT_FOUND`) while the path being revealed was perfectly valid. |
| `roles` filter | widens rather than restricts | same | Kept identical because the macOS engine does it too (`Tree.swift`, `shouldEmit`), but the shared description claimed it kept *only* those roles. The filter adds matching roles to an output that still contains every element carrying text — including text-bearing elements that are not ancestors of any match. |
| `drag` destination | `toX`/`toY` are not read (the shipped tool still sends them, so drag is effectively broken) | `toX`/`toY` are honoured | The tool's own schema documents them as the destination. |
| Key chords | `key: "cmd+s"` is an unknown key; `modifiers` is separate | both spellings work | The tool advertises chords; a model writes them. |
| Parameter typing | optional accessors fall back silently on a wrong type | a wrong type is an error | The protocol's documented rule is "a wrong call fails"; a coordinate written as a string must not degrade into a click somewhere else. |
| Unknown parameter names | ignored | rejected, listing what is accepted | Catches a typo (`maxdepth`) instead of silently applying the default. |
| Outline text | `\n` → `⏎`, `\r` left alone | `\r\n`, `\r`, and `\n` all → `⏎` | Windows edit controls supply `\r\n`; leaving `\r` alone breaks the one-node-one-line property the substitution exists to provide. |
| `roles` vocabulary | AX role names | UI Automation control types, with AX names accepted as aliases | Reports what the platform actually has. |
| `quit` / `hide` scope | one application, one window | one *instance*: the named process plus the parent/child chain sharing its executable | A Windows application is several processes; acting on the one that owned the matched window leaves the rest running, and acting on *every* process with the same image catches an independently launched copy. |
| Lifecycle across the integrity boundary | n/a | refused | Terminating an elevated process from an unelevated engine **succeeds** — UIPI does not cover process access — so it has to be refused deliberately. |
| An ambiguous `app` / `bundleId` for a state-changing action | first match wins | refused, with the candidates listed | Picking one of two running instances is a guess the caller cannot see, and `quit` is not recoverable. `pid` is the escape hatch. |

## Building and testing

```powershell
cd packages/dsh-plugin-cua
pnpm install
pnpm run build          # publishes the .NET engine, then bundles the plugin
pnpm run typecheck
pnpm run check:schemas
pnpm run smoke          # loads the real bundle and calls the real engine
pnpm run smoke:writes   # also moves the pointer, presses a key, and writes into a background app
```

`smoke:writes` opens Notepad, writes into it through both `cua_element` and
`cua_type`, reads the text back, and closes it again, restoring the foreground
window it found. Which parts of the background-operation guarantee it asserts
depends on the platform, and it says which: macOS can prove the whole thing
because it delivers keystrokes to a named process, while Windows proves the
element action and reports that background *typing* is not available there.
