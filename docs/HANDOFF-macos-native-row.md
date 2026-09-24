# Handoff: verify the native plugin row on macOS

**The one thing this document exists for.** Everything else about macOS is
verified. The native plugin row's *participation* in a model session is not, and
it cannot be rehearsed on Windows: the row's registration path is asserted by
`smoke.mjs`, but its **tool results** — the text projection, the screenshot's
image delivery, the write gate's refusal wording, the `ctx.computerUse` claim,
and the status report's macOS branch — have only ever been seen from a session on
the Windows machine.

Read this before trusting the native row on macOS, and report back the filled-in
tables at the end. Everything here is either measured or explicitly marked as
inferred; do not let the two mix.

- Project state: [`HANDOFF.md`](HANDOFF.md)
- Machine-local Windows record, including the same exercise that produced this
  document's checklist: [`HANDOFF-desktop-profile.md`](HANDOFF-desktop-profile.md)
- Why the tools look missing when they are not:
  [`case-study-tool-visibility.md`](case-study-tool-visibility.md)

## Why this row and not the other one

The package ships one integration path: the **native plugin row**, twelve tools
named `cua_*`. The MCP row (`cua-engine --mcp` through `dsh-mcp-client`) still
works and is the README's manual-wiring alternative, but it is not what
`cordis.patch.yml` inserts, and it is not what a user gets.

The two paths are not interchangeable in what they carry:

| | Native plugin row | MCP row |
|---|---|---|
| The plugin's `apply()` runs | yes | no — `dsh-mcp-client` is its sibling row, not its loader |
| `writeApproval` gate | enforced | absent; the OS grants are the only gate |
| `ctx.computerUse` provider slot | claimed as `cua` | not claimed |
| Tool results reach the model as | the plugin's projection and prose | the engine's own MCP text |
| Verified on macOS from a model session | **no — this document** | yes |

So a macOS session on the **MCP** row proves nothing about this one. Everything
below is about the native row.

## What is already verified on macOS

Measured, not inferred. The rows marked **this round** were added by the run
recorded at the end of this document; the rest were already here.

| Claim | Evidence |
|---|---|
| The Swift engine builds and runs | `lib/bin/cua-engine --probe` → engine **0.1.0**, backend `macos-ax`, `accessibility`/`screenRecording` true, `ready` true |
| The engine's logic is unit-tested | `swift test` through `scripts/test-swift.mjs`: **34** tests in 7 suites over coordinate conversion, region clipping, display overlap, application ranking, **application listing**, pointer buttons, catalog consistency |
| A wedged capture cannot hang the engine | `check-capture-deadline.mjs`: the simulated wedge fires the watchdog at 12 s and the engine exits 75 |
| The twelve tools work through the MCP row | every tool called from a live macOS session (see `HANDOFF.md` §1) |
| The row composes and registers | `smoke.mjs`, in-process, with the real bundle |
| **The whole suite is green on macOS — this round** | `make check` → `all 6 stages passed`: 34 Swift tests, 46/46 schemas, 128/128 MCP catalog, 5/5 capture deadline, smoke **58/58** |
| **The capture path works, not just the read paths — this round** | With `DSH_CUA_CAPTURE=1`, because the harness's own shell is inside the host's process tree: smoke **74/74**, including captures of displays 1–3, a region spanning two displays, clipping, and `region.x + px/scale` reproducing the captured pixel size |
| **Real input and background operation — this round** | `smoke.mjs --write` with capture on: **85/85**, including `cua_click` moving the pointer, key aliases resolving, `cua_element`/`cua_type` writing into a **background** application, and the focus assertion holding |
| **The packaged composer boots this profile onto the native row — this round** | A throwaway profile built from the real `desktop` files, composed by the **packaged** dsh 0.1.6-alpha.2 via `--dump-config`: one `# == @deepseek-ai/dsh-plugin-cua` layer, `- id: cua`, `name: '@deepseek-ai/dsh-plugin-cua'`, and no `dsh-mcp-client` row anywhere |

The gap this document exists to close. Read the last column before starting: most
of it is answered now, and §9 says how.

| Claim | Why it was open | Now |
|---|---|---|
| The native row's tool **results** on macOS | never seen from a model session | **closed — §9** |
| The write gate's refusal wording, as a model receives it | same | **closed — §9** |
| A screenshot's image delivery through the harness's attachment store | same; on Windows the path is read back with `read_image`, on macOS nobody had | **closed — §9** |
| `ctx.computerUse` claimed by a live macOS host | `smoke.mjs` asserts the slot claim in-process; the live host has never been checked | **not exercisable here** — see below |
| `cua_status`'s macOS branch | the `elevated` line added for Windows must **not** appear on macOS | **closed — §9** |

**All but `ctx.computerUse` were closed the same day by a headless model session on
the native row; §9 has the evidence.** The rows keep their original wording so the
gap being described is still readable.

`ctx.computerUse` is not a thing a restart can settle on this machine: the service
lives in the harness's own `packages/computer-use/computer-use`, and **none of the
three profiles here — `desktop`, `web`, `headless` — bundles it**. `--dump-config`
over each reports zero `computerUse` rows, so the branch a live load actually takes
is the plugin's graceful *absence* path (`ctx.get('computerUse')` rather than an
injected dependency), which is exactly what `smoke.mjs` asserts first. The claim
branch is asserted in-process against a stub. Exercising a real claim needs a
composition that mounts the service — a bundle edit, not a restart.

