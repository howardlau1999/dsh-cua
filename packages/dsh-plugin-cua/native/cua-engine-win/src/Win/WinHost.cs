using System.Text.Json.Nodes;

namespace CuaEngine.Win;

/// <summary>Configuration the plugin hands the Windows backend at startup.</summary>
public sealed class WinHostOptions
{
    /// <summary>
    /// Whether <c>app</c> action=script may run a PowerShell snippet.
    /// </summary>
    /// <remarks>
    /// Off unless the plugin passes <c>--allow-script</c>. macOS reaches "let
    /// the application do the work itself" through Apple events, which are
    /// scoped to a named target application by the automation permission. The
    /// Windows equivalent is a shell script, which is not scoped to anything at
    /// all, so it is opt-in rather than on by default.
    /// </remarks>
    public bool AllowScript { get; init; }
}

/// <summary>
/// The Windows backend: permissions, applications, windows, displays, UI
/// Automation trees, screen capture, synthesized input, and element actions.
/// </summary>
/// <remarks>
/// The backend is split across partial-class files by capability, mirroring the
/// Swift engine's <c>MacHost</c> split, so each file stays readable and the
/// protocol surface is visible in one place.
/// </remarks>
public sealed partial class WinHost(WinHostOptions options) : IPlatformHost
{
    /// <summary>Reported by <c>engine.status</c>; names the technology, not the OS.</summary>
    public string BackendName => "windows-uia";

    /// <summary>Whether <c>app</c> action=script is permitted on this process.</summary>
    private bool AllowScript => options.AllowScript;

    // MARK: - Permissions

    /// <summary>
    /// The permission report.
    /// </summary>
    /// <remarks>
    /// Windows has no per-process grant for either capability, and saying so is
    /// more useful than inventing one: the plugin's whole permission story is
    /// keyed on these booleans, and on Windows the honest answer is that both
    /// are available. What can genuinely block work is elevation — an
    /// unelevated engine cannot send input to or read a window owned by an
    /// elevated process — so that is reported as its own field and folded into
    /// the hint rather than being disguised as a missing permission.
    /// </remarks>
    public JsonObject PermissionStatus()
    {
        var locked = Native.IsSessionLocked();
        var elevated = Native.IsElevated();
        var missing = new JsonArray();
        if (locked) missing.Add("session");

        return new JsonObject
        {
            ["platform"] = PlatformInfo.Name,
            ["platformVersion"] = PlatformInfo.Version,
            ["accessibility"] = !locked,
            ["screenRecording"] = !locked,
            ["ready"] = !locked,
            ["sessionLocked"] = locked,
            ["missing"] = missing,
            ["hint"] = Hint(locked, elevated),
            ["executablePath"] = Environment.ProcessPath ?? string.Empty,
            ["processId"] = Environment.ProcessId,
            // Windows-specific fields. The plugin ignores what it does not know,
            // so these are additive to the shared contract rather than a fork of it.
            ["backendDetail"] = "UI Automation (Control view) + SendInput + GDI screen capture",
            ["elevated"] = elevated,
            ["elevationAvailable"] = elevated,
            ["sessionId"] = Environment.UserInteractive ? "interactive" : "non-interactive",
        };
    }

    private static string Hint(bool locked, bool elevated)
    {
        if (locked)
        {
            return "The workstation is locked. Captures would show the lock screen and synthesized input "
                + "would go nowhere; unlock the session (or use a machine that stays signed in) and retry. "
                + "Nothing has to be granted: Windows does not gate UI Automation or screen capture per process.";
        }
        if (elevated)
        {
            return "Windows does not gate UI Automation, screen capture, or synthesized input behind a "
                + "permission, and this engine is running elevated, so every window including other "
                + "elevated ones is reachable. Nothing has to be granted.";
        }
        return "Windows does not gate UI Automation, screen capture, or synthesized input behind a "
            + "permission, so every tool is available. The one limitation is elevation: this engine runs "
            + "with a standard token, so Windows will refuse to send input to a window owned by an "
            + "elevated process (UIPI). Run the harness elevated if that becomes necessary — `cua_status` "
            + "reports `elevated: false` here.";
    }

