import Foundation
import ApplicationServices
import CoreGraphics
import AppKit
import ScreenCaptureKit

/// The action half of the macOS backend: pointer, keyboard, element actions,
/// capture, and application messaging.
extension MacHost {
    // MARK: - Target resolution

    /// Resolve the element a request refers to, by snapshot index or pointer.
    ///
    /// - Returns: the element, or `nil` when the caller asked for no element.
    /// - Throws: `not_found` when an element was requested but cannot be
    ///   resolved, which is the common case after the UI changed underneath a
    ///   stale index.
    func resolveElement(_ params: ParamsReader, pid: pid_t?) throws -> AXUIElement? {
        let index = params.optionalInt("element")
        guard params.has("element") else { return nil }
        // From here the caller asked for a specific element, so every failure
        // below is a real lookup failure rather than "no element requested".

        let targetPid: pid_t
        if let pid {
            targetPid = pid
        } else if let raw = params.optionalInt("pid"), let application = NSRunningApplication(processIdentifier: pid_t(raw)) {
            targetPid = application.processIdentifier
        } else if let last = lastSnapshotPid {
            targetPid = last
        } else if let app = NSWorkspace.shared.frontmostApplication {
            targetPid = app.processIdentifier
        } else {
            throw CuaError.notFound("no element snapshot is available; call cua_tree first")
        }

        guard let snapshot = snapshots[targetPid] else {
            throw CuaError.notFound(
                "no UI snapshot for pid \(targetPid); re-run cua_tree for that application before addressing elements by index"
            )
        }
        if let index {
            guard index > 0 else {
                throw CuaError.invalidRequest(
                    "element 0 is the application itself, not a control; pick a node index from the outline body"
                )
            }
            guard index < snapshot.elements.count else {
                throw CuaError.notFound(
                    "element index \(index) is outside the last snapshot of pid \(targetPid) (\(snapshot.elements.count) nodes); re-run cua_tree"
                )
            }
            return snapshot.elements[index]
        }
        throw CuaError.notFound("no element was addressed; pass the index printed by cua_tree")
    }

    /// Resolve the screen point an action should target.
    ///
    /// Coordinates from a screenshot or a tree entry are in top-left global
    /// screen points; the conversion to Quartz's bottom-left space happens here
    /// so every caller above this line stays in one coordinate system.
    func resolvePoint(_ params: ParamsReader, element: AXUIElement?) async throws -> (screen: CGPoint, event: CGPoint) {
        // Type-checked rather than "read if it happens to parse": a malformed
        // coordinate that silently degrades to the element's center would click
        // the wrong thing, which is worse than refusing the call.
        let coordinates = try Self.coordinates(params)
        if let coordinates {
            guard await Capture.isOnDesktop(coordinates) else {
                let bounds = await Capture.desktopBounds()
                throw CuaError.invalidRequest(
                    "screen point (\(Int(coordinates.x)), \(Int(coordinates.y))) is not on any display. "
                        + "The desktop spans x \(Int(bounds.minX))…\(Int(bounds.maxX)) and y "
                        + "\(Int(bounds.minY))…\(Int(bounds.maxY)) in top-left-origin screen points."
                )
            }
            return (coordinates, Capture.eventPoint(fromScreenPoint: coordinates))
        }
        if let element {
            guard let frame = AX.frame(element), frame.width > 0, frame.height > 0 else {
                throw CuaError.operationFailed(
                    "the target element has no on-screen frame; scroll it into view or pass explicit x/y coordinates"
                )
            }
            let point = CGPoint(x: frame.midX, y: frame.midY)
            return (point, Capture.eventPoint(fromScreenPoint: point))
        }
        // No coordinates and no element: the pointer's current position.
        let current = NSEvent.mouseLocation
        let screen = Capture.screenPoint(fromEventPoint: current)
        return (screen, current)
    }

    /// Read an explicit `x`/`y` pair, rejecting a partial or non-numeric one.
    static func coordinates(_ params: ParamsReader) throws -> CGPoint? {
        let hasX = params.has("x")
        let hasY = params.has("y")
        guard hasX || hasY else { return nil }
        guard hasX, hasY else {
            throw CuaError.invalidRequest("pass both x and y, or neither")
        }
        guard let x = params.optionalDouble("x") else {
            throw CuaError.invalidRequest("parameter \"x\" must be a number")
        }
        guard let y = params.optionalDouble("y") else {
            throw CuaError.invalidRequest("parameter \"y\" must be a number")
        }
        return CGPoint(x: x, y: y)
    }

