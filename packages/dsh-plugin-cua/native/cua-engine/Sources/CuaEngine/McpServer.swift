import Foundation

/// Minimal Model Context Protocol server over stdio.
///
/// The engine already speaks one JSON object per line, and MCP's stdio transport
/// is the same framing with a different method vocabulary, so the server is a
/// thin translation rather than a second protocol implementation:
///
/// * `initialize` negotiates the protocol version and reports the server name.
/// * `notifications/initialized` is accepted and ignored.
/// * `tools/list` returns this engine's catalog.
/// * `tools/call` routes one tool to the operation it names.
///
/// Serving MCP as well as the engine's own protocol exists because the harness
/// already has a working path for exposing a subprocess's tools to a model
/// (`dsh-mcp-client`), and going through it is more useful than reimplementing
/// what that path provides.
enum McpServer {
    /// The protocol revision this server implements.
    static let protocolVersion = "2025-06-18"

    /// One exposed tool: the MCP name, what it does, and the operation it runs.
    struct Tool {
        let name: String
        let description: String
        /// The parameters this tool accepts, as a JSON Schema object.
        let schema: JSONValue
        /// The engine method this tool invokes.
        let method: String
        /// Parameter names that this tool fixes to a constant, so one engine
        /// operation can back several tools without the caller repeating itself.
        let fixed: [String: JSONValue]

        init(
            _ name: String,
            _ description: String,
            _ method: String,
            schema: JSONValue,
            fixed: [String: JSONValue] = [:]
        ) {
            self.name = name
            self.description = description
            self.method = method
            self.schema = schema
            self.fixed = fixed
        }
    }

    /// Reusable schema fragments.
    private static func merged(_ base: [String: JSONValue], _ extra: [String: JSONValue]) -> [String: JSONValue] {
        var result = base
        for (key, value) in extra { result[key] = value }
        return result
    }

    private static func object(_ properties: [String: JSONValue], required: [String] = []) -> JSONValue {
        jsonObject([
            "type": .string("object"),
            "properties": .object(properties),
            "required": .array(required.map { JSONValue.string($0) }),
            "additionalProperties": .bool(true),
        ])
    }

    private static func string(_ description: String) -> JSONValue {
        jsonObject(["type": .string("string"), "description": .string(description)])
    }

    private static func integer(_ description: String) -> JSONValue {
        jsonObject(["type": .string("integer"), "description": .string(description)])
    }

    private static func number(_ description: String) -> JSONValue {
        jsonObject(["type": .string("number"), "description": .string(description)])
    }

    private static func boolean(_ description: String) -> JSONValue {
        jsonObject(["type": .string("boolean"), "description": .string(description)])
    }

    private static func enumString(_ description: String, _ values: [String]) -> JSONValue {
        jsonObject([
            "type": .string("string"),
            "description": .string(description),
            "enum": .array(values.map { JSONValue.string($0) }),
        ])
    }

    /// Target selector shared by every tool that addresses a window or process.
    private static var targetProperties: [String: JSONValue] {
        [
            "app": string("Application name or bundle id."),
            "pid": integer("Target process id; wins over app."),
            "windowId": integer("Target window id from cua_windows."),
            "windowTitle": string("Case-insensitive substring of the window title."),
            "displayId": integer("Target display id from cua_displays."),
        ]
    }

