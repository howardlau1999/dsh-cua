using System.Text.Json.Nodes;

namespace CuaEngine;

/// <summary>
/// The set of host operations a platform backend must provide.
/// </summary>
/// <remarks>
/// This is the seam the whole engine is built around. The dispatch loop, the
/// request/response encoding, the parameter reader, and the plugin's tool layer
/// are all platform-independent; a backend implements exactly these members and
/// nothing above them changes. The macOS backend implements it in Swift, this
/// one in C#.
/// </remarks>
public interface IPlatformHost
{
    /// <summary>Human-readable backend name, reported by <c>engine.status</c>.</summary>
    string BackendName { get; }

    /// <summary>Current state of every permission this backend needs.</summary>
    JsonObject PermissionStatus();

    /// <summary>Raise the OS prompts that lead to granting those permissions.</summary>
    JsonObject RequestPermissions();

    /// <summary>Running and installed applications.</summary>
    JsonObject ListApps(Params parameters);

    /// <summary>Windows across all applications, or one application.</summary>
    JsonObject ListWindows(Params parameters);

    /// <summary>Displays with their geometry and density.</summary>
    JsonObject ListDisplays(Params parameters);

    /// <summary>Accessibility elements of one application or window.</summary>
    JsonObject ReadTree(Params parameters);

    /// <summary>Capture a window, display, or rectangle.</summary>
    JsonObject Screenshot(Params parameters);

    /// <summary>Pointer actions: click, move, scroll, drag.</summary>
    JsonObject Pointer(Params parameters);

    /// <summary>Keyboard actions: text entry and key chords.</summary>
    JsonObject Keyboard(Params parameters);

    /// <summary>Perform the element's own action (UIA patterns).</summary>
    JsonObject ElementAction(Params parameters);

    /// <summary>Application lifecycle and direct GUI messaging.</summary>
    JsonObject App(Params parameters);
}

/// <summary>
/// The engine's dispatch loop: one JSON request per line in, one JSON response
/// per line out, errors contained per request so a malformed call never takes
/// the process down.
/// </summary>
public sealed class Engine(IPlatformHost host)
{
    public string BackendName => host.BackendName;

    /// <summary>Handle one request line, always returning a response to write back.</summary>
    public string Handle(string line)
    {
        var trimmed = line.Trim();
        if (trimmed.Length == 0)
        {
            return EngineResponse.Failure(null, CuaException.Invalid("empty request line"));
        }
        EngineRequest request;
        try
        {
            request = EngineRequest.Decode(trimmed);
        }
        catch (Exception error)
        {
            // A decode failure carries no usable id, so the answer goes out with
            // a null one; the plugin drops it and the loop stays alive.
            return EngineResponse.Failure(null, EngineResponse.AsCuaError(error));
        }
        return Dispatch(request);
    }

    /// <summary>Route one decoded request to its capability.</summary>
    public string Dispatch(EngineRequest request)
    {
        try
        {
            var parameters = new Params(request.Params, request.Method);
            var value = request.Method switch
            {
                "engine.status" => Status(),
                "engine.permissions" => host.PermissionStatus(),
                "engine.request_permissions" => host.RequestPermissions(),
                "app.list" => host.ListApps(parameters),
                "window.list" => host.ListWindows(parameters),
                "display.list" => host.ListDisplays(parameters),
                "tree.dump" => host.ReadTree(parameters),
                "capture.screenshot" => host.Screenshot(parameters),
                "pointer" => host.Pointer(parameters),
                "keyboard" => host.Keyboard(parameters),
                "element.action" => host.ElementAction(parameters),
                "app" => host.App(parameters),
                _ => throw CuaException.UnknownMethod($"unknown method \"{request.Method}\""),
            };
            return EngineResponse.Result(request.Id, value);
        }
        catch (Exception error)
        {
            return EngineResponse.Failure(request.Id, EngineResponse.AsCuaError(error));
        }
    }

    private JsonObject Status() => new()
    {
        ["engine"] = EngineIdentity.Version,
        ["protocol"] = ProtocolVersion.Value,
        ["backend"] = host.BackendName,
        ["platform"] = PlatformInfo.Name,
        ["platformVersion"] = PlatformInfo.Version,
        ["processId"] = Environment.ProcessId,
        ["permissions"] = host.PermissionStatus(),
    };
}

/// <summary>Platform facts reported by <c>engine.status</c>.</summary>
public static class PlatformInfo
{
    public static string Name =>
        OperatingSystem.IsMacOS() ? "macos"
        : OperatingSystem.IsWindows() ? "windows"
        : OperatingSystem.IsLinux() ? "linux"
        : "unknown";

    /// <summary>
    /// The OS version as <c>major.minor.build</c>.
    /// </summary>
    /// <remarks>
    /// <see cref="Environment.OSVersion"/> only reports the real build when the
    /// process manifest claims support for this Windows version; the manifest in
    /// this project does, so the reported value is the actual build rather than
    /// the 6.2 compatibility shim.
    /// </remarks>
    public static string Version
    {
        get
        {
            var version = Environment.OSVersion.Version;
            return $"{version.Major}.{version.Minor}.{version.Build}";
        }
    }
}
