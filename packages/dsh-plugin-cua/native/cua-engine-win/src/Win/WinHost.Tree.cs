using System.Text.Json.Nodes;
using System.Text;
using System.Windows.Automation;

namespace CuaEngine.Win;

/// <summary>One emitted tree node, in the form both the JSON array and the outline need.</summary>
internal sealed record TreeNode
{
    public required int Index { get; init; }
    public required int Depth { get; init; }
    public string Role { get; init; } = string.Empty;
    public string? Subrole { get; init; }
    public string? RoleDescription { get; init; }
    public string? Title { get; init; }
    public string? Value { get; init; }
    public string? Description { get; init; }
    public string? Placeholder { get; init; }
    public string? Url { get; init; }
    public string? Help { get; init; }
    public string? Identifier { get; init; }
    public string? ClassName { get; init; }
    public bool Actionable { get; init; }
    public bool Disabled { get; init; }
    public bool Focused { get; init; }
    public bool Selected { get; init; }
    public Native.RECT? Frame { get; init; }
}

/// <summary>
/// The accessibility tree: traversal, filtering, the outline, and the element
/// snapshot that index-addressed actions resolve against.
/// </summary>
/// <remarks>
/// The traversal reproduces the macOS engine's algorithm — breadth-first with a
/// per-sibling priority, layout wrappers folded without consuming a depth level,
/// three independent budgets, and indices assigned at emission time — because
/// the outline it produces is what a model reads and what every later
/// <c>element</c> index means. The vocabulary differs (UI Automation control
/// types instead of AX roles) and so does what counts as a layout wrapper, but
/// the shape of the result does not.
/// </remarks>
public sealed partial class WinHost
{
    /// <summary>Layout wrappers: folded away unless the caller asks for structure.</summary>
    /// <remarks>
    /// The macOS list is AX roles; this is its UI Automation counterpart. These
    /// are the containers that exist for layout rather than for content, so
    /// emitting them buries the interesting nodes under noise — a Chromium
    /// window alone contributes several nested panes before any text appears.
    /// </remarks>
    private static readonly HashSet<string> StructuralRoles = new(StringComparer.Ordinal)
    {
        "Pane", "Group", "TitleBar", "List", "Table", "Tree", "DataGrid", "Separator",
    };

    /// <summary>Control types a user can act on; drives `actionable` and `interactiveOnly`.</summary>
    /// <remarks>
    /// <c>Window</c> is here deliberately. macOS windows always carry an
    /// <c>AXTitle</c>, so they survive the text test on their own; a Windows
    /// top-level window can have no accessible name at all (the desktop's
    /// <c>Progman</c> is one), and dropping it would leave an outline with no
    /// anchor at the top and no way to tell what was dumped.
    /// </remarks>
    private static readonly HashSet<string> InteractiveRoles = new(StringComparer.Ordinal)
    {
        "Button", "CheckBox", "RadioButton", "ComboBox", "Edit", "Hyperlink", "MenuItem", "Menu",
        "TabItem", "Tab", "Slider", "Spinner", "ListItem", "TreeItem", "DataItem", "SplitButton",
        "ScrollBar", "Thumb", "Document", "Calendar", "HeaderItem", "ToolBar", "Window", "Dialog",
    };

    /// <summary>Lower sorts first within one sibling batch.</summary>
    private static int VisitPriority(string role) => role switch
    {
        "Window" or "Dialog" or "Pane" => 0,
        "MenuBar" or "MenuItem" or "Menu" => 2,
        _ => 1,
    };

    /// <summary>The traversal's fixed ceilings, matching the macOS engine's.</summary>
    private const int VisitLimit = 40_000;

    private const int DefaultMaxDepth = 8;
    private const int DefaultNodeLimit = 1200;
    private const int DefaultTextLimit = 200;
    private const double DefaultTimeBudgetMs = 8000;

    /// <summary>The last emitted elements per process, addressed by outline index.</summary>
    private readonly Dictionary<uint, List<AutomationElement>> _snapshots = [];

    private uint? _lastSnapshotPid;

    // MARK: - tree.dump

