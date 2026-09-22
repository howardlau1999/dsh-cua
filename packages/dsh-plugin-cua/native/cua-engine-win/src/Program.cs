using System.IO;
using System.Text;
using System.Text.Json.Nodes;
using CuaEngine.Win;

namespace CuaEngine;

/// <summary>
/// The engine's process entry point and its stdio loop.
/// </summary>
/// <remarks>
/// The whole program runs on one STA thread. That is not incidental: the
/// managed UI Automation client is a COM apartment object, and every call into
/// it — and every COM automation an application action performs on the engine's
/// behalf — has to happen on the apartment that created it. A second thread
/// would either marshal every property read or silently return empty results.
/// Serialising requests on one thread is also what keeps a click from overtaking
/// the tree read that produced its target.
/// </remarks>
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        // Redundant with the manifest, but the manifest is only consulted for
        // the executable: a `dotnet run` host or an embedding process still gets
        // the right coordinate space. A second call is a documented no-op.
        TryMakePerMonitorDpiAware();

        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

        if (Has(args, "--help") || Has(args, "-h"))
        {
            stdout.WriteLine(HelpText);
            return 0;
        }

        if (Has(args, "--version"))
        {
            stdout.WriteLine(
                $"cua-engine {EngineIdentity.Version} (protocol {ProtocolVersion.Value}, {PlatformInfo.Name} {PlatformInfo.Version})");
            return 0;
        }

        var engine = new Engine(CreateHost(args));

        // `--mcp` serves the Model Context Protocol on stdio instead of this
        // engine's own protocol, so the harness's existing MCP client can expose
        // these tools. The two loops differ only in the envelope they put around
        // the same dispatch.
        if (Has(args, "--mcp"))
        {
            McpServer.Serve(engine, stdin, stdout);
            return 0;
        }

        if (Has(args, "--probe"))
        {
            // One status response and exit, which is how a setup check reads the
            // permission state without starting a session.
            stdout.WriteLine(engine.Dispatch(new EngineRequest("probe", "engine.status", null)));
            return 0;
        }

        var callIndex = Array.IndexOf(args, "--call");
        if (callIndex >= 0)
        {
            var method = args.Length > callIndex + 1 ? args[callIndex + 1] : "engine.status";
            JsonNode? parameters = null;
            var paramsIndex = Array.IndexOf(args, "--params");
            if (paramsIndex >= 0 && args.Length > paramsIndex + 1)
            {
                try
                {
                    parameters = JsonNode.Parse(args[paramsIndex + 1]);
                }
                catch (Exception error)
                {
                    stdout.WriteLine(EngineResponse.Failure(
                        "cli", CuaException.Invalid($"--params is not valid JSON: {error.Message}")));
                    return 1;
                }
            }
            stdout.WriteLine(engine.Dispatch(new EngineRequest("cli", method, parameters)));
            return 0;
        }

        Serve(engine, stdin, stdout);
        return 0;
    }

    /// <summary>Answer one request per input line until stdin closes.</summary>
    private static void Serve(Engine engine, TextReader stdin, TextWriter stdout)
    {
        while (stdin.ReadLine() is { } line)
        {
            if (line.Length == 0) continue;
            try
            {
                stdout.WriteLine(engine.Handle(line));
            }
            catch (Exception error)
            {
                // Handle() already contains per-request failures; this is the
                // last-resort guard so a bug in response encoding cannot end the
                // session by taking the loop down with it.
                WriteDiagnostic($"request failed outside the dispatch guard: {error}");
            }
        }
    }

    private static IPlatformHost CreateHost(string[] args)
    {
        if (OperatingSystem.IsWindows())
        {
            return new WinHost(new WinHostOptions
            {
                AllowScript = Has(args, "--allow-script"),
            });
        }
        return new UnsupportedHost();
    }

    private static bool Has(string[] args, string flag) => Array.IndexOf(args, flag) >= 0;

    /// <summary>Write a diagnostic to stderr, which the plugin forwards to its log.</summary>
    internal static void WriteDiagnostic(string message)
    {
        try
        {
            Console.Error.WriteLine($"cua-engine: {message}");
        }
        catch (IOException)
        {
            // A closed stderr must not be able to fail a request.
        }
    }

    private static void TryMakePerMonitorDpiAware()
    {
        try
        {
            if (Native.SetProcessDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return;
            // Older builds: 2 is PROCESS_PER_MONITOR_DPI_AWARE.
            Native.SetProcessDpiAwareness(2);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            // Windows 8.1 and earlier have neither export; the manifest still
            // applies, and a non-aware process is a degraded result rather than
            // a broken engine.
        }
    }

    private const string HelpText = """
        cua-engine — computer-use engine for the DeepSeek Harness CUA plugin.

        Usage:
          cua-engine                 Serve newline-delimited JSON requests on stdio.
          cua-engine --mcp           Serve the Model Context Protocol on stdio.
          cua-engine --probe         Print one engine.status response and exit.
          cua-engine --version       Print version and platform, then exit.
          cua-engine --call M        Send one request for method M and exit.
          cua-engine --params JSON   Parameters for --call.
          cua-engine --allow-script  Permit `app` action=script (PowerShell) on Windows.
          cua-engine --help          Print this message.

        Protocol: one JSON object per line in, one JSON object per line out.
          {"id":1,"method":"engine.status","params":{}}
        Each response carries either "result" or "error".

        --mcp speaks the same operations in the Model Context Protocol's
        vocabulary instead: initialize, tools/list, and tools/call.

        Platform: this build targets Windows. The backends are selected at
        startup and reported by `engine.status` as `backend`.
        """;
}

/// <summary>
/// Placeholder backend for a platform without an implementation yet. It answers
/// <c>engine.status</c> honestly so the plugin reports an unsupported host
/// instead of hanging on a missing capability.
/// </summary>
public sealed class UnsupportedHost : IPlatformHost
{
    public string BackendName => "unsupported";

    public JsonObject PermissionStatus() => new()
    {
        ["platformSupported"] = false,
        ["platform"] = PlatformInfo.Name,
        ["platformVersion"] = PlatformInfo.Version,
        ["accessibility"] = false,
        ["screenRecording"] = false,
        ["ready"] = false,
        ["sessionLocked"] = false,
        ["missing"] = new JsonArray(),
        ["hint"] = $"there is no Computer Use backend for {PlatformInfo.Name}; only macOS and Windows have one",
        ["executablePath"] = Environment.ProcessPath ?? string.Empty,
        ["processId"] = Environment.ProcessId,
    };

    private static CuaException Missing(string what) =>
        CuaException.Unsupported($"no {what} backend for {PlatformInfo.Name}");

    public JsonObject RequestPermissions() => PermissionStatus();
    public JsonObject ListApps(Params parameters) => throw Missing("application");
    public JsonObject ListWindows(Params parameters) => throw Missing("window");
    public JsonObject ListDisplays(Params parameters) => throw Missing("display");
    public JsonObject ReadTree(Params parameters) => throw Missing("accessibility");
    public JsonObject Screenshot(Params parameters) => throw Missing("screen-capture");
    public JsonObject Pointer(Params parameters) => throw Missing("pointer");
    public JsonObject Keyboard(Params parameters) => throw Missing("keyboard");
    public JsonObject ElementAction(Params parameters) => throw Missing("element");
    public JsonObject App(Params parameters) => throw Missing("application");
}
