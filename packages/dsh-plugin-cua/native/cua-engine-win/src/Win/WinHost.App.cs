using System.IO;
using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Windows.Automation;

namespace CuaEngine.Win;

/// <summary>
/// Application-level actions: lifecycle, direct GUI messaging, and menu
/// invocation.
/// </summary>
/// <remarks>
/// This is the "drive the app, not the mouse" surface. Activating, hiding,
/// quitting, opening a URL, and revealing a path are ordinary shell calls the
/// engine makes itself, so they work without moving the pointer — on Windows as
/// much as on macOS. The one action that does not port is <c>script</c>: macOS
/// reaches it through Apple events, which the automation permission scopes to a
/// named target application, and the Windows equivalent is a shell script with
/// no such scope. It is therefore opt-in (<c>--allow-script</c>) rather than on
/// by default.
/// </remarks>
public sealed partial class WinHost
{
    private static readonly string[] AppActions =
    [
        "list", "activate", "focus", "hide", "unhide", "quit",
        "launch", "openURL", "openUrl", "reveal", "script", "menu",
    ];

    /// <summary>Application lifecycle and direct GUI messaging.</summary>
    public JsonObject App(Params parameters)
    {
        parameters.RejectUnknown(
            "action", "pid", "app", "bundleId", "windowTitle", "force", "path", "url", "script",
            "timeoutSeconds", "includeBackground", "query", "running");

        var action = parameters.Enum("action", AppActions) ?? "list";
        return action switch
        {
            "list" => ListApps(AppListParams(parameters)),
            "activate" or "focus" => Activate(parameters),
            "hide" => SetVisibility(parameters, hide: true),
            "unhide" => SetVisibility(parameters, hide: false),
            "quit" => Quit(parameters),
            "launch" => Launch(parameters),
            "openURL" or "openUrl" => OpenUrl(parameters),
            "reveal" => Reveal(parameters),
            "script" => Script(parameters),
            "menu" => AppMenu(parameters),
            _ => throw CuaException.Invalid(
                $"unknown app action \"{action}\"; expected one of {string.Join(", ", AppActions)}"),
        };
    }

    private static Params AppListParams(Params source)
    {
        var filtered = new System.Text.Json.Nodes.JsonObject();
        if (source.String("query") is { } query) filtered["query"] = query;
        if (source.Bool("running") is { } running) filtered["running"] = running;
        if (source.Bool("includeBackground") is { } background) filtered["includeBackground"] = background;
        return new Params(filtered, "app.list");
    }

    // MARK: - Target resolution

    private sealed record AppTarget(uint ProcessId, string Name, WindowRecord? Window);

    /// <summary>Resolve the application an action applies to.</summary>
    /// <remarks>
    /// The order mirrors the macOS resolver: an explicit pid, then a name or id
    /// query, then whatever is frontmost. An unknown pid continues to the next
    /// candidate rather than failing outright, which is what makes a caller that
    /// passes a stale pid alongside a valid name still work.
    /// </remarks>
    private static AppTarget ResolveApp(Params parameters, bool requireWindow)
    {
        var pid = parameters.Int("pid");
        var query = parameters.String("app");
        var bundleId = parameters.String("bundleId");
        var titleQuery = parameters.String("windowTitle");
        var running = Discovery.RunningApps();

        AppRecord? match = null;
        // `pid` is the unambiguous selector and is tried first, so a caller that
        // wants a specific instance always has a way to say so.
        if (pid is not null) match = running.FirstOrDefault(app => app.ProcessId == (uint)pid.Value);
        if (match is null && query is { Length: > 0 })
        {
            var matches = running.Where(app =>
                app.Name.Contains(query, StringComparison.OrdinalIgnoreCase)
                || app.AppId.Contains(query, StringComparison.OrdinalIgnoreCase)
                || app.Path.Contains(query, StringComparison.OrdinalIgnoreCase)).ToList();
            if (matches.Count == 0) throw CuaException.NotFound($"no running application matches \"{query}\"");
            match = OneInstance(matches, $"\"{query}\"");
        }
        if (match is null && bundleId is { Length: > 0 })
        {
            var matches = running
                .Where(app => app.AppId.Equals(bundleId, StringComparison.OrdinalIgnoreCase))
                .ToList();
            match = matches.Count == 0 ? null : OneInstance(matches, $"\"{bundleId}\"");
        }
        if (match is null)
        {
            var foreground = Native.GetForegroundWindow();
            if (foreground == IntPtr.Zero) throw CuaException.NotFound("no frontmost application");
            Native.GetWindowThreadProcessId(foreground, out uint foregroundPid);
            match = running.FirstOrDefault(app => app.ProcessId == foregroundPid)
                ?? new AppRecord(
                    Discovery.ProcessName(foregroundPid, Discovery.ProcessImagePath(foregroundPid)),
                    Discovery.AppIdFor(foregroundPid, Discovery.ProcessImagePath(foregroundPid)),
                    foregroundPid, true, false, "regular", Discovery.ProcessImagePath(foregroundPid));
        }

        var window = Discovery.FindWindow(match.ProcessId, titleQuery, requireVisible: false);
        if (window is null && titleQuery is { Length: > 0 })
        {
            throw CuaException.NotFound($"no window of {match.Name} matches \"{titleQuery}\"");
        }
        if (window is null && requireWindow)
        {
            throw CuaException.NotFound($"{match.Name} (pid {match.ProcessId}) has no top-level window");
        }
        return new AppTarget(match.ProcessId, match.Name, window);
    }

