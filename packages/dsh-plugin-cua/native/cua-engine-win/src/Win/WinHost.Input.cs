using System.Text.Json.Nodes;
using System.Windows.Automation;

namespace CuaEngine.Win;

/// <summary>
/// Synthesized pointer and keyboard input.
/// </summary>
/// <remarks>
/// Windows has one real input path — <c>SendInput</c> — and it targets whatever
/// is frontmost, exactly like the macOS window-server route. The difference from
/// macOS is that there is no <c>CGEventPostToPid</c> equivalent, so the
/// background-window guarantees the tools describe for macOS do not hold here.
/// Rather than pretend, the pointer offers a genuinely different second route:
/// posting window messages straight to a background window's queue, which works
/// on classic Win32 controls and leaves the visible cursor alone. The keyboard
/// has no such route at all, and reports the route it actually used.
/// </remarks>
public sealed partial class WinHost
{
    private static readonly string[] PointerActions = ["click", "move", "scroll", "drag", "down", "up"];
    private static readonly string[] PointerButtons = ["left", "right", "middle"];
    private static readonly string[] Routes = ["post", "pid"];

    // MARK: - Pointer

    /// <summary>Click, move, scroll, or drag on the real desktop.</summary>
    public JsonObject Pointer(Params parameters)
    {
        parameters.RejectUnknown(
            "action", "x", "y", "element", "pid", "clickCount", "button",
            "dx", "dy", "fromX", "fromY", "toX", "toY", "steps", "durationMs", "route");

        var action = parameters.Enum("action", PointerActions, "click");
        var button = parameters.Enum("button", PointerButtons, "left");
        var route = parameters.Enum("route", Routes, "post");
        var clickCount = parameters.Int("clickCount") ?? 1;
        var elementIndex = parameters.Int("element");
        var pid = parameters.Int("pid");

        if (clickCount < 1) throw CuaException.Invalid("\"clickCount\" must be at least 1");

        return action switch
        {
            "drag" => Drag(parameters, button, route, elementIndex, pid),
            "scroll" => Scroll(parameters, route, elementIndex, pid),
            _ => Simple(action, parameters, button, route, clickCount, elementIndex, pid),
        };
    }

