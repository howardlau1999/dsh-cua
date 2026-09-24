import Testing
import Foundation
import AppKit
@testable import cua_engine

/// Unit tests for the engine's pure decision logic.
///
/// The smoke test drives the real desktop, which means it can only assert that
/// a call succeeded — not *why* it produced the answer it did. Everything here
/// is a function whose output is decided by arithmetic or by a comparison rule,
/// which is exactly the class of code a real desktop cannot cross-check: a
/// coordinate flipped into the wrong origin, a filter that keeps one role too
/// many, an ambiguous query resolved to a background helper.
///
/// These need no permissions and no display, so they are the only part of the
/// engine that can run on a CI runner.
///
/// Swift Testing rather than XCTest on purpose: the engine builds with the
/// Command Line Tools, which do not ship the XCTest module, and a test suite
/// that only runs on a machine with full Xcode is a test suite that stops being
/// run.
@Suite("coordinate conversion")
struct CoordinateConversionTests {

    /// A screenshot's coordinates are top-left origin; Quartz events are
    /// bottom-left. The flip uses the primary display's height, and getting it
    /// wrong clicks the mirror image of the intended point — which on a tall
    /// window looks entirely plausible, so nothing else catches it.
    @Test("the y flip is about the primary display height")
    func yFlipUsesPrimaryDisplayHeight() {
        let height = NSScreen.screens.first?.frame.height ?? 0
        #expect(Capture.eventPoint(fromScreenPoint: CGPoint(x: 10, y: 0)).y == height)
        #expect(Capture.eventPoint(fromScreenPoint: CGPoint(x: 10, y: height)).y == 0)
        if height > 0 {
            #expect(Capture.eventPoint(fromScreenPoint: CGPoint(x: 10, y: height / 2)).y == height / 2)
        }
    }

    /// The conversion must not touch x. A y-flip implemented as a point
    /// negation would move the pointer horizontally too, which is how a bug here
    /// hides: the click still lands somewhere.
    @Test("x is never touched")
    func xIsPreserved() {
        for x in [CGFloat(-1168), -1, 0, 752, 1512] {
            #expect(Capture.eventPoint(fromScreenPoint: CGPoint(x: x, y: 100)).x == x)
        }
    }

    /// The two directions must invert each other, or a point read back from the
    /// pointer would not be the point that was set.
    @Test("the two directions are inverses")
    func directionsInvert() {
        for point in [CGPoint(x: 0, y: 0), CGPoint(x: 123.5, y: 456.25), CGPoint(x: -500, y: 900)] {
            let roundTripped = Capture.screenPoint(fromEventPoint: Capture.eventPoint(fromScreenPoint: point))
            #expect(abs(roundTripped.x - point.x) < 0.0001)
            #expect(abs(roundTripped.y - point.y) < 0.0001)
        }
    }
}

@Suite("capture region clipping")
struct RegionClippingTests {
    private let display = CGRect(x: 0, y: 0, width: 1512, height: 982)

    /// A region inside its display is captured whole.
    @Test("a region inside its display is kept whole")
    func insideIsKept() {
        let region = CGRect(x: 100, y: 100, width: 200, height: 200)
        #expect(Capture.clip(region, to: display) == region)
    }

    /// A region overlapping an edge is clipped to the overlap, and the result is
    /// strictly smaller than the request — which is what makes the result's
    /// `clipped` flag tell the truth.
    @Test("an overhanging region is trimmed to the overlap")
    func overhangIsTrimmed() {
        let region = CGRect(x: 1400, y: 900, width: 400, height: 400)
        let clipped = Capture.clip(region, to: display)
        #expect(clipped == CGRect(x: 1400, y: 900, width: 112, height: 82))
        #expect(clipped != region)
    }