    /// Read the route/pid/button triple shared by every pointer request.
    func pointerCommand(_ params: ParamsReader, defaultPid: pid_t?) throws -> Pointer.Command {
        var command = Pointer.Command()
        let route = params.string("route", default: "post")
        guard let parsed = Pointer.Route(rawValue: route) else {
            throw CuaError.invalidRequest("route must be \"post\" or \"pid\", received \"\(route)\"")
        }
        command.route = parsed
        command.targetPid = params.optionalInt("pid").map { pid_t($0) } ?? defaultPid
        let button = params.string("button", default: "left")
        guard Pointer.buttonNumber(button) != nil else {
            throw CuaError.invalidRequest("button must be left, right, or middle, received \"\(button)\"")
        }
        command.button = button
        if command.route == .pid, command.targetPid == nil {
            throw CuaError.invalidRequest("route \"pid\" requires a pid")
        }
        return command
    }

    // MARK: - Pointer

    func pointer(_ params: ParamsReader) async throws -> JSONValue {
        try requireAccessibility("Synthesizing pointer input")
        let action = params.string("action", default: "click")
        let element = try resolveElement(params, pid: params.optionalInt("pid").map { pid_t($0) })
        let command = try pointerCommand(params, defaultPid: params.optionalInt("pid").map { pid_t($0) })

        switch action {
        case "click":
            let point = try await resolvePoint(params, element: element)
            let count = try params.int("clickCount", default: 1, in: 1...3)
            let hold = try params.int("holdMs", default: 40, in: 0...2_000)
            let result = Pointer.click(at: point.event, count: count, command: command, holdMs: hold)
            return addScreenPoint(result, point.screen)

        case "move":
            let point = try await resolvePoint(params, element: element)
            let result = Pointer.move(to: point.event, command: command)
            return addScreenPoint(result, point.screen)

        case "scroll":
            let point = try await resolvePoint(params, element: element)
            let dx = params.optionalDouble("dx") ?? 0
            let dy = params.optionalDouble("dy") ?? 0
            guard dx != 0 || dy != 0 else {
                throw CuaError.invalidRequest("scroll requires a non-zero dx or dy")
            }
            let result = Pointer.scroll(at: point.event, dx: dx, dy: dy, command: command)
            return addScreenPoint(result, point.screen)

        case "drag":
            guard params.has("fromX"), params.has("fromY") else {
                throw CuaError.invalidRequest("drag requires fromX and fromY")
            }
            guard let fromX = params.optionalDouble("fromX"), let fromY = params.optionalDouble("fromY") else {
                throw CuaError.invalidRequest("parameters \"fromX\" and \"fromY\" must be numbers")
            }
            let toElement = try resolveElement(params, pid: params.optionalInt("pid").map { pid_t($0) })
            let to = try await resolvePoint(params, element: toElement)
            let startScreen = CGPoint(x: fromX, y: fromY)
            let start = Capture.eventPoint(fromScreenPoint: startScreen)
            let steps = try params.int("steps", default: 12, in: 1...200)
            let duration = try params.int("durationMs", default: 300, in: 0...10_000)
            let waypoints = (1...steps).map { step -> CGPoint in
                let ratio = Double(step) / Double(steps)
                return CGPoint(
                    x: start.x + (to.event.x - start.x) * ratio,
                    y: start.y + (to.event.y - start.y) * ratio
                )
            }
            let result = Pointer.drag(from: start, through: waypoints, command: command, durationMs: duration)
            return jsonObject([
                "delivered": result["delivered"],
                "fromScreen": .array([.double(Double(fromX)), .double(Double(fromY))]),
                "toScreen": .array([.double(Double(to.screen.x)), .double(Double(to.screen.y))]),
                "steps": .int(steps),
                "route": .string(command.route.rawValue),
            ])

        case "down", "up":
            let point = try await resolvePoint(params, element: element)
            let result = Pointer.button(action, at: point.event, command: command)
            return addScreenPoint(result, point.screen)

        default:
            throw CuaError.invalidRequest("unknown pointer action \"\(action)\"; expected click, move, scroll, drag, down, or up")
        }
    }