    /// <summary>
    /// The single running instance a fuzzy query refers to, or a refusal.
    /// </summary>
    /// <remarks>
    /// A name or id query is a substring match against every running application,
    /// and a machine can have two independent instances of one program — two
    /// Notepads, two editors, two terminals. Taking the first match means acting
    /// on whichever happens to have the lower pid, which is not a decision the
    /// caller made and not one they can see. Every caller of this resolver
    /// changes state, and the sharpest of them — `quit` — is not recoverable, so
    /// a coin flip is not an acceptable answer.
    ///
    /// Note what is *not* ambiguous: a single instance of a multi-process
    /// application. Notepad contributes two processes and a browser dozens, so
    /// the question is asked of instances, not of processes.
    ///
    /// The escape hatch costs the caller one call: the refusal names every
    /// candidate, and `pid` is tried before any query.
    /// </remarks>
    private static AppRecord OneInstance(List<AppRecord> matches, string describedQuery)
    {
        var instances = Discovery.ApplicationInstances([.. matches.Select(app => app.ProcessId)]);
        if (instances.Count <= 1) return matches[0];

        var described = string.Join(", ", instances.Select(pid =>
        {
            var title = Discovery.FindWindow(pid, null, requireVisible: false)?.Title;
            return title is { Length: > 0 } ? $"pid {pid} (\"{title}\")" : $"pid {pid}";
        }));
        throw CuaException.Invalid(
            $"{describedQuery} matches {instances.Count} running applications: {described}. "
            + "This action changes state, so choosing between them is not something to guess at; the call "
            + "was refused instead. Repeat it with `pid` to name the one you meant.");
    }

    // MARK: - Actions

    private JsonObject Activate(Params parameters)
    {
        var target = ResolveApp(parameters, requireWindow: true);
        var window = target.Window!;
        if (window.IsMinimized)
        {
            Native.ShowWindowAsync(window.Handle, Native.SW_RESTORE);
            Thread.Sleep(80);
        }

        // Windows only lets the foreground process hand foreground away, so a
        // background engine has to attach to the current foreground thread's
        // input queue for the duration of the call.
        var foreground = Native.GetForegroundWindow();
        var foregroundThread = foreground == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(foreground, IntPtr.Zero);
        var targetThread = Native.GetWindowThreadProcessId(window.Handle, IntPtr.Zero);
        var attached = false;
        try
        {
            if (foregroundThread != 0 && targetThread != 0 && foregroundThread != targetThread)
            {
                attached = Native.AttachThreadInput(foregroundThread, targetThread, true);
            }
            Native.BringWindowToTop(window.Handle);
            Native.SetForegroundWindow(window.Handle);
            Native.SetActiveWindow(window.Handle);
        }
        finally
        {
            if (attached) Native.AttachThreadInput(foregroundThread, targetThread, false);
        }

        Thread.Sleep(60);
        var activated = Native.GetForegroundWindow() == window.Handle;
        return new JsonObject
        {
            ["activated"] = activated,
            ["raised"] = true,
            ["name"] = target.Name,
            ["pid"] = (int)target.ProcessId,
            ["reason"] = activated
                ? null
                : "the window was raised but another process holds the foreground; Windows refuses "
                    + "foreground changes from a process the user is not interacting with, so click the "
                    + "window once or bring it forward yourself",
        };
    }