Nothing above needed a fresh install or an edit beyond the three defects the round
found. The tree is green, the profile is installed in the bundle style, and the
packaged composer has been made to produce the row.

## 0. Prerequisites

- macOS with the **Swift toolchain**: `xcode-select --install`. `swift test`
  resolves the Swift Testing macro plugin from the active toolchain directory,
  and that directory differs between a Command Line Tools install and a full
  Xcode install — `scripts/test-swift.mjs` handles both, so use it rather than
  calling `swift test` yourself.
- Node and pnpm on `PATH`. `make` prefers the harness's own runtime under
  `$DSH_HOME/dsh-runtimes/dsh-primary-runtime` and falls back to `PATH`; the
  fallback is the normal case on a fresh machine.
- A clone of this repository, and a checkout of the harness if you want the
  linked dev dependencies `packages/dsh-plugin-cua/node_modules` points at.

## 1. Local verification — no permissions needed

```sh
cd packages/dsh-plugin-cua
pnpm install
pnpm run build          # the Swift engine, then the plugin bundle
pnpm run check
```

On macOS this runs **six** stages; the summary line says so:

```
all 6 stages passed
```

Expected counts, measured on macOS 26.6.2 / Swift 6.4 with the Command Line Tools:
types clean, **34** Swift tests in 7 suites, `check-schemas` 46/46,
`check-mcp-catalog` 128/128, `check-capture-deadline` 5/5, and `smoke` **58/58**.
The two macOS-only stages are the Swift unit tests and the capture deadline; the
other four are the ones Windows also runs.

The smoke count is the one number that differs from the Windows machine, and the
reason is worth knowing: `make check` does not set `DSH_CUA_CAPTURE`, so the
capture assertions skip. Set it when the script is already inside the host's
process tree and the same suite runs **74/74**; add `--write` for the pointer,
key, and background-app assertions and it is **85/85**.

**The capture deadline stage needs no screen-recording grant** — it drives the
simulated wedge through `CUA_ENGINE_SIMULATE_WEDGED_CAPTURE`, not a real capture.

### Two things that are *not* failures

**Capture from a CLI-spawned engine does not return.** macOS attributes the
Screen Recording grant to the process *responsible* for the engine — the
application that loaded the plugin — so an engine started from a terminal has no
capture attribution, and its first ScreenCaptureKit call does not error: it stops
answering. This is why `lib/bin/cua-engine --call capture.screenshot` cannot be
used to check capture by hand. Trees, windows, and app lists are unaffected.
Confirm the hang rather than assume it:

```sh
timeout 15 ./lib/bin/cua-engine --call capture.screenshot; echo "exit=$?"
```

An `exit=124` is the documented wedge, not a bug in your setup. **This limitation
is macOS-only**: the Windows backend captures through GDI, so a terminal-spawned
engine there captures fine.

**`smoke.mjs` skips its capture assertions** unless `DSH_CUA_CAPTURE=1` says the
script is already running inside the host. A skip is not a pass; in particular it
means the capture checks have *not* run when you see them skipped.

## 2. Install into the profile the application actually boots

**Do not assume the profile directory.** Every directory under
`~/.dsh/profiles/` is a valid, loadable profile, and an install into the wrong
one succeeds completely and is never reached. On the Windows machine the
application boots `desktop`; a macOS investigation earlier in this project found
the row sitting in `web` while the app booted something else. Read the answer off
the running process:

```sh
host_pid=$(lsof -nP -iTCP:19387 -sTCP:LISTEN -t)
ps -o command= -p "$host_pid"
```

The profile directory is the positional argument on the `dsh-desktop-host`
command line, after the packaged dsh directory. Then:

```sh
profile=$(ps -o command= -p "$host_pid" | tr ' ' '\n' | grep '/profiles/')
echo "$profile"
test -f "$profile/cordis.patch.yml" && echo "profile found"
```

`dsh --profile desktop …` and `dsh plugin --profile desktop …` are refused by the
launcher when `desktop` is the application's own profile, so the CLI cannot tell
you this. The process can.

### Validate a patch before you write it

Never check a patch with string matching — a file holding two YAML documents once
passed a `text.includes()` check and cost the user their profile configuration.

```sh
node packages/dsh-plugin-cua/scripts/validate-patch.mjs "$profile/cordis.patch.yml"
node packages/dsh-plugin-cua/scripts/validate-patch.mjs \
  packages/dsh-plugin-cua/cordis.patch.yml
```

Which of the two carries the row depends on how the plugin was installed, and the
two answers look nothing alike:

- **The bundle install — what this machine runs, and what to expect.** The profile
  lists the package in `package.json`'s `dsh.profile.bundles`, and its own
  `cordis.patch.yml` is the empty list `[]`. The row arrives from the *package's*
  patch, so it is the second command that must report `documents: 1` and an
  `insertedRows` entry with `id: cua`. The first reports `documents: 0`, which is
  correct for an empty patch and is **not** a missing row — reading it as one is
  how a working install gets "repaired" into a broken one.
- **A hand-written row.** An older install wrote the `insert` entry into the
  profile's patch itself, and then the first command is the one that must report
  the row.

