using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CuaEngine;

/// <summary>
/// Minimal Model Context Protocol server over stdio.
/// </summary>
/// <remarks>
/// This file sits beside <see cref="ProtocolVersion"/> rather than under
/// <c>Win/</c>, and that placement is the point: nothing here knows which
/// platform it is running on. The engine already speaks one JSON object per
/// line, and MCP's stdio transport is the same framing with a different method
/// vocabulary, so this is a translation over <see cref="Engine.Execute"/> rather
/// than a second protocol implementation:
///
/// <list type="bullet">
/// <item><c>initialize</c> negotiates the protocol version and reports the server.</item>
/// <item><c>notifications/initialized</c> and <c>notifications/cancelled</c> are accepted and ignored.</item>
/// <item><c>tools/list</c> returns this engine's catalog.</item>
/// <item><c>tools/call</c> routes one tool to the operation it names.</item>
/// </list>
///
/// Serving MCP as well as the engine's own protocol exists because the harness
/// already has a working path for exposing a subprocess's tools to a model
/// (<c>dsh-mcp-client</c>), and going through it is more useful than
/// reimplementing what that path provides.
///
/// The catalog's <em>schemas</em> are the same objects the macOS engine
/// publishes, because they describe the same twelve operations. Its
/// <em>descriptions</em> are written for this backend: they are what a model
/// reads, and a sentence about the Accessibility grant or an Apple event would
/// be false here, exactly as <c>src/platform.ts</c> rewrites the plugin's own
/// copy for the same reason.
/// </remarks>
public static class McpServer
{
    /// <summary>The protocol revision this server implements.</summary>
    public const string ProtocolVersion = "2025-06-18";

    private const string ServerName = "cua-engine";

    /// <summary>One exposed tool: the MCP name, what it does, and the operation it runs.</summary>
    /// <param name="Fixed">
    /// Parameters this tool pins to a constant, so one engine operation can back
    /// several tools without the caller repeating itself.
    /// </param>
    private sealed record Tool(
        string Name,
        string Description,
        string Method,
        JsonObject Schema,
        JsonObject? Fixed = null);

    // MARK: - Schema fragments

    private static JsonObject Typed(string type, string description) => new()
    {
        ["type"] = type,
        ["description"] = description,
    };

    private static JsonObject Text(string description) => Typed("string", description);

    private static JsonObject Integer(string description) => Typed("integer", description);

    private static JsonObject Number(string description) => Typed("number", description);

    private static JsonObject Flag(string description) => Typed("boolean", description);

    private static JsonObject Choice(string description, params string[] values)
    {
        var schema = Typed("string", description);
        schema["enum"] = new JsonArray([.. values.Select(value => (JsonNode)value)]);
        return schema;
    }

    private static JsonObject Strings(string description) => new()
    {
        ["type"] = "array",
        ["items"] = new JsonObject { ["type"] = "string" },
        ["description"] = description,
    };