    /// <summary>
    /// Every process that is the same running instance as the resolved target.
    /// </summary>
    /// <remarks>
    /// A Windows application is frequently several processes: Notepad ships a
    /// helper, a browser ships one per tab plus a broker, an Electron app ships a
    /// renderer per window. Acting on only the process that happened to own the
    /// matched window leaves the rest running.
    ///
    /// The scope is one *instance* — the named process plus the processes linked
    /// to it by parent/child that share its executable — and not every process
    /// running the same file. The wider rule matched a second, independently
    /// launched copy too, which is how an administrator-elevated Notepad the user
    /// had opened was terminated by a smoke test that only meant to close its
    /// own. See <see cref="Discovery.ApplicationFamily"/>.
    /// </remarks>
    private static List<uint> AppProcessIds(AppTarget target)
    {
        var resolved = Discovery.RunningApps().FirstOrDefault(app => app.ProcessId == target.ProcessId);
        var image = resolved?.Path ?? Discovery.ProcessImagePath(target.ProcessId);
        if (image.Length == 0) return [target.ProcessId];

        var family = Discovery.ApplicationFamily(target.ProcessId, image);
        return family.Count == 0 ? [target.ProcessId] : family;
    }

    /// <summary>
    /// Refuse a lifecycle action that would reach a higher integrity level.
    /// </summary>
    /// <remarks>
    /// The engine already refuses to *send input* across the integrity boundary.
    /// Terminating across it is the same act with the opposite polarity, and it
    /// is worse: UIPI restricts window messages and injected input but places no
    /// restriction on process access at all, so while a keystroke aimed at an
    /// elevated window is discarded, <c>TerminateProcess</c> against one
    /// **succeeds** — a process owned by the same user passes its own DACL
    /// whatever its integrity level. Measured on the development machine:
    /// `OpenProcess(PROCESS_TERMINATE)` was granted against every elevated
    /// process on the box.
    ///
    /// A caller asking to quit an application is asking about something it can
    /// see; silently escalating to end a process the user deliberately elevated
    /// is not a service, it is a privilege escalation on the model's behalf.
    /// Fail closed instead.
    /// </remarks>
    private static string? ElevatedTargetReason(List<uint> pids, string name)
    {
        if (Native.IsElevated()) return null;
        var elevated = pids.FirstOrDefault(Discovery.IsProcessElevated);
        if (elevated == 0) return null;
        return $"{name} (pid {elevated}) is running with administrator rights and this engine is not. "
            + "Windows allows terminating such a process but not sending it input, so acting on it would be "
            + "a privilege escalation performed on the caller's behalf — and quitting the wrong application "
            + "is not recoverable. Run the harness with administrator rights if this is intended.";
    }

    private JsonObject SetVisibility(Params parameters, bool hide)
    {
        var target = ResolveApp(parameters, requireWindow: true);
        var pids = AppProcessIds(target);
        if (ElevatedTargetReason(pids, target.Name) is { } elevated)
        {
            return new JsonObject
            {
                [hide ? "hidden" : "unhidden"] = false,
                ["name"] = target.Name,
                ["pid"] = (int)target.ProcessId,
                ["reason"] = elevated,
            };
        }
        var windows = Discovery.AppWindows()
            .Where(window => pids.Contains(window.ProcessId))
            .ToArray();
        if (windows.Length == 0) windows = [target.Window!];

        var changed = 0;
        foreach (var window in windows)
        {
            var ok = hide
                ? Native.ShowWindowAsync(window.Handle, Native.SW_HIDE)
                : Native.ShowWindowAsync(window.Handle, Native.SW_SHOW);
            if (hide && ok) changed++;
            if (hide || !ok) continue;
            // Showing a minimized window leaves it minimized, which is not what
            // "unhide" means to a caller looking for a window they can read.
            Native.ShowWindowAsync(window.Handle, Native.SW_RESTORE);
            changed++;
        }

        return new JsonObject
        {
            [hide ? "hidden" : "unhidden"] = changed > 0,
            ["name"] = target.Name,
            ["pid"] = (int)target.ProcessId,
            ["windows"] = changed,
            ["reason"] = changed > 0 ? null : "the window refused the visibility change",
        };
    }