Do not end up with both: two rows is the twenty-four-tool catalog the case study
already paid for.

Keep a backup of both files you touch before touching them:

```sh
cp "$profile/cordis.patch.yml" "$profile/cordis.patch.yml.bak-cua-$(date +%Y%m%d-%H%M%S)"
cp "$profile/package.json"     "$profile/package.json.bak-cua-$(date +%Y%m%d-%H%M%S)"
```

### Then install

The application's Plugins page is the supported path when it offers one. By hand,
the three things that have to be true are:

1. `$profile/package.json` lists the dependency:
   `"@deepseek-ai/dsh-plugin-cua": "link:/abs/path/to/dsh-cua/packages/dsh-plugin-cua"`,
   **and** names `@deepseek-ai/dsh-plugin-cua` in `dsh.profile.bundles` — the
   bundles list is what applies the package's patch, so a dependency without it
   installs the files and contributes no row.
2. `$profile/node_modules/@deepseek-ai/dsh-plugin-cua` resolves to that package
   directory — a **symlink** on macOS (a junction on Windows).
3. The package's own `cordis.patch.yml` holds one insert document with the `cua`
   row, and the profile's `cordis.patch.yml` does not add a second one.

Verify the link resolves to real files, not a dangling path:

```sh
ls "$profile/node_modules/@deepseek-ai/dsh-plugin-cua/lib/index.js"
ls "$profile/node_modules/@deepseek-ai/dsh-plugin-cua/lib/bin/cua-engine"
```

Then **quit the application completely** (not just the window) and relaunch it.
Rows are applied at boot and there is no evidence of hot reload for them.

## 3. Restart, then a NEW session

The tools register when the host boots. A session that existed before that boot —
and was restored afterwards — never sees them, no matter how many times you
restart. **New session first, always.** This is the entire root cause recorded in
the case study.

## 4. The decisive exercise: the twelve tools from a model session

This is the part nobody has done on macOS. Call each tool from the session and
record the result in the table.

### Before you grant anything

`cua_status` alone should be callable, and on a machine where the app has not been
granted Accessibility or Screen Recording it must report them missing **and name
the host application to enable** — it reads that name from the process's
`__CFBundleIdentifier` / `CFBundleName`. If it says only "grant Accessibility",
that naming is broken and is itself a finding.

`cua_tree`, `cua_click`, `cua_type`, `cua_key`, `cua_element` need Accessibility.
`cua_screenshot` needs Screen Recording. `cua_displays`, `cua_apps`,
`cua_windows`, `cua_app` need neither. The grants attach to the **host
application** in System Settings → Privacy & Security, and take effect only on a
fresh launch. `cua_request_permissions` raises the prompts; the user still has to
confirm.

### The exercise

| Tool | What to confirm | Result |
|---|---|---|
| `cua_status` | engine version; backend `macos-ax`; permissions as granted; the hint names the host app | |
| `cua_displays` | display list with geometry **and density**; secondary displays may sit at negative x/y | |
| `cua_apps` | running applications; `bundleId` is a real bundle id | |
| `cua_windows` | frames and window ids; `frontmost: true` narrows to the front window | |
| `cua_tree` | an indexed outline; note node count and elapsed time | |
| `cua_screenshot` | a file at `<path>`; then `read_image` on that path and confirm the image arrives | |
| `cua_click` | delivered; then `route: "pid"` against a background window — cursor must not move | |
| `cua_type` | **CJK text into a background app, read back from the app** | |
| `cua_key` | a chord, e.g. `cmd+s` | |
| `cua_element` | `list` reports actions and attributes; an index survives across calls; a stale index fails closed | |
| `cua_app` | `activate`, `launch`, `openURL`, `reveal`, `menu`, and `quit force` | |
| `cua_request_permissions` | same report as `cua_status`; on macOS it raises real prompts | |

`cua_app`'s `reveal` and `menu` are the two that were broken and are now fixed;
they are worth exercising on macOS specifically, because `menu` descends into an
`AXMenu` child that only materializes while the menu is open.

### The four things only a model session can show

**1. The status report's macOS branch.** `cua_status` gained an `elevated` field
for Windows. On macOS it must be **absent** — both from the canonical value and
from the rendered prose. If a line matching `/elevat/i` appears in a macOS status
report, the optionality is wrong and a Windows-only claim has leaked into a macOS
report. Paste the whole rendered report.

Two smaller platform differences to expect, both read off the current source
rather than remembered, and both worth confirming in the same paste:

- The macOS permission payload carries **no `platformVersion`**, so the report's
  first line renders as `... on macos  (backend macos-ax).` — with the gap where a
  version would be. That is faithful to what the engine reports, not a formatting
  bug; if a macOS report ever claims a version, something invented one.
- `sessionLocked` is true on a locked Mac, and then `ready` is false and the hint
  reads "The Mac's screen is locked. Unlock it before expecting captures, UI
  trees, or input to work." — not the Windows wording.

**2. The screenshot path, end to end.** The tool writes a file and returns the
path; the model reads it back with `read_image`. Confirm both halves, plus
`region`, `scale`, and `scaleY` — on a scaled HiDPI display those are the numbers
a click has to be computed from. Then verify the arithmetic once by hand:
`region.x + px/scale` for a feature you can identify in the image.

