import Foundation
import AppKit
import ScreenCaptureKit
import CoreGraphics

/// Screen capture through ScreenCaptureKit.
///
/// `CGWindowListCreateImage` was obsoleted in macOS 15, so ScreenCaptureKit is
/// the only supported path. Captures are produced at native pixel density and
/// then optionally downscaled, because a Retina window capture is otherwise
/// 4x the pixels the model needs and every extra pixel costs tokens.
enum Capture {
    /// One resolved capture request.
    struct Request {
        /// A window to capture, when the call named one.
        var window: SCWindow?
        /// A display to capture, when the call named one.
        var display: SCDisplay?
        /// The screen rectangle being captured, in top-left-origin global points.
        /// This is both the capture source and the coordinate frame reported
        /// back to the caller, so there is one field rather than two.
        var region: CGRect
        /// Output pixel cap.
        var maxWidth: Int
        var maxHeight: Int
        /// JPEG quality when the format is jpeg.
        var quality: Double
        var format: String
        var showsCursor: Bool
    }

    /// Capture one image and encode it.
    ///
    /// - Returns: the encoded bytes, media type, and the geometry the caller
    ///   needs to map image pixels back to screen points. `scale` is measured
    ///   from the image that came back, so `region` + `scale` always describe the
    ///   image the caller receives — on a mixed-density setup that is the only
    ///   number that is true for this particular capture.
    static func run(_ request: Request) async throws -> JSONValue {
        let native = try await captureImage(request)
        let image = try downscaleIfNeeded(native, request: request)
        let encoded = try encode(image, format: request.format, quality: request.quality)

        let pointWidth = max(request.region.width, 1)
        let pointHeight = max(request.region.height, 1)
        return jsonObject([
            "data": .string(encoded.data.base64EncodedString()),
            "mimeType": .string(encoded.mimeType),
            "pixelWidth": .int(image.width),
            "pixelHeight": .int(image.height),
            "pointWidth": .double(Double(pointWidth)),
            "pointHeight": .double(Double(pointHeight)),
            "region": .array([
                .double(Double(request.region.origin.x.rounded())),
                .double(Double(request.region.origin.y.rounded())),
                .double(Double(request.region.width.rounded())),
                .double(Double(request.region.height.rounded())),
            ]),
            "scale": .double(Double(image.width) / Double(pointWidth)),
            "scaleY": .double(Double(image.height) / Double(pointHeight)),
            "byteLength": .int(encoded.data.count),
        ])
    }

    /// Produce the `CGImage` for one request.
    ///
    /// ScreenCaptureKit intermittently fails with `-3811` ("Failed to start
    /// stream due to audio/video capture failure") when captures arrive in quick
    /// succession, which a perceive/act/perceive loop hits routinely. The failure
    /// is transient, so a bounded retry runs before it becomes a tool failure.
    private static func captureImage(_ request: Request) async throws -> CGImage {
        if sessionLocked { throw lockedError() }
        var lastError: Error?
        for attempt in 1...3 {
            do {
                return try await captureOnce(request)
            } catch {
                lastError = error
                let nsError = error as NSError
                let transient = nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain"
                // A lock that happened mid-flight is not worth retrying.
                guard transient, attempt < 3, !sessionLocked else {
                    throw sessionLocked ? lockedError() : error
                }
                try? await Task.sleep(nanoseconds: UInt64(attempt) * 250_000_000)
            }
        }
        throw lastError ?? CuaError.operationFailed("screen capture failed")
    }

