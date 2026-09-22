# dsh-cua — Computer Use for DeepSeek Harness

English | [中文](README.md)

Let a model see and operate the macOS desktop: read the UI of foreground and
background applications, take screenshots, synthesize mouse and keyboard input,
and drive applications through their own APIs and Apple events.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
package: twelve `cua_*` tools over a native Swift engine.

## What it does

| Tool | Purpose | Permission |
|---|---|---|
| `cua_status` | Engine state, and exactly how to fix what is missing | — |
| `cua_request_permissions` | Raise the macOS permission prompts | — |
| `cua_displays` | Display layout: ids, rectangles, densities, desktop bounds | — |
| `cua_apps` | Running or installed applications | — |
| `cua_windows` | On-screen windows with ids and screen rectangles | Accessibility |
| `cua_tree` | Accessibility tree, one indexed line per element | Accessibility |
| `cua_screenshot` | Window, display, or region capture to a file | Screen Recording |
| `cua_click` | Click, drag, scroll; global or direct-to-process | Accessibility |
| `cua_type` | Type text, including CJK and emoji, into a named field | Accessibility |
| `cua_key` | Named keys and chords such as `cmd+shift+t` | Accessibility |
| `cua_element` | Let an element perform its own action | Accessibility |
| `cua_app` | Lifecycle, menus, and Apple-event messaging | Accessibility; Automation for `script` |

## Design

Two layers, split so the process holding the macOS grants stays small:

- **`cua-engine`** — a Swift binary speaking one JSON object per line over stdio.
  It owns every operating-system capability and all cross-call state (element
  snapshots, calibrated display densities). `PlatformHost` is the seam a Windows
  (UIAutomation) or Linux (AT-SPI) backend would implement; the protocol and the
  plugin do not change for it.
- **`@deepseek-ai/dsh-plugin-cua`** — a TypeScript package that registers the
  tools, renders engine results for a model, and gates writes through
  `ctx.approval`. Reads are free; writes are gated.

## Behaviour worth knowing

**Background applications are a first-class case.** Every read addresses a
background application directly, and `cua_element` performs its actions through
the accessibility API — nothing has to be frontmost, and focus is never stolen
from the user. Typing into a background window requires naming the element
(`cua_type` with `element`): keystrokes posted to a background process are
ignored unless that application's own accessibility focus is already on the
field. Without an element the text goes to whatever is frontmost, and a
background application drops it silently.

**Multi-display is handled explicitly.** Coordinates are top-left-origin screen
points everywhere, and secondary displays may sit at negative x or y. Pixel
density is *measured per capture* rather than assumed: on a mixed-density setup
the same logical size captures at different pixel counts per display, and the
convenience capture APIs silently change density with region size — so the
engine calibrates each display once and reports the `scale` that is true for the
image you actually received.

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

## Requirements

macOS 15.2 or newer, the Swift toolchain (`xcode-select --install`), and Node 22+.

Accessibility is required for trees, input, and element actions; Screen
Recording for screenshots; Automation for `cua_app`'s `script` action.

The grants attach to the **responsible process**, not to the binary. Measured:
copying the engine to a file name that has never been granted anything still
reports the grant as present, because the grant follows whatever launched the
process rather than the executable. Two consequences: rebuilding or moving the
engine cannot lose the permission, and the application to enable in System
Settings is the one that loads the plugin — not `cua-engine`, and not the
terminal you launched it from. `cua_status` names that application and its pid,
and the grant only takes effect on a fresh launch.

## Build

```sh
make build          # native engine + bundled plugin
make check          # types, tool schemas, end-to-end smoke test
make smoke-writes   # also moves the pointer and exercises background writing
```

`make` uses the toolchain the harness ships under `$DSH_HOME`; see the
`Makefile` for the exact paths, or run `pnpm install && pnpm run build` inside
`packages/dsh-plugin-cua` with your own Node.

## Install

The package declares `dsh.bundle`, so the plugin manager can install it. In the
application: **Settings → Plugins → Add plugin**, then the package's absolute
directory:

