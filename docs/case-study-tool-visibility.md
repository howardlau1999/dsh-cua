# Case study: the tools were there the whole time

A record of diagnosing "the plugin's tools never reach the model" in the DeepSeek
Harness desktop application. Kept because the root cause was mundane, the path to
it was not, and most of the time went into four wrong conclusions that this
document exists to prevent.

Read this if you are adding tools to a harness profile and they do not appear.

## The symptom

The package loaded, the engine ran, and no `cua_*` tool could be called. Three
different integration attempts all looked identical:

| Attempt | Registration result | Reached the model |
|---|---|---|
| Native plugin row in the profile patch | reported present in `ctx.tools.schemas()` | no |
| MCP client row in the profile patch | engine started, handshake completed | no |
| Both rows via an installed bundle | engine started, registry stable at `cua=12` | no |

Every attempt produced evidence that it had worked, and every attempt failed the
same way. That pattern — consistent success signals with consistent failure —
is what made this expensive: each attempt looked like a new mystery rather than
the same one.

## The root cause

**The tools were registered when the host booted. The session being tested was
created before that boot and restored afterwards, so it never picked them up.**

Confirmed by the decisive test: in one running host, a session that predated the
boot could not call the tools while a session created after it could. Same
process, same registry, same host, different sessions.

This is not specific to this package. Anything mounted at the **profile** or
**bundle** layer registers at boot, and a restored session does not see it.

**First thing to try when tools appear to be missing: open a new session.**

## The same symptom, a second cause

A new session does not always fix it, and there is one other failure that looks
identical: **the row was installed into a profile the host does not boot.**

`~/.dsh/profiles/` holds several profiles and the desktop application boots
exactly one of them — on the machine this was last diagnosed on, `desktop`, while
the `cua` row sat in `web`, which only the CLI opens. That row was loaded by
nothing that ever served a session from the application, so no number of new
sessions could have surfaced the tools. It was found by reading the profile
directory out of the running host process's own command line — it follows the
packaged dsh directory there — rather than from the file that had been edited.

Two details make this trap easy to fall into. Every profile under that directory
is a real, valid, loadable profile, so an install into the wrong one succeeds
completely. And `dsh --profile desktop …` — including `plugin --profile desktop`
— is refused by the launcher on every platform, so the obvious tool for asking
"what is this profile running?" is unavailable exactly when the question matters.

**Checklist item for this cause: the row and the package must be in the profile
the running host boots, which is read from the host process, not from memory.**

## Two real defects found on the way

The investigation was not wasted — it surfaced two genuine problems, one of
which would have blocked every install path.

### A package with no `dsh.bundle` cannot be installed

The plugin manager's own validation refuses a package that declares no
composition layer. `dsh.bundle.patch` in `package.json` is what makes a directory
installable as a plugin. Without it, the manager rejects the package before any
of its code is reached — and the failure reads as "this plugin does not work"
rather than "this package is not installable".

A bundle is also how its rows reach the composition without depending on how the
profile resolves bare module names: the loader applies the patch directly.

### Two integration paths produced two identical catalogs

Carrying both the native plugin row and the MCP row put twenty-four tools in
front of the model — twelve `cua_*` and twelve `mcp__cua__*` doing the same
things. Both worked. A model choosing between two identical catalogs is worse
than a model with one.

## Four wrong conclusions, and what each teaches

These cost most of the time. They are listed in the order they were made.

### 1. Treating the observer's own tool list as a proxy for the target system

The assistant's available tool list was used as the test for "did the tools
register". They are different things:

- the **agent's catalog** is what a plugin writes into and what a model request reads;
- the **assistant's own list** is a separate projection.

A tool can be in the first and absent from the second. Every "still not working"
in the log above meant only "the assistant could not call it", which was never
evidence about registration.

**Lesson: read the target system's own state. `ctx.tools.schemas(agent)` is the
scoped query the request assembly performs, and it is the only reading that
answers the question.**

### 2. Announcing a fix before verifying it

"The bare package name is the root cause; an absolute path is the fix." Stated
confidently, restarted, still broken. The absolute path *was* required — a
packaged harness resolves bare names against its own installation, which cannot
see a profile's `node_modules` — but that was established later and separately,
not by the confident announcement.

**Lesson: a hypothesis is not a finding. Say which one you have.**

### 3. Inferring a mechanism from a count instead of reading it

