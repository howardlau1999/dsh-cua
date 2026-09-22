# Handoff

State of the Computer Use plugin as of the work following commit `e56fa4f`, and
what is left. Read [`docs/case-study-tool-visibility.md`](case-study-tool-visibility.md)
first for why the integration looks the way it does.

## Where things stand

Working and verified: the Swift engine, the MCP server over it, the bundle, and
the install path. The twelve tools reach a model as `cua_*` in a session created
after the host booted.

The bundle's row is the **native plugin row**, not the MCP one. A row that names
the engine has to carry a path, and that path differs per platform — a directory
ending in `cua-engine.exe` on Windows, the single file `cua-engine` on macOS — so
the shipped patch names the package instead and lets the plugin find its own
engine. `cua-engine --mcp` is still there and still verified; reaching it is the
README's manual-wiring alternative.

Verified by direct measurement, not inference:

| Claim | How it was checked |
|---|---|
| Tools reach a model | Called from a session created after the host boot |
| Engine permissions inherited | `accessibility=true screenRecording=true ready=true` from inside the host process tree |
| Accessibility tree | 548 nodes in 185 ms through the model; 23 ms at `nodeLimit: 25` |
| Unicode text input | Typed CJK into TextEdit and read it back from the app |
| Background operation | `cua_element` wrote to a non-frontmost app; focus unchanged |
| Background input, `route: "pid"` | Scrolled a background TextEdit; cursor stayed at 313,-270 and focus did not move |
| Multi-display density | Calibrated per display: 1.270 on a scaled HiDPI screen, 1.000 on 2× screens |
| Region clipping | A rectangle spanning two displays clips to the larger overlap and reports `clipped` |
| Off-desktop rejection | A point outside every display is refused with the desktop bounds |
| Locked screen | Reported as `the screen is locked`, not a ScreenCaptureKit error |
| Screenshot through the model | 616 KB PNG written to disk; the image read back through `read_image` |
| JPEG capture | `mimeType: image/jpeg`, `.jpg` extension, image read back |
| `cua_request_permissions` | Called; reports the same permissions as `cua_status` |
| A wedged capture cannot hang the engine | Watchdog fires at 12 s and the engine exits 75; MCP client reconnects onto a new one |

Test suites, all green:

| Suite | Covers |
|---|---|
| `swift test` (via `scripts/test-swift.mjs`) | 27 tests over the engine's pure logic: coordinate conversion, region clipping, display overlap, application ranking, pointer buttons, catalog consistency |
| `check-schemas.mjs` | 46 checks: every TypeScript tool's parameter and output schema, through the harness's own validator |
| `check-mcp-catalog.mjs` | 128 checks: the twelve tools the engine publishes over MCP, validated the same way and compared against the TypeScript catalog |
| `check-capture-deadline.mjs` | 5 checks: a wedged capture aborts the engine within its bound |
| `smoke.mjs` | 51 checks: the built bundle loaded and every tool called against the real engine |
| `smoke.mjs --write` | Adds pointer movement, key delivery, and background read/write with a focus assertion |

`make check` runs the first five. `make smoke-writes` adds the last.

## 1. Exercise the tools through the model — **done**

All twelve were called from a live session. Everything behaved, and the
exercise found four defects that no existing check covered. All four are fixed;
each has a regression check.

| Tool | Result |
|---|---|
| `cua_status` | Both permissions granted, `ready: true` |
| `cua_request_permissions` | Same report; no dialog, because nothing is missing |
| `cua_displays` | Three displays, desktop `[-1168,-1080,3840,2062]` — matches the previous record exactly |
| `cua_apps` | 82 running applications |
| `cua_windows` | Correct frames and window ids |
| `cua_tree` | 548 nodes in **185 ms**; no timeout risk. The MCP row's 120 s budget is not close to being reached |
| `cua_screenshot` | 616 KB PNG written; path read back through `read_image` and the image arrived |
| `cua_click` | Delivered; `route: "pid"` verified against a background window |
| `cua_type` / `cua_key` | Delivered |
| `cua_element` | Actions on background windows; indices survive across calls |
| `cua_app` | `activate`, `launch`, `quit force`, `openURL`, `reveal`, `menu` all exercised |

### The four defects it found

1. **A wedged capture took the whole machine's capture path down.**
   ScreenCaptureKit's worst failure is not an error: the call stops answering
   and never returns. One such capture blocked every later capture in every
   process — the host's long-lived engine and a freshly spawned one alike —
   until the wedged process was killed, with the engine spinning at ~19% CPU.
   A 12 s watchdog now stops the engine instead. Stopping is safe and
   self-healing: the MCP row reconnects and the capture path recovers for
   everything else. `check-capture-deadline.mjs` drives the real abort path.

