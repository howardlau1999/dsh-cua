import Foundation
import CoreGraphics
import ApplicationServices

/// Synthetic pointer input through Quartz event taps.
///
/// Two delivery routes exist and both are exposed because they trade off
/// differently: `post` writes to the session event stream exactly like a real
/// mouse (goes through the window server, moves the visible cursor, reaches the
/// app the user is actually looking at), while `pid` targets one process
/// directly (leaves the cursor untouched, reaches background windows, and is the
/// only way to drive an app that is not frontmost without stealing focus).
enum Pointer {
    /// Delivery route for generated events.
    enum Route: String {
        /// Session event stream; equivalent to a physical mouse.
        case post
        /// Directly to one process; does not move the visible cursor.
        case pid
    }

    /// One pointer request.
    struct Command {
        var route: Route = .post
        var button: String = "left"
        var targetPid: pid_t?
    }

    /// The Quartz button number for a name.
    static func buttonNumber(_ name: String) -> CGMouseButton? {
        switch name {
        case "left": return .left
        case "right": return .right
        case "middle", "center": return .center
        default: return nil
        }
    }

    /// Move the pointer to a point.
    @discardableResult
    static func move(to point: CGPoint, command: Command) -> JSONValue {
        let button = buttonNumber(command.button) ?? .left
        guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                  mouseCursorPosition: point, mouseButton: button) else {
            return jsonObject(["delivered": .bool(false)])
        }
        deliver(event, command: command)
        return jsonObject([
            "delivered": .bool(true),
            "x": .double(Double(point.x)),
            "y": .double(Double(point.y)),
            "route": .string(command.route.rawValue),
        ])
    }

    /// Click at a point, optionally multiple times.
    ///
    /// `clickCount` is set on every event of the sequence: a double-click is one
    /// down/up pair at state 1 followed by a second pair at state 2, which is
    /// what AppKit uses to synthesize `doubleAction`.
    static func click(at point: CGPoint, count: Int, command: Command, holdMs: Int) -> JSONValue {
        guard let button = buttonNumber(command.button) else {
            return jsonObject(["delivered": .bool(false)])
        }
        let (down, up) = mouseTypes(button)
        move(to: point, command: command)
        for click in 1...max(1, count) {
            guard let downEvent = CGEvent(mouseEventSource: nil, mouseType: down,
                                          mouseCursorPosition: point, mouseButton: button),
                  let upEvent = CGEvent(mouseEventSource: nil, mouseType: up,
                                        mouseCursorPosition: point, mouseButton: button) else {
                return jsonObject(["delivered": .bool(false)])
            }
            downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            deliver(downEvent, command: command)
            if holdMs > 0 { Thread.sleep(forTimeInterval: Double(holdMs) / 1000.0) }
            deliver(upEvent, command: command)
            if click < count { Thread.sleep(forTimeInterval: 0.02) }
        }
        return jsonObject([
            "delivered": .bool(true),
            "x": .double(Double(point.x)),
            "y": .double(Double(point.y)),
            "button": .string(command.button),
            "clickCount": .int(max(1, count)),
            "route": .string(command.route.rawValue),
        ])
    }

    /// Press or release a button without moving the pointer first.
    static func button(_ action: String, at point: CGPoint, command: Command) -> JSONValue {
        guard let button = buttonNumber(command.button) else {
            return jsonObject(["delivered": .bool(false)])
        }
        let (down, up) = mouseTypes(button)
        let type = action == "down" ? down : up
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                                  mouseCursorPosition: point, mouseButton: button) else {
            return jsonObject(["delivered": .bool(false)])
        }
        if action == "down" { event.setIntegerValueField(.mouseEventClickState, value: 1) }
        deliver(event, command: command)
        return jsonObject([
            "delivered": .bool(true),
            "action": .string(action),
            "x": .double(Double(point.x)),
            "y": .double(Double(point.y)),
            "route": .string(command.route.rawValue),
        ])
    }

    /// Press, move through waypoints, release. Used for drag-and-drop, sliders,
    /// and text selection.
    static func drag(from start: CGPoint, through waypoints: [CGPoint], command: Command, durationMs: Int) -> JSONValue {
        guard let button = buttonNumber(command.button) else {
            return jsonObject(["delivered": .bool(false)])
        }
        let (down, up) = mouseTypes(button)
        let steps = max(1, waypoints.count)
        let perStep = max(1, durationMs) / steps

        move(to: start, command: command)
        guard let downEvent = CGEvent(mouseEventSource: nil, mouseType: down,
                                      mouseCursorPosition: start, mouseButton: button) else {
            return jsonObject(["delivered": .bool(false)])
        }
        downEvent.setIntegerValueField(.mouseEventClickState, value: 1)
        deliver(downEvent, command: command)

        for waypoint in waypoints {
            guard let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged,
                                          mouseCursorPosition: waypoint, mouseButton: button) else { continue }
            deliver(moveEvent, command: command)
            Thread.sleep(forTimeInterval: Double(perStep) / 1000.0)
        }

        let end = waypoints.last ?? start
        guard let upEvent = CGEvent(mouseEventSource: nil, mouseType: up,
                                    mouseCursorPosition: end, mouseButton: button) else {
            return jsonObject(["delivered": .bool(false)])
        }
        deliver(upEvent, command: command)
        return jsonObject([
            "delivered": .bool(true),
            "from": .array([.double(Double(start.x)), .double(Double(start.y))]),
            "to": .array([.double(Double(end.x)), .double(Double(end.y))]),
            "steps": .int(steps),
            "route": .string(command.route.rawValue),
        ])
    }

    /// Scroll at a point.
    ///
    /// `dy` follows screen convention: positive scrolls content down (the
    /// gesture a user makes to move further down a page).
    static func scroll(at point: CGPoint, dx: Double, dy: Double, command: Command) -> JSONValue {
        move(to: point, command: command)
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                                  wheelCount: 2, wheel1: Int32(dy.rounded()),
                                  wheel2: Int32(dx.rounded()), wheel3: 0) else {
            return jsonObject(["delivered": .bool(false)])
        }
        event.location = point
        deliver(event, command: command)
        return jsonObject([
            "delivered": .bool(true),
            "dx": .double(dx),
            "dy": .double(dy),
            "x": .double(Double(point.x)),
            "y": .double(Double(point.y)),
        ])
    }

    /// The down/up event types for a button.
    private static func mouseTypes(_ button: CGMouseButton) -> (CGEventType, CGEventType) {
        switch button {
        case .right: return (.rightMouseDown, .rightMouseUp)
        case .center: return (.otherMouseDown, .otherMouseUp)
        default: return (.leftMouseDown, .leftMouseUp)
        }
    }

    /// Send one event on the requested route.
    private static func deliver(_ event: CGEvent, command: Command) {
        switch command.route {
        case .post:
            event.post(tap: .cghidEventTap)
        case .pid:
            if let pid = command.targetPid {
                event.postToPid(pid)
            } else {
                event.post(tap: .cghidEventTap)
            }
        }
    }
}
