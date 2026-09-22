namespace CuaEngine.Win;

/// <summary>One key on the Windows keyboard, as a virtual-key code.</summary>
/// <param name="VirtualKey">The VK_ code sent to <c>SendInput</c>.</param>
/// <param name="Extended">Whether the key is in the extended set (arrows, Insert, keypad Enter, Win).</param>
internal readonly record struct KeyDefinition(ushort VirtualKey, bool Extended = false);

/// <summary>
/// Names to virtual keys.
/// </summary>
/// <remarks>
/// The vocabulary is the macOS engine's, because that is what the tools
/// advertise and what a model will send ("cmd+s", "return", "pageup"), plus the
/// names a Windows user would reach for instead ("enter", "escape", "win",
/// "backspace"). Accepting both is the difference between a shortcut that works
/// and a model that concludes the keyboard is broken.
/// </remarks>
internal static class Keymap
{
    private const ushort VK_BACK = 0x08;
    private const ushort VK_TAB = 0x09;
    private const ushort VK_CLEAR = 0x0C;
    private const ushort VK_RETURN = 0x0D;
    private const ushort VK_SHIFT = 0x10;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_MENU = 0x12;
    private const ushort VK_PAUSE = 0x13;
    private const ushort VK_CAPITAL = 0x14;
    private const ushort VK_ESCAPE = 0x1B;
    private const ushort VK_SPACE = 0x20;
    private const ushort VK_PRIOR = 0x21;
    private const ushort VK_NEXT = 0x22;
    private const ushort VK_END = 0x23;
    private const ushort VK_HOME = 0x24;
    private const ushort VK_LEFT = 0x25;
    private const ushort VK_UP = 0x26;
    private const ushort VK_RIGHT = 0x27;
    private const ushort VK_DOWN = 0x28;
    private const ushort VK_SELECT = 0x29;
    private const ushort VK_PRINT = 0x2A;
    private const ushort VK_EXECUTE = 0x2B;
    private const ushort VK_SNAPSHOT = 0x2C;
    private const ushort VK_INSERT = 0x2D;
    private const ushort VK_DELETE = 0x2E;
    private const ushort VK_HELP = 0x2F;
    private const ushort VK_LWIN = 0x5B;
    private const ushort VK_RWIN = 0x5C;
    private const ushort VK_APPS = 0x5D;
    private const ushort VK_SLEEP = 0x5F;
    private const ushort VK_NUMPAD0 = 0x60;
    private const ushort VK_SEPARATOR = 0x6C;
    private const ushort VK_F1 = 0x70;
    private const ushort VK_NUMLOCK = 0x90;
    private const ushort VK_SCROLL = 0x91;
    private const ushort VK_LSHIFT = 0xA0;
    private const ushort VK_RSHIFT = 0xA1;
    private const ushort VK_LCONTROL = 0xA2;
    private const ushort VK_RCONTROL = 0xA3;
    private const ushort VK_LMENU = 0xA4;
    private const ushort VK_RMENU = 0xA5;
    private const ushort VK_VOLUME_MUTE = 0xAD;
    private const ushort VK_VOLUME_DOWN = 0xAE;
    private const ushort VK_VOLUME_UP = 0xAF;
    private const ushort VK_MEDIA_NEXT_TRACK = 0xB0;
    private const ushort VK_MEDIA_PREV_TRACK = 0xB1;
    private const ushort VK_MEDIA_STOP = 0xB2;
    private const ushort VK_MEDIA_PLAY_PAUSE = 0xB3;
    private const ushort VK_BROWSER_BACK = 0xA6;
    private const ushort VK_BROWSER_FORWARD = 0xA7;
    private const ushort VK_BROWSER_REFRESH = 0xA8;
    private const ushort VK_BROWSER_STOP = 0xA9;
    private const ushort VK_BROWSER_SEARCH = 0xAA;
    private const ushort VK_BROWSER_FAVORITES = 0xAB;
    private const ushort VK_BROWSER_HOME = 0xAC;

    private static readonly Dictionary<string, KeyDefinition> Table = Build();

    /// <summary>Resolve a key name, or null when the name is not a key.</summary>
    public static KeyDefinition? Lookup(string name)
    {
        var key = name.Trim().ToLowerInvariant();
        if (key.Length == 0) return null;
        if (Table.TryGetValue(key, out var definition)) return definition;
        // A single character outside the table is still a key: accept it by its
        // virtual-key code so an unusual layout name does not dead-end.
        if (key.Length == 1)
        {
            var character = char.ToUpperInvariant(key[0]);
            if (character is >= 'A' and <= 'Z' or >= '0' and <= '9') return new KeyDefinition(character);
        }
        return null;
    }

