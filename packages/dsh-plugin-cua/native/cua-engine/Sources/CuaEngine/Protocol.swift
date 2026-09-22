import Foundation

/// Bumped whenever the wire contract changes in a way the plugin must notice.
public let engineProtocolVersion = 1

/// The engine's identity, reported by `engine.status`.
public let engineVersion = "0.1.0"

// MARK: - Faults

/// A structured failure carried back to the caller as `error.code`/`error.message`.
///
/// Codes are part of the contract; the plugin maps them onto stable tool
/// failures, so a new code is a protocol decision rather than a detail.
public enum CuaError: Error, Sendable {
    /// The request is not valid JSON, or a parameter has the wrong shape/type.
    case invalidRequest(String)
    /// The method name is not part of this engine's surface.
    case unknownMethod(String)
    /// The named target (pid, window, element, or app) does not exist.
    case notFound(String)
    /// macOS has not granted the permission this method needs.
    case permissionDenied(String)
    /// The target exists but refused or could not complete the operation.
    case operationFailed(String)
    /// The engine is not running on the platform this build targets.
    case unsupportedPlatform(String)

    public var code: String {
        switch self {
        case .invalidRequest: return "invalid_request"
        case .unknownMethod: return "unknown_method"
        case .notFound: return "not_found"
        case .permissionDenied: return "permission_denied"
        case .operationFailed: return "operation_failed"
        case .unsupportedPlatform: return "unsupported_platform"
        }
    }

    public var message: String {
        switch self {
        case .invalidRequest(let text),
             .unknownMethod(let text),
             .notFound(let text),
             .permissionDenied(let text),
             .operationFailed(let text),
             .unsupportedPlatform(let text):
            return text
        }
    }

    /// Extra actionable fields, such as the System Settings pane that unblocks it.
    public var details: [String: JSONValue] {
        switch self {
        case .permissionDenied:
            return ["settingsPane": .string("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")]
        default:
            return [:]
        }
    }
}

/// One decoded request line.
public struct EngineRequest: Sendable {
    public let id: JSONValue
    public let method: String
    public let params: JSONValue?

    public init(id: JSONValue, method: String, params: JSONValue?) {
        self.id = id
        self.method = method
        self.params = params
    }

    /// Decode one request line, rejecting anything without an id/method pair.
    public static func decode(_ line: String) throws -> EngineRequest {
        let value = try JSONValue.parse(line)
        guard case .object = value else {
            throw CuaError.invalidRequest("request must be a JSON object")
        }
        guard let id = value["id"], id != .null else {
            throw CuaError.invalidRequest("request is missing \"id\"")
        }
        guard let method = value["method"]?.stringValue, !method.isEmpty else {
            throw CuaError.invalidRequest("request is missing a non-empty \"method\"")
        }
        return EngineRequest(id: id, method: method, params: value["params"])
    }
}

/// One response line: exactly one of `result` or `error`.
public enum EngineResponse: Sendable {
    case result(id: JSONValue, value: JSONValue)
    case failure(id: JSONValue, error: CuaError)

    /// Render this response as one newline-terminated JSON line.
    public func encodedLine() -> Data {
        let payload: JSONValue
        switch self {
        case .result(let id, let value):
            payload = jsonObject(["id": id, "result": value])
        case .failure(let id, let error):
            var details = error.details
            details["code"] = .string(error.code)
            details["message"] = .string(error.message)
            payload = jsonObject(["id": id, "error": .object(details)])
        }
        // `encoded()` only throws for non-JSON graphs, which this enum cannot
        // build; the fallback keeps the loop alive if that ever changes.
        let data = (try? payload.encoded()) ?? Data(#"{"error":{"code":"encoding_failed"}}"#.utf8)
        return data + Data([0x0A])
    }
}

// MARK: - Capability seam

/// The set of host operations a platform backend must provide.
///
/// The macOS backend is the only implementation today; keeping the protocol
/// explicit is what lets a Windows (UIAutomation) or Linux (AT-SPI) backend be
/// added without touching the protocol layer, the dispatch loop, or the plugin.
public protocol PlatformHost: Sendable {
    /// Human-readable backend name, reported by `engine.status`.
    var backendName: String { get }

    /// Current state of every permission this backend needs.
    func permissionStatus() -> JSONValue
    /// Raise the OS prompts that lead to granting those permissions.
    func requestPermissions() throws -> JSONValue

    /// Running and installed applications.
    func listApps(_ params: ParamsReader) throws -> JSONValue
    /// Windows across all applications, or one application.
    func listWindows(_ params: ParamsReader) throws -> JSONValue
    /// Displays with their geometry and density.
    func listDisplays(_ params: ParamsReader) async throws -> JSONValue
    /// Accessibility elements of one application or window.
    func readTree(_ params: ParamsReader) throws -> JSONValue

    /// Capture a window, display, or rectangle.
    func screenshot(_ params: ParamsReader) async throws -> JSONValue

    /// Pointer actions: click, move, scroll, drag.
    func pointer(_ params: ParamsReader) async throws -> JSONValue
    /// Keyboard actions: text entry and key chords.
    func keyboard(_ params: ParamsReader) throws -> JSONValue
    /// Perform the element's own action (AXPress and friends).
    func elementAction(_ params: ParamsReader) async throws -> JSONValue

    /// Application lifecycle and direct Apple-event messaging.
    func app(_ params: ParamsReader) async throws -> JSONValue
}

public extension PlatformHost {
    /// The macOS backend ignores unknown permission requests rather than failing.
    func requestPermissions() throws -> JSONValue {
        throw CuaError.unsupportedPlatform("\(backendName) cannot request permissions")
    }

    func listDisplays(_ params: ParamsReader) async throws -> JSONValue {
        throw CuaError.unsupportedPlatform("\(backendName) has no display backend")
    }

    func pointer(_ params: ParamsReader) async throws -> JSONValue {
        throw CuaError.unsupportedPlatform("\(backendName) has no pointer backend")
    }

    func keyboard(_ params: ParamsReader) throws -> JSONValue {
        throw CuaError.unsupportedPlatform("\(backendName) has no keyboard backend")
    }

    func elementAction(_ params: ParamsReader) async throws -> JSONValue {
        throw CuaError.unsupportedPlatform("\(backendName) has no element backend")
    }
}