    /// <summary>Dump one application's or window's accessibility tree.</summary>
    public JsonObject ReadTree(Params parameters)
    {
        parameters.RejectUnknown(
            "app", "pid", "windowId", "windowTitle", "frontmost", "maxDepth", "nodeLimit",
            "textLimit", "roles", "interactiveOnly", "includeStructural", "includeGeometry",
            "includeMenuBar", "timeBudgetMs", "format");

        var appQuery = parameters.String("app");
        var pid = parameters.Int("pid");
        var windowId = parameters.Int("windowId");
        var titleQuery = parameters.String("windowTitle");
        var frontmost = parameters.Bool("frontmost", pid is null && appQuery is null && windowId is null);

        var maxDepth = parameters.Int("maxDepth") ?? DefaultMaxDepth;
        if (maxDepth is < 1 or > 40) throw CuaException.Invalid("\"maxDepth\" must be between 1 and 40");
        var nodeLimit = parameters.Int("nodeLimit") ?? DefaultNodeLimit;
        if (nodeLimit is < 1 or > 20000) throw CuaException.Invalid("\"nodeLimit\" must be between 1 and 20000");
        var textLimit = parameters.Int("textLimit") ?? DefaultTextLimit;
        if (textLimit is < 0 or > 4000) throw CuaException.Invalid("\"textLimit\" must be between 0 and 4000");
        var interactiveOnly = parameters.Bool("interactiveOnly", false);
        var includeStructural = parameters.Bool("includeStructural", false);
        var includeGeometry = parameters.Bool("includeGeometry", false);
        var includeMenuBar = parameters.Bool("includeMenuBar", false);
        var timeBudgetMs = Math.Clamp(parameters.Double("timeBudgetMs") ?? DefaultTimeBudgetMs, 200, 60_000);
        var roleFilter = NormalizeRoles(parameters.StringArray("roles"));

        var resolveRoot = ResolveTreeRoot(
            pid, appQuery, windowId, titleQuery, frontmost, out uint rootPid, out string appName, out IntPtr rootHandle);
        var started = Environment.TickCount64;

        var nodes = new List<TreeNode>(Math.Min(nodeLimit, 256));
        var elements = new List<AutomationElement>(Math.Min(nodeLimit, 256));
        string? truncatedBy = null;
        var visited = 0;

        var cache = BuildCacheRequest();
        using (cache.Activate())
        {
            // The root has to be created inside the cache scope. An element
            // obtained before it has an empty cached property block, which would
            // render the root as `?` with every flag false — the one node the
            // reader uses to orient themselves.
            var root = resolveRoot();
            var queue = new Queue<(AutomationElement Element, int Depth, int Priority)>();
            queue.Enqueue((root, 0, 0));
            while (queue.Count > 0)
            {
                if (Environment.TickCount64 - started > timeBudgetMs) { truncatedBy = "time_budget"; break; }
                if (visited >= VisitLimit) { truncatedBy = "visit_limit"; break; }

                var (element, depth, _) = queue.Dequeue();
                visited++;

                var role = ControlTypeOf(element);
                // The root is never folded and never filtered out. It is what
                // the caller asked for, and it is the only thing that tells a
                // reader what the outline below it describes. This matters more
                // on Windows than on macOS: a Chromium top-level window reports
                // its control type as `Pane`, which the folder would otherwise
                // swallow, leaving an outline with no visible root at all.
                var isRoot = depth == 0;
                var structural = !isRoot && StructuralRoles.Contains(role);
                if (includeStructural || !structural)
                {
                    if (isRoot || ShouldEmit(element, role, roleFilter, interactiveOnly, textLimit))
                    {
                        nodes.Add(BuildNode(nodes.Count, depth, element, role, includeGeometry, textLimit));
                        elements.Add(element);
                        if (nodes.Count >= nodeLimit) { truncatedBy = "node_limit"; break; }
                    }
                }

                var childDepth = structural && !includeStructural ? depth : depth + 1;
                if (childDepth > maxDepth) continue;

                var children = SafeChildren(element, includeStructural);
                var batch = new List<(AutomationElement Element, int Depth, int Priority)>(children.Count);
                foreach (var child in children)
                {
                    var childRole = ControlTypeOf(child);
                    if (!includeMenuBar && childRole == "MenuBar") continue;
                    batch.Add((child, childDepth, VisitPriority(childRole)));
                }
                // A stable sort keeps a menu-bar-free batch in provider order,
                // which is the order the application itself considers visual.
                foreach (var entry in batch.OrderBy(entry => entry.Priority)) queue.Enqueue(entry);
            }
        }

        _snapshots[rootPid] = elements;
        _lastSnapshotPid = rootPid;

        var elapsed = Environment.TickCount64 - started;
        var rendered = RenderOutline(nodes);
        var payload = new JsonArray();
        foreach (var node in nodes) payload.Add(EncodeNode(node));

        var sortedRoles = roleFilter is null ? [] : roleFilter.OrderBy(role => role, StringComparer.Ordinal).ToArray();
        var result = new JsonObject
        {
            ["app"] = appName,
            ["pid"] = (int)rootPid,
            ["windowTitle"] = (rootHandle == IntPtr.Zero ? null : Native.WindowTitle(rootHandle)).Node(),
            ["nodes"] = payload,
            ["text"] = rendered,
            ["nodeCount"] = nodes.Count,
            ["visitedCount"] = visited,
            ["truncatedBy"] = truncatedBy.Node(),
            ["elapsedMs"] = elapsed,
            ["options"] = new JsonObject
            {
                ["maxDepth"] = maxDepth,
                ["nodeLimit"] = nodeLimit,
                ["includeStructural"] = includeStructural,
                ["interactiveOnly"] = interactiveOnly,
                ["includeGeometry"] = includeGeometry,
                ["roles"] = Json.Strings(sortedRoles),
                ["includeMenuBar"] = includeMenuBar,
            },
        };

        // Windows withholds the contents of an elevated window from a lower
        // integrity level, and the enumeration comes back empty rather than
        // failing — so the dump would otherwise look exactly like an application
        // that has no UI at all. Say which one it is.
        if (!Native.IsElevated() && Discovery.IsProcessElevated(rootPid))
        {
            result["note"] =
                $"{appName} is running with administrator rights and this engine is not, so Windows "
                + "withholds its contents: the node below is the window itself and nothing inside it can "
                + "be read, clicked, or typed into from here. Run the harness with administrator rights "
                + "to reach it.";
        }

        return result;
    }

