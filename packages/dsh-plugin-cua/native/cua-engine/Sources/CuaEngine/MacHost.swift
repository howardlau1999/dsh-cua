import Foundation
import ApplicationServices
import CoreGraphics
import AppKit
import ScreenCaptureKit

/// The macOS backend.
///
/// All engine state that outlives one request lives here. There is exactly one
/// mutable field: the element snapshot backing index addressing for element
/// actions, which is overwritten by each dump and bounded by the number of
/// applications rather than by the number of nodes ever dumped.
///
/// `@unchecked Sendable` is honest here rather than convenient: the engine's
/// protocol loop awaits each request to completion on the main actor, so the
/// snapshot map has exactly one possible accessor at a time. AppKit and the
/// accessibility API would refuse concurrent use anyway.
final class MacHost: PlatformHost, @unchecked Sendable {
    var backendName: String { "macos-ax" }

    /// The most recent dump per process, so element actions can address a node
    /// by the index the model just saw. A stale index fails closed with
    /// `not_found` rather than acting on a re-used pointer, and the map is keyed
    /// by pid so its size is bounded by the number of applications, not by the
    /// number of nodes ever dumped.
    var snapshots: [pid_t: TreeDump.Result] = [:]

    /// The process whose tree was dumped most recently.
    ///
    /// Element actions resolve their default target from this rather than from
    /// the frontmost application: a dump and the action taken on it are one
    /// logical operation, and the frontmost app can change in between (a click
    /// that itself brings an app forward, for example).
    var lastSnapshotPid: pid_t?

    // MARK: - Permissions

    func permissionStatus() -> JSONValue {
        let accessibility = AXIsProcessTrusted()
        let screenRecording = CGPreflightScreenCaptureAccess()
        let locked = Capture.sessionLocked
        var missing: [JSONValue] = []
        if !accessibility { missing.append(.string("accessibility")) }
        if !screenRecording { missing.append(.string("screen_recording")) }
        return jsonObject([
            "platformSupported": .bool(true),
            "platform": .string("macos"),
            "accessibility": .bool(accessibility),
            "screenRecording": .bool(screenRecording),
            "ready": .bool(missing.isEmpty && !locked),
            "missing": .array(missing),
            "sessionLocked": .bool(locked),
            "processId": .int(Int(ProcessInfo.processInfo.processIdentifier)),
            "executablePath": .string(Bundle.main.executablePath ?? CommandLine.arguments.first ?? ""),
            "hint": .string(
                locked
                    ? "The Mac's screen is locked. Unlock it before expecting captures, UI trees, or input to work."
                    : Self.permissionHint(missing: missing)
            ),
        ])
    }

