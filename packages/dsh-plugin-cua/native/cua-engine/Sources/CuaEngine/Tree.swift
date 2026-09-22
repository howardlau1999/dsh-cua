import Foundation
import ApplicationServices
import CoreGraphics

/// Accessibility tree traversal.
///
/// A full macOS accessibility tree is far larger than any model budget — a
/// single browser window can expose tens of thousands of nodes — so the dump is
/// deliberately lossy in three explicit ways: structural wrappers are dropped
/// (their depth is folded into their children), every string is capped, and the
/// traversal stops at whichever of node/depth/time budget runs out first. The
/// result always reports which budget stopped it, so a model can narrow the
/// query instead of assuming it saw everything.
enum TreeDump {
    /// Per-string cap; long document bodies are the main payload risk.
    static let defaultTextLimit = 200
    /// Node budget default; enough for a deep app window, small enough to stay
    /// inside a single tool result.
    static let defaultNodeLimit = 1200
    /// Wall-clock budget for bouncing between the engine and the target app.
    static let defaultTimeBudget: TimeInterval = 8.0

    /// Attributes read for every visited element, in one cross-process call.
    ///
    /// These are all "always supported, cheap" attributes; `AXChildren` is read
    /// separately because it is the expensive one and only needed to descend.
    static let cachedAttributes: [String] = [
        kAXRoleAttribute as String,
        kAXSubroleAttribute as String,
        kAXRoleDescriptionAttribute as String,
        kAXTitleAttribute as String,
        kAXValueAttribute as String,
        kAXDescriptionAttribute as String,
        kAXHelpAttribute as String,
        kAXIdentifierAttribute as String,
        "AXDOMIdentifier",
        "AXDOMClassList",
        kAXEnabledAttribute as String,
        kAXFocusedAttribute as String,
        kAXSelectedAttribute as String,
        kAXPositionAttribute as String,
        kAXSizeAttribute as String,
        kAXPlaceholderValueAttribute as String,
        "AXURL",
        "AXValueDescription",
        "AXMaxValue",
        "AXMinValue",
        "AXSelectedText",
        "AXFilename",
    ]

    /// Roles that carry no information of their own; their children are
    /// re-parented and their depth is not counted.
    static let structuralRoles: Set<String> = [
        "AXGroup", "AXUnknown", "AXLayoutArea", "AXLayoutItem", "AXSplitGroup",
        "AXScrollArea", "AXList", "AXOutline", "AXTable", "AXBrowser", "AXColumn",
        "AXRow", "AXGrid", "AXSection", "AXLandmarkRegion", "AXLandmarkGroup",
    ]