    private static JsonObject Object(JsonObject properties, params string[] required)
    {
        var schema = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = properties,
            ["additionalProperties"] = true,
        };
        // Always present, even when empty: the catalog check reads it as an array
        // and the harness registers a tool whose contract it can describe.
        schema["required"] = new JsonArray([.. required.Select(name => (JsonNode)name)]);
        return schema;
    }

    /// <summary>Target selectors shared by every tool that addresses a window or process.</summary>
    private static JsonObject TargetProperties() => new()
    {
        ["app"] = Text("Application name or app id."),
        ["pid"] = Integer("Target process id; wins over app."),
        ["windowId"] = Integer("Target window id from cua_windows."),
        ["windowTitle"] = Text("Case-insensitive substring of the window title."),
        ["displayId"] = Integer("Target display id from cua_displays."),
    };

    /// <summary>Copy <paramref name="base"/> and add <paramref name="extra"/> to it.</summary>
    private static JsonObject Merged(JsonObject @base, JsonObject extra)
    {
        var result = new JsonObject();
        foreach (var (key, value) in @base) result[key] = value?.DeepClone();
        foreach (var (key, value) in extra) result[key] = value?.DeepClone();
        return result;
    }

    // MARK: - Catalog

    private static readonly Tool[] Catalog =
    [
        new Tool(
            "cua_status",
            "Report the engine's platform and state: whether UI Automation and screen capture are available "
                + "(on Windows they always are), whether the screen is locked, and whether this engine is running "
                + "elevated. Call this first when a computer-use tool reports a problem.",
            "engine.status",
            Object([])),
        new Tool(
            "cua_request_permissions",
            "Ask for anything the engine is missing, and return the same report as cua_status. On Windows there "
                + "is nothing to grant — UI Automation, screen capture, and synthesized input are open to every "
                + "process — so this reports state rather than raising a prompt. The one real limit is elevation, "
                + "which this cannot change.",
            "engine.request_permissions",
            Object([])),
        new Tool(
            "cua_displays",
            "List the displays with their rectangles in top-left-origin screen coordinates and the desktop "
                + "bounding box. On Windows one point is one physical pixel, so there is no density to convert. "
                + "Call this before computing coordinates by hand on a multi-display machine.",
            "display.list",
            Object([])),
        new Tool(
            "cua_apps",
            "List running or installed applications, one row per application rather than per process. Use it to "
                + "find the name, app id, or pid that the other tools take as a target. A name that matches more "
                + "than one running instance is refused by cua_app rather than guessed at, so read the pid here.",
            "app.list",
            Object(new JsonObject
            {
                ["query"] = Text("Case-insensitive substring matched against the application name and app id."),
                ["running"] = Flag("List running applications (default true) instead of installed ones."),
                ["includeBackground"] = Flag("Include windowless background helpers. Off by default."),
            })),
        new Tool(
            "cua_windows",
            "List on-screen windows with their id, owning application, title, and rectangle in top-left-origin "
                + "screen coordinates. The returned windowId feeds cua_screenshot and cua_tree.",
            "window.list",
            Object(Merged(TargetProperties(), new JsonObject
            {
                ["frontmost"] = Flag("Only the frontmost application."),
                ["includeUntitled"] = Flag("Include windows with no title (default true)."),
            }))),
        new Tool(
            "cua_tree",
            "Dump the control tree of an application or window as one line per element, each with an index. This "
                + "is the primary way to read a UI: it gives roles, titles, values, and states that a screenshot "
                + "cannot. Roles are UI Automation control types (`Button`, `Edit`), not macOS AX roles. The index "
                + "addresses the element in cua_element and cua_click, and stays valid until the next cua_tree for "
                + "the same application. The tree is always truncated by a budget; the result names which one.",
            "tree.dump",
            Object(Merged(TargetProperties(), new JsonObject
            {
                ["maxDepth"] = Integer("Maximum tree depth (default 8). Structural wrappers do not consume depth."),
                ["nodeLimit"] = Integer("Maximum emitted nodes (default 1200)."),
                ["interactiveOnly"] = Flag("Emit only elements a user can act on."),
                ["roles"] = Strings("Add these roles to the output, such as [\"Button\"]. This widens rather than restricts: any element carrying text is listed as well."),
                ["textLimit"] = Integer("Truncate every text value to this many characters (default 200)."),
                ["includeGeometry"] = Flag("Include each element frame as [x, y, width, height] in screen coordinates."),
                ["includeStructural"] = Flag("Include layout wrappers that are otherwise folded away."),
                ["includeMenuBar"] = Flag("Include the menu bar hierarchy, skipped by default."),
                ["timeBudgetMs"] = Integer("Wall-clock budget for the walk (default 8000)."),
            }))),
        new Tool(
            "cua_screenshot",
            "Capture a window, a display, or a rectangle of the screen and save it to a file. Read the returned "
                + "path to see the pixels. The result reports `region` in top-left-origin screen coordinates and "
                + "`scale` (image pixels per screen unit), so a feature at image pixel (px, py) is at screen "
                + "coordinate (region.x + px/scale, region.y + py/scale).",
            "capture.screenshot",
            Object(Merged(TargetProperties(), new JsonObject
            {
                ["x"] = Integer("Left edge of the region to capture, in screen coordinates."),
                ["y"] = Integer("Top edge of the region, in screen coordinates."),
                ["width"] = Integer("Region width in screen coordinates."),
                ["height"] = Integer("Region height in screen coordinates."),
                ["format"] = Choice("Image format.", "png", "jpeg"),
                ["quality"] = Number("JPEG quality 0.1-1.0 (default 0.8)."),
                ["maxWidth"] = Integer("Downscale so the image is at most this many pixels wide."),
                ["maxHeight"] = Integer("Downscale so the image is at most this many pixels tall."),
                ["showCursor"] = Flag("Draw the mouse cursor into the capture."),
            }))),
        new Tool(
            "cua_click",
            "Move the pointer and click, drag, or scroll on the real desktop. Coordinates are top-left-origin "
                + "screen coordinates. Prefer the `element` index from cua_tree over raw coordinates. With "
                + "route \"post\" the events are synthesized like a physical mouse; with route \"pid\" they are "
                + "posted to the target window as messages, which leaves the cursor alone and reaches a background "
                + "window — classic Win32 controls honour those, applications that read the real cursor position "
                + "(Chromium, UWP, most canvas UIs) ignore them, and the result says which happened.",
            "pointer",
            Object(
                new JsonObject
                {
                    ["action"] = Choice("Pointer action.", "click", "move", "scroll", "drag", "down", "up"),
                    ["x"] = Number("Horizontal position in screen coordinates."),
                    ["y"] = Number("Vertical position in screen coordinates."),
                    ["element"] = Integer("A cua_tree index to target instead of coordinates."),
                    ["toX"] = Number("For action=drag: destination x."),
                    ["toY"] = Number("For action=drag: destination y."),
                    ["clickCount"] = Integer("Click count: 2 double-clicks, 3 triple-clicks."),
                    ["button"] = Choice("Mouse button.", "left", "right", "middle"),
                    ["dx"] = Number("For action=scroll: horizontal scroll in pixels."),
                    ["dy"] = Number("For action=scroll: vertical scroll in pixels; positive scrolls content down. Quantised to the 120-pixel wheel detents Windows uses, and the result reports the delta actually applied."),
                    ["route"] = Choice("Delivery route.", "post", "pid"),
                    ["pid"] = Integer("Target process id for route=pid."),
                    ["durationMs"] = Integer("For action=drag: total drag duration."),
                    ["steps"] = Integer("For action=drag: intermediate move events."),
                },
                "action")),
        new Tool(
            "cua_type",
            "Type text as keyboard input. Pass `element` whenever the field is known: the engine focuses it and "
                + "verifies the focus actually landed there before typing. Windows has no way to post keystrokes "
                + "to a process, so typing always goes to the foreground window — naming the element is what "
                + "guarantees that window is the right one. Without `element` the text goes to whatever holds the "
                + "keyboard. Unicode works on any keyboard layout. For shortcuts use cua_key.",
            "keyboard",
            Object(
                new JsonObject
                {
                    ["text"] = Text("The text to type."),
                    ["element"] = Integer("A cua_tree index to focus and type into."),
                    ["perCharacterDelayMs"] = Integer("Delay between characters; 10-30ms helps applications that drop fast input."),
                    ["pid"] = Integer("Process id owning the element."),
                },
                "text"),
            new JsonObject { ["action"] = "type" }),
        new Tool(
            "cua_key",
            "Press a named key or a chord such as ctrl+s. The key name identifies a physical key position, so the "
                + "shortcut is the same on every keyboard layout. Names include letters, digits, return, tab, "
                + "space, delete (or del), escape, the arrows, home, end, pageup/pgup, pagedown/pgdn, f1-f20, the "
                + "keypad keys, and the modifiers themselves (win, shift, alt, ctrl).",
            "keyboard",
            Object(
                new JsonObject
                {
                    ["key"] = Text("Key name such as \"s\", \"return\", \"down\" or \"f5\"."),
                    ["modifiers"] = Strings("Modifiers held while the key is pressed, such as [\"ctrl\",\"shift\"]."),
                    ["repeat"] = Integer("Press the chord this many times."),
                    ["holdMs"] = Integer("How long to hold the key down, in milliseconds."),
                },
                "key"),
            new JsonObject { ["action"] = "key" }),
        new Tool(
            "cua_element",
            "Act on one element from the most recent cua_tree by asking the application to perform the action "
                + "itself. This is the most reliable way to press a button, choose a menu item, focus a field, or "
                + "write a text value: it needs no coordinates, cannot miss because a window moved, and — for "
                + "everything but typing — never steals focus, so it works on a BACKGROUND window.",
            "element.action",
            Object(
                new JsonObject
                {
                    ["element"] = Integer("Index from the most recent cua_tree dump."),
                    ["action"] = Choice(
                        "What to do with the element.",
                        "press", "setValue", "focus", "scrollToVisible", "menu", "list"),
                    ["text"] = Text("For action=setValue: the value to write into the element."),
                    ["path"] = Strings("For action=menu: menu titles from the menu bar inward."),
                    ["pid"] = Integer("Process id owning the element."),
                },
                "element")),
        new Tool(
            "cua_app",
            "Control one application directly instead of through the pointer. Actions: list, activate, hide, "
                + "unhide, quit, launch, openURL, reveal, menu, and script. Every action changes state, so a name "
                + "or bundleId matching more than one running instance is refused with the candidates listed "
                + "rather than resolved to one of them — pass `pid` to choose. `quit`, `hide`, and `unhide` refuse "
                + "to act on an elevated process. `script` runs a PowerShell snippet and is off unless the caller "
                + "enabled it, because unlike a macOS Apple event it is scoped to nothing.",
            "app",
            Object(
                new JsonObject
                {
                    ["action"] = Choice(
                        "What to do.",
                        "list", "activate", "hide", "unhide", "quit", "launch",
                        "openURL", "reveal", "menu", "script"),
                    ["app"] = Text("Target application name or app id."),
                    ["pid"] = Integer("Target process id; wins over app."),
                    ["bundleId"] = Text("Target app id, executable path, or Application User Model ID; used by launch, openURL, and script."),
                    ["windowTitle"] = Text("With activate: bring the window whose title contains this text to the front."),
                    ["path"] = Strings("For action=menu: menu titles inward. For action=reveal: one filesystem path."),
                    ["url"] = Text("For action=openURL: the URL to open."),
                    ["script"] = Text("For action=script: PowerShell source."),
                    ["timeoutSeconds"] = Integer("For action=script: how long the snippet may take."),
                    ["force"] = Flag("For action=quit: terminate instead of asking the application to close."),
                },
                "action")),
    ];

    /// <summary>Every tool this server publishes, by name.</summary>
    public static IReadOnlyList<string> ToolNames => [.. Catalog.Select(tool => tool.Name)];

    // MARK: - Protocol

    /// <summary>
    /// Handle one request line, returning the response to write, or null for a
    /// notification (which is answered with silence).
    /// </summary>
    public static string? Handle(string line, Engine engine)
    {
        var trimmed = line.Trim();
        if (trimmed.Length == 0) return null;

        JsonNode? parsed;
        try
        {
            parsed = JsonNode.Parse(trimmed);
        }
        catch (JsonException)
        {
            return Error(null, -32700, "invalid JSON");
        }
        if (parsed is not JsonObject request)
        {
            return Error(null, -32700, "invalid JSON");
        }

        var id = request["id"]?.DeepClone();
        var method = request["method"] is JsonValue methodValue
            && methodValue.TryGetValue(out string? methodText) ? methodText : string.Empty;
        var parameters = request["params"] as JsonObject;
        // A notification carries no id and takes no response.
        var isNotification = id is null || id is JsonValue absent && absent.GetValueKind() == JsonValueKind.Null;

        switch (method)
        {
            case "initialize":
            {
                var requested = parameters?["protocolVersion"] is JsonValue versionValue
                    && versionValue.TryGetValue(out string? version) ? version : null;
                return Result(id, new JsonObject
                {
                    ["protocolVersion"] = requested ?? ProtocolVersion,
                    ["capabilities"] = new JsonObject { ["tools"] = new JsonObject() },
                    ["serverInfo"] = new JsonObject
                    {
                        ["name"] = ServerName,
                        ["version"] = EngineIdentity.Version,
                    },
                });
            }

            case "notifications/initialized":
            case "notifications/cancelled":
                return null;

            case "ping":
                return Result(id, new JsonObject());

            case "tools/list":
                return Result(id, new JsonObject
                {
                    ["tools"] = new JsonArray([.. Catalog.Select(tool => (JsonNode)new JsonObject
                    {
                        ["name"] = tool.Name,
                        ["description"] = tool.Description,
                        ["inputSchema"] = tool.Schema.DeepClone(),
                    })]),
                });

            case "tools/call":
            {
                var name = parameters?["name"] is JsonValue nameValue
                    && nameValue.TryGetValue(out string? nameText) ? nameText : null;
                if (name is null)
                {
                    return Error(id, -32602, "tools/call requires a name");
                }
                var tool = Catalog.FirstOrDefault(entry => entry.Name == name);
                if (tool is null)
                {
                    return Error(id, -32602, $"unknown tool {name}");
                }

                var call = new JsonObject();
                if (parameters?["arguments"] is JsonObject arguments)
                {
                    foreach (var (key, value) in arguments) call[key] = value?.DeepClone();
                }
                if (tool.Fixed is { } pinned)
                {
                    foreach (var (key, value) in pinned) call[key] = value?.DeepClone();
                }

                var outcome = engine.Execute(new EngineRequest("mcp", tool.Method, call));
                if (outcome.Error is { } failure)
                {
                    return Result(id, Content($"{failure.CodeText}: {failure.Message}", isError: true));
                }

                // A screenshot carries megabytes of base64 that the MCP client
                // projects to a text block, which would spend the model's whole
                // budget on an unreadable blob. The file is written here instead
                // and the tool returns its path, so the model can open the image
                // through the path-aware reader the harness already has.
                var payload = tool.Name == "cua_screenshot"
                    ? ScreenshotFile.Materialize(outcome.Value!)
                    : outcome.Value!;
                return Result(id, Content(Json.Encode(payload), isError: false));
            }

            default:
                return isNotification ? null : Error(id, -32601, $"unknown method {method}");
        }
    }

    /// <summary>Serve MCP on stdin/stdout until the input closes.</summary>
    public static void Serve(Engine engine, TextReader stdin, TextWriter stdout)
    {
        while (stdin.ReadLine() is { } line)
        {
            string? response;
            try
            {
                response = Handle(line, engine);
            }
            catch (Exception error)
            {
                // Handle() contains per-request failures; this is the last-resort
                // guard so a bug in response encoding cannot end the session.
                Program.WriteDiagnostic($"mcp request failed outside the dispatch guard: {error}");
                continue;
            }
            if (response is not null) stdout.WriteLine(response);
        }
    }

    private static JsonObject Content(string text, bool isError) => new()
    {
        ["content"] = new JsonArray([(JsonNode)new JsonObject
        {
            ["type"] = "text",
            ["text"] = text,
        }]),
        ["isError"] = isError,
    };

    private static string Result(JsonNode? id, JsonNode value) =>
        Json.Encode(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = value });

    private static string Error(JsonNode? id, int code, string message) =>
        Json.Encode(new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
        });
}