"MCP tools are not in the unscoped view" was derived from `count=28 cua=12` —
arithmetic on a number that had another explanation. Reading the source later
showed the MCP client registers through `ctx.root`, which contradicts the
inference.

**Lesson: a count that fits your theory also fits others. Read the code or
measure the thing directly.**

### 4. Mistaking an epistemic gap for a deliverable

Asked to extract the shipped preset, the answer given was "I could not find it".
That is an honest report of a failed step, not a completed one, and the
difference matters when someone is waiting on it.

**Lesson: say "I did not do this" plainly.**

## Diagnostics that worked

Kept because they generalise, and because the last one is what finally settled
it.

**A boot log written at module scope, not from `apply`.** A Cordis plugin's
`apply` runs only after every injected service exists, so a plugin that never
applies looks exactly like a plugin that never imported. Writing from module
scope separates the two.

```ts
// module scope — runs when the module is evaluated, before any service gate
const BOOT_LOG = process.env.DSH_CUA_BOOT_LOG ?? `${tmpdir()}/dsh-cua-boot.log`
function bootLog(stage: string, detail = ''): void {
  try { appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${stage} ${detail}\n`) } catch {}
}
bootLog('module-evaluated', `execPath=${process.execPath}`)
```

A file log is the only observability available when the host captures its own
stdout — an Electron host's stdout is a socket, and the system log carries only
sandbox noise.

**Reading the scoped registry from inside the plugin.** This is the one that
answered the question:

```ts
import type {} from '@deepseek-ai/dsh-agent'   // augments Context with `agents`

// Cordis refuses to read a service a plugin has not injected, so the injection
// is required for the probe even though nothing else in the plugin needs it.
export const inject = ['tools', 'systemPrompt', 'agents']

const agents = ctx.agents.list()          // AgentRegistry.list(): Agent[]
const scoped = ctx.tools.schemas(agents[0])
```

`AgentRegistry.list()` is the whole discovery API needed here: it returns live
agents, and `schemas(agent)` accepts one as the scope.

It reported the live session's catalog — and once it did, the shape of the
answer was obvious: the tool count was far higher than the assistant's own list,
so the tools had been there all along.

**`loadOverlayPatches` for validating a patch layer.** A YAML file that parses is
not a patch the loader will accept. The harness's own loader is the only thing
whose agreement means anything, and it is callable directly — the package ships
that call as a script, so the habit costs nothing to follow:

```
node packages/dsh-plugin-cua/scripts/validate-patch.mjs <path/to/cordis.patch.yml>
```

```js
const { loadOverlayPatches } = await import('.../app-boot/lib/index.js')
const patches = loadOverlayPatches('dsh', '/path/to/cordis.patch.yml')
```

It reports the document count and the rows the patch contributes, and exits
non-zero with the loader's own message when the file is not one patch document.

A string check for the plugin name is not a validation. That mistake was made
once too: a patch file containing two YAML documents passed a
`text.includes('...')` check and failed the real parser, which reset the user's
profile configuration.

## Checklist for the next person

1. **Open a new session.** If the tools appear, the session was older than the
   host boot and nothing is wrong.
2. **If they do not, check the profile.** Read the profile directory out of the
   running host's command line and confirm the row and the package are there. A
   correct install into a profile the host does not boot fails exactly like a
   broken install.
3. **Check the package declares `dsh.bundle`** — without it the plugin manager
   refuses to install it, before any code runs.
4. **Confirm exactly one integration path.** Two working rows means two
   identical catalogs.
5. **Read `ctx.tools.schemas(agent)`, not your own tool list.**
6. **Validate patches with `loadOverlayPatches`, not with string matching.**
7. **Restart after installing.** Rows are applied at boot.

## What this package settled on

One row, and it is the **native plugin row**: twelve tools named `cua_*`, with
the engine resolved from inside the package.

The MCP client over the engine's `--mcp` mode was the first choice and still
works — it is documented in the README's manual wiring — but a row that reaches
the engine directly has to name a path, and no single path is right for both
platforms: the Windows engine is a directory ending in `cua-engine.exe`, the
macOS engine is the single file `cua-engine`. That row also carried an absolute
path belonging to one machine, which is wrong on every other one. The plugin row
needs only the package name and finds its own engine either way, and it is the
only one of the two on which `writeApproval` and the `ctx.computerUse`
registration take effect.