    private JsonObject Simple(
        string action, Params parameters, string button, string route, int clickCount, int? elementIndex, int? pid)
    {
        var target = ResolvePoint(parameters, elementIndex, pid, action == "move" ? "move" : action);
        var desktop = Discovery.Desktop();

        if (route == "pid")
        {
            // The point has to belong to the named process, otherwise the
            // messages would be posted to an unrelated window.
            var window = Native.WindowFromPoint(new Native.POINT { X = target.X, Y = target.Y });
            if (window == IntPtr.Zero)
            {
                throw CuaException.NotFound($"no window is at ({target.X}, {target.Y}) to receive the message");
            }
            Native.GetWindowThreadProcessId(window, out uint owner);
            if (pid is not null && owner != (uint)pid.Value)
            {
                throw CuaException.NotFound(
                    $"the window at ({target.X}, {target.Y}) belongs to pid {owner}, not pid {pid}");
            }
            // A posted message crosses the integrity boundary no more than
            // injected input does: UIPI blocks PostMessage to a higher-integrity
            // window, and it fails silently in exactly the same way.
            if (BlockedReason(window, "the window receiving the messages") is { } posted)
            {
                return Refused(action, "pid", target, button, action == "click" ? clickCount : null, posted);
            }
            PostPointerMessages(window, target, action, button, clickCount);
            return new JsonObject
            {
                ["delivered"] = true,
                ["action"] = action,
                ["route"] = "pid",
                ["screenX"] = target.X,
                ["screenY"] = target.Y,
                ["clickCount"] = action == "click" ? clickCount : null,
                ["button"] = button,
                ["note"] = "Posted as window messages; the visible cursor did not move and the target window "
                    + "does not need to be frontmost. Classic Win32 controls honour these messages; "
                    + "applications that read the real cursor position (Chromium, UWP, most canvas UIs) do not.",
            };
        }

        // Refuse before moving anything when the target cannot receive the event.
        // Checked for every action that actually delivers a button or a wheel
        // event; a bare move is not gated by integrity and is left alone.
        if (action != "move" && BlockedReasonAt(target) is { } blocked)
        {
            return Refused(action, "post", target, button, action == "click" ? clickCount : null, blocked);
        }

        var actual = MoveCursor(target.X, target.Y);
        if (action == "move")
        {
            return new JsonObject
            {
                ["delivered"] = actual.X == target.X && actual.Y == target.Y,
                ["action"] = "move",
                ["route"] = "post",
                ["screenX"] = actual.X,
                ["screenY"] = actual.Y,
                ["reason"] = actual.X == target.X && actual.Y == target.Y
                    ? null
                    : $"the pointer landed at ({actual.X}, {actual.Y}) instead of ({target.X}, {target.Y}); "
                        + "another process may be capturing the mouse",
            };
        }

        uint down;
        uint up;
        (down, up) = button switch
        {
            "right" => (Native.MOUSEEVENTF_RIGHTDOWN, Native.MOUSEEVENTF_RIGHTUP),
            "middle" => (Native.MOUSEEVENTF_MIDDLEDOWN, Native.MOUSEEVENTF_MIDDLEUP),
            _ => (Native.MOUSEEVENTF_LEFTDOWN, Native.MOUSEEVENTF_LEFTUP),
        };

        // `down` and `up` are the halves of a gesture the caller is composing
        // itself — press here, move, release there — so each sends only its own
        // half. Both used to fall through to the click branch and send a complete
        // press-and-release pair, which turned a hand-built drag into two clicks:
        // measured, a `down` at one point and an `up` at another left the caret
        // where the second click landed and selected nothing.
        var events = new List<Native.INPUT>();
        if (action == "down")
        {
            events.Add(Mouse(down, 0));
        }
        else if (action == "up")
        {
            events.Add(Mouse(up, 0));
        }
        else
        {
            for (var index = 0; index < clickCount; index++)
            {
                events.Add(Mouse(down, 0));
                events.Add(Mouse(up, 0));
                if (index + 1 < clickCount && Native.GetDoubleClickTime() > 0)
                {
                    // Stay inside the double-click window so the pair is recognised
                    // as one gesture rather than two unrelated clicks.
                    Send(events);
                    events.Clear();
                    Thread.Sleep((int)Math.Min(Native.GetDoubleClickTime() / 4, 60));
                }
            }
        }
        var inserted = events.Count == 0 || Send(events);

        return new JsonObject
        {
            ["delivered"] = inserted,
            ["action"] = action,
            ["route"] = "post",
            ["screenX"] = actual.X,
            ["screenY"] = actual.Y,
            ["clickCount"] = action == "click" ? clickCount : null,
            ["button"] = button,
            ["held"] = action == "down" ? true : null,
            ["reason"] = inserted
                ? null
                // SendInput returning short is a genuine queue failure, not the
                // integrity boundary: when UIPI discards input it still reports
                // success, which is why that case is caught before sending.
                : "the pointer events could not be queued",
        };
    }