    /// The complete tool catalog.
    static let tools: [Tool] = [
        Tool(
            "cua_status",
            "Report the engine's platform, the macOS permissions it holds, and whether the screen is locked. "
                + "Call this first when a computer-use tool reports a permission problem.",
            "engine.status",
            schema: object([:])
        ),
        Tool(
            "cua_request_permissions",
            "Raise the macOS permission prompts for Accessibility and Screen Recording. "
                + "The user still has to confirm in System Settings, and the grant only applies to a new launch.",
            "engine.request_permissions",
            schema: object([:])
        ),
        Tool(
            "cua_displays",
            "List the displays with their rectangles in top-left-origin screen points, their reported pixel density, "
                + "and the desktop bounding box. Call this before computing coordinates by hand on a multi-display machine.",
            "display.list",
            schema: object([:])
        ),
        Tool(
            "cua_apps",
            "List running applications, or every installed application. Use it to find the name, bundle id, or pid "
                + "that the other tools take as a target.",
            "app.list",
            schema: object([
                "query": string("Case-insensitive substring matched against the application name and bundle id."),
                "running": boolean("List running applications (default true) instead of installed ones."),
                "includeBackground": boolean("Include windowless background helpers. Off by default."),
            ])
        ),
        Tool(
            "cua_windows",
            "List on-screen windows with their id, owning application, title, and rectangle in top-left-origin screen points. "
                + "The returned windowId feeds cua_screenshot and cua_tree.",
            "window.list",
            schema: object(merged(targetProperties, [
                "frontmost": boolean("Only the frontmost application."),
                "includeUntitled": boolean("Include windows with no title (default true)."),
            ]))
        ),
        Tool(
            "cua_tree",
            "Dump the accessibility tree of an application or window as one line per element, each with an index. "
                + "This is the primary way to read a UI: it gives roles, titles, values, and states that a screenshot cannot. "
                + "The index addresses the element in cua_element and cua_click, and stays valid until the next cua_tree "
                + "for the same application. The tree is always truncated by a budget; the result names which one.",
            "tree.dump",
            schema: object(merged(targetProperties, [
                "maxDepth": integer("Maximum tree depth (default 8). Structural wrappers do not consume depth."),
                "nodeLimit": integer("Maximum emitted nodes (default 1200)."),
                "interactiveOnly": boolean("Emit only elements a user can act on."),
                "roles": jsonObject([
                    "type": .string("array"),
                    "items": .object(["type": .string("string")]),
                    "description": .string("Keep only these accessibility roles, such as [\"AXButton\"]."),
                ]),
                "textLimit": integer("Truncate every text value to this many characters (default 200)."),
                "includeGeometry": boolean("Include each element frame as [x, y, width, height] in screen points."),
                "includeStructural": boolean("Include layout wrappers that are otherwise folded away."),
                "includeMenuBar": boolean("Include the menu bar hierarchy, skipped by default."),
                "timeBudgetMs": integer("Wall-clock budget for the walk (default 8000)."),
            ]))
        ),
        Tool(
            "cua_screenshot",
            "Capture a window, a display, or a rectangle of the screen and save it to a file. "
                + "Read the returned path to see the pixels. The result reports `region` in top-left-origin screen points "
                + "and `scale` (image pixels per screen point), so a feature at image pixel (px, py) is at screen point "
                + "(region.x + px/scale, region.y + py/scale).",
            "capture.screenshot",
            schema: object(merged(targetProperties, [
                "x": integer("Left edge of the region to capture, in screen points."),
                "y": integer("Top edge of the region, in screen points."),
                "width": integer("Region width in screen points."),
                "height": integer("Region height in screen points."),
                "format": enumString("Image format.", ["png", "jpeg"]),
                "quality": number("JPEG quality 0.1-1.0 (default 0.8)."),
                "maxWidth": integer("Downscale so the image is at most this many pixels wide."),
                "maxHeight": integer("Downscale so the image is at most this many pixels tall."),
                "showCursor": boolean("Draw the mouse cursor into the capture."),
            ]))
        ),
        Tool(
            "cua_click",
            "Move the pointer and click, drag, or scroll on the real desktop. Coordinates are top-left-origin screen points. "
                + "Prefer the `element` index from cua_tree over raw coordinates. With route \"post\" the events go through the "
                + "window server like a physical mouse; with route \"pid\" they go straight to one process, leaving the cursor alone "
                + "and reaching a background window.",
            "pointer",
            schema: object([
                "action": enumString("Pointer action.", ["click", "move", "scroll", "drag", "down", "up"]),
                "x": number("Horizontal position in screen points."),
                "y": number("Vertical position in screen points."),
                "element": integer("A cua_tree index to target instead of coordinates."),
                "toX": number("For action=drag: destination x."),
                "toY": number("For action=drag: destination y."),
                "clickCount": integer("Click count: 2 double-clicks, 3 triple-clicks."),
                "button": enumString("Mouse button.", ["left", "right", "middle"]),
                "dx": number("For action=scroll: horizontal scroll in pixels."),
                "dy": number("For action=scroll: vertical scroll in pixels; positive scrolls content down."),
                "durationMs": integer("For action=drag: total drag duration."),
                "steps": integer("For action=drag: intermediate move events."),
                "route": enumString("Delivery route.", ["post", "pid"]),
                "pid": integer("Target process id for route=pid."),
            ], required: ["action"])
        ),
        Tool(
            "cua_type",
            "Type text as keyboard input. Pass `element` whenever the field is known: the engine focuses it and delivers the "
                + "keystrokes to that application, which is the only way to type into a background window. Without `element` the "
                + "text goes to whatever has keyboard focus on the frontmost application, and a background one drops it silently. "
                + "Unicode works on any keyboard layout. For shortcuts use cua_key.",
            "keyboard",
            schema: object([
                "text": string("The text to type."),
                "element": integer("A cua_tree index to focus and type into."),
                "perCharacterDelayMs": integer("Delay between characters; 10-30ms helps applications that drop fast input."),
                "route": enumString("Delivery route when no element is named.", ["post", "pid"]),
                "pid": integer("Process id owning the element, or the route=pid target."),
            ], required: ["text"]),
            fixed: ["action": .string("type")]
        ),
        Tool(
            "cua_key",
            "Press a named key or a chord such as cmd+s. The key name identifies a physical key position, so the shortcut is the "
                + "same on every keyboard layout. Names include letters, digits, return, tab, space, delete, escape, the arrows, "
                + "home, end, pageup, pagedown, f1-f20, the keypad keys, and the modifiers themselves.",
            "keyboard",
            schema: object([
                "key": string("Key name such as \"s\", \"return\", \"down\" or \"f5\"."),
                "modifiers": jsonObject([
                    "type": .string("array"),
                    "items": .object(["type": .string("string")]),
                    "description": .string("Modifiers held while the key is pressed, such as [\"cmd\",\"shift\"]."),
                ]),
                "repeat": integer("Press the chord this many times."),
                "holdMs": integer("How long to hold the key down, in milliseconds."),
            ], required: ["key"]),
            fixed: ["action": .string("key")]
        ),
        Tool(
            "cua_element",
            "Act on one element from the most recent cua_tree by asking the application to perform the action itself. "
                + "This is the most reliable way to press a button, choose a menu item, focus a field, or write a text value: it "
                + "works on a BACKGROUND window, needs no coordinates, cannot miss because a window moved, and never steals focus.",
            "element.action",
            schema: object([
                "element": integer("Index from the most recent cua_tree dump."),
                "action": enumString("What to do with the element.", [
                    "press", "setValue", "focus", "scrollToVisible", "menu", "list",
                ]),
                "text": string("For action=setValue: the value to write into the element."),
                "path": jsonObject([
                    "type": .string("array"),
                    "items": .object(["type": .string("string")]),
                    "description": .string("For action=menu: menu titles from the menu bar inward."),
                ]),
                "pid": integer("Process id owning the element."),
            ], required: ["element"])
        ),
        Tool(
            "cua_app",
            "Control one application directly instead of through the pointer. Actions: activate, hide, unhide, quit, launch, "
                + "openURL, reveal, menu, and script. `script` sends an Apple event, so the application performs the work itself; "
                + "it needs the Automation permission, which macOS asks for on first use.",
            "app",
            schema: object([
                "action": enumString("What to do.", [
                    "list", "activate", "hide", "unhide", "quit", "launch", "openURL", "reveal", "menu", "script",
                ]),
                "app": string("Target application name or bundle id."),
                "pid": integer("Target process id; wins over app."),
                "bundleId": string("Target bundle id; used by launch, openURL, and script."),
                "windowTitle": string("With activate: bring the window whose title contains this text to the front."),
                "path": jsonObject([
                    "type": .string("array"),
                    "items": .object(["type": .string("string")]),
                    "description": .string("For action=menu: menu titles inward. For action=reveal: one filesystem path."),
                ]),
                "url": string("For action=openURL: the URL to open."),
                "script": string("For action=script: AppleScript source."),
                "timeoutSeconds": integer("For action=script: how long the target may take."),
                "force": boolean("For action=quit: force-kill instead of asking the application to quit."),
            ], required: ["action"])
        ),
    ]

