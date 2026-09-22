# cua-engine wire contract

**Target of this document:** the native *Computer Use* engine `cua-engine`, a long-lived
child process that speaks one JSON object per line in both directions over stdio.

> **Scope.** Every detail below was read out of the Swift sources, so this is the
> **macOS** backend's behaviour stated as a contract. The Windows backend
> (`native/cua-engine-win/`) implements the same envelope, the same 12 methods,
> the same response field names, and the same six error codes, but it is not a
> line-by-line port: it uses UI Automation control types instead of AX roles,
> honours `toX`/`toY` on drag, allows element index 0, and refuses a mistyped
> parameter instead of silently falling back. Each of those differences, with its
> reason, is listed in [windows-backend.md](windows-backend.md) — read that
> alongside this document before writing a client that must work on both.

| Fact | Value | Source of truth |
| --- | --- | --- |
| Engine version (`engine`) | `0.1.0` macOS, `0.2.0` Windows | `native/cua-engine/Sources/CuaEngine/Protocol.swift` (`engineVersion`), `native/cua-engine-win/src/Protocol.cs` (`EngineIdentity.Version`) |
| Protocol version (`protocol`) | `1` (JSON integer) | both backends |
| macOS backend name (`backend`) | `macos-ax` | `MacHost.swift` (`MacHost.backendName`) |
| Windows backend name (`backend`) | `windows-uia` | `WinHost.cs` (`WinHost.BackendName`) |
| Non-implemented platform backend name | `unsupported` | `main.swift` / `Program.cs` (`UnsupportedHost`) |
| Platform names | `macos`, `windows`, `linux`, `unknown` | `Engine.swift` / `PlatformHost.cs` (`PlatformInfo.Name`) |
| Method count | 12 methods | `Engine.swift` `route`/`dispatchAsync` |

The authoritative sources read to produce this document:

```
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/Engine.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/Protocol.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/MacHost.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/MacHost+Actions.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/Tree.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/Capture.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/Pointer.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/Keyboard.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/AppleEvents.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/AX.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/AXArray.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/JSONValue.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/JSONReader.swift
packages/dsh-plugin-cua/native/cua-engine/Sources/CuaEngine/main.swift
```

Consumer side (what the TypeScript plugin actually sends and reads):
`packages/dsh-plugin-cua/src/engine-client.ts`, `shared.ts`, `tools-observe.ts`,
`tools-interact.ts`, `tools-app.ts`, `config.ts`.

---

## Table of contents