    private JsonObject Drag(Params parameters, string button, string route, int? elementIndex, int? pid)
    {
        var fromX = parameters.Double("fromX");
        var fromY = parameters.Double("fromY");
        var toX = parameters.Double("toX");
        var toY = parameters.Double("toY");
        var steps = parameters.Int("steps") ?? 12;
        var durationMs = parameters.Int("durationMs") ?? 300;

        var startX = fromX ?? parameters.Double("x") ?? CurrentPoint().X;
        var startY = fromY ?? parameters.Double("y") ?? CurrentPoint().Y;
        if (elementIndex is not null)
        {
            var centre = ResolvePoint(parameters, elementIndex, pid, "drag");
            startX = centre.X;
            startY = centre.Y;
        }
        if (toX is null || toY is null)
        {
            throw CuaException.Invalid("\"toX\" and \"toY\" are required for action=drag (the destination)");
        }
        if (steps < 1) steps = 1;

        var from = RequireOnScreenPoint(startX, startY, "drag start");
        var to = RequireOnScreenPoint(toX.Value, toY.Value, "drag destination");
        // A drag presses where it starts, so that is the window whose integrity
        // decides whether any of it arrives.
        if (BlockedReasonAt(from) is { } blocked)
        {
            return new JsonObject
            {
                ["delivered"] = false,
                ["action"] = "drag",
                ["route"] = route,
                ["fromScreen"] = Json.Numbers([from.X, from.Y]),
                ["toScreen"] = Json.Numbers([to.X, to.Y]),
                ["reason"] = blocked,
            };
        }
        var (down, up) = button switch
        {
            "right" => (Native.MOUSEEVENTF_RIGHTDOWN, Native.MOUSEEVENTF_RIGHTUP),
            "middle" => (Native.MOUSEEVENTF_MIDDLEDOWN, Native.MOUSEEVENTF_MIDDLEUP),
            _ => (Native.MOUSEEVENTF_LEFTDOWN, Native.MOUSEEVENTF_LEFTUP),
        };

        if (route == "pid")
        {
            var window = Native.WindowFromPoint(new Native.POINT { X = from.X, Y = from.Y });
            if (window == IntPtr.Zero)
            {
                throw CuaException.NotFound($"no window is at ({from.X}, {from.Y}) to receive the drag");
            }
            PostPointerMessages(window, from, "down", button, 1);
            for (var step = 1; step <= steps; step++)
            {
                var ratio = (double)step / steps;
                var point = new Native.POINT
                {
                    X = (int)Math.Round(from.X + (to.X - from.X) * ratio),
                    Y = (int)Math.Round(from.Y + (to.Y - from.Y) * ratio),
                };
                PostPointerMessages(window, point, "move", button, 1);
                if (durationMs > 0) Thread.Sleep(Math.Max(1, durationMs / steps));
            }
            PostPointerMessages(window, to, "up", button, 1);
            return new JsonObject
            {
                ["delivered"] = true,
                ["action"] = "drag",
                ["route"] = "pid",
                ["fromScreen"] = Json.Numbers([from.X, from.Y]),
                ["toScreen"] = Json.Numbers([to.X, to.Y]),
                ["note"] = "Posted as window messages; the visible cursor did not move.",
            };
        }

        var actualFrom = MoveCursor(from.X, from.Y);
        Send([Mouse(down, 0)]);
        for (var step = 1; step <= steps; step++)
        {
            var ratio = (double)step / steps;
            var x = (int)Math.Round(from.X + (to.X - from.X) * ratio);
            var y = (int)Math.Round(from.Y + (to.Y - from.Y) * ratio);
            MoveCursor(x, y);
            if (durationMs > 0) Thread.Sleep(Math.Max(1, durationMs / steps));
        }
        var actualTo = MoveCursor(to.X, to.Y);
        var inserted = Send([Mouse(up, 0)]);

        return new JsonObject
        {
            ["delivered"] = inserted,
            ["action"] = "drag",
            ["route"] = "post",
            ["fromScreen"] = Json.Numbers([actualFrom.X, actualFrom.Y]),
            ["toScreen"] = Json.Numbers([actualTo.X, actualTo.Y]),
            ["reason"] = inserted ? null : "the pointer events could not be queued",
        };
    }

    private JsonObject Scroll(Params parameters, string route, int? elementIndex, int? pid)
    {
        var dx = parameters.Double("dx") ?? 0;
        var dy = parameters.Double("dy") ?? 0;
        if (dx == 0 && dy == 0)
        {
            throw CuaException.Invalid("action=scroll needs a non-zero \"dx\" or \"dy\"");
        }

        var target = ResolvePoint(parameters, elementIndex, pid, "scroll");
        if (BlockedReasonAt(target) is { } wheelBlocked)
        {
            return new JsonObject
            {
                ["delivered"] = false,
                ["action"] = "scroll",
                ["route"] = route,
                ["screenX"] = target.X,
                ["screenY"] = target.Y,
                ["dx"] = 0,
                ["dy"] = 0,
                ["reason"] = wheelBlocked,
            };
        }
        if (route == "pid")
        {
            var window = Native.WindowFromPoint(new Native.POINT { X = target.X, Y = target.Y });
            if (window == IntPtr.Zero)
            {
                throw CuaException.NotFound($"no window is at ({target.X}, {target.Y}) to receive the scroll");
            }
            PostScrollMessages(window, target, dx, dy);
            return new JsonObject
            {
                ["delivered"] = true,
                ["action"] = "scroll",
                ["route"] = "pid",
                ["screenX"] = target.X,
                ["screenY"] = target.Y,
                ["dx"] = dx,
                ["dy"] = dy,
            };
        }

        var actual = MoveCursor(target.X, target.Y);
        var events = new List<Native.INPUT>();
        // The tool describes dx/dy in pixels, the way macOS delivers them; the
        // Windows wheel is quantised into detents. One detent is three lines and
        // a line is conventionally 40 pixels, so 120 pixels is one notch — and
        // the applied amount is reported rather than the requested one.
        var appliedY = Detents(dy) * WheelPixels;
        var appliedX = Detents(dx) * WheelPixels;
        if (appliedY != 0) events.Add(Mouse(Native.MOUSEEVENTF_WHEEL, unchecked((uint)appliedY / WheelPixels * Native.WHEEL_DELTA)));
        if (appliedX != 0) events.Add(Mouse(Native.MOUSEEVENTF_HWHEEL, unchecked((uint)appliedX / WheelPixels * Native.WHEEL_DELTA)));
        var inserted = Send(events);

        return new JsonObject
        {
            ["delivered"] = inserted,
            ["action"] = "scroll",
            ["route"] = "post",
            ["screenX"] = actual.X,
            ["screenY"] = actual.Y,
            ["dx"] = appliedX,
            ["dy"] = appliedY,
            ["quantisation"] = "Windows scrolls in 120-pixel detents, so the applied delta is the nearest "
                + "whole detent to the requested one and may differ from it.",
            ["reason"] = inserted ? null : "the wheel events could not be queued",
        };
    }