    /// One capture attempt; see `captureImage` for the retry policy.
    ///
    /// No output size is forced. Forcing one requires knowing the display's pixel
    /// density in advance, and on a mixed-density setup that guess caps the
    /// capture at the point size on one display while oversampling on another.
    /// Capturing at each target's native density and downscaling afterwards is
    /// simpler, correct on every layout, and what makes the measured `scale`
    /// trustworthy.
    private static func captureOnce(_ request: Request) async throws -> CGImage {
        if let window = request.window {
            // `desktopIndependentWindow` captures the window itself, even when it
            // is covered or sitting on another display, at that window's density.
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            // A region crop is expressed in the filter's own coordinate space,
            // whose origin is the window's top-left.
            let local = localRect(request.region, in: window.frame)
            if local != window.frame { configuration.sourceRect = local }
            // The window's own density, so a capture of a window on a scaled
            // display keeps the detail that display is showing.
            let scale = await density(ofDisplayContaining: window.frame)
            configuration.width = max(1, Int((request.region.width * scale).rounded()))
            configuration.height = max(1, Int((request.region.height * scale).rounded()))
            configuration.showsCursor = request.showsCursor
            configuration.capturesAudio = false
            configuration.scalesToFit = false
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        }

        if let display = request.display {
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let configuration = SCStreamConfiguration()
            let local = localRect(request.region, in: display.frame)
            if local != display.frame { configuration.sourceRect = local }
            let scale = await density(of: display)
            configuration.width = max(1, Int((request.region.width * scale).rounded()))
            configuration.height = max(1, Int((request.region.height * scale).rounded()))
            configuration.showsCursor = request.showsCursor
            configuration.capturesAudio = false
            configuration.scalesToFit = false
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        }

        // A plain screen rectangle. The display is resolved here, by largest
        // overlap, rather than left to `captureImage(in:)`: that convenience API
        // picks a density per call — it returns 2x for a small region and 1x for
        // a larger one on the very same screen — so two captures of the same
        // place can disagree about how many pixels a point is worth. Choosing the
        // display and sizing the output from its calibrated density makes the
        // density a property of one known screen, the same rule window and
        // display captures already follow.
        guard let display = try await displayContaining(rect: request.region) else {
            throw CuaError.notFound(
                "the requested region \(request.region) does not overlap any display"
            )
        }
        let scale = await density(of: display)
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.sourceRect = localRect(request.region, in: display.frame)
        configuration.width = max(1, Int((request.region.width * scale).rounded()))
        configuration.height = max(1, Int((request.region.height * scale).rounded()))
        configuration.showsCursor = request.showsCursor
        configuration.capturesAudio = false
        configuration.scalesToFit = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }

    /// Express a global rectangle in the local space of a container frame.
    private static func localRect(_ region: CGRect, in container: CGRect) -> CGRect {
        CGRect(
            x: region.origin.x - container.origin.x,
            y: region.origin.y - container.origin.y,
            width: region.width,
            height: region.height
        )
    }

    /// Apply the pixel budget to a natively captured image.
    ///
    /// The only place that resizes, so the reported scale always describes the
    /// image the caller actually receives.
    private static func downscaleIfNeeded(_ image: CGImage, request: Request) throws -> CGImage {
        let scaleDown = min(
            1.0,
            min(Double(request.maxWidth) / Double(image.width), Double(request.maxHeight) / Double(image.height))
        )
        guard scaleDown < 1.0 else { return image }
        let width = max(1, Int((Double(image.width) * scaleDown).rounded()))
        let height = max(1, Int((Double(image.height) * scaleDown).rounded()))
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            throw CuaError.operationFailed("could not allocate a \(width)x\(height) bitmap for downscaling")
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else {
            throw CuaError.operationFailed("downscaling produced no image")
        }
        return scaled
    }

    /// Encode an image as PNG or JPEG.
    static func encode(_ image: CGImage, format: String, quality: Double) throws -> (data: Data, mimeType: String) {
        let representation = NSBitmapImageRep(cgImage: image)
        switch format.lowercased() {
        case "jpeg", "jpg":
            guard let data = representation.representation(using: .jpeg, properties: [.compressionFactor: quality]) else {
                throw CuaError.operationFailed("JPEG encoding failed")
            }
            return (data, "image/jpeg")
        default:
            guard let data = representation.representation(using: .png, properties: [:]) else {
                throw CuaError.operationFailed("PNG encoding failed")
            }
            return (data, "image/png")
        }
    }

    // MARK: - Display geometry

    /// Every display as ScreenCaptureKit describes it.
    ///
    /// `SCDisplay.frame` is top-left-origin — the same space as window frames and
    /// the engine's own coordinates. `NSScreen.frame` is *not* (it is
    /// bottom-left-origin), so AppKit geometry is never used for a decision here:
    /// mixing the two silently mis-assigns displays whenever a secondary display
    /// sits above or left of the main one.
    static func displays() async throws -> [SCDisplay] {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        return content.displays
    }

    /// The shareable window matching a window-server id.
    static func shareableWindow(id: CGWindowID) async throws -> SCWindow? {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        return content.windows.first { $0.windowID == id }
    }

    /// The shareable display matching a display id.
    static func shareableDisplay(id: CGDirectDisplayID) async throws -> SCDisplay? {
        try await displays().first { $0.displayID == id }
    }

    /// The main display's id, for callers that want to name it.
    static var mainDisplayId: CGDirectDisplayID { CGMainDisplayID() }

    /// Measured native density per display, filled in on first use.
    ///
    /// Neither `SCDisplay.width / frame.width` nor a capture's result can be
    /// trusted to be *stable*: the reported ratio is 1 on displays that capture
    /// at 2x, and the rectangle convenience API silently drops to 1x for larger
    /// regions. Calibrating once per display — capture its whole frame with no
    /// forced size and measure — gives one number that both region logic and
    /// result reporting can agree on.
    nonisolated(unsafe) private static var calibratedDensity: [CGDirectDisplayID: Double] = [:]

