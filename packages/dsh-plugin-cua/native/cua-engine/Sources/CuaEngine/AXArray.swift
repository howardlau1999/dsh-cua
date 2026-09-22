import Foundation
import ApplicationServices

/// Helpers for reading CoreFoundation arrays returned by the accessibility API.
///
/// The C API hands back `CFArray` of `AXUIElement` refs. Bridging that into a
/// Swift array costs a retain/release per node, which is measurable on a tree
/// with thousands of nodes, so traversal reads the array in place instead.
enum AXArray {
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

}