    private const int WheelPixels = 120;

    private static int Detents(double pixels)
    {
        if (pixels == 0) return 0;
        var detents = (int)Math.Round(pixels / WheelPixels, MidpointRounding.AwayFromZero);
        return detents == 0 ? Math.Sign(pixels) : detents;
    }

    private static void PostPointerMessages(IntPtr window, Native.POINT screen, string action, string button, int count)
    {
        var client = screen;
        Native.ScreenToClient(window, ref client);
        var (downMessage, upMessage, pressed) = button switch
        {
            "right" => (Native.WM_RBUTTONDOWN, Native.WM_RBUTTONUP, Native.MK_RBUTTON),
            "middle" => (Native.WM_MBUTTONDOWN, Native.WM_MBUTTONUP, Native.MK_MBUTTON),
            _ => (Native.WM_LBUTTONDOWN, Native.WM_LBUTTONUP, Native.MK_LBUTTON),
        };
        var position = Native.MakeParam(client.X, client.Y);

        switch (action)
        {
            case "move":
                Native.PostMessageW(window, Native.WM_MOUSEMOVE, IntPtr.Zero, position);
                break;
            case "down":
                Native.PostMessageW(window, (uint)downMessage, pressed, position);
                break;
            case "up":
                Native.PostMessageW(window, (uint)upMessage, IntPtr.Zero, position);
                break;
            default:
                for (var index = 0; index < count; index++)
                {
                    Native.PostMessageW(window, Native.WM_MOUSEMOVE, IntPtr.Zero, position);
                    Native.PostMessageW(window, (uint)downMessage, pressed, position);
                    Native.PostMessageW(window, (uint)upMessage, IntPtr.Zero, position);
                }
                break;
        }
    }

    private static void PostScrollMessages(IntPtr window, Native.POINT screen, double dx, double dy)
    {
        var client = screen;
        Native.ScreenToClient(window, ref client);
        var position = Native.MakeParam(client.X, client.Y);
        var vertical = Detents(dy) * Native.WHEEL_DELTA;
        var horizontal = Detents(dx) * Native.WHEEL_DELTA;
        if (vertical != 0)
        {
            var data = Native.MakeParam(0, (short)vertical);
            Native.PostMessageW(window, Native.WM_MOUSEWHEEL, data, position);
        }
        if (horizontal != 0)
        {
            var data = Native.MakeParam(0, (short)horizontal);
            Native.PostMessageW(window, Native.WM_MOUSEHWHEEL, data, position);
        }
    }

    private static Native.INPUT Mouse(uint flags, uint data) => new()
    {
        Type = Native.INPUT_MOUSE,
        Data = new Native.InputUnion
        {
            Mouse = new Native.MOUSEINPUT { Flags = flags, MouseData = data },
        },
    };

    /// <summary>Move the pointer and report where it actually ended up.</summary>
    /// <remarks>
    /// An absolute <c>SendInput</c> move maps the desktop onto 0…65535, which
    /// rounds; the readback is what makes the reported coordinate true rather
    /// than intended. When the rounding is off by a pixel the exact API corrects
    /// it, and when a process has captured the mouse neither works — which is
    /// worth knowing before a click is sent.
    /// </remarks>
    private static Native.POINT MoveCursor(int x, int y)
    {
        var desktop = Discovery.Desktop();
        var width = Math.Max(desktop.Width - 1, 1);
        var height = Math.Max(desktop.Height - 1, 1);
        var normalizedX = (int)Math.Round((x - desktop.Left) * 65535.0 / width);
        var normalizedY = (int)Math.Round((y - desktop.Top) * 65535.0 / height);

        Send(
        [
            new Native.INPUT
            {
                Type = Native.INPUT_MOUSE,
                Data = new Native.InputUnion
                {
                    Mouse = new Native.MOUSEINPUT
                    {
                        Dx = normalizedX,
                        Dy = normalizedY,
                        Flags = Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK,
                    },
                },
            },
        ]);

        if (Native.GetCursorPos(out var landed) && (landed.X != x || landed.Y != y))
        {
            if (Native.SetCursorPos(x, y)) Native.GetCursorPos(out landed);
        }
        return Native.GetCursorPos(out var final) ? final : new Native.POINT { X = x, Y = y };
    }