    /// A region on a secondary display with negative coordinates is clipped
    /// against that display, not against an assumed origin at zero. The desktop
    /// here spans x from -1168, so a rectangle at negative x is ordinary, and a
    /// clip that used an origin of zero would fall back to the whole display.
    @Test("negative display origins are honoured")
    func negativeOrigins() {
        let secondary = CGRect(x: -1168, y: -1080, width: 1920, height: 1080)
        let inside = CGRect(x: -1000, y: -1000, width: 100, height: 100)
        #expect(Capture.clip(inside, to: secondary) == inside)

        // Overhangs the bottom edge (the display's lower bound is y = -1080 + 1080 = 0):
        // 400 of its 720 points are on the display.
        let overhanging = CGRect(x: -268, y: -400, width: 400, height: 720)
        #expect(Capture.clip(overhanging, to: secondary) == CGRect(x: -268, y: -400, width: 400, height: 400))
    }

    /// A region that misses its target entirely falls back to the whole target.
    /// Returning a null rectangle instead would produce a zero-pixel capture;
    /// returning the request would report pixels that are not in the image.
    @Test("a region off its target falls back to the target")
    func offTargetFallsBack() {
        let secondary = CGRect(x: -1168, y: -1080, width: 1920, height: 1080)
        // Left of the secondary display's left edge and above its top edge.
        let off = CGRect(x: -1300, y: -1200, width: 50, height: 50)
        #expect(Capture.clip(off, to: secondary) == secondary)
    }

    /// A region that misses its target entirely falls back to the whole target.
    /// Returning a null rectangle instead would produce a zero-pixel capture;
    /// returning the request would report pixels that are not in the image.
    @Test("a region overlapping nothing falls back to the whole target")
    func noOverlapFallsBackToTarget() {
        let elsewhere = CGRect(x: 5000, y: 5000, width: 100, height: 100)
        #expect(Capture.clip(elsewhere, to: display) == display)
    }

    /// A sub-point sliver is not a capture: the guard is at least one point in
    /// each direction, so a 0.5-point overlap is rejected rather than rounded
    /// into a one-pixel strip.
    @Test("a sub-point overlap is rejected")
    func subPointOverlapIsRejected() {
        let small = CGRect(x: 0, y: 0, width: 100, height: 100)
        let sliver = CGRect(x: 99.5, y: 0, width: 100, height: 100)
        #expect(Capture.clip(sliver, to: small) == small)
    }

    /// `localRect` converts a global rectangle into a container's own space,
    /// which is what an `SCStreamConfiguration.sourceRect` needs.
    @Test("localRect is relative to its container")
    func localRectIsRelative() {
        let container = CGRect(x: -1168, y: -1080, width: 1920, height: 1080)
        let global = CGRect(x: -1100, y: -1000, width: 200, height: 100)
        #expect(Capture.localRect(global, in: container) == CGRect(x: 68, y: 80, width: 200, height: 100))
    }
}

@Suite("display geometry")
struct DisplayGeometryTests {
    private let displays = [
        CGRect(x: -1168, y: -1080, width: 1920, height: 1080),
        CGRect(x: 752, y: -1080, width: 1920, height: 1080),
        CGRect(x: 0, y: 0, width: 1512, height: 982),
    ]

    /// A rectangle inside one display overlaps only that one, which is what a
    /// per-display capture request relies on.
    @Test("a rectangle inside one display overlaps only that one")
    func containedRectOverlapsOnce() {
        let rect = CGRect(x: -1000, y: -1000, width: 200, height: 200)
        let overlapping = displays.filter { $0.intersects(rect) }
        #expect(overlapping == [displays[0]])
    }

    /// A rectangle that misses every display overlaps none of them, which is the
    /// input that must not be resolved to an arbitrary display.
    @Test("a rectangle off every display overlaps none")
    func offDesktopRectOverlapsNone() {
        let rect = CGRect(x: 9000, y: 9000, width: 100, height: 100)
        for display in displays {
            let overlap = display.intersection(rect)
            #expect(overlap.isNull || overlap.width <= 0 || overlap.height <= 0)
        }
    }