    // MARK: - Root resolution

    /// <summary>
    /// Work out what to dump, and hand back a factory for its root element.
    /// </summary>
    /// <remarks>
    /// The element is created lazily by the caller rather than here, because a
    /// UI Automation element materialised outside an active cache request has no
    /// cached properties — and the walk reads every property from the cache.
    /// </remarks>
    private Func<AutomationElement> ResolveTreeRoot(
        int? pid, string? appQuery, int? windowId, string? titleQuery, bool frontmost,
        out uint rootPid, out string appName, out IntPtr rootHandle)
    {
        if (windowId is not null)
        {
            var handle = new IntPtr(windowId.Value);
            var window = Discovery.Window(handle);
            if (window is null)
            {
                throw CuaException.NotFound($"no window with id {windowId}");
            }
            rootPid = window.ProcessId;
            rootHandle = handle;
            appName = Discovery.ProcessName(rootPid, Discovery.ProcessImagePath(rootPid));
            return () => AutomationElement.FromHandle(handle);
        }

        uint targetPid;
        if (pid is not null)
        {
            if (!Discovery.RunningApps().Any(app => app.ProcessId == (uint)pid.Value))
            {
                throw CuaException.NotFound($"no running application with pid {pid}");
            }
            targetPid = (uint)pid.Value;
        }
        else if (appQuery is { Length: > 0 })
        {
            var candidates = Discovery.RunningApps()
                .Where(app => app.Name.Contains(appQuery, StringComparison.OrdinalIgnoreCase)
                    || app.AppId.Contains(appQuery, StringComparison.OrdinalIgnoreCase)
                    || app.Path.Contains(appQuery, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (candidates.Count == 0)
            {
                throw CuaException.NotFound(
                    $"no running application matches \"{appQuery}\"; call cua_apps for the exact names");
            }
            // Prefer an app the user is looking at; a query like "chrome" can
            // otherwise land on a windowless helper process that owns a window
            // the human never opened.
            targetPid = (candidates.FirstOrDefault(app => app.Active)
                ?? candidates.FirstOrDefault(app => !app.Hidden)
                ?? candidates[0]).ProcessId;
        }
        else if (frontmost || (pid is null && appQuery is null))
        {
            var foreground = Native.GetForegroundWindow();
            if (foreground == IntPtr.Zero)
            {
                throw CuaException.NotFound("no frontmost application");
            }
            Native.GetWindowThreadProcessId(foreground, out targetPid);
        }
        else
        {
            throw CuaException.Invalid("tree.dump needs one of pid, app, or windowId");
        }

        rootPid = targetPid;
        appName = Discovery.ProcessName(targetPid, Discovery.ProcessImagePath(targetPid));

        var chosen = Discovery.FindWindow(targetPid, titleQuery, requireVisible: false);
        if (chosen is null)
        {
            if (titleQuery is { Length: > 0 })
            {
                throw CuaException.NotFound($"no window of {appName} matches title \"{titleQuery}\"");
            }
            // A process with no top-level window still has an automation
            // element; reading it is how a background helper is inspected.
            rootHandle = IntPtr.Zero;
            var fallbackPid = targetPid;
            var fallbackName = appName;
            return () =>
            {
                var byPid = AutomationElement.RootElement.FindFirst(
                    TreeScope.Children,
                    new PropertyCondition(AutomationElement.ProcessIdProperty, (int)fallbackPid));
                return byPid ?? throw CuaException.NotFound(
                    $"{fallbackName} (pid {fallbackPid}) exposes no window and no automation element");
            };
        }
        if (titleQuery is { Length: > 0 }
            && !chosen.Title.Contains(titleQuery, StringComparison.OrdinalIgnoreCase))
        {
            throw CuaException.NotFound($"no window of {appName} matches title \"{titleQuery}\"");
        }
        var chosenHandle = chosen.Handle;
        rootHandle = chosenHandle;
        return () => AutomationElement.FromHandle(chosenHandle);
    }

    // MARK: - Traversal helpers

    /// <summary>
    /// The property set every visited element is read with, in one call.
    /// </summary>
    /// <remarks>
    /// A UI Automation property read is a cross-process call, so reading twelve
    /// properties per node individually makes a browser window take minutes.
    /// A cache request turns each level of the walk into a single round trip and
    /// is what makes a 1200-node dump finish in well under a second.
    /// </remarks>
    private static CacheRequest BuildCacheRequest()
    {
        var cache = new CacheRequest
        {
            TreeScope = TreeScope.Element,
            // Patterns have to stay usable: `element.action` invokes them on
            // these very objects after the dump returns.
            AutomationElementMode = AutomationElementMode.Full,
        };
        foreach (var property in new[]
                 {
                     AutomationElement.NameProperty,
                     AutomationElement.ControlTypeProperty,
                     AutomationElement.AutomationIdProperty,
                     AutomationElement.ClassNameProperty,
                     AutomationElement.BoundingRectangleProperty,
                     AutomationElement.IsEnabledProperty,
                     AutomationElement.HasKeyboardFocusProperty,
                     AutomationElement.IsKeyboardFocusableProperty,
                     AutomationElement.IsOffscreenProperty,
                     AutomationElement.HelpTextProperty,
                     AutomationElement.ItemStatusProperty,
                     AutomationElement.AcceleratorKeyProperty,
                     AutomationElement.AccessKeyProperty,
                     AutomationElement.IsInvokePatternAvailableProperty,
                     AutomationElement.IsTogglePatternAvailableProperty,
                     AutomationElement.IsSelectionItemPatternAvailableProperty,
                     AutomationElement.IsExpandCollapsePatternAvailableProperty,
                     AutomationElement.IsValuePatternAvailableProperty,
                     AutomationElement.IsScrollItemPatternAvailableProperty,
                     AutomationElement.IsRangeValuePatternAvailableProperty,
                     AutomationElement.IsTextPatternAvailableProperty,
                 })
        {
            cache.Add(property);
        }
        // The patterns have to be added as patterns, not merely through their
        // properties: `GetCachedPattern` only succeeds for a pattern the request
        // asked for, and a missing one throws rather than degrading. Adding only
        // the properties silently loses every value, selection state, and toggle
        // state in the dump.
        foreach (var pattern in new[]
                 {
                     InvokePattern.Pattern,
                     ValuePattern.Pattern,
                     SelectionItemPattern.Pattern,
                     TogglePattern.Pattern,
                     ExpandCollapsePattern.Pattern,
                     RangeValuePattern.Pattern,
                     ScrollItemPattern.Pattern,
                 })
        {
            cache.Add(pattern);
        }
        foreach (var patternProperty in new[]
                 {
                     ValuePattern.ValueProperty,
                     ValuePattern.IsReadOnlyProperty,
                     SelectionItemPattern.IsSelectedProperty,
                     TogglePattern.ToggleStateProperty,
                     ExpandCollapsePattern.ExpandCollapseStateProperty,
                     RangeValuePattern.ValueProperty,
                 })
        {
            cache.Add(patternProperty);
        }
        return cache;
    }

    private static string ControlTypeOf(AutomationElement element)
    {
        try
        {
            var name = element.Cached.ControlType.ProgrammaticName;
            var dot = name.LastIndexOf('.');
            return dot >= 0 ? name[(dot + 1)..] : name;
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return string.Empty;
        }
    }

    /// <summary>
    /// The children to consider, as a list.
    /// </summary>
    /// <remarks>
    /// <c>AutomationElementCollection</c> is non-generic in .NET, so it hands
    /// back <c>object</c>; materialising it here keeps the walk typed and lets a
    /// subtree that disappeared mid-walk contribute nothing instead of failing
    /// the whole dump.
    /// </remarks>
    private static List<AutomationElement> SafeChildren(AutomationElement element, bool includeStructural)
    {
        var result = new List<AutomationElement>();
        try
        {
            var condition = includeStructural ? Condition.TrueCondition : Automation.ControlViewCondition;
            var found = element.FindAll(TreeScope.Children, condition);
            foreach (AutomationElement child in found) result.Add(child);
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            // A subtree that went away mid-walk (a menu closing, a page
            // navigating) contributes nothing rather than failing the dump.
        }
        return result;
    }

    private static bool IsUiaFailure(Exception error) =>
        error is ElementNotAvailableException
            or ElementNotEnabledException
            or InvalidOperationException
            or NotSupportedException
            or UnauthorizedAccessException
            or System.Runtime.InteropServices.COMException
            or ArgumentException;

    // MARK: - Emission

    /// <summary>
    /// Whether a visited element earns a line in the outline.
    /// </summary>
    /// <remarks>
    /// The order of the tests is the contract: a role filter admits a
    /// non-interactive text ancestor so that its matching descendants stay
    /// anchored in something readable, and it does so before
    /// <c>interactiveOnly</c> is consulted.
    /// </remarks>
    private static bool ShouldEmit(
        AutomationElement element, string role, string[]? roleFilter, bool interactiveOnly, int textLimit)
    {
        var hasText = HasText(element, textLimit);
        if (roleFilter is not null)
        {
            if (!roleFilter.Contains(role)) return hasText;
        }
        var interactive = IsInteractive(element, role);
        var focused = SafeBool(() => element.Cached.HasKeyboardFocus);
        if (interactiveOnly) return interactive || focused;
        return interactive || focused || hasText;
    }

    private static bool HasText(AutomationElement element, int textLimit)
    {
        if (textLimit <= 0) return false;
        return SafeString(() => element.Cached.Name) is { Length: > 0 }
            || SafeString(() => element.Cached.HelpText) is { Length: > 0 }
            || SafeString(() => element.Cached.ItemStatus) is { Length: > 0 }
            || ReadValuePattern(element) is { Length: > 0 };
    }

    /// <summary>The cached ValuePattern text, without the TextPattern fallback.</summary>
    private static string? ReadValuePattern(AutomationElement element)
    {
        try
        {
            if (!PatternAvailable(element, AutomationElement.IsValuePatternAvailableProperty)) return null;
            var pattern = (ValuePattern)element.GetCachedPattern(ValuePattern.Pattern);
            var value = pattern.Current.Value;
            return string.IsNullOrEmpty(value) ? null : value;
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return null;
        }
    }

    /// <summary>
    /// Whether a user can act on this element.
    /// </summary>
    /// <remarks>
    /// Control type alone is not enough: a large share of real controls —
    /// list rows, custom widgets, provider-authored elements — expose an
    /// action pattern while reporting a generic type. Asking the pattern
    /// availability flags, which the cache already fetched, answers the
    /// question the model is actually asking.
    /// </remarks>
    /// <summary>
    /// Whether a pattern-availability flag came back true.
    /// </summary>
    /// <remarks>
    /// The managed client exposes these as automation properties rather than as
    /// members of the cached information block, and the value is only there
    /// because the cache request asked for it — which is also what makes the
    /// question cheap enough to ask about every node.
    /// </remarks>
    private static bool PatternAvailable(AutomationElement element, AutomationProperty property)
    {
        try
        {
            return element.GetCachedPropertyValue(property) is bool available && available;
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return false;
        }
    }

    private static bool IsInteractive(AutomationElement element, string role)
    {
        if (InteractiveRoles.Contains(role)) return true;
        // ScrollItem is deliberately absent: bringing an element into view is
        // something done *to* it, not by it, and every text node in a browser
        // exposes it — which would mark the whole page "actionable" and make the
        // flag worthless.
        return PatternAvailable(element, AutomationElement.IsInvokePatternAvailableProperty)
            || PatternAvailable(element, AutomationElement.IsTogglePatternAvailableProperty)
            || PatternAvailable(element, AutomationElement.IsSelectionItemPatternAvailableProperty)
            || PatternAvailable(element, AutomationElement.IsExpandCollapsePatternAvailableProperty);
    }

    private static bool SafeBool(Func<bool> read)
    {
        try
        {
            return read();
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return false;
        }
    }

    private static string? SafeString(Func<string?> read)
    {
        try
        {
            var value = read();
            return string.IsNullOrEmpty(value) ? null : value;
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return null;
        }
    }

    /// <summary>
    /// The element's text, from whichever pattern exposes it.
    /// </summary>
    /// <remarks>
    /// macOS has one place to look — <c>AXValue</c>. UI Automation splits it in
    /// two: an edit field publishes <c>ValuePattern</c>, and a document control
    /// (which is what a WinForms text box, a rich edit, and a browser's content
    /// area all report as) publishes <c>TextPattern</c> instead. Reading only
    /// the first would leave the model unable to verify that the text it just
    /// typed arrived, which the tool's own guidance tells it to do.
    /// </remarks>
    private static string? ReadValue(AutomationElement element, string role, int textLimit)
    {
        try
        {
            if (PatternAvailable(element, AutomationElement.IsValuePatternAvailableProperty))
            {
                var pattern = (ValuePattern)element.GetCachedPattern(ValuePattern.Pattern);
                var value = pattern.Current.Value;
                if (!string.IsNullOrEmpty(value)) return value;
            }

            // TextPattern has no cached form, so this is a live cross-process
            // call and is deliberately limited to the controls whose whole
            // purpose is to hold text.
            var textBearing = role == "Edit"
                || (role == "Document" && SafeBool(() => element.Cached.HasKeyboardFocus));
            if (!textBearing) return null;
            if (!PatternAvailable(element, AutomationElement.IsTextPatternAvailableProperty)) return null;
            if (!element.TryGetCurrentPattern(TextPattern.Pattern, out var instance)) return null;

            // Over-fetch a little past the cap so the truncation the caller
            // asked for is the only truncation that happens, and never pull a
            // whole document across the process boundary.
            var budget = Math.Clamp(textLimit * 4 + 64, 256, 4096);
            var text = ((TextPattern)instance).DocumentRange.GetText(budget);
            return string.IsNullOrEmpty(text) ? null : text;
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return null;
        }
    }

    private static bool ReadSelected(AutomationElement element)
    {
        try
        {
            if (!PatternAvailable(element, AutomationElement.IsSelectionItemPatternAvailableProperty)) return false;
            var pattern = (SelectionItemPattern)element.GetCachedPattern(SelectionItemPattern.Pattern);
            return pattern.Current.IsSelected;
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return false;
        }
    }

    private static TreeNode BuildNode(
        int index, int depth, AutomationElement element, string role, bool includeGeometry, int textLimit)
    {
        var name = SafeString(() => element.Cached.Name);
        var help = SafeString(() => element.Cached.HelpText);
        var value = ReadValue(element, role, textLimit);
        var isLink = role == "Hyperlink";

        // A hyperlink's value is its target, which is a different kind of fact
        // from a text field's contents; surfacing it as `url` keeps the outline
        // honest about which is which.
        string? url = null;
        if (isLink && value is not null && (value.Contains("://", StringComparison.Ordinal) || value.StartsWith("www.", StringComparison.OrdinalIgnoreCase)))
        {
            url = value;
            value = null;
        }

        // Windows controls describe their placeholder through HelpText and leave
        // Name empty; macOS has a dedicated AXPlaceholderValue. Mapping it this
        // way lets a model recognise an empty search box on either platform.
        string? placeholder = name is null ? help : null;
        string? description = name is null ? null : help;

        Native.RECT? frame = null;
        if (includeGeometry)
        {
            var bounds = Bounds(element);
            if (bounds.Width > 0 || bounds.Height > 0) frame = bounds;
        }

        return new TreeNode
        {
            Index = index,
            Depth = depth,
            Role = role,
            Subrole = null,
            RoleDescription = SafeString(() => element.Cached.LocalizedControlType) is { } localized
                && !string.Equals(localized, role, StringComparison.OrdinalIgnoreCase)
                    ? localized
                    : null,
            Title = Cap(name, textLimit),
            Value = Cap(value, textLimit),
            Description = Cap(description, textLimit),
            Placeholder = Cap(placeholder, textLimit),
            Url = Cap(url, textLimit),
            Help = Cap(help, textLimit),
            Identifier = Cap(SafeString(() => element.Cached.AutomationId), textLimit),
            ClassName = Cap(SafeString(() => element.Cached.ClassName), textLimit),
            Actionable = IsInteractive(element, role),
            Disabled = !SafeBool(() => element.Cached.IsEnabled),
            Focused = SafeBool(() => element.Cached.HasKeyboardFocus),
            Selected = ReadSelected(element),
            Frame = frame,
        };
    }

    // MARK: - Text handling

    /// <summary>
    /// Truncate to <paramref name="limit"/> characters, appending an ellipsis.
    /// </summary>
    /// <remarks>
    /// Counted in Unicode scalar values rather than UTF-16 units: half a
    /// surrogate pair is not text, and an emoji-heavy label would otherwose be
    /// cut to something unreadable. A limit of zero disables text entirely,
    /// which is how a caller asks for shape without content.
    /// </remarks>
    private static string? Cap(string? text, int limit)
    {
        if (string.IsNullOrEmpty(text) || limit <= 0) return null;
        var count = 0;
        for (var index = 0; index < text.Length; index++)
        {
            if (count == limit) return text[..index] + "\u2026";
            if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
            {
                index++;
            }
            count++;
        }
        return text;
    }

    /// <summary>
    /// Make a value safe to place inside a one-line outline entry.
    /// </summary>
    /// <remarks>
    /// One node is one line, which is what makes the outline scannable. The
    /// macOS engine maps newlines to <c>⏎</c> and leaves carriage returns alone,
    /// which a Windows edit control supplies in abundance (<c>\r\n</c> pairs) —
    /// so all three line endings map to the same visible mark here.
    /// </remarks>
    private static string Flatten(string text) =>
        text.Replace("\r\n", "\u23CE", StringComparison.Ordinal)
            .Replace('\r', '\u23CE')
            .Replace('\n', '\u23CE')
            .Replace('\t', ' ');

    // MARK: - Outline

    /// <summary>Render the emitted nodes as the model-facing outline.</summary>
    private static string RenderOutline(List<TreeNode> nodes)
    {
        var builder = new StringBuilder();
        for (var index = 0; index < nodes.Count; index++)
        {
            if (index > 0) builder.Append('\n');
            var node = nodes[index];
            builder.Append('[').Append(node.Index).Append("] ");
            builder.Append(' ', Math.Max(0, node.Depth) * 2);
            builder.Append(node.Role.Length > 0 ? node.Role : "?");
            if (node.Subrole is { Length: > 0 } subrole) builder.Append('/').Append(subrole);

            var details = new List<string>(8);
            if (node.Title is { Length: > 0 } title) details.Add($"title=\"{Flatten(title)}\"");
            if (node.Value is { Length: > 0 } value) details.Add($"value=\"{Flatten(value)}\"");
            if (node.Description is { Length: > 0 } description) details.Add($"description=\"{Flatten(description)}\"");
            if (node.Placeholder is { Length: > 0 } placeholder) details.Add($"placeholder=\"{Flatten(placeholder)}\"");
            if (node.Url is { Length: > 0 } url) details.Add($"url=\"{Flatten(url)}\"");
            if (node.Actionable) details.Add("actionable");
            if (node.Disabled) details.Add("disabled");
            if (node.Focused) details.Add("focused");
            if (node.Selected) details.Add("selected");
            if (node.Frame is { } frame)
            {
                details.Add($"at={frame.Left},{frame.Top} {frame.Width}x{frame.Height}");
            }
            if (details.Count > 0) builder.Append(" \u2014 ").Append(string.Join(' ', details));
        }
        return builder.ToString();
    }

    // MARK: - Node encoding

    private static JsonObject EncodeNode(TreeNode node)
    {
        var payload = new JsonObject
        {
            ["depth"] = node.Depth,
            ["role"] = node.Role,
        };
        // Optional members are omitted rather than sent as null, matching the
        // macOS engine: the plugin's normaliser already supplies the defaults,
        // and `enabled: true` on every node is noise the model has to read past.
        if (node.Title is { Length: > 0 }) payload["title"] = node.Title;
        if (node.Value is { Length: > 0 }) payload["value"] = node.Value;
        if (node.Description is { Length: > 0 }) payload["description"] = node.Description;
        if (node.Placeholder is { Length: > 0 }) payload["placeholder"] = node.Placeholder;
        if (node.Url is { Length: > 0 }) payload["url"] = node.Url;
        if (node.RoleDescription is { Length: > 0 }) payload["roleDescription"] = node.RoleDescription;
        if (node.Identifier is { Length: > 0 }) payload["identifier"] = node.Identifier;
        if (node.ClassName is { Length: > 0 }) payload["className"] = node.ClassName;
        if (node.Actionable) payload["actionable"] = true;
        if (node.Disabled) payload["enabled"] = false;
        if (node.Focused) payload["focused"] = true;
        if (node.Selected) payload["selected"] = true;
        if (node.Frame is { } frame) payload["frame"] = Discovery.Frame(frame);
        return payload;
    }

    // MARK: - Role filter

    /// <summary>
    /// Normalise a role filter so both vocabularies work.
    /// </summary>
    /// <remarks>
    /// The tools advertise the macOS role names, and a model that has learned
    /// them will keep sending <c>AXButton</c> on Windows. Translating the common
    /// AX roles to their UI Automation control types costs one table and saves
    /// the caller from a filter that silently matches nothing.
    /// </remarks>
    private static string[]? NormalizeRoles(string[]? roles)
    {
        if (roles is null || roles.Length == 0) return null;
        var normalised = new HashSet<string>(StringComparer.Ordinal);
        foreach (var role in roles)
        {
            if (role.Length == 0) continue;
            var name = role.StartsWith("AX", StringComparison.Ordinal) ? role[2..] : role;
            normalised.Add(Aliases.TryGetValue(name, out var mapped) ? mapped : name);
        }
        return normalised.Count == 0 ? null : [.. normalised];
    }

    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["TextField"] = "Edit",
        ["TextArea"] = "Edit",
        ["SearchField"] = "Edit",
        ["StaticText"] = "Text",
        ["Link"] = "Hyperlink",
        ["PopUpButton"] = "ComboBox",
        ["MenuButton"] = "MenuItem",
        ["MenuBarItem"] = "MenuItem",
        ["DisclosureTriangle"] = "Button",
        ["SegmentedControl"] = "Button",
        ["ToolbarButton"] = "Button",
        ["Switch"] = "CheckBox",
        ["Toggle"] = "CheckBox",
        ["Incrementor"] = "Spinner",
        ["Row"] = "DataItem",
        ["Cell"] = "DataItem",
        ["ScrollArea"] = "Pane",
        ["Outline"] = "Tree",
        ["Browser"] = "Tree",
        ["Column"] = "HeaderItem",
        ["WebArea"] = "Document",
        ["Image"] = "Image",
        ["Sheet"] = "Window",
        ["Application"] = "Window",
    };
}
