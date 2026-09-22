import Foundation
import ApplicationServices
import CoreGraphics

/// Thin helpers over the C Accessibility API.
///
/// Every call can fail because the target application owns the response: it may
/// refuse an attribute, be busy, or have gone away. Returning `nil`/empty for
/// those cases keeps traversal alive without pretending the data was read.
enum AX {
    /// Cross-process calls against an unresponsive app otherwise stall for the
    /// default 6 seconds; the engine's own budgets need them shorter.
    static func setMessagingTimeout(_ element: AXUIElement, seconds: Float) {
        AXUIElementSetMessagingTimeout(element, seconds)
    }

    /// The application element for a process.
    static func application(_ pid: pid_t) -> AXUIElement {
        let element = AXUIElementCreateApplication(pid)
        setMessagingTimeout(element, seconds: 2.0)
        return element
    }

    /// Read one attribute as an opaque value.
    static func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var out: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &out) == .success else {
            return nil
        }
        return out
    }

    /// Read one attribute as a string.
    static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        value(element, attribute) as? String
    }

    /// Read one attribute as a boolean.
    static func bool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        (value(element, attribute) as? NSNumber)?.boolValue
    }

    /// Read one attribute as a number.
    static func number(_ element: AXUIElement, _ attribute: String) -> Double? {
        (value(element, attribute) as? NSNumber)?.doubleValue
    }

    /// Read one attribute as an element.
    static func element(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let raw = value(element, attribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            return nil
        }
        return (raw as! AXUIElement)
    }

    /// Read one attribute as an element list.
    static func elements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
        guard let raw = value(element, attribute) as? [AXUIElement] else { return [] }
        return raw
    }

    /// Whether a value carries the `AXValue` payload for a geometric attribute.
    static func isAXValue(_ raw: CFTypeRef) -> Bool {
        CFGetTypeID(raw) == AXValueGetTypeID()
    }

    /// Read a point-valued attribute such as `AXPosition`.
    static func point(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        guard let raw = value(element, attribute), isAXValue(raw) else { return nil }
        var point = CGPoint.zero
        guard AXValueGetValue((raw as! AXValue), .cgPoint, &point) else { return nil }
        return point
    }

    /// Read a size-valued attribute such as `AXSize`.
    static func size(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        guard let raw = value(element, attribute), isAXValue(raw) else { return nil }
        var size = CGSize.zero
        guard AXValueGetValue((raw as! AXValue), .cgSize, &size) else { return nil }
        return size
    }

    /// Read the position and size attributes as one frame in top-left global
    /// coordinates, the same space `CGWindowListCopyWindowInfo` reports.
    static func frame(_ element: AXUIElement) -> CGRect? {
        guard let origin = point(element, kAXPositionAttribute as String),
              let size = size(element, kAXSizeAttribute as String) else { return nil }
        return CGRect(origin: origin, size: size)
    }

    /// Perform one named action.
    @discardableResult
    static func perform(_ element: AXUIElement, _ action: String) -> AXError {
        AXUIElementPerformAction(element, action as CFString)
    }

    /// The action names the element advertises.
    static func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    /// Whether the element is a valid target right now.
    static func isValid(_ element: AXUIElement) -> Bool {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) != .invalidUIElement
    }
}

extension AXError {
    /// A short human-readable explanation used in tool failures.
    var readableName: String {
        switch self {
        case .success: return "success"
        case .failure: return "failure"
        case .illegalArgument: return "illegal argument"
        case .invalidUIElement: return "the element is no longer valid"
        case .invalidUIElementObserver: return "invalid observer"
        case .cannotComplete: return "the application did not respond"
        case .attributeUnsupported: return "the attribute is not supported"
        case .actionUnsupported: return "the action is not supported"
        case .notificationUnsupported: return "the notification is not supported"
        case .notImplemented: return "the application does not implement accessibility"
        case .notificationAlreadyRegistered: return "already registered"
        case .notificationNotRegistered: return "not registered"
        case .apiDisabled: return "the accessibility API is disabled for this process"
        case .noValue: return "the attribute has no value"
        case .parameterizedAttributeUnsupported: return "the parameterized attribute is not supported"
        case .notEnoughPrecision: return "not enough precision"
        @unknown default: return "unknown accessibility error \(rawValue)"
        }
    }
}