    /// A rectangle straddling two displays overlaps both, with a larger area on
    /// one of them: the case where "largest overlap wins" has to decide.
    @Test("a straddling rectangle overlaps both with different areas")
    func straddlingRectHasALargerSide() {
        let rect = CGRect(x: -100, y: -500, width: 1600, height: 400)
        let left = displays[0].intersection(rect)
        let right = displays[1].intersection(rect)
        let leftArea = left.width * left.height
        let rightArea = right.width * right.height
        #expect(leftArea > 0 && rightArea > 0)
        #expect(leftArea != rightArea)
        #expect(max(leftArea, rightArea) == leftArea)
    }
}

@Suite("application resolution ranking")
struct ApplicationRankingTests {

    /// The measured defect: a query for an application matched its Dock helper
    /// first, because a helper owns a window and nothing else separated the two.
    /// A regular application must outrank a helper that also matches.
    @Test("a regular application outranks a matching helper")
    func regularBeatsHelper() throws {
        let helper = MacHost.ApplicationCandidate(
            name: "DockHelper", bundleId: "com.apple.dock.helper", regular: false
        )
        let application = MacHost.ApplicationCandidate(
            name: "Dock", bundleId: "com.apple.dock", regular: true
        )
        let helperRank = try #require(MacHost.matchRank(helper, query: "dock"))
        let appRank = try #require(MacHost.matchRank(application, query: "dock"))
        #expect(appRank < helperRank)
    }

    /// However many candidates match, a regular application is still preferred
    /// to every prohibited one — the ordering must not depend on how many
    /// helpers happen to exist, which is what made the original defect
    /// intermittent.
    @Test("every prohibited match ranks below every regular one")
    func allHelpersRankBelow() throws {
        let regular = MacHost.ApplicationCandidate(name: "Edge", bundleId: "com.microsoft.edgemac", regular: true)
        let regularRank = try #require(MacHost.matchRank(regular, query: "edge"))
        for index in 0..<5 {
            let helper = MacHost.ApplicationCandidate(
                name: "Edge Helper \(index)",
                bundleId: "com.microsoft.edgemac.helper\(index)",
                regular: false
            )
            let helperRank = try #require(MacHost.matchRank(helper, query: "edge"))
            #expect(regularRank < helperRank)
        }
    }

    /// An exact name beats a merely-contains match, even when the contains match
    /// is a regular application and the exact one is not.
    @Test("an exact match outranks a regular partial match")
    func exactBeatsRegularPartial() throws {
        let exactHelper = MacHost.ApplicationCandidate(name: "Dock", bundleId: "com.apple.dock.helper", regular: false)
        let partial = MacHost.ApplicationCandidate(name: "Dock Station", bundleId: "com.example.dockstation", regular: true)
        let exactRank = try #require(MacHost.matchRank(exactHelper, query: "dock"))
        let partialRank = try #require(MacHost.matchRank(partial, query: "dock"))
        #expect(exactRank < partialRank)
    }

    /// A bare bundle suffix is an exact match, so a query of "finder" reaches
    /// `com.apple.finder` the same way the full identifier does.
    @Test("a bare bundle suffix counts as exact")
    func bareSuffixIsExact() {
        let candidate = MacHost.ApplicationCandidate(name: "Finder", bundleId: "com.apple.finder", regular: true)
        #expect(MacHost.isExactMatch(candidate, "com.apple.finder"))
        #expect(MacHost.isExactMatch(candidate, "finder"))
        #expect(!MacHost.isExactMatch(candidate, "fin"))
    }