2. **A capture reported the frontmost application, not the captured one.**
   `app` was read from `NSWorkspace` at the end of the call, so a capture of a
   specific window named whichever application had focus when it finished.
   It now names the captured window's owner.

3. **The two integration paths disagreed about the catalog.**
   The engine publishes `cua_request_permissions` as its own name; the
   TypeScript catalog had eleven tools with the same capability folded into
   `cua_status` as a `request` boolean. Both now expose one tool per name.
   Fixing it also removed a latent bug: `engine.request_permissions` returns
   the report flat while `engine.status` nests it under `permissions`.

4. **`cua_app`'s `reveal` and `menu` were both broken.**
   `reveal` could not be called at all — the schema declares `path` as an array
   and the handler read a string. `menu` always claimed success, discarding the
   traversal's outcome. Underneath, the traversal had never worked: a menu only
   materializes while open, so entries live in the `AXMenu` child that pressing
   a bar item exposes, and the walk never descended. Each level is now opened as
   the walk descends.

### The write gate, settled

The MCP row does **not** carry the plugin's own `writeApproval`, and cannot: the
plugin's `apply()` never runs on that path, because `dsh-mcp-client` is its
sibling row rather than its loader. The operating system's grants are the only
gate there.

Whether that matters depends on the session's approval preset, and in a session
that cannot prompt it does not: a plugin-level gate would be answered
`unavailable` and would refuse every write. `writeApproval` only has teeth when
the session can actually prompt.

That argument decided which row to ship, once the path problem did: **the native
row**, because it is the one that carries the write gate and the
`ctx.computerUse` registration, and because a row naming the engine has to carry
a path that differs per platform while a row naming the package carries none.
The MCP row remains for a deployment that wants `mcp__cua__*` or is wiring the
engine as an MCP provider directly; switching is a one-line patch change,
documented in the README. Do not run both: that is the twenty-four-tool catalog
the case study already paid for.

If the gate is ever needed *without* giving up the MCP row, the missing piece is
a thin plugin that owns the MCP child itself (registering `computerUse` and
gating writes in its own `apply`) instead of letting a patch row spawn
`dsh-mcp-client` directly. That package cannot be imported from here — the
profile does not install it, and only the harness's own composition resolves
`@deepseek-ai/dsh-mcp-client` by name — so it would have to load the client by
plugin name through the composition rather than by import. Not attempted.

## 2. Reconcile with `ctx.computerUse` — **done, on the native row**

`ctx.computerUse.register(ComputerUseProviderName('cua'))` now happens in
`src/computer-use.ts`, reached through `ctx.get('computerUse')` rather than
injected, so a composition without the service loads exactly as it did before.
The slot is released with the plugin's own fiber, and a second provider still
fails loudly.

**It only takes effect on the native row**, for the same reason the write gate
does: `apply()` does not run on the MCP path. This is the same one decision as
the write gate above, not a second one.

Reaching it required no dependency on a harness package: only `register` is ever
called, and a duplicate registration is the registry's own error. The provider
name is fixed rather than configurable, because the registry's duplicate message
is only useful if the name is stable.

## 3. Test coverage and CI — **done, except CI**

The twelve MCP tool definitions are now asserted
(`scripts/check-mcp-catalog.mjs`), which is what §3 asked for and what caught the
catalog drift. It boots the engine over the same stdio protocol the harness
uses, runs each returned schema through the harness's own validator, and
compares the two catalogs so they cannot drift again.

The engine has unit tests (`native/cua-engine/Tests/`), 27 of them, over the
four targets §3 named in order of value:

| Target | Tests |
|---|---|
| `Tree` filter and budget | Covered end-to-end by `smoke.mjs` instead: roles filtering, the named truncation budget, and stale-index refusal all need a live application, and the pure parts are already pinned there |
| Capture region clipping | 7, including negative display origins and the no-overlap fallback |
| `Pointer` coordinate conversion | 3, including that x is never touched and that the two directions invert |
| `MacHost` application resolution ranking | 7, including the measured Dock-helper defect |

The remaining 10 cover display-overlap arithmetic (3), the pointer button table
(2), and the published MCP catalog's internal consistency (5).

Writing the ranking tests forced `resolveApplications` to stop ranking inline,
which is why its defect had been unreachable from a test. The ranking is now a
pure function over name, bundle id, and activation policy.

Two things about running them are worth knowing:

