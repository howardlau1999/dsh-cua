# Handoff

State of the Computer Use plugin as of commit `267d32b`, and what is left. Read
[`docs/case-study-tool-visibility.md`](docs/case-study-tool-visibility.md) first
for why the integration looks the way it does.

## Where things stand

Working and verified: the Swift engine, the MCP server over it, the bundle, and
the install path. The twelve tools reach a model as `mcp__cua__<name>` in a
session created after the host booted.

Verified by direct measurement, not inference:

| Claim | How it was checked |
|---|---|
| Tools reach a model | Called from a session created after the host boot |
| Engine permissions inherited | `accessibility=true screenRecording=true ready=true` from inside the host process tree |
| Accessibility tree | 492 nodes in 94 ms on a full browser window |
| Unicode text input | Typed CJK into TextEdit and read it back from the app |
| Background operation | `cua_element` wrote to a non-frontmost app; focus unchanged |
| Multi-display density | Calibrated per display: 1.270 on a scaled HiDPI screen, 1.000 on 2× screens |
| Region clipping | A rectangle spanning two displays clips to the larger overlap and reports `clipped` |
| Off-desktop rejection | A point outside every display is refused with the desktop bounds |
| Locked screen | Reported as `the screen is locked`, not a ScreenCaptureKit error |

Test suites: `make check` (types, tool schemas, end-to-end smoke against the real
engine) and `make smoke-writes` (adds pointer movement, key delivery, and
background read/write with a focus assertion). Both green.

## 1. Exercise the tools through the model, in a session

**Nothing has ever called these tools the way a session does.** Every check so
far ran the engine directly or drove the plugin's client from a shell. The tool
result path — text projection, error surfacing, the timeout in between — is
unproven.

In a new session, ask for each of these and record what comes back:

- `cua_status` — the twelve tools' baseline. Does it report both permissions granted?
- `cua_displays` — three displays, desktop `[-1168,-1080,3840,2062]`.
- `cua_tree` on a complex application — **watch the latency**. The MCP row sets
  `toolCallTimeoutMs: 120000` while the engine's own walk budget defaults to 8 s;
  a slow tree is the most likely timeout.
- `cua_screenshot`, then read the returned path. The tool writes the file and
  returns its path because an MCP result is projected to text — confirm the image
  actually arrives through the reader.
- `cua_click` and `cua_type` — writes. Whether they are gated depends on the
  install: the MCP row does **not** carry the plugin's own `writeApproval`, only
  the native row does. Decide whether that is acceptable.

Something to settle while doing this: with the MCP row there is no plugin-level
write gate, so the macOS grant is the only one. The native row has
`writeApproval`. If the gate matters, either accept the duplicate catalogs and
remove one deliberately, or find a way to gate at the MCP layer.

## 2. Reconcile with `ctx.computerUse`

The harness already owns a computer-use capability this package does not
participate in:

```
packages/computer-use/computer-use/                    ctx.computerUse, exclusive provider registration
packages/experimental/computer-use-cua-driver-mcp/     a Cua Driver provider over MCP
packages/experimental/computer-use-cua-driver-native/  a Cua Driver provider over a native SDK
docs/subsystems/computer-use.md
```

Its contract is narrow: a provider registers a name and supplies an upstream tool
catalog. Both existing providers adapt that catalog with
`createMcpToolDefinition`, which is the same shape this engine's MCP server
produces.

So the aligned form is probably an MCP provider that also calls
`ctx.computerUse.register(ComputerUseProviderName('cua'))`, giving this engine
what the built-in Cua Driver providers have: a Plugins-page row, exclusive
registration, and consistent diagnostics.

The obstacle is the one that consumed the original investigation: a native plugin
row could not be reached, and the reason is now known — the row worked, the
session was older than the boot. **Retry the native row in a new session before
concluding anything.**

## 3. Test coverage and CI

- `scripts/check-schemas.mjs` validates the tool definitions through the
  harness's own validator, but only the **TypeScript** tools. The twelve tools a
  model actually sees are the ones `McpServer.swift` declares, and nothing
  asserts those. A typo in a tool schema there would be invisible until a model
  called it.
- There are no unit tests. Candidate targets, in order of value: the `Tree`
  filter and budget logic, the capture region clipping, `Pointer`'s coordinate
  conversion, and `MacHost`'s application resolution ranking (which once matched
  a Dock helper instead of the application).
- No CI. The engine tests need macOS with Accessibility and Screen Recording, so
  a runner would only manage the pure-Swift parts; the tool-call checks belong in
  `make smoke`, which already exists and runs locally.

## 4. Engine work worth doing

- **Expose the write gate at the MCP layer.** See §1.
- **`cua_request_permissions` is untested.** It raises the macOS prompts; it has
  never been called.
- **Untested code paths**, all reachable from a model:
  `cua_click` with `route: "pid"` against a background window (keyboard with
  `route: "pid"` is verified; synthetic clicks are documented as not guaranteed);
  `cua_app`'s `openURL` and `reveal`; `cua_app quit` with `force`; JPEG capture.
- **An engine-side `screenshotDir`.** The MCP boundary writes captures to
  `~/.dsh/cua-screenshots` (overridable with `DSH_CUA_SCREENSHOT_DIR`). The native
  protocol still returns inline base64, which suits a same-process consumer but
  leaves the two integration paths reporting captures differently.
- **Windows and Linux.** `PlatformHost` in `Protocol.swift` is the seam. Nothing
  else — the protocol layer, the MCP server, and the plugin — would change. This
  is the largest remaining piece of work and the one with no local way to verify.

## Known limitations, all documented

Text entry without `element` does nothing to a background application (the engine
focuses the element first when one is named); `route: "post"` reaches only the
frontmost application; a region spanning two displays is captured from the larger
overlap rather than stitched; element indices last only as long as the engine
session; a tree is always truncated by a budget and says which; the screen being
locked makes capture and trees unreliable and is reported explicitly.

## How to work in this repository

```sh
make build          # Swift engine + bundled plugin
make check          # types, tool schemas, end-to-end smoke
make smoke-writes   # adds real pointer, key, and background-app assertions
```

The engine is usable without the harness, which is how it gets debugged:

```sh
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
