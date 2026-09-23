# Verifying the plugin inside the harness host

## Which profile the desktop application boots

`~/.dsh/profiles/` holds one directory per profile, and the Electron application
boots exactly one of them. On this machine it is **`desktop`**, not `web`;
`web` is the CLI profile. Installing the plugin into the wrong one produces a
plugin that loads perfectly, registers all twelve tools, and is never reached —
and because the failure is "the tools do not exist", it looks identical to a
plugin that failed to load.

Read the answer off the running host rather than guessing. The profile directory
is an explicit argument to the host process, so the argv of the process that
serves the session is the answer:

Windows (PowerShell) — ask who owns the session's port, then read its argv:

```powershell
$hostPid = Get-NetTCPConnection -LocalPort 19387 -State Listen | Select-Object -ExpandProperty OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=$hostPid" | Select-Object -ExpandProperty CommandLine
```

The profile directory is the argument after the dsh runtime directory on the
`dsh-desktop-host` command line — `process.argv[3]` to that process, since
Electron's own `--expose-internals` flag never reaches argv. Verified on this
machine: the listener on 19387 is that host, its argv reads

```
…\dsh-desktop-host\lib\index.js <packaged dsh dir> C:\Users\howar\.dsh\profiles\desktop <…>
```

and the profile it boots is therefore `~/.dsh/profiles/desktop`.

macOS:

```sh
ps -o command= -p "$(pgrep -f 'MacOS/DeepSeek Harness$' | head -1)"
lsof -p "$(pgrep -f 'MacOS/DeepSeek Harness$' | head -1)" | grep profiles
```

`dsh --profile desktop …` refuses to run on **both** platforms — the launcher
rejects the name `desktop` outright, whatever the host is doing
(`profile "desktop" is managed exclusively by the Electron application`) — so the
check is the process's own argv (or `lsof` on macOS), never the CLI. That also
means `dsh plugin --profile desktop add …` cannot install into it; the
application's own plugin page, or a hand-made link, is the only way in.


Everything in the package is verified against the engine launched from a shell.
What is **not** verified by that route is the plugin running inside the
application that loads it, because the host is the only configuration where the
plugin is reached the way a model reaches it.

On macOS the difference is sharper still: that is the only configuration where
macOS attributes the Accessibility and Screen Recording grants to the host
application rather than to the terminal.

The grant rule this rests on was measured: copying the engine to a file name that
has never been granted anything still reports the grant as present. Attribution
follows the **responsible process**, not the executable, so rebuilding the engine
cannot lose the permission and the entry to enable in System Settings is the host
application — not `cua-engine`, and not the terminal.

## Step 0 — what driving the engine from the host already proved

Run from a shell derived from the harness host, through the plugin's own
`EngineClient` and the real `enginePath` from `cordis.patch.yml`:

- macOS: permissions inherited from the host — Accessibility **true**, Screen
  Recording **true**, `ready` true. The attribution rule holds in practice: the
  host application's grants reach the engine it spawns. On Windows there is
  nothing to inherit: `cua-engine.exe --probe` reports `accessibility: true`,
  `screenRecording: true`, `ready: true`, `elevated: false` from any shell,
  because Windows does not gate those capabilities behind a permission.
- macOS: `display.list` 3 displays, desktop `[-1168,-1080,3840,2062]`.
- `window.list`, `tree.dump`, and `capture.screenshot` all answered correctly,
  and `region x scale` reproduced the returned pixel size.

What that does **not** prove is that the plugin is loaded into a live session:
the tools exist only if Cordis registered them at boot. A tool call is the only
way to confirm it, which is Step 1.

## Step 1 — the engine starts at all

```
cua_status
```

Expect a report naming the engine version and this platform's backend —
`macos-ax` on macOS, `windows-uia` on Windows (engine 0.2.0) — and its
permissions. The failure this catches is a plugin that never loaded or an engine
that never spawned, both of which look like "the tools do not exist".

- macOS, if `ready` is false: the hint names the host application and its pid.
  Enable that application in System Settings → Privacy & Security →
  Accessibility and Screen Recording, then quit and relaunch it: macOS reads the
  grant only at process start.
- If `cua_status` itself is unknown, the plugin did not load. Check the profile
  the running host actually boots (see the first section — on this machine,
  `~/.dsh/profiles/desktop`), not the profile you happen to have edited. For a
  profile the CLI may open, `dsh --profile <name> --dump-config` lists the rows;
  for `desktop` it refuses, so read
  `~/.dsh/profiles/desktop/cordis.patch.yml` and the profile's `node_modules`
  directly. An installed row that does not resolve is the other half of this
  failure, and the boot log is where it says so.
- On Windows, `ready` is only false while the session is locked; there is no
  grant to enable and nothing to relaunch for.

## Step 2 — reads work under the host's grants

```
cua_displays      # layout and pixel density
cua_windows       # window ids and screen rectangles
cua_tree          # accessibility tree of the frontmost application
cua_screenshot    # capture, then read the returned path with read_image
```

`cua_screenshot` with no arguments captures the main display; the result's
`region` and `scale` must reproduce the returned pixel size.

## Step 3 — background operation, the guarantee that is easiest to lose

The property under test is that operating an application the user is not looking
at neither requires it to be frontmost nor steals focus.

1. `cua_apps` to find an application that is not frontmost.
2. `cua_tree` for that application, and find the index of a text field.
3. `cua_element` with `setValue` into that field.
4. `cua_tree` again and confirm the value changed, and that the frontmost
   application is unchanged.

Typing is the case that needs the element named, and what that buys differs by
platform: on macOS `cua_type` with `element` delivers keystrokes to that
element's process, so a background application is typed into without being
raised. On Windows there is no per-process key delivery — `element` focuses the
element's window first and the engine fails the call if the focus did not
actually move — and `cua_type` without an element reaches only the frontmost
application, dropping the text silently in a background one. On Windows, plan on
`cua_element` `setValue` for background writes.

## Step 4 — the write gate behaves as configured

The profile sets `writeApproval: never`, so writes must proceed without asking.
If the intent is to confirm the gate instead, set it to `always`, relaunch, and
check that a write is refused when the session cannot prompt.

## Known-untested beyond this

Reading the list below matters as much as the steps above: every entry is a place
where "it worked" has not been observed, and the two platforms do not share the
list.

macOS:

- `cua_click` with `route: "pid"` reaching a background window (keyboard is
  verified there; synthetic clicks depend on the application).
- `cua_app` `openURL` and `reveal`.
- `cua_app` `quit` with `force` against an unresponsive application.
- The engine's idle shutdown and respawn after a long idle period.

Windows has nothing on that list: `route: "pid"` clicks, `reveal`, `menu`,
`openURL`, `quit force`, and JPEG capture were all measured on the Windows
backend, and the smoke test calls every tool against the real engine.

Both:

- **The `desktop` profile after an application restart** — *done, on Windows.*
  The row was verified to compose and register all twelve tools under the packaged
  runtime (0.1.6-alpha.2) in a throwaway home, the plugin was verified end to end
  against the real engine by `scripts/smoke.mjs` (68 checks), and the live
  Electron host has since booted the row and served all twelve `cua_*` tools to a
  session created after that boot. What the restart is still needed for is
  anything the host loaded *before* a fix: the plugin bundle is read once at boot,
  so a rebuilt `lib/index.js` reaches a session only after a restart. Treat
  "restart, then a fresh session" as the standing procedure after any change to
  the plugin, the patch row, or the profile — see
  [`docs/HANDOFF-desktop-profile.md`](docs/HANDOFF-desktop-profile.md), which
  carries the Windows record and the re-check list.