    /// Roles a model can act on. `actionable` is reported so a caller can find
    /// the clickable/toggleable subset without guessing from role names.
    static let interactiveRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
        "AXMenuItem", "AXMenuBarItem", "AXTextField", "AXTextArea", "AXSearchField",
        "AXSlider", "AXIncrementor", "AXComboBox", "AXLink", "AXTab", "AXDisclosureTriangle",
        "AXSegmentedControl", "AXColorWell", "AXToolbarButton", "AXSwitch", "AXToggle",
        "AXDockItem", "AXCell", "AXTreeItem", "AXRow", "AXWebArea",
    ]

    /// Attributes whose presence makes an otherwise-plain node worth keeping.
    static let textAttributes: [String] = [
        kAXTitleAttribute as String,
        kAXValueAttribute as String,
        "AXDescription",
        kAXPlaceholderValueAttribute as String,
        "AXURL",
        "AXFilename",
    ]

    /// One pending element plus the path that reached it.
    struct Visit {
        let element: AXUIElement
        let depth: Int
        let priority: Int
        /// Roles of the ancestors, nearest last.
        let ancestors: [String]
        /// Whether each ancestor was itself emitted, aligned with `ancestors`.
        let ancestorEmitted: [Bool]
    }

    /// One visited element with its cached attributes.
    struct Node {
        let depth: Int
        let element: AXUIElement
        let attributes: [String: JSONValue]
        let frame: CGRect?

        var role: String { attributes[kAXRoleAttribute as String]?.stringValue ?? "" }
    }

    /// The traversal outcome handed back to the caller.
    struct Result {
        let nodes: [JSONValue]
        let visited: Int
        let truncatedBy: String?
        let elapsed: TimeInterval
        let format: String
        /// Flat element list backing index addressing until the next dump of the
        /// same process.
        let elements: [AXUIElement]
    }

    /// Walk one application or window subtree.
    ///
    /// - Parameters:
    ///   - root: the application or window element to start from.
    ///   - options: traversal filters and budgets.
    /// - Returns: the emitted nodes plus the budget that stopped the walk.
    static func walk(root: AXUIElement, options: Options) -> Result {
        let started = Date()
        var visited = 0
        var emitted: [Node] = []
        var elementIndex: [AXUIElement] = []
        var truncatedBy: String?
        // Priority breaks ties toward the content a caller almost always means.
        // Each entry carries the role path that reached it, which is what lets a
        // role filter keep a match's true ancestors instead of every text-bearing
        // element in the tree.
        var queue: [Visit] = [Visit(element: root, depth: 0, priority: 0, ancestors: [], ancestorEmitted: [])]

        AX.setMessagingTimeout(root, seconds: 2.0)

        while !queue.isEmpty {
            if Date().timeIntervalSince(started) > options.timeBudget {
                truncatedBy = "time_budget"
                break
            }
            if visited >= options.visitLimit {
                truncatedBy = "visit_limit"
                break
            }
            let visit = queue.removeFirst()
            let element = visit.element
            let depth = visit.depth
            visited += 1

            // The timeout is per element, so a deep tree would otherwise fall back
            // to the 6-second default exactly where responsiveness matters most.
            AX.setMessagingTimeout(element, seconds: 2.0)
            let attributes = readAttributes(element)
            let frame = geometry(from: attributes)
            let role = attributes[kAXRoleAttribute as String]?.stringValue ?? ""

            let structural = structuralRoles.contains(role)
            var emittedHere = false
            if options.includeStructural || !structural {
                if shouldEmit(attributes: attributes, role: role, options: options, visit: visit) {
                    emittedHere = true
                    let node = Node(depth: depth, element: element, attributes: attributes, frame: frame)
                    emitted.append(node)
                    elementIndex.append(element)
                    if emitted.count >= options.nodeLimit {
                        truncatedBy = "node_limit"
                        break
                    }
                }
            }

            // A structural node does not consume depth: its children replace it.
            let childDepth = structural && !options.includeStructural ? depth : depth + 1
            guard childDepth <= options.maxDepth else { continue }
            let childAncestors = visit.ancestors + [role]
            let childEmitted = visit.ancestorEmitted + [emittedHere]
            var batch: [Visit] = []
            for child in AXArray.elements(element, kAXChildrenAttribute as String) {
                let childRole = AX.string(child, kAXRoleAttribute as String) ?? ""
                // The menu bar is a sibling of the window list. It is dozens of
                // nodes of chrome that no caller wants before the content, so it
                // sorts last instead of consuming the budget front-first.
                if options.skipMenuBar, childRole == "AXMenuBar" { continue }
                batch.append(Visit(element: child, depth: childDepth,
                                   priority: Self.visitPriority(childRole),
                                   ancestors: childAncestors, ancestorEmitted: childEmitted))
            }
            if batch.count > 1 {
                batch.sort { $0.priority < $1.priority }
            }
            queue.append(contentsOf: batch)
        }

        let nodes = emitted.map { encode($0, options: options) }
        return Result(
            nodes: nodes,
            visited: visited,
            truncatedBy: truncatedBy,
            elapsed: Date().timeIntervalSince(started),
            format: options.format,
            elements: elementIndex
        )
    }

    /// Lower sorts earlier. Windows and sheets are what a caller means by "the
    /// app"; decorative and overlay chrome comes after.
    static func visitPriority(_ role: String) -> Int {
        switch role {
        case "AXWindow", "AXSheet", "AXDialog":
            return 0
        case "AXMenuBar", "AXMenuBarItem", "AXMenu":
            return 2
        default:
            return 1
        }
    }

    /// Traversal knobs.
    struct Options {
        var maxDepth: Int = 8
        var nodeLimit: Int = defaultNodeLimit
        var visitLimit: Int = 40_000
        var timeBudget: TimeInterval = defaultTimeBudget
        var includeStructural: Bool = false
        var interactiveOnly: Bool = false
        var textLimit: Int = defaultTextLimit
        var includeGeometry: Bool = false
        var format: String = "outline"
        var roleFilter: Set<String> = []
        /// Menu bars are skipped by default; an explicit request still gets them.
        var skipMenuBar: Bool = true
    }

    // MARK: - Attribute reading

    /// Read the cached attribute set in one cross-process round trip.
    ///
    /// `AXUIElementCopyMultipleAttributeValues` returns one entry per requested
    /// attribute in request order, with `AXValue`-typed geometry still wrapped.
    /// Decoding it here rather than storing the wrapper keeps the rest of the
    /// traversal free of CoreFoundation types.
    static func readAttributes(_ element: AXUIElement) -> [String: JSONValue] {
        var raw: CFArray?
        let names = cachedAttributes as CFArray
        let error = AXUIElementCopyMultipleAttributeValues(element, names, [], &raw)
        guard error == .success, let pairs = raw as? [Any] else { return [:] }
        var attributes: [String: JSONValue] = [:]
        for (index, name) in cachedAttributes.enumerated() where index < pairs.count {
            let value = pairs[index] as CFTypeRef
            if CFGetTypeID(value) == CFNullGetTypeID() { continue }
            if let text = value as? String {
                if !text.isEmpty { attributes[name] = .string(text) }
                continue
            }
            if let list = value as? [String] {
                if !list.isEmpty { attributes[name] = .string(list.joined(separator: " ")) }
                continue
            }
            if let number = value as? NSNumber {
                // Booleans and numbers share `NSNumber`; both are stored as the
                // boolean reading, which is how every cached flag is consumed.
                attributes[name] = .bool(number.boolValue)
                continue
            }
            if CFGetTypeID(value) == AXValueGetTypeID(), let geometry = geometryValue(value) {
                attributes[name] = geometry
            }
        }
        return attributes
    }

    /// Convert a geometric `AXValue` into a two-element JSON array.
    private static func geometryValue(_ raw: CFTypeRef) -> JSONValue? {
        let value = raw as! AXValue
        switch AXValueGetType(value) {
        case .cgPoint:
            var point = CGPoint.zero
            guard AXValueGetValue(value, .cgPoint, &point) else { return nil }
            return .array([.double(Double(point.x)), .double(Double(point.y))])
        case .cgSize:
            var size = CGSize.zero
            guard AXValueGetValue(value, .cgSize, &size) else { return nil }
            return .array([.double(Double(size.width)), .double(Double(size.height))])
        case .cgRect:
            var rect = CGRect.zero
            guard AXValueGetValue(value, .cgRect, &rect) else { return nil }
            return .array([
                .double(Double(rect.origin.x)), .double(Double(rect.origin.y)),
                .double(Double(rect.width)), .double(Double(rect.height)),
            ])
        default:
            return nil
        }
    }

    /// Decode the geometric attributes into a rectangle.
    static func geometry(from attributes: [String: JSONValue]) -> CGRect? {
        guard let origin = pointValue(attributes[kAXPositionAttribute as String]),
              let size = sizeValue(attributes[kAXSizeAttribute as String]) else { return nil }
        return CGRect(origin: origin, size: size)
    }

    private static func pointValue(_ value: JSONValue?) -> CGPoint? {
        guard case .array(let items)? = value, items.count == 2,
              let x = items[0].doubleValue, let y = items[1].doubleValue else { return nil }
        return CGPoint(x: x, y: y)
    }

    private static func sizeValue(_ value: JSONValue?) -> CGSize? {
        guard case .array(let items)? = value, items.count == 2,
              let width = items[0].doubleValue, let height = items[1].doubleValue else { return nil }
        return CGSize(width: width, height: height)
    }

    // MARK: - Filtering

    /// Whether one visited element earns a line in the output.
    ///
    /// With a role filter, a non-matching element is kept only when it is the
    /// structural anchor of a matching subtree — the way an HTML selector keeps
    /// the path above a match. Two extremes are both wrong: keeping every
    /// element that carries text retains almost the whole tree (a container's
    /// title is text too), and keeping only an unbroken chain of structural
    /// wrappers drops the window the match lives in.
    ///
    /// The rule is therefore: keep a structural element that a filtered-out
    /// matching chain descends from, and not the wrappers below it.
    static func shouldEmit(
        attributes: [String: JSONValue],
        role: String,
        options: Options,
        visit: Visit? = nil
    ) -> Bool {
        if !options.roleFilter.isEmpty && !options.roleFilter.contains(role) {
            guard structuralRoles.contains(role) else { return false }
            guard let visit else { return true }
            // A structural ancestor above the match anchors the path; a second
            // one below it is layout noise.
            let structuralAncestors = zip(visit.ancestors, visit.ancestorEmitted)
                .filter { structuralRoles.contains($0.0) && $0.1 }
            return structuralAncestors.isEmpty
        }
        if options.interactiveOnly {
            return interactiveRoles.contains(role)
                || attributes[kAXFocusedAttribute as String]?.boolValue == true
        }
        if interactiveRoles.contains(role) { return true }
        if attributes[kAXFocusedAttribute as String]?.boolValue == true { return true }
        for attribute in textAttributes where attributes[attribute] != nil { return true }
        return false
    }

    // MARK: - Encoding

    /// Encode one node for the wire, applying text caps.
    static func encode(_ node: Node, options: Options) -> JSONValue {
        let attributes = node.attributes
        var members: [String: JSONValue?] = [:]
        members["role"] = attributes[kAXRoleAttribute as String]
        members["subrole"] = attributes[kAXSubroleAttribute as String]
        let roleDescription = attributes[kAXRoleDescriptionAttribute as String]?.stringValue
        let role = attributes[kAXRoleAttribute as String]?.stringValue ?? ""
        if let roleDescription, roleDescription != role { members["roleDescription"] = .string(roleDescription) }
        members["title"] = cap(attributes[kAXTitleAttribute as String]?.stringValue, options.textLimit)
        members["value"] = cap(attributes[kAXValueAttribute as String]?.stringValue, options.textLimit)
        members["description"] = cap(attributes[kAXDescriptionAttribute as String]?.stringValue, options.textLimit)
        members["help"] = cap(attributes[kAXHelpAttribute as String]?.stringValue, options.textLimit)
        members["placeholder"] = cap(attributes[kAXPlaceholderValueAttribute as String]?.stringValue, options.textLimit)
        members["identifier"] = attributes[kAXIdentifierAttribute as String]
        members["domIdentifier"] = attributes["AXDOMIdentifier"]
        members["domClasses"] = attributes["AXDOMClassList"]
        members["url"] = cap(attributes["AXURL"]?.stringValue, options.textLimit)
        if interactiveRoles.contains(role) { members["actionable"] = .bool(true) }
        if attributes[kAXEnabledAttribute as String]?.boolValue == false { members["enabled"] = .bool(false) }
        if attributes[kAXFocusedAttribute as String]?.boolValue == true { members["focused"] = .bool(true) }
        if attributes[kAXSelectedAttribute as String]?.boolValue == true { members["selected"] = .bool(true) }
        if options.includeGeometry, let frame = node.frame {
            members["frame"] = .array([
                .int(Int(frame.origin.x.rounded())),
                .int(Int(frame.origin.y.rounded())),
                .int(Int(frame.width.rounded())),
                .int(Int(frame.height.rounded())),
            ])
        }
        members["depth"] = .int(node.depth)
        return jsonObject(members)
    }

    /// Truncate a string to a grapheme-safe prefix.
    static func cap(_ text: String?, _ limit: Int) -> JSONValue? {
        guard let text, !text.isEmpty else { return nil }
        guard limit > 0 else { return nil }
        if text.count <= limit { return .string(text) }
        return .string(String(text.prefix(limit)) + "…")
    }

    /// Render nodes as an indented outline for the model-facing result.
    ///
    /// An outline beats raw JSON here: it costs one line per node instead of one
    /// object per node, and indentation carries the parent/child relation that a
    /// flat array would otherwise spend tokens restating.
    static func outline(_ nodes: [JSONValue]) -> String {
        var lines: [String] = []
        lines.reserveCapacity(nodes.count)
        for (index, node) in nodes.enumerated() {
            guard let members = node.objectValue else { continue }
            let depth = members["depth"]?.intValue ?? 0
            var label = members["role"]?.stringValue ?? "?"
            if let subrole = members["subrole"]?.stringValue, !subrole.isEmpty {
                label += "/\(subrole)"
            }
            var details: [String] = []
            for key in ["title", "value", "description", "placeholder"] {
                guard let text = members[key]?.stringValue, !text.isEmpty else { continue }
                details.append("\(key)=\(quoted(text))")
            }
            if let url = members["url"]?.stringValue, !url.isEmpty { details.append("url=\(quoted(url))") }
            if members["actionable"] != nil { details.append("actionable") }
            if members["enabled"]?.boolValue == false { details.append("disabled") }
            if members["focused"]?.boolValue == true { details.append("focused") }
            if members["selected"]?.boolValue == true { details.append("selected") }
            if let frame = members["frame"]?.arrayValue, frame.count == 4 {
                let numbers = frame.compactMap(\.intValue)
                if numbers.count == 4 {
                    details.append("at=\(numbers[0]),\(numbers[1]) \(numbers[2])x\(numbers[3])")
                }
            }
            let indent = String(repeating: "  ", count: max(0, depth))
            let suffix = details.isEmpty ? "" : " — " + details.joined(separator: " ")
            lines.append("[\(index)] \(indent)\(label)\(suffix)")
        }
        return lines.joined(separator: "\n")
    }

    /// Quote a value for the outline, collapsing newlines so one node stays one line.
    private static func quoted(_ text: String) -> String {
        let collapsed = text
            .replacingOccurrences(of: "\n", with: "⏎")
            .replacingOccurrences(of: "\t", with: " ")
        return "\"\(collapsed)\""
    }
}