    /// One decoded MCP request.
    struct Request {
        let id: JSONValue?
        let method: String
        let params: JSONValue?
    }

    /// Handle one request line, returning the response to write (or nil for a
    /// notification, which is answered with silence).
    static func handle(line: String, engine: Engine) async -> JSONValue? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let value = try? JSONValue.parse(trimmed), case .object = value else {
            return errorResponse(id: .null, code: -32700, message: "invalid JSON")
        }
        let request = Request(
            id: value["id"],
            method: value["method"]?.stringValue ?? "",
            params: value["params"]
        )
        // Notifications carry no id and take no response.
        let isNotification = request.id == nil || request.id == .null

        switch request.method {
        case "initialize":
            let requested = request.params?["protocolVersion"]?.stringValue
            return result(id: request.id, jsonObject([
                "protocolVersion": .string(requested ?? protocolVersion),
                "capabilities": .object(["tools": .object([:])]),
                "serverInfo": .object([
                    "name": .string("cua-engine"),
                    "version": .string(engineVersion),
                ]),
            ]))

        case "notifications/initialized", "notifications/cancelled":
            return nil

        case "ping":
            return result(id: request.id, .object([:]))

        case "tools/list":
            return result(id: request.id, jsonObject([
                "tools": .array(tools.map { tool in
                    jsonObject([
                        "name": .string(tool.name),
                        "description": .string(tool.description),
                        "inputSchema": tool.schema,
                    ])
                }),
            ]))

        case "tools/call":
            guard let name = request.params?["name"]?.stringValue else {
                return errorResponse(id: request.id, code: -32602, message: "tools/call requires a name")
            }
            guard let tool = tools.first(where: { $0.name == name }) else {
                return errorResponse(id: request.id, code: -32602, message: "unknown tool \(name)")
            }
            let arguments = request.params?["arguments"]?.objectValue ?? [:]
            var params: [String: JSONValue] = arguments
            for (key, value) in tool.fixed { params[key] = value }
            let call = EngineRequest(id: .string("mcp"), method: tool.method, params: .object(params))
            let response = await engine.dispatchAsync(call)
            switch response {
            case .result(_, let value):
                // A screenshot carries megabytes of base64 that the MCP client
                // projects to a text block, which would spend the model's whole
                // budget on an unreadable blob. The file is written here instead
                // and the tool returns its path, so the model can open the image
                // through the path-aware reader the harness already has.
                let payload = tool.name == "cua_screenshot"
                    ? ScreenshotFile.materialize(value)
                    : value
                let text = (try? payload.encoded()).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                return result(id: request.id, jsonObject([
                    "content": .array([.object([
                        "type": .string("text"),
                        "text": .string(text),
                    ])]),
                    "isError": .bool(false),
                ]))
            case .failure(_, let error):
                return result(id: request.id, jsonObject([
                    "content": .array([.object([
                        "type": .string("text"),
                        "text": .string("\(error.code): \(error.message)"),
                    ])]),
                    "isError": .bool(true),
                ]))
            }

        default:
            if isNotification { return nil }
            return errorResponse(id: request.id, code: -32601, message: "unknown method \(request.method)")
        }
    }

    private static func result(id: JSONValue?, _ value: JSONValue) -> JSONValue {
        jsonObject(["jsonrpc": .string("2.0"), "id": id ?? .null, "result": value])
    }

    private static func errorResponse(id: JSONValue?, code: Int, message: String) -> JSONValue {
        jsonObject([
            "jsonrpc": .string("2.0"),
            "id": id ?? .null,
            "error": .object(["code": .int(code), "message": .string(message)]),
        ])
    }
}