    private static Native.POINT CurrentPoint() =>
        Native.GetCursorPos(out var point) ? point : new Native.POINT();

    /// <summary>Send a batch of input events and report whether all of them landed.</summary>
    /// <remarks>
    /// <c>SendInput</c> is all-or-nothing: it returns zero and sets
    /// <c>ERROR_ACCESS_DENIED</c> when UIPI blocks the target, which is the only
    /// failure mode worth distinguishing from a successful delivery.
    /// </remarks>
    private static bool Send(List<Native.INPUT> events)
    {
        if (events.Count == 0) return true;
        var array = events.ToArray();
        var inserted = Native.SendInput((uint)array.Length, array, System.Runtime.InteropServices.Marshal.SizeOf<Native.INPUT>());
        if (inserted != array.Length)
        {
            Program.WriteDiagnostic(
                $"SendInput delivered {inserted}/{array.Length} events (win32 error {System.Runtime.InteropServices.Marshal.GetLastWin32Error()})");
            return false;
        }
        return true;
    }

    // MARK: - Keyboard

    private static readonly string[] KeyboardActions = ["type", "key"];

    /// <summary>Text entry and named-key chords.</summary>
    public JsonObject Keyboard(Params parameters)
    {
        parameters.RejectUnknown(
            "action", "text", "key", "modifiers", "repeat", "holdMs",
            "perCharacterDelayMs", "element", "pid", "route");

        var action = parameters.Enum("action", KeyboardActions, "type");
        // Validated even though Windows has no per-process key delivery and the
        // value cannot change what happens: a mistyped route should be an error
        // here as it is for the pointer, not something silently ignored.
        _ = parameters.Enum("route", Routes);
        return action == "key" ? KeyChord(parameters) : TypeText(parameters);
    }