```
/path/to/packages/dsh-plugin-cua
```

The manager adds it as a bundle layer of the chosen profile, and the package's
`cordis.patch.yml` contributes one row: an MCP client over the engine's `--mcp`
mode. The tools reach a model as **`mcp__cua__<name>`**. Restart the application
after installing.

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

```yaml
- insert:
    - id: mcp-cua
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: cua
        transport: stdio
        command: /absolute/path/to/packages/dsh-plugin-cua/lib/bin/cua-engine
        args: [--mcp]
        toolCallTimeoutMs: 120000
        failOnStartupError: false
        reconnect: { enabled: true }
```

The engine also installs as a native plugin row registering `cua_*` tools
directly. That form is verified working, but the package does not ship it: both
rows together put two identical catalogs of twelve tools in front of the model.
To use it, replace the row above with:

```yaml
- insert:
    - id: cua
      name: /absolute/path/to/packages/dsh-plugin-cua/lib/index.js
      config:
        enginePath: /absolute/path/to/packages/dsh-plugin-cua/lib/bin/cua-engine
        writeApproval: always     # always | session | never
        idleShutdownMs: 600000
```

The two rows differ in three ways, all in the plugin layer rather than in what
the tools can do: the native row names its tools `cua_*` instead of
`mcp__cua__*`; `writeApproval` applies **only** to the native row; and the
`ctx.computerUse` provider registration happens **only** on the native row. Both
of the latter are because a plugin's `apply()` runs only when the plugin is
loaded, and `dsh-mcp-client` is a sibling row rather than a loader for it.

`writeApproval` gates writes on top of the macOS grants: `always` asks before
every write, `session` asks once per write tool per session, `never` leaves the
macOS grants as the only gate. In a session whose approval policy is `never` — a
refused approval blocks the action outright — `never` is the only usable value,
and a plugin-level gate would refuse every write rather than gate it. Choose the
native row when the session can prompt and the gate should be enforced, or when
the harness's computer-use capability should report this engine as its provider.

## Engine CLI

The engine is usable without the plugin, which is how it gets debugged:

```sh
lib/bin/cua-engine --probe
lib/bin/cua-engine --call tree.dump --params '{"app":"Finder","maxDepth":4}'

# Stateful: one process, so an element index from one call addresses the next.
printf '%s\n' \
  '{"id":1,"method":"tree.dump","params":{"app":"Finder","maxDepth":4}}' \
  '{"id":2,"method":"element.action","params":{"element":5,"action":"list"}}' \
  | lib/bin/cua-engine
```

Methods: `engine.status`, `engine.permissions`, `engine.request_permissions`,
`display.list`, `app.list`, `window.list`, `tree.dump`, `capture.screenshot`,
`pointer`, `keyboard`, `element.action`, `app`. Errors carry a code —
`invalid_request`, `unknown_method`, `not_found`, `permission_denied`,
`operation_failed`, `unsupported_platform`.

## Limitations

- macOS only. Other platforms load the plugin and report `unsupported_platform`.
- Locked screen: capture fails and the frontmost application becomes
  `loginwindow`, so everything is unreliable. Reported explicitly as
  `the screen is locked`.
- A region spanning two displays is captured from the display with the largest
  overlap; regions are not stitched across screens.
- Whether `route: "pid"` synthetic clicks reach a background window depends on
  the application and is not guaranteed — use `cua_element` when reliability
  matters.
- Element indices live only as long as the engine session; a stale index is
  rejected with a message saying to re-read the tree.
- Screen capture works only inside the host's process tree. macOS attributes the
  Screen Recording grant to the process responsible for the engine, so an engine
  started from a terminal has no capture attribution — and its first
  ScreenCaptureKit call does not fail, it stops answering. A watchdog stops the
  engine after 12 s rather than letting it hang, and the MCP client reconnects
  onto a fresh one; a hung engine otherwise blocks capture for every process on
  the machine. Trees, windows, and application lists are unaffected, so the CLI
  above remains the way to debug those.

## License

MIT — see [LICENSE](LICENSE).