/// Run the MCP stdio loop until stdin closes.
public func runMcpLoop(engine: Engine) async {
    let stdout = FileHandle.standardOutput
    while let line = readLine(strippingNewline: true) {
        guard let response = await McpServer.handle(line: line, engine: engine) else { continue }
        guard let data = try? response.encoded() else { continue }
        try? stdout.write(contentsOf: data + Data([0x0A]))
    }
}


/// Writes captures to disk at the MCP boundary.
///
/// The engine's own protocol returns image bytes inline, which is right for a
/// same-process consumer that can hand them to an attachment store. MCP has no
/// such channel here — the harness projects an MCP result to a text block — so
/// the bytes are written beside the session and the path is returned instead.
enum ScreenshotFile {
    /// Where captures land when no directory is configured.
    static var defaultDirectory: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.dsh/cua-screenshots"
    }

    /// Replace a capture result's inline bytes with a written path.
    static func materialize(_ value: JSONValue) -> JSONValue {
        guard var members = value.objectValue,
              let encoded = members["data"]?.stringValue,
              let bytes = Data(base64Encoded: encoded) else { return value }
        let mimeType = members["mimeType"]?.stringValue ?? "image/png"
        let directory = ProcessInfo.processInfo.environment["DSH_CUA_SCREENSHOT_DIR"] ?? defaultDirectory
        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(atPath: directory, withIntermediateDirectories: true)
        } catch {
            return failure("could not create the screenshot directory \(directory): \(error)")
        }
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: ".", with: "-")
        let ext = mimeType == "image/jpeg" ? "jpg" : "png"
        let path = "\(directory)/cua-\(stamp).\(ext)"
        do {
            try bytes.write(to: URL(fileURLWithPath: path))
        } catch {
            return failure("could not write the screenshot to \(path): \(error)")
        }
        members.removeValue(forKey: "data")
        members["path"] = .string(path)
        return .object(members)
    }

    private static func failure(_ reason: String) -> JSONValue {
        jsonObject(["error": .string(reason)])
    }
}