**3. The write gate's refusal wording.** With the shipped `cordis.patch.yml`,
`writeApproval` is `always`. In a session that cannot prompt, the gate fails
closed and the model receives, verbatim:

```
refused to run <tool>: <reason>. The operating system was not touched. If the
session cannot prompt, set writeApproval: "never" in the plugin configuration
to run writes without asking.
```

where `<reason>` is `no approval service is mounted, so this write cannot be
authorized`, `the user rejected it`, `the request was withdrawn`, or `no approver
was available to answer`. Capture which one you get. Note also what is *not*
gated: reads (`cua_status`, `cua_apps`, `cua_windows`, `cua_tree`,
`cua_screenshot`) never ask; the five write tools (`cua_click`, `cua_type`,
`cua_key`, `cua_element`, `cua_app`) always do.

**4. The computer-use slot.** If the harness's `computerUse` capability is mounted
in that session, the native row claims the provider slot as `cua` through its own
`apply()` — which is exactly the code path the MCP row never runs. Check how the
harness reports its provider, and confirm a second registration fails loudly
rather than silently coexisting.

## 5. macOS-only limitations to expect

Not defects; documented behaviour. A report that treats one as a bug costs a
round trip.

- **Capture needs the host process tree.** A terminal-spawned engine's first
  capture stops answering instead of erroring; the engine's 12 s watchdog stops
  the engine (exit 75) rather than hanging it.
- **Text entry without an `element` does nothing to a background application.**
  Type into a background app through `cua_element` instead.
- **`route: "post"` reaches only the frontmost application.** `route: "pid"` is
  the one that works in the background, and only for applications that accept
  synthetic events.
- **A region spanning two displays is captured from the larger overlap**, not
  stitched, and reports `clipped`.
- **Element indices last only as long as the engine session.** A stale index fails
  closed instead of addressing whatever now occupies it.
- **A tree is always truncated by a budget and says which** (`node_limit`,
  `visit_limit`, `depth`, `time_budget`).
- **A locked screen makes capture and trees unreliable**; it is reported as `the
  screen is locked`.
- **`cua_screenshot`'s `app` field is absent on macOS.** The Windows engine
  reports which application the image is of; the macOS engine does not yet, so the
  field is optional. If you want it, that is engine work, not plugin work.

## 6. Rollback

```sh
profile=<the profile you found in step 2>
rm "$profile/node_modules/@deepseek-ai/dsh-plugin-cua"      # the symlink only
cp "$profile/cordis.patch.yml.bak-cua-<stamp>" "$profile/cordis.patch.yml"
cp "$profile/package.json.bak-cua-<stamp>"     "$profile/package.json"
```

Relaunch. With the row gone the tools are gone, and the application boots as it
did before the install — the fallback if the row is ever rejected at boot.

## 7. What to report back

Fill in and send:

1. `uname -a`, the macOS version, and `swift --version`.
2. The output of `pnpm run check`, including the stage summary line.
3. The profile directory you found, and the command you used to find it.
4. The `cua_status` **rendered** text, verbatim, on macOS.
5. The filled-in table from §4, with the failures verbatim if any.
6. Which of the four items in "only a model session can show" you completed, and
   what each produced.

If a tool fails, the two things that discriminate between the known causes are
`cua_status`'s report and whether a **new** session sees the tool. Send those two
and skip the investigation — those are the two causes the case study spent the
most time on.

## 8. The run of 2026-09-24 — answers to §7, items 1–3

Recorded so the next reader starts from measurements rather than from this
document's expectations. **§4 — the model-session exercise — was not reached**;
items 4–6 are still open, and §3's restart is the only thing between the tree and
them.

**Environment (item 1).** `Darwin howard-mbp-ds.local 25.6.0 arm64`, macOS
**26.6.2** (build 25G83), Swift **6.4** (swiftlang-6.4.0.34.1) from the Command
Line Tools at `/Library/Developer/CommandLineTools` — no full Xcode, which is the
configuration §0 warns about and `scripts/test-swift.mjs` exists for. It works.

**Suite (item 2).** `make check` → `all 6 stages passed`, with the counts recorded
in the table above: 34 Swift tests in 7 suites, `check-schemas` 46/46,
`check-mcp-catalog` 128/128, `check-capture-deadline` 5/5, `smoke` 58/58; then
74/74 and 85/85 with capture and writes enabled.

**Profile (item 3).** `~/.dsh/profiles/desktop`, read off the running host's argv
rather than assumed:

```sh
host_pid=$(lsof -nP -iTCP:19387 -sTCP:LISTEN -t)   # 39374
ps -o command= -p "$host_pid" | tr ' ' '\n' | grep '/profiles/'
# → /Users/hh.liu/.dsh/profiles/desktop
```

The install there is the **bundle** style: `package.json` lists the package in
both `dependencies` and `dsh.profile.bundles`, `node_modules/@deepseek-ai/dsh-plugin-cua`
is a symlink to this checkout, and the profile's own `cordis.patch.yml` is `[]`.
See §2 for why that empty file is correct and must not be "fixed".

### Two defects this round found and fixed

