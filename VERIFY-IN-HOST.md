# Verifying the plugin inside the harness host

## Which profile the desktop application boots

`~/.dsh/profiles/` holds one directory per profile, and the Electron application
boots exactly one of them. On this machine it is **`desktop`**, not `web`;
`web` is the CLI profile. Installing the plugin into the wrong one produces a
plugin that loads perfectly, registers all eleven tools, and is never reached —
and because the failure is "the tools do not exist", it looks identical to a
plugin that failed to load.

Read the answer off the running host rather than guessing:

```sh
ps -o command= -p "$(pgrep -f 'MacOS/DeepSeek Harness$' | head -1)"
lsof -p "$(pgrep -f 'MacOS/DeepSeek Harness$' | head -1)" | grep profiles
```

The profile directory is both the process's working directory and an explicit
argument to `dsh-desktop-host`. `dsh --profile desktop --dump-config` refuses to
run — that profile is owned by the Electron application — so the check is
`lsof`, not the CLI.


Everything in the package is verified against the engine launched from a shell.
What is **not** verified is the plugin running inside the application that loads
it, because that is the only configuration where macOS attributes the
Accessibility and Screen Recording grants to the host application rather than to
the terminal.

The grant rule this rests on was measured: copying the engine to a file name that
has never been granted anything still reports the grant as present. Attribution
follows the **responsible process**, not the executable, so rebuilding the engine
cannot lose the permission and the entry to enable in System Settings is the host
application — not `cua-engine`, and not the terminal.

## Step 0 — what driving the engine from the host already proved

Run from a shell derived from the harness host, through the plugin's own
`EngineClient` and the real `enginePath` from `cordis.patch.yml`:

- permissions inherited from the host: Accessibility **true**, Screen Recording
  **true**, `ready` true. The attribution rule holds in practice: the host
  application's grants reach the engine it spawns.
- `display.list` 3 displays, desktop `[-1168,-1080,3840,2062]`.
- `window.list`, `tree.dump`, and `capture.screenshot` all answered correctly,
  and `region x scale` reproduced the returned pixel size.

What that does **not** prove is that the plugin is loaded into a live session:
the tools exist only if Cordis registered them at boot. A tool call is the only
way to confirm it, which is Step 1.

## Step 1 — the engine starts at all

```
cua_status
```

Expect a report naming the engine version, the backend `macos-ax`, and both
permissions. The failure this catches is a plugin that never loaded or an engine
that never spawned, both of which look like "the tools do not exist".

- If `ready` is false, the hint names the host application and its pid. Enable
  that application in System Settings → Privacy & Security → Accessibility and
  Screen Recording, then quit and relaunch it: macOS reads the grant only at
  process start.
- If `cua_status` itself is unknown, the plugin did not load. Check that
  `~/.dsh/profiles/web/cordis.patch.yml` still contains the `cua` entry and that
  `dsh --profile web --dump-config` lists it.

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

Typing is the case that needs the element named: `cua_type` with `element` focuses
that field and delivers keystrokes to its process, whereas `cua_type` without an
element reaches only the frontmost application and a background one drops it
silently.

## Step 4 — the write gate behaves as configured

The profile sets `writeApproval: never`, so writes must proceed without asking.
If the intent is to confirm the gate instead, set it to `always`, relaunch, and
check that a write is refused when the session cannot prompt.

## Known-untested beyond this

- `cua_click` with `route: "pid"` reaching a background window (keyboard is
  verified; synthetic clicks depend on the application and are not guaranteed).
- `cua_app` `openURL` and `reveal`.
- `cua_app` `quit` with `force` against an unresponsive application.
- JPEG capture format.
- The engine's idle shutdown and respawn after a long idle period.