    /// <summary>
    /// Nothing to request.
    /// </summary>
    /// <remarks>
    /// The macOS engine pops the Accessibility and Screen Recording prompts
    /// here. Windows has no equivalent — there is no prompt that would grant
    /// anything — so the honest answer is the current status plus an explanation
    /// rather than a silent no-op the caller might read as success.
    /// </remarks>
    public JsonObject RequestPermissions()
    {
        var status = PermissionStatus();
        status["requested"] = false;
        status["requestNote"] =
            "Windows grants UI Automation and screen capture to every process; there is no permission "
            + "dialog to raise. If a specific window cannot be reached, the cause is elevation, not a "
            + "missing grant: this engine reports elevated=" + Native.IsElevated().ToString().ToLowerInvariant() + ".";
        return status;
    }

    // MARK: - Displays

    /// <summary>
    /// The display layout in physical pixels.
    /// </summary>
    /// <remarks>
    /// Any parameters are ignored, matching the macOS backend: the method takes
    /// no input, and clients call it with an empty object.
    /// </remarks>
    public JsonObject ListDisplays(Params parameters)
    {
        _ = parameters;
        var displays = Discovery.Displays();
        var desktop = Discovery.Desktop();
        var payload = new JsonArray();
        foreach (var display in displays)
        {
            payload.Add(new JsonObject
            {
                ["displayId"] = display.DisplayId,
                ["frame"] = Discovery.Frame(display.Bounds),
                ["workArea"] = Discovery.Frame(display.Work),
                // Informational, exactly as on macOS: the trustworthy density is
                // the `scale` a capture reports, measured from the image itself.
                ["reportedPixelWidth"] = (int)Math.Round(display.Bounds.Width * display.Density),
                ["reportedPixelHeight"] = (int)Math.Round(display.Bounds.Height * display.Density),
                ["reportedDensity"] = display.Density,
                ["main"] = display.IsMain,
            });
        }

        return new JsonObject
        {
            ["count"] = displays.Count,
            ["desktop"] = Discovery.Frame(desktop),
            ["coordinateSpace"] = "top-left origin, physical pixels; secondary displays may have negative x or y",
            ["dpiNote"] =
                "This engine is per-monitor DPI aware, so every coordinate it reports and accepts is a "
                + "physical pixel: UI Automation rectangles, SendInput positions, window frames, and "
                + "capture regions are all the same space and need no conversion. reportedDensity is the "
                + "display's DPI divided by 96 and is informational only; the authoritative figure for a "
                + "capture is the `scale` that capture returns.",
            ["displays"] = payload,
        };
    }

    // MARK: - Applications

    /// <summary>Running applications by default, installed ones on request.</summary>
    public JsonObject ListApps(Params parameters)
    {
        parameters.RejectUnknown("query", "running", "includeBackground");
        var query = parameters.String("query");
        var running = parameters.Bool("running", true);
        var includeBackground = parameters.Bool("includeBackground", false);

        var apps = running ? Discovery.RunningApplications() : Discovery.InstalledApps();
        var matched = apps
            .Where(app => includeBackground || running is false || !app.Hidden || app.Active)
            .Where(app => Matches(app, query))
            .Select(app => (JsonNode)new JsonObject
            {
                ["name"] = app.Name,
                ["bundleId"] = app.AppId,
                ["pid"] = (int)app.ProcessId,
                ["active"] = app.Active,
                ["hidden"] = app.Hidden,
                ["policy"] = app.Policy,
                ["path"] = app.Path,
            })
            .ToArray();

        return new JsonObject
        {
            ["count"] = matched.Length,
            ["apps"] = Json.Arr(matched),
            ["note"] = running
                ? "One row per application, not per process: several processes that share an executable "
                    + "image — a browser's tab processes, an Electron renderer, a helper — are reported as "
                    + "the one application they are, and the row carries the pid that owns its window. "
                    + "`bundleId` is the Windows analogue of a macOS bundle id: the Application User Model ID "
                    + "for a packaged or AppUserModel-registered app, and the executable path for a classic "
                    + "Win32 binary. Either form is a valid target for cua_app launch and for the `app` "
                    + "parameter of the other tools."
                : "Installed applications come from the uninstall registry keys; packaged Store apps are "
                    + "not listed there. Run cua_apps with running=true to see those once they are open.",
        };
    }

