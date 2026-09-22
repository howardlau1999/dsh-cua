import Foundation

#if canImport(Darwin)
import Darwin
#endif

/// The engine's dispatch loop: one JSON request per line in, one JSON response
/// per line out, errors contained per request so a malformed call never takes
/// the process down.
public struct Engine: Sendable {
    private let host: any PlatformHost

    public init(host: any PlatformHost) {
        self.host = host
    }

    /// A human-readable description of the backend, used in `engine.status`.
    public var backendName: String { host.backendName }

    /// Handle one request line, always returning a response to write back.
    public func handle(line: String) -> EngineResponse {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        // A bare id keeps spontaneous diagnostics honest if the line is unusable.
        guard !trimmed.isEmpty else {
            return .failure(id: .null, error: .invalidRequest("empty request line"))
        }
        let request: EngineRequest
        do {
            request = try EngineRequest.decode(trimmed)
        } catch let error as CuaError {
            return .failure(id: .null, error: error)
        } catch let fault as JSONFault {
            return .failure(id: .null, error: .invalidRequest(fault.reason))
        } catch {
            return .failure(id: .null, error: .invalidRequest("\(error)"))
        }
        return dispatch(request)
    }

    /// Route one decoded request to its capability.
    public func dispatch(_ request: EngineRequest) -> EngineResponse {
        do {
            let params = try ParamsReader(request.params, method: request.method)
            let value = try route(request.method, params)
            return .result(id: request.id, value: value)
        } catch let error as CuaError {
            return .failure(id: request.id, error: error)
        } catch let fault as JSONFault {
            return .failure(id: request.id, error: .invalidRequest(fault.reason))
        } catch {
            return .failure(id: request.id, error: .operationFailed("\(request.method): \(error)"))
        }
    }

    /// The half of the surface that needs no suspension: everything that only
    /// talks to the accessibility and workspace APIs. Anything that may need the
    /// async ScreenCaptureKit display list is routed in `dispatchAsync`.
    private func route(_ method: String, _ params: ParamsReader) throws -> JSONValue {
        switch method {
        case "engine.status":
            return jsonObject([
                "engine": .string(engineVersion),
                "protocol": .int(engineProtocolVersion),
                "backend": .string(host.backendName),
                "platform": .string(PlatformInfo.name),
                "platformVersion": .string(PlatformInfo.version),
                "processId": .int(Int(ProcessInfo.processInfo.processIdentifier)),
                "permissions": host.permissionStatus(),
            ])

        case "engine.permissions":
            return host.permissionStatus()

        case "engine.request_permissions":
            return try host.requestPermissions()

        case "app.list":
            return try host.listApps(params)

        case "window.list":
            return try host.listWindows(params)

        case "tree.dump":
            return try host.readTree(params)

        case "keyboard":
            return try host.keyboard(params)

        default:
            throw CuaError.unknownMethod("unknown method \"\(method)\"")
        }
    }

    /// The asynchronous half of the surface, which screen capture requires.
    public func dispatchAsync(_ request: EngineRequest) async -> EngineResponse {
        do {
            let params = try ParamsReader(request.params, method: request.method)
            let value: JSONValue
            switch request.method {
            case "capture.screenshot":
                value = try await host.screenshot(params)
            case "app":
                value = try await host.app(params)
            case "display.list":
                value = try await host.listDisplays(params)
            case "pointer":
                value = try await host.pointer(params)
            case "element.action":
                value = try await host.elementAction(params)
            default:
                value = try route(request.method, params)
            }
            return .result(id: request.id, value: value)
        } catch let error as CuaError {
            return .failure(id: request.id, error: error)
        } catch let fault as JSONFault {
            return .failure(id: request.id, error: .invalidRequest(fault.reason))
        } catch {
            return .failure(id: request.id, error: .operationFailed("\(request.method): \(error)"))
        }
    }
}

/// Platform facts reported by `engine.status`.
public enum PlatformInfo {
    public static var name: String {
        #if os(macOS)
        return "macos"
        #elseif os(Windows)
        return "windows"
        #elseif os(Linux)
        return "linux"
        #else
        return "unknown"
        #endif
    }

    public static var version: String {
        let info = ProcessInfo.processInfo
        return "\(info.operatingSystemVersion.majorVersion).\(info.operatingSystemVersion.minorVersion).\(info.operatingSystemVersion.patchVersion)"
    }
}

// MARK: - Stdio loop

/// Run the line-oriented stdio protocol until stdin closes.
///
/// Each line is handled on the main actor because AppKit, Accessibility, and
/// ScreenCaptureKit all require it; requests are processed in order, which
/// keeps a click from overtaking the tree read that produced its target.
public func runStdioLoop(engine: Engine) async {
    let stdout = FileHandle.standardOutput
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        let request: EngineRequest
        do {
            request = try EngineRequest.decode(line)
        } catch {
            // Decode failures carry no usable id; answer with a null id and continue.
            write(EngineResponse.failure(id: .null, error: asCuaError(error)), to: stdout)
            continue
        }
        let response = await engine.dispatchAsync(request)
        write(response, to: stdout)
    }
}

/// Translate any thrown value into the protocol's error vocabulary.
func asCuaError(_ error: Error) -> CuaError {
    if let error = error as? CuaError { return error }
    if let fault = error as? JSONFault { return .invalidRequest(fault.reason) }
    return .operationFailed("\(error)")
}

/// Write one response line and flush so the plugin never waits on buffering.
func write(_ response: EngineResponse, to handle: FileHandle) {
    do {
        try handle.write(contentsOf: response.encodedLine())
    } catch {
        FileHandle.standardError.write(Data("cua-engine: stdout write failed: \(error)\n".utf8))
    }
}