    /// Echo the resolved screen point alongside the delivered event.
    private func addScreenPoint(_ result: JSONValue, _ point: CGPoint) -> JSONValue {
        var members = result.objectValue ?? [:]
        members["screenX"] = .double(Double(point.x.rounded()))
        members["screenY"] = .double(Double(point.y.rounded()))
        return .object(members)
    }

    // MARK: - Keyboard

    func keyboard(_ params: ParamsReader) throws -> JSONValue {
        try requireAccessibility("Synthesizing keyboard input")
        let action = params.string("action", default: "type")
        let route = Pointer.Route(rawValue: params.string("route", default: "post")) ?? .post
        let pid = params.optionalInt("pid").map { pid_t($0) }

        switch action {
        case "type":
            let text = try params.string("text")
            let delay = try params.int("perCharacterDelayMs", default: 0, in: 0...1_000)
            // Typing into a named element implies focusing it first. Measured
            // behavior on macOS: `CGEventPostToPid` delivers key events to a
            // background application, but that application ignores them unless its
            // own AX focus is on the target — whereas the same sequence preceded by
            // an AX focus call writes the text. The focus also makes the focus
            // target explicit instead of "whatever had focus last".
            if params.has("element"), let element = try resolveElement(params, pid: pid) {
                let error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                if error != .success {
                    throw CuaError.operationFailed(
                        "the target element could not take focus (\(error.readableName)); "
                            + "typing would have gone to whatever was focused instead"
                    )
                }
                var owner: pid_t = 0
                if AXUIElementGetPid(element, &owner) == .success, owner > 0 {
                    return Keyboard.typeText(text, perCharacterDelayMs: delay, route: .pid, pid: owner)
                }
            }
            return Keyboard.typeText(text, perCharacterDelayMs: delay, route: route, pid: pid)

        case "key":
            let key = try params.nonEmptyString("key")
            let modifiers = try params.stringList("modifiers")
            let repeatCount = try params.int("repeat", default: 1, in: 1...100)
            let hold = try params.int("holdMs", default: 15, in: 0...2_000)
            // An unrecognised name is a caller error, not a refused action: a
            // silent `delivered: false` invites a model to keep going as if the
            // shortcut had been pressed.
            guard Keyboard.keyCode(key) != nil else {
                throw CuaError.invalidRequest(
                    "unknown key name \"\(key)\". Known names include letters, digits, return, tab, space, "
                        + "delete, escape, the arrow keys, home, end, pageup, pagedown, f1-f20, the keypad keys, "
                        + "and the modifiers themselves."
                )
            }
            return Keyboard.chord(key: key, modifiers: modifiers, repeatCount: repeatCount, holdMs: hold)

        case "insert":
            let text = try params.string("text")
            let element = try resolveElement(params, pid: pid) ?? Self.focusedElement(pid: pid)
            return Keyboard.insertText(text, into: element)

        default:
            throw CuaError.invalidRequest("unknown keyboard action \"\(action)\"; expected type, key, or insert")
        }
    }

    /// The element that currently has keyboard focus, preferring the target app.
    static func focusedElement(pid: pid_t?) -> AXUIElement? {
        if let pid {
            let application = AX.application(pid)
            if let focused = AX.element(application, kAXFocusedUIElementAttribute as String) {
                return focused
            }
        }
        let system = AXUIElementCreateSystemWide()
        AX.setMessagingTimeout(system, seconds: 2.0)
        return AX.element(system, kAXFocusedUIElementAttribute as String)
    }

    // MARK: - Element actions