    /// <summary>The canonical name a modifier is reported as.</summary>
    public static string? CanonicalModifier(string name) => name.Trim().ToLowerInvariant() switch
    {
        "cmd" or "command" or "super" or "meta" or "win" or "windows" or "lwin" or "left_win" => "win",
        "rwin" or "right_win" => "win",
        "shift" or "lshift" or "left_shift" => "shift",
        "rshift" or "right_shift" => "shift",
        "ctrl" or "control" or "lctrl" or "left_ctrl" => "ctrl",
        "rctrl" or "right_ctrl" => "ctrl",
        "alt" or "option" or "lalt" or "left_alt" => "alt",
        "ralt" or "right_alt" or "altgr" => "alt",
        _ => null,
    };

    /// <summary>
    /// Names accepted as modifiers that have no Windows equivalent.
    /// </summary>
    /// <remarks>
    /// The tools advertise <c>fn</c> because macOS has it. Failing with a reason
    /// is better than dropping it: a chord that silently loses a modifier does
    /// something other than what was asked.
    /// </remarks>
    public static bool IsUnsupportedModifier(string name) =>
        name.Trim().ToLowerInvariant() is "fn" or "function" or "globe";

    private static Dictionary<string, KeyDefinition> Build()
    {
        var table = new Dictionary<string, KeyDefinition>(StringComparer.Ordinal);

        void Add(KeyDefinition definition, params string[] names)
        {
            foreach (var name in names) table[name] = definition;
        }

        for (var letter = 'a'; letter <= 'z'; letter++)
        {
            table[letter.ToString()] = new KeyDefinition(char.ToUpperInvariant(letter));
        }
        for (var digit = '0'; digit <= '9'; digit++)
        {
            table[digit.ToString()] = new KeyDefinition(digit);
        }

        Add(new KeyDefinition(VK_RETURN), "return", "enter", "linefeed");
        Add(new KeyDefinition(VK_TAB), "tab");
        Add(new KeyDefinition(VK_SPACE), "space", "spacebar");
        // macOS `delete` is the key above Return, which Windows calls Backspace.
        Add(new KeyDefinition(VK_BACK), "delete", "backspace", "back_space");
        Add(new KeyDefinition(VK_DELETE, Extended: true), "forward_delete", "forwarddelete", "del", "fdel");
        Add(new KeyDefinition(VK_ESCAPE), "escape", "esc");
        // The arrow and page keys carry the aliases the macOS engine accepts as
        // well as the Windows-flavoured ones. A model learns these names from one
        // shared tool description, and that description advertises both spellings,
        // so a name that works on one platform has to work on the other.
        Add(new KeyDefinition(VK_LEFT, Extended: true), "left", "arrowleft", "arrow_left", "leftarrow");
        Add(new KeyDefinition(VK_RIGHT, Extended: true), "right", "arrowright", "arrow_right", "rightarrow");
        Add(new KeyDefinition(VK_UP, Extended: true), "up", "arrowup", "arrow_up", "uparrow");
        Add(new KeyDefinition(VK_DOWN, Extended: true), "down", "arrowdown", "arrow_down", "downarrow");
        Add(new KeyDefinition(VK_HOME, Extended: true), "home");
        Add(new KeyDefinition(VK_END, Extended: true), "end");
        Add(new KeyDefinition(VK_PRIOR, Extended: true), "pageup", "page_up", "prior", "pgup");
        Add(new KeyDefinition(VK_NEXT, Extended: true), "pagedown", "page_down", "next", "pgdn", "pagedn");
        Add(new KeyDefinition(VK_INSERT, Extended: true), "insert", "help_insert");
        Add(new KeyDefinition(VK_HELP), "help");
        Add(new KeyDefinition(VK_SELECT), "select");
        Add(new KeyDefinition(VK_CLEAR), "clear");
        Add(new KeyDefinition(VK_PRINT), "print");
        Add(new KeyDefinition(VK_EXECUTE), "execute");
        Add(new KeyDefinition(VK_SNAPSHOT, Extended: true), "printscreen", "print_screen", "snapshot");
        Add(new KeyDefinition(VK_PAUSE), "pause", "break");
        Add(new KeyDefinition(VK_CAPITAL), "capslock", "caps_lock", "capital");
        Add(new KeyDefinition(VK_NUMLOCK, Extended: true), "numlock", "num_lock");
        Add(new KeyDefinition(VK_SCROLL), "scrolllock", "scroll_lock");
        Add(new KeyDefinition(VK_APPS, Extended: true), "apps", "menu", "contextmenu", "context_menu");
        Add(new KeyDefinition(VK_SLEEP), "sleep");

        for (var index = 1; index <= 24; index++)
        {
            table[$"f{index}"] = new KeyDefinition((ushort)(VK_F1 + index - 1));
        }

        // Modifiers, when pressed on their own or as the base key of a chord.
        Add(new KeyDefinition(VK_LWIN, Extended: true), "cmd", "command", "super", "meta", "win", "windows", "lwin");
        Add(new KeyDefinition(VK_RWIN, Extended: true), "rwin");
        Add(new KeyDefinition(VK_LSHIFT), "shift", "lshift");
        Add(new KeyDefinition(VK_RSHIFT), "rshift");
        Add(new KeyDefinition(VK_LCONTROL), "ctrl", "control", "lctrl");
        Add(new KeyDefinition(VK_RCONTROL, Extended: true), "rctrl");
        Add(new KeyDefinition(VK_LMENU), "alt", "option", "lalt");
        Add(new KeyDefinition(VK_RMENU, Extended: true), "ralt", "altgr", "option_right");

        // Keypad, under the macOS engine's names.
        for (var index = 0; index <= 9; index++)
        {
            table[$"keypad_{index}"] = new KeyDefinition((ushort)(VK_NUMPAD0 + index));
            table[$"numpad{index}"] = new KeyDefinition((ushort)(VK_NUMPAD0 + index));
        }
        Add(new KeyDefinition(0x6A), "keypad_multiply", "keypad_multiplication");
        Add(new KeyDefinition(0x6B), "keypad_plus", "keypad_plus_sign");
        Add(new KeyDefinition(VK_SEPARATOR), "keypad_comma", "keypad_separator");
        Add(new KeyDefinition(0x6D), "keypad_minus", "keypad_hyphen");
        Add(new KeyDefinition(0x6E), "keypad_decimal", "keypad_period", "keypad_dot");
        Add(new KeyDefinition(0x6F), "keypad_divide", "keypad_division", "keypad_slash");
        Add(new KeyDefinition(VK_RETURN, Extended: true), "keypad_enter", "keypad_return");
        Add(new KeyDefinition(VK_CLEAR), "keypad_clear");
        Add(new KeyDefinition(0x92), "keypad_equal", "keypad_equals");

        Add(new KeyDefinition(VK_VOLUME_MUTE, Extended: true), "volume_mute", "mute");
        Add(new KeyDefinition(VK_VOLUME_DOWN, Extended: true), "volume_down");
        Add(new KeyDefinition(VK_VOLUME_UP, Extended: true), "volume_up");
        Add(new KeyDefinition(VK_MEDIA_NEXT_TRACK, Extended: true), "media_next", "next_track");
        Add(new KeyDefinition(VK_MEDIA_PREV_TRACK, Extended: true), "media_previous", "media_prev", "previous_track");
        Add(new KeyDefinition(VK_MEDIA_STOP, Extended: true), "media_stop", "stop_track");
        Add(new KeyDefinition(VK_MEDIA_PLAY_PAUSE, Extended: true), "media_play_pause", "play_pause");
        Add(new KeyDefinition(VK_BROWSER_BACK, Extended: true), "browser_back");
        Add(new KeyDefinition(VK_BROWSER_FORWARD, Extended: true), "browser_forward");
        Add(new KeyDefinition(VK_BROWSER_REFRESH, Extended: true), "browser_refresh");
        Add(new KeyDefinition(VK_BROWSER_STOP, Extended: true), "browser_stop");
        Add(new KeyDefinition(VK_BROWSER_SEARCH, Extended: true), "browser_search");
        Add(new KeyDefinition(VK_BROWSER_FAVORITES, Extended: true), "browser_favorites");
        Add(new KeyDefinition(VK_BROWSER_HOME, Extended: true), "browser_home");

        // Punctuation, by its Windows virtual-key code. The tools steer models
        // towards cua_key for shortcuts rather than cua_type, so these matter.
        Add(new KeyDefinition(0xBA), "semicolon", ";");
        Add(new KeyDefinition(0xBB), "equal", "equals", "=");
        Add(new KeyDefinition(0xBC), "comma", ",");
        Add(new KeyDefinition(0xBD), "minus", "hyphen", "-");
        Add(new KeyDefinition(0xBE), "period", "fullstop", ".");
        Add(new KeyDefinition(0xBF), "slash", "forward_slash", "/");
        Add(new KeyDefinition(0xC0), "backtick", "grave", "`");
        Add(new KeyDefinition(0xDB), "leftbracket", "left_bracket", "[");
        Add(new KeyDefinition(0xDC), "backslash", "\\");
        Add(new KeyDefinition(0xDD), "rightbracket", "right_bracket", "]");
        Add(new KeyDefinition(0xDE), "quote", "apostrophe", "'");

        return table;
    }
}
