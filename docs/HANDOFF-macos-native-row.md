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

Measured, not inferred:

| Claim | Evidence |
|---|---|
| The Swift engine builds and runs | `lib/bin/cua-engine --probe` → engine 0.2.0, backend `macos-ax` |
| The engine's logic is unit-tested | `swift test` through `scripts/test-swift.mjs`: 27 tests over coordinate conversion, region clipping, display overlap, application ranking, pointer buttons, catalog consistency |
| A wedged capture cannot hang the engine | `check-capture-deadline.mjs`: the simulated wedge fires the watchdog at 12 s and the engine exits 75 |
| The twelve tools work through the MCP row | every tool called from a live macOS session (see `HANDOFF.md` §1) |
| The row composes and registers | `smoke.mjs`, in-process, with the real bundle |

Not verified, and the actual subject of this document:

| Claim | Why it is open |
|---|---|
| The native row's tool **results** on macOS | never seen from a model session |
| The write gate's refusal wording, as a model receives it | same |
| A screenshot's image delivery through the harness's attachment store | same; on Windows the path is read back with `read_image`, on macOS nobody has |
| `ctx.computerUse` claimed by a live macOS host | `smoke.mjs` asserts the slot claim in-process; the live host has never been checked |
| `cua_status`'s macOS branch | the `elevated` line added for Windows must **not** appear on macOS |

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

Expected counts: types clean, `check-schemas` 46/46, `check-mcp-catalog` 128/128,
`smoke` 68/68. The two macOS-only stages are the Swift unit tests and the capture
deadline; the other four are the ones Windows also runs.

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
```

Expect `documents: 1` and an `insertedRows` entry with `id: cua`. Keep a backup of
both files you touch before touching them:

```sh
cp "$profile/cordis.patch.yml" "$profile/cordis.patch.yml.bak-cua-$(date +%Y%m%d-%H%M%S)"
cp "$profile/package.json"     "$profile/package.json.bak-cua-$(date +%Y%m%d-%H%M%S)"
```

### Then install

The application's Plugins page is the supported path when it offers one. By hand,
the three things that have to be true are:

1. `$profile/package.json` lists the dependency:
   `"@deepseek-ai/dsh-plugin-cua": "link:/abs/path/to/dsh-cua/packages/dsh-plugin-cua"`.
2. `$profile/node_modules/@deepseek-ai/dsh-plugin-cua` resolves to that package
   directory — a **symlink** on macOS (a junction on Windows).
3. `$profile/cordis.patch.yml` holds one insert document with the `cua` row. The
   package also ships its own `cordis.patch.yml`; the profile's file is the one
   that matters.

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
