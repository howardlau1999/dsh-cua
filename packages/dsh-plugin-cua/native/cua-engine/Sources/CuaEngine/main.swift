import Foundation

// Top-level `await` is the SwiftPM entry point for an async command-line tool;
// the tool has no other top-level state to own.

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.contains("--help") || arguments.contains("-h") {
    print("""
    cua-engine — computer-use engine for the DeepSeek Harness CUA plugin.

    Usage:
      cua-engine                 Serve newline-delimited JSON requests on stdio.
      cua-engine --probe         Print one engine.status response and exit.
      cua-engine --version       Print version and platform, then exit.
      cua-engine --help          Print this message.

    Protocol: one JSON object per line in, one JSON object per line out.
      {"id":1,"method":"engine.status","params":{}}
    Each response carries either "result" or "error".
    """)
    exit(0)
}

if arguments.contains("--version") {
    print("cua-engine \(engineVersion) (protocol \(engineProtocolVersion), \(PlatformInfo.name) \(PlatformInfo.version))")
    exit(0)
}

#if os(macOS)
let host: any PlatformHost = MacHost()
#else
let host: any PlatformHost = UnsupportedHost()
#endif


/// Placeholder backend for a platform without an implementation yet. It answers
/// `engine.status` honestly so the plugin reports an unsupported host instead of
/// hanging on a missing capability.
struct UnsupportedHost: PlatformHost {
    var backendName: String { "unsupported" }

    func permissionStatus() -> JSONValue {
        jsonObject([
            "platformSupported": .bool(false),
            "platform": .string(PlatformInfo.name),
        ] as [String: JSONValue])
    }

    func listApps(_ params: ParamsReader) throws -> JSONValue {
        throw CuaError.unsupportedPlatform("no application backend for \(PlatformInfo.name)")
    }

    func listWindows(_ params: ParamsReader) throws -> JSONValue {
        throw CuaError.unsupportedPlatform("no window backend for \(PlatformInfo.name)")
    }

    func readTree(_ params: ParamsReader) throws -> JSONValue {
        throw CuaError.unsupportedPlatform("no accessibility backend for \(PlatformInfo.name)")
    }

    func screenshot(_ params: ParamsReader) async throws -> JSONValue {
        throw CuaError.unsupportedPlatform("no screen-capture backend for \(PlatformInfo.name)")
    }

    func app(_ params: ParamsReader) async throws -> JSONValue {
        throw CuaError.unsupportedPlatform("no application backend for \(PlatformInfo.name)")
    }

    func pointer(_ params: ParamsReader) async throws -> JSONValue {
        throw CuaError.unsupportedPlatform("no pointer backend for \(PlatformInfo.name)")
    }

    func elementAction(_ params: ParamsReader) async throws -> JSONValue {
        throw CuaError.unsupportedPlatform("no element backend for \(PlatformInfo.name)")
    }
}

let engine = Engine(host: host)

if arguments.contains("--probe") {
    // One status response and exit, which is how setup checks permissions
    // without starting a session.
    let request = EngineRequest(id: .string("probe"), method: "engine.status", params: nil)
    FileHandle.standardOutput.write(await engine.dispatchAsync(request).encodedLine())
    exit(0)
}

if let methodIndex = arguments.firstIndex(of: "--call") {
    // One arbitrary request and exit: the CLI smoke-test path, and the way to
    // check a single method from a shell without writing a protocol client.
    let method = arguments.count > methodIndex + 1 ? arguments[methodIndex + 1] : "engine.status"
    var params: JSONValue?
    if let paramsIndex = arguments.firstIndex(of: "--params"), arguments.count > paramsIndex + 1 {
        params = try? JSONValue.parse(arguments[paramsIndex + 1])
    }
    let request = EngineRequest(id: .string("cli"), method: method, params: params)
    FileHandle.standardOutput.write(await engine.dispatchAsync(request).encodedLine())
    exit(0)
}

await runStdioLoop(engine: engine)
