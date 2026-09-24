# Handoff

State of the Computer Use plugin as of the work following commit `e56fa4f`, and
what is left. Read [`docs/case-study-tool-visibility.md`](case-study-tool-visibility.md)
first for why the integration looks the way it does.

Machine-local companion: [`HANDOFF-desktop-profile.md`](HANDOFF-desktop-profile.md)
(Chinese) records the profile the desktop application on this machine actually
boots, what was installed into it, how to verify it after the next restart, and
how to roll it back.

The macOS counterpart is [`HANDOFF-macos-native-row.md`](HANDOFF-macos-native-row.md):
the native row's tool results have never been seen from a macOS model session, and
that document is the procedure for producing them, including the three checks that
only such a session can perform.

## Where things stand

Working and verified: the Swift engine, the MCP server over it, the bundle, and
the install path. The twelve tools reach a model as `cua_*` in a session created
after the host booted.

**The profile the tools reach is the profile the host boots, and on this machine
that is `desktop`, not `web`.** The Electron application boots
`~/.dsh/profiles/desktop` — read off the running host's own argv, not guessed —
and the `web` profile that had been carrying the `cua` row is the CLI's, so a row
installed there is loaded by nothing that ever serves a session from the
application. The row now lives in the `desktop` profile, with the package linked
into that profile's `node_modules`. `dsh --profile desktop …` and
`dsh plugin --profile desktop …` both refuse outright (the launcher owns that
name), so the link is made by hand and the patch is validated with
`loadOverlayPatches` before it is written — the habit recorded at the end of this
document, applied to the file that would otherwise take the application's boot
with it.

Verified on Windows against the packaged runtime (0.1.6-alpha.2, dsh
0.1.6-alpha.2), not inferred: a throwaway profile built from the real
`desktop` files composed the row, resolved the linked package, ran its `apply()`,
and registered all twelve `cua_*` tools. `cua-engine.exe --probe` reports engine
0.2.0, backend `windows-uia`, `accessibility`/`screenRecording` true, `ready`
true, `elevated` false; `scripts/smoke.mjs` passes 68/68 against the real engine.

**The application's own boot has since been verified, which closes the one step a
hand edit could not rehearse.** After a full restart of the desktop application,
a session created after that boot called all twelve `cua_*` tools — the model
session, not a probe — and `cua_status` reported engine 0.2.0 on `windows-uia`
with both permissions granted. The host's own argv names
`C:\Users\howar\.dsh\profiles\desktop`, the linked package resolves inside it, and
`validate-patch.mjs` accepts the row. The machine-local record of that run is
[`HANDOFF-desktop-profile.md`](HANDOFF-desktop-profile.md).

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
| `swift test` (via `scripts/test-swift.mjs`) | **34** tests over the engine's pure logic: coordinate conversion, region clipping, display overlap, application ranking, application listing, pointer buttons, catalog consistency |
| `check-schemas.mjs` | **49** checks: every TypeScript tool's parameter and output schema, through the harness's own validator, plus the guidance section's order (see §4) |
| `check-mcp-catalog.mjs` | 128 checks: the twelve tools the engine publishes over MCP, validated the same way and compared against the TypeScript catalog |
| `check-capture-deadline.mjs` | 5 checks: a wedged capture aborts the engine within its bound |
| `smoke.mjs` | 51 checks when it was written, **68 on Windows today**: the built bundle loaded and every tool called against the real engine. macOS runs **62** of them by default, **78** with `DSH_CUA_CAPTURE=1`, **89** with `--write` too |
| `smoke.mjs --write` | Adds pointer movement, key delivery, and background read/write with a focus assertion |

`make check` runs the first five. `make smoke-writes` adds the last.

Two numbers in the table above age, and were re-measured on the Windows machine
rather than carried forward: `check-schemas.mjs` is 49 checks now and
`check-mcp-catalog.mjs` still 128, but the smoke suite grew to 68 as tools gained
assertions — most recently the three that hold `cua_status` to the elevation the
engine actually reported. The macOS counts moved for the same reason and were
re-measured on macOS: four checks joined the status section (§4) — the
payload-to-value invariant and the three fields it protects — taking 58/74/85 to
**62/78/89**. One wrinkle worth recording because it was seen once and not
reproduced: the first `--write` run of that measurement threw an uncaught error
immediately after a capture run, and the same sequence then passed twice (78/78
then 89/89, exit 0). It is not attributable to the projection change, and it is
noted here so that a repeat sighting starts from a known one.
`scripts/check.mjs` skips the two macOS-only stages on Windows and says so —
`all 4 stages passed (2 skipped on this platform)` — so a green `pnpm run check`
on Windows is four suites, not six.

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