/// <summary>
/// Writes captures to disk at the MCP boundary.
/// </summary>
/// <remarks>
/// The engine's own protocol returns image bytes inline, which is right for a
/// same-process consumer that can hand them to an attachment store. MCP has no
/// such channel here — the harness projects an MCP result to a text block — so
/// the bytes are written beside the session and the path is returned instead.
/// </remarks>
public static class ScreenshotFile
{
    /// <summary>Where captures land when no directory is configured.</summary>
    public static string DefaultDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".dsh",
        "cua-screenshots");

    /// <summary>Replace a capture result's inline bytes with a written path.</summary>
    public static JsonNode Materialize(JsonNode value)
    {
        if (value is not JsonObject members) return value;
        if (members["data"] is not JsonValue dataValue
            || !dataValue.TryGetValue(out string? encoded)
            || encoded is null)
        {
            return value;
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(encoded);
        }
        catch (FormatException error)
        {
            return Failure($"the capture's image data is not valid base64: {error.Message}");
        }

        var mimeType = members["mimeType"] is JsonValue mimeValue
            && mimeValue.TryGetValue(out string? text) && text is not null ? text : "image/png";
        var directory = Environment.GetEnvironmentVariable("DSH_CUA_SCREENSHOT_DIR") is { Length: > 0 } configured
            ? configured
            : DefaultDirectory;
        try
        {
            Directory.CreateDirectory(directory);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return Failure($"could not create the screenshot directory {directory}: {error.Message}");
        }

        // Colons are legal in a Windows path only as a drive separator, so the
        // ISO-8601 stamp cannot be used verbatim the way the macOS engine uses it.
        var stamp = DateTime.Now.ToString("yyyy-MM-dd'T'HH-mm-ss-fff", System.Globalization.CultureInfo.InvariantCulture);
        var extension = mimeType == "image/jpeg" ? "jpg" : "png";
        var path = Path.Combine(directory, $"cua-{stamp}.{extension}");
        try
        {
            File.WriteAllBytes(path, bytes);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return Failure($"could not write the screenshot to {path}: {error.Message}");
        }

        members.Remove("data");
        members["path"] = path;
        return members;
    }

    private static JsonObject Failure(string reason) => new() { ["error"] = reason };
}