    func elementAction(_ params: ParamsReader) async throws -> JSONValue {
        try requireAccessibility("Performing an accessibility action")
        let pid = params.optionalInt("pid").map { pid_t($0) }
        guard let element = try resolveElement(params, pid: pid) else {
            throw CuaError.invalidRequest("element.action requires \"element\" (a cua_tree index) or \"elementRef\"")
        }
        let action = params.string("action", default: "press")

        switch action {
        case "press":
            // Prefer the element's own action: it is a real user action inside the
            // target app, needs no focus, and never moves the pointer.
            let error = AX.perform(element, kAXPressAction as String)
            if error == .success {
                return jsonObject(["performed": .bool(true), "action": .string("AXPress")])
            }
            let available = AX.actions(element)
            if available.contains(kAXPressAction as String) {
                return jsonObject([
                    "performed": .bool(false),
                    "action": .string("AXPress"),
                    "reason": .string("AXPress failed: \(error.readableName)"),
                ])
            }
            // Not pressable: fall back to a click at its center, which is what a
            // model means by "press this" for a non-button element.
            guard let frame = AX.frame(element), frame.width > 0, frame.height > 0 else {
                return jsonObject([
                    "performed": .bool(false),
                    "action": .string("AXPress"),
                    "reason": .string("the element exposes no AXPress action and has no on-screen frame"),
                    "availableActions": .array(available.map { JSONValue.string($0) }),
                ])
            }
            let point = CGPoint(x: frame.midX, y: frame.midY)
            var command = Pointer.Command()
            command.targetPid = pid
            let clicked = Pointer.click(at: Capture.eventPoint(fromScreenPoint: point), count: 1, command: command, holdMs: 40)
            return jsonObject([
                "performed": clicked["delivered"],
                "action": .string("click_fallback"),
                "screenX": .double(Double(point.x.rounded())),
                "screenY": .double(Double(point.y.rounded())),
                "availableActions": .array(available.map { JSONValue.string($0) }),
            ])

        case "setValue":
            let text = try params.string("text")
            let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
            guard error == .success else {
                throw CuaError.operationFailed("AXValue could not be set: \(error.readableName)")
            }
            return jsonObject(["performed": .bool(true), "action": .string("setValue")])

        case "focus":
            let error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard error == .success else {
                throw CuaError.operationFailed("the element could not take focus: \(error.readableName)")
            }
            return jsonObject(["performed": .bool(true), "action": .string("focus")])

        case "scrollToVisible":
            let error = AX.perform(element, "AXScrollToVisible")
            if error == .success {
                return jsonObject(["performed": .bool(true), "action": .string("AXScrollToVisible")])
            }
            return jsonObject([
                "performed": .bool(false),
                "action": .string("AXScrollToVisible"),
                "reason": .string("the element does not support scrolling into view: \(error.readableName)"),
            ])

        case "menu":
            return try menuAction(element: element, params: params)

        case "list":
            let actions = AX.actions(element)
            var attributes: [JSONValue] = []
            var names: CFArray?
            if AXUIElementCopyAttributeNames(element, &names) == .success, let list = names as? [String] {
                attributes = list.map { JSONValue.string($0) }
            }
            return jsonObject([
                "actions": .array(actions.map { JSONValue.string($0) }),
                "attributes": .array(attributes),
            ])

        default:
            // Any other name is passed straight through, so callers can reach
            // vendor-specific actions without an engine change.
            let error = AX.perform(element, action)
            guard error == .success else {
                throw CuaError.operationFailed("action \"\(action)\" failed: \(error.readableName)")
            }
            return jsonObject(["performed": .bool(true), "action": .string(action)])
        }
    }