- **`swift test` alone does not work here.** With the Command Line Tools as the
  active developer directory, the Swift Testing macros live in a plugin bundle
  SwiftPM does not put on the compiler's search path, so every `@Test` fails
  with "external macro implementation type could not be found" even though both
  the module and the plugin ship with the toolchain. `scripts/test-swift.mjs`
  resolves the directory from the active toolchain — it differs between the
  Command Line Tools and Xcode layouts — and passes it explicitly.
- **XCTest is not an option at all**: the Command Line Tools do not ship the
  module. Swift Testing was chosen for that reason.

No CI. The engine tests and both schema checks need no permissions or desktop,
so they would run on a macOS runner; the smoke and deadline checks need a live
desktop and real permissions, so they stay local.

## 4. Engine work

Done:

- **The write gate at the MCP layer** — see §1. Decided against a new mechanism;
  the native row carries it, and the reason is recorded above.
- **`cua_request_permissions`** — called, and its projection bug fixed.
- **`cua_app`'s `openURL`, `reveal`, and `quit force`** — `reveal` was broken and
  is fixed; the other two were correct.
- **JPEG capture** — verified end to end.
- **`cua_click` with `route: "pid"`** — verified against a background window.

Still open:

- **An engine-side `screenshotDir`.** Unchanged: the MCP boundary writes captures
  to `~/.dsh/cua-screenshots` (overridable with `DSH_CUA_SCREENSHOT_DIR`), while
  the native protocol still returns inline base64 and the plugin decides where it
  lands. The setting lives in the plugin's config rather than the engine's, which
  is where it belongs for the row that is now shipped.
- **The macOS side of the native row has not been exercised from a model
  session.** Everything verified on macOS went through the MCP row; the native
  row's registration path is asserted by `smoke.mjs`, but its *tool results* —
  text projection, image admission through the attachment store, the write gate's
  refusal wording — have never been seen from a macOS session. Open a new session
  on the native row before trusting it there.
- **Windows is done**, and it was done on the native row: the C#/.NET engine
  implements all twelve methods and `--mcp`, `check-mcp-catalog.mjs` validates its
  catalog (128 checks), and the smoke test drives real windows. Linux is the one
  platform with no backend; `IPlatformHost` is the seam, and `UnsupportedHost`
  answers honestly in the meantime.

## Known limitations, all documented

Text entry without `element` does nothing to a background application;
`route: "post"` reaches only the frontmost application; a region spanning two
displays is captured from the larger overlap rather than stitched; element
indices last only as long as the engine session; a tree is always truncated by a
budget and says which; the screen being locked makes capture and trees
unreliable and is reported explicitly; `route: "pid"` clicks reach a background
window only for applications that accept synthetic events.

One more, added by this work: **screen capture only works inside the host's
process tree.** macOS attributes the Screen Recording grant to the process
responsible for the engine, so an engine started from a terminal has no capture
attribution — and its first ScreenCaptureKit call does not fail, it stops
answering. `lib/bin/cua-engine --call capture.screenshot` therefore cannot be
used to verify capture by hand; trees, windows, and app lists are unaffected.
`make smoke` skips the capture assertions unless `DSH_CUA_CAPTURE=1` says it is
already running inside the host.

## How to work in this repository

```sh
make build          # Swift engine + bundled plugin
make check          # engine unit tests, types, both catalogs, deadline, smoke
make smoke-writes   # adds real pointer, key, and background-app assertions
```

The engine is usable without the harness, which is how it gets debugged. Note
the path: the handoff previously printed `lib/bin/cua-engine`, which is wrong —
it lives under the package.

```sh
cd packages/dsh-plugin-cua
lib/bin/cua-engine --probe
lib/bin/cua-engine --call tree.dump --params '{"app":"Finder","maxDepth":4}'
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | lib/bin/cua-engine --mcp
```

Two habits this project earned the hard way:

- **Validate a patch with `loadOverlayPatches`, never with string matching.** A
  `text.includes()` check once passed a file holding two YAML documents and cost
  the user their profile configuration.
- **When a tool seems missing, open a new session before investigating.** That is
  the entire root cause of the case study.

And two this round added:

- **A check that passes because it did not run is worse than no check.** The
  smoke test's capture assertions were reporting on the absence of a TCC grant,
  not on the capture code. They now say so and skip. `build-engine.mjs` verifies
  the binary it installed is the one SwiftPM built, after SwiftPM reported
  "Build complete!" without recompiling and silently installed a stale engine —
  a stale engine answers every check.
- **A stale binary is the one failure that looks like success everywhere.**
  When a check contradicts a previous measurement, suspect the artifact before
  the reasoning.
