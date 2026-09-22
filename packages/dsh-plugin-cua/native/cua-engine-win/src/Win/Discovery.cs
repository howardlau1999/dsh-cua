using System.IO;
using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace CuaEngine.Win;

/// <summary>One top-level window, as discovery found it.</summary>
internal sealed record WindowRecord(
    IntPtr Handle,
    uint ProcessId,
    string Title,
    string ClassName,
    Native.RECT Bounds,
    bool IsMain,
    bool IsFocused,
    bool IsMinimized,
    bool IsVisible);

/// <summary>One application, running or installed.</summary>
internal sealed record AppRecord(
    string Name,
    string AppId,
    uint ProcessId,
    bool Active,
    bool Hidden,
    string Policy,
    string Path);

/// <summary>One display, in physical pixels with the primary's top-left at the origin.</summary>
internal sealed record DisplayRecord(
    IntPtr Monitor,
    int DisplayId,
    Native.RECT Bounds,
    Native.RECT Work,
    bool IsMain,
    double Density);

/// <summary>
/// Windows, processes, and displays.
/// </summary>
/// <remarks>
/// Everything here reports <b>physical pixels in the virtual-screen space</b>:
/// the primary display's top-left corner is the origin, a display to its left or
/// above it has negative coordinates, and a display's extent is the union of all
/// of them. That is the same convention the macOS backend uses for screen
/// points, so the coordinate arithmetic the model performs is identical on both
/// platforms — and because this process is per-monitor DPI aware, "physical
/// pixel" is also what UI Automation, <c>SendInput</c>, and screen capture all
/// mean by a coordinate.
/// </remarks>
internal static class Discovery
{
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int APPMODEL_ERROR_NO_APPLICATION = 15700;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);

    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, [Out] char[] name, ref int size);

    [DllImport("kernel32.dll", EntryPoint = "GetApplicationUserModelId", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetApplicationUserModelId(IntPtr process, ref uint length, [Out] char[]? applicationUserModelId);

    // MARK: - Displays

    /// <summary>Every display, ordered left-to-right then top-to-bottom.</summary>
    public static List<DisplayRecord> Displays()
    {
        var found = new List<DisplayRecord>();
        Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr monitor, IntPtr _, ref Native.RECT _, IntPtr _) =>
        {
            var info = new Native.MONITORINFOEX { Size = Marshal.SizeOf<Native.MONITORINFOEX>(), Device = string.Empty };
            if (!Native.GetMonitorInfo(monitor, ref info)) return true;
            double density = 1.0;
            if (Native.GetDpiForMonitor(monitor, 0, out uint dpiX, out _) == 0 && dpiX > 0)
            {
                density = dpiX / 96.0;
            }
            found.Add(new DisplayRecord(
                monitor,
                DisplayIdFor(info.Device),
                info.Monitor,
                info.Work,
                (info.Flags & Native.MONITORINFOF_PRIMARY) != 0,
                density));
            return true;
        }, IntPtr.Zero);

        return [.. found.OrderBy(display => display.Bounds.Left).ThenBy(display => display.Bounds.Top)];
    }

    /// <summary>
    /// A display id that survives a restart.
    /// </summary>
    /// <remarks>
    /// An <c>HMONITOR</c> is a handle: it is what a capture needs internally, but
    /// it is not stable across sessions, so it must not leak into the protocol —
    /// a model that cached `displayId 65537` from an earlier turn would be
    /// pointing at nothing. The device name (<c>\\.\DISPLAY1</c>) is stable for a
    /// given port, so its ordinal is the id.
    /// </remarks>
    private static int DisplayIdFor(string device)
    {
        var digits = 0;
        var seen = false;
        foreach (var character in device)
        {
            if (char.IsAsciiDigit(character))
            {
                digits = digits * 10 + (character - '0');
                seen = true;
            }
            else if (seen)
            {
                break;
            }
        }
        return seen ? digits : device.GetHashCode(StringComparison.Ordinal) & 0x7FFFFFFF;
    }

    /// <summary>The union of every display, as [x, y, width, height].</summary>
    public static Native.RECT Desktop()
    {
        var x = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
        var y = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
        var width = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
        var height = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
        if (width <= 0 || height <= 0)
        {
            // Only reachable without an interactive session; fall back to the
            // monitor list rather than reporting an empty desktop.
            var displays = Displays();
            if (displays.Count == 0) return default;
            x = displays.Min(display => display.Bounds.Left);
            y = displays.Min(display => display.Bounds.Top);
            width = displays.Max(display => display.Bounds.Right) - x;
            height = displays.Max(display => display.Bounds.Bottom) - y;
        }
        return new Native.RECT { Left = x, Top = y, Right = x + width, Bottom = y + height };
    }

    /// <summary>The display a point falls on, or null when it falls on none.</summary>
    public static DisplayRecord? DisplayAt(int x, int y)
    {
        var monitor = Native.MonitorFromPoint(new Native.POINT { X = x, Y = y }, Native.MONITOR_DEFAULTTONULL);
        if (monitor == IntPtr.Zero) return null;
        return Displays().FirstOrDefault(display => display.Monitor == monitor);
    }

    /// <summary>
    /// Reject a point that is not on any display.
    /// </summary>
    /// <remarks>
    /// Windows would happily clamp an off-screen point to the nearest edge and
    /// deliver the event there, which turns one arithmetic mistake into a click
    /// on something the caller never named. Failing with the real desktop bounds
    /// keeps the error diagnosable.
    /// </remarks>
    public static DisplayRecord RequireDisplayAt(double x, double y)
    {
        var rounded = new Native.POINT { X = (int)Math.Round(x), Y = (int)Math.Round(y) };
        var monitor = Native.MonitorFromPoint(rounded, Native.MONITOR_DEFAULTTONULL);
        if (monitor != IntPtr.Zero)
        {
            var match = Displays().FirstOrDefault(display => display.Monitor == monitor);
            if (match is not null) return match;
        }
        var desktop = Desktop();
        throw CuaException.Invalid(
            $"the point ({rounded.X}, {rounded.Y}) is not on any display; "
            + $"the desktop spans x={desktop.Left}…{desktop.Right}, y={desktop.Top}…{desktop.Bottom}");
    }

    // MARK: - Windows

    /// <summary>Application windows, in Z-order from the top.</summary>
    /// <remarks>
    /// This is the Alt-Tab set: what a user would call a window. It is what
    /// <c>window.list</c> reports, because a list that also carried the taskbar,
    /// the desktop, every tray icon host, and 500 invisible message-only windows
    /// would be unreadable. Shell infrastructure stays reachable through
    /// <c>cua_tree</c> and <c>cua_screenshot</c>, which address a process rather
    /// than a window list.
    /// </remarks>
    public static List<WindowRecord> Windows(bool includeUntitled) =>
        Collect(IsAppWindow, includeUntitled);

    /// <summary>
    /// Every window belonging to an application, hidden ones included.
    /// </summary>
    /// <remarks>
    /// The set that answers "is this application running" and "where is its
    /// window". It is deliberately wider than the Alt-Tab set in one direction:
    /// a hidden window still belongs to a running application, and deriving the
    /// application list from visible windows alone makes <c>hide</c>
    /// irreversible — the application vanishes from <c>cua_apps</c> and can never
    /// be found again in order to be shown.
    ///
    /// The extra rows are all reported as <c>hidden</c>, so they stay out of the
    /// default <c>cua_apps</c> listing and appear only when a caller asks for
    /// background applications or names one directly.
    /// </remarks>
    public static List<WindowRecord> AppWindows() =>
        Collect(IsApplicationOwned, includeUntitled: true);

    private static List<WindowRecord> Collect(Func<IntPtr, bool> predicate, bool includeUntitled)
    {
        var handles = new List<IntPtr>();
        Native.EnumWindows((hwnd, _) =>
        {
            if (predicate(hwnd)) handles.Add(hwnd);
            return true;
        }, IntPtr.Zero);

        var foreground = Native.GetForegroundWindow();
        var records = new List<WindowRecord>(handles.Count);
        foreach (var hwnd in handles)
        {
            var title = Native.WindowTitle(hwnd);
            if (title.Length == 0 && !includeUntitled) continue;
            Native.GetWindowThreadProcessId(hwnd, out uint pid);
            records.Add(new WindowRecord(
                hwnd,
                pid,
                title,
                Native.ClassName(hwnd),
                Native.WindowBounds(hwnd),
                IsMain: false,
                IsFocused: hwnd == foreground,
                IsMinimized: Native.IsIconic(hwnd),
                IsVisible: Native.IsWindowVisible(hwnd)));
        }

        // A process's main window is the first one it owns, in Z-order, that
        // carries a title and has no owner — the same idea as AXMain on macOS,
        // derived from what the window manager already knows rather than from a
        // per-application convention. Visible windows get first refusal, so a
        // hidden helper that happens to sort earlier cannot become "the" window.
        var assigned = new HashSet<uint>();
        for (var pass = 0; pass < 2; pass++)
        {
            var wantVisible = pass == 0;
            for (var index = 0; index < records.Count; index++)
            {
                var record = records[index];
                if (record.IsVisible != wantVisible) continue;
                if (record.Title.Length == 0) continue;
                if (Native.GetWindow(record.Handle, Native.GW_OWNER) != IntPtr.Zero) continue;
                if (!assigned.Add(record.ProcessId)) continue;
                records[index] = record with { IsMain = true };
            }
        }
        return records;
    }

    /// <summary>
    /// Whether a window is one a user would call an application window.
    /// </summary>
    /// <remarks>
    /// The filter is deliberately inclusive — a model looking for something to
    /// read wants dialogs and palettes too — and only excludes what is provably
    /// not an application window: DWM-cloaked windows (a suspended UWP app still
    /// enumerates), tool windows, no-activate overlays such as a HUD or an
    /// on-screen keyboard, and child windows.
    /// </remarks>
    private static bool IsApplicationOwned(IntPtr hwnd) =>
        IsTopLevel(hwnd) && IsApplicationStyle(hwnd);

    /// <summary>The same, restricted to what is actually on screen.</summary>
    private static bool IsAppWindow(IntPtr hwnd) =>
        IsTopLevel(hwnd) && Native.IsWindowVisible(hwnd) && IsApplicationStyle(hwnd);

    private static bool IsApplicationStyle(IntPtr hwnd)
    {
        var style = Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE).ToInt64();
        if ((style & Native.WS_EX_TOOLWINDOW) != 0 && (style & Native.WS_EX_APPWINDOW) == 0) return false;
        // A no-activate overlay (an on-screen keyboard, a HUD) is not a target
        // for reading or clicking; only keep it if it explicitly asks to be one.
        if ((style & Native.WS_EX_NOACTIVATE) != 0 && (style & Native.WS_EX_APPWINDOW) == 0) return false;
        return true;
    }

    /// <summary>Whether a window is a real top-level window of any kind.</summary>
    private static bool IsTopLevel(IntPtr hwnd)
    {
        if (Native.GetAncestor(hwnd, Native.GA_ROOT) != hwnd) return false;
        if (Native.IsCloaked(hwnd)) return false;
        var bounds = Native.WindowBounds(hwnd);
        return bounds.Width > 0 && bounds.Height > 0;
    }

    /// <summary>One window by handle, or null when it is gone.</summary>
    public static WindowRecord? Window(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) return null;
        Native.GetWindowThreadProcessId(hwnd, out uint pid);
        return new WindowRecord(
            hwnd,
            pid,
            Native.WindowTitle(hwnd),
            Native.ClassName(hwnd),
            Native.WindowBounds(hwnd),
            Native.GetWindow(hwnd, Native.GW_OWNER) == IntPtr.Zero,
            hwnd == Native.GetForegroundWindow(),
            Native.IsIconic(hwnd),
            Native.IsWindowVisible(hwnd));
    }

    /// <summary>
    /// Pick one window of a process: a title match first, then the main window.
    /// </summary>
    /// <remarks>
    /// Searches the broad window set, so naming a process that owns only shell
    /// infrastructure — the desktop, the taskbar — still resolves to something.
    /// Among several candidates the main window wins, which is the one a user
    /// would name.
    /// </remarks>
    public static WindowRecord? FindWindow(uint pid, string? titleContains, bool requireVisible)
    {
        var candidates = AppWindows()
            .Where(window => window.ProcessId == pid)
            .Where(window => !requireVisible || window.IsVisible)
            .ToList();
        if (candidates.Count == 0) return null;

        if (titleContains is { Length: > 0 })
        {
            var match = candidates.FirstOrDefault(window =>
                window.Title.Contains(titleContains, StringComparison.OrdinalIgnoreCase));
            if (match is not null) return match;
        }
        return candidates.FirstOrDefault(window => window.IsMain) ?? candidates[0];
    }

    // MARK: - Processes

    /// <summary>Running applications: every process that owns a visible window.</summary>
    /// <remarks>
    /// The window set here is the broad one, not the Alt-Tab set: the shell owns
    /// only infrastructure windows, and leaving <c>explorer</c> out of
    /// <c>cua_apps</c> would make the desktop itself untargetable.
    ///
    /// One row per process. That is the right shape for callers addressing a
    /// specific process; <see cref="RunningApplications"/> is the right shape for
    /// listing applications.
    /// </remarks>
    public static List<AppRecord> RunningApps()
    {
        var windows = AppWindows();
        var foreground = Native.GetForegroundWindow();
        var apps = new List<AppRecord>();

        foreach (var group in windows.GroupBy(window => window.ProcessId).OrderBy(group => group.Key))
        {
            var pid = group.Key;
            var path = ProcessImagePath(pid);
            var hasVisible = group.Any(window => window.IsVisible);
            apps.Add(new AppRecord(
                ProcessName(pid, path),
                AppIdFor(pid, path),
                pid,
                group.Any(window => window.Handle == foreground),
                !hasVisible,
                hasVisible ? "regular" : "background",
                path));
        }
        return apps;
    }

    /// <summary>Running applications, one row per application rather than per process.</summary>
    /// <remarks>
    /// A Windows application is frequently several processes: a browser ships one
    /// per tab plus a broker, an Electron app a renderer per window, Notepad a
    /// helper with no window of its own. Listing each process separately makes
    /// <c>cua_apps</c> report "Windows Subsystem for Linux" four times and the
    /// same Slack twice — rows a model has to read past and cannot tell apart,
    /// because every one of them names the same thing.
    ///
    /// macOS de-duplicates by bundle id. The Windows equivalent of "the same
    /// application" is the executable image those processes share, which is also
    /// what <c>cua_app</c> uses to decide the scope of <c>hide</c> and
    /// <c>quit</c> — so the listing and the lifecycle actions agree about what
    /// one application is.
    ///
    /// The surviving row keeps a pid a caller can act on: the process that owns
    /// the foreground window when there is one, otherwise one that has a window
    /// on screen, and only failing both a windowless one.
    /// </remarks>
    public static List<AppRecord> RunningApplications()
    {
        var groups = new List<AppRecord>();
        var byImage = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var app in RunningApps())
        {
            // A process whose image cannot be read has no identity beyond itself,
            // so it stands alone rather than being merged with something it
            // merely resembles. Guessing the other way would fuse two unrelated
            // applications into one row.
            var key = app.Path.Length > 0 ? app.Path : $"pid:{app.ProcessId}";
            if (byImage.TryGetValue(key, out var index))
            {
                groups[index] = Merge(groups[index], app);
                continue;
            }
            byImage[key] = groups.Count;
            groups.Add(app);
        }

        // Frontmost first, then by name: the application the user is looking at
        // should be the first line a model reads.
        return [.. groups
            .OrderByDescending(app => app.Active)
            .ThenBy(app => app.Name, StringComparer.OrdinalIgnoreCase)];
    }

    /// <summary>Fold one more process of the same application into its row.</summary>
    private static AppRecord Merge(AppRecord kept, AppRecord extra)
    {
        var best = Rank(extra) < Rank(kept) ? extra : kept;
        var hidden = kept.Hidden && extra.Hidden;
        return new AppRecord(
            kept.Name.Length > 0 ? kept.Name : extra.Name,
            PreferAppId(kept.AppId, extra.AppId),
            best.ProcessId,
            kept.Active || extra.Active,
            hidden,
            hidden ? "background" : "regular",
            kept.Path.Length > 0 ? kept.Path : extra.Path);
    }

    /// <summary>Which of two processes is the better face for its application.</summary>
    private static int Rank(AppRecord app) => app.Active ? 0 : app.Hidden ? 2 : 1;

    /// <summary>Prefer an Application User Model ID over an executable path.</summary>
    /// <remarks>
    /// The same image can back processes registered under different application
    /// ids — Windows hosts several unrelated things in <c>RuntimeBroker.exe</c> —
    /// and any of them is a better answer than a path, because an id is what
    /// <c>launch</c> takes and what the user recognises.
    /// </remarks>
    private static string PreferAppId(string kept, string extra)
    {
        if (kept.Length == 0) return extra;
        if (extra.Length == 0) return kept;
        var keptIsPath = kept.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
        var extraIsPath = extra.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
        return keptIsPath && !extraIsPath ? extra : kept;
    }

    /// <summary>
    /// Installed applications, from the Start menu and the uninstall registry.
    /// </summary>
    /// <remarks>
    /// Two indexes, because neither is complete. The Start menu is what the user
    /// actually launches — and a shortcut is itself a perfectly good
    /// <c>ShellExecute</c> target, which is why <c>path</c> is the <c>.lnk</c>
    /// file rather than a target the engine had to resolve out of it. The
    /// uninstall keys add the applications that never put a shortcut there.
    /// A packaged (Store) app with neither is still launchable by its
    /// Application User Model ID, and appears in <c>cua_apps running=true</c>
    /// once it is open.
    /// </remarks>
    public static List<AppRecord> InstalledApps()
    {
        var roots = new (Microsoft.Win32.RegistryKey Root, string Path)[]
        {
            (Microsoft.Win32.Registry.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (Microsoft.Win32.Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (Microsoft.Win32.Registry.CurrentUser, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        };

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var apps = new List<AppRecord>();

        foreach (var shortcut in StartMenuShortcuts())
        {
            var shortcutName = Path.GetFileNameWithoutExtension(shortcut);
            if (shortcutName.Length == 0 || !seen.Add(shortcutName)) continue;
            apps.Add(new AppRecord(shortcutName, shortcut, 0, false, false, "regular", shortcut));
        }

        foreach (var (root, path) in roots)
        {
            using var key = root.OpenSubKey(path);
            if (key is null) continue;
            foreach (var name in key.GetSubKeyNames())
            {
                using var entry = key.OpenSubKey(name);
                if (entry is null) continue;
                if (entry.GetValue("DisplayName") is not string displayName || displayName.Length == 0) continue;
                // Updates and runtimes are not launchable applications.
                if (entry.GetValue("SystemComponent") is int system && system == 1) continue;
                if (entry.GetValue("ParentKeyName") is string) continue;
                if (!seen.Add(displayName)) continue;

                var icon = entry.GetValue("DisplayIcon") as string ?? string.Empty;
                var location = entry.GetValue("InstallLocation") as string ?? string.Empty;
                var executable = ExecutableFromIcon(icon) ?? location;
                apps.Add(new AppRecord(
                    displayName,
                    executable.Length > 0 ? executable : displayName,
                    0,
                    false,
                    false,
                    "regular",
                    executable));
            }
        }
        return [.. apps.OrderBy(app => app.Name, StringComparer.OrdinalIgnoreCase)];
    }

    /// <summary>Every shortcut in the per-machine and per-user Start menus.</summary>
    private static IEnumerable<string> StartMenuShortcuts()
    {
        var folders = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu), "Programs"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs"),
        };
        foreach (var folder in folders)
        {
            if (!Directory.Exists(folder)) continue;
            string[] found;
            try
            {
                found = Directory.GetFiles(folder, "*.lnk", SearchOption.AllDirectories);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            foreach (var shortcut in found) yield return shortcut;
        }
    }
    private static string? ExecutableFromIcon(string icon)
    {
        if (icon.Length == 0) return null;
        var path = icon.Trim('"');
        var comma = path.LastIndexOf(',');
        if (comma > 2 && int.TryParse(path[(comma + 1)..], out _)) path = path[..comma];
        return path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? path : null;
    }

    /// <summary>
    /// Every running process whose executable is this image.
    /// </summary>
    /// <remarks>
    /// Enumerated from the process list rather than from windows, because the
    /// process that has to end for an application to be gone is often the one
    /// with no window at all: Notepad's helper, a browser's broker, an Electron
    /// app's renderer.
    /// </remarks>
    public static List<uint> ProcessIdsWithImage(string imagePath)
    {
        var result = new List<uint>();
        if (imagePath.Length == 0) return result;
        foreach (var process in Process.GetProcesses())
        {
            var pid = (uint)process.Id;
            process.Dispose();
            if (ProcessImagePath(pid).Equals(imagePath, StringComparison.OrdinalIgnoreCase)) result.Add(pid);
        }
        return result;
    }

    /// <summary>
    /// The processes that make up one running instance of an application.
    /// </summary>
    /// <remarks>
    /// Deliberately narrower than <see cref="ProcessIdsWithImage"/>, and the
    /// difference matters: matching on the image alone also matches a *second*
    /// copy of the same program that the user launched independently, and acting
    /// on that is not a mistake the caller can see coming. It happened —
    /// `cua_app quit app=notepad` matched an administrator-elevated Notepad the
    /// user had opened, and terminating it succeeded, because UIPI restricts
    /// window messages and injected input but **not** process access. A process
    /// owned by the same user passes its own DACL whatever its integrity level.
    ///
    /// So the scope is one *instance*: the named process, plus the processes
    /// connected to it by parent/child links that share its executable. That is
    /// what an application's own helper processes look like — Notepad's is its
    /// parent, a browser's renderers are its children — while a second launch is
    /// a separate chain that happens to run the same file.
    /// </remarks>
    public static List<uint> ApplicationFamily(uint rootPid, string imagePath)
    {
        if (imagePath.Length == 0) return [rootPid];
        var graph = BuildInstanceGraph([imagePath]);
        return graph.Members.Contains(rootPid) ? [.. Instance(rootPid, graph)] : [rootPid];
    }

    /// <summary>
    /// One pid per distinct running instance among a set of processes.
    /// </summary>
    /// <remarks>
    /// The same connected-component notion as <see cref="ApplicationFamily"/>,
    /// used to answer a different question: not "which processes are this
    /// application" but "how many applications is this". It exists because the
    /// process list is one row per *process*, so a single Notepad contributes two
    /// of them and counting matches would report every multi-process application
    /// as ambiguous.
    ///
    /// Components are computed **per image**, and that is not a detail. Building
    /// one graph over every candidate's image lets a process of one program
    /// bridge two instances of another: launching two copies of a program from
    /// the same shell makes both of them children of that shell, so a shared
    /// parent joins them into a single component and the ambiguity disappears —
    /// measured, with a `quit app=powershell` that matched two form windows plus
    /// the shell itself and reported one instance. An instance cannot span two
    /// executables, so the grouping has to respect that.
    ///
    /// Each returned pid is one of the pids passed in, so a caller that matched on
    /// a query can look the record back up.
    /// </remarks>
    public static List<uint> ApplicationInstances(IReadOnlyCollection<uint> pids)
    {
        if (pids.Count == 0) return [];

        var byImage = new Dictionary<string, List<uint>>(StringComparer.OrdinalIgnoreCase);
        var instances = new List<uint>();
        foreach (var pid in pids)
        {
            var image = ProcessImagePath(pid);
            if (image.Length == 0)
            {
                // Nothing provable about it, so it stands alone rather than being
                // assumed to belong with the others.
                instances.Add(pid);
                continue;
            }
            if (!byImage.TryGetValue(image, out var group)) byImage[image] = group = [];
            group.Add(pid);
        }

        foreach (var (image, candidates) in byImage)
        {
            var graph = BuildInstanceGraph([image]);
            var accounted = new HashSet<uint>();
            foreach (var pid in candidates)
            {
                if (accounted.Contains(pid)) continue;
                accounted.UnionWith(Instance(pid, graph));
                instances.Add(pid);
            }
        }
        return instances;
    }

    /// <summary>Who shares one of these executable images, and who their parents are.</summary>
    private static InstanceGraph BuildInstanceGraph(IReadOnlyCollection<string> images)
    {
        var members = new HashSet<uint>();
        var parents = new Dictionary<uint, uint>();
        foreach (var process in Process.GetProcesses())
        {
            var pid = (uint)process.Id;
            process.Dispose();
            var image = ProcessImagePath(pid);
            if (image.Length == 0 || !images.Contains(image)) continue;
            members.Add(pid);
            parents[pid] = Native.ParentProcessId(pid);
        }
        return new InstanceGraph(members, parents);
    }

    /// <summary>
    /// Everything connected to one process by parent/child links, staying inside
    /// the image.
    /// </summary>
    /// <remarks>
    /// Both directions matter: a helper is as likely to be an ancestor as a
    /// descendant — Notepad's is its parent — so walking only down would miss it,
    /// and walking only up would miss a browser's renderers.
    /// </remarks>
    private static HashSet<uint> Instance(uint root, InstanceGraph graph)
    {
        var reached = new HashSet<uint> { root };
        var queue = new Queue<uint>();
        queue.Enqueue(root);
        while (queue.Count > 0)
        {
            var pid = queue.Dequeue();
            if (graph.Parents.TryGetValue(pid, out var parent) && graph.Members.Contains(parent) && reached.Add(parent))
            {
                queue.Enqueue(parent);
            }
            foreach (var candidate in graph.Members)
            {
                if (reached.Contains(candidate)) continue;
                if (graph.Parents.TryGetValue(candidate, out var candidateParent) && candidateParent == pid
                    && reached.Add(candidate))
                {
                    queue.Enqueue(candidate);
                }
            }
        }
        return reached;
    }

    private sealed record InstanceGraph(HashSet<uint> Members, Dictionary<uint, uint> Parents);

    /// <summary>The full image path of a process, or an empty string.</summary>
    public static string ProcessImagePath(uint pid)
    {
        var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return string.Empty;
        try
        {
            var buffer = new char[1024];
            var size = buffer.Length;
            return QueryFullProcessImageName(handle, 0, buffer, ref size)
                ? new string(buffer, 0, size)
                : string.Empty;
        }
        finally
        {
            Native.CloseHandle(handle);
        }
    }

    /// <summary>
    /// The closest Windows analogue of a bundle id.
    /// </summary>
    /// <remarks>
    /// It has to be a single string that both names the application and can be
    /// handed back to <c>launch</c>. An Application User Model ID is exactly
    /// that for packaged and many desktop apps; a classic Win32 binary has none,
    /// and for those the executable path plays the same role. Reporting the
    /// empty string would be worse than either: `cua_apps` exists so the model
    /// can find a launch target.
    /// </remarks>
    public static string AppIdFor(uint pid, string imagePath)
    {
        var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle != IntPtr.Zero)
        {
            try
            {
                uint length = 0;
                var status = GetApplicationUserModelId(handle, ref length, null);
                if (status == APPMODEL_ERROR_NO_APPLICATION) return imagePath;
                if (length > 0)
                {
                    var buffer = new char[length];
                    if (GetApplicationUserModelId(handle, ref length, buffer) == 0)
                    {
                        var appId = new string(buffer, 0, (int)length).TrimEnd('\0');
                        if (appId.Length > 0) return appId;
                    }
                }
            }
            finally
            {
                Native.CloseHandle(handle);
            }
        }
        return imagePath;
    }

    /// <summary>A human-readable application name.</summary>
    /// <remarks>
    /// The version resource's description is what the Start menu and Task
    /// Manager show ("Google Chrome"), while the process name is the binary
    /// ("chrome"). The friendly one is what a user, and therefore a model
    /// reading a window title, will recognise.
    /// </remarks>
    public static string ProcessName(uint pid, string imagePath)
    {
        if (imagePath.Length > 0)
        {
            try
            {
                var info = FileVersionInfo.GetVersionInfo(imagePath);
                if (info.FileDescription is { Length: > 0 } description) return description;
            }
            catch (Exception error) when (error is FileNotFoundException or IOException or UnauthorizedAccessException)
            {
                // Fall through to the process name.
            }
        }
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return process.ProcessName;
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException)
        {
            return imagePath.Length > 0 ? Path.GetFileNameWithoutExtension(imagePath) : $"pid {pid}";
        }
    }

    /// <summary>
    /// Whether synthesized input can reach a window, or UIPI will discard it.
    /// </summary>
    /// <remarks>
    /// This has to be asked *before* sending, because there is no way to ask
    /// afterwards. <c>SendInput</c> returns the number of events it queued, not
    /// the number that reached a window; Windows drops injected input destined
    /// for a higher-integrity process further down, and reports nothing. Measured
    /// against an elevated Notepad from an unelevated engine: 36 key events were
    /// accepted with no error and not one character was typed. Reporting
    /// `delivered: true` on the strength of that return value is exactly the kind
    /// of claim this engine exists not to make.
    /// </remarks>
    public static bool CanSendInputTo(IntPtr hwnd)
    {
        if (Native.IsElevated()) return true;
        if (hwnd == IntPtr.Zero) return false;
        if (Native.GetWindowThreadProcessId(hwnd, out uint pid) == 0) return false;
        return CanSendInputToProcess(pid);
    }

    /// <summary>The same question, asked about a process rather than a window.</summary>
    public static bool CanSendInputToProcess(uint pid)
    {
        if (Native.IsElevated()) return true;
        var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return false;
        try
        {
            return !IsProcessElevated(handle);
        }
        finally
        {
            Native.CloseHandle(handle);
        }
    }

    /// <summary>Whether a process runs with an elevated token.</summary>
    public static bool IsProcessElevated(uint pid)
    {
        var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return false;
        try
        {
            return IsProcessElevated(handle);
        }
        finally
        {
            Native.CloseHandle(handle);
        }
    }

    private static bool IsProcessElevated(IntPtr process)
    {
        if (!Native.OpenProcessToken(process, Native.TOKEN_QUERY, out IntPtr token)) return false;
        try
        {
            return Native.GetTokenInformation(
                token, Native.TokenElevation, out Native.TOKEN_ELEVATION info,
                Marshal.SizeOf<Native.TOKEN_ELEVATION>(), out _)
                && info.TokenIsElevated != 0;
        }
        finally
        {
            Native.CloseHandle(token);
        }
    }

    /// <summary>Build a JSON array of display rectangles, as [x, y, width, height].</summary>
    public static JsonArray Frame(Native.RECT rect) => Json.Numbers(
        [rect.Left, rect.Top, rect.Width, rect.Height]);

    /// <summary>Describe a rectangle the way every tool result does.</summary>
    public static string Describe(Native.RECT rect) =>
        $"x={rect.Left} y={rect.Top} width={rect.Width} height={rect.Height}";
}