    private static bool Matches(AppRecord app, string? query)
    {
        if (query is not { Length: > 0 }) return true;
        return app.Name.Contains(query, StringComparison.OrdinalIgnoreCase)
            || app.AppId.Contains(query, StringComparison.OrdinalIgnoreCase)
            || app.Path.Contains(query, StringComparison.OrdinalIgnoreCase);
    }

    // MARK: - Windows

    /// <summary>Top-level windows, filtered by the usual targets.</summary>
    public JsonObject ListWindows(Params parameters)
    {
        parameters.RejectUnknown("app", "pid", "frontmost", "includeUntitled", "windowTitle");
        var appQuery = parameters.String("app");
        var pid = parameters.Int("pid");
        var frontmost = parameters.Bool("frontmost", false);
        var includeUntitled = parameters.Bool("includeUntitled", true);
        var titleQuery = parameters.String("windowTitle");

        var foreground = Native.GetForegroundWindow();
        var foregroundPid = foreground == IntPtr.Zero
            ? 0u
            : (Native.GetWindowThreadProcessId(foreground, out uint owner) == 0 ? 0u : owner);

        var rows = new JsonArray();
        var count = 0;
        foreach (var window in Discovery.Windows(includeUntitled))
        {
            if (pid is not null && window.ProcessId != (uint)pid.Value) continue;
            if (frontmost && window.ProcessId != foregroundPid) continue;
            if (titleQuery is { Length: > 0 }
                && !window.Title.Contains(titleQuery, StringComparison.OrdinalIgnoreCase)) continue;
            if (appQuery is { Length: > 0 })
            {
                var path = Discovery.ProcessImagePath(window.ProcessId);
                var name = Discovery.ProcessName(window.ProcessId, path);
                var appId = Discovery.AppIdFor(window.ProcessId, path);
                var hit = name.Contains(appQuery, StringComparison.OrdinalIgnoreCase)
                    || appId.Contains(appQuery, StringComparison.OrdinalIgnoreCase)
                    || path.Contains(appQuery, StringComparison.OrdinalIgnoreCase)
                    || window.Title.Contains(appQuery, StringComparison.OrdinalIgnoreCase);
                if (!hit) continue;
            }

            count++;
            rows.Add(new JsonObject
            {
                ["title"] = window.Title,
                ["app"] = Discovery.ProcessName(window.ProcessId, Discovery.ProcessImagePath(window.ProcessId)),
                ["pid"] = (int)window.ProcessId,
                ["windowId"] = window.Handle.ToInt64(),
                ["frame"] = Discovery.Frame(window.Bounds),
                ["main"] = window.IsMain,
                ["focused"] = window.IsFocused,
                ["minimized"] = window.IsMinimized,
                ["className"] = window.ClassName,
                ["visible"] = window.IsVisible,
            });
        }

        var result = new JsonObject
        {
            ["count"] = count,
            ["windows"] = rows,
        };
        if (pid is not null && count == 0)
        {
            result["note"] = Discovery.RunningApps().Any(app => app.ProcessId == (uint)pid.Value)
                ? $"pid {pid} is running but owns no top-level window matching the filter; "
                    + "drop windowTitle/includeUntitled or read its tree by pid."
                : $"no process with pid {pid} is running; call cua_apps to refresh the list.";
        }
        return result;
    }
}