    private JsonObject Quit(Params parameters)
    {
        var force = parameters.Bool("force", false);
        var target = ResolveApp(parameters, requireWindow: false);
        var pids = AppProcessIds(target);

        if (ElevatedTargetReason(pids, target.Name) is { } elevated)
        {
            return new JsonObject
            {
                ["terminated"] = false,
                ["forced"] = force,
                ["name"] = target.Name,
                ["pid"] = (int)target.ProcessId,
                ["reason"] = elevated,
            };
        }

        if (force)
        {
            var killed = 0;
            string? failure = null;
            foreach (var pid in pids)
            {
                try
                {
                    using var process = Process.GetProcessById((int)pid);
                    process.Kill();
                    killed++;
                }
                catch (Exception error) when (error is ArgumentException or InvalidOperationException
                    or System.ComponentModel.Win32Exception or NotSupportedException)
                {
                    // Already gone, or protected; the other members still count.
                    failure ??= error.Message;
                }
            }
            return new JsonObject
            {
                ["terminated"] = killed > 0,
                ["forced"] = true,
                ["name"] = target.Name,
                ["pid"] = (int)target.ProcessId,
                ["processes"] = killed,
                ["reason"] = killed > 0 ? null : $"no process could be killed: {failure}",
            };
        }

        // A graceful quit is the window close the user would perform, so the
        // application gets to prompt about unsaved work.
        var windows = Discovery.AppWindows()
            .Where(window => pids.Contains(window.ProcessId))
            .ToArray();
        if (windows.Length == 0)
        {
            return new JsonObject
            {
                ["terminated"] = false,
                ["forced"] = false,
                ["name"] = target.Name,
                ["pid"] = (int)target.ProcessId,
                ["reason"] = "the application owns no window to close; use force to kill it",
            };
        }
        foreach (var window in windows)
        {
            Native.PostMessageW(window.Handle, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }

        return new JsonObject
        {
            ["terminated"] = true,
            ["forced"] = false,
            ["name"] = target.Name,
            ["pid"] = (int)target.ProcessId,
            ["windows"] = windows.Length,
        };
    }

    private JsonObject Launch(Params parameters)
    {
        var bundleId = parameters.String("bundleId");
        if (string.IsNullOrEmpty(bundleId))
        {
            throw CuaException.Invalid("app: missing required parameter \"bundleId\" (the app id or path from cua_apps)");
        }

        var before = Discovery.RunningApps().Select(app => app.ProcessId).ToHashSet();
        var installed = Discovery.InstalledApps();
        var known = installed.FirstOrDefault(app =>
            app.Name.Equals(bundleId, StringComparison.OrdinalIgnoreCase)
            || app.AppId.Equals(bundleId, StringComparison.OrdinalIgnoreCase)
            || app.Name.Contains(bundleId, StringComparison.OrdinalIgnoreCase));

        // Four shapes reach here, and each needs a different shell target: a
        // path that exists (a shortcut or a binary), a packaged app's
        // Application User Model ID, a bare executable name that only PATH
        // knows, or a name to look up in the installed index.
        string file;
        if (File.Exists(bundleId)) file = bundleId;
        else if (bundleId.StartsWith("shell:", StringComparison.OrdinalIgnoreCase)) file = bundleId;
        else if (known is not null && File.Exists(known.Path)) file = known.Path;
        else if (bundleId.Contains('!')) file = $"shell:AppsFolder\\{bundleId}";
        else if (IsBareExecutableName(bundleId)) file = bundleId;
        else file = $"shell:AppsFolder\\{bundleId}";

        var result = ShellExecute(file);
        if (result <= 32)
        {
            return new JsonObject
            {
                ["launched"] = false,
                ["name"] = known?.Name ?? bundleId,
                ["reason"] = $"Windows could not start \"{bundleId}\" (shell error {result}); "
                    + "call cua_apps to find a launchable path, or pass an Application User Model ID",
            };
        }

        // The shell returns as soon as it has handed the request on, so the
        // process is discovered by polling rather than reported by a callback.
        var expected = Path.GetFileNameWithoutExtension(file);
        uint? pid = null;
        var deadline = Environment.TickCount64 + 8000;
        while (Environment.TickCount64 < deadline)
        {
            Thread.Sleep(150);
            var candidate = Discovery.RunningApps().FirstOrDefault(app =>
                !before.Contains(app.ProcessId)
                && (app.AppId.Equals(bundleId, StringComparison.OrdinalIgnoreCase)
                    || app.Path.Equals(bundleId, StringComparison.OrdinalIgnoreCase)
                    || Path.GetFileNameWithoutExtension(app.Path).Equals(expected, StringComparison.OrdinalIgnoreCase)
                    || (known is not null && app.Name.Equals(known.Name, StringComparison.OrdinalIgnoreCase))));
            if (candidate is not null) { pid = candidate.ProcessId; break; }
        }

        return new JsonObject
        {
            ["launched"] = true,
            ["bundleId"] = bundleId,
            ["name"] = known?.Name ?? bundleId,
            ["pid"] = pid is null ? null : (int)pid.Value,
        };
    }

    /// <summary>
    /// Whether a name is a bare executable the shell can resolve through PATH.
    /// </summary>
    /// <remarks>
    /// <c>ShellExecute</c> searches PATH and the <c>App Paths</c> registry key
    /// for a name with no directory part, which is how <c>notepad.exe</c> and
    /// <c>explorer.exe</c> resolve without the engine knowing where they live.
    /// A name with a separator is a path, and a name with none and no extension
    /// is more likely an Application User Model ID.
    /// </remarks>
    private static bool IsBareExecutableName(string name) =>
        !name.Contains('\\') && !name.Contains('/')
        && name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);

