import Foundation
import ApplicationServices

/// Helpers for reading CoreFoundation arrays returned by the accessibility API.
///
/// The C API hands back `CFArray` of `AXUIElement` refs. Bridging that into a
/// Swift array costs a retain/release per node, which is measurable on a tree
/// with thousands of nodes, so traversal reads the array in place instead.
enum AXArray {
    /// The byte order constant used to decode `AXUIElementGetPid`.
    static let hostByteOrder: CFByteOrder = CFByteOrderGetCurrent()

    /// Apply a body to every `AXUIElement` in a `CFArray`, without bridging.
    static func forEachElement(_ array: CFArray, _ body: (AXUIElement) -> Void) {
        let count = CFArrayGetCount(array)
        guard count > 0 else { return }
        var buffer = [UnsafeRawPointer?](repeating: nil, count: count)
        CFArrayGetValues(array, CFRange(location: 0, length: count), &buffer)
        for pointer in buffer {
            guard let pointer else { continue }
            body(unsafeBitCast(pointer, to: AXUIElement.self))
        }
    }

    /// Read a `CFArray` attribute of an element as an `AXUIElement` list.
    static func elements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
        var out: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &out) == .success,
              let raw = out, CFGetTypeID(raw) == CFArrayGetTypeID() else { return [] }
        let array = unsafeBitCast(raw, to: CFArray.self)
        var result: [AXUIElement] = []
        result.reserveCapacity(CFArrayGetCount(array))
        forEachElement(array) { result.append($0) }
        return result
    }

    /// Stable identity of an element as `"<pid>:<pointer>"`.
    ///
    /// Accessibility elements are CoreFoundation objects, not references into
    /// the target process, so this identity is unique among live elements and
    /// meaningful only until the target is relaunched. It is used for addressing
    /// nodes inside one engine session, never persisted.
    static func pointerIdentity(of element: AXUIElement, pid: pid_t) -> String {
        let number = UInt(bitPattern: Unmanaged.passUnretained(element).toOpaque())
        return "\(pid):\(String(number, radix: 16))"
    }
}

extension TreeDump {
    /// The identity map backing pointer addressing for one dump.
    static func pointerIdentities(for elements: [AXUIElement], pid: pid_t) -> [String: AXUIElement] {
        var map: [String: AXUIElement] = [:]
        map.reserveCapacity(elements.count)
        for element in elements {
            map[AXArray.pointerIdentity(of: element, pid: pid)] = element
        }
        return map
    }
}