    func requestPermissions() throws -> JSONValue {
        let accessibility = AXIsProcessTrusted()
        if !accessibility {
            // The documented way to raise the Accessibility prompt; the user
            // still has to flip the switch in System Settings.
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        let screenRecording = CGPreflightScreenCaptureAccess()
        if !screenRecording {
            // On macOS 15+ this returns immediately; the system shows its own
            // prompt and records the decision under Screen Recording.
            _ = CGRequestScreenCaptureAccess()
        }
        Thread.sleep(forTimeInterval: 0.6)
        return permissionStatus()
    }

    /// The remediation sentence a model can relay to the user verbatim.
    static func permissionHint(missing: [JSONValue]) -> String {
        if missing.isEmpty { return "All required macOS permissions are granted." }
        var names: [String] = []
        for entry in missing {
            switch entry.stringValue {
            case "accessibility": names.append("Accessibility")
            case "screen_recording": names.append("Screen Recording")
            default: break
            }
        }
        let list = names.joined(separator: " and ")
        // Naming the host matters: macOS attributes the grant to the process
        // responsible for this engine, which is the application that loaded the
        // plugin — not `cua-engine`, and not the terminal it was launched from.
        // A user told only "grant Accessibility" opens the pane and finds a list
        // of applications with no idea which entry is theirs.
        let host = ProcessInfo.processInfo.environment["__CFBundleIdentifier"]
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? "the application running this engine"
        return "macOS has not granted \(list) to the application hosting this engine (\"\(host)\", pid "
            + "\(ProcessInfo.processInfo.processIdentifier)). "
            + "Open System Settings → Privacy & Security → \(list), enable that application (add it with the + "
            + "button if it is not listed), then quit and relaunch it — the grant takes effect only on a fresh launch. "
            + "Accessibility is required for UI trees, clicks, and typing; Screen Recording is required for screenshots."
    }

    /// Fail closed on every accessibility-dependent method.
    ///
    /// Without this an ungranted process does not error: the accessibility API
    /// returns empty attribute sets, so a window list would come back as a
    /// confident zero instead of "you have not granted permission".
    func requireAccessibility(_ what: String) throws {
        guard !AXIsProcessTrusted() else { return }
        throw CuaError.permissionDenied(
            "\(what) needs Accessibility permission. " + Self.permissionHint(missing: [.string("accessibility")])
        )
    }

    // MARK: - Applications

    func listApps(_ params: ParamsReader) throws -> JSONValue {
        let query = params.optionalString("query")?.lowercased()
        let includeBackground = params.bool("includeBackground", default: false)
        let runningOnly = params.bool("running", default: true)

        var rows: [JSONValue] = []
        var seen = Set<String>()

        if runningOnly {
            // Which processes own a window on screen, so the pid a row carries
            // is one a caller can act on even when the window server lists a
            // windowless helper of the same application first.
            let windowOwners = Self.onScreenWindowOwners()
            let candidates: [(app: NSRunningApplication, instance: ApplicationInstance)] =
                NSWorkspace.shared.runningApplications.compactMap { app in
                    if !includeBackground, app.activationPolicy == .prohibited { return nil }
                    let name = app.localizedName ?? ""
                    let bundleId = app.bundleIdentifier ?? ""
                    if let query, !query.isEmpty,
                       !name.lowercased().contains(query), !bundleId.lowercased().contains(query) {
                        return nil
                    }
                    let pid = app.processIdentifier
                    return (app, ApplicationInstance(
                        bundleId: bundleId,
                        pid: pid,
                        active: app.isActive,
                        hidden: app.isHidden,
                        hasWindow: windowOwners.contains(pid)
                    ))
                }
            // One row per application, not per process. The fold happens before
            // anything is encoded: a row naming one of eleven WebKit content
            // processes names nothing a caller can tell from the other ten.
            for row in Self.applicationRows(candidates.map(\.instance)) {
                seen.insert(row.identity)
                let app = candidates[row.representative].app
                rows.append(encode(app: app, active: row.active, hidden: row.hidden))
            }
        }
        if !runningOnly {
            for app in Self.installedApplications() {
                let name = app.name
                let bundleId = app.bundleId
                if let query, !query.isEmpty,
                   !name.lowercased().contains(query), !bundleId.lowercased().contains(query) {
                    continue
                }
                if seen.contains(bundleId) { continue }
                seen.insert(bundleId)
                rows.append(jsonObject([
                    "name": .string(name),
                    "bundleId": .string(bundleId),
                    "path": .string(app.path),
                    "running": .bool(false),
                ]))
            }
        }

        rows.sort { left, right in
            let leftFront = left["frontmost"]?.boolValue ?? false
            let rightFront = right["frontmost"]?.boolValue ?? false
            if leftFront != rightFront { return leftFront }
            let leftName = left["name"]?.stringValue ?? ""
            let rightName = right["name"]?.stringValue ?? ""
            return leftName.localizedCaseInsensitiveCompare(rightName) == .orderedAscending
        }
        return jsonObject([
            "apps": .array(rows),
            "count": .int(rows.count),
            "runningOnly": .bool(runningOnly),
        ])
    }

    /// Encode one running application.
    ///
    /// `active` and `hidden` are passed in when the row describes an
    /// *application* rather than one process: the process that lends the row
    /// its pid need not be the one that is frontmost or visible.
    func encode(app: NSRunningApplication, active: Bool? = nil, hidden: Bool? = nil) -> JSONValue {
        // Bound to locals first: a long literal reaching through optional chains
        // on `NSRunningApplication` is slow enough for the type checker to give
        // up, and the names are part of the tool's public vocabulary anyway.
        let name: JSONValue = .string(app.localizedName ?? "")
        let bundleId: JSONValue = .string(app.bundleIdentifier ?? "")
        let pid: JSONValue = .int(Int(app.processIdentifier))
        let policy: JSONValue = .string(Self.policyName(app.activationPolicy))
        let isActive = active ?? app.isActive
        let isHidden = hidden ?? app.isHidden
        var path: JSONValue?
        if let url = app.bundleURL {
            path = .string(url.path)
        }
        var launchDate: JSONValue?
        if let date = app.launchDate {
            launchDate = .string(ISO8601DateFormatter().string(from: date))
        }
        return jsonObject([
            "name": name,
            "bundleId": bundleId,
            "pid": pid,
            "path": path,
            "active": .bool(isActive),
            "frontmost": .bool(isActive),
            "hidden": .bool(isHidden),
            "terminated": .bool(app.isTerminated),
            "policy": policy,
            "launchDate": launchDate,
        ])
    }

    static func policyName(_ policy: NSApplication.ActivationPolicy) -> String {
        switch policy {
        case .regular: return "regular"
        case .accessory: return "accessory"
        case .prohibited: return "background"
        @unknown default: return "unknown"
        }
    }

    /// Installed applications discovered from the standard library locations.
    static func installedApplications() -> [(name: String, bundleId: String, path: String)] {
        let roots = [
            "/Applications",
            "/Applications/Utilities",
            "/System/Applications",
            "/System/Applications/Utilities",
            NSHomeDirectory() + "/Applications",
        ]
        var found: [(String, String, String)] = []
        let manager = FileManager.default
        for root in roots {
            guard let entries = try? manager.contentsOfDirectory(atPath: root) else { continue }
            for entry in entries where entry.hasSuffix(".app") {
                let path = root + "/" + entry
                let bundle = Bundle(path: path)
                let bundleId = bundle?.bundleIdentifier ?? ""
                let name = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
                    ?? String(entry.dropLast(4))
                guard !bundleId.isEmpty else { continue }
                found.append((name, bundleId, path))
            }
        }
        return found
    }

    // MARK: - Windows

    func listWindows(_ params: ParamsReader) throws -> JSONValue {
        try requireAccessibility("Listing windows")
        let pidFilter = params.optionalInt("pid")
        let appQuery = params.optionalString("app")?.lowercased()
        let frontmostOnly = params.bool("frontmost", default: false)
        let includeUntitled = params.bool("includeUntitled", default: true)

        let targets = try resolveApplications(
            pid: pidFilter.map { pid_t($0) },
            query: appQuery,
            frontmost: frontmostOnly,
            includeBackground: params.bool("includeBackground", default: false)
        )
        var rows: [JSONValue] = []
        for app in targets {
            let application = AX.application(app.processIdentifier)
            var windows = AXArray.elements(application, kAXWindowsAttribute as String)
            if windows.isEmpty, let focused = AX.element(application, kAXFocusedWindowAttribute as String) {
                windows = [focused]
            }
            for window in windows {
                let title = AX.string(window, kAXTitleAttribute as String) ?? ""
                if !includeUntitled, title.isEmpty { continue }
                let frame = AX.frame(window)
                let subrole = AX.string(window, kAXSubroleAttribute as String) ?? ""
                let minimized = AX.bool(window, "AXMinimized") ?? false
                var windowId: Int?
                if let frame, let cgId = Self.matchWindowID(pid: app.processIdentifier, frame: frame) {
                    windowId = Int(cgId)
                }
                var frameValue: JSONValue?
                if let frame {
                    frameValue = .array([
                        .int(Int(frame.origin.x.rounded())), .int(Int(frame.origin.y.rounded())),
                        .int(Int(frame.width.rounded())), .int(Int(frame.height.rounded())),
                    ])
                }
                let windowIdValue: JSONValue = windowId.jsonField
                let isMain = AX.bool(window, kAXMainAttribute as String) ?? false
                let isFocused = AX.bool(window, kAXFocusedAttribute as String) ?? false
                rows.append(jsonObject([
                    "title": .string(title),
                    "app": .string(app.localizedName ?? ""),
                    "bundleId": .string(app.bundleIdentifier ?? ""),
                    "pid": .int(Int(app.processIdentifier)),
                    "windowId": windowIdValue,
                    "frame": frameValue,
                    "subrole": subrole.isEmpty ? nil : .string(subrole),
                    "minimized": .bool(minimized),
                    "main": .bool(isMain),
                    "focused": .bool(isFocused),
                ]))
            }
        }
        // Main windows first: a model asking "what is on screen" almost always
        // wants the front document, not the inspector panel that sorted earlier.
        rows.sort { left, right in
            let leftMain = left["main"]?.boolValue ?? false
            let rightMain = right["main"]?.boolValue ?? false
            if leftMain != rightMain { return leftMain }
            let leftFocused = left["focused"]?.boolValue ?? false
            let rightFocused = right["focused"]?.boolValue ?? false
            return leftFocused && !rightFocused
        }
        var note: JSONValue?
        if rows.isEmpty, let first = targets.first {
            note = .string(
                "\(first.localizedName ?? "The application") exposes no accessibility windows right now: "
                    + "it may have no open window, or its windows may be closed, minimized, or owned by a helper process."
            )
        }
        return jsonObject([
            "windows": .array(rows),
            "count": .int(rows.count),
            "note": note,
        ])
    }

    /// What an application contributes to a query decision.
    ///
    /// Split out from `NSRunningApplication` so the ranking below is a pure
    /// function of the facts it actually uses, and can therefore be tested
    /// without a desktop. The defect this guards against — a Dock helper
    /// outranking the application a user meant — is a property of names and
    /// activation policies, not of anything AppKit knows.
    struct ApplicationCandidate: Equatable {
        /// Localized display name, as the query is matched against it.
        let name: String
        /// Bundle identifier.
        let bundleId: String
        /// Whether this is a regular (Dock-visible, window-owning) application.
        let regular: Bool

        init(name: String?, bundleId: String?, regular: Bool) {
            self.name = (name ?? "").lowercased()
            self.bundleId = (bundleId ?? "").lowercased()
            self.regular = regular
        }
    }

    /// How well one application answers a query, or `nil` when it does not.
    ///
    /// The order is the whole point: an exact name or bundle-id match first,
    /// then a regular application over a background helper, then the
    /// application's name. Without the second test an ambiguous query resolves
    /// to whichever helper the window server happens to list first — the
    /// `com.apple.dock.helper` / `DockHelper.xpc` pair is the case that was
    /// measured, and it owns a window, so nothing else distinguishes it.
    ///
    /// - Parameters:
    ///   - candidate: the application, reduced to the facts a query judges.
    ///   - query: an already-lowercased substring.
    /// - Returns: a comparable rank, or `nil` when the query does not match.
    static func matchRank(_ candidate: ApplicationCandidate, query: String) -> ApplicationMatch? {
        let exact = isExactMatch(candidate, query)
        guard exact || candidate.name.contains(query) || candidate.bundleId.contains(query) else { return nil }
        return ApplicationMatch(candidate: candidate, exact: exact)
    }

    /// `matchRank`'s result, carrying the inputs needed to order two ranks.
    struct ApplicationMatch: Comparable {
        let candidate: ApplicationCandidate
        let exact: Bool

        /// Whether neither application is a strictly better answer, so both
        /// should be returned for the caller to choose between.
        func ties(with other: ApplicationMatch) -> Bool {
            exact == other.exact && candidate.regular == other.candidate.regular
        }

        static func < (left: ApplicationMatch, right: ApplicationMatch) -> Bool {
            if left.exact != right.exact { return left.exact }
            if left.candidate.regular != right.candidate.regular { return left.candidate.regular }
            if left.candidate.name != right.candidate.name { return left.candidate.name < right.candidate.name }
            // A total order, so the result does not depend on the window
            // server's listing order when two applications tie on everything
            // above.
            return left.candidate.bundleId < right.candidate.bundleId
        }
    }

    /// Whether an application's name or bundle id equals the query exactly.
    static func isExactMatch(_ candidate: ApplicationCandidate, _ query: String) -> Bool {
        let bare = candidate.bundleId.split(separator: ".").last.map(String.init) ?? candidate.bundleId
        return candidate.name == query || candidate.bundleId == query || bare == query
    }

    /// Whether an application's name or bundle id equals the query exactly.
    static func isExactMatch(_ app: NSRunningApplication, _ query: String) -> Bool {
        isExactMatch(ApplicationCandidate(
            name: app.localizedName,
            bundleId: app.bundleIdentifier,
            regular: app.activationPolicy == .regular
        ), query)
    }

    /// The pids that own a window currently on screen.
    ///
    /// Only the owner pid is read, which the window server returns without
    /// Screen Recording permission — window *titles* are what that grant
    /// protects, and nothing here needs them. An empty answer (no permission,
    /// or no windows) is not an error: it only costs the listing its preference
    /// for a process that owns a window, and the ranking falls back to
    /// visibility.
    static func onScreenWindowOwners() -> Set<pid_t> {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        var owners = Set<pid_t>()
        for entry in list {
            if let pid = entry[kCGWindowOwnerPID as String] as? pid_t { owners.insert(pid) }
        }
        return owners
    }

    /// Match one accessibility window frame against the window server's list,
    /// which is the only source of the `CGWindowID` that capture needs.
    static func matchWindowID(pid: pid_t, frame: CGRect) -> CGWindowID? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        var best: (id: CGWindowID, delta: CGFloat)?
        for entry in list {
            guard (entry[kCGWindowOwnerPID as String] as? pid_t) == pid,
                  let number = entry[kCGWindowNumber as String] as? CGWindowID,
                  let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict) else { continue }
            let delta = abs(bounds.origin.x - frame.origin.x)
                + abs(bounds.origin.y - frame.origin.y)
                + abs(bounds.width - frame.width)
                + abs(bounds.height - frame.height)
            if delta <= 2, best == nil || delta < best!.delta {
                best = (number, delta)
            }
        }
        return best?.id
    }

    /// One running process, reduced to the facts that decide which of an
    /// application's processes becomes its row.
    ///
    /// Split out from `NSRunningApplication` for the same reason
    /// `ApplicationCandidate` is: which process represents an application is a
    /// property of these facts and not of anything AppKit knows, so the rule can
    /// be tested without a desktop.
    struct ApplicationInstance: Equatable {
        /// Bundle identifier, or `""` when the process has none.
        let bundleId: String
        let pid: Int32
        /// Whether this process is the active (frontmost) one.
        let active: Bool
        /// Whether this process is hidden.
        let hidden: Bool
        /// Whether this process owns a window on screen.
        let hasWindow: Bool

        init(bundleId: String?, pid: Int32, active: Bool, hidden: Bool, hasWindow: Bool) {
            self.bundleId = bundleId ?? ""
            self.pid = pid
            self.active = active
            self.hidden = hidden
            self.hasWindow = hasWindow
        }

        /// What makes two processes the same application.
        ///
        /// A process with no bundle id has no identity beyond itself, so it
        /// stands alone rather than being merged with something it merely
        /// resembles — the rule the Windows backend applies to a process whose
        /// image it cannot read, for the same reason.
        var identity: String { bundleId.isEmpty ? "pid:\(pid)" : bundleId }
    }

    /// One row of `cua_apps`: which process lends it a pid, and the state of the
    /// application as a whole.
    struct ApplicationRow: Equatable {
        /// The identity the row's processes were folded under.
        let identity: String
        /// Index into the instance list this row was built from.
        let representative: Int
        /// Whether *any* process of the application is active.
        let active: Bool
        /// Whether *every* process of the application is hidden.
        let hidden: Bool
    }

    /// Which of two processes is the better face for its application.
    ///
    /// The order mirrors the Windows backend's: the process the user is actually
    /// looking at, else one that owns a window a caller could address, else one
    /// that is merely not hidden, and only failing all of those a hidden one.
    static func instanceRank(_ instance: ApplicationInstance) -> Int {
        if instance.active { return 0 }
        if instance.hasWindow { return 1 }
        return instance.hidden ? 3 : 2
    }

    /// One row per application, not per process.
    ///
    /// A macOS application is frequently several processes, and the window
    /// server lists every one of them separately: a browser runs a content
    /// process per page, an Electron app a renderer per window, and plenty of
    /// system agents a windowless helper. Reported process by process, `cua_apps`
    /// listed `“QQ音乐”网页内容` eleven times under one bundle id — measured, not
    /// supposed — and rows a model cannot tell apart are rows it cannot act on,
    /// because every one of them names the same thing.
    ///
    /// A row keeps the pid of the process best placed to be acted on, while
    /// `active` and `hidden` describe the application rather than that one
    /// process: a frontmost application whose listed process was a hidden helper
    /// would otherwise read as neither.
    ///
    /// - Parameter instances: every matching process, in the caller's order.
    /// - Returns: one row per distinct identity, in first-appearance order.
    static func applicationRows(_ instances: [ApplicationInstance]) -> [ApplicationRow] {
        var index: [String: Int] = [:]
        var rows: [ApplicationRow] = []
        for (offset, instance) in instances.enumerated() {
            let key = instance.identity
            guard let existing = index[key] else {
                index[key] = rows.count
                rows.append(ApplicationRow(
                    identity: key,
                    representative: offset,
                    active: instance.active,
                    hidden: instance.hidden
                ))
                continue
            }
            let kept = rows[existing]
            // Strictly better, so a tie keeps the earlier process and the result
            // does not depend on the window server's listing order.
            let better = instanceRank(instance) < instanceRank(instances[kept.representative])
            rows[existing] = ApplicationRow(
                identity: key,
                representative: better ? offset : kept.representative,
                active: kept.active || instance.active,
                hidden: kept.hidden && instance.hidden
            )
        }
        return rows
    }

    /// Resolve the applications a request refers to.
    ///
    /// Background-only processes are excluded unless asked for. Without that
    /// filter `"ghostty"` matches Dock Extra (Ghostty.app) — a windowless helper
    /// whose name contains the app's — before it matches the app itself, and the
    /// caller silently operates on the wrong process.
    func resolveApplications(
        pid: pid_t?,
        query: String?,
        frontmost: Bool = false,
        includeBackground: Bool = false
    ) throws -> [NSRunningApplication] {
        if let pid {
            guard let app = NSRunningApplication(processIdentifier: pid) else {
                throw CuaError.notFound("no running application with pid \(pid)")
            }
            return [app]
        }
        if frontmost, query == nil {
            guard let app = NSWorkspace.shared.frontmostApplication else {
                throw CuaError.notFound("no frontmost application")
            }
            return [app]
        }
        if let query, !query.isEmpty {
            // Rank through the pure function, so the ordering rule is testable
            // and the `includeBackground` filter and the ranking cannot disagree
            // about what a candidate is.
            let judged: [(app: NSRunningApplication, rank: ApplicationMatch)] =
                NSWorkspace.shared.runningApplications.compactMap { app in
                    let candidate = ApplicationCandidate(
                        name: app.localizedName,
                        bundleId: app.bundleIdentifier,
                        regular: app.activationPolicy == .regular
                    )
                    if !includeBackground, app.activationPolicy == .prohibited { return nil }
                    guard let rank = Self.matchRank(candidate, query: query) else { return nil }
                    return (app, rank)
                }
            let ranked = judged.sorted { $0.rank < $1.rank }
            guard let best = ranked.first else {
                throw CuaError.notFound("no running application matches \"\(query)\"")
            }
            // Every application that ties with the best is returned, so a
            // genuinely ambiguous query stays ambiguous instead of being
            // resolved by the window server's listing order.
            return ranked.filter { $0.rank.ties(with: best.rank) }.map(\.app)
        }
        guard let app = NSWorkspace.shared.frontmostApplication else {
            throw CuaError.notFound("no frontmost application")
        }
        return [app]
    }

    /// Every display, with the geometry a caller needs to address coordinates.
    func listDisplays(_ params: ParamsReader) async throws -> JSONValue {
        let displays = try await Capture.displays()
        let main = Capture.mainDisplayId
        // Sorted by position so the listing reads like the physical layout.
        let rows = displays
            .sorted { left, right in
                if left.frame.minY != right.frame.minY { return left.frame.minY < right.frame.minY }
                return left.frame.minX < right.frame.minX
            }
            .map { encode(display: $0, isMain: $0.displayID == main) }
        let bounds = await Capture.desktopBounds()
        return jsonObject([
            "displays": .array(rows),
            "count": .int(rows.count),
            "desktop": .array([
                .double(Double(bounds.origin.x)), .double(Double(bounds.origin.y)),
                .double(Double(bounds.width)), .double(Double(bounds.height)),
            ]),
            "coordinateSpace": .string("top-left origin, screen points; secondary displays may have negative x or y"),
        ])
    }

    // MARK: - Tree

    func readTree(_ params: ParamsReader) throws -> JSONValue {
        try requireAccessibility("Reading the UI tree")
        var options = TreeDump.Options()
        options.maxDepth = try params.int("maxDepth", default: options.maxDepth, in: 1...40)
        options.nodeLimit = try params.int("nodeLimit", default: options.nodeLimit, in: 1...20_000)
        options.includeStructural = params.bool("includeStructural", default: false)
        options.interactiveOnly = params.bool("interactiveOnly", default: false)
        options.includeGeometry = params.bool("includeGeometry", default: false)
        options.textLimit = try params.int("textLimit", default: options.textLimit, in: 0...4_000)
        options.format = params.string("format", default: "outline")
        options.skipMenuBar = params.bool("includeMenuBar", default: false) == false
        options.roleFilter = Set(try params.stringList("roles"))
        if let budget = params.optionalDouble("timeBudgetMs") {
            options.timeBudget = min(max(budget / 1000.0, 0.2), 60.0)
        }

        let root = try resolveTreeRoot(params)
        let result = TreeDump.walk(root: root.0, options: options)
        snapshots[root.1] = result
        lastSnapshotPid = root.1

        return jsonObject([
            "app": .string(root.2),
            "pid": .int(Int(root.1)),
            "windowTitle": root.3.jsonField,
            "nodes": .array(result.nodes),
            "text": .string(TreeDump.outline(result.nodes)),
            "nodeCount": .int(result.nodes.count),
            "visitedCount": .int(result.visited),
            "truncatedBy": result.truncatedBy.jsonField,
            "elapsedMs": .int(Int((result.elapsed * 1000).rounded())),
            "options": jsonObject([
                "maxDepth": .int(options.maxDepth),
                "nodeLimit": .int(options.nodeLimit),
                "includeStructural": .bool(options.includeStructural),
                "interactiveOnly": .bool(options.interactiveOnly),
                "includeGeometry": .bool(options.includeGeometry),
                "roles": .array(options.roleFilter.sorted().map { JSONValue.string($0) }),
                "includeMenuBar": .bool(!options.skipMenuBar),
            ]),
        ])
    }

    /// Resolve which element a tree request starts from.
    ///
    /// - Returns: the root element, its pid, the application name, and the
    ///   window title when a specific window was requested.
    func resolveTreeRoot(_ params: ParamsReader) throws -> (AXUIElement, pid_t, String, String?) {
        if let windowId = params.optionalInt("windowId") {
            guard let entry = Self.windowEntry(windowId: CGWindowID(windowId)) else {
                throw CuaError.notFound("no on-screen window with id \(windowId)")
            }
            let pid = entry.pid
            let application = AX.application(pid)
            let frame = entry.frame
            let windows = AXArray.elements(application, kAXWindowsAttribute as String)
            for window in windows {
                guard let candidate = AX.frame(window) else { continue }
                if abs(candidate.origin.x - frame.origin.x) <= 2,
                   abs(candidate.origin.y - frame.origin.y) <= 2,
                   abs(candidate.width - frame.width) <= 2,
                   abs(candidate.height - frame.height) <= 2 {
                    return (window, pid, entry.appName, AX.string(window, kAXTitleAttribute as String))
                }
            }
            // The window server knows about it but accessibility does not expose
            // it (a panel, an overlay, or a permission mismatch): fall back to
            // the application rather than reporting a false "not found".
            return (application, pid, entry.appName, nil)
        }

        let pid = params.optionalInt("pid")
        let query = params.optionalString("app")
        let frontmost = params.bool("frontmost", default: pid == nil && query == nil)
        let windowTitle = params.optionalString("windowTitle")

        let apps = try resolveApplications(pid: pid.map { pid_t($0) }, query: query?.lowercased(), frontmost: frontmost)
        let app = apps[0]
        let application = AX.application(app.processIdentifier)
        guard let windowTitle, !windowTitle.isEmpty else {
            return (application, app.processIdentifier, app.localizedName ?? "", nil)
        }
        let windows = AXArray.elements(application, kAXWindowsAttribute as String)
        for window in windows {
            let title = AX.string(window, kAXTitleAttribute as String) ?? ""
            if title.localizedCaseInsensitiveContains(windowTitle) {
                return (window, app.processIdentifier, app.localizedName ?? "", title)
            }
        }
        throw CuaError.notFound("no window of \(app.localizedName ?? "the application") matches title \"\(windowTitle)\"")
    }

    /// One on-screen window from the window server's list.
    struct WindowEntry {
        let id: CGWindowID
        let pid: pid_t
        let appName: String
        let title: String
        let frame: CGRect
        let layer: Int
        let alpha: Double
    }

    /// Look up one window by id.
    static func windowEntry(windowId: CGWindowID) -> WindowEntry? {
        windowEntries().first { $0.id == windowId }
    }

    /// Every on-screen window, front to back.
    static func windowEntries() -> [WindowEntry] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return list.compactMap { entry in
            guard let number = entry[kCGWindowNumber as String] as? CGWindowID,
                  let pid = entry[kCGWindowOwnerPID as String] as? pid_t,
                  let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
            return WindowEntry(
                id: number,
                pid: pid,
                appName: entry[kCGWindowOwnerName as String] as? String ?? "",
                title: entry[kCGWindowName as String] as? String ?? "",
                frame: frame,
                layer: entry[kCGWindowLayer as String] as? Int ?? 0,
                alpha: entry[kCGWindowAlpha as String] as? Double ?? 1
            )
        }
    }

    /// The captured element list from the newest dump of one process.
    func snapshotElements(pid: pid_t) -> [AXUIElement]? {
        snapshots[pid]?.elements
    }
}
