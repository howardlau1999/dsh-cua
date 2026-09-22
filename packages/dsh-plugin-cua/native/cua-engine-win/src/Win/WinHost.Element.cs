using System.Text.Json.Nodes;
using System.Windows.Automation;

namespace CuaEngine.Win;

/// <summary>
/// Element actions: ask a control to perform its own action.
/// </summary>
/// <remarks>
/// This is the preferred way to act on a control on either platform, and the
/// reason is structural rather than stylistic: the application performs the
/// action through its own automation provider, so it needs no coordinates, it
/// cannot miss because a window moved, it works on a window the user is not
/// looking at, and it does not steal focus.
///
/// Where macOS has one <c>AXPress</c>, UI Automation has a family of patterns,
/// so <c>press</c> here means "whichever of Invoke, Toggle, Select, Expand, or
/// the legacy default action this control actually exposes" — and the result
/// names the one that ran instead of hiding the choice.
/// </remarks>
public sealed partial class WinHost
{
    private static readonly string[] ElementActions =
        ["press", "setValue", "focus", "scrollToVisible", "menu", "list"];

    /// <summary>Perform one element's own action.</summary>
    public JsonObject ElementAction(Params parameters)
    {
        parameters.RejectUnknown("element", "elementRef", "pid", "action", "text", "path");

        var index = parameters.Int("element");
        if (index is null)
        {
            throw CuaException.Invalid(
                "element.action requires \"element\" (a cua_tree index); run cua_tree first");
        }
        var pid = parameters.Int("pid");
        var action = parameters.Enum("action", ElementActions) ?? "press";

        var (element, ownerPid) = ResolveElement(index.Value, pid);
        var available = AvailablePatterns(element);

        switch (action)
        {
            case "list":
                return new JsonObject
                {
                    ["actions"] = Json.Strings(available),
                    ["attributes"] = Json.Strings(SupportedProperties(element)),
                };

            case "press":
                return Press(element, index.Value, available);

            case "setValue":
                return SetValue(element, parameters, available);

            case "focus":
                return Focus(element);

            case "scrollToVisible":
                return ScrollIntoView(element, available);

            case "menu":
                return InvokeMenu(element, ownerPid, ReadPath(parameters));

            default:
                throw CuaException.Failed($"action \"{action}\" is not supported by the Windows backend");
        }
    }

    // MARK: - Actions

    private JsonObject Press(AutomationElement element, int index, List<string> available)
    {
        // Order matters: Invoke is the direct "activate this" verb; the rest are
        // the same user intent expressed through whatever pattern the control
        // chose to expose.
        foreach (var (pattern, verb) in new (AutomationPattern Pattern, string Verb)[]
                 {
                     (InvokePattern.Pattern, "Invoke"),
                     (TogglePattern.Pattern, "Toggle"),
                     (SelectionItemPattern.Pattern, "Select"),
                     (ExpandCollapsePattern.Pattern, "Expand"),
                 })
        {
            if (!element.TryGetCurrentPattern(pattern, out var instance)) continue;
            try
            {
                switch (verb)
                {
                    case "Invoke":
                        ((InvokePattern)instance).Invoke();
                        break;
                    case "Toggle":
                        ((TogglePattern)instance).Toggle();
                        break;
                    case "Select":
                        ((SelectionItemPattern)instance).Select();
                        break;
                    case "Expand":
                        var expand = (ExpandCollapsePattern)instance;
                        // Already open is the state a press would produce, so it
                        // counts as performed rather than collapsing the menu
                        // the caller was trying to open.
                        if (expand.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) expand.Expand();
                        break;
                }
                return new JsonObject { ["performed"] = true, ["action"] = verb };
            }
            catch (Exception error) when (IsUiaFailure(error))
            {
                // The control advertises the pattern but refused — a disabled
                // button, a read-only toggle. That is a refusal, not a reason to
                // fall back to clicking, which would hit whatever moved there.
                return new JsonObject
                {
                    ["performed"] = false,
                    ["action"] = verb,
                    ["reason"] = $"{verb} failed: {error.Message}",
                    ["availableActions"] = Json.Strings(available),
                };
            }
        }


        var bounds = Bounds(element);
        if (bounds.Width > 0 && bounds.Height > 0)
        {
            var x = bounds.Left + bounds.Width / 2;
            var y = bounds.Top + bounds.Height / 2;
            Discovery.RequireDisplayAt(x, y);
            // The fallback is synthesized input like any other, so the integrity
            // boundary applies to it too — and a click that Windows discards must
            // not be reported as performed.
            if (BlockedReasonAt(new Native.POINT { X = x, Y = y }) is { } blocked)
            {
                return new JsonObject
                {
                    ["performed"] = false,
                    ["action"] = "click_fallback",
                    ["screenX"] = x,
                    ["screenY"] = y,
                    ["reason"] = blocked,
                    ["availableActions"] = Json.Strings(available),
                };
            }
            var actual = MoveCursor(x, y);
            var delivered = Send([Mouse(Native.MOUSEEVENTF_LEFTDOWN, 0), Mouse(Native.MOUSEEVENTF_LEFTUP, 0)]);
            return new JsonObject
            {
                ["performed"] = delivered,
                ["action"] = "click_fallback",
                ["screenX"] = actual.X,
                ["screenY"] = actual.Y,
                ["reason"] = delivered
                    ? null
                    : "the element exposes no invokable pattern and the fallback click was refused",
                ["availableActions"] = Json.Strings(available),
            };
        }

        return new JsonObject
        {
            ["performed"] = false,
            ["action"] = "press",
            ["reason"] = "the element exposes no invokable pattern and has no on-screen rectangle",
            ["availableActions"] = Json.Strings(available),
        };
    }