    /// Walk a menu path such as `["File", "Export", "PDF"]` and invoke the leaf.
    ///
    /// Menu items are unreachable through normal traversal because the menu bar
    /// only materializes open menus; resolving them explicitly by title is what
    /// makes menu-driven commands scriptable without stealing the pointer.
    private func menuAction(element: AXUIElement, params: ParamsReader) throws -> JSONValue {
        let path = try params.stringList("path")
        guard !path.isEmpty else {
            throw CuaError.invalidRequest("the menu action requires a non-empty \"path\" of menu titles")
        }
        var current = element

        // Start at the menu bar. An application element exposes it as a child;
        // a bare element (a window, a menu item) has no such child, so the
        // system-wide menu bar is the fallback for "the menu bar of whatever is
        // frontmost".
        let container: AXUIElement
        if let bar = AX.element(current, kAXMenuBarAttribute as String) {
            container = bar
        } else if let bar = AX.element(current, "AXMenuBar") {
            container = bar
        } else {
            let system = AXUIElementCreateSystemWide()
            AX.setMessagingTimeout(system, seconds: 2.0)
            guard let bar = AX.element(system, kAXMenuBarAttribute as String) else {
                return jsonObject([
                    "performed": .bool(false),
                    "reason": .string("no menu bar is reachable from this element; target an application instead"),
                ])
            }
            container = bar
        }
        let titles = path
        current = container

        var traversed: [JSONValue] = []
        for (index, title) in titles.enumerated() {
            let items = AXArray.elements(current, kAXChildrenAttribute as String)
            guard let match = items.first(where: { item in
                let itemTitle = AX.string(item, kAXTitleAttribute as String) ?? ""
                return itemTitle.compare(title, options: .caseInsensitive) == .orderedSame
            }) else {
                return jsonObject([
                    "performed": .bool(false),
                    "traversed": .array(traversed),
                    "reason": .string("no menu item titled \"\(title)\" under \(traversed.isEmpty ? "the menu bar" : "the open menu")"),
                ])
            }
            traversed.append(.string(title))
            if index == titles.count - 1 {
                let error = AX.perform(match, kAXPressAction as String)
                if error == .success {
                    return jsonObject(["performed": .bool(true), "path": .array(traversed)])
                }
                // Menus only respond while open; opening the parent and retrying
                // is what a real click does.
                if let parent = AX.element(match, "AXParent") {
                    AX.perform(parent, kAXPressAction as String)
                    Thread.sleep(forTimeInterval: 0.15)
                    let retry = AX.perform(match, kAXPressAction as String)
                    return jsonObject([
                        "performed": .bool(retry == .success),
                        "path": .array(traversed),
                        "reason": retry == .success ? nil : .string("menu item did not respond: \(error.readableName)"),
                    ])
                }
                return jsonObject([
                    "performed": .bool(false),
                    "path": .array(traversed),
                    "reason": .string("menu item did not respond: \(error.readableName)"),
                ])
            }
            // An intermediate item may be a submenu; open it to reach children.
            guard let submenu = AX.element(match, kAXChildrenAttribute as String) else {
                return jsonObject([
                    "performed": .bool(false),
                    "traversed": .array(traversed),
                    "reason": .string("menu item \"\(title)\" has no submenu"),
                ])
            }
            current = submenu
        }
        return jsonObject(["performed": .bool(false), "reason": .string("menu path was not resolved")])
    }

    // MARK: - Capture

    func screenshot(_ params: ParamsReader) async throws -> JSONValue {
        guard CGPreflightScreenCaptureAccess() else {
            throw CuaError.permissionDenied(
                "Screen Recording permission is required for screenshots. "
                    + Self.permissionHint(missing: [.string("screen_recording")])
            )
        }

        var request = Capture.Request(
            window: nil,
            display: nil,
            region: .zero,
            maxWidth: try params.int("maxWidth", default: 1568, in: 64...8_192),
            maxHeight: try params.int("maxHeight", default: 1568, in: 64...8_192),
            quality: try params.double("quality", default: 0.8, in: 0.1...1.0),
            format: params.string("format", default: "png"),
            showsCursor: params.bool("showCursor", default: false)
        )

        // Resolve what to capture, most specific first.
        let windowId = params.optionalInt("windowId")
        // A caller who names a rectangle is describing a place on the desktop.
        // Targeting the frontmost window by default would then reject the
        // request whenever that window happens to be on another display.
        let hasExplicitRegion = params.has("x") || params.has("y") || params.has("width") || params.has("height")
        let displayId = params.optionalInt("displayId")
        let pid = params.optionalInt("pid")
        let appQuery = params.optionalString("app")

        if let windowId {
            let id = CGWindowID(windowId)
            guard let entry = Self.windowEntry(windowId: id) else {
                throw CuaError.notFound("no on-screen window with id \(String(windowId)); list windows first")
            }
            guard let window = try await Capture.shareableWindow(id: id) else {
                throw CuaError.notFound("window \(String(windowId)) is not shareable (it may be off-screen or minimized)")
            }
            request.window = window
            request.region = entry.frame
        } else if let pid {
            let target = pid_t(pid)
            let application = AX.application(target)
            let windows = AXArray.elements(application, kAXWindowsAttribute as String)
            let wanted = params.optionalString("windowTitle")
            guard let chosen = await Self.pickWindow(pid: target, titleContains: wanted),
                  let cgId = Self.matchWindowID(pid: target, frame: chosen.frame),
                  let window = try await Capture.shareableWindow(id: cgId) else {
                throw CuaError.notFound("pid \(pid) has no capturable window\(wanted.map { " matching \"\($0)\"" } ?? "")")
            }
            request.window = window
            request.region = chosen.frame
        } else if let displayId {
            guard let display = try await Capture.shareableDisplay(id: CGDirectDisplayID(displayId)) else {
                throw CuaError.notFound("no display with id \(displayId)")
            }
            request.display = display
            request.region = display.frame
        } else if let appQuery {
            let apps = try resolveApplications(pid: nil, query: appQuery.lowercased(), includeBackground: params.bool("includeBackground", default: false))
            guard let app = apps.first else { throw CuaError.notFound("no application matches \"\(appQuery)\"") }
            guard let chosen = await Self.pickWindow(pid: app.processIdentifier) else {
                throw CuaError.notFound("no capturable window for \"\(appQuery)\"")
            }
            request.window = chosen.shareable
            request.region = chosen.frame
        } else if params.bool("frontmost", default: !hasExplicitRegion), let app = NSWorkspace.shared.frontmostApplication {
            if let chosen = await Self.pickWindow(pid: app.processIdentifier) {
                request.window = chosen.shareable
                request.region = chosen.frame
            } else {
                request.region = await Self.fallbackCaptureFrame()
            }
        } else {
            request.region = await Self.fallbackCaptureFrame()
        }