**Measured on macOS: no profile on this machine mounts the service, and the
packaged application does not ship it.** The provider lives in the harness's own
`packages/computer-use/computer-use`; `--dump-config` over `desktop`, `web`, and
`headless` reports zero `computerUse` rows in every one of them, and the
application's bundled tree carries 275 `@deepseek-ai` packages with no
`dsh-computer-use` among them — so a live host claim would be an install, not a
composition row. The branch a live host takes is the graceful absence path, which
is the point of reaching the service through `ctx.get`.

**The claim is no longer asserted only against a stub.** The registry's own source
and this plugin's built bundle now run in one real cordis context, driven through
the plugin's own `apply()`: the slot goes `undefined → "cua" → undefined` across
the claim and the plugin's disposal, and every wrong ordering fails loudly with the
registry's own `computer use provider "cua" is already registered` — a repeat
registration, a second `apply()`, and a foreign provider registered first, where the
plugin refuses to load at all. 13/13 checks. The registry loaded was
0.1.7-alpha.1 from the checkout, which is a partial install; the service is not
installed anywhere else on this machine, so that is the reference implementation
rather than the shipped one. One trap for a repeat run: `ctx.get('computerUse')`
returns cordis's traceable wrapper, not the registry instance, so an identity
assertion fails while the claim works — read `providerName` instead.

## 3. Test coverage and CI — **done**

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

CI now exists as [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), and it
deliberately covers less than "the suite". The split is worth stating where
someone will read it:

- **What runs, on a clean clone.** macOS builds the Swift engine, runs the 34 unit
  tests, and runs the capture-deadline checks; Windows builds the .NET engine.
  Those three scripts import no harness package, which is what makes a bare
  checkout enough. The deadline check belongs there because it needs no
  screen-recording grant — it drives the simulated wedge
  (`CUA_ENGINE_SIMULATE_WEDGED_CAPTURE`), not a real capture. An earlier version
  of this paragraph claimed the opposite and would have left it out.
- **What does not run, and why.** `typecheck`, `check-schemas`,
  `check-mcp-catalog`, `smoke` and `validate-patch` import
  `@deepseek-ai/dsh-tools` or `@deepseek-ai/dsh-app-boot` through this package's
  `link:../../../deepseek-harness/…` devDependencies. The harness repository is
  public, but it publishes no build output to git — `lib/` and `node_modules/`
  are both gitignored — so a runner would have to clone and build that whole
  monorepo before any of them could execute. Until someone does that
  deliberately, a green CI run means "both engines build and their tests pass",
  not "the suite is green"; `make check` on a configured machine is still the only
  thing that means that.
- **One further limit, invisible from outside.** Even with the harness present,
  the macOS half of `smoke` could not exercise its permission-gated checks:
  Accessibility and Screen Recording cannot be granted to a runner.