    private static JsonObject SetValue(AutomationElement element, Params parameters, List<string> available)
    {
        var text = parameters.String("text")
            ?? throw CuaException.Invalid("element.action: missing required parameter \"text\" for setValue");
        try
        {
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var instance))
            {
                var value = (ValuePattern)instance;
                if (value.Current.IsReadOnly)
                {
                    throw CuaException.Failed("the element's value is read-only, so it cannot be set");
                }
                value.SetValue(text);
                return new JsonObject { ["performed"] = true, ["action"] = "setValue" };
            }

        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            throw CuaException.Failed($"the value could not be set: {error.Message}");
        }
        throw CuaException.Failed(
            $"the element does not expose a value that can be set (available: "
            + $"{(available.Count == 0 ? "none" : string.Join(", ", available))}); "
            + "type into it with cua_type and an element index instead");
    }

    private static JsonObject Focus(AutomationElement element)
    {
        try
        {
            element.SetFocus();
            return new JsonObject { ["performed"] = true, ["action"] = "focus" };
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            throw CuaException.Failed($"the element could not take focus: {error.Message}");
        }
    }

    private static JsonObject ScrollIntoView(AutomationElement element, List<string> available)
    {
        try
        {
            if (!element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out var instance))
            {
                return new JsonObject
                {
                    ["performed"] = false,
                    ["action"] = "scrollToVisible",
                    ["reason"] = "the element is not inside a scrollable container",
                    ["availableActions"] = Json.Strings(available),
                };
            }
            ((ScrollItemPattern)instance).ScrollIntoView();
            return new JsonObject { ["performed"] = true, ["action"] = "scrollToVisible" };
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return new JsonObject
            {
                ["performed"] = false,
                ["action"] = "scrollToVisible",
                ["reason"] = $"the element does not support scrolling into view: {error.Message}",
                ["availableActions"] = Json.Strings(available),
            };
        }
    }

    private static string[] ReadPath(Params parameters)
    {
        var path = parameters.StringArray("path") ?? [];
        if (path.Length == 0)
        {
            throw CuaException.Invalid("the menu action requires a non-empty \"path\" of menu titles");
        }
        return path;
    }

    // MARK: - Menu traversal

    /// <summary>
    /// Walk a menu path from the menu bar inward and invoke the leaf.
    /// </summary>
    /// <remarks>
    /// Best-effort by nature: a Win32 menu is a popup window rather than a
    /// subtree of the application, so after expanding a top-level item the
    /// engine has to look for the popup the application just created. When that
    /// lookup fails the result says which title it got to, so the caller can
    /// fall back to dumping the tree with <c>includeMenuBar</c> and pressing the
    /// item by index — which is the more reliable route on Windows anyway.
    /// </remarks>
    private JsonObject InvokeMenu(AutomationElement element, uint pid, string[] path)
    {
        if (FindMenuBar(element) is null)
        {
            return new JsonObject
            {
                ["performed"] = false,
                ["reason"] = "no menu bar is reachable from this element; target an application window "
                    + "that has one, or read the tree with includeMenuBar",
            };
        }
        var window = OwningWindow(element);
        if (window is null)
        {
            return new JsonObject
            {
                ["performed"] = false,
                ["reason"] = "the element's window could not be identified",
            };
        }
        _ = pid;

        var traversed = new List<string>();
        for (var step = 0; step < path.Length; step++)
        {
            var title = path[step];
            var item = FindMenuItem(window, title);
            if (item is null)
            {
                return new JsonObject
                {
                    ["performed"] = false,
                    ["traversed"] = Json.Strings(traversed),
                    ["reason"] = $"no menu item titled \"{title}\" under "
                        + (step == 0 ? "the menu bar" : $"the menu opened by \"{path[step - 1]}\""),
                };
            }
            traversed.Add(title);

            if (step == path.Length - 1)
            {
                return ActivateMenuItem(item, traversed);
            }

            if (!Open(item))
            {
                return new JsonObject
                {
                    ["performed"] = false,
                    ["traversed"] = Json.Strings(traversed),
                    ["reason"] = $"menu item \"{title}\" has no submenu",
                };
            }
            // The submenu is built asynchronously by the application; without a
            // pause the next lookup runs before its items exist.
            Thread.Sleep(150);
        }

        return new JsonObject { ["performed"] = false, ["reason"] = "menu path was not resolved" };
    }

    /// <summary>
    /// The menu item with this title, anywhere in the window.
    /// </summary>
    /// <remarks>
    /// Searching the whole window rather than a located "submenu" object is what
    /// makes this work across toolkits. Windows 11's own applications build their
    /// menus in WinUI, where opening a top-level item creates a
    /// <c>PopupWindowSiteBridge</c> pane holding a plain <c>Window</c> named
    /// "Popup" — not the <c>Menu</c> element a classic Win32 menu produces, which
    /// is what the first version of this looked for, so every multi-level path
    /// failed while single-level ones worked.
    ///
    /// The scope is exact despite being broad: only one menu can be open at a
    /// time, and until one is, its items do not exist in the tree at all.
    /// </remarks>
    private static AutomationElement? FindMenuItem(AutomationElement window, string title)
    {
        try
        {
            var items = window.FindAll(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem));
            AutomationElement? partial = null;
            foreach (AutomationElement item in items)
            {
                var name = item.Current.Name;
                if (string.Equals(name, title, StringComparison.OrdinalIgnoreCase)) return item;
                // Menu titles carry their accelerator after a tab or in
                // parentheses; a prefix match keeps "Save" finding "Save\tCtrl+S".
                if (partial is null && name.Length > 0
                    && name.StartsWith(title, StringComparison.OrdinalIgnoreCase)) partial = item;
            }
            return partial;
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return null;
        }
    }

    private static JsonObject ActivateMenuItem(AutomationElement item, List<string> traversed)
    {
        try
        {
            if (item.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke))
            {
                ((InvokePattern)invoke).Invoke();
                return new JsonObject { ["performed"] = true, ["path"] = Json.Strings(traversed) };
            }
            if (item.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var select))
            {
                ((SelectionItemPattern)select).Select();
                return new JsonObject { ["performed"] = true, ["path"] = Json.Strings(traversed) };
            }
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return new JsonObject
            {
                ["performed"] = false,
                ["path"] = Json.Strings(traversed),
                ["reason"] = $"menu item did not respond: {error.Message}",
            };
        }
        return new JsonObject
        {
            ["performed"] = false,
            ["path"] = Json.Strings(traversed),
            ["reason"] = "the menu item exposes no way to be invoked",
        };
    }

    /// <summary>Open a menu item so that its submenu comes into existence.</summary>
    /// <remarks>
    /// Two patterns, because the right one depends on the toolkit and there is no
    /// way to ask which. A classic Win32 menu bar opens a top-level item through
    /// ExpandCollapse; a WinUI menu bar — which is what Windows 11's own
    /// applications use — has no ExpandCollapse on those items at all and opens
    /// through Invoke. Trying only ExpandCollapse made every multi-level path fail
    /// with "has no submenu" against the menus this machine actually ships, which
    /// is also why the port notes claiming multi-level paths work were wrong.
    /// </remarks>
    private static bool Open(AutomationElement item) =>
        TryPattern(item, ExpandCollapsePattern.Pattern, instance => ((ExpandCollapsePattern)instance).Expand())
        || TryPattern(item, InvokePattern.Pattern, instance => ((InvokePattern)instance).Invoke());

    private static bool TryPattern(AutomationElement element, AutomationPattern pattern, Action<object> use)
    {
        try
        {
            if (!element.TryGetCurrentPattern(pattern, out var instance)) return false;
            use(instance);
            return true;
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return false;
        }
    }

    /// <summary>The menu bar belonging to an element's window.</summary>
    private static AutomationElement? FindMenuBar(AutomationElement element)
    {
        try
        {
            var window = OwningWindow(element);
            if (window is null) return null;
            var direct = window.FindFirst(
                TreeScope.Children,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuBar));
            if (direct is not null) return direct;
            // Some applications put a client pane between the window and the bar.
            return window.FindFirst(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuBar));
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return null;
        }
    }

    /// <summary>The top-level window containing an element.</summary>
    private static AutomationElement? OwningWindow(AutomationElement element)
    {
        try
        {
            var walker = TreeWalker.RawViewWalker;
            var current = element;
            for (var depth = 0; depth < 64 && current is not null; depth++)
            {
                if (current.Current.ControlType == ControlType.Window) return current;
                current = walker.GetParent(current);
            }
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            // Fall through to the geometry-based answer.
        }
        var bounds = Bounds(element);
        if (bounds.Width <= 0) return null;
        var handle = Native.WindowFromPoint(
            new Native.POINT { X = bounds.Left + bounds.Width / 2, Y = bounds.Top + bounds.Height / 2 });
        if (handle == IntPtr.Zero) return null;
        var root = Native.GetAncestor(handle, Native.GA_ROOT);
        try
        {
            return AutomationElement.FromHandle(root == IntPtr.Zero ? handle : root);
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return null;
        }
    }

    // MARK: - Introspection

    private static List<string> AvailablePatterns(AutomationElement element)
    {
        var names = new List<string>();
        foreach (var (pattern, name) in new (AutomationPattern Pattern, string Name)[]
                 {
                     (InvokePattern.Pattern, "Invoke"),
                     (TogglePattern.Pattern, "Toggle"),
                     (SelectionItemPattern.Pattern, "Select"),
                     (SelectionPattern.Pattern, "Selection"),
                     (ExpandCollapsePattern.Pattern, "ExpandCollapse"),
                     (ValuePattern.Pattern, "Value"),
                     (RangeValuePattern.Pattern, "RangeValue"),
                     (ScrollItemPattern.Pattern, "ScrollIntoView"),
                     (ScrollPattern.Pattern, "Scroll"),
                     (TextPattern.Pattern, "Text"),
                     (WindowPattern.Pattern, "Window"),
                     (TransformPattern.Pattern, "Transform"),
                     (GridPattern.Pattern, "Grid"),
                     (GridItemPattern.Pattern, "GridItem"),
                     (TablePattern.Pattern, "Table"),
                     (TableItemPattern.Pattern, "TableItem"),

                 })
        {
            try
            {
                if (element.TryGetCurrentPattern(pattern, out _)) names.Add(name);
            }
            catch (Exception error) when (IsUiaFailure(error))
            {
                // A pattern that cannot even be queried is simply not available.
            }
        }
        return names;
    }

    private static List<string> SupportedProperties(AutomationElement element)
    {
        var names = new List<string>();
        try
        {
            foreach (var property in element.GetSupportedProperties())
            {
                var name = property.ProgrammaticName;
                var dot = name.LastIndexOf('.');
                names.Add(dot >= 0 ? name[(dot + 1)..] : name);
            }
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            // Introspection is optional; an element that refuses it still works.
        }
        return names;
    }

    // MARK: - Snapshot addressing

    /// <summary>
    /// Resolve a <c>cua_tree</c> outline index against the snapshot it came from.
    /// </summary>
    /// <remarks>
    /// Indices are only meaningful relative to the dump that produced them, so a
    /// missing or out-of-range index is an explicit failure that names the
    /// remedy. Falling back to a remembered element would silently act on
    /// something the caller never chose.
    /// </remarks>
    private (AutomationElement Element, uint Pid) ResolveElement(int index, int? pid)
    {
        var target = pid is not null ? (uint)pid.Value : _lastSnapshotPid;
        if (target is null)
        {
            throw CuaException.NotFound(
                "no cua_tree snapshot exists yet; run cua_tree before addressing an element by index");
        }
        var resolved = target.Value;
        if (!_snapshots.TryGetValue(resolved, out var elements))
        {
            throw CuaException.NotFound(
                $"no cua_tree snapshot for pid {resolved}; run cua_tree for that application first");
        }
        if (index < 0)
        {
            throw CuaException.Invalid($"element index {index} is negative; outline indices start at 0");
        }
        if (index >= elements.Count)
        {
            throw CuaException.NotFound(
                $"element index {index} is outside the last snapshot of pid {resolved} "
                + $"({elements.Count} nodes); re-run cua_tree");
        }
        var element = elements[index];
        try
        {
            // Touching a property is what proves the element still exists; the
            // reference is live, and the window it belonged to may have closed.
            _ = element.Current.ControlType;
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            throw CuaException.NotFound(
                $"element #{index} no longer exists ({error.Message}); re-run cua_tree");
        }
        return (element, resolved);
    }
}
