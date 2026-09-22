import Foundation
import AppKit

/// Application lifecycle and inter-application messaging.
///
/// Two mechanisms are used because they need different permissions and have
/// different reach:
///
/// * **Workspace / accessibility** — activation, hiding, quitting, raising a
///   window, and pressing a menu item. These are ordinary API calls the engine
///   performs itself; they need only Accessibility permission, and the target
///   app receives a real user action rather than a synthesized one. This is the
///   default channel because it never prompts.
/// * **Apple events** — a script sent to another app. This is the "GUI message"
///   channel: it can drive any scriptable app (Finder, Safari, Music, Terminal)
///   without touching the pointer or keyboard. macOS gates it behind the
///   Automation permission, and the first call for a target raises a system
///   dialog, so it always runs under a deadline on its own queue.
enum AppleEvents {
    /// Whether an AppleScript is still inside `executeAndReturnError`.
    ///
    /// `NSAppleScript` is not interruptible: a script parked on an Automation
    /// permission dialog occupies its thread until the user answers it. The
    /// engine therefore stops starting new scripts rather than stacking more
    /// work onto a thread that may never come back.
    private static let scriptStateLock = NSLock()
    nonisolated(unsafe) private static var scriptInFlight = false

    private static func beginScript() -> Bool {
        scriptStateLock.lock()
        defer { scriptStateLock.unlock() }
        guard !scriptInFlight else { return false }
        scriptInFlight = true
        return true
    }

    private static func endScript() {
        scriptStateLock.lock()
        scriptInFlight = false
        scriptStateLock.unlock()
    }

    /// Run one AppleScript source, optionally targeting a bundle id.
    ///
    /// - Parameters:
    ///   - source: the script text.
    ///   - bundleId: when present, the script is wrapped in a `tell application id`
    ///     block so the caller does not have to know the app's display name.
    ///   - timeoutSeconds: per-event timeout handed to the target, and the basis
    ///     for the hard deadline this engine also enforces.
    /// - Returns: the script result encoded as JSON.
    static func runScript(source: String, bundleId: String?, timeoutSeconds: Int) -> JSONValue {
        guard beginScript() else {
            return jsonObject([
                "executed": .bool(false),
                "timeout": .bool(true),
                "reason": .string(
                    "a previous AppleScript is still running; it is likely waiting on an Automation permission dialog. "
                        + "Answer or dismiss that dialog before sending another script."
                ),
            ])
        }
        defer { endScript() }

        let script = bundleId.map {
            """
            with timeout of \(timeoutSeconds) seconds
            tell application id "\($0)"
            \(source)
            end tell
            end timeout
            """
        } ?? source

        guard let appleScript = NSAppleScript(source: script) else {
            return jsonObject([
                "executed": .bool(false),
                "reason": .string("the script could not be compiled"),
            ])
        }

        // A worker queue plus a semaphore gives the engine a deadline the
        // AppleScript API does not offer. On timeout the worker stays blocked and
        // the in-flight flag keeps later requests from piling up behind it.
        let box = ScriptResultBox()
        let semaphore = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            var errorInfo: NSDictionary?
            let outcome = appleScript.executeAndReturnError(&errorInfo)
            box.store(value: outcome.stringValue, error: errorInfo)
            semaphore.signal()
        }

        let deadline = DispatchTime.now() + .milliseconds(Int((Double(timeoutSeconds) + 5.0) * 1000))
        guard semaphore.wait(timeout: deadline) == .success else {
            return jsonObject([
                "executed": .bool(false),
                "timeout": .bool(true),
                "reason": .string(
                    "the AppleScript did not finish within \(timeoutSeconds)s. "
                        + "If macOS is showing an Automation permission dialog, answer it and retry; "
                        + "otherwise the target application is not responding to Apple events."
                ),
            ])
        }

        if let errorInfo = box.error {
            let number = errorInfo[NSAppleScript.errorNumber] as? Int ?? 0
            let message = errorInfo[NSAppleScript.errorMessage] as? String ?? "unknown AppleScript error"
            // -1743 and -600 are the Automation-permission rejections; surface
            // them as a permission problem so the caller gets the remediation
            // rather than a bare error number.
            let denied = number == -1743 || number == -600
            return jsonObject([
                "executed": .bool(false),
                "errorNumber": .int(number),
                "errorMessage": .string(message),
                "permissionDenied": .bool(denied),
                "reason": .string(denied
                    ? "macOS refused the Apple event: the process hosting this engine is not authorized to control this app. "
                        + "Grant it under System Settings → Privacy & Security → Automation."
                    : message),
            ])
        }
        return jsonObject([
            "executed": .bool(true),
            "result": .string(box.value ?? ""),
        ])
    }

    /// Hand-off box between the script queue and the request thread.
    private final class ScriptResultBox: @unchecked Sendable {
        private let lock = NSLock()
        private var storedValue: String?
        private var storedError: NSDictionary?

        func store(value: String?, error: NSDictionary?) {
            lock.lock()
            storedValue = value
            storedError = error
            lock.unlock()
        }

        var value: String? {
            lock.lock()
            defer { lock.unlock() }
            return storedValue
        }

        var error: NSDictionary? {
            lock.lock()
            defer { lock.unlock() }
            return storedError
        }
    }

    /// Open a URL through the default handler.
    static func open(url: String, bundleId: String?) -> JSONValue {
        guard let target = URL(string: url) else {
            return jsonObject(["opened": .bool(false), "reason": .string("not a valid URL: \(url)")])
        }
        if let bundleId, let appUrl = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            var opened = false
            let semaphore = DispatchSemaphore(value: 0)
            NSWorkspace.shared.open([target], withApplicationAt: appUrl, configuration: configuration) { _, error in
                opened = error == nil
                semaphore.signal()
            }
            _ = semaphore.wait(timeout: .now() + 10)
            return jsonObject([
                "opened": .bool(opened),
                "url": .string(url),
                "bundleId": .string(bundleId),
            ])
        }
        let opened = NSWorkspace.shared.open(target)
        return jsonObject(["opened": .bool(opened), "url": .string(url)])
    }

    /// Reveal a path in Finder.
    static func reveal(path: String) -> JSONValue {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else {
            return jsonObject(["revealed": .bool(false), "reason": .string("no such path: \(path)")])
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
        return jsonObject(["revealed": .bool(true), "path": .string(path)])
    }

    /// Launch an application by bundle id, returning the resulting process.
    static func launch(bundleId: String) -> JSONValue {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            return jsonObject([
                "launched": .bool(false),
                "reason": .string("no installed application with bundle id \(bundleId)"),
            ])
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        var launchedPid: pid_t?
        let semaphore = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, _ in
            launchedPid = app?.processIdentifier
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 20)
        return jsonObject([
            "launched": .bool(launchedPid != nil),
            "bundleId": .string(bundleId),
            "pid": launchedPid.map { Int($0) }.jsonField,
        ])
    }
}