- **First run, measured.** [Run
  1](https://github.com/howardlau1999/dsh-cua/actions/runs/35983459710) on
  GitHub's own runners: both jobs green. macOS took 1m57s — engine build 57s, the
  34 unit tests 38s, the deadline check 13s — and Windows 50s, of which the .NET
  engine build was 29s. That Windows job is the half that could not be rehearsed
  locally, so it is also the first time the C# engine has been built anywhere but
  this machine.

## 4. Engine work

Done:

- **The guidance section took its order from a number the harness had moved past.**
  `ctx.systemPrompt.section({ name: 'cua:guidance', … })` hardcoded `900`, under a
  comment claiming the section landed "after the harness's own tool guidance". It
  did not: the harness's table puts `FILE_REFERENCE` at 900 and every tool section
  above it, while publishing a canonical order for exactly this guidance —
  `TOOL_COMPUTER_USE: 3000` — which its own computer-use providers ask for rather
  than name (`getSectionOrder('TOOL_COMPUTER_USE')`). The plugin asks the host now
  and falls back to 3000 when the host does not answer, through a locally declared
  slice, because the type this package compiles against lags the running host's own
  table: the union `getSectionOrder` accepts has no `TOOL_COMPUTER_USE` in it, while
  the shipped application defines the name (both measured). Three checks in
  `check-schemas.mjs` pin the behavior on a host that states an order and on one
  that cannot, which is why that stage reads 49 rather than 46.
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
  on the native row before trusting it there. **Windows has now had exactly that
  exercise** (see §1), and the projection defect it turned up was Windows-specific
  in its trigger, so this remains the one unverified surface.
  [`HANDOFF-macos-native-row.md`](HANDOFF-macos-native-row.md) is the procedure for
  closing it: what is already verified, what only a macOS model session can show,
  the exact commands, and what to report back.

  **Everything around that session has since been verified on macOS, and it is
  now one restart away** — §8 of that document records the run. All six stages
  pass (`all 6 stages passed`); smoke is 58/58, 74/74 with `DSH_CUA_CAPTURE=1`,
  and 85/85 with `--write` as well, which means capture, real pointer and key
  input, and background-app writes are all measured on macOS rather than assumed.
  A throwaway profile built from the real `desktop` files was composed by the
  **packaged** dsh and produced the `cua` row and nothing else, so the boot is
  rehearsed too. Three defects were found and fixed on the way:

  1. **`make` replaced `PATH` rather than prepending to it.** `$(if)` expands
     only the branch it selects, so `$(if $(DSH_NODE_BIN),$(DSH_NODE_BIN):,$(PATH))`
     dropped the entire system PATH whenever the harness runtime was present —
     which is the normal case — and `make build` failed claiming the Swift
     toolchain was missing on a machine where `swift --version` works.
     `pnpm run build` was unaffected, which is what made it look like a toolchain
     problem.
  2. **`cua_apps` listed one row per process, not per application.** The Windows
     backend documents the contract and states that macOS already de-duplicates
     by bundle id; it did not. `listApps` built a `seen` set in its running branch
     and only consulted it in the installed branch. On the live desktop that was
     20 duplicate ids — `com.apple.WebKit.WebContent` eleven times. Now folded by
     bundle id: 76 rows before, 56 after, no duplicate id or pid, frontmost
     preserved. Seven unit tests cover it.
  3. **`cua_request_permissions` reported an identity it did not have** — found
     by a model session on the native row, which is the exercise §4 of the macOS
     document exists for. It answered `engine unknown on macos  (backend unknown)`
     while `cua_status`, in the same session, answered `0.1.0` and `macos-ax`.
     The contract had already drawn the line: `engine.request_permissions` returns
     the *permissions* object, and `engine`/`backend` come from `engine.status`
     alone (§8.1 says as much of `platformVersion`). The tool projected its own
     payload, so its description's promise of "the same report as cua_status" was
     false for the three fields a model is most likely to quote back. It now
     re-reads `engine.status` after raising the prompts. The smoke suite compared
     only the permission booleans, `ready`, and `missing` — all present in the
     flat payload — so it now also asserts the two tools agree on engine version
     and backend, which is the check that would have caught it.

  One documentation defect came out of the same run and is the kind this project
  keeps having to correct: the macOS document's "already verified" table claimed
  `--probe` reports engine **0.2.0** on macOS, and it reports **0.1.0**. The two
  backends carry independent versions by design — `engine-contract.md` has said
  so all along — so the engine was right and the prose was wrong.

  **The GUI host has since run the same exercise, after the restart this list was
  waiting for** — §10 of the macOS document records it. Measured: the host booted
  at 11:36:31 and the session that called the tools was created at 11:36:34, so
  the row it saw came from that boot; the catalog was the twelve `cua_*` tools
  with no `mcp__cua__*`, and exactly one `cua` row (the profile's patch
  `documents: 0`, the package's `documents: 1`). `cua_status` reproduced §9's
  report byte for byte with zero `/elevat/i` matches, and `cua_displays`,
  `cua_tree`, and `cua_element action=list` all behaved. The write gate refused
  again with §9's wording — and §9's explanation of *why* turned out to be wrong
  in the one way worth carrying forward: the refusal was **not** "nobody to ask".
  A `never` approval policy short-circuits the ask before any answerer is
  dispatched, and every session on this machine was seeded with it
  (`~/.dsh/settings.yaml` had `permission.defaultPreset: danger-full-access`, and
  the base bundle pairs that preset with `approval: never`). The GUI session's own
  log carries `permission/preset {"preset":"danger-full-access"}` +
  `approval/policy {"policy":"never"}`, and §9's headless log
  (`session-17a7a47b-…`) carries the same two events — so GUI and headless
  matched for one reason, and the refusal wording identifies neither who was asked
  nor whether anyone was. **The gate is now confirmed in the positive direction
  too**: in a session whose policy is `ask` (`session-5271d134`, opened after the
  relaunch), `cua_click` raised a prompt and the approval came back
  `{"outcome":"allowed-once"}` — the whole of §4's item 3, both halves.

  An attempt to add a `full-access-ask` preset (full file access *with* prompts)
  through `~/.dsh/settings.yaml` **did not take effect**: after a relaunch the next
  new session seeded `workspace-write` + `approval/policy: ask` instead. The
  settings layer carries **volatile** fields only — `presets` is not one, so the
  table it named was never composed, and the `defaultPreset` beside it stopped
  being applied too (`packages/settings/settings/src/schema.ts`). That line of the
  file was restored from its backup. A preset table ships only as a composition
  override of the `permission` row in the profile's patch layer — which is what
  `~/.dsh/profiles/desktop/cordis.patch.yml` now carries, validated by
  `validate-patch.mjs` (`overrides: [{ "id": "permission" }]`, and the package's
  patch still the single `cua` row) and by `--dump-config` over a copy of the
  profile, which printed the patched row with all four presets. The layer split is
  now measured rather than guessed: that boot still seeded `danger-full-access`,
  because a composed `defaultPreset` loses to the settings document — `defaultPreset`
  *is* volatile, and volatile fields are exactly what `settings.yaml` carries (the
  same mechanism that picks this machine's `agent-default-model`). So the table
  belongs to the composition and the default choice to `settings.yaml`; that line
  was flipped to `full-access-ask`, and the running application then resolved the
  name — `/permission full-access-ask` in the GUI session logged
  `permission/preset {"preset":"full-access-ask"}` + `approval/policy {"policy":"ask"}`,
  the sandbox knob unchanged because it was already `danger-full-access`. A **new**
  session (`session-25943e68`, 13:53:13, no manual switching) then seeded
  `full-access-ask` + `danger-full-access` + `ask` from `defaultPreset` alone, so
  full file access *with* prompts is now what every session here starts on. The same
  patch also carries `- id: cua` with `writeApproval: session`, asking at most once
  per write tool per session; a config-only override reaches a running host without
  a relaunch, which was measured rather than assumed. §10 of the macOS document has
  the whole sequence.
- **The status projection is a hand-maintained list, and it silently drops what
  it does not name — both halves of that are now fixed.** Windows reports
  `elevated`, `elevationAvailable`, `backendDetail`, and `sessionId`;
  `toPermissionReport` kept the twelve fields macOS also has, so a model on
  Windows could not see which side of the UIPI boundary the engine was on while
  `cua_status`'s own hint text referred to `elevated: false` as though the model
  could read it. All four are carried now, each only when the backend actually
  reported it, so a macOS report never grows a Windows-only claim — the render is
  byte-for-byte what §9 of the macOS document quotes, checked by diffing the
  output against that quote rather than by reading the guards.

  The general form of the trap is closed with it: `smoke.mjs` now compares the two
  shapes, asserting that **every field the engine's status payload carries reaches
  a model** under its own name, under a mapped one, or as an entry in a short
  list of deliberate omissions. It found two cases on its first run, which is the
  argument for having it: `executablePath`, reported as `enginePath` (same fact,
  the name the report renders), and `processId`, which reached `PermissionReport`
  and was dropped one layer up — a half-carry nothing would have noticed. Both
  decisions now live in that list in `smoke.mjs` rather than in this paragraph,
  and a backend that grows a field fails the check until someone decides what it
  means.
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

## Installing into another machine's application

The manifest now describes what that takes, which it did not before. Three things
have to be true on the new machine, and two of them used to be impossible to
satisfy from the published metadata alone:

1. **The package has to come from a path, not a registry.** `@deepseek-ai/dsh-plugin-cua`
   is not published (the registry answers 404 for it), and the application's plugin
   manager resolves a local install by *absolute path* (`install-spec.ts` refuses a
   relative one). Clone this repository on that machine and point Add-plugin at
   `packages/dsh-plugin-cua`.
2. **The engine has to be built there.** `lib/bin/**` is in `files` now, so a
   packed tarball carries the engine the plugin looks for — but a checkout carries
   sources, so a fresh machine needs `pnpm install && pnpm run build` once, with
   the Swift toolchain on macOS or the .NET 9 SDK on Windows. Both platforms'
   sources ship for that reason: the Windows project was previously absent from
   `files` altogether, while the Swift sources were present, so a Windows user
   unpacking the package could not have built an engine at all.
3. **Its peers have to resolve.** The bundle imports `@deepseek-ai/dsh-tools` and
   `@deepseek-ai/schemastery` at runtime, and the manifest used to declare all
   three of its dependencies as peers on `^0.1.5-rc.1` — a version line that
   **no host has ever had**: the app ships cordis 4.0.2, `dsh-tools` 0.1.6-alpha.2
   and schemastery 3.18.2, and semver refuses `0.1.6-alpha.2` against
   `^0.1.5-rc.1` (a prerelease only satisfies a range when a comparator with the
   *same* major.minor.patch carries one). The plugin only worked on this machine
   because `node_modules/@deepseek-ai/{cordis,dsh-tools}` are hand-made `link:`
   entries into a sibling harness checkout; the plugin manager does no peer
   handling of its own, so on a clean machine nothing would have supplied them and
   the import would have failed before `apply()` ran. The manifest now says what
   the ecosystem actually is: `schemastery` is a **dependency** on the 3.18 line
   (as the harness's own published plugins declare it), `cordis` a peer on `^4.0.2`,
   and `dsh-tools` a peer on the union of the lines in use —
   `^0.1.5-rc.1 || ^0.1.6-alpha.2 || ^0.1.7-alpha.1` — because no single caret range
   spans prerelease tuples, which is a property of semver rather than of this
   package.

The `schemastery` range stops below 3.18.4 on purpose. 3.18.4 tightened
`.default()`'s typing — its result is marked required and the meta type widens to
`T | Volatile<T>` — which the `z<Config>` annotation in `src/config.ts` does not
satisfy under `exactOptionalPropertyTypes`; `pnpm run typecheck` fails against it,
and that failure is a stage of this repository's green. The difference is
type-only, so a host that provides 3.18.4 at runtime still loads this bundle; the
range names the line the source compiles against and that the shipping hosts carry.

## How to work in this repository

```sh
make build          # the native engine for this platform + the bundled plugin
make check          # every suite that applies here: see below
make smoke-writes   # adds real pointer, key, and background-app assertions
```

`make` prefers the harness's own Node and pnpm under
`$DSH_HOME/dsh-runtimes/dsh-primary-runtime`, which is the toolchain the plugin is
loaded by — but that runtime is installed on demand and is absent on a fresh
machine, and MSYS resolves `$(HOME)` to `/home/<user>` rather than to the Windows
profile, so the targets now fall back to `node` and `pnpm` from `PATH` instead of
failing on a path that was never there. `pnpm run check`, `pnpm run typecheck`,
`pnpm run smoke` and friends are the portable spellings; they are what the README
lists.

That fallback had a bug of its own until the macOS round: `export PATH :=
$(if $(DSH_NODE_BIN),$(DSH_NODE_BIN):,$(PATH))` expands only the branch `$(if)`
selects, so when the runtime *was* present the else-branch never expanded and
`PATH` became the node bin directory alone. `make build` then could not find
`xcrun` and blamed the Swift toolchain. The prefix is now built inside the `$(if)`
and `$(PATH)` appended outside it, so the system PATH survives on both paths.

`pnpm run check` runs every stage that applies to the host. macOS runs six;
Windows runs four — the Swift unit tests and the capture-wedge deadline both
exercise macOS-only behaviour — and the summary says which:
`all 4 stages passed (2 skipped on this platform)`. On the Windows machine that is
`check-schemas` 49/49, `check-mcp-catalog` 128/128, and `smoke` 68/68. On macOS it
is the same two schema stages plus 34 Swift tests, 5 capture-deadline checks and
`smoke` **62/62** — the difference is that `make check` leaves `DSH_CUA_CAPTURE`
unset, so the capture assertions skip rather than run. Set it when the script is
already inside the host's process tree and macOS reports **78/78**, or **89/89**
with `--write`. (Those three macOS counts were re-measured after the projection
work added four checks to the status section; the Windows 68 will move the same
way whenever it is next measured there.)

The engine is usable without the harness, which is how it gets debugged. Note
the path: the handoff previously printed `lib/bin/cua-engine`, which is wrong —
it lives under the package, and on Windows it is the directory
`lib/bin/cua-engine/` holding `cua-engine.exe`.

```sh
cd packages/dsh-plugin-cua
lib/bin/cua-engine --probe
lib/bin/cua-engine --call tree.dump --params '{"app":"Finder","maxDepth":4}'
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | lib/bin/cua-engine --mcp
```

The last three lines are the `--mcp` envelope and are platform-neutral; the
`--call tree.dump` example names Finder, which on Windows would be
`--params '{"app":"explorer"}'` (or any running application).

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