1. **`make` replaced `PATH` instead of prepending to it.** `Makefile` had
   `export PATH := $(if $(DSH_NODE_BIN),$(DSH_NODE_BIN):,$(PATH))`. GNU make
   expands only the branch `$(if)` selects, so on any machine where the harness
   runtime exists — the normal case — the else-branch holding `$(PATH)` was never
   expanded and `PATH` became the node bin directory alone. `make build` then
   could not find `xcrun`, and failed with *"the Swift toolchain is required to
   build the engine"* on a machine where `swift --version` works. Measured, both
   ways:

   | Form | Result with the runtime present |
   |---|---|
   | `$(if $(DSH_NODE_BIN),$(DSH_NODE_BIN):,$(PATH))` | `/…/node/bin:` — the system PATH is gone |
   | `$(if $(DSH_NODE_BIN),$(DSH_NODE_BIN):)$(PATH)` | `/…/node/bin:/usr/bin:/bin:…` |

   The prefix is now computed inside the `$(if)` and `$(PATH)` is appended
   outside it, so both the runtime-present and the fallback case keep the system
   PATH. `pnpm run build` was unaffected, which is why the failure looked like a
   missing toolchain rather than a broken variable.

2. **`cua_apps` listed one row per process, not per application.** The contract
   is one row per application — the Windows backend says so in its own `note`
   ("several processes that share an executable image … are reported as the one
   application they are"), and its source says the macOS backend already
   de-duplicates by bundle id. It did not. The listing read:

   ```
   FAIL cua_apps reports each application once by id — 20 duplicate id(s)
   ```

   with `com.apple.WebKit.WebContent` listed eleven times (once per content
   process), `com.apple.WebKit.GPU` four times, `com.tencent.flue.helper.renderer`
   four times. `listApps` built a `seen` set in its running branch and only ever
   consulted it in the installed branch, so the fold the code intended never
   happened. The running branch now folds by bundle id — a process with no bundle
   id still stands alone — keeps the pid of the process best placed to be acted on
   (active, else one owning a window, else merely visible, else hidden), and
   reports `active`/`hidden` for the application rather than for that one process.
   Measured on the live desktop: **76 rows before, 56 after, 0 duplicate ids,
   0 duplicate pids**, frontmost still reported. Seven unit tests cover the fold,
   which is why the Swift suite reads 34 rather than 27.

### Documentation this round corrected

Both were claims the documents made about themselves, and both were wrong in the
same way — an expectation carried across from the Windows machine:

- **The engine version.** This document's "already verified" table claimed
  `--probe` reports engine **0.2.0** on macOS. It reports **0.1.0**. The two
  backends carry independent versions by design, which
  [`engine-contract.md`](../packages/dsh-plugin-cua/docs/engine-contract.md) has
  said all along (`0.1.0` macOS, `0.2.0` Windows); `VERIFY-IN-HOST.md` said
  "(engine 0.2.0)" for both. Both now say which version belongs to which backend.
  Nothing in the plugin branches on the number.
- **`validate-patch.mjs` expectations in §2**, which assumed the profile's patch
  carries the row. Under the bundle install it is `[]` and reports
  `documents: 0`; the row lives in the *package's* patch. §2 now gives both
  commands and says which answer is correct for which install style.

### What is left

One restart and one new session: §3, then §4. The packaged composer has already
been made to produce this row from these profile files, so the boot itself is
rehearsed — what is untested is what the twelve tools *return* to a model, which
is the reason this document exists.

**Superseded the same day — §4 was then run, and §9 records it.** The paragraph
above was true when written and is left standing only so the sequence is clear;
read §9 for what the model session actually returned.

## 9. The model session, run — §4 is closed for items 1–3

The decisive exercise was performed without restarting the application, by
booting a **headless** session on the native row: a throwaway profile whose
bundles are the packaged `dsh-headless` app plus `@deepseek-ai/dsh-plugin-cua`,
composed by the packaged dsh 0.1.6-alpha.2. That is a genuine model session —
the twelve tools registered by the plugin's own `apply()`, results projected by
the same harness code the GUI uses — and it runs from the host application's
process tree, so Screen Recording attribution applies.

The twelve tools the session saw, all unprefixed, with **no** `mcp__cua__*`
anywhere: `cua_app, cua_apps, cua_click, cua_displays, cua_element, cua_key,
cua_request_permissions, cua_screenshot, cua_status, cua_tree, cua_type,
cua_windows`.

The profile it ran on was a throwaway copy of the shipped `headless` profile:
`@deepseek-ai/dsh-plugin-cua` added to both `dependencies` and
`dsh.profile.bundles`, the package symlinked into its `node_modules`, and its own
`cordis.patch.yml` left as `[]` so the row comes from the package. It was deleted
after the run and nothing references it — recreate it the same way to repeat the
exercise, then:

```sh
dsh --profile <the copy> "<the §4 checklist, as one task>"
```

The name does not matter, and a one-shot run needs no `DSH_CUA_CAPTURE`: the
session starts from the host application's process tree, so Screen Recording
attribution already applies and `cua_screenshot` works as it did above.

| # | Item | Result |
|---|---|---|
| 1 | `cua_status`'s macOS branch | **Closed.** Rendered verbatim below. No `/elevat/i` anywhere in any output — checked with `grep -i` across every capture — so the Windows-only field correctly does not leak. The `... on macos  (backend macos-ax)` gap where a version would sit is present exactly as predicted |
| 2 | The screenshot path, end to end | **Closed.** `cua_screenshot` wrote a PNG and `read_image` returned the image; it was admitted to the attachment store at `~/.dsh/attachments/v1/objects/94/9415…` as a 1568×882 webp. `scale` 1.037037037037037 and **`scaleY` 0.9293993677555321 differ**, which is the scaled-HiDPI case the arithmetic exists for |
| 3 | The write gate's refusal wording | **Closed.** All five write tools refused, with reason **`the user rejected it`** — see below |
| 4 | `ctx.computerUse` claimed by a live host | **Not exercisable on this machine.** No profile here mounts the `computerUse` service, this throwaway one included, so there was no slot to claim. See below |

`cua_status`, verbatim:

```
Computer Use engine 0.1.0 on macos  (backend macos-ax).
Accessibility: granted. Screen Recording: granted. Screen: unlocked.
Engine binary: /Users/hh.liu/code/cua/packages/dsh-plugin-cua/lib/bin/cua-engine

All permissions are granted and the screen is unlocked.

Available with the current permissions: cua_displays, cua_apps, cua_windows, cua_app (launch, openURL, reveal, quit, hide, script), cua_tree, cua_click, cua_type, cua_key, cua_element, cua_screenshot.
```

The refusals, verbatim, one per write tool:

```
Error: refused to run cua_click: the user rejected it. The operating system was not touched. If the session cannot prompt, set writeApproval: "never" in the plugin configuration to run writes without asking.
Error: refused to run cua_type: the user rejected it. The operating system was not touched. If the session cannot prompt, set writeApproval: "never" in the plugin configuration to run writes without asking.
Error: refused to run cua_key: the user rejected it. The operating system was not touched. If the session cannot prompt, set writeApproval: "never" in the plugin configuration to run writes without asking.
Error: refused to run cua_app: the user rejected it. The operating system was not touched. If the session cannot prompt, set writeApproval: "never" in the plugin configuration to run writes without asking.
```

The reason is **`the user rejected it`**, not the `no approval service is mounted`
this document predicted for a session that cannot prompt. Worth knowing before
someone reads a rejection as a broken gate: this session *had* an approval
service, so the gate reached it and got a "no" back.

**What produced that "no" is not what this section first said, and the
correction is measured.** The original claim was that the service "answered no
because there was nobody to ask" — but no answerer was reached at all. That run's
own session log
(`~/.dsh/sessions/--Users-hh.liu-code-cua--/session-17a7a47b-…/session.v4.jsonl.zstd`,
11:27–11:29: four `approval/asked` events — `cua_click` at (100, 100),
`cua_type` `"测试"`, `cua_key` escape, `cua_app` Finder — and four
`approval/decided` events, every one `"outcome":"rejected"`) also carries the
pair that explains them:

```
permission/preset {"preset":"danger-full-access"}
approval/policy   {"policy":"never"}
```

`ApprovalService.decide()` short-circuits a session whose approval policy is
`never` **before** dispatching to any answerer, and returns `'rejected'`
deterministically (the harness's `packages/interaction/user-approval/src/index.ts`).
Nobody was asked, no prompt was raised, and the plugin rendered the wording above
verbatim. The policy is this machine's deployed default — `~/.dsh/settings.yaml`
named `permission.defaultPreset: danger-full-access`, and the base bundle's
preset table pairs that preset with `approval: never` — and every session here
was seeded with it, §10's GUI session included. So the wording above was never
evidence about who could be asked.

The discriminator is therefore **approval policy**, not GUI-versus-headless.
Under `ask` the request dispatches to the composed answerers, and a refusal there
is the user's (`the user rejected it`), a withdrawal (`the request was
withdrawn`), or nobody reachable (`no approver was available to answer`). Until
someone re-runs this exercise under an `ask` policy, the wording identifies
neither.

### The defect the session found

`cua_request_permissions` reported an identity it did not have:

```
Computer Use engine unknown on macos  (backend unknown).
```

against `cua_status`, in the same session, naming `0.1.0` and `macos-ax`. The
cause is a division the contract had already written down: `engine.request_permissions`
returns the **permissions object**, and `engine` and `backend` are produced by
`engine.status` alone — §8.1 of
[`engine-contract.md`](../packages/dsh-plugin-cua/docs/engine-contract.md) says
exactly this of `platformVersion`, and the same is true of the other two. The
tool projected its own payload, so its description's promise — *"Returns the same
report as cua_status, re-read after the request"* — was false for the three
fields a model is most likely to quote back to a user.

It now raises the prompts with `engine.request_permissions` and then re-reads
`engine.status`, which is what its description always claimed. The smoke suite
compared only the permission booleans, `ready`, and `missing` — all present in
the flat payload — so nothing caught it; it now also asserts that the two tools
agree on engine version and backend, and the suite is **58/58** where it was
57/57.

### What is still open

Item 4, and only item 4 — and it is not a restart away. The service is provided by
the harness's own `packages/computer-use/computer-use`, and `--dump-config` over
`desktop`, `web` and `headless` reports **zero** `computerUse` rows in every one,
so the running GUI host does not mount it either and the branch a live load takes
is the absence path. Confirming a real claim needs a profile that bundles the
service — a composition change, not a restart. Items 1–3 are closed regardless.

## 10. The GUI session, run — §3 satisfied, §4 items 1 and 2 closed (2026-09-24)

§8 measured everything around the exercise and left one restart between it and
§4. That restart happened, and this is §4 run from the host the row actually
ships in: the GUI desktop application, not §9's headless session. §3's
requirement is met by measurement rather than assumption — the process listening
on 19387 (`pid 44195`) started at **11:36:31**, and the session that called the
tools was created at **11:36:34**, three seconds after the boot that registered
the row. The host's own argv names `/Users/hh.liu/.dsh/profiles/desktop`.

| Tool | What to confirm | Result |
|---|---|---|
| `cua_status` | engine version; backend `macos-ax`; permissions as granted; no `/elevat/i` | **Pass.** Byte-for-byte §9's report, quoted there. `/elevat/i` over the rendered text: **0** matches, so the Windows-only field does not leak, and the `on macos  (backend macos-ax)` gap is present exactly as predicted |
| `cua_displays` | display list with geometry **and density**; negative coordinates | **Pass.** `3 display(s)`, desktop bounding box `[-1168,-1080,3840,2062]` — the same box the earlier records give. Display 1 (main) `0…1512 × 0…982`; displays 2 and 3 sit above it at `y -1080…0` |
| `cua_tree` | an indexed outline; node count and elapsed time | **Pass.** 9 nodes in **18 ms** from the frontmost application (Ghostty), 15 visited; the result names no budget, so nothing was cut |
| `cua_element` | `list` reports actions and attributes | **Pass.** `Available actions: (none).` plus 20 readable attributes. Worth recording: `list` is deliberately **ungated** — inspection changes nothing, so it never asks |
| `cua_click` | delivered | **Refused in this session** — correctly, because its approval policy was `never`. See §9, and the positive run below |
| the remaining eight | | not re-run this round; §9 covers them and nothing here changes them |

The catalog, as the session held it: the twelve `cua_*` tools and **no**
`mcp__cua__*` anywhere. Exactly one row, too — the profile's own patch validated
to `documents: 0` and the package's to `documents: 1` with a single `cua` row,
which is the bundle install §2 describes and why the first number is correct
rather than alarming. (The only MCP row on this machine belongs to a *Blender*
client in the `web` profile, which the host does not boot.)

### The write gate, answered — §4's item 3 has both halves now

The refusal above is the negative half. The positive half came from the session
opened after the relaunch (`session-5271d134`, policy `ask`): `cua_click` asked,
and the approval was granted. Its log, verbatim:

```
approval/asked   {"toolName":"cua_click","callId":"call_00_KBmVaNO9fSRykK1YUgQp3953",
                  "reason":"Computer Use wants to move at (756, 491) on your desktop."}
approval/decided {"outcome":"allowed-once"}
```

So the gate is confirmed in both directions, and the difference between them is
one thing: the session's approval policy. GUI and headless behaved identically
under `never` (§9); under `ask` the same tool reaches the user and proceeds on
`allowed-once`.

### Full access with prompts: settings cannot carry it, the composition can

The GUI host mounts the approval service, and the browser client composes a real
prompt UI (`packages/client/ui-approval`, wired into the web bundle), so the gate
*can* prompt here. In this session it did not, because the session was seeded —
see §9's two log events — with `danger-full-access`, whose `approval` is `never`:
the ask resolves `rejected` before any answerer is dispatched, and the model
receives §9's wording again.

To make the prompt reachable while keeping full file access, the first attempt
put a fourth preset in `~/.dsh/settings.yaml` — sandbox `danger-full-access`,
approval `ask`, `defaultPreset` pointing at it, and the three built-ins restated
because a user section replaces the whole key. **It did not take effect, and the
restart meant to exercise it is what proved it did not.**

After the application was quit and relaunched (`pid 46698`, boot 11:48:18), a new
GUI session (`session-5271d134`, created 11:49:25) seeded — verbatim from its log:

```
permission/preset {"preset":"workspace-write"}
sandbox/mode      {"mode":"workspace-write"}
approval/policy   {"policy":"ask"}
```

`full-access-ask` appears nowhere in it. The reason is a division the settings
layer draws explicitly: it carries **volatile** fields only — `volatileForm`
selects "fields whose nearest volatile ancestor makes them editable without
remounting", and `isVolatilePath` rejects every other path (harness
`packages/settings/settings/src/schema.ts`). In this plugin's config
`defaultPreset` is `z.string().volatile()` and `presets` is not, so a preset
table cannot be shipped as a setting; and once the section was no longer
resolvable, the `defaultPreset` beside it stopped being applied too, which is why
the new session fell back to a derived default instead of the configured one.

Two things follow, and the second is the one that matters:

- **The preset table is composition, not settings.** Adding a preset means an
  id-targeted override of the `permission` row in the profile's patch layer — the
  same layer the harness's own configuration editor writes non-volatile config
  into (`packages/boot/config-editor`). That edit was **not** made this round: it
  changes the boot composition, so it wants `validate-patch.mjs` and a
  throwaway-profile rehearsal first.
- **The prompt became reachable anyway.** The new session above carries
  `approval/policy: ask`, which is what the base bundle's own
  `process.env.DSH_PERMISSION_MODE ?? 'workspace-write'` expression yields when
  that variable is unset — so a write tool called in *that* session dispatches to
  the composed answerers instead of being short-circuited. Why the earlier
  sessions, §9's included, sat on `danger-full-access` while this one does not is
  **not settled**: either that variable was in the old host's environment, or the
  `defaultPreset` line was being applied until this round's edit made its section
  unresolvable. Both fit every measurement taken here.

`~/.dsh/settings.yaml` was restored byte-for-byte from
`~/.dsh/settings.yaml.bak-cua-20260924-114208` once this was measured, so the
file carries no trace of the attempt.

The composition route was then taken. `~/.dsh/profiles/desktop/cordis.patch.yml`
now carries a `- id: permission` override whose `presets` restates the three
built-ins and adds `full-access-ask` (sandbox `danger-full-access`, approval
`ask`), with `defaultPreset: full-access-ask` beside them. Backups:
`cordis.patch.yml.bak-cua-20260924-121427`, and the matching `package.json` one.
`validate-patch.mjs` accepts the file through the loader's own parser —
`documents: 1`, `patchEntries: 1`, `overrides: [{ "id": "permission" }]` — and the
package's patch still reports its single `cua` row, so the catalog stays twelve
tools rather than twenty-four.

The composition itself was then measured, on a throwaway copy of the profile, with
the harness's own `--dump-config`:

```
# == @deepseek-ai/dsh-base, patched by …/zz-perm-check/cordis.patch.yml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    defaultPreset: full-access-ask
    presets:          # all four, abbreviated here
      read-only / workspace-write / danger-full-access / full-access-ask
```

so the table composes as intended. The application's next boot nevertheless seeded
`danger-full-access` again (`session-cf104eab`, created 13:04:49 after a relaunch
at 13:04:45) — which settles the question the first attempt left open: **a
composed `defaultPreset` loses to the settings document.** `defaultPreset` is
volatile, and `settings.yaml` really does carry volatile fields — that is how
`agent-default-model` selects this machine's model — so the document's value is
what `config.defaultPreset.get()` returns. The **preset table belongs to the
composition; the default choice belongs to `settings.yaml`**, and the first attempt
had both in the wrong layer.

With the table composed, `~/.dsh/settings.yaml` was then flipped to
`defaultPreset: full-access-ask` — the one line that was the document's to own all
along. **And the live application then resolved that name**, which is the proof
the patch is composed in the running host rather than only under `--dump-config`:
`/permission full-access-ask` in the GUI session appended

```
permission/preset {"preset":"full-access-ask"}
approval/policy   {"policy":"ask"}
```

with no new `sandbox/mode` event, because that knob was already
`danger-full-access` and only changed knobs are written. So the very session that
had every write refused at 11:36 now holds full file access *and* real prompts —
the configuration this section was chasing, on the layer that can actually carry
it. What remains unmeasured is only that a **new** session seeds it from
`defaultPreset` rather than from this live switch; it is the same mechanism that
seeded `danger-full-access` before. Rollback is the two profile backups plus
restoring that line, and a relaunch.

### The write gate's own knob: `session`, and proof that a patch edit reaches a running host

The same profile patch then gained a second override, for the Computer Use row
itself:

```yaml
- id: cua
  config:
    writeApproval: session
    idleShutdownMs: 600000
    allowedScript: false
```

`session` asks **once per write tool per session** and stops asking for that tool
afterwards, where `always` — the value the package ships — prompts on every single
write. The other value is `never`, which asks nothing at all and leaves the macOS
grants as the only gate. Like the preset table, `writeApproval` is not a volatile
field, so it belongs to this layer and not to `~/.dsh/settings.yaml`; the override
restates `idleShutdownMs` and `allowedScript` with the package's own values so it
is complete whether the loader merges the config or replaces it. `validate-patch.mjs`
accepts both entries (`patchEntries: 2`, overrides for `permission` and `cua`), and
`--dump-config` shows the composed row carrying `writeApproval: session` — with the
package's patch still the only thing inserting the row, so the catalog stays twelve
tools.

Two things were then measured in the live GUI session, and the second is the one
worth keeping:

- The first `cua_click` logged `approval/asked` + `approval/decided
  {"outcome":"allowed-once"}` — the per-session grant — and the call proceeded.
- A second `cua_click` immediately after moved the pointer with **no
  `approval/asked` event at all**, which is `session` behaving exactly as its own
  doc comment says *and* proves a config-only patch edit reaches an already-running
  host: **no relaunch was needed.** §2's "rows are applied at boot" is about
  inserted rows; an id-targeted override of an existing row hot-reloads.

So this machine now runs full file access *with* prompts, asking at most five times
per session — once per write tool (`cua_click`, `cua_type`, `cua_key`,
`cua_element`, `cua_app`) — and never for a read.

Item 4 (`ctx.computerUse`) remains unexercisable here for the reason §9 gives, and
it is the only item left open.

## Related

- [`HANDOFF.md`](HANDOFF.md) — project state, test suites, open items.
- [`HANDOFF-desktop-profile.md`](HANDOFF-desktop-profile.md) — the Windows record
  of the same exercise (Chinese; machine-local).
- [`../VERIFY-IN-HOST.md`](../VERIFY-IN-HOST.md) — verifying inside the host
  application, Windows and macOS.
- [`case-study-tool-visibility.md`](case-study-tool-visibility.md) — why a new
  session is the first thing to try, and the four wrong conclusions to skip.
- [`../packages/dsh-plugin-cua/docs/engine-contract.md`](../packages/dsh-plugin-cua/docs/engine-contract.md)
  — the protocol both backends implement.