1. [Transport and framing](#1-transport-and-framing)
2. [Request envelope](#2-request-envelope)
3. [Response envelope and the error object](#3-response-envelope-and-the-error-object)
4. [Error code vocabulary](#4-error-code-vocabulary)
5. [Parameter reader semantics](#5-parameter-reader-semantics)
6. [Method surface and dispatch](#6-method-surface-and-dispatch)
7. [`engine.status`](#7-enginestatus)
8. [`engine.permissions` and the permissions object](#8-enginepermissions-and-the-permissions-object)
9. [`engine.request_permissions`](#9-enginerequest_permissions)
10. [`app.list`](#10-applist)
11. [`window.list`](#11-windowlist)
12. [`display.list`](#12-displaylist)
13. [`tree.dump`](#13-treedump)
14. [`capture.screenshot`](#14-capturescreenshot)
15. [`pointer`](#15-pointer)
16. [`keyboard`](#16-keyboard)
17. [`element.action`](#17-elementaction)
18. [`app`](#18-app)
19. [Cross-cutting: target resolution](#19-cross-cutting-target-resolution)
20. [Cross-cutting: coordinate spaces and geometry](#20-cross-cutting-coordinate-spaces-and-geometry)
21. [Cross-cutting: state, caching, timeouts, retries, ordering](#21-cross-cutting-state-caching-timeouts-retries-ordering)
22. [macOS behaviour to map onto Windows](#22-macos-behaviour-to-map-onto-windows)
23. [CLI entry points](#23-cli-entry-points)
24. [Ambiguities, gaps and contradictions](#24-ambiguities-gaps-and-contradictions)
- [Appendix A: macOS AX attributes read by `tree.dump`](#appendix-a-macos-ax-attributes-read-by-treedump)
- [Appendix B: key-name table](#appendix-b-key-name-table)
- [Appendix C: verbatim message catalogue](#appendix-c-verbatim-message-catalogue)

---

## 1. Transport and framing

* The engine owns **stdout** for response lines and **stderr** for diagnostics. Nothing
  but response lines may be written to stdout.
* The engine is started with no required arguments; it inherits the host environment
  (that inheritance is what carries the OS permission grants).
* Framing is **one JSON document per line, LF terminated** (`0x0A` appended to every
  encoded response). No length prefix, no `Content-Length`, no EOF terminator per message.
* The read loop is `while let line = readLine(strippingNewline: true)`: it accepts `\n`
  and `\r\n` terminated lines and runs until stdin reaches EOF.
* **Requests are strictly serialized.** Exactly one request is processed at a time and
  each is fully awaited before the next line is read. A re-implementation must not
  interleave responses and must preserve request order (a click must not overtake the
  tree read that produced its target).
* Consequence for clients: request/response multiplexing is impossible on this pipe. The
  shipped TypeScript client serializes with a promise chain.

### 1.1 Blank and malformed lines (exact behaviour)

| Input line | Behaviour |
| --- | --- |
| Zero-length line (just the newline) | **Silently skipped.** No response is written. |
| Whitespace-only line (`"   "`) | Not empty → parsed → JSON error → `{"id":null,"error":{"code":"invalid_request",...}}`. |
| Non-JSON text | Error response with `"id":null`, code `invalid_request`, message `request is not valid JSON: <Foundation localizedDescription>`. |
| JSON that is not an object (`42`, `"x"`, `[]`, `null`) | Error with `"id":null`, code `invalid_request`, message `request must be a JSON object`. |
| Object without `id`, or with `"id":null` | Error with `"id":null`, message `request is missing "id"`. |
| Object with missing/empty/non-string `method` | Error with `"id":null`, message `request is missing a non-empty "method"`. |
| Object with an unknown `method` | Error echoing the request `id`, code `unknown_method`, message `unknown method "<method>"`. |
| Object with non-object, non-null `params` | Error echoing the request `id`, code `invalid_request`, message `<method>: params must be an object, received <typeName>`. |

The engine also exposes an internal `Engine.handle(line:)` that trims the line and answers
an empty line with `{"id":null,"error":{"code":"invalid_request","message":"empty request line"}}`.
**That path is not reachable through the stdio loop** — the loop skips empty lines before
decoding. A port must implement the loop behaviour (skip empty lines), not the
`empty request line` behaviour.

### 1.2 JSON encoding details that leak into the wire

* Object keys are serialized **sorted ascending by Unicode code point** (`JSONSerialization`
  `.sortedKeys`), so field order is deterministic: `error` before `id`, `id` before `result`,
  and inside the error object `code`, `message`, `settingsPane`.
* Forward slashes are **not** escaped (`.withoutEscapingSlashes`), so URLs and file paths
  appear literally.
* Non-ASCII is emitted as raw UTF-8 (`…`, `—`, `⏎`, `→` appear literally, not as `\uXXXX`).
* No whitespace/pretty printing is inserted.
* Integers are encoded as JSON integers; floating point as JSON numbers. JSON has no
  `2` vs `2.0` distinction on the wire — Foundation prints an integral double without a
  fractional part (`2.0` → `2`, `720.0` → `720`) and a fractional one with as many digits
  as needed (`0.8`, `1.3333333333333333`). Examples in this document therefore show
  integral doubles as integers; a client must treat every numeric field as a JSON number,
  never assume an integer type.
* If encoding ever throws, the fallback line is
  `{"error":{"code":"encoding_failed"}}` — note this object has **no `id`**. It is
  unreachable for the current result graphs but must exist as a literal fallback.
* A stdout write failure writes `cua-engine: stdout write failed: <error>` to stderr and
  the loop continues.

---

## 2. Request envelope

```json
{"id":1,"method":"engine.status","params":{}}
```

Literal shape after decoding:

```swift
struct EngineRequest { id: JSONValue; method: String; params: JSONValue? }
```

| Member | JSON type | Required | Rules |
| --- | --- | --- | --- |
| `id` | **any** JSON value except `null` (string, number, boolean, array, object) | **yes** | Present and `!= null`, else `invalid_request` + `"id":null` response. Echoed verbatim. |
| `method` | string | **yes** | Must be a non-empty string; empty string and non-string both rejected. |
| `params` | object, `null`, or absent | no | `absent` and `null` are equivalent to `{}`. Any other type → `invalid_request`. |

Decode order matters for error precedence: object check → `id` check → `method` check.
So `{"method":"tree.dump"}` (no id) reports the id error, not "unknown method".

Additional rules:

* **Unknown members of the request object are ignored** (`"jsonrpc":"2.0"`, `"timeoutMs"`,
  … are accepted and dropped).
* **Unknown members of `params` are ignored** by every method. There is no strict-schema
  rejection anywhere.
* Duplicate JSON keys resolve to the last occurrence (Foundation dictionary decode).
* The same key may carry `null`: "present and null" is distinct from "absent" for the
  `has()`/`supplies()` distinction described in §5.1.
* Request lines are not size limited by the engine. The shipped client caps nothing either;
  the practical limit is the `tree.dump` node budget and the screenshot base64 payload that
  the *response* carries.

---

## 3. Response envelope and the error object

Exactly one response line per processed request:

```json
{"id":1,"result":{"engine":"0.1.0"}}
```

```json
{"id":1,"error":{"code":"not_found","message":"no on-screen window with id 42"}}
```

```json
{"id":1,"error":{"code":"permission_denied","message":"Listing windows needs Accessibility permission. …","settingsPane":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"}}
```

| Member | Type | Presence |
| --- | --- | --- |
| `id` | any JSON value | Always present in a dispatch response; echoes the request `id` **by value** (same type, same content). JSON `null` only for requests that could not be decoded. |
| `result` | any JSON value (always an object in this engine) | Present iff the method succeeded. `result` and `error` are mutually exclusive. |
| `error` | object | Present iff the method failed. |
| `error.code` | string | Always present. One of the seven codes in §4. |
| `error.message` | string | Always present. Human-readable, actionable; often includes the method name and the offending parameter. |
| `error.settingsPane` | string | Present **only** for `permission_denied`. Value is always `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`, including for Screen Recording denials. |

Rules:

* The error object is built by merging `CuaError.details` and then setting `code` and
  `message`, so a future detail key cannot shadow `code`/`message`.
* A `result` payload is never `null` in this engine; every method returns an object.
* **A "successful" response does not imply the action worked.** `pointer`, `keyboard`,
  `element.action` and `app` report per-action outcome flags inside `result`
  (`delivered`, `performed`, `executed`, `launched`, `opened`, `revealed`, `hidden`,
  `terminated`, …). Some of them return HTTP-200-style failures with `reason` strings;
  see the per-method sections. A port must preserve both layers.

---

## 4. Error code vocabulary

| `code` | Raised when | `details` |
| --- | --- | --- |
| `invalid_request` | Not valid JSON; not a JSON object; missing/`null` `id`; missing/empty `method`; `params` of the wrong type; any parameter of the wrong type, missing when required, empty when it must not be, or outside its range; a region/crop that is incomplete, non-positive, or outside its target; an unknown action verb inside a known method; a scroll with `dx == dy == 0`; a partial `x`/`y` pair; `element: 0`; a point outside every display; a `route`/`button` value outside its enum. | — |
| `unknown_method` | The `method` is not one of the 12 supported names. | — |
| `not_found` | The named pid, window id, display id, application, window title, element index, element reference, menu bar, or snapshot does not exist; a region that overlaps no display; a window that is not shareable. | — |
| `permission_denied` | Accessibility is required but not granted (windows, tree, pointer, keyboard, element actions, activate); Screen Recording is required but not granted (screenshot). | `settingsPane` (string, always the Accessibility pane URL) |
| `operation_failed` | The target existed but refused or could not complete the operation (AX action failed, focus refused, encoding/allocation failure, locked screen during capture); **also the catch-all for any unexpected Swift error**, whose message is prefixed with `"<method>: "`. | — |
| `unsupported_platform` | The build/backend does not implement the method. Emitted by the protocol's default `PlatformHost` implementations and by `UnsupportedHost` (non-macOS builds). Messages: `<backend> cannot request permissions`, `<backend> has no display backend`, `<backend> has no pointer backend`, `<backend> has no keyboard backend`, `<backend> has no element backend`, `no application backend for <platform>`, `no window backend for <platform>`, `no accessibility backend for <platform>`, `no screen-capture backend for <platform>`. | — |

### 4.1 How a thrown value becomes a code

1. `CuaError` thrown by a host method → its own code/message directly.
2. `JSONFault` (thrown by the JSON parser or by any `ParamsReader` accessor) →
   `invalid_request` with the fault's `reason` as the message. The fault reason is
   **never prefixed** with the method again — the reader already embedded it.
3. Any other Swift `Error` escaping a method → `operation_failed` with
   `"<request.method>: <error description>"`.
4. In the stdio loop, anything thrown while *decoding* the line produces `"id":null`;
   anything thrown while *dispatching* produces the request's own `id`.

### 4.2 Failure modes that are **not** errors

These come back as `result` with a flag, and a port must not convert them into errors:

* `keyboard` with `action:"key"`: unknown key / unknown modifier / uncreatable events →
  `{"delivered":false, "reason":…}`.
* `keyboard` with `action:"insert"`: no focusable element / AXValue rejected →
  `{"inserted":false, "reason":…}`.
* `element.action` `press` / `scrollToVisible` / `menu`: refusals →
  `{"performed":false, "reason":…, …}`.
* `app` `launch` / `openURL` / `reveal` / `script`: refusals →
  `{"launched":false,"reason":…}`, `{"opened":false,"reason":…}`,
  `{"revealed":false,"reason":…}`, `{"executed":false,…}`.
* `pointer` event-construction failure → `{"delivered":false}` (plus `screenX`/`screenY`).
* `app` `menu` → always `{"requested":true,"path":[…]}` even when the menu walk failed.

---

## 5. Parameter reader semantics

Every method receives a `ParamsReader` built from the request's `params`. This reader
defines the entire validation behaviour of the engine, so it must be reproduced exactly.

### 5.1 Membership predicates

| Predicate | Meaning |
| --- | --- |
| `has(key)` | The key is present at all, **even if its value is JSON null**. Used for `pointer`'s `x`/`y` pairing and `drag`'s `fromX`/`fromY` check, `capture.screenshot`'s region detection and completeness check, element-request detection (`element`/`elementRef`), and `keyboard` `type`'s "an element was named" check. |
| `supplies(key)` | Present **and** not null. (Defined in the reader; not used by any current method.) |
| `raw(key)` | The raw value or absent. |

`element: 0`, `x: 0`, `clickCount: 0` and `dy: 0` are real requests — a port that tests
truthiness instead of key presence will silently drop them. This is called out explicitly
in the Swift source.

### 5.2 Accessor matrix

`<M>` below is the request's `method` string as received, e.g. `tree.dump`.

| Accessor | Absent | `null` | Wrong type | Out of range |
| --- | --- | --- | --- | --- |
| `string(key)` (required) | `invalid_request`: `<M>: missing required parameter "<key>"` | same | `invalid_request`: `<M>: parameter "<key>" must be a string, received <typeName>` | — |
| `nonEmptyString(key)` | as `string` | as `string` | as `string` | `invalid_request`: `<M>: parameter "<key>" must not be empty` |
| `string(key, default:)` | default | default | **default (silent)** | — |
| `optionalString(key)` | `nil` | `nil` | **`nil` (silent)** | — |
| `int(key)` (required) | missing-parameter error | missing-parameter error | `<M>: parameter "<key>" must be an integer, received <typeName>` | — |
| `int(key, default:, in:)` | default | default | `<M>: parameter "<key>" must be an integer, received <typeName>` | `<M>: parameter "<key>" must be within <lo>...<hi>, received <n>` |
| `optionalInt(key)` | `nil` | `nil` | **`nil` (silent)** | — |
| `double(key)` (required) | missing-parameter error | missing-parameter error | `<M>: parameter "<key>" must be a number, received <typeName>` | — |
| `double(key, default:, in:)` | default | default | `<M>: parameter "<key>" must be a number, received <typeName>` | `<M>: parameter "<key>" must be within <lo>...<hi>, received <n>` |
| `optionalDouble(key)` | `nil` | `nil` | **`nil` (silent)** | — |
| `bool(key, default:)` | default | default | **default (silent)** | — |
| `stringList(key)` | `[]` | `[]` | see below | — |

`stringList` accepts:

* a single string → `[thatString]`
* an array → every element must be a string, else
  `<M>: parameter "<key>" must be an array of strings, received <typeName>`
* anything else → `<M>: parameter "<key>" must be a string or an array of strings, received <typeName>`

The "silent" rows are a real part of the contract: `route: 5` on `pointer` falls back to
`post` **without error**, `interactiveOnly: "yes"` falls back to `false`, and
`timeBudgetMs: "5000"` is ignored entirely (see §13.1). A port that rejects them will
reject requests the macOS engine accepts; a port that *requires* them to be validated
would be stricter than the reference. Match the reference per-key, as tabulated in each
method section.

### 5.3 Numeric decoding

| Wire value | Internal type | `intValue` | `doubleValue` | `boolValue` | `stringValue` |
| --- | --- | --- | --- | --- | --- |
| `3` | int | 3 | 3.0 | nil | nil |
| `3.0` | **int** (integral, `abs(v) < 2^53`) | 3 | 3.0 | nil | nil |
| `3.5` | double | nil | 3.5 | nil | nil |
| `1e2` | int | 100 | 100.0 | nil | nil |
| `true` / `false` | boolean | nil | nil | value | nil |
| `"3"` | string | nil | nil | nil | `"3"` |
| `null` | null | nil | nil | nil | nil |

Notes:

* Integral JSON numbers below 2^53 are normalised to ints at parse time, so
  `maxDepth: 8.0` is accepted by an integer accessor. `maxDepth: 8.5` is **not**.
* Booleans are distinguished from numbers by CoreFoundation type id, so `true` never
  satisfies an integer accessor and `1` never satisfies a boolean accessor.
* `typeName` (used in every message) is one of: `null`, `boolean`, `number`, `string`,
  `array`, `object`. Ints and doubles are both reported as `number`, so a message such as
  `must be an integer, received number` is normal for a fractional value.
* **Hazard:** `JSONValue.intValue` converts an integral double with `Int(value)`, which
  traps for magnitudes outside `Int64` (e.g. `{"maxDepth":1e30}`). Likewise `pid_t(int)`
  traps for values outside `Int32`. A port should reject these with `invalid_request`
  rather than aborting the process; the reference implementation would crash.

### 5.4 Result construction helpers

* `jsonObject([String: JSONValue?])` **drops** nil members — optional fields are simply
  absent from the wire, never explicit `null`.
* `jsonObject([String: JSONValue])` keeps every member.
* `Optional<String|Int|Double>.jsonField` converts to a value **or an explicit JSON
  `null`** — that is the mechanism by which a handful of keys (for example
  `window.list[].windowId`, `tree.dump.windowTitle`, `capture.screenshot.displayId`) are
  *always present* but may be null. Which keys use which rule is documented per method;
  do not generalise.
* All ranges are **inclusive** (`ClosedRange`).

---

## 6. Method surface and dispatch

| Method | Dispatch path | Notes |
| --- | --- | --- |
| `engine.status` | sync | Never requires permission. |
| `engine.permissions` | sync | Never requires permission. |
| `engine.request_permissions` | sync | macOS: raises prompts, then reports status. |
| `app.list` | sync | No permission required. |
| `window.list` | sync | Requires Accessibility. |
| `tree.dump` | sync | Requires Accessibility. |
| `keyboard` | sync | Requires Accessibility. |
| `capture.screenshot` | async | Requires Screen Recording. |
| `display.list` | async | No permission precheck. |
| `pointer` | async | Requires Accessibility. |
| `element.action` | async | Requires Accessibility. |
| `app` | async | Mixed: `activate`/`focus` require Accessibility; `list`, `hide`, `unhide`, `quit`, `launch`, `openURL`, `reveal`, `script`, `menu` do not precheck. |
| anything else | — | `unknown_method` |

The split between the sync and async halves is an implementation detail, but the
consequence is observable: the sync half never touches ScreenCaptureKit, so
`display.list` and window/display resolution in `capture.screenshot` are the only paths
that can fail with a ScreenCaptureKit error.

---

## 7. `engine.status`

Identity and permission snapshot of the engine process. Never fails, requires no
permission, and never touches the accessibility tree.

**Request params:** none. Any `params` members are ignored (they are still type-checked as
an object by the reader, §5).

**Response:**

```json
{
  "id": 1,
  "result": {
    "engine": "0.1.0",
    "protocol": 1,
    "backend": "macos-ax",
    "platform": "macos",
    "platformVersion": "15.2.0",
    "processId": 48213,
    "permissions": {
      "platformSupported": true,
      "platform": "macos",
      "accessibility": true,
      "screenRecording": true,
      "ready": true,
      "missing": [],
      "sessionLocked": false,
      "processId": 48213,
      "executablePath": "/Users/me/cua/lib/bin/cua-engine",
      "hint": "All required macOS permissions are granted."
    }
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `engine` | string | Literal engine version, currently `"0.1.0"`. |
| `protocol` | integer | Literal protocol version, currently `1`. Bumped only when the wire contract changes in a way a client must notice. |
| `backend` | string | `host.backendName`. macOS: `"macos-ax"`. Non-macOS placeholder build: `"unsupported"`. |
| `platform` | string | `"macos"` \| `"windows"` \| `"linux"` \| `"unknown"`, compiled in per target. |
| `platformVersion` | string | `ProcessInfo.operatingSystemVersion` formatted as `"<major>.<minor>.<patch>"` — exactly three dot-separated decimal components, no leading zeros, e.g. `"15.2.0"`, `"10.15.7"`. Never a marketing name and never a build number. |
| `processId` | integer | The engine process's own pid (`ProcessInfo.processInfo.processIdentifier`). Not the target app's pid. |
| `permissions` | object | Exactly the object `engine.permissions` returns (§8). |

Errors: none (only the envelope-level `invalid_request` for a malformed `params`).

---

## 8. `engine.permissions` and the permissions object

**Request params:** none (same rules as `engine.status`).

**Response:** the permissions object itself — *not* wrapped in another key:

```json
{
  "id": 2,
  "result": {
    "platformSupported": true,
    "platform": "macos",
    "accessibility": true,
    "screenRecording": false,
    "ready": false,
    "missing": ["screen_recording"],
    "sessionLocked": false,
    "processId": 48213,
    "executablePath": "/Users/me/cua/lib/bin/cua-engine",
    "hint": "macOS has not granted Screen Recording to the process hosting this engine. Open System Settings → Privacy & Security → Screen Recording, add or enable the host application, then quit and relaunch it. Accessibility is required for UI trees, clicks, and typing; Screen Recording is required for screenshots."
  }
}
```

### 8.1 macOS computation, key by key

| Field | Type | Always present | Computation |
| --- | --- | --- | --- |
| `platformSupported` | boolean | yes | Literal `true` on the macOS backend. **`false`** on the non-macOS placeholder build (which returns *only* `platformSupported` and `platform`). |
| `platform` | string | yes | Literal `"macos"` on the macOS backend; `PlatformInfo.name` on the placeholder build. |
| `accessibility` | boolean | yes | `AXIsProcessTrusted()`. |
| `screenRecording` | boolean | yes | `CGPreflightScreenCaptureAccess()`. |
| `ready` | boolean | yes | `missing.isEmpty && !sessionLocked`. True means "a capture/tree/input call has every OS grant it needs and the console is unlocked". |
| `missing` | array of string | yes | `["accessibility","screen_recording"]` order: `"accessibility"` appended first when `AXIsProcessTrusted()` is false, then `"screen_recording"` when `CGPreflightScreenCaptureAccess()` is false. Never contains anything else. Empty array when both are granted. |
| `sessionLocked` | boolean | yes | See §8.2. |
| `processId` | integer | yes | Engine's own pid. |
| `executablePath` | string | yes | `Bundle.main.executablePath ?? CommandLine.arguments.first ?? ""`. Used by clients to tell the user which binary to add in System Settings. |
| `hint` | string | yes | One of three sentences, verbatim in Appendix C: the locked-screen sentence (when `sessionLocked`), the "all granted" sentence (when `missing` is empty), otherwise the long remediation sentence built from the `missing` names joined by `" and "`. |
| `platformVersion` | string | **no** | *Not* produced by the engine here, although the shipped TypeScript normaliser reads it from this object (it therefore always normalises to `""`). `platformVersion` lives in `engine.status` (§7). |

### 8.2 Locked-session detection

`sessionLocked` is true when **either**:

* `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"] == true`, or
* `CGSessionCopyCurrentDictionary()["kCGSSessionOnConsoleKey"] == false`,

and false when the session dictionary is unavailable. The hint takes priority over the
permission list: a locked screen reports the locked sentence even if permissions are also
missing. `ready` is false whenever `sessionLocked` is true.

### 8.3 Hint precedence (exact)

```
locked                                  -> "The Mac's screen is locked. Unlock it before expecting captures, UI trees, or input to work."
missing empty (and not locked)          -> "All required macOS permissions are granted."
otherwise                               -> "macOS has not granted <list> to the process hosting this engine. Open System Settings → Privacy & Security → <list>, add or enable the host application, then quit and relaunch it. Accessibility is required for UI trees, clicks, and typing; Screen Recording is required for screenshots."
```

`<list>` is `"Accessibility"`, `"Screen Recording"`, or `"Accessibility and Screen Recording"`
(the missing entries mapped to those display names, joined with a single `" and "`).
Note the literal `→` (U+2192) characters; there is no ASCII fallback.

### 8.4 Backend rule for a new platform

A Windows backend should return the **same nine keys** (with `platformSupported: true`,
`platform: "windows"`) plus whatever Windows-specific facts it needs. Returning the
minimal two-key placeholder object is what the *unbuildable* host does, and clients treat
that as "unsupported", not as "no permissions missing".

---

## 9. `engine.request_permissions`

Raises the OS prompts that lead to a grant, then reports the same object as
`engine.permissions`.

**Request params:** none.

**macOS behaviour, in order:**

1. If `AXIsProcessTrusted()` is false → `AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt: true])`.
   This shows the "…would like to control this computer using accessibility features"
   prompt; the user still has to flip the switch in System Settings.
2. If `CGPreflightScreenCaptureAccess()` is false → `CGRequestScreenCaptureAccess()`.
   On macOS 15+ this returns immediately and the system shows its own prompt.
3. `Thread.sleep(0.6)` — the response is delayed by 600 ms so a prompt has time to appear
   and the re-read reflects a fast user decision.
4. Return `permissionStatus()`.

**Response:** identical shape to §8.1 (not wrapped), i.e. `{"id":…,"result":{ …permissions… }}`.

**Errors:** none on macOS. The protocol's default implementation (any other backend that
does not override it) throws `unsupported_platform` with message
`"<backendName> cannot request permissions"`.

**Idempotence:** safe to call repeatedly; each call re-raises the prompt only for the
still-missing permission. The shipped tools call this instead of `engine.status` when the
user asks to fix permissions, with a 20 s client timeout.

---

## 10. `app.list`

Also reachable as `app` with `action:"list"` (§18).

**Request params**

| Param | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `query` | string | no | none | Read with `optionalString` → silently `nil` for a non-string. Lower-cased, then matched as a **substring** against the app's lower-cased `name` and `bundleId`. An empty string behaves like "no filter". |
| `running` | boolean | no | `true` | `bool(key, default:)` → a non-boolean value silently falls back to `true`. |
| `includeBackground` | boolean | no | `false` | `bool(key, default:)`. In the **running** branch this drops applications whose activation policy is `.prohibited` (windowless helpers). In the **installed** branch it is read but unused. |

**No Accessibility permission is required.** This method never calls `requireAccessibility`.

**Algorithm**

* `running == true` (default): iterate `NSWorkspace.shared.runningApplications` in the
  system's order; skip `.prohibited` apps unless `includeBackground`; apply the `query`
  filter; de-duplicate by `bundleId` (or `"pid:<pid>"` when `bundleId` is empty).
* `running == false`: iterate installed bundles found under
  `/Applications`, `/Applications/Utilities`, `/System/Applications`,
  `/System/Applications/Utilities`, `~/Applications` in that order, keeping `*.app`
  entries whose bundle id is readable; de-duplicate by bundle id (first root wins);
  apply the same `query` filter. Note the de-duplication set starts **empty** in this
  branch, so installed rows are never de-duplicated against running ones.
* Sort: `frontmost` rows first (`isActive == true`), then `name` ascending by
  case-insensitive localized comparison. Installed rows have no `frontmost` key, so they
  always sort after any running row. Ties keep the platform's sort order (the comparator
  is not a total order).

**Response**

```json
{
  "id": 3,
  "result": {
    "apps": [
      {
        "name": "Finder",
        "bundleId": "com.apple.finder",
        "pid": 512,
        "path": "/System/Library/CoreServices/Finder.app",
        "active": true,
        "frontmost": true,
        "hidden": false,
        "terminated": false,
        "policy": "regular",
        "launchDate": "2024-05-05T20:15:03Z"
      },
      {
        "name": "Preview",
        "bundleId": "com.apple.Preview",
        "pid": 903,
        "active": false,
        "frontmost": false,
        "hidden": false,
        "terminated": false,
        "policy": "regular"
      }
    ],
    "count": 2,
    "runningOnly": true
  }
}
```

| Field | Type | Presence |
| --- | --- | --- |
| `apps` | array of object | always |
| `count` | integer | always; `apps.length` after filtering and sorting |
| `runningOnly` | boolean | always; echoes the effective `running` value (note the name differs from the request key) |
| `apps[].name` | string | always (`""` when the platform reports no localized name) |
| `apps[].bundleId` | string | always (`""` when unknown) |
| `apps[].pid` | integer | running rows only |
| `apps[].path` | string | present only when `bundleURL` is non-nil (running) / always for installed rows |
| `apps[].active` | boolean | running rows only; `NSRunningApplication.isActive` |
| `apps[].frontmost` | boolean | running rows only; **the same value as `active`** (the same property is read twice) |
| `apps[].hidden` | boolean | running rows only; `isHidden` |
| `apps[].terminated` | boolean | running rows only; `isTerminated` |
| `apps[].policy` | string | running rows only; one of `regular`, `accessory`, `background`, `unknown` (`background` is the wire name for `.prohibited`) |
| `apps[].launchDate` | string | running rows only, and only when the platform reports a launch date; ISO-8601 with `Z`, second precision (`ISO8601DateFormatter` default) |
| `apps[].running` | boolean | **installed rows only**; literal `false`. Installed rows contain exactly `name`, `bundleId`, `path`, `running`. |

**Errors:** none beyond envelope-level `invalid_request`. A query that matches nothing
returns `{"apps":[],"count":0,"runningOnly":…}`. There is no `note` field here.

---

## 11. `window.list`

**Requires Accessibility** (`requireAccessibility("Listing windows")`) — see §19.4 for the
exact message.

**Request params**

| Param | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `pid` | integer | no | none | `optionalInt` → a non-integral value silently becomes "no pid filter". Wins over `app` when both are present. |
| `app` | string | no | none | `optionalString` (non-string silently ignored), lower-cased, substring match against app name and bundle id. |
| `frontmost` | boolean | no | `false` | `bool(key, default:)`. Only meaningful when `pid` is absent **and** `app` is absent/empty. |
| `includeUntitled` | boolean | no | `true` | `bool(key, default:)`. When false, windows whose `AXTitle` is empty (or unreadable) are dropped. |
| `includeBackground` | boolean | no | `false` | `bool(key, default:)`; forwarded to application resolution, so `"ghostty"` does not match the windowless Dock Extra helper before the app itself. |

**Algorithm**

1. Resolve target applications with the shared resolver (§19.1). `pid` → exactly that
   app or `not_found`; `frontmost && !app` → the frontmost app; `app` → the ranked
   candidate set (possibly **several** apps); otherwise the frontmost app.
2. For each target application: read `AXWindows` from its application element. If that
   list is empty, fall back to the single `AXFocusedWindow` element when present.
3. For each window: read `AXTitle`, frame (`AXPosition`+`AXSize`), `AXSubrole`,
   `AXMinimized`, `AXMain`, `AXFocused`; drop untitled windows when
   `includeUntitled == false`; try to resolve the `CGWindowID` by matching the
   accessibility frame against the window-server list (see below).
4. Sort: `main` first, then `focused` before non-focused. Ordering among equally-ranked
   rows is unspecified (the comparator is not stable).

**Window-id matching (`matchWindowID`)** — the only source of the `windowId` that
`capture.screenshot` and `tree.dump` accept:

* Query `CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)`.
* Keep entries with the same owning pid; compute
  `delta = |dx| + |dy| + |dw| + |dh|` between the AX frame and the window-server bounds.
* Accept entries with `delta <= 2`; return the **smallest** delta's window number.
* Returns nothing when no entry is close enough, which is why `windowId` can be `null`
  for a perfectly valid window (off-screen, non-shareable, animating, or owned by a
  helper process).

**Response**

```json
{
  "id": 4,
  "result": {
    "windows": [
      {
        "title": "report.md — dsh-cua",
        "app": "Code",
        "bundleId": "com.microsoft.VSCode",
        "pid": 887,
        "windowId": 4211,
        "frame": [0, 25, 1512, 900],
        "subrole": "AXStandardWindow",
        "minimized": false,
        "main": true,
        "focused": true
      },
      {
        "title": "",
        "app": "Finder",
        "bundleId": "com.apple.finder",
        "pid": 512,
        "windowId": null,
        "frame": null,
        "minimized": false,
        "main": false,
        "focused": false
      }
    ],
    "count": 2,
    "note": "Code exposes no accessibility windows right now: it may have no open window, or its windows may be closed, minimized, or owned by a helper process."
  }
}
```

| Field | Type | Presence |
| --- | --- | --- |
| `windows` | array of object | always |
| `count` | integer | always |
| `note` | string | **conditional**: present only when `windows` is empty *and* at least one target application resolved. |
| `windows[].title` | string | always (`""` when untitled/unreadable) |
| `windows[].app` | string | always; `localizedName` of the owning app |
| `windows[].bundleId` | string | always (`""` when unknown) |
| `windows[].pid` | integer | always |
| `windows[].windowId` | integer \| null | **always present**; null when the frame could not be matched to a window-server window |
| `windows[].frame` | array of 4 integers `[x,y,w,h]` | **absent** when the window exposes no readable frame (never explicit null) |
| `windows[].subrole` | string | **absent** when `AXSubrole` is empty/unreadable |
| `windows[].minimized` | boolean | always; `AXMinimized ?? false` |
| `windows[].main` | boolean | always; `AXMain ?? false` |
| `windows[].focused` | boolean | always; `AXFocused ?? false` |

Frame coordinates are rounded to integers, in top-left-origin global screen points.

`note` text (verbatim): `"<AppName> exposes no accessibility windows right now: it may have no open window, or its windows may be closed, minimized, or owned by a helper process."`
where `<AppName>` is the first target's localized name, or the literal `"The application"`
when it has none.

**Errors**

* `permission_denied` — Accessibility not granted.
* `not_found` — `pid` given but not running (`no running application with pid <pid>`);
  `app` given but nothing matches (`no running application matches "<query>"`);
  neither resolved and no frontmost app (`no frontmost application`).

---

## 12. `display.list`

**Request params:** none (any members are ignored). Note there is **no permission
precheck**: this method calls ScreenCaptureKit directly and may fail with a
ScreenCaptureKit error while Screen Recording is ungranted.

**Response**

```json
{
  "id": 5,
  "result": {
    "displays": [
      {
        "displayId": 1,
        "frame": [0, 0, 1512, 982],
        "reportedPixelWidth": 3024,
        "reportedPixelHeight": 1964,
        "reportedDensity": 2.0,
        "main": true
      },
      {
        "displayId": 3,
        "frame": [-1920, 200, 1920, 1080],
        "reportedPixelWidth": 1920,
        "reportedPixelHeight": 1080,
        "reportedDensity": 1.0,
        "main": false
      }
    ],
    "count": 2,
    "desktop": [-1920, 0, 3432, 1280],
    "coordinateSpace": "top-left origin, screen points; secondary displays may have negative x or y"
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `displays` | array of object | All displays ScreenCaptureKit reports for on-screen content, sorted by `frame.minY` ascending, then `frame.minX` ascending. |
| `displays[].displayId` | integer | `CGDirectDisplayID`. This is the value `capture.screenshot`'s `displayId` (and `result.displayId`) uses. |
| `displays[].frame` | array of 4 numbers `[x,y,w,h]` | Top-left-origin global **points**. Secondary displays may have negative coordinates. Not rounded. |
| `displays[].reportedPixelWidth` / `reportedPixelHeight` | integer | ScreenCaptureKit's reported pixel size for the display. **Informational** — do not use it as a density source. |
| `displays[].reportedDensity` | number | `reportedPixelWidth / max(frame.width, 1)`. Informational: this ratio is `1` on displays that actually capture at 2x. The trustworthy density is the per-capture `scale` (§14). |
| `displays[].main` | boolean | `displayId == CGMainDisplayID()`. Exactly one row is normally true. |
| `count` | integer | `displays.length`. |
| `desktop` | array of 4 numbers `[x,y,w,h]` | Union of every display frame. When no display is enumerable the fallback is `[0,0,1920,1080]`. |
| `coordinateSpace` | string | Literal `"top-left origin, screen points; secondary displays may have negative x or y"`. |

**Errors:** `operation_failed` with message `display.list: <error>` when ScreenCaptureKit
cannot enumerate content (permission, locked session, or a transient stream failure).

**Ordering guarantee:** the display order is deterministic for a given layout but is
**not** the system's display order and does not put the main display first; clients must
use `main`/`displayId`/`frame`, never the array index.

---

## 13. `tree.dump`

The accessibility-tree dump. This is the primary read primitive: it produces a flat array
of nodes, a rendered text outline, and the element snapshot that every later
`element`-indexed call addresses.

**Requires Accessibility** (`requireAccessibility("Reading the UI tree")`).

### 13.1 Request params

| Param | Type | Required | Default | Range / validation | Reader |
| --- | --- | --- | --- | --- | --- |
| `app` | string | no | frontmost app | Lower-cased, substring match on app name / bundle id. | `optionalString` (non-string → ignored) |
| `pid` | integer | no | none | Wins over `app`. Must be a running process, else `not_found`. | `optionalInt` (non-integral → ignored) |
| `windowId` | integer | no | none | A window-server id from `window.list`. Wins over `pid`/`app`/`frontmost`. Must be an **on-screen** window, else `not_found`. | `optionalInt` |
| `windowTitle` | string | no | none | Case-insensitive **substring** of an `AXTitle`. Only consulted when `windowId` is absent. | `optionalString` |
| `frontmost` | boolean | no | `pid == nil && app == nil` | Only consulted when no `pid`/`app`/`windowId` is given. | `bool(key, default:)` (non-boolean → default) |
| `maxDepth` | integer | no | `8` | `1…40` inclusive; out of range → `invalid_request`. Root is depth 0; structural wrappers do not consume a level. | `int(default:in:)` |
| `nodeLimit` | integer | no | `1200` | `1…20000` inclusive. Caps **emitted** nodes, not visited ones. | `int(default:in:)` |
| `textLimit` | integer | no | `200` | `0…4000` inclusive. **`0` disables every text field** (all capped strings become absent). | `int(default:in:)` |
| `roles` | string \| array of string | no | `[]` (no filter) | A single string is accepted and treated as a one-element list. Non-string elements → `invalid_request: tree.dump: parameter "roles" must be an array of strings, received <type>`. | `stringList` |
| `interactiveOnly` | boolean | no | `false` | Non-boolean silently → `false`. | `bool(key, default:)` |
| `includeStructural` | boolean | no | `false` | Non-boolean silently → `false`. | `bool(key, default:)` |
| `includeGeometry` | boolean | no | `false` | Non-boolean silently → `false`. Adds the `frame` array to each node. | `bool(key, default:)` |
| `includeMenuBar` | boolean | no | `false` | Non-boolean silently → `false`. The implementation stores the **inverse** as `skipMenuBar`. | `bool(key, default:)` |
| `timeBudgetMs` | number | no | `8000` ms | Clamped, not rejected: `seconds = min(max(ms / 1000, 0.2), 60.0)`. **A non-numeric value is silently ignored** (falls back to 8000 ms) because it is read with `optionalDouble`. | `optionalDouble` |
| `format` | string | no | `"outline"` | Accepted, echoed into the internal result, but **has no effect on the response** — `text` is always the outline, and `format` is not echoed in `options`. Non-string silently → `"outline"`. | `string(key, default:)` |

Params the engine does **not** accept (do not invent them in a port): `maxNodes`,
`filter`, `depth`, `geometry`, `all`, `appFilter`, `element`, `path`, `includeText`.
Unknown keys are ignored, so a client sending them gets a default tree rather than an error.

`visitLimit` is **not** settable: it is fixed at `40000` visited elements.

### 13.2 Root resolution

Two mutually exclusive paths, tried in this order.

**A. `windowId` present (non-null int)**

1. Look the id up in the window-server list (`CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements])`).
   Missing → `not_found: no on-screen window with id <windowId>` (note: no trailing advice
   in this message; the sibling `capture.screenshot` message adds `; list windows first`).
2. Under the owning pid, walk `AXWindows` and pick the **first** window whose frame differs
   from the window-server frame by **≤ 2 points on each of x, y, width, height**, returning
   that window element.
3. If no accessibility window matches, fall back to the **application element** itself
   (a panel, overlay, or permission mismatch must not read as "not found").
4. The reported `app` is the window-server owner name (`kCGWindowOwnerName`, may be `""`),
   **not** the localized application name.

**B. Otherwise**

1. `frontmost` defaults to `pid == nil && app == nil`.
2. Resolve applications with the shared resolver (§19.1) — `includeBackground` defaults to
   `false` here and is not read from params.
3. Use **the first** application of the ranked list (`apps[0]`), even when several are
   equally ranked.
4. Without `windowTitle` (or with an empty one) → the **application element**, depth 0,
   `windowTitle` reported as `null`.
5. With `windowTitle` → walk `AXWindows` and take the first window whose title
   `localizedCaseInsensitiveContains(windowTitle)`; report that window's actual title.
   None → `not_found: no window of <AppName> matches title "<windowTitle>"`.

The root element is created via `AXUIElementCreateApplication(pid)` with a **2.0 s**
messaging timeout, and the walk sets another 2.0 s timeout on the root.

### 13.3 Traversal algorithm (exact)

Breadth-first, single-threaded, budget-checked before each dequeue:

```
started   = now()
visited   = 0
emitted   = []            # nodes, and the index space
elements  = []            # parallel array of AXUIElement
truncatedBy = null
queue     = [ (root, depth=0, priority=0) ]
setMessagingTimeout(root, 2.0)

while queue is not empty:
    if now() - started > timeBudget:          truncatedBy = "time_budget"; break
    if visited >= 40000:                      truncatedBy = "visit_limit"; break
    (element, depth, _) = queue.removeFirst() # FIFO
    visited += 1
    setMessagingTimeout(element, 2.0)

    attrs     = readAttributes(element)        # one cross-process call, §13.5
    frame     = geometry(attrs)                # AXPosition + AXSize, §13.5
    role      = attrs["AXRole"] ?? ""
    structural = role in structuralRoles

    if includeStructural or not structural:
        if shouldEmit(attrs, role, options):   # §13.6
            emitted.append(Node(depth, element, attrs, frame))
            elements.append(element)
            if emitted.count >= nodeLimit:
                truncatedBy = "node_limit"; break

    # structural wrappers are folded: their children keep their depth
    childDepth = depth if (structural and not includeStructural) else depth + 1
    guard childDepth <= maxDepth else { continue }   # no truncation flag is set

    batch = []
    for child in children(element):                  # AXChildren
        childRole = AXRole(child) ?? ""              # one extra cross-process read per child
        if skipMenuBar and childRole == "AXMenuBar": continue
        batch.append((child, childDepth, visitPriority(childRole)))
    if batch.count > 1: sort batch by priority ascending
    queue.append(contentsOf: batch)
```

Consequences a port must reproduce:

* **Traversal order is breadth-first with a priority sort per sibling batch.** The queue is
  FIFO, and the children a node pushes are appended contiguously in `visitPriority` order.
  So the dump is *not* a global level-order walk: everything queued before a node's children
  is emitted first, which is why the emitted `depth` values can go back down (a deep subtree
  is emitted after shallower nodes that were already in the queue). A port that switches to a
  strict global level-order walk would produce a different node order *and* different indices.
* **Budgets are checked before dequeuing**, so the element that trips `time_budget` or
  `visit_limit` is *not* counted in `visitedCount`; the element that trips `node_limit`
  *is* counted (it was visited and emitted).
* **`node_limit` is checked immediately after appending**, so exactly `nodeLimit` nodes are
  emitted when it fires.
* **`maxDepth` pruning is silent.** Reaching `maxDepth` does not set `truncatedBy`
  (see §13.11).
* **Sibling order beyond priority is unspecified** — Swift's `sort` is not stable, so nodes
  with equal priority may appear in any order within their batch. A port is free to use a
  stable sort; do not write tests that depend on it.
* The `AXMenuBar` skip is a **direct-child role check** at every level, so it removes the
  whole menu-bar subtree (the bar is a child of the application element). With
  `includeMenuBar: true` the menu bar is traversed — its items sort last, so they do not
  consume the node budget ahead of content.
* `AXRow` is **both** structural and interactive. With `includeStructural: false`
  (the default) rows are folded away and never emitted, even with `interactiveOnly: true`.
  Only `includeStructural: true` can surface rows.

**Ordering constants**

`structuralRoles` (folded when `includeStructural == false`; their children inherit their
depth and are re-parented into the output):

```
AXGroup AXUnknown AXLayoutArea AXLayoutItem AXSplitGroup AXScrollArea AXList AXOutline
AXTable AXBrowser AXColumn AXRow AXGrid AXSection AXLandmarkRegion AXLandmarkGroup
```

`interactiveRoles` (drive `actionable` and `interactiveOnly`):

```
AXButton AXCheckBox AXRadioButton AXPopUpButton AXMenuButton AXMenuItem AXMenuBarItem
AXTextField AXTextArea AXSearchField AXSlider AXIncrementor AXComboBox AXLink AXTab
AXDisclosureTriangle AXSegmentedControl AXColorWell AXToolbarButton AXSwitch AXToggle
AXDockItem AXCell AXTreeItem AXRow AXWebArea
```

`visitPriority` (lower first, applied per sibling batch):

| Role | Priority |
| --- | --- |
| `AXWindow`, `AXSheet`, `AXDialog` | 0 |
| everything else (including `AXApplication`, `AXButton`, …) | 1 |
| `AXMenuBar`, `AXMenuBarItem`, `AXMenu` | 2 |

`textAttributes` (an element carrying any of these is "worth keeping"):

```
AXTitle AXValue AXDescription AXPlaceholderValue AXURL AXFilename
```

### 13.4 Emission filter (`shouldEmit`)

Evaluated in this order for every visited non-structural element (and for every visited
element when `includeStructural == true`):

1. **Role filter** — when `roles` is non-empty and does not contain the element's role:
   keep the element **only if** it exposes at least one `textAttributes` member (so matches
   stay anchored inside their labelled surroundings); otherwise drop it. Note this test runs
   before `interactiveOnly`, so a role filter can still admit non-interactive text
   ancestors.
2. **`interactiveOnly == true`** — keep iff `role ∈ interactiveRoles` **or**
   `AXFocused == true`. (Nothing else — a text-only static text without focus is dropped.)
3. **Default** — keep iff `role ∈ interactiveRoles` **or** `AXFocused == true` **or** any
   `textAttributes` member is present.

`AXEnabled` is not part of the filter: a disabled button is still emitted (with
`enabled: false`). No element is ever dropped for having no frame.

### 13.5 Attribute reading

Every visited element gets **one** cross-process call,
`AXUIElementCopyMultipleAttributeValues`, requesting these 22 attributes in this exact
order (the reply is positional, so order matters for a port):

```
AXRole AXSubrole AXRoleDescription AXTitle AXValue AXDescription AXHelp AXIdentifier
AXDOMIdentifier AXDOMClassList AXEnabled AXFocused AXSelected AXPosition AXSize
AXPlaceholderValue AXURL AXValueDescription AXMaxValue AXMinValue AXSelectedText AXFilename
```

Decoding rules per returned value:

| Returned CoreFoundation type | Stored as | Notes |
| --- | --- | --- |
| `CFNull` | *(absent)* | skipped |
| non-empty `String` | string | empty strings are **absent** |
| `[String]` (non-empty) | string | joined with a single space `" "` — this is how `AXDOMClassList` becomes `domClasses` |
| any `NSNumber` | **boolean** | `number.boolValue`. Numeric attributes such as `AXMaxValue`, `AXMinValue` and numeric `AXValue` are therefore stored as booleans (non-zero → true) and never surface as numbers. |
| `AXValue` of type `.cgPoint` | array `[x, y]` (doubles) | `AXPosition` |
| `AXValue` of type `.cgSize` | array `[w, h]` (doubles) | `AXSize` |
| `AXValue` of type `.cgRect` | array `[x, y, w, h]` (doubles) | not requested, but decoded if returned |
| anything else / call failure | *(absent)* | the whole attribute dictionary is empty when the multiple-copy call fails |

`frame` is derived from the stored `AXPosition` (2-element array) and `AXSize`
(2-element array) only; a missing or malformed pair leaves the frame `nil`, and a `nil`
frame means `window.list[].frame` is absent and `tree.dump … frame` is absent even with
`includeGeometry: true`.

The 22 requested attributes include four that are read and then never surfaced anywhere:
`AXValueDescription`, `AXMaxValue`, `AXMinValue`, `AXSelectedText`. Three more are
requested only because they participate in filtering: `AXFilename`, `AXURL`,
`AXPlaceholderValue`. `AXHelp`, `AXIdentifier`, `AXDOMIdentifier`, `AXDOMClassList` surface
as node fields.

### 13.6 Node encoding

Each emitted node becomes a JSON object. Optional members are **omitted**, never null.

| Member | Type | Present when | Value |
| --- | --- | --- | --- |
| `role` | string | `AXRole` read successfully and non-empty | Raw role, e.g. `AXButton`. Absent is possible; the outline then prints `?`. |
| `subrole` | string | `AXSubrole` non-empty | e.g. `AXStandardWindow` |
| `roleDescription` | string | `AXRoleDescription` non-empty **and different from `role`** | Localized description, e.g. `button` |
| `title` | string | capped `AXTitle` non-empty | see caps below |
| `value` | string | capped `AXValue` non-empty | **only when `AXValue` arrived as a string**; numeric values were stored as booleans and produce no `value` |
| `description` | string | capped `AXDescription` non-empty | |
| `help` | string | capped `AXHelp` non-empty | |
| `placeholder` | string | capped `AXPlaceholderValue` non-empty | |
| `identifier` | string | `AXIdentifier` present | **not** capped |
| `domIdentifier` | string | `AXDOMIdentifier` present | **not** capped |
| `domClasses` | string | `AXDOMClassList` present | space-joined, **not** capped |
| `url` | string | capped `AXURL` non-empty | |
| `actionable` | `true` (boolean) | `role ∈ interactiveRoles` | always literally `true`; never `false` |
| `enabled` | `false` (boolean) | `AXEnabled` was read and is `false` | always literally `false`; absence means "enabled or unknown" |
| `focused` | `true` (boolean) | `AXFocused == true` | |
| `selected` | `true` (boolean) | `AXSelected == true` | |
| `frame` | array of 4 integers `[x,y,w,h]` | `includeGeometry == true` **and** a frame was derived | each component rounded to the nearest integer (away from zero on .5) |
| `depth` | integer | **always** | the folded depth, `0` for the root when the root is emitted |

**Text capping (`cap(text, limit)`)**

* `nil`, empty string, or `limit <= 0` → member absent.
* `Character` count (grapheme clusters, not UTF-16 units) `<= limit` → the string unchanged.
* Otherwise → first `limit` characters **plus** `"…"` (U+2026). The ellipsis is *added*,
  so a capped field can be `limit + 1` characters long.

### 13.7 Index assignment and the element snapshot

* Indices are assigned **at emission time**, starting at `0`, incrementing by exactly 1 per
  emitted node, in traversal order.
* `nodes[i].depth` and the outline line `[i]` share index `i`. `nodeCount == nodes.length`.
* Pruned elements (structural folds, filter drops, menu bar, depth-pruned subtrees,
  budget-pruned remainder) consume **no** index.
* The snapshot stored for later addressing is the **parallel array of emitted elements
  only** (`snapshots[pid].elements`), so index `i` addresses exactly `nodes[i]` — but the
  stored value is the live `AXUIElement` reference, not a copy of its attributes.
* `snapshots[pid]` is **replaced wholesale** by each dump of the same pid, and
  `lastSnapshotPid` is set to the dump's pid. Indices therefore stay valid until the next
  `tree.dump` for that *same* pid, or until the target app relaunches. A dump of another
  pid does not invalidate them (the map is keyed by pid and retains one entry per pid).
* The map holds at most one snapshot per process, so memory is bounded by the number of
  applications rather than by the number of nodes dumped.
* `snapshots[pid].pointers` is **always empty**: `elementRef` string addressing is accepted
  by every action method but can never resolve (see §19.5).

### 13.8 Response

```json
{
  "id": 6,
  "result": {
    "app": "Finder",
    "pid": 512,
    "windowTitle": "Downloads",
    "nodes": [
      {
        "role": "AXWindow",
        "subrole": "AXStandardWindow",
        "roleDescription": "standard window",
        "title": "Downloads",
        "depth": 1,
        "frame": [0, 25, 1440, 900]
      },
      {
        "role": "AXButton",
        "title": "Open",
        "depth": 2,
        "actionable": true,
        "focused": true,
        "frame": [1200, 60, 80, 24]
      }
    ],
    "text": "[0]   AXWindow/AXStandardWindow — title=\"Downloads\" at=0,25 1440x900\n[1]     AXButton — title=\"Open\" actionable focused at=1200,60 80x24",
    "nodeCount": 2,
    "visitedCount": 37,
    "truncatedBy": null,
    "elapsedMs": 412,
    "options": {
      "maxDepth": 8,
      "nodeLimit": 1200,
      "includeStructural": false,
      "interactiveOnly": false,
      "includeGeometry": true,
      "roles": [],
      "includeMenuBar": false
    }
  }
}
```

| Field | Type | Presence / meaning |
| --- | --- | --- |
| `app` | string | Always present. `localizedName` for path B, window-server owner name for path A; can be `""`. |
| `pid` | integer | Always present. The pid whose snapshot was stored. |
| `windowTitle` | string \| null | **Always present.** The matched window's title when a specific window was requested and found; `null` when the dump started at the application element (including the `windowId` fallback case). |
| `nodes` | array of node objects | Always present; may be empty. |
| `text` | string | Always present. The rendered outline (§13.9); `""` when nothing was emitted. |
| `nodeCount` | integer | `nodes.length` (the emitted count, not the visited count). |
| `visitedCount` | integer | Elements dequeued and inspected, including folded structural nodes, filtered-out nodes, and the element that tripped `node_limit`. |
| `truncatedBy` | string \| null | **Always present.** One of `null`, `"node_limit"`, `"visit_limit"`, `"time_budget"` (§13.11). |
| `elapsedMs` | integer | `round(elapsed_seconds * 1000)` measured around the walk only (root resolution excluded). |
| `options` | object | Always present. Effective traversal options, see below. |

`options` sub-object (exact key set — nothing else is echoed):

| Key | Type | Value |
| --- | --- | --- |
| `maxDepth` | integer | effective value |
| `nodeLimit` | integer | effective value |
| `includeStructural` | boolean | effective value |
| `interactiveOnly` | boolean | effective value |
| `includeGeometry` | boolean | effective value |
| `roles` | array of string | the role filter **sorted ascending** (Swift `<` on `String`), deduplicated by the `Set` |
| `includeMenuBar` | boolean | `!skipMenuBar` |

Not echoed anywhere: `textLimit`, `timeBudgetMs`, `format`, `visitLimit`, the resolved
root, the app/pid query.

### 13.9 Outline rendering (byte-exact)

```
line(i) = "[" + str(i) + "] " + repeat("  ", depth_i) + label_i + suffix_i
```

1. **Index prefix**: `[`, the 0-based emitted index in decimal, `]`, then **exactly one
   space**. The index is the same number the `element` parameter takes (and index `0`
   is rejected by action methods — see §19.5).
2. **Indentation**: the literal two-space unit `"  "` repeated `depth_i` times, where
   `depth_i` is the node's folded depth (`>= 0`; negative values are impossible but the
   renderer clamps with `max(0, depth)`).
3. **Label**: the `role` string, or `?` when `role` is absent. Then, when `subrole` is
   present and non-empty, `/` + subrole. Example: `AXWindow/AXStandardWindow`.
4. **Details** are appended in this fixed order, each separated by a single space, all
   preceded by the separator `" — "` (space, U+2014 EM DASH, space) when at least one
   detail exists:
   1. `title="<text>"` — only when `title` is a non-empty string
   2. `value="<text>"` — only when `value` is a non-empty string
   3. `description="<text>"`
   4. `placeholder="<text>"`
   5. `url="<text>"`
   6. `actionable` — bare word, printed whenever the `actionable` member exists
      (i.e. only when it is `true`)
   7. `disabled` — printed when `enabled == false`
   8. `focused` — printed when `focused == true`
   9. `selected` — printed when `selected == true`
   10. `at=<x>,<y> <w>x<h>` — printed when `frame` is a 4-element integer array; the
       components are joined exactly as `at=0,25 1440x900` (comma between x and y, single
       space before the size, `x` between width and height)
5. **Quoting**: each text detail is wrapped in straight double quotes after
   `\n` → `⏎` (U+23CE) and `\t` → `" "` substitution, so one node is always exactly one
   line. Embedded `"` characters are **not** escaped and embedded `\r` is **not**
   converted — a value containing a quote or a CR makes the line ambiguous. (Both are
   under-specified; see §24.)
6. **Join**: lines are joined with `"\n"`; there is **no trailing newline** and no header.
   Zero nodes → the empty string.

Literal examples (spaces are significant; the run after `]` is `1 + 2×depth` spaces):

```
[0]   AXWindow/AXStandardWindow — title="Downloads" at=0,25 1440x900
[1]     AXButton — title="Open" actionable focused
[2]     AXTextField — value="receipts" placeholder="Search mail" actionable
[3]       AXStaticText — value="No new mail"
[4]       AXButton — title="Delete" actionable disabled
[5]         AXLink — title="Show details" url="https://example.com/a/b" actionable
[6]     AXTextArea — value="first line⏎second line" actionable selected
```

Line-by-line explanation of the examples:

* `[0]` is depth 1 → `"  "` → `[0]` + one space + two spaces = `[0]   AXWindow…`. It has
  **no** `actionable` because `AXWindow` is not in `interactiveRoles`.
* `[1]`/`[2]` are depth 2 → four spaces → `[1]     AXButton…`.
* `[3]`/`[4]` are depth 3 → six spaces.
* `[5]` is depth 4 → eight spaces; `url` (with slashes unescaped) comes after
  `placeholder` and before the flags.
* `[6]` shows the newline substitution and `selected`.
* A node with no details renders as `[7]   AXOutline` (the `" — "` separator is omitted
  entirely), which only happens for `includeStructural: true` dumps or a focused element
  with no text attributes.

The shipped client prefers `text` for the model and normalises `nodes` separately; both
must be produced from the same emission order.

### 13.10 Element addressing after the dump

Any action method taking `element` (an integer from the outline) resolves it against the
snapshot of the resolved pid. Full rules are in §19.5. Summary of the guaranteed contract:

* `element` indexes are **0-based** and match `[N]` in the outline and `nodes[N]`.
* Valid range for addressing: `1 … nodeCount-1`. `0` is rejected with `invalid_request`
  (`element 0 is the application itself, not a control; pick a node index from the outline body`),
  and `>= nodeCount` with `not_found`
  (`element index <n> is outside the last snapshot of pid <pid> (<count> nodes); re-run cua_tree`).
* A snapshot is per-pid and is replaced by the next dump of that pid; a stale index after a
  re-dump either resolves to a different element or fails `not_found` — it never falls back
  to a remembered pointer.

### 13.11 `truncatedBy` semantics

| Value | Set when | Notes |
| --- | --- | --- |
| `null` | The queue drained naturally | **Also** the value when `maxDepth` cut the walk short — depth pruning is silent. |
| `"node_limit"` | `emitted.count` reached `nodeLimit` | Exactly `nodeLimit` nodes are returned. |
| `"visit_limit"` | `visited` reached the fixed 40000 cap | Indicates a pathological tree (browsers, Electron apps). |
| `"time_budget"` | Elapsed time exceeded the effective budget **before** dequeuing | Checked before each dequeue; the element that would have exceeded it is not visited. |

The shipped tool text advertises a fourth value `depth`; **the engine never emits it**.
A port that adds a `"depth"` value would be inventing protocol.

### 13.12 Errors

| Code | Condition | Message |
| --- | --- | --- |
| `permission_denied` | Accessibility not granted | `<what> needs Accessibility permission. <hint…>` with `<what>` = `Reading the UI tree` |
| `invalid_request` | `maxDepth`/`nodeLimit`/`textLimit` out of range or wrong type; `roles` not string/array-of-string; `params` not an object | see §5.2 templates |
| `not_found` | `windowId` not on screen; no running app for `pid`; no app matches `app`; no frontmost app; `windowTitle` did not match any window of the resolved app | see §13.2 |
| `operation_failed` | Unexpected Swift error, message prefixed with `tree.dump: ` | — |

---

## 14. `capture.screenshot`

**Requires Screen Recording** — checked *before* any parameter is read:

```
permission_denied: "Screen Recording permission is required for screenshots. " + hint(["screen_recording"])
```

Because the guard runs first, a request with invalid params still reports
`permission_denied` while Screen Recording is ungranted.

### 14.1 Request params

| Param | Type | Required | Default | Range / validation |
| --- | --- | --- | --- | --- |
| `windowId` | integer | no | none | Highest-priority target. Must be an **on-screen** window (`not_found: no on-screen window with id <id>; list windows first`) that is also shareable (`not_found: window <id> is not shareable (it may be off-screen or minimized)`). |
| `pid` | integer | no | none | Second priority. Captures the main window of that process, else its last window with a readable frame larger than 1×1. `not_found: pid <pid> has no capturable window[ matching "<windowTitle>"]`. |
| `displayId` | integer | no | none | Third priority. `not_found: no display with id <displayId>`. |
| `app` | string | no | none | Fourth priority. Substring match; captures the app's **first** accessibility window. `not_found: no application matches "<app>"` / `no capturable window for "<app>"`. |
| `windowTitle` | string | no | none | Case-insensitive substring filter over the candidate windows' AX titles. Honoured in the **`pid`** branch (the main window wins and stops the search; otherwise the **last** matching window is kept). **Ignored in the `app` branch.** |
| `frontmost` | boolean | no | `!hasExplicitRegion` | Fifth priority: capture the frontmost application's first window, falling back to the union of all displays when it has no capturable window. |
| `includeBackground` | boolean | no | `false` | Passed to application resolution in the `app` branch only. |
| `x`, `y`, `width`, `height` | numbers | no | none | Region crop. **All four or none**: any subset triggers `invalid_request: a capture region needs all of x, y, width, and height; received <keys>`. Non-numeric or `null` → `invalid_request: capture region values must be numbers`. `width <= 0` or `height <= 0` → `invalid_request: region width and height must be positive`. |
| `format` | string | no | `"png"` | `"jpeg"`/`"jpg"` (case-insensitive) → JPEG; **anything else** → PNG. Non-string silently → `"png"`. |
| `quality` | number | no | `0.8` | `0.1…1.0` inclusive; out of range or wrong type → `invalid_request`. Used only for JPEG (`CGImage` `compressionFactor`). |
| `maxWidth` | integer | no | `1568` | `64…8192` inclusive. Output pixel cap on the horizontal axis. |
| `maxHeight` | integer | no | `1568` | `64…8192` inclusive. Output pixel cap on the vertical axis. |
| `showCursor` | boolean | no | `false` | Non-boolean silently → `false`. Maps to `SCStreamConfiguration.showsCursor`. |

Params that **do not exist** (explicitly): `path`, `savePath`, `target`, `scale`,
`maxDimension`, `region`, `rect`, `quality` for PNG, `display` (the id key is `displayId`),
`windowTitle` for the `app` branch. The engine **never writes a file** — it returns base64
`data`, and the client decides where to put it. The plugin config key
`maxCaptureDimension` (default `1568`, range 64…8192) is what the shipped tools pass as
both `maxWidth` and `maxHeight`.

`hasExplicitRegion` is computed with **key presence** (`has`), so `"x": null` counts as an
explicit region (and then fails with `capture region values must be numbers`).

### 14.2 Target resolution order and region semantics

1. `windowId` → capture that window (via `SCContentFilter(desktopIndependentWindow:)`),
   region = the window-server frame.
2. `pid` → the accessibility window chosen as described above (main window first, else the
   last title-matching window), region = its AX frame, window resolved through
   `matchWindowID`; unshareable → `not_found: the window of pid <pid> is not shareable; it may be minimized or off-screen`.
3. `displayId` → region = the display frame (negative origins allowed).
4. `app` → first accessibility window of the resolved application.
5. `frontmost` (default when no explicit region) → frontmost app's first window, else the
   union of all displays.
6. Otherwise → the union of all displays (`desktop` from `display.list`, fallback
   `(0,0,1920,1080)`).

Then the explicit region crop:

* No `request.window`/`request.display` (a plain desktop rectangle): the region **replaces**
  the target region.
* With a window or display target: the requested rectangle must **intersect** the target,
  else `invalid_request: the requested region <CGRect> lies outside the capture target <CGRect>`;
  otherwise the capture region becomes the **intersection** (so a partially off-window
  region is silently clipped, not rejected).

### 14.3 Pixel geometry, scale and `maxDimension` downscaling

1. **Native capture.** No output size is forced up front. The captured pixel size is
   `round(region_size × density)` where `density` is the *calibrated* pixels-per-point of
   the display that contains the capture target (for a window: the display containing the
   window's frame; for a region: the display with the largest overlap). Minimum 1 px per
   axis. `scalesToFit = false`, `capturesAudio = false`.
2. **Downscale.** `scaleDown = min(1, maxWidth / pixelWidth, maxHeight / pixelHeight)`.
   When `scaleDown < 1`, the image is redrawn at
   `max(1, round(w × scaleDown)) × max(1, round(h × scaleDown))` with high interpolation
   quality. Only *one* resize happens, so the reported `scale` always describes the image
   the caller receives.
3. **Measured scale.** `scale = pixelWidth / max(region.width, 1)` and
   `scaleY = pixelHeight / max(region.height, 1)`, both computed **after** downscaling and
   as floats. `scale != scaleY` only for a non-uniform aspect (not produced by this
   pipeline; they are equal in practice).
4. Mapping back: `screenX = region[0] + pixelX / scale`,
   `screenY = region[1] + pixelY / scale`.

Isolation of the density: it is a **property of the display**, calibrated once per display
per engine process (§21.3), *not* of the capture. Two captures of the same rectangle on the
same display always report the same `scale`.

### 14.4 Response

```json
{
  "id": 7,
  "result": {
    "data": "iVBORw0KGgoAAAANSUhEUg…",
    "mimeType": "image/png",
    "pixelWidth": 1512,
    "pixelHeight": 900,
    "pointWidth": 1512.0,
    "pointHeight": 900.0,
    "region": [0, 25, 1512, 900],
    "scale": 1.0,
    "scaleY": 1.0,
    "byteLength": 184320,
    "app": "Finder",
    "windowId": 4211,
    "displayId": 1
  }
}
```

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `data` | string | always | Base64 of the encoded image (standard alphabet, with `=` padding). Never empty in a success response. |
| `mimeType` | string | always | `"image/png"` or `"image/jpeg"`. |
| `pixelWidth` / `pixelHeight` | integer | always | Size of the image the caller receives, after any downscale. |
| `pointWidth` / `pointHeight` | number | always | `max(region.width, 1)` / `max(region.height, 1)` as floats — the region size in screen points. |
| `region` | array of 4 numbers | always | The **final** capture rectangle `[x, y, w, h]`, each component rounded to an integer, in top-left-origin screen points. This is the frame the caller should map pixels into. |
| `scale` | number | always | Horizontal pixels per screen point of the delivered image. |
| `scaleY` | number | always | Vertical pixels per screen point of the delivered image. |
| `byteLength` | integer | always | `data.length` in bytes **before** base64 encoding (the decoded size). |
| `app` | string \| null | always | `NSWorkspace.shared.frontmostApplication?.localizedName` — the **frontmost** application at the time of the call, **not necessarily the captured one**. Null when no frontmost app. |
| `windowId` | integer \| null | always | The captured window-server window id, when the capture targeted a window. |
| `displayId` | integer \| null | always | The display the capture came from: the explicitly requested display, else the display covering the most of the final `region` (largest intersection area), else null when no display could be resolved. |

Field ordering note: `app`, `windowId` and `displayId` are merged onto the capture result,
so they are always present (possibly null); `region`, `scale`, `scaleY` etc. are never null.

### 14.5 Errors

| Code | Condition |
| --- | --- |
| `permission_denied` | Screen Recording not granted (checked first; includes the `settingsPane` detail). |
| `invalid_request` | Partial/non-numeric/non-positive region; a region outside its target; `quality`/`maxWidth`/`maxHeight` out of range or wrong type. |
| `not_found` | Unknown `windowId`; unshareable window; unknown `displayId`; a `pid`/`app` with no capturable window; a region that overlaps no display (`the requested region <CGRect> does not overlap any display`). |
| `operation_failed` | Locked screen (`the screen is locked, so nothing can be captured. …`), JPEG/PNG encoding failure, downscale allocation failure, or a ScreenCaptureKit error that survived the retry policy. |

### 14.6 Retry policy (must be reproduced or deliberately replaced)

`SCScreenshotManager.captureImage` is attempted up to **3** times. A failure is retried
only when `error.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain"` and the
session is not locked; the wait before attempt *n* is `n × 250 ms` (250 ms, then 500 ms).
A non-transient error, a locked session flip, or a third failure returns the original error
(or the locked-screen error). Capture is the only method with a retry loop.

---

## 15. `pointer`

**Requires Accessibility** (`requireAccessibility("Synthesizing pointer input")`).

### 15.1 Request params

| Param | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `action` | string | no | `"click"` | One of `click`, `move`, `scroll`, `drag`, `down`, `up`. Anything else → `invalid_request: unknown pointer action "<action>"; expected click, move, scroll, drag, down, or up`. Non-string silently → `"click"`. |
| `route` | string | no | `"post"` | Exactly `"post"` or `"pid"`; any other string → `invalid_request: route must be "post" or "pid", received "<route>"`. Validated for **every** action, before the action switch. |
| `button` | string | no | `"left"` | `left`, `right`, `middle`, `center` (case-sensitive; `center` is the wire name for the middle button, but the echo reports what was sent). Anything else → `invalid_request: button must be left, right, or middle, received "<button>"`. Non-string silently → `"left"`. |
| `pid` | integer | no | none | Route target. **Required when `route == "pid"`**: `invalid_request: route "pid" requires a pid`. Also used as the default pid for element resolution. |
| `x`, `y` | number | no | none | Screen points, top-left origin. **Both or neither**: `invalid_request: pass both x and y, or neither`. Non-numeric (including explicit null) → `invalid_request: parameter "x" must be a number` (idem `y`). |
| `element` | integer | no | none | A `tree.dump` index; the click target becomes the element's centre. Triggers snapshot resolution (§19.5). |
| `elementRef` | string | no | none | Accepted alternative to `element`; can never resolve (§19.5). |
| `clickCount` | integer | no | `1` | `1…3` inclusive (`action: click` only). |
| `holdMs` | integer | no | `40` | `0…2000` inclusive (`action: click` only): sleep between the down and up events. |
| `dx`, `dy` | number | no | `0` each | `action: scroll` only. `dx == 0 && dy == 0` → `invalid_request: scroll requires a non-zero dx or dy`. Values are rounded to `Int32` wheel units. |
| `fromX`, `fromY` | number | **yes for `drag`** | none | Start point. Missing either → `invalid_request: drag requires fromX and fromY`; present but non-numeric → `invalid_request: parameters "fromX" and "fromY" must be numbers`. |
| `steps` | integer | no | `12` | `1…200` inclusive (`drag` only). Number of interpolated waypoints. |
| `durationMs` | integer | no | `300` | `0…10000` inclusive (`drag` only). Spread across the waypoints: `perStep = max(1, durationMs) / steps` ms, and the sleep happens **after each waypoint**. |

Params that **do not exist** (explicitly): `toX`/`toY` (the destination comes from `x`/`y`
or `element`), `duration` (it is `durationMs`), `modifiers`, `pressure`, `target`,
`coordinateSpace`. The shipped client sends `toX`/`toY` for `action: "drag"`, which the
engine ignores — see §24.

### 15.2 Point resolution (`resolvePoint`)

1. If `x`/`y` were supplied: the point must lie inside the union of all display frames
   (`desktopBounds.contains`), else
   `invalid_request: screen point (<x>, <y>) is not on any display. The desktop spans x <minX>…<maxX> and y <minY>…<maxY> in top-left-origin screen points.`
   (values truncated to integers, `…` = U+2026). Note the test is bounding-box containment,
   so a point in the "gap" between two non-adjacent displays of a multi-display desktop is
   accepted.
2. Else, if an `element` was resolved: its frame's centre point; a zero-area or missing
   frame → `operation_failed: the target element has no on-screen frame; scroll it into view or pass explicit x/y coordinates`.
3. Else: the pointer's current position (`NSEvent.mouseLocation`, converted to screen space).

The top-left-origin point is converted once to Quartz's bottom-left event space:
`eventY = primaryScreenHeight - screenY`, where `primaryScreenHeight` is
`NSScreen.screens.first?.frame.height` (falling back to `NSScreen.main?.frame.height`, then 0).

### 15.3 Action semantics

* **`click`** — `Pointer.click`: moves the pointer to the target first (its own `delivered`
  is discarded), then for `click = 1…max(1, count)` posts a down/up pair with
  `mouseEventClickState = click`, sleeping `holdMs` between down and up and 20 ms between
  successive clicks. A double-click is therefore state 1 then state 2, which is what AppKit
  uses to synthesise `doubleAction`.
* **`move`** — one `mouseMoved` event.
* **`scroll`** — moves first, then posts a **pixel-unit** scroll event with
  `wheel1 = round(dy)`, `wheel2 = round(dx)` and `location = point`. `dy > 0` scrolls content
  down (the natural-scrolling gesture direction), matching the screen convention.
* **`drag`** — moves to `fromX/fromY`, posts a button-down with click state 1, posts
  `leftMouseDragged` events (note: the dragged event type is **always** `.leftMouseDragged`,
  even for `button: "right"`/`"middle"`) through `steps` linearly interpolated waypoints
  ending exactly at the resolved destination, sleeping `perStep` ms after each, then posts
  the button-up at the last waypoint. `steps` waypoints means the first waypoint is
  `1/steps` of the way, not the start point.
* **`down` / `up`** — a single button event at the resolved point; a `down` carries click
  state 1. No movement beforehand.
* **Delivery route** — `post`: `event.post(tap: .cghidEventTap)` (like a physical mouse:
  moves the visible cursor, reaches whatever is under it). `pid`: `event.postToPid(pid)`
  (does not move the cursor, works on background apps; falls back to `.cghidEventTap` only
  if the pid is missing, which the `route: "pid"` validation already prevents).

### 15.4 Response

| Action | Response object |
| --- | --- |
| `click` | `{"delivered":true,"x":<eventX>,"y":<eventY>,"button":"left","clickCount":1,"route":"post","screenX":<int>,"screenY":<int>}` |
| `move` | `{"delivered":true,"x":<eventX>,"y":<eventY>,"route":"post","screenX":<int>,"screenY":<int>}` |
| `scroll` | `{"delivered":true,"dx":<dx>,"dy":<dy>,"x":<eventX>,"y":<eventY>,"screenX":<int>,"screenY":<int>}` — **no `route` field** |
| `drag` | `{"delivered":true,"fromScreen":[<x>,<y>],"toScreen":[<x>,<y>],"steps":12,"route":"post"}` — **no `x`/`y`, no `screenX`/`screenY`, no `button`** |
| `down` / `up` | `{"delivered":true,"action":"down","x":<eventX>,"y":<eventY>,"route":"post","screenX":<int>,"screenY":<int>}` |
| any action, event construction failed | `{"delivered":false,"screenX":<int>,"screenY":<int>}` — for `drag` the point fields are still added by the caller, so it is `{"delivered":false,"fromScreen":[…],"toScreen":[…],"steps":<n>,"route":"post"}` |

Field meanings:

* `x` / `y` — the **event-space** (bottom-left origin, Quartz) coordinates actually posted,
  as floats. Only useful for debugging; clients should use `screenX`/`screenY`.
* `screenX` / `screenY` — the resolved top-left-origin screen point, **rounded to an
  integer** but emitted as JSON numbers (e.g. `720` not `720.0`). Added to every action
  except `drag`.
* `clickCount`, `button`, `route`, `dx`, `dy`, `steps`, `fromScreen`, `toScreen` echo what
  was actually delivered, not the request.

Literal responses:

```json
{"id":8,"result":{"delivered":true,"x":720,"y":506,"button":"left","clickCount":1,"route":"post","screenX":720,"screenY":476}}
```
```json
{"id":9,"result":{"delivered":true,"fromScreen":[100,200],"toScreen":[900,600],"steps":12,"route":"post"}}
```
```json
{"id":10,"result":{"delivered":true,"dx":0,"dy":-240,"x":720,"y":506,"screenX":720,"screenY":476}}
```

`delivered: false` never comes with an error code; it means the Quartz event object could
not be constructed (a rare failure) — the engine still reports the resolved point.

---

## 16. `keyboard`

**Requires Accessibility** (`requireAccessibility("Synthesizing keyboard input")`).

Three modes, selected by `action`: `type` (literal text through Quartz unicode events),
`key` (one named key with modifiers held), `insert` (write `AXValue` directly).

| Param | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `action` | string | no | `"type"` | `type`, `key`, `insert`. Anything else → `invalid_request: unknown keyboard action "<action>"; expected type, key, or insert`. Non-string silently → `"type"`. |
| `route` | string | no | `"post"` | **Not validated here.** `Pointer.Route(rawValue:) ?? .post`, so any unknown or non-string value silently becomes `post`. Contrast with `pointer`, which rejects it. |
| `pid` | integer | no | none | Route target for `type`, and the default pid for element resolution. |

### 16.1 `action: "type"`

| Param | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `text` | string | **yes** | — | `string("text")`: missing/`null` → `keyboard: missing required parameter "text"`; wrong type → `keyboard: parameter "text" must be a string, received <type>`. An **empty** string is accepted by the engine (the shipped tool rejects it client-side). |
| `perCharacterDelayMs` | integer | no | `0` | `0…1000` inclusive; sleep after each character. |
| `element` | integer | no | none | A `tree.dump` index. When **present** (key presence, even `null`): resolve the element, then set `AXFocused = true` on it. Failure → `operation_failed: the target element could not take focus (<readableName>); typing would have gone to whatever was focused instead`. On success, read the element's owning pid with `AXUIElementGetPid` and deliver with `route: "pid"` to that pid (background typing works because the app's own accessibility focus is now on the field). `elementRef` does **not** trigger this path. |

Behaviour: each Unicode grapheme cluster of `text` is sent as one down/up event pair with
virtual keycode `0` and the character's UTF-16 units placed in the event's unicode payload
(`CGEventKeyboardSetUnicodeString`) — that is what makes CJK, emoji and accented text work
on any keyboard layout, and why `text` never needs a keycode mapping. Both events carry the
payload. `perCharacterDelayMs` is slept after each character. Events are posted to
`.cghidEventTap` for `route: "post"` and with `postToPid` for `route: "pid"`.

Response:

```json
{"id":11,"result":{"delivered":true,"characters":12,"route":"pid"}}
```

| Field | Type | Presence |
| --- | --- | --- |
| `delivered` | boolean | always |
| `characters` | integer | always; number of grapheme clusters actually posted |
| `route` | string | **absent when `text` was empty** — the empty-text early return is `{"delivered":true,"characters":0}`. Otherwise the route actually used (`"pid"` when element focusing succeeded, else the requested/validated route). |

A mid-string event-construction failure returns
`{"delivered":false,"characters":<delivered so far>}` (still a success response, no error).

### 16.2 `action: "key"`

| Param | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `key` | string | **yes** | — | `nonEmptyString`: missing/`null` → `keyboard: missing required parameter "key"`; wrong type → `… must be a string, received <type>`; empty → `keyboard: parameter "key" must not be empty`. Resolved case-insensitively via the key table (Appendix B). |
| `modifiers` | string \| array of string | no | `[]` | Modifier **names**, not a chord string: `cmd`, `command`, `meta`, `super`, `shift`, `alt`, `option`, `opt`, `ctrl`, `control`, `fn`, `function` (case-insensitive). |
| `repeat` | integer | no | `1` | `1…100` inclusive. |
| `holdMs` | integer | no | `15` | `0…2000` inclusive: the sleep between down and up. |

**There is no chord-string parser.** `"cmd+shift+t"` passed as `key` is not recognised and
returns `{"delivered":false,"reason":"unknown key \"cmd+shift+t\""}`. Modifiers must be sent
in the `modifiers` array. `keyCode` resolution also accepts `KeyA`-style names (`key` +
exactly one character, length 4) and `Digit1`-style names (`digit` + exactly one character,
length 6), case-insensitively.

Behaviour: the modifier names are translated to `CGEventFlags` and applied to **both** the
down and the up event (they are per-event flags, not sticky state — there is no explicit
modifier release, and a mid-chord failure cannot leave a modifier stuck). The chord is
repeated `repeat` times; each iteration creates fresh events from a `.hidSystemState` event
source and posts them to `.cghidEventTap` (there is **no** `route` support for `action: "key"`).

Response — success:

```json
{"id":12,"result":{"delivered":true,"key":"t","keyCode":17,"modifiers":["cmd","shift"],"repeat":1}}
```

Response — failures (all `result`, never `error`):

```json
{"id":13,"result":{"delivered":false,"reason":"unknown key \"cmd+shift+t\""}}
```
```json
{"id":14,"result":{"delivered":false,"reason":"unknown modifier","unknownModifiers":["hyper"]}}
```
```json
{"id":15,"result":{"delivered":false,"reason":"could not create key events"}}
```

| Field | Type | Presence |
| --- | --- | --- |
| `delivered` | boolean | always |
| `key` | string | success only; echoes the request string, **not** the normalised name |
| `keyCode` | integer | success only; the ANSI virtual keycode (Appendix B) |
| `modifiers` | array of string | success only; echoes the request strings verbatim (no normalisation, no dedupe) |
| `repeat` | integer | success only; `max(1, repeat)` |
| `reason` | string | failure only |
| `unknownModifiers` | array of string | failure only, and only for the `"unknown modifier"` reason |

### 16.3 `action: "insert"`

| Param | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `text` | string | **yes** | — | as above, but via `string("text")` (empty allowed) |
| `element` | integer | no | none | Resolved through §19.5. When absent (or unresolvable without error) the **focused element** is used: `AXFocusedUIElement` of `pid` when a pid is given, else the system-wide `AXFocusedUIElement`. |

Behaviour: `AXUIElementSetAttributeValue(element, kAXValueAttribute, text)`. Works without
focus and on background windows, but only for elements with a settable `AXValue` — which is
why it is an explicit choice rather than the default for typing.

Response:

```json
{"id":16,"result":{"inserted":true,"characters":7}}
```
```json
{"id":17,"result":{"inserted":false,"reason":"no focused element was found to insert into"}}
```
```json
{"id":18,"result":{"inserted":false,"reason":"the focused element rejected AXValue: the attribute is not supported"}}
```

| Field | Type | Presence |
| --- | --- | --- |
| `inserted` | boolean | always |
| `characters` | integer | success only; `text.count` (grapheme clusters) |
| `reason` | string | failure only |

Note: an unresolvable `element` (stale index) **does** raise `not_found` from
`resolveElement` for this action — the focused-element fallback applies only when no
`element`/`elementRef` key was supplied at all.

---

## 17. `element.action`

**Requires Accessibility** (`requireAccessibility("Performing an accessibility action")`).

The preferred way to act on a control: it asks the application to perform its own
accessibility action, so it works on background windows, needs no coordinates, does not
move the pointer, and does not steal focus.

### 17.1 Request params

| Param | Type | Required | Default | Validation |
| --- | --- | --- | --- | --- |
| `element` | integer | **yes** (or `elementRef`) | none | A `tree.dump` index; §19.5. Neither key present → `invalid_request: element.action requires "element" (a cua_tree index) or "elementRef"`. |
| `elementRef` | string | no | none | Accepted alternative; never resolves (§19.5). |
| `pid` | integer | no | last dump's pid | Target process for the snapshot lookup and for the click fallback. |
| `action` | string | no | `"press"` | `press`, `setValue`, `focus`, `scrollToVisible`, `menu`, `list`; **any other string is a pass-through** to `AXUIElementPerformAction` (see below). Non-string silently → `"press"`. |
| `text` | string | for `setValue` | none | Missing/wrong type → `keyboard`-style template with method `element.action`: `element.action: missing required parameter "text"`. |
| `path` | string \| array of string | for `menu` | none | Non-empty required: `invalid_request: the menu action requires a non-empty "path" of menu titles`. |

### 17.2 `action: "press"`

1. Perform `AXPress` on the element.
2. Success → `{"performed":true,"action":"AXPress"}`.
3. Failure, but the element **advertises** `AXPress` → `{"performed":false,"action":"AXPress","reason":"AXPress failed: <readableName>"}`
   (a genuine refusal such as a disabled control — do not retry as a click).
4. Failure and no `AXPress` advertised, but the element has a non-zero frame → fall back to
   a **single left click at the frame centre**, posted on the default `post` route with
   `holdMs: 40`, targeting `pid` when given:
   `{"performed":<click delivered>,"action":"click_fallback","screenX":<int>,"screenY":<int>,"availableActions":["AXShowMenu",…]}`.
5. Failure, no `AXPress`, no usable frame →
   `{"performed":false,"action":"AXPress","reason":"the element exposes no AXPress action and has no on-screen frame","availableActions":[…]}`.

`availableActions` is the element's advertised action list (`AXUIElementCopyActionNames`),
in the application's order.

### 17.3 Other actions

| `action` | Behaviour | Response |
| --- | --- | --- |
| `setValue` | `AXUIElementSetAttributeValue(element, AXValue, text)` | success → `{"performed":true,"action":"setValue"}`; failure → **error** `operation_failed: AXValue could not be set: <readableName>` |
| `focus` | set `AXFocused = true` | success → `{"performed":true,"action":"focus"}`; failure → **error** `operation_failed: the element could not take focus: <readableName>` |
| `scrollToVisible` | perform `AXScrollToVisible` | success → `{"performed":true,"action":"AXScrollToVisible"}`; failure → `{"performed":false,"action":"AXScrollToVisible","reason":"the element does not support scrolling into view: <readableName>"}` |
| `menu` | walk the menu path (§17.4) | see §17.4 |
| `list` | read `AXUIElementCopyActionNames` + `AXUIElementCopyAttributeNames` | `{"actions":[…],"attributes":[…]}` — **no `performed`, no `action` key** |
| anything else | `AXUIElementPerformAction(element, action)` verbatim, so vendor-specific actions work without an engine change | success → `{"performed":true,"action":"<action>"}`; failure → **error** `operation_failed: action "<action>" failed: <readableName>` |

### 17.4 `action: "menu"`

Walks a path of menu titles from the menu bar inward and presses the leaf, without
touching the pointer.

Container resolution for the starting element:

1. `AXMenuBar` attribute of the element (an application element exposes it), else
2. the literal attribute name `"AXMenuBar"` again (a duplicated fallback), else
3. the **system-wide** menu bar (`AXUIElementCreateSystemWide()` + `AXMenuBar`, 2 s timeout) —
   "the menu bar of whatever is frontmost".
4. None reachable → `{"performed":false,"reason":"no menu bar is reachable from this element; target an application instead"}`.

Traversal: for each title in `path`, take the container's `AXChildren` and pick the **first**
child whose `AXTitle` compares equal to the title case-insensitively. Then:

| Situation | Response |
| --- | --- |
| No child matches | `{"performed":false,"traversed":[…titles matched so far…],"reason":"no menu item titled \"<title>\" under <the menu bar|the open menu>"}` |
| Match is the **last** title and `AXPress` succeeds | `{"performed":true,"path":[<all titles>]}` |
| Match is the last title, `AXPress` fails, and the item has an `AXParent` | press the parent, sleep **150 ms**, retry once → `{"performed":<retry succeeded>,"path":[…],"reason":"menu item did not respond: <first error readableName>"}` (`reason` omitted on retry success) |
| Match is the last title, `AXPress` fails, no parent | `{"performed":false,"path":[…],"reason":"menu item did not respond: <readableName>"}` |
| Match is an **intermediate** title and its `AXChildren` cannot be read as a single element | `{"performed":false,"traversed":[…],"reason":"menu item \"<title>\" has no submenu"}` |
| Loop finishes without returning (unreachable in practice) | `{"performed":false,"reason":"menu path was not resolved"}` |

Implementation quirk worth knowing when porting: the intermediate step reads the submenu
with the *single-element* accessor (`AXAttribute` cast to `AXUIElement`). On macOS
`AXChildren` is an array, so a path of length ≥ 2 typically fails at the first intermediate
step with `has no submenu`; single-element paths work. A Windows port should use the
children **array** (the evident intent) and note that this is a behaviour *improvement*,
not a byte-identical port — see §24.

### 17.5 Errors

| Code | Condition |
| --- | --- |
| `permission_denied` | Accessibility not granted (`Performing an accessibility action needs Accessibility permission. …`). |
| `invalid_request` | No `element`/`elementRef`; `element: 0`; missing `text` for `setValue`; empty/missing `path` for `menu`; wrong-typed params. |
| `not_found` | Stale or out-of-range element index; no snapshot for the pid; `elementRef` (always). |
| `operation_failed` | `setValue`/`focus` refused; any unknown action rejected by the application. |

---

## 18. `app`

Application lifecycle and inter-application messaging. One method, selected by `action`.

### 18.1 Request params

| Param | Type | Required | Default | Used by | Validation |
| --- | --- | --- | --- | --- | --- |
| `action` | string | no | `"list"` | all | `list`, `activate`, `focus` (alias of `activate`), `hide`, `unhide`, `quit`, `launch`, `openURL`, `openUrl` (alias), `reveal`, `script`, `menu`. Anything else → `invalid_request: unknown app action "<action>"; expected list, activate, hide, unhide, quit, launch, openURL, reveal, script, or menu`. Non-string silently → `"list"`. |
| `pid` | integer | no | none | activate, hide, unhide, quit, menu | First choice in `resolveApplication`: used **only** when a running application with that pid exists; otherwise the resolver silently continues with `app`, then `bundleId`, then the frontmost app. |
| `app` | string | no | none | activate, hide, unhide, quit, menu | Second choice; lower-cased substring match on name/bundle id; the best-ranked match wins; no match → `not_found: no running application matches "<query>"`. |
| `bundleId` | string | no | none | third choice in `resolveApplication`; launch/openURL/script target | For resolution: the first **running** app with that bundle id (`NSRunningApplication.runningApplications(withBundleIdentifier:)`), else the resolver continues. For `launch`: a **non-empty** string is required → `app: parameter "bundleId" must not be empty` / `app: missing required parameter "bundleId"`. |
| `windowTitle` | string | no | none | activate/focus only | Case-insensitive substring; unmatched → `not_found: no window of <app> matches "<title>"`. |
| `force` | boolean | no | `false` | quit only | Non-boolean silently → `false`. `true` → `forceTerminate()`, `false` → `terminate()`. |
| `path` | string | yes for `reveal` | none | reveal only | `nonEmptyString` → an **array** here is a type error: `app: parameter "path" must be a string, received array`. |
| `path` | string \| array of string | yes for `menu` | none | menu only | `stringList` + non-empty check: `invalid_request: the menu action requires a non-empty "path" of menu titles`. |
| `url` | string | yes for `openURL`/`openUrl` | none | openURL | `nonEmptyString`; a string that `URL(string:)` rejects → `{"opened":false,"reason":"not a valid URL: <url>"}`. |
| `script` | string | yes for `script` | none | script | `nonEmptyString`; source text passed to `NSAppleScript`. |
| `timeoutSeconds` | integer | no | `30` | script | `1…600` inclusive; out of range → `invalid_request`. Wrapped into the script as `with timeout of N seconds`, and used for the engine's own deadline of `N + 5` seconds. |
| `includeBackground` | boolean | no | `false` | activate/hide/unhide/quit/menu resolution | Passed to application resolution. |
| `query`, `running` | — | no | — | list only | Forwarded to `app.list` (§10). |

### 18.2 Per-action behaviour and responses

#### `action: "list"` (default)

Delegates to `app.list` with the same params object, so `query`, `running` and
`includeBackground` apply. Response is exactly `app.list`'s response (§10).

#### `action: "activate"` / `"focus"`

Requires Accessibility (`Activating and raising a window`).
Resolves the application and a window (by `windowTitle`, else `AXMain` attribute of the
application element, else `AXFocusedWindow`, else the first `AXWindows` element). Then:

* `AXRaise` on the window when one was resolved (return value → `raised`).
* Sets `AXMain` and `AXFocused` to true on that window (results ignored).
* Calls `NSRunningApplication.activate()` (`activateIgnoringOtherApps` is deprecated and a
  no-op on macOS 14+, which is why the window is raised through accessibility instead).

```json
{"id":19,"result":{"activated":true,"raised":true,"name":"Finder","pid":512}}
```

Because the flags are independent, `activated:false, raised:true` is a legitimate partial
success (the window came forward but the process declined to become frontmost).

#### `action: "hide"` / `"unhide"`

No permission precheck, no window handling.

```json
{"id":20,"result":{"hidden":true,"name":"Finder"}}
```
```json
{"id":21,"result":{"unhidden":true,"name":"Finder"}}
```

`hidden`/`unhidden` is the return value of `NSRunningApplication.hide()`/`unhide()`.

#### `action: "quit"`

```json
{"id":22,"result":{"terminated":true,"forced":false,"name":"Finder","pid":512}}
```

`terminated` is the return value of `terminate()` / `forceTerminate()` (a request accepted,
not a confirmation that the process exited).

#### `action: "launch"`

Requires a non-empty `bundleId`. Looks the bundle id up among installed applications.

```json
{"id":23,"result":{"launched":true,"bundleId":"com.apple.TextEdit","pid":4471}}
```
```json
{"id":24,"result":{"launched":false,"reason":"no installed application with bundle id com.example.nope"}}
```

`pid` is **always present** (null when the launch callback did not report a process). The
call waits up to **20 s** for the launch callback.

#### `action: "openURL"` / `"openUrl"`

```json
{"id":25,"result":{"opened":true,"url":"https://example.com/"}}
```
```json
{"id":26,"result":{"opened":true,"url":"https://example.com/","bundleId":"com.apple.Safari"}}
```
```json
{"id":27,"result":{"opened":false,"reason":"not a valid URL: not a url"}}
```

With a `bundleId` whose application URL exists, the URL is opened **in that app** with
`activates = true` and the call waits up to **10 s**; `bundleId` is echoed in the response.
Without a resolvable `bundleId` the URL goes to the default handler
(`NSWorkspace.open`), and the `bundleId` key is absent. A `bundleId` that does not resolve
to an installed app silently falls back to the default handler **without** echoing the id.

#### `action: "reveal"`

```json
{"id":28,"result":{"revealed":true,"path":"/Users/me/Documents/report.md"}}
```
```json
{"id":29,"result":{"revealed":false,"reason":"no such path: /Users/me/nope"}}
```

Existence is checked with `FileManager.fileExists`; success calls
`NSWorkspace.activateFileViewerSelecting` (Finder comes forward with the item selected).
No application resolution happens.

#### `action: "script"`

Runs AppleScript through `NSAppleScript` on a worker queue with a hard deadline.

* Only **one script may be in flight**; a second concurrent request immediately returns
  `{"executed":false,"timeout":true,"reason":"a previous AppleScript is still running; it is likely waiting on an Automation permission dialog. Answer or dismiss that dialog before sending another script."}`
* With `bundleId`, the source is wrapped exactly as:

```
with timeout of <timeoutSeconds> seconds
tell application id "<bundleId>"
<source>
end tell
end timeout
```

* Deadline: `timeoutSeconds + 5` seconds (`DispatchSemaphore.wait`). On expiry:
  `{"executed":false,"timeout":true,"reason":"the AppleScript did not finish within <timeoutSeconds>s. If macOS is showing an Automation permission dialog, answer it and retry; otherwise the target application is not responding to Apple events."}`
* Compilation failure: `{"executed":false,"reason":"the script could not be compiled"}`.
* AppleScript error: `{"executed":false,"errorNumber":<int>,"errorMessage":"<text>","permissionDenied":<bool>,"reason":"<text>"}`
  where `permissionDenied` is true for error numbers **-1743** (not authorized) and
  **-600** (app not running / no user interaction), and `reason` is the remediation
  sentence in that case, otherwise the raw `errorMessage`.
* Success: `{"executed":true,"result":"<script result as string>"}`; `result` is `""` when
  the script returned nothing.

```json
{"id":30,"result":{"executed":true,"result":"/Users/me"}}
```

#### `action: "menu"`

Resolves the application (with `pid`/`app`/`bundleId`/frontmost as usual), requires a
non-empty `path`, then runs the same menu walk as `element.action`'s `menu` on the
application element — **and discards its result**:

```json
{"id":31,"result":{"requested":true,"path":["File","Save"]}}
```

`requested` is always `true` when the call did not raise an error, even if the menu item
was not found or was not pressable. To learn whether the invocation worked, use
`element.action` `menu` or re-read the tree. Errors here are only the envelope-level ones
(unknown action, empty path, unresolvable application).

### 18.3 Errors

| Code | Condition |
| --- | --- |
| `permission_denied` | `activate`/`focus` with Accessibility ungranted. |
| `invalid_request` | Unknown `action`; missing/empty `bundleId`, `url`, `path`, `script`; `path` as an array for `reveal`; `timeoutSeconds` out of range. |
| `not_found` | `app` query with no running match; `windowTitle` with no matching window; no target and no frontmost application (`no application matched the request and no frontmost application is available`). |
| `operation_failed` | Unexpected Swift errors. |

Note: `hide`, `unhide`, `quit`, `launch`, `openURL`, `reveal`, `script` and `menu` do **not**
precheck Accessibility; they rely on the operating system's own TCC behaviour.

---

## 19. Cross-cutting: target resolution

### 19.1 `resolveApplications(pid, query, frontmost, includeBackground)`

The shared application resolver used by `window.list`, `tree.dump`, `app`, `capture.screenshot`
and `resolveApplication`.

```
if pid is given:
    app = NSRunningApplication(pid) or -> not_found: no running application with pid <pid>
    return [app]                                  # exactly one, no ranking
if frontmost and query is nil/absent:
    app = NSWorkspace.frontmostApplication or -> not_found: no frontmost application
    return [app]
if query is non-empty:                            # callers pass it already lower-cased
    candidates = running apps where
        (includeBackground or activationPolicy != prohibited)
        and (lower(name).contains(query) or lower(bundleId).contains(query))
    if candidates is empty -> not_found: no running application matches "<query>"
    rank each candidate by:
        1. exact match: lower(name) == query
           or lower(bundleId) == query
           or the last dot-separated component of bundleId == query
        2. activationPolicy == regular
        3. name ascending (Swift String "<")
    best = first of the ranked list
    return every candidate that has the SAME rank as best
        (same exactness AND same regular-ness)   # may be several apps
otherwise:
    app = NSWorkspace.frontmostApplication or -> not_found: no frontmost application
    return [app]
```

Consequences:

* The `pid` path never consults `query`/`frontmost`/`includeBackground`.
* The `query` path can return **more than one application**, which is why `window.list` can
  return windows from several apps for one query. `tree.dump`, `capture.screenshot` and
  `app` take the first element of that set.
* Background (`.prohibited`) helpers are excluded unless `includeBackground: true`; without
  that filter `"ghostty"` matches the windowless Dock Extra helper before the app itself.
* Note the asymmetry: `window.list`/`tree.dump`/`capture.screenshot` raise `not_found` for a
  `pid` that is not running, while `app`'s resolver silently falls through to the next
  criterion for a dead `pid`.

### 19.2 Window-server helpers

`windowEntries()` returns every **on-screen** window, front to back, as
`(id: CGWindowID, pid, appName: kCGWindowOwnerName, title: kCGWindowName, frame, layer, alpha)`
— only `id`, `pid`, `appName` and `frame` are ever used. `matchWindowID(pid:frame:)` picks
the entry of that pid whose bounds differ by `|Δx|+|Δy|+|Δw|+|Δh| <= 2`, preferring the
smallest total delta.

### 19.3 Window selection inside an application

* `tree.dump` with `windowTitle`: first `AXWindows` element whose title
  `localizedCaseInsensitiveContains(title)`.
* `capture.screenshot` with `pid` + optional `windowTitle`: walks `AXWindows`, keeps windows
  with `width > 1 && height > 1` whose title matches (when a title filter is given),
  **breaks early on the first main window**, otherwise keeps the last match; then resolves
  the `CGWindowID` and requires it to be shareable.
* `capture.screenshot` with `app`: `AXWindows.first` — `windowTitle` is ignored.
* `app activate/focus`: `AXMain` attribute of the application element ?? `AXFocusedWindow`
  ?? first `AXWindows`.
* `window.list`: all `AXWindows`, or `[AXFocusedWindow]` when the window list is empty.

### 19.4 Permission gates

`requireAccessibility(what)` throws when `AXIsProcessTrusted()` is false, with

```
permission_denied: "<what> needs Accessibility permission. " + permissionHint(["accessibility"])
```

The exact `<what>` strings in use:

| Method / action | `<what>` |
| --- | --- |
| `window.list` | `Listing windows` |
| `tree.dump` | `Reading the UI tree` |
| `pointer` (any action) | `Synthesizing pointer input` |
| `keyboard` (any action) | `Synthesizing keyboard input` |
| `element.action` (any action) | `Performing an accessibility action` |
| `app` `activate`/`focus` | `Activating and raising a window` |

`capture.screenshot` uses the Screen Recording analogue instead:

```
permission_denied: "Screen Recording permission is required for screenshots. " + permissionHint(["screen_recording"])
```

Full sentences are in Appendix C. The `settingsPane` detail is attached to every
`permission_denied`, always with the Accessibility pane URL.

This gate exists so an ungranted process does not silently return an **empty** window list
or an empty tree — that would read as "nothing is open" instead of "you have not granted
permission".

### 19.5 Element resolution (`element` / `elementRef`)

Used by `pointer` (target point), `keyboard` (`type` with `element`, `insert`),
`element.action`, and honoured for `drag`'s destination.

1. If neither key is present at all (`has("element") || has("elementRef")` is false) →
   resolve to "no element requested" (returns nil; callers then use coordinates or the
   current pointer position). `element.action` turns that into `invalid_request`.
2. Determine the target pid, in order:
   1. the `pid` the caller passed (itself `params.optionalInt("pid")`);
   2. `params.optionalInt("pid")` when it names a running application (effectively
      unreachable, since callers pass the same value in step 1);
   3. `lastSnapshotPid` (the pid of the most recent `tree.dump` for **any** application);
   4. the frontmost application's pid;
   5. nothing available → `not_found: no element snapshot is available; call cua_tree first`.
3. Without a snapshot for that pid →
   `not_found: no UI snapshot for pid <pid>; re-run cua_tree for that application before addressing elements by index`.
4. With `element` (an integer):
   * `index <= 0` → `invalid_request: element 0 is the application itself, not a control; pick a node index from the outline body`;
   * `index >= snapshot.elements.count` → `not_found: element index <index> is outside the last snapshot of pid <pid> (<count> nodes); re-run cua_tree`;
   * otherwise → the stored `AXUIElement`.
5. With only `elementRef` →
   `not_found: element reference "<ref>" is not in the last snapshot of pid <pid>; re-run cua_tree`
   (with `""` when the key was present but null), because the pointer identity map is always
   empty in this implementation.

Notes for a port:

* `element: null` counts as "an element was requested" and therefore fails with the
  `elementRef` message rather than falling back to coordinates.
* The default target pid comes from the **last dump**, not from the frontmost application —
  a dump followed by an action is one logical operation, and the frontmost app can change
  in between.
* Snapshot indexes are never "repaired": a stale index either maps to a still-valid element
  object or fails closed with `not_found`.

---

## 20. Cross-cutting: coordinate spaces and geometry

### 20.1 The canonical space: top-left-origin screen points

Every coordinate on the wire — `pointer.x`/`y`, `screenX`/`screenY`, `window.list[].frame`,
`display.list[].frame`, `desktop`, `tree.dump` `frame`, `capture.screenshot.region`,
`fromScreen`/`toScreen` — is in **screen points with the origin at the top-left of the
primary display**. The accessibility API, `CGWindowListCopyWindowInfo` and `SCDisplay.frame`
all report this space; they agree, and the engine deliberately never mixes AppKit's
bottom-left geometry into a decision.

* Secondary displays may have **negative** x or y (a display left of / above the primary).
* One point unit = one logical point; the pixel density of a display is *not* part of this
  space (it appears only as `scale` in a capture result).
* Values are rounded to integers where documented (window/tree frames, `region`,
  `screenX`/`screenY`); `display.list[].frame` and `desktop` are **not** rounded.

### 20.2 The event space (Quartz, bottom-left origin)

`CGEvent` cursor positions use the primary display's **bottom-left** origin. Exactly one
conversion happens, in `Capture.eventPoint(fromScreenPoint:)`:

```
eventY = primaryScreenHeight - screenY      # x is unchanged
primaryScreenHeight = NSScreen.screens.first?.frame.height ?? NSScreen.main?.frame.height ?? 0
```

The inverse is the same function (`y' = H - y` is an involution), so
`screenPoint(fromEventPoint:)` is literally `eventPoint(fromScreenPoint:)`.

A port must apply this conversion exactly once per action, and must report `x`/`y` as the
event-space values and `screenX`/`screenY` as the (rounded) screen-space values, exactly as
`pointer` does.

### 20.3 Pixel space and the capture mapping

`capture.screenshot` reports both the region (points) and the delivered image size (pixels):

```
screenX = region[0] + pixelX / scale
screenY = region[1] + pixelY / scale
```

`scale`/`scaleY` are measured **after** downscaling, so this mapping holds for the image the
caller actually receives, on a mixed-density desktop, without the caller knowing anything
about displays. The point↔pixel relation of a display (`reportedDensity`) is informational
only.

### 20.4 Geometry rounded vs exact

| Field | Representation |
| --- | --- |
| `window.list[].frame` | 4 integers, rounded |
| `tree.dump` node `frame` | 4 integers, rounded |
| `capture.screenshot.region` | 4 numbers, each rounded to an integer |
| `pointer.screenX`/`screenY` | numbers, rounded to integers |
| `pointer.fromScreen`/`toScreen` | 2 numbers each, exact (not rounded) |
| `pointer.x`/`y` | event-space, exact |
| `display.list[].frame`, `desktop` | 4 numbers, exact |
| `display.list[].reportedDensity` | number, exact ratio |
| `capture.screenshot.scale`/`scaleY` | number, exact ratio |

### 20.5 "On the desktop" validation

`Capture.isOnDesktop(point)` is `desktopBounds.contains(point)` where `desktopBounds` is the
**union of all display frames** (fallback `(0,0,1920,1080)` when no display is enumerable).
It is applied to `pointer` coordinates only (not to `drag`'s `fromX`/`fromY`), and it is a
bounding-box test: a gap between two non-adjacent displays is "on the desktop" for this
check even though no display contains the point. Failure message:

```
invalid_request: screen point (<x>, <y>) is not on any display. The desktop spans x <minX>…<maxX> and y <minY>…<maxY> in top-left-origin screen points.
```

Coordinates are refused rather than clamped: the window server would otherwise clamp a bad
point to the nearest screen edge and deliver the event somewhere the caller never asked for.

---

## 21. Cross-cutting: state, caching, timeouts, retries, ordering

### 21.1 Mutable state that outlives a request

| State | Keyed by | Lifetime | Reset by |
| --- | --- | --- | --- |
| `snapshots: [pid: TreeDump.Result]` | target pid | Engine process | Overwritten by the next `tree.dump` of the same pid |
| `lastSnapshotPid: pid?` | — | Engine process | Every `tree.dump` |
| `calibratedDensity: [CGDirectDisplayID: Double]` | display id | Engine process | Never (see §21.3) |
| `scriptInFlight: Bool` | — | Engine process | Script completion/timeout |

There is no other cross-request state: every other value is computed per request. In
particular there is no session object, no "current app" outside `lastSnapshotPid`, no
cached window list, no cached permission state, and no cursor tracking.

### 21.2 Snapshot store (element addressing)

* One `TreeDump.Result` per pid, holding the **emitted** element array of the newest dump
  and the (always empty) pointer map, plus `visited`, `truncatedBy`, `elapsed`, `format`.
* Memory is therefore bounded by `sum(nodes of newest dump per app)`, not by total dumps.
* A dump of application A does not invalidate the snapshot of application B.
* `lastSnapshotPid` is the addressing default when an action names no pid — it is *not*
  derived from the frontmost application.

### 21.3 Display density calibration (must be reproduced for identical `scale`)

```
density(display):
    if calibratedDensity[display.id] exists: return it          # never invalidated
    estimate = display.width / max(display.frame.width, 1)      # ScreenCaptureKit's own ratio
    capture the WHOLE display frame with no forced output size
    if the capture succeeded:
        measured = image.width / max(display.frame.width, 1)
        if 1.0 <= measured <= 4.0: estimate = measured          # reject implausible samples
    calibratedDensity[display.id] = estimate
    return estimate
```

* Calibration happens once per display per engine process, on first use — the first capture
  that touches a display is therefore slower than later ones.
* The cache is never invalidated: a display rearranged, moved to a different scaling mode
  or hot-plugged mid-session keeps its old density until the engine restarts. This is the
  reference behaviour; a port may add invalidation but must document the divergence.
* The estimate is deliberately biased "never too small": if the initial ratio overstates the
  density, the capture is downscaled by the forced size and the measured value corrects it.
* Why calibrate at all: `SCDisplay.width / frame.width` reports `1` on displays that capture
  at 2x, and the rectangle convenience API silently switches density with region size, so two
  captures of the same place could otherwise disagree about how many pixels a point is worth.

### 21.4 Session lock

`sessionLocked` is recomputed on every `permissionStatus()` call from
`CGSessionCopyCurrentDictionary()` (see §8.2). While locked:

* `permissionStatus().ready == false` and the `hint` is the locked sentence;
* any capture fails immediately with
  `operation_failed: the screen is locked, so nothing can be captured. Wake and unlock the Mac, then retry. (While locked, the frontmost application is also reported as loginwindow, so UI trees and input are unreliable too.)`;
* the capture retry loop is aborted rather than retried when the lock appears mid-flight.

### 21.5 Timeouts

| Where | Value | Notes |
| --- | --- | --- |
| Accessibility messaging timeout | **2.0 s** per element | Set on the application element, on the system-wide element for focus/menu lookups, on the tree root, and on every element dequeued during a walk. Bounds each cross-process call; the default 6 s is too long for an interactive loop. |
| `tree.dump` time budget | default **8 s**, clamp `0.2…60 s` | From `timeBudgetMs`; checked before each dequeue. |
| `tree.dump` visit cap | **40000** elements | Not configurable. |
| AppleScript deadline | `timeoutSeconds + 5 s` (default 35 s) | The AppleScript `with timeout` is `timeoutSeconds`. |
| App launch wait | **20 s** | `NSWorkspace.openApplication` semaphore. |
| Open-URL-in-app wait | **10 s** | `NSWorkspace.open([...], withApplicationAt:)` semaphore. |
| Engine-side per-request deadline | **none** | A hung target app can hold a request open for as long as its AX/SCK call blocks; the 2 s AX timeout is the only bound. The shipped client enforces 30 s per call (45 s for screenshots, `timeBudgetMs + 15 s` for trees, `text.length × delay + 30 s` for typing, `timeoutSeconds + 20 s` for scripts). |

### 21.6 Sleeps (literal, all blocking)

| Sleep | Where |
| --- | --- |
| **600 ms** | `engine.request_permissions`, after raising prompts |
| **150 ms** | `element.action` `menu` retry after pressing the parent item |
| **20 ms** | between successive clicks of a multi-click |
| `holdMs` (default 40, `click`) | between mouse-down and mouse-up |
| `holdMs` (default 15, `key`) | between key-down and key-up |
| `perStep = max(1, durationMs) / steps` | after **each** drag waypoint (default `300/12 = 25 ms`) |
| `perCharacterDelayMs` | after each character of `keyboard` `type` |
| **250 ms × attempt** | before capture retry attempts 2 and 3 |

### 21.7 Retries

Only screen capture retries: up to 3 attempts, only for
`com.apple.ScreenCaptureKit.SCStreamErrorDomain` errors (the transient `-3811`
"Failed to start stream due to audio/video capture failure" that a perceive/act/perceive
loop hits routinely), never when the session is locked. Every other operation is
single-shot: no AX retry, no tree partial retry, no keyboard retry.

### 21.8 Ordering guarantees summary

| Response | Order |
| --- | --- |
| `app.list.apps` | frontmost first, then `name` ascending (case-insensitive localized compare); ties unspecified. |
| `window.list.windows` | `main` first, then `focused` first; ties unspecified. |
| `display.list.displays` | `frame.minY` ascending, then `frame.minX` ascending. |
| `tree.dump.nodes` / `.text` | Traversal order: FIFO queue, siblings sorted by `visitPriority` (windows/sheets/dialogs, then the rest, then menu bar items); the emitted index is the array position. |
| `tree.dump.options.roles` | Ascending string sort of the deduplicated filter set. |
| `element.action` `list` → `actions` | Application's advertised order. |
| `element.action` `list` → `attributes` | Application's advertised order. |
| Response object key order | Irrelevant to consumers, but deterministic: keys are sorted (see §1.2). |

Requests themselves are always processed **in arrival order, one at a time**.

### 21.9 What a re-implementation must reproduce, and what it may change

Must reproduce: the snapshot/index lifetime and failure modes; the 2 s per-element messaging
bound; the tree budgets and their `truncatedBy` names; the density cache *semantics* (a
stable per-display pixels-per-point that agrees with the reported `scale`); the locked-session
reporting; the single-flight AppleScript behaviour; the "never clamp, always refuse"
coordinate policy; and the one-response-per-request, in-order, single-threaded loop.

May change: the concrete concurrency primitive (actor/thread), the exact retry backoff, the
sleep durations that only affect latency, the sort algorithm for equal keys, and the order of
keys inside a JSON object.

---

## 22. macOS behaviour to map onto Windows

This section is guidance for the port, not part of the frozen wire contract. The rule that
matters: **anything a client already parses must keep its name, type and meaning.**

### 22.1 Identity and permissions

| Wire item | macOS | Windows recommendation |
| --- | --- | --- |
| `backend` | `"macos-ax"` | `"windows-uia"` (any stable string). |
| `platform` | `"macos"` | `"windows"` (already in `PlatformInfo`). |
| `platformVersion` | `15.2.0` | `10.0.26100` (from `RtlGetVersion`/`Environment.OSVersion`), same three-component shape. |
| `permissionStatus().accessibility` | `AXIsProcessTrusted()` | `true`, plus per-target detection: UIA calls against an elevated process throw `ElementNotAvailable`/`AccessDenied` → map to `permission_denied` with an actionable message. |
| `permissionStatus().screenRecording` | `CGPreflightScreenCaptureAccess()` | `true` (no grant needed); keep the key for schema compatibility. |
| `missing` | `["accessibility","screen_recording"]` | `[]` normally; may carry `["accessibility"]` when UI Automation is genuinely unavailable. |
| `sessionLocked` | `CGSessionCopyCurrentDictionary` | Detect a locked/locked-workstation or disconnected session; keep the flag and the "unlock before expecting captures" hint. |
| `settingsPane` detail | Accessibility pane URL | Any actionable URI (e.g. `ms-settings:easeofaccess`); the key must still be present on `permission_denied`. |
| `executablePath` | bundle executable path | `Process.GetCurrentProcess().MainModule.FileName`. |
| `engine`, `protocol`, `processId` | as documented | unchanged. |

### 22.2 Accessibility vocabulary on the wire

`role`, `subrole`, `roleDescription`, `roles`, `actionable`, the outline labels, and the
`action` strings in `element.action` responses are **macOS accessibility names** and are part
of the observable contract (the shipped client renders them and its tool schema mentions
`AXButton`/`AXTextField`). Recommended approach:

* Map UI Automation `ControlType` values onto the AX role names the engine already uses
  (`Button → AXButton`, `Edit → AXTextField`, `CheckBox → AXCheckBox`, `RadioButton →
  AXRadioButton`, `ComboBox → AXPopUpButton`/`AXComboBox`, `Text → AXStaticText`,
  `Hyperlink → AXLink`, `ListItem → AXRow`, `MenuItem → AXMenuItem`, `MenuBar → AXMenuBar`,
  `TabItem → AXTab`, `Slider → AXSlider`, `TreeItem → AXTreeItem`, `Window → AXWindow`,
  `Pane → AXGroup`, `List → AXList`, `Table → AXTable`, `ScrollBar → AXScrollBar`, …).
* Keep the `structuralRoles`, `interactiveRoles` and `textAttributes` sets as they are
  (they are the filter contract), optionally extended with Windows-only names.
* Keep the action names `"AXPress"`, `"AXScrollToVisible"`, `"setValue"`, `"focus"`,
  `"list"`, `"menu"` and `"click_fallback"` in `element.action` responses; map `AXPress`
  onto UIA `InvokePattern`/`TogglePattern`/`SelectionItemPattern`/`ExpandCollapsePattern`.
* `element.action` with an unknown verb must keep passing the name through (on Windows:
  attempt the matching UIA pattern, else `operation_failed: action "<name>" failed: …`).
* `AXEnabled` → `IsEnabled`; `AXFocused` → `HasKeyboardFocus`; `AXSelected` →
  `SelectionItemPattern.IsSelected`; `AXPosition`/`AXSize` → `BoundingRectangle`;
  `AXTitle` → `Name`; `AXValue` → `ValuePattern.Value`/`RangeValuePattern.Value` (keep the
  "strings only" rule for `value`, per §13.6); `AXHelp` → `HelpText`;
  `AXIdentifier` → `AutomationId`; `AXDOMIdentifier`/`AXDOMClassList` → only for browser
  content, may be absent.

### 22.3 Identifiers, capture and input

| Concept | macOS | Windows recommendation |
| --- | --- | --- |
| `windowId` | `CGWindowID` (uint32) | `HWND` as a JSON number (fits in 2^53; never truncate to 32 bits). `window.list`/`tree.dump`/`capture.screenshot` must accept the same value back. |
| `displayId` | `CGDirectDisplayID` | A stable integer derived from the monitor (device index or a documented hash of the device name); `display.list` must be able to round-trip it. |
| `desktop` | union of display frames | Use the **virtual screen** bounds, same semantics. |
| `region`/`scale` | ScreenCaptureKit points→pixels, calibrated per display | Per-monitor DPI awareness (PerMonitorV2); calibrate pixels-per-point per monitor exactly as §21.3 describes, and report the measured `scale` of the delivered image. Downscale with `maxWidth`/`maxHeight` and report the post-downscale `scale`/`scaleY`. |
| image payload | PNG/JPEG base64 in `data` | Same: encode PNG/JPEG, return base64; never write a file. |
| `pointer.route: "post"` | `CGEvent.post(.cghidEventTap)` | `SendInput` (moves the real cursor). |
| `pointer.route: "pid"` | `CGEvent.postToPid` | `PostMessage`/`SendMessage` to the window (does not move the cursor, reaches background windows). |
| named keys | ANSI virtual keycodes (Appendix B) | Windows virtual-key codes; keep the *names* identical, since `key`/`modifiers` strings are the wire contract. `cmd` has no Windows equivalent — decide whether to map it to Ctrl or reject it (rejecting is more honest; document it). |
| text typing | `CGEventKeyboardSetUnicodeString` per grapheme | `SendInput` with `KEYEVENTF_UNICODE` per UTF-16 unit, so layout-independent Unicode keeps working. |
| `app launch` | `NSWorkspace.openApplication` | `ShellExecuteEx` / `Process.Start`; report `launched` + `pid` (may be null, same rule). |
| `app openURL` | `NSWorkspace.open` | `ShellExecute("open")`; same `opened`/`url`/`bundleId` shape. |
| `app reveal` | `activateFileViewerSelecting` | `explorer.exe /select,<path>`; check existence first and keep `revealed`/`reason`. |
| `app script` | `NSAppleScript` | PowerShell (or a documented scripting host). Keep `executed`, `result`, `timeout`, `errorNumber`, `errorMessage`, `permissionDenied`, `reason` — a Windows script host has no Automation-permission dialog, so `permissionDenied` is normally `false` and the single-flight rule becomes unnecessary (but harmless). |
| `app.list` installed mode | scan `/Applications` | Scan the registry uninstall keys + Start Menu; keep the row shape (`name`, `bundleId`, `path`, `running:false`) and the `count`/`runningOnly` envelope. |
| menu walking | `AXMenuBar`/`AXChildren`/`AXPress` | UIA `MenuBar`→`MenuItem` walk, or keyboard accelerators; keep the `traversed`/`path`/`reason` shapes and the "requested is always true for `app` menu" rule. |
| locked session | `CGSSessionScreenIsLocked` | WTS session state; keep the `sessionLocked` key, `ready == false`, and the locked capture error message shape. |

### 22.4 Things the port must not "fix" silently

* `elementRef` never resolving (§19.5) — either implement pointer identities (and document
  the divergence) or keep failing with the documented `not_found` message.
* `format` on `tree.dump` being inert.
* `truncatedBy` having exactly three non-null values.
* `keyboard` accepting an unvalidated `route`, and `pointer` rejecting an invalid one.
* `app` `menu` reporting `requested: true` unconditionally.
* `capture.screenshot.app` naming the **frontmost** app, not the captured one.
* `window.list[].windowId` being present-and-null while `frame` is absent.
* Unknown params being ignored rather than rejected.

---

## 23. CLI entry points

`main.swift` is the entire CLI. Argument parsing is `CommandLine.arguments.dropFirst()` plus
`contains`/`firstIndex` probes — there is no option parser, so **argument order does not
matter except for the value that follows `--params`**, and any unrecognised argument is
ignored.

Precedence: `--help`/`-h` → `--version` → `--probe` → `--call` → serve loop.

### 23.1 `cua-engine` (no arguments) — serve

Reads newline-delimited JSON requests on stdin and writes one response line per request to
stdout until stdin closes (EOF → the process exits with status 0). Empty lines are skipped
(§1.1). This is the mode the plugin uses.

### 23.2 `cua-engine --help` / `-h`

Prints exactly this text and exits `0`:

```
cua-engine — computer-use engine for the DeepSeek Harness CUA plugin.

Usage:
  cua-engine                 Serve newline-delimited JSON requests on stdio.
  cua-engine --probe         Print one engine.status response and exit.
  cua-engine --version       Print version and platform, then exit.
  cua-engine --help          Print this message.

Protocol: one JSON object per line in, one JSON object per line out.
  {"id":1,"method":"engine.status","params":{}}
Each response carries either "result" or "error".
```

Note the em dash in the first line and the two-space indentation of the usage column.

### 23.3 `cua-engine --version`

Prints exactly one line and exits `0`:

```
cua-engine 0.1.0 (protocol 1, macos 15.2.0)
```

Format: `cua-engine <engineVersion> (protocol <protocolVersion>, <platform> <platformVersion>)`.
It is **not** the `engine.status` response, and it does not touch the backend (it runs
before the host is constructed).

### 23.4 `cua-engine --probe`

Builds the host, dispatches one `engine.status` request with the **string** id `"probe"` and
no params, writes the encoded response line, and exits `0`:

```json
{"id":"probe","result":{"backend":"macos-ax","engine":"0.1.0","permissions":{…},"pid":…}}
```

(Field order is the engine's sorted-key order.) `--probe` runs before `--call`, so passing
both probes only.

### 23.5 `cua-engine --call <method> [--params <json>]`

* `method` = the argument immediately after `--call`, defaulting to `"engine.status"` when
  `--call` is last.
* `params` = the argument immediately after the **first** `--params` occurrence, parsed with
  `try?` — **malformed JSON silently becomes "no params"** rather than an error.
* The request id is the **string** `"cli"`.
* One response line on stdout, exit `0`. No state carries over between invocations (each is
  a fresh process), which is why element indices cannot be used through `--call`.

```
$ cua-engine --call tree.dump --params '{"app":"Finder","maxDepth":4}'
{"id":"cli","result":{"app":"Finder","nodes":[…],"text":"…"}}
$ cua-engine --call engine.permissions
$ cua-engine --call no.such.method
{"id":"cli","error":{"code":"unknown_method","message":"unknown method \"no.such.method\""}}
```

Because `--call` exits after one request, it inherits the single-request limits: a
`tree.dump` with a large `timeBudgetMs` is still bounded by its own budget.

### 23.6 Exit codes

| Situation | Exit |
| --- | --- |
| `--help`, `--version`, `--probe`, `--call` | `0` (always, including for an error response) |
| serve loop, stdin closed | `0` (implicit) |
| serve loop, stdout write failure | the loop continues; the error goes to stderr |
| non-macOS build | still runs, with `backend: "unsupported"` and `unsupported_platform` for every capability method |

A port must keep all five entry points: the README documents them and `--probe` is the
documented way to check permissions without starting a session.

---

## 24. Ambiguities, gaps and contradictions

Everything below was found by reading the Swift sources; each item is a place where a port
must make a decision the reference does not settle, or where the reference is inconsistent
with its own documentation.

### 24.1 Contract fields that are inert or unreachable

1. **`tree.dump.format`** is read, stored and never used: the response always contains an
   `outline`-rendered `text` and never echoes `format`. The parameter implies an intended
   alternative rendering mode (presumably JSON text) that does not exist.
2. **`elementRef`** is a documented addressing mode that can never succeed: the only code
   that builds pointer identities (`TreeDump.pointerIdentities`) is never called, and
   `walk()` returns `pointers: [:]`. Every `elementRef` request fails with
   `not_found: element reference "<ref>" is not in the last snapshot …`.
3. **`truncatedBy: "depth"`** is advertised by the plugin's tool description and is never
   emitted; depth pruning (`childDepth > maxDepth`) is silent. A truncated-by-depth dump
   reports `truncatedBy: null`, so a client cannot distinguish "complete" from
   "depth-limited" without inspecting `options.maxDepth` and the maximum node depth.
4. **`Supplies`** (`supplies(key)`) is defined in the parameter reader and used nowhere.
5. **`AXValueDescription`, `AXMaxValue`, `AXMinValue`, `AXSelectedText`** are fetched from
   every element and then discarded; `AXFilename` participates only in the emit filter.
6. **`engine.handle(line:)`'s `"empty request line"` error** is unreachable through the
   stdio loop, which skips empty lines.

### 24.2 Inconsistencies between methods

7. **`route` validation differs**: `pointer` rejects anything other than `post`/`pid`;
   `keyboard` silently coerces an unknown route to `post` (`Route(rawValue:) ?? .post`).
8. **Dead `pid` handling differs**: `window.list`/`tree.dump`/`capture.screenshot` raise
   `not_found: no running application with pid <pid>`; `app`'s `resolveApplication` silently
   falls through to `app`/`bundleId`/frontmost when the pid is not running, so
   `app: {action:"quit", pid: <dead>}` can quit the **frontmost** application instead.
9. **Missing vs null keys**: `window.list[].windowId` is always present (null when unknown)
   while `window.list[].frame` is absent in the same situation; `capture.screenshot`'s
   `app`/`windowId`/`displayId` are always present; `app.list` running rows omit `path` and
   `launchDate` when unavailable but always include `active`/`frontmost`/`hidden`/
   `terminated`/`policy`.
10. **`app.list`'s `includeBackground`** is read but unused in the installed branch, and
    `runningOnly` echoes `running` under a different name.
11. **`active` and `frontmost`** are always the same value (the same property read twice),
    so a client cannot distinguish "focused app" from "frontmost app".
12. **`keyboard` `type` with empty text** returns `{"delivered":true,"characters":0}` with no
    `route` key, although the shipped tool's output schema marks `route` as required.
13. **`element.action` `press`** returns `performed:false` with a `reason` when the element
    advertises `AXPress` but refuses it, and does not attempt the click fallback in that
    case — intentional, but the fallback policy is not documented on the wire.
14. **`element.action` `list`** returns neither `performed` nor `action`; every other action
    does. The shipped client synthesises `performed: true` client-side.
15. **`app` `menu`** discards the menu walk result and always answers
    `{"requested":true,"path":[…]}`; `element.action` `menu` is the only way to learn the
    outcome.
16. **`capture.screenshot.app`** reports the *frontmost* application's name, which is
    unrelated to the captured window when the call targeted a background app.
17. **`permission_denied.settingsPane`** always points at the Accessibility pane, even for a
    Screen Recording denial.
18. **`engine.permissions` never returns `platformVersion`**, yet the shipped client's
    `PermissionReport` normaliser reads it from that object (always `""`).

### 24.3 Behaviour that cannot be reproduced byte-for-byte

19. **JSON parse errors embed Foundation's localized description** (`request is not valid
    JSON: The data couldn’t be read because it isn’t in the correct format.`), which is
    locale-dependent. Only the `request is not valid JSON: ` prefix is stable.
20. **Swift `sort` is not stable**, so sibling order for equal `visitPriority` and tie order
    in `app.list`/`window.list` are unspecified. The engine's own output can vary run to run
    for those ties.
21. **The multi-level `menu` path walk** reads a submenu with the single-element accessor
    while `AXChildren` is an array, so paths longer than one element typically fail with
    `menu item "<title>" has no submenu`. The intended behaviour (and what a port should
    implement) is to descend into the submenu element of the children array.
22. **The drag waypoints are computed in event space** (`Capture.eventPoint` applied to both
    endpoints, then linear interpolation), which is correct, but the intermediate dragged
    events always use `.leftMouseDragged` regardless of the requested button.
23. **`element.action` `press`'s click fallback** posts a `route: "post"` click with
    `targetPid = pid` (unused by that route), so the fallback always moves the real cursor
    even when the request named a pid.

### 24.4 Robustness gaps (a port should reject instead of crashing)

24. **Integer conversion traps.** `JSONValue.intValue` calls `Int(value)` for an integral
    double, which traps outside `Int64` (`{"maxDepth":1e30}`); `pid_t(<int>)` traps outside
    `Int32`. Neither is validated. A port should answer
    `invalid_request: … must be an integer …` (or a range error).
25. **`textLimit: 0`** disables every text field *and* removes nodes that were only kept
    because they had text attributes, changing the node set and therefore the indices —
    surprising but contractual.
26. **`timeBudgetMs` accepts a float**: `0.2 s` minimum, `60 s` maximum; a value of `0`
    becomes `0.2 s` rather than "no budget".
27. **A `null` `params` member vs an absent one** is only distinguished by `has()`, and only
    in the places listed in §5.1 (`x`/`y` pairing, capture-region detection, element-request
    detection, `keyboard` `type`'s element check); everywhere else `null` behaves like
    "absent" for the silent accessors and like "missing" for the required ones.
28. **`desktopBounds.contains`** accepts points inside the union bounding box that lie on no
    display (multi-display gaps), contradicting the error text "is not on any display".
29. **The engine has no shutdown/quit method**; the client kills the process (SIGTERM) after
    `idleShutdownMs` (default 600000 ms, `0` = keep alive). A Windows port has no SIGTERM —
    agree on a termination mechanism (the shipped client calls `child.kill('SIGTERM')`, which
    Node maps to `TerminateProcess` on Windows).

### 24.5 Under-specified rendering details

30. **Outline quoting** does not escape `"` and does not convert `\r`, so a value containing
    either produces an ambiguous line. Only `\n` → `⏎` and `\t` → `" "` are specified.
31. **`at=<x>,<y> <w>x<h>`** prints whatever integers the frame carries, including negative
    coordinates; there is no unit suffix.
32. **The `— ` separator is a literal EM DASH (U+2014)** with a leading space; a port that
    emits an en dash or a hyphen will differ byte-for-byte.
33. **The ellipsis appended by `cap` is U+2026** and is counted *in addition to* the limit,
    so a capped field is up to `limit + 1` characters long.

---

## Appendix A: macOS AX attributes read by `tree.dump`

Requested for every visited element in one `AXUIElementCopyMultipleAttributeValues` call, in
this order:

| # | Attribute | Stored as | Surfaces as |
| --- | --- | --- | --- |
| 1 | `AXRole` | string | `role` (and the outline label) |
| 2 | `AXSubrole` | string | `subrole` (and `role/ subrole`) |
| 3 | `AXRoleDescription` | string | `roleDescription` (only when different from `role`) |
| 4 | `AXTitle` | string | `title` (capped) |
| 5 | `AXValue` | string **or boolean** | `value` (capped) when a string |
| 6 | `AXDescription` | string | `description` (capped) |
| 7 | `AXHelp` | string | `help` (capped) |
| 8 | `AXIdentifier` | string | `identifier` (uncapped) |
| 9 | `AXDOMIdentifier` | string | `domIdentifier` (uncapped) |
| 10 | `AXDOMClassList` | `[String]` → space-joined string | `domClasses` (uncapped) |
| 11 | `AXEnabled` | boolean | `enabled: false` when false |
| 12 | `AXFocused` | boolean | `focused: true` when true; also emit/filter input |
| 13 | `AXSelected` | boolean | `selected: true` when true |
| 14 | `AXPosition` | `AXValue(.cgPoint)` → `[x,y]` | half of `frame` |
| 15 | `AXSize` | `AXValue(.cgSize)` → `[w,h]` | half of `frame` |
| 16 | `AXPlaceholderValue` | string | `placeholder` (capped); emit/filter input |
| 17 | `AXURL` | string | `url` (capped); emit/filter input |
| 18 | `AXValueDescription` | — | *never surfaced* |
| 19 | `AXMaxValue` | number → boolean | *never surfaced* |
| 20 | `AXMinValue` | number → boolean | *never surfaced* |
| 21 | `AXSelectedText` | — | *never surfaced* |
| 22 | `AXFilename` | string | emit/filter input only |

Other attributes read with dedicated single-value calls: `AXWindows`, `AXFocusedWindow`,
`AXMain`, `AXMinimized`, `AXTitle`, `AXSubrole`, `AXMenuBar`, `AXParent`, `AXChildren`,
`AXFocusedUIElement`, `AXPosition`, `AXSize` (window list, tree root, menu walk, focus).

## Appendix B: key-name table

`keyCode(name)`: lower-case the input, look it up in the table below; else if it starts with
`"key"` and has length 4, look up the remaining single character; else if it starts with
`"digit"` and has length 6, look up the remaining single character; else unknown.

Modifier flags (`modifierFlag`, case-insensitive), used for the `modifiers` array:

| Names | Flag |
| --- | --- |
| `cmd`, `command`, `meta`, `super` | `maskCommand` |
| `shift` | `maskShift` |
| `alt`, `option`, `opt` | `maskAlternate` |
| `ctrl`, `control` | `maskControl` |
| `fn`, `function` | `maskSecondaryFn` |

Key names → ANSI virtual keycodes (literal table; every alias listed is accepted):

```
a 0      s 1      d 2      f 3      h 4      g 5      z 6      x 7      c 8      v 9
b 11     q 12     w 13     e 14     r 15     y 16     t 17
1 18     2 19     3 20     4 21     6 22     5 23     equal 24  = 24
9 25     7 26     minus 27  - 27    8 28     0 29
rightbracket 30  ] 30     o 31     u 32     leftbracket 33  [ 33
i 34     p 35     return 36  enter 36  l 37     j 38     quote 39  ' 39
k 40     semicolon 41  ; 41     backslash 42  \ 42
comma 43  , 43     slash 44  / 44     n 45     m 46     period 47  . 47
tab 48   space 49  " " 49   grave 50  ` 50     delete 51  backspace 51
escape 53  esc 53
cmd 55   command 55  meta 55  super 55
rightcmd 54  rightcommand 54
shift 56  rightshift 60
capslock 57
alt 58   option 58  opt 58   rightalt 61  rightoption 61
ctrl 59  control 59  rightctrl 62  rightcontrol 62
fn 63    function 63
f17 64   keypad_decimal 65   keypad_multiply 67   keypad_plus 69
keypad_clear 71   keypad_divide 75   keypad_enter 76   keypad_minus 78
f18 79   f19 80   keypad_equals 81   keypad_0 82   keypad_1 83
keypad_2 84   keypad_3 85   keypad_4 86   keypad_5 87   keypad_6 88
keypad_7 89   f20 90   keypad_8 91   keypad_9 92
f5 96    f6 97    f7 98    f3 99    f8 100   f9 101
f11 103  f13 105  f16 106  f14 107  f10 109  f12 111
f15 113  help 114  home 115  pageup 116  page_up 116
forwarddelete 117  f4 118  end 119  f2 120  f1 121
left 123  arrowleft 123   right 124  arrowright 124
down 125  arrowdown 125   up 126     arrowup 126
```

Notes:

* Modifier names are also **keys** (`cmd`, `shift`, …) so a caller can press shift alone to
  extend a selection.
* `page_down` / `pagedown` do **not** exist (only `pageup`/`page_up` and `forwarddelete`);
  the plugin's description mentions "pagedown", but sending it yields
  `unknown key "pagedown"`. This is a documentation bug worth not porting.
* `enter` is an alias of `return` (36); there is no separate numeric-keypad enter except
  `keypad_enter` (76).

## Appendix C: verbatim message catalogue

Envelope / reader (with `<M>` = the request's method string, `<T>` = the JSON type name):

```
request must be a JSON object
request is missing "id"
request is missing a non-empty "method"
empty request line                                        (unreachable through stdio)
request is not valid UTF-8
request is not valid JSON: <Foundation localizedDescription>
<M>: params must be an object, received <T>
<M>: missing required parameter "<key>"
<M>: parameter "<key>" must be a string, received <T>
<M>: parameter "<key>" must not be empty
<M>: parameter "<key>" must be an integer, received <T>
<M>: parameter "<key>" must be a number, received <T>
<M>: parameter "<key>" must be an array of strings, received <T>
<M>: parameter "<key>" must be a string or an array of strings, received <T>
<M>: parameter "<key>" must be within <lo>...<hi>, received <n>
unknown method "<method>"
<M>: <underlying error>                                   (catch-all operation_failed)
```

Permissions:

```
All required macOS permissions are granted.
The Mac's screen is locked. Unlock it before expecting captures, UI trees, or input to work.
macOS has not granted <list> to the process hosting this engine. Open System Settings → Privacy & Security → <list>, add or enable the host application, then quit and relaunch it. Accessibility is required for UI trees, clicks, and typing; Screen Recording is required for screenshots.
<what> needs Accessibility permission. <hint>
Screen Recording permission is required for screenshots. <hint>
```

Target resolution:

```
no running application with pid <pid>
no frontmost application
no running application matches "<query>"
no application matched the request and no frontmost application is available
no window of <app> matches title "<title>"
no window of <app> matches "<title>"
no on-screen window with id <id>
no display with id <displayId>
```

Tree:

```
no UI snapshot is available; call cua_tree first
no UI snapshot for pid <pid>; re-run cua_tree for that application before addressing elements by index
element 0 is the application itself, not a control; pick a node index from the outline body
element index <index> is outside the last snapshot of pid <pid> (<count> nodes); re-run cua_tree
element reference "<ref>" is not in the last snapshot of pid <pid>; re-run cua_tree
```

Pointer / keyboard / element actions:

```
unknown pointer action "<action>"; expected click, move, scroll, drag, down, or up
route must be "post" or "pid", received "<route>"
button must be left, right, or middle, received "<button>"
route "pid" requires a pid
pass both x and y, or neither
parameter "x" must be a number
parameter "y" must be a number
scroll requires a non-zero dx or dy
drag requires fromX and fromY
parameters "fromX" and "fromY" must be numbers
screen point (<x>, <y>) is not on any display. The desktop spans x <minX>…<maxX> and y <minY>…<maxY> in top-left-origin screen points.
the target element has no on-screen frame; scroll it into view or pass explicit x/y coordinates
unknown keyboard action "<action>"; expected type, key, or insert
the target element could not take focus (<name>); typing would have gone to whatever was focused instead
element.action requires "element" (a cua_tree index) or "elementRef"
the menu action requires a non-empty "path" of menu titles
AXValue could not be set: <name>
the element could not take focus: <name>
action "<action>" failed: <name>
unknown key "<key>"
unknown modifier
could not create key events
no focused element was found to insert into
the focused element rejected AXValue: <name>
AXPress failed: <name>
the element exposes no AXPress action and has no on-screen frame
the element does not support scrolling into view: <name>
no menu bar is reachable from this element; target an application instead
no menu item titled "<title>" under the menu bar
no menu item titled "<title>" under the open menu
menu item "<title>" has no submenu
menu item did not respond: <name>
menu path was not resolved
```

Capture:

```
<a capture region needs all of x, y, width, and height; received <keys>>
capture region values must be numbers
region width and height must be positive
the requested region <CGRect> lies outside the capture target <CGRect>
the requested region <CGRect> does not overlap any display
no on-screen window with id <id>; list windows first
window <id> is not shareable (it may be off-screen or minimized)
pid <pid> has no capturable window
pid <pid> has no capturable window matching "<title>"
the window of pid <pid> is not shareable; it may be minimized or off-screen
no application matches "<app>"
no capturable window for "<app>"
could not allocate a <w>x<h> bitmap for downscaling
downscaling produced no image
JPEG encoding failed
PNG encoding failed
screen capture failed
the screen is locked, so nothing can be captured. Wake and unlock the Mac, then retry. (While locked, the frontmost application is also reported as loginwindow, so UI trees and input are unreliable too.)
```

Application actions:

```
unknown app action "<action>"; expected list, activate, hide, unhide, quit, launch, openURL, reveal, script, or menu
no installed application with bundle id <bundleId>
not a valid URL: <url>
no such path: <path>
the script could not be compiled
a previous AppleScript is still running; it is likely waiting on an Automation permission dialog. Answer or dismiss that dialog before sending another script.
the AppleScript did not finish within <timeoutSeconds>s. If macOS is showing an Automation permission dialog, answer it and retry; otherwise the target application is not responding to Apple events.
macOS refused the Apple event: the process hosting this engine is not authorized to control this app. Grant it under System Settings → Privacy & Security → Automation.
```

Unsupported-platform messages (protocol defaults / placeholder host):

```
<backend> cannot request permissions
<backend> has no display backend
<backend> has no pointer backend
<backend> has no keyboard backend
<backend> has no element backend
no application backend for <platform>
no window backend for <platform>
no accessibility backend for <platform>
no screen-capture backend for <platform>
```

Accessibility error names used inside `reason`/message text (`AXError.readableName`):

```
success | failure | illegal argument | the element is no longer valid | invalid observer |
the application did not respond | the attribute is not supported | the action is not supported |
the notification is not supported | the application does not implement accessibility |
already registered | not registered | the accessibility API is disabled for this process |
the attribute has no value | the parameterized attribute is not supported |
not enough precision | unknown accessibility error <rawValue>
```