    private JsonObject TypeText(Params parameters)
    {
        var text = parameters.RequiredString("text");
        var delay = parameters.Int("perCharacterDelayMs") ?? 0;
        var elementIndex = parameters.Int("element");
        var pid = parameters.Int("pid");
        if (delay < 0) throw CuaException.Invalid("\"perCharacterDelayMs\" must not be negative");

        AutomationElement? target = null;
        if (elementIndex is not null) (target, _) = ResolveElement(elementIndex.Value, pid);

        // Refused before anything is focused or typed. Focusing first would
        // change what the user sees for an action that cannot work anyway, and
        // the keystrokes would be discarded without a trace.
        if (target is not null && !ElementProcessReachable(target))
        {
            return TextRefused(
                $"element #{elementIndex} belongs to a process running with administrator rights, and this "
                + "engine does not. Windows discards input sent from a lower integrity level to a higher one "
                + "and reports nothing, so the text was not sent rather than being reported as delivered. "
                + "Run the harness with administrator rights to reach such windows.");
        }

        var focused = false;
        if (elementIndex is not null)
        {
            try
            {
                target!.SetFocus();
                focused = true;
                // UIA's SetFocus is asynchronous with respect to the target
                // application's own message loop; without a pause the first
                // characters can arrive before the field owns the caret.
                Thread.Sleep(30);
            }
            catch (Exception error) when (error is ElementNotAvailableException or InvalidOperationException
                or System.Runtime.InteropServices.COMException or UnauthorizedAccessException)
            {
                throw CuaException.Failed(
                    $"element #{elementIndex} could not take focus ({error.Message}); "
                    + "re-read the tree with cua_tree and check the index still refers to a focusable control");
            }

            // Where focus actually went decides where the text goes, and asking
            // for it is not the same as getting it: Windows refuses foreground
            // changes from a process the user is not interacting with. Without
            // this check the keystrokes land in whatever window really holds the
            // focus — a different application entirely — while the result says
            // the text was delivered to the element that was named.
            var (foregroundPid, reached) = ForegroundProcess(target!);
            if (!reached)
            {
                return TextRefused(
                    $"element #{elementIndex} could not take the keyboard focus: its process is pid "
                    + $"{ElementProcessId(target!)}, but pid {foregroundPid} still holds it. Windows refuses "
                    + "foreground changes from a process the user is not interacting with, and keystrokes "
                    + "follow the foreground window — so the text was not sent rather than delivered into "
                    + "another application. Activate the window first, or use cua_element with action=setValue, "
                    + "which writes through the accessibility API and needs no focus.");
            }
        }

        // A key event follows the foreground window, so that is the window whose
        // integrity decides whether any of it arrives.
        if (KeyboardBlockedReason() is { } blocked) return TextRefused(blocked);

        // One event pair per UTF-16 code unit, which is what the KEYEVENTF_UNICODE
        // payload carries. A surrogate pair therefore goes out as two pairs, in
        // order, and reassembles in the target — this is how an emoji or a CJK
        // character is typed on a keyboard layout that has no key for it.
        var delivered = true;
        var batch = new List<Native.INPUT>();
        var characters = CountCharacters(text);
        var inBatch = 0;
        foreach (var unit in text)
        {
            batch.Add(Unicode(unit, up: false));
            batch.Add(Unicode(unit, up: true));
            inBatch++;
            // The delay is per character, so the batch is drained once its
            // worth of delay has been spent: one SendInput for a handful of
            // characters instead of one per character, with the pause that the
            // caller asked for still observed.
            if (delay > 0 && inBatch >= 8)
            {
                if (!Send(batch)) { delivered = false; break; }
                batch.Clear();
                Thread.Sleep(delay * inBatch);
                inBatch = 0;
            }
        }
        if (delivered && batch.Count > 0)
        {
            if (!Send(batch)) delivered = false;
            else if (delay > 0) Thread.Sleep(delay * inBatch);
        }

        return new JsonObject
        {
            ["delivered"] = delivered && characters > 0,
            ["characters"] = characters,
            // Windows has no per-process key delivery, so `post` is the route
            // that happened whatever the caller asked for.
            ["route"] = "post",
            ["focusedElement"] = focused ? true : null,
            ["reason"] = delivered
                ? null
                : "the key events could not be queued",
        };
    }

    /// <summary>Count Unicode scalar values rather than UTF-16 units.</summary>
    /// <remarks>
    /// The tool reports "sent N character(s)" to a model that is thinking in
    /// characters. An emoji is one character and two code units, and reporting
    /// two would make the model think it had typed something it had not.
    /// </remarks>
    private static int CountCharacters(string text)
    {
        var count = 0;
        for (var index = 0; index < text.Length; index++)
        {
            count++;
            if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
            {
                index++;
            }
        }
        return count;
    }

    private static Native.INPUT Unicode(char unit, bool up) => new()
    {
        Type = Native.INPUT_KEYBOARD,
        Data = new Native.InputUnion
        {
            Keyboard = new Native.KEYBDINPUT
            {
                VirtualKey = 0,
                ScanCode = unit,
                Flags = Native.KEYEVENTF_UNICODE | (up ? Native.KEYEVENTF_KEYUP : 0),
            },
        },
    };

    private JsonObject KeyChord(Params parameters)
    {
        var rawKey = parameters.RequiredString("key");
        var holdMs = parameters.Int("holdMs") ?? 15;
        var repeat = parameters.Int("repeat") ?? 1;
        if (repeat < 1) throw CuaException.Invalid("\"repeat\" must be at least 1");
        if (holdMs < 0) throw CuaException.Invalid("\"holdMs\" must not be negative");

        // A model will sometimes write the whole chord into `key` ("cmd+shift+t")
        // even though the tool has a separate `modifiers` array. Splitting here
        // means that spelling does the right thing instead of failing.
        var parts = rawKey.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) throw CuaException.Invalid("\"key\" must name a key");

        var requested = new List<string>();
        if (parameters.StringArray("modifiers") is { } explicitModifiers) requested.AddRange(explicitModifiers);
        for (var index = 0; index < parts.Length - 1; index++) requested.Add(parts[index]);
        var baseName = parts[^1];