    /// Matching is case-insensitive on both fields, because the callsite
    /// lowercases the query and the candidate lowercases itself.
    @Test("matching ignores case on name and bundle id")
    func matchingIgnoresCase() {
        let candidate = MacHost.ApplicationCandidate(
            name: "Microsoft Edge", bundleId: "com.microsoft.edgemac", regular: true
        )
        #expect(MacHost.matchRank(candidate, query: "microsoft edge") != nil)
        #expect(MacHost.matchRank(candidate, query: "edgemac") != nil)
        #expect(MacHost.matchRank(candidate, query: "edge") != nil)
        #expect(MacHost.matchRank(candidate, query: "safari") == nil)
    }

    /// Candidates that tie on both tests are all returned, so an ambiguous query
    /// stays ambiguous instead of being resolved by listing order.
    @Test("genuinely tied candidates report as tied")
    func tiedCandidates() throws {
        let first = MacHost.ApplicationCandidate(name: "WeChat", bundleId: "com.tencent.xinwechat", regular: true)
        let second = MacHost.ApplicationCandidate(name: "WeChat", bundleId: "com.tencent.flue.wechatappex", regular: true)
        let left = try #require(MacHost.matchRank(first, query: "wechat"))
        let right = try #require(MacHost.matchRank(second, query: "wechat"))
        #expect(left.ties(with: right))
        // The total order still separates them, so the sort is deterministic.
        #expect(left != right)
        #expect(left < right || right < left)
    }

    /// A helper and a regular application with the same name are not tied: only
    /// the better-ranked one is an answer.
    @Test("a helper and a regular application are not tied")
    func helperIsNotTied() throws {
        let helper = MacHost.ApplicationCandidate(name: "Token Bar", bundleId: "com.highfive.tokenbar.helper", regular: false)
        let application = MacHost.ApplicationCandidate(name: "Token Bar", bundleId: "com.highfive.tokenbar", regular: true)
        let helperRank = try #require(MacHost.matchRank(helper, query: "token bar"))
        let appRank = try #require(MacHost.matchRank(application, query: "token bar"))
        #expect(!appRank.ties(with: helperRank))
    }
}

@Suite("application listing")
struct ApplicationListingTests {

    /// The measured defect: eleven WebKit content processes of one page-hosting
    /// app, all sharing a bundle id, listed as eleven rows a model cannot tell
    /// apart. One application is one row.
    @Test("processes sharing a bundle id fold into one row")
    func foldsDuplicates() {
        let instances = (0..<11).map { offset in
            MacHost.ApplicationInstance(
                bundleId: "com.apple.WebKit.WebContent",
                pid: Int32(100 + offset),
                active: false,
                hidden: false,
                hasWindow: false
            )
        }
        let rows = MacHost.applicationRows(instances)
        #expect(rows.count == 1)
        #expect(rows[0].identity == "com.apple.WebKit.WebContent")
    }

    /// Distinct applications must stay distinct, or the fold would hide the
    /// thing the caller asked for.
    @Test("distinct bundle ids stay distinct")
    func keepsDistinctApplications() {
        let rows = MacHost.applicationRows([
            MacHost.ApplicationInstance(bundleId: "com.apple.finder", pid: 1, active: false, hidden: false, hasWindow: true),
            MacHost.ApplicationInstance(bundleId: "com.apple.dock", pid: 2, active: false, hidden: false, hasWindow: true),
        ])
        #expect(rows.count == 2)
        #expect(rows.map(\.identity) == ["com.apple.finder", "com.apple.dock"])
    }

    /// A process with no bundle id has no identity beyond itself, so it must not
    /// be merged with another identity-less process.
    @Test("a process with no bundle id stands alone")
    func identitylessProcessesStandAlone() {
        let rows = MacHost.applicationRows([
            MacHost.ApplicationInstance(bundleId: nil, pid: 7, active: false, hidden: false, hasWindow: false),
            MacHost.ApplicationInstance(bundleId: "", pid: 8, active: false, hidden: false, hasWindow: false),
        ])
        #expect(rows.count == 2)
        #expect(rows.map(\.identity) == ["pid:7", "pid:8"])
    }