    private JsonObject OpenUrl(Params parameters)
    {
        var url = parameters.String("url");
        if (string.IsNullOrEmpty(url))
        {
            throw CuaException.Invalid("app: missing required parameter \"url\" for openURL");
        }
        if (!url.Contains("://", StringComparison.Ordinal) && !url.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))
        {
            return new JsonObject { ["opened"] = false, ["url"] = url, ["reason"] = $"not a valid URL: {url}" };
        }

        var bundleId = parameters.String("bundleId");
        string file;
        string? arguments = null;
        string? echoed = null;
        if (bundleId is { Length: > 0 })
        {
            var app = Discovery.RunningApps().FirstOrDefault(entry =>
                    entry.AppId.Equals(bundleId, StringComparison.OrdinalIgnoreCase)
                    || entry.Name.Equals(bundleId, StringComparison.OrdinalIgnoreCase))
                ?? Discovery.InstalledApps().FirstOrDefault(entry =>
                    entry.AppId.Equals(bundleId, StringComparison.OrdinalIgnoreCase)
                    || entry.Name.Equals(bundleId, StringComparison.OrdinalIgnoreCase));
            if (app is not null && File.Exists(app.Path))
            {
                // Handing the URL to a named browser is a different request from
                // handing it to the default handler, so it is only echoed when it
                // actually happened.
                file = app.Path;
                arguments = url;
                echoed = bundleId;
            }
            else
            {
                file = url;
            }
        }
        else
        {
            file = url;
        }