        var modifiers = new List<KeyDefinition>();
        var reportedModifiers = new List<string>();
        foreach (var name in requested)
        {
            if (Keymap.IsUnsupportedModifier(name))
            {
                return KeyFailure(baseName, reportedModifiers, repeat,
                    $"\"{name}\" is a macOS-only modifier and has no Windows equivalent");
            }
            if (Keymap.CanonicalModifier(name) is not { } canonical)
            {
                return KeyFailure(baseName, reportedModifiers, repeat, $"\"{name}\" is not a modifier");
            }
            if (!Keymap.Lookup(canonical).HasValue)
            {
                return KeyFailure(baseName, reportedModifiers, repeat, $"no key for modifier \"{name}\"");
            }
            modifiers.Add(Keymap.Lookup(canonical)!.Value);
            reportedModifiers.Add(canonical);
        }

        if (Keymap.Lookup(baseName) is not { } key)
        {
            return KeyFailure(baseName, reportedModifiers, repeat,
                $"\"{baseName}\" is not a key this engine knows; use a letter, a digit, "
                + "return, tab, space, delete, escape, left/right/up/down, home, end, pageup, pagedown, "
                + "f1–f24, a keypad_* name, or a modifier");
        }

        // A chord goes to whatever holds the keyboard focus, so the same
        // integrity question applies as for typed text.
        if (KeyboardBlockedReason() is { } blocked)
        {
            return new JsonObject
            {
                ["delivered"] = false,
                ["key"] = baseName.ToLowerInvariant(),
                ["modifiers"] = Json.Strings(reportedModifiers),
                ["repeat"] = repeat,
                ["reason"] = blocked,
            };
        }

        var delivered = true;
        for (var pass = 0; pass < repeat && delivered; pass++)
        {
            var events = new List<Native.INPUT>(modifiers.Count * 2 + 2);
            foreach (var modifier in modifiers) events.Add(Key(modifier, up: false));
            events.Add(Key(key, up: false));
            if (!Send(events)) { delivered = false; break; }
            if (holdMs > 0) Thread.Sleep(holdMs);

            var releases = new List<Native.INPUT>(modifiers.Count + 1) { Key(key, up: true) };
            for (var index = modifiers.Count - 1; index >= 0; index--) releases.Add(Key(modifiers[index], up: true));
            if (!Send(releases)) { delivered = false; break; }
            if (pass + 1 < repeat) Thread.Sleep(15);
        }