    /// The row has to carry a pid a caller can act on: the process the user is
    /// looking at outranks a windowless helper listed first.
    @Test("the active process wins the row")
    func activeProcessWins() {
        let rows = MacHost.applicationRows([
            MacHost.ApplicationInstance(bundleId: "com.example.app", pid: 10, active: false, hidden: false, hasWindow: false),
            MacHost.ApplicationInstance(bundleId: "com.example.app", pid: 11, active: true, hidden: false, hasWindow: true),
        ])
        #expect(rows.count == 1)
        #expect(rows[0].representative == 1)
    }

    /// A process owning a window beats one that merely is not hidden, because a
    /// window is what the other tools can address.
    @Test("a window owner outranks a windowless process")
    func windowOwnerOutranksWindowless() {
        let rows = MacHost.applicationRows([
            MacHost.ApplicationInstance(bundleId: "com.example.app", pid: 20, active: false, hidden: false, hasWindow: false),
            MacHost.ApplicationInstance(bundleId: "com.example.app", pid: 21, active: false, hidden: false, hasWindow: true),
        ])
        #expect(rows[0].representative == 1)
    }

    /// The row describes the application, not the one process that lent it a
    /// pid: a helper that is hidden must not make a visible application read as
    /// hidden, and a hidden application stays hidden only if all of it is.
    @Test("active and hidden describe the whole application")
    func stateIsFoldedAcrossProcesses() {
        let visible = MacHost.applicationRows([
            MacHost.ApplicationInstance(bundleId: "com.example.app", pid: 30, active: false, hidden: true, hasWindow: false),
            MacHost.ApplicationInstance(bundleId: "com.example.app", pid: 31, active: true, hidden: false, hasWindow: true),
        ])
        #expect(visible[0].active)
        #expect(!visible[0].hidden)

        let allHidden = MacHost.applicationRows([
            MacHost.ApplicationInstance(bundleId: "com.example.app", pid: 40, active: false, hidden: true, hasWindow: false),
            MacHost.ApplicationInstance(bundleId: "com.example.app", pid: 41, active: false, hidden: true, hasWindow: false),
        ])
        #expect(!allHidden[0].active)
        #expect(allHidden[0].hidden)
    }

    /// A tie must not depend on the window server's listing order.
    @Test("a tie keeps the earlier process")
    func tiesKeepTheEarlierProcess() {
        let rows = MacHost.applicationRows([
            MacHost.ApplicationInstance(bundleId: "com.example.app", pid: 50, active: false, hidden: false, hasWindow: true),
            MacHost.ApplicationInstance(bundleId: "com.example.app", pid: 51, active: false, hidden: false, hasWindow: true),
        ])
        #expect(rows[0].representative == 0)
    }
}

@Suite("pointer buttons")
struct PointerButtonTests {

    /// The button name a model sends maps to the Quartz button number, and an
    /// unknown name maps to nothing rather than silently defaulting to left —
    /// which would turn a typo into a click on the wrong button.
    @Test("known names map and unknown names do not")
    func buttonNames() {
        #expect(Pointer.buttonNumber("left") == .left)
        #expect(Pointer.buttonNumber("right") == .right)
        #expect(Pointer.buttonNumber("middle") == .center)
        #expect(Pointer.buttonNumber("center") == .center)
        #expect(Pointer.buttonNumber("Left") == nil)
        #expect(Pointer.buttonNumber("primary") == nil)
        #expect(Pointer.buttonNumber("") == nil)
    }

    /// The command's defaults are what `route: "pid"` without a pid falls back
    /// on, so they are part of the delivery contract rather than cosmetics.
    @Test("a pointer command defaults to the session stream and the left button")
    func commandDefaults() {
        let command = Pointer.Command()
        #expect(command.route == .post)
        #expect(command.button == "left")
        #expect(command.targetPid == nil)
    }
}

@Suite("MCP tool catalog")
struct McpCatalogTests {