        var result = ShellExecute(file, arguments);
        return new JsonObject
        {
            ["opened"] = result > 32,
            ["url"] = url,
            ["bundleId"] = echoed,
            ["reason"] = result > 32 ? null : $"Windows could not open the URL (shell error {result})",
        };
    }

    private JsonObject Reveal(Params parameters)
    {
        var path = parameters.String("path");
        if (string.IsNullOrEmpty(path))
        {
            throw CuaException.Invalid("app: missing required parameter \"path\" for reveal");
        }
        if (!File.Exists(path) && !Directory.Exists(path))
        {
            return new JsonObject { ["revealed"] = false, ["path"] = path, ["reason"] = $"no such path: {path}" };
        }

        // Explorer's /select switch is what opens the containing folder with the
        // item highlighted; running it on a folder opens that folder.
        //
        // explorer.exe sits *beside* System32, not in it, so `SystemDirectory`
        // asks for a file that does not exist — every reveal answered "shell error
        // 2" (ERROR_FILE_NOT_FOUND) while the path being revealed was perfectly
        // valid, which is a misleading way to fail.
        var explorer = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
        var result = Directory.Exists(path)
            ? ShellExecute(path, null)
            : ShellExecute(explorer, $"/select,\"{path}\"");
        return new JsonObject
        {
            ["revealed"] = result > 32,
            ["path"] = path,
            ["reason"] = result > 32 ? null : $"Explorer could not show the path (shell error {result})",
        };
    }

    /// <summary>
    /// Run a PowerShell snippet in the target application's context.
    /// </summary>
    /// <remarks>
    /// The Windows stand-in for an Apple event. It is opt-in because unlike
    /// Apple events it is not scoped to a named application: it can do anything
    /// the user can. With a resolved application the snippet runs with that
    /// application's directory as its working directory and its executable
    /// exposed as <c>$AppPath</c>, which is what makes COM automation of a
    /// running application expressible.
    /// </remarks>
    private JsonObject Script(Params parameters)
    {
        var source = parameters.String("script");
        if (string.IsNullOrEmpty(source))
        {
            throw CuaException.Invalid("app: missing required parameter \"script\" for script");
        }
        var timeoutSeconds = parameters.Int("timeoutSeconds") ?? 30;
        if (timeoutSeconds is < 1 or > 600)
        {
            throw CuaException.Invalid("\"timeoutSeconds\" must be between 1 and 600");
        }
        if (!AllowScript)
        {
            return new JsonObject
            {
                ["executed"] = false,
                ["reason"] = "app action=script is disabled on Windows by default. Unlike a macOS Apple "
                    + "event, which the system scopes to one target application, a Windows script is "
                    + "unrestricted, so it has to be enabled deliberately: add `allowedScript: true` to the "
                    + "plugin configuration (or pass --allow-script to the engine) and restart the harness.",
            };
        }

        var target = ResolveApp(parameters, requireWindow: false);
        // The snippet runs with the application's own directory as its working
        // directory, and the two facts worth having are pre-bound so a caller can
        // reach them without re-deriving the process: `$AppPath` for the
        // executable (which is what COM automation wants) and `$AppName` for the
        // display name. The comment here used to promise a path while the code
        // bound a name.
        var image = Discovery.ProcessImagePath(target.ProcessId);
        var script = $"$AppName = '{target.Name.Replace("'", "''", StringComparison.Ordinal)}'\n"
            + $"$AppPath = '{image.Replace("'", "''", StringComparison.Ordinal)}'\n"
            + source;

        var start = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-ExecutionPolicy");
        start.ArgumentList.Add("Bypass");
        start.ArgumentList.Add("-Command");
        start.ArgumentList.Add(script);
        var directory = Path.GetDirectoryName(image);
        if (!string.IsNullOrEmpty(directory) && Directory.Exists(directory)) start.WorkingDirectory = directory;

        using var process = Process.Start(start)
            ?? throw CuaException.Failed("PowerShell could not be started");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(timeoutSeconds * 1000))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                // Already gone.
            }
            return new JsonObject
            {
                ["executed"] = false,
                ["timeout"] = true,
                ["name"] = target.Name,
                ["reason"] = $"the script did not finish within {timeoutSeconds}s and was stopped",
            };
        }

        var output = stdout.GetAwaiter().GetResult().Trim();
        var errors = stderr.GetAwaiter().GetResult().Trim();
        return new JsonObject
        {
            ["executed"] = process.ExitCode == 0,
            ["timeout"] = false,
            ["name"] = target.Name,
            ["result"] = output.Length > 0 ? output : errors,
            ["reason"] = process.ExitCode == 0
                ? null
                : $"the script exited with code {process.ExitCode}: {(errors.Length > 0 ? errors : output)}",
        };
    }

    private JsonObject AppMenu(Params parameters)
    {
        var target = ResolveApp(parameters, requireWindow: true);
        var window = target.Window!;
        AutomationElement element;
        try
        {
            element = AutomationElement.FromHandle(window.Handle);
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            throw CuaException.Failed($"{target.Name}'s window could not be read: {error.Message}");
        }
        return InvokeMenu(element, target.ProcessId, ReadPath(parameters));
    }

    // MARK: - Shell

    /// <summary>
    /// Run a shell verb and report the raw result code.
    /// </summary>
    /// <remarks>
    /// <c>ShellExecute</c> reports failure as a value at or below 32 rather than
    /// through the last-error slot, which is why the code is returned instead of
    /// being folded into a boolean here.
    /// </remarks>
    private static long ShellExecute(string file, string? arguments = null)
    {
        try
        {
            var result = Native.ShellExecute(IntPtr.Zero, "open", file, arguments, null, Native.SW_SHOWNORMAL);
            return result.ToInt64();
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or DllNotFoundException)
        {
            Program.WriteDiagnostic($"ShellExecute(\"{file}\") failed: {error.Message}");
            return 0;
        }
    }
}