        // Apply an explicit region crop, expressed in screen points.
        let regionKeys = ["x", "y", "width", "height"].filter { params.has($0) }
        if !regionKeys.isEmpty {
            guard regionKeys.count == 4 else {
                throw CuaError.invalidRequest(
                    "a capture region needs all of x, y, width, and height; received \(regionKeys.joined(separator: ", "))"
                )
            }
            guard let x = params.optionalDouble("x"), let y = params.optionalDouble("y"),
                  let width = params.optionalDouble("width"), let height = params.optionalDouble("height") else {
                throw CuaError.invalidRequest("capture region values must be numbers")
            }
            guard width > 0, height > 0 else {
                throw CuaError.invalidRequest("region width and height must be positive")
            }
            if request.window != nil || request.display != nil {
                let clipped = CGRect(x: x, y: y, width: width, height: height)
                let outside = !request.region.intersects(clipped)
                guard !outside else {
                    throw CuaError.invalidRequest(
                        "the requested region \(clipped) lies outside the capture target \(request.region)"
                    )
                }
                request.region = clipped.intersection(request.region)
            } else {
                request.region = CGRect(x: x, y: y, width: width, height: height)
            }
        }

        let result = try await Capture.run(request)
        var members = result.objectValue ?? [:]
        members["app"] = NSWorkspace.shared.frontmostApplication?.localizedName.jsonField
        members["windowId"] = request.window.map { Int($0.windowID) }.jsonField
        // Which screen the capture came from, on-screen: on a multi-display setup
        // the caller needs to know where the pixels they are looking at live.
        var covering = request.display
        if covering == nil {
            let displays = (try? await Capture.displays()) ?? []
            covering = Capture.displayCovering(rect: request.region, among: displays)
        }
        members["displayId"] = covering.map { Int($0.displayID) }.jsonField
        return .object(members)
    }

    /// Every display with its geometry, density, and whether it is the main one.
    ///
    /// Density is reported as ScreenCaptureKit's own width/point ratio, which is
    /// informational only: the authoritative density of a specific capture is
    /// the `scale` the capture itself reports, because a window's backing scale
    /// can differ from its display's.
    func encode(display: SCDisplay, isMain: Bool) -> JSONValue {
        jsonObject([
            "displayId": .int(Int(display.displayID)),
            "frame": .array([
                .double(Double(display.frame.origin.x)), .double(Double(display.frame.origin.y)),
                .double(Double(display.frame.width)), .double(Double(display.frame.height)),
            ]),
            "reportedPixelWidth": .int(display.width),
            "reportedPixelHeight": .int(display.height),
            "reportedDensity": .double(
                Double(display.width) / max(Double(display.frame.width), 1)
            ),
            "main": .bool(isMain),
        ])
    }

    /// Every display with its geometry, density, and whether it is the main one.
    ///
    /// Density is ScreenCaptureKit's own width/point ratio, reported for
    /// orientation only: the authoritative density of a capture is the `scale`
    /// that capture reports, because a window's backing scale can differ from its
    /// display's.
    /// Choose the window a capture should use.
    ///
    /// `AXWindows` is not ordered by importance and its first entry is often a
    /// menu-bar or overlay item — on this machine the frontmost application's
    /// first accessibility window is the 33-point menu bar strip, so taking the
    /// first entry captures a sliver instead of the window. Preference order is
    /// the main window, then the focused one, then the largest, because a caller
    /// asking for "the window" means the one with content in it.
    ///
    /// - Returns: the chosen shareable window with its frame, or `nil` when the
    ///   application exposes nothing capturable.
    static func pickWindow(
        pid: pid_t,
        titleContains wanted: String? = nil
    ) async -> (shareable: SCWindow, frame: CGRect)? {
        let application = AX.application(pid)
        var candidates: [(window: AXUIElement, frame: CGRect, main: Bool, focused: Bool)] = []
        for window in AXArray.elements(application, kAXWindowsAttribute as String) {
            if let wanted {
                let title = AX.string(window, kAXTitleAttribute as String) ?? ""
                if !title.localizedCaseInsensitiveContains(wanted) { continue }
            }
            guard let frame = AX.frame(window), frame.width > 40, frame.height > 40 else { continue }
            candidates.append((
                window, frame,
                AX.bool(window, kAXMainAttribute as String) ?? false,
                AX.bool(window, kAXFocusedAttribute as String) ?? false
            ))
        }
        guard let best = candidates.max(by: { left, right in
            let leftScore = (left.main ? 2 : 0) + (left.focused ? 1 : 0)
            let rightScore = (right.main ? 2 : 0) + (right.focused ? 1 : 0)
            if leftScore != rightScore { return leftScore < rightScore }
            return (left.frame.width * left.frame.height) < (right.frame.width * right.frame.height)
        }) else { return nil }
        // Resolving the shareable window needs the window-server id, which only
        // the window list can map.
        guard let cgId = Self.matchWindowID(pid: pid, frame: best.frame),
              let shareable = try? await Capture.shareableWindow(id: cgId) else { return nil }
        return (shareable, best.frame)
    }

    /// The fallback capture target: the main display.
    ///
    /// Not the bounding box of all displays, which spans the gaps between them
    /// and therefore no display's own pixels.
    static func fallbackCaptureFrame() async -> CGRect {
        await Capture.mainDisplayFrame()
    }

    // MARK: - Applications and messaging

    func app(_ params: ParamsReader) async throws -> JSONValue {
        let action = params.string("action", default: "list")
        switch action {
        case "list":
            return try listApps(params)

        case "activate", "focus":
            try requireAccessibility("Activating and raising a window")
            let (app, window) = try resolveAppAndWindow(params)
            // Raising the window through accessibility is deliberate: it is the
            // same call the Dock makes, it needs only Accessibility permission,
            // and unlike `NSRunningApplication.activate` it also brings a
            // specific window forward.
            var raised: JSONValue = .bool(false)
            if let window {
                let error = AX.perform(window, kAXRaiseAction as String)
                raised = .bool(error == .success)
                AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
                AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            }
            // `activateIgnoringOtherApps` is deprecated and a no-op on macOS 14+;
            // raising the window through accessibility above is what actually
            // brings a specific window forward.
            let activated = app.activate()
            return jsonObject([
                "activated": .bool(activated),
                "raised": raised,
                "name": .string(app.localizedName ?? ""),
                "pid": .int(Int(app.processIdentifier)),
            ])

        case "hide":
            let app = try resolveApplication(params)
            // `NSRunningApplication.hide()` returns false and leaves the
            // application visible on current macOS, so the state is read back
            // rather than trusted, and a real failure comes with a reason.
            let requested = app.hide()
            try? await Task.sleep(nanoseconds: 300_000_000)
            let hidden = app.isHidden
            var members: [String: JSONValue?] = [
                "hidden": .bool(hidden),
                "name": .string(app.localizedName ?? ""),
            ]
            if !hidden {
                members["reason"] = .string(
                    requested
                        ? "the hide request was accepted but \(app.localizedName ?? "the application") is still visible"
                        : "macOS refused to hide \(app.localizedName ?? "the application"); "
                            + "hiding is unavailable here. Use action=activate on the application you want in front instead."
                )
            }
            return jsonObject(members)

        case "unhide":
            let app = try resolveApplication(params)
            let requested = app.unhide()
            try? await Task.sleep(nanoseconds: 300_000_000)
            let visible = !app.isHidden
            var members: [String: JSONValue?] = [
                "unhidden": .bool(visible),
                "name": .string(app.localizedName ?? ""),
            ]
            if !visible {
                members["reason"] = .string(
                    requested
                        ? "the unhide request was accepted but \(app.localizedName ?? "the application") is still hidden"
                        : "macOS refused to unhide \(app.localizedName ?? "the application")"
                )
            }
            return jsonObject(members)

        case "quit":
            let app = try resolveApplication(params)
            let forced = params.bool("force", default: false)
            let terminated = forced ? app.forceTerminate() : app.terminate()
            return jsonObject([
                "terminated": .bool(terminated),
                "forced": .bool(forced),
                "name": .string(app.localizedName ?? ""),
                "pid": .int(Int(app.processIdentifier)),
            ])

        case "launch":
            let bundleId = try params.nonEmptyString("bundleId")
            return AppleEvents.launch(bundleId: bundleId)

        case "openURL", "openUrl":
            let url = try params.nonEmptyString("url")
            return AppleEvents.open(url: url, bundleId: params.optionalString("bundleId"))

        case "reveal":
            let path = try params.nonEmptyString("path")
            return AppleEvents.reveal(path: path)

        case "script":
            let source = try params.nonEmptyString("script")
            let bundleId = params.optionalString("bundleId")
            let timeout = try params.int("timeoutSeconds", default: 30, in: 1...600)
            return AppleEvents.runScript(source: source, bundleId: bundleId, timeoutSeconds: timeout)

        case "menu":
            let app = try resolveApplication(params)
            let application = AX.application(app.processIdentifier)
            let path = try params.stringList("path")
            guard !path.isEmpty else {
                throw CuaError.invalidRequest("the menu action requires a non-empty \"path\" of menu titles")
            }
            _ = try menuAction(element: application, params: params)
            return jsonObject(["requested": .bool(true), "path": .array(path.map { JSONValue.string($0) })])

        default:
            throw CuaError.invalidRequest(
                "unknown app action \"\(action)\"; expected list, activate, hide, unhide, quit, launch, openURL, reveal, script, or menu"
            )
        }
    }

    /// Resolve one application from `pid`, `app`, or the frontmost fallback.
    func resolveApplication(_ params: ParamsReader) throws -> NSRunningApplication {
        if let pid = params.optionalInt("pid"), let app = NSRunningApplication(processIdentifier: pid_t(pid)) {
            return app
        }
        if let query = params.optionalString("app") {
            let matches = try resolveApplications(
                pid: nil,
                query: query.lowercased(),
                includeBackground: params.bool("includeBackground", default: false)
            )
            guard let first = matches.first else {
                throw CuaError.notFound("no running application matches \"\(query)\"")
            }
            return first
        }
        if let bundleId = params.optionalString("bundleId"),
           let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
            return app
        }
        guard let frontmost = NSWorkspace.shared.frontmostApplication else {
            throw CuaError.notFound("no application matched the request and no frontmost application is available")
        }
        return frontmost
    }

    /// Resolve an application plus the window the request refers to.
    func resolveAppAndWindow(_ params: ParamsReader) throws -> (NSRunningApplication, AXUIElement?) {
        let app = try resolveApplication(params)
        let application = AX.application(app.processIdentifier)
        if let title = params.optionalString("windowTitle") {
            for window in AXArray.elements(application, kAXWindowsAttribute as String) {
                let windowTitle = AX.string(window, kAXTitleAttribute as String) ?? ""
                if windowTitle.localizedCaseInsensitiveContains(title) {
                    return (app, window)
                }
            }
            throw CuaError.notFound("no window of \(app.localizedName ?? "the application") matches \"\(title)\"")
        }
        let main = AX.element(application, kAXMainAttribute as String)
            ?? AX.element(application, kAXFocusedWindowAttribute as String)
        if let main { return (app, main) }
        return (app, AX.elements(application, kAXWindowsAttribute as String).first)
    }
}