    /// Every published tool must describe its schema as an object with a
    /// `properties` map and a `required` array, because MCP clients differ in
    /// whether they reject an absent value.
    @Test("every tool schema is an object with properties and required")
    func schemasAreObjects() {
        #expect(!McpServer.tools.isEmpty)
        for tool in McpServer.tools {
            #expect(tool.schema["type"]?.stringValue == "object", "\(tool.name) is not an object schema")
            #expect(tool.schema["properties"]?.objectValue != nil, "\(tool.name) declares no properties")
            #expect(tool.schema["required"]?.arrayValue != nil, "\(tool.name) declares no required array")
        }
    }

    /// Tool names are what a model calls and what the harness namespaces, so a
    /// duplicate or an empty one is a broken catalog.
    @Test("tool names are unique, namespaced, and described")
    func namesAreUnique() {
        var seen = Set<String>()
        for tool in McpServer.tools {
            #expect(!tool.name.isEmpty)
            #expect(tool.name.hasPrefix("cua_"), "\(tool.name) is not in the cua_ namespace")
            #expect(!tool.description.isEmpty, "\(tool.name) has no description")
            #expect(!tool.method.isEmpty, "\(tool.name) routes to no engine method")
            #expect(seen.insert(tool.name).inserted, "\(tool.name) is declared twice")
        }
    }

    /// Every required parameter must be a declared property, or the schema
    /// describes a call no client can construct.
    @Test("every required parameter is declared")
    func requiredParametersAreDeclared() {
        for tool in McpServer.tools {
            let properties = tool.schema["properties"]?.objectValue ?? [:]
            for required in tool.schema["required"]?.arrayValue ?? [] {
                let name = try? #require(required.stringValue)
                #expect(name.flatMap { properties[$0] } != nil, "\(tool.name) requires undeclared `\(name ?? "")`")
            }
        }
    }

    /// `cua_type` and `cua_key` share one engine method and are told apart only
    /// by the parameter each fixes, so a missing or colliding fix would make one
    /// tool call the other's action.
    ///
    /// A fixed parameter is deliberately absent from the published schema: the
    /// server drops fixed keys from `properties`, so a model cannot set the one
    /// thing the tool has already decided. `cua_element` is the exception that
    /// proves the intent — there `action` is *also* fixed, because `element.action`
    /// is reached through `cua_element` alone.
    @Test("fixed parameters discriminate the shared method")
    func fixedParametersDiscriminate() {
        let keyboardTools = McpServer.tools.filter { $0.method == "keyboard" }
        #expect(keyboardTools.count == 2, "keyboard backs exactly cua_type and cua_key")
        var actions = Set<String>()
        for tool in keyboardTools {
            let fixed = try? #require(tool.fixed["action"])
            #expect(fixed != nil, "\(tool.name) does not fix `action`")
            let properties = tool.schema["properties"]?.objectValue ?? [:]
            for key in tool.fixed.keys {
                #expect(
                    properties[key] == nil,
                    "\(tool.name) still publishes the fixed parameter `\(key)`, so a model can override it"
                )
            }
            if let action = tool.fixed["action"]?.stringValue {
                #expect(actions.insert(action).inserted, "two keyboard tools fix the same action")
            }
        }
    }

    /// A required parameter must survive into the published schema, because a
    /// client sends what the schema asks for and nothing else.
    @Test("required parameters are published, and only those")
    func requiredParametersArePublished() {
        for tool in McpServer.tools {
            let properties = tool.schema["properties"]?.objectValue ?? [:]
            let required = (tool.schema["required"]?.arrayValue ?? []).compactMap(\.stringValue)
            for name in required {
                #expect(properties[name] != nil, "\(tool.name) requires undeclared `\(name)`")
            }
            for name in tool.fixed.keys {
                #expect(!required.contains(name), "\(tool.name) both fixes and requires `\(name)`")
            }
        }
    }
}