    /// Read the cached density without holding a lock across a suspension point.
    ///
    /// The engine answers one request at a time on the main actor, so this
    /// dictionary has a single possible accessor; a lock would only add the
    /// hazard of holding it across an `await`.
    private static func cachedDensity(_ id: CGDirectDisplayID) -> Double? {
        calibratedDensity[id]
    }

    private static func storeDensity(_ id: CGDirectDisplayID, _ value: Double) {
        calibratedDensity[id] = value
    }

    /// Native pixels per screen point for one display, measured once.
    static func density(of display: SCDisplay) async -> Double {
        if let cached = cachedDensity(display.displayID) { return cached }

        // A first guess that is never wrong in the "too small" direction: if the
        // ratio overstates the density the capture is downscaled by the forced
        // size, and the measurement below corrects it.
        var estimate = Double(display.width) / max(Double(display.frame.width), 1)
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.scalesToFit = false
        if let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) {
            let measured = Double(image.width) / max(Double(display.frame.width), 1)
            // Only accept a measurement that is at least a nominal 1x, and keep
            // the reported estimate when the sample is implausible.
            if measured >= 1.0, measured <= 4.0 { estimate = measured }
        }
        storeDensity(display.displayID, estimate)
        return estimate
    }

    /// The display covering most of a rectangle.
    ///
    /// Overlap rather than containment: a window straddling two displays has no
    /// single containing display, and answering "none" would be worse than
    /// answering with the one showing most of it.
    static func displayCovering(rect: CGRect, among displays: [SCDisplay]) -> SCDisplay? {
        var best: (display: SCDisplay, area: CGFloat)?
        for display in displays {
            let overlap = display.frame.intersection(rect)
            guard !overlap.isNull, overlap.width > 0, overlap.height > 0 else { continue }
            let area = overlap.width * overlap.height
            if best == nil || area > best!.area { best = (display, area) }
        }
        return best?.display
    }

    /// The display containing (most of) a rectangle.
    static func displayContaining(rect: CGRect) async throws -> SCDisplay? {
        displayCovering(rect: rect, among: try await displays())
    }

    /// The calibrated density of the display showing most of a rectangle.
    static func density(ofDisplayContaining rect: CGRect) async -> Double {
        guard let display = displayCovering(rect: rect, among: (try? await displays()) ?? []) else {
            return 1.0
        }
        return await density(of: display)
    }

    // MARK: - Session state

    /// Whether the console session is locked or the screen is asleep.
    ///
    /// This matters because capture fails with an opaque ScreenCaptureKit error
    /// (`-3811`) while locked, and so does useful accessibility work: the
    /// frontmost application becomes `loginwindow`. Reporting the real cause is
    /// the difference between a model retrying forever and telling the user to
    /// unlock the screen.
    static var sessionLocked: Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        if session["CGSSessionScreenIsLocked"] as? Bool == true { return true }
        if session["kCGSSessionOnConsoleKey"] as? Bool == false { return true }
        return false
    }

    /// A capture error that names the real cause when the session is locked.
    static func lockedError() -> CuaError {
        .operationFailed(
            "the screen is locked, so nothing can be captured. Wake and unlock the Mac, then retry. "
                + "(While locked, the frontmost application is also reported as loginwindow, so UI trees and input are unreliable too.)"
        )
    }

    /// The union of every display, in top-left-origin global points.
    static func desktopBounds() async -> CGRect {
        var union = CGRect.null
        if let displays = try? await displays() {
            for display in displays { union = union.union(display.frame) }
        }
        return union.isNull ? CGRect(x: 0, y: 0, width: 1920, height: 1080) : union
    }

    /// Whether a top-left-origin point lies on some display.
    ///
    /// A point outside every display does not exist. The window server clamps
    /// such a point to the nearest screen edge and delivers the event anyway,
    /// which turns a coordinate mistake into a click somewhere the caller never
    /// asked for.
    static func isOnDesktop(_ point: CGPoint) async -> Bool {
        await desktopBounds().contains(point)
    }

    // MARK: - Coordinate spaces

    /// Convert a top-left-origin global point into the bottom-left-origin space
    /// `CGEvent` uses for cursor positions.
    ///
    /// The window server and the accessibility API agree on top-left origin with
    /// the primary display's top-left at (0, 0); Quartz events use the primary
    /// display's *bottom*-left. Screenshots and UI trees report the former, so
    /// every click has to cross this boundary exactly once.
    static func eventPoint(fromScreenPoint point: CGPoint) -> CGPoint {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? NSScreen.main?.frame.height ?? 0
        return CGPoint(x: point.x, y: primaryHeight - point.y)
    }

    /// The inverse of `eventPoint`.
    static func screenPoint(fromEventPoint point: CGPoint) -> CGPoint {
        eventPoint(fromScreenPoint: point)
    }
}