        return new JsonObject
        {
            ["delivered"] = delivered,
            ["key"] = baseName.ToLowerInvariant(),
            ["modifiers"] = Json.Strings(reportedModifiers),
            ["repeat"] = repeat,
            ["reason"] = delivered
                ? null
                : "the key events could not be queued",
        };
    }

    private static JsonObject KeyFailure(string key, List<string> modifiers, int repeat, string reason) => new()
    {
        ["delivered"] = false,
        ["key"] = key,
        ["modifiers"] = Json.Strings(modifiers),
        ["repeat"] = repeat,
        ["reason"] = reason,
    };

    private static Native.INPUT Key(KeyDefinition definition, bool up)
    {
        var flags = (up ? Native.KEYEVENTF_KEYUP : 0) | (definition.Extended ? Native.KEYEVENTF_EXTENDEDKEY : 0);
        return new Native.INPUT
        {
            Type = Native.INPUT_KEYBOARD,
            Data = new Native.InputUnion
            {
                Keyboard = new Native.KEYBDINPUT { VirtualKey = definition.VirtualKey, Flags = flags },
            },
        };
    }

    // MARK: - Point resolution

    private Native.POINT ResolvePoint(Params parameters, int? elementIndex, int? pid, string what)
    {
        if (elementIndex is not null)
        {
            var (element, _) = ResolveElement(elementIndex.Value, pid);
            var bounds = Bounds(element);
            if (bounds.Width <= 0 || bounds.Height <= 0)
            {
                throw CuaException.Failed(
                    $"element #{elementIndex} has no readable screen rectangle, so it cannot be clicked by "
                    + "coordinate; use cua_element with action=press, which does not need one");
            }
            return new Native.POINT
            {
                X = bounds.Left + bounds.Width / 2,
                Y = bounds.Top + bounds.Height / 2,
            };
        }

        var x = parameters.Double("x");
        var y = parameters.Double("y");
        if (x is null && y is null) return CurrentPoint();
        if (x is null || y is null)
        {
            throw CuaException.Invalid($"\"x\" and \"y\" must be given together for {what}");
        }
        return RequireOnScreenPoint(x.Value, y.Value, what);
    }

    private static Native.POINT RequireOnScreenPoint(double x, double y, string what)
    {
        var display = Discovery.RequireDisplayAt(x, y);
        _ = display;
        return new Native.POINT { X = (int)Math.Round(x), Y = (int)Math.Round(y) };
    }

    /// <summary>An element's bounding rectangle in physical screen pixels.</summary>
    private static Native.RECT Bounds(AutomationElement element)
    {
        var rectangle = element.Current.BoundingRectangle;
        if (rectangle.IsEmpty) return default;
        return new Native.RECT
        {
            Left = (int)Math.Round(rectangle.Left),
            Top = (int)Math.Round(rectangle.Top),
            Right = (int)Math.Round(rectangle.Right),
            Bottom = (int)Math.Round(rectangle.Bottom),
        };
    }

    // MARK: - The integrity boundary

    /// <summary>
    /// Why input cannot reach the window at a point, or null when it can.
    /// </summary>
    /// <remarks>
    /// A point that is on no window at all is not a refusal: the click would go
    /// to the desktop, which is a legitimate thing to click.
    /// </remarks>
    private static string? BlockedReasonAt(Native.POINT point)
    {
        var window = Native.WindowFromPoint(point);
        if (window == IntPtr.Zero) return null;
        return BlockedReason(window, $"the window at ({point.X}, {point.Y})");
    }

    /// <summary>Why input cannot reach a window, or null when it can.</summary>
    private static string? BlockedReason(IntPtr window, string what)
    {
        if (Discovery.CanSendInputTo(window)) return null;
        return $"{what} belongs to a process running with administrator rights, and this engine does not. "
            + "Windows discards input sent from a lower integrity level to a higher one and reports nothing, "
            + "so the action was refused instead of being reported as delivered. "
            + "Run the harness with administrator rights to reach such windows.";
    }

    /// <summary>A refusal shaped like a success, so the caller sees what did not happen.</summary>
    private static JsonObject Refused(
        string action, string route, Native.POINT target, string button, int? clickCount, string reason) => new()
    {
        ["delivered"] = false,
        ["action"] = action,
        ["route"] = route,
        ["screenX"] = target.X,
        ["screenY"] = target.Y,
        ["clickCount"] = clickCount,
        ["button"] = button,
        ["reason"] = reason,
    };

    /// <summary>
    /// The refusal reason for a keyboard event, or null when it can be delivered.
    /// </summary>
    /// <remarks>
    /// A key event follows the keyboard focus, and on Windows that means the
    /// foreground window — there is no per-process delivery to aim somewhere
    /// else. So the foreground window is the one that has to be reachable, and
    /// this is asked after any focus has been set rather than before: what
    /// matters is where focus ended up, not where it was asked to go.
    /// </remarks>
    private static string? KeyboardBlockedReason()
    {
        if (Discovery.CanSendInputTo(Native.GetForegroundWindow())) return null;
        return "the window that has keyboard focus belongs to a process running with administrator rights, "
            + "and this engine does not. Windows discards input sent from a lower integrity level to a "
            + "higher one and reports nothing, so the text was not sent rather than being reported as "
            + "delivered. Run the harness with administrator rights, or target a window this engine is "
            + "allowed to reach.";
    }

    /// <summary>A refusal from the text path, shaped like the success it is not.</summary>
    private static JsonObject TextRefused(string reason) => new()
    {
        ["delivered"] = false,
        ["characters"] = 0,
        ["route"] = "post",
        ["reason"] = reason,
    };

    /// <summary>An element's process id, or 0 when it cannot be read.</summary>
    private static int ElementProcessId(AutomationElement element)
    {
        try
        {
            return element.Current.ProcessId;
        }
        catch (Exception error) when (IsUiaFailure(error))
        {
            return 0;
        }
    }

    /// <summary>Whether input can reach the process an element belongs to.</summary>
    private static bool ElementProcessReachable(AutomationElement element)
    {
        var pid = ElementProcessId(element);
        return pid != 0 && Discovery.CanSendInputToProcess((uint)pid);
    }

    /// <summary>
    /// The foreground process, and whether it is the one an element belongs to.
    /// </summary>
    private static (int ProcessId, bool Reached) ForegroundProcess(AutomationElement element)
    {
        var foreground = Native.GetForegroundWindow();
        if (foreground == IntPtr.Zero) return (0, false);
        Native.GetWindowThreadProcessId(foreground, out uint owner);
        var target = ElementProcessId(element);
        return ((int)owner, target != 0 && (int)owner == target);
    }
}
