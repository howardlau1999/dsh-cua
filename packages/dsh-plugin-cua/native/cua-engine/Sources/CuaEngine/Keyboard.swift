import Foundation
import CoreGraphics
import ApplicationServices

/// Synthetic keyboard input through Quartz event taps.
enum Keyboard {
    /// Modifier flag for a name, or `nil` when the name is not a modifier.
    static func modifierFlag(_ name: String) -> CGEventFlags? {
        switch name.lowercased() {
        case "cmd", "command", "meta", "super": return .maskCommand
        case "shift": return .maskShift
        case "alt", "option", "opt": return .maskAlternate
        case "ctrl", "control": return .maskControl
        case "fn", "function": return .maskSecondaryFn
        default: return nil
        }
    }

    /// Virtual keycodes for named keys.
    ///
    /// These are ANSI positional codes: they identify a key's physical location,
    /// so the character produced depends on the active keyboard layout. That is
    /// the right semantic for shortcuts (`cmd+s` must be the S key) and the wrong
    /// one for text, which is why text entry goes through
    /// `CGEventKeyboardSetUnicodeString` instead.
    static let namedKeys: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "=": 24,
        "9": 25, "7": 26, "minus": 27, "-": 27, "8": 28, "0": 29,
        "rightbracket": 30, "]": 30, "o": 31, "u": 32, "leftbracket": 33, "[": 33,
        "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "quote": 39, "'": 39,
        "k": 40, "semicolon": 41, ";": 41, "backslash": 42, "\\": 42,
        "comma": 43, ",": 43, "slash": 44, "/": 44, "n": 45, "m": 46, "period": 47, ".": 47,
        "tab": 48, "space": 49, " ": 49, "grave": 50, "`": 50, "delete": 51, "backspace": 51,
        "escape": 53, "esc": 53,
        // Modifiers are keys too: pressing and releasing shift on its own is how
        // a caller extends a selection, and a name that only worked as a
        // modifier would make that impossible.
        "cmd": 55, "command": 55, "meta": 55, "super": 55,
        "rightcmd": 54, "rightcommand": 54,
        "shift": 56, "rightshift": 60,
        "capslock": 57,
        "alt": 58, "option": 58, "opt": 58, "rightalt": 61, "rightoption": 61,
        "ctrl": 59, "control": 59, "rightctrl": 62, "rightcontrol": 62,
        "fn": 63, "function": 63,
        "f17": 64, "keypad_decimal": 65, "keypad_multiply": 67, "keypad_plus": 69,
        "keypad_clear": 71, "keypad_divide": 75, "keypad_enter": 76, "keypad_minus": 78,
        "f18": 79, "f19": 80, "keypad_equals": 81, "keypad_0": 82, "keypad_1": 83,
        "keypad_2": 84, "keypad_3": 85, "keypad_4": 86, "keypad_5": 87, "keypad_6": 88,
        "keypad_7": 89, "f20": 90, "keypad_8": 91, "keypad_9": 92,
        "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101,
        "f11": 103, "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111,
        "f15": 113, "help": 114, "home": 115, "pageup": 116, "page_up": 116,
        "forwarddelete": 117, "f4": 118, "end": 119, "f2": 120, "f1": 122,
        "pagedown": 121, "page_down": 121,
        "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
        "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
    ]

    /// Spellings that mean a key already in `namedKeys`.
    ///
    /// The canonical table uses short macOS names (`down`, `pageup`), but callers
    /// reach for `downarrow` or `pgdn` just as often. Accepting the obvious
    /// aliases costs nothing; rejecting them costs a wasted round trip.
    static let keyAliases: [String: String] = [
        "downarrow": "down", "uparrow": "up", "leftarrow": "left", "rightarrow": "right",
        "arrowdown": "down", "arrowup": "up", "arrowleft": "left", "arrowright": "right",
        "pgup": "pageup", "pgdn": "pagedown", "pagedn": "pagedown",
        "del": "delete", "backspacekey": "backspace", "escapekey": "escape",
        "escape_key": "escape", "returnkey": "return", "spacebar": "space",
        "caps_lock": "capslock", "return_key": "return",
    ]

    /// Resolve a key name case-insensitively, also accepting single characters.
    static func keyCode(_ name: String) -> CGKeyCode? {
        let normalized = name.lowercased()
        if let code = namedKeys[normalized] { return code }
        if let canonical = keyAliases[normalized], let code = namedKeys[canonical] { return code }
        // "KeyA"/"Digit1" style names are common in other automation stacks.
        if normalized.hasPrefix("key"), normalized.count == 4 {
            return namedKeys[String(normalized.dropFirst(3))]
        }
        if normalized.hasPrefix("digit"), normalized.count == 6 {
            return namedKeys[String(normalized.dropFirst(5))]
        }
        return nil
    }

    /// Press and release one key with optional modifiers held.
    ///
    /// Modifier state is applied to both the down and up events, and released
    /// afterwards, so a failed mid-chord sequence cannot leave a modifier stuck
    /// down on the user's machine.
    static func chord(key: String, modifiers: [String], repeatCount: Int, holdMs: Int) -> JSONValue {
        guard let code = keyCode(key) else {
            return jsonObject(["delivered": .bool(false), "reason": .string("unknown key \"\(key)\"")])
        }
        var flags: CGEventFlags = []
        var unknown: [JSONValue] = []
        for name in modifiers {
            if let flag = modifierFlag(name) {
                flags.insert(flag)
            } else {
                unknown.append(.string(name))
            }
        }
        if !unknown.isEmpty {
            return jsonObject([
                "delivered": .bool(false),
                "reason": .string("unknown modifier"),
                "unknownModifiers": .array(unknown),
            ])
        }

        let source = CGEventSource(stateID: .hidSystemState)
        for _ in 0..<max(1, repeatCount) {
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
                return jsonObject(["delivered": .bool(false), "reason": .string("could not create key events")])
            }
            down.flags = flags
            up.flags = flags
            down.post(tap: .cghidEventTap)
            if holdMs > 0 { Thread.sleep(forTimeInterval: Double(holdMs) / 1000.0) }
            up.post(tap: .cghidEventTap)
        }
        return jsonObject([
            "delivered": .bool(true),
            "key": .string(key),
            "keyCode": .int(Int(code)),
            "modifiers": .array(modifiers.map { JSONValue.string($0) }),
            "repeat": .int(max(1, repeatCount)),
        ])
    }

    /// Type literal text.
    ///
    /// Unicode is delivered through the event's unicode payload rather than by
    /// mapping characters to keycodes, which is what makes CJK, emoji, and
    /// accented text work on any keyboard layout.
    static func typeText(_ text: String, perCharacterDelayMs: Int, route: Pointer.Route, pid: pid_t?) -> JSONValue {
        guard !text.isEmpty else {
            return jsonObject(["delivered": .bool(true), "characters": .int(0)])
        }
        let source = CGEventSource(stateID: .hidSystemState)
        var delivered = 0
        // Cluster-safe iteration: an emoji or combining sequence must arrive whole.
        for character in text {
            let units = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                return jsonObject(["delivered": .bool(false), "characters": .int(delivered)])
            }
            units.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
            post(down, route: route, pid: pid)
            post(up, route: route, pid: pid)
            delivered += 1
            if perCharacterDelayMs > 0 {
                Thread.sleep(forTimeInterval: Double(perCharacterDelayMs) / 1000.0)
            }
        }
        return jsonObject([
            "delivered": .bool(true),
            "characters": .int(delivered),
            "route": .string(route.rawValue),
        ])
    }

    /// Insert text through the accessibility API instead of the event stream.
    ///
    /// Slower to fail but far faster to run, and it works in a background window
    /// without focus. Only text fields that expose a settable `AXValue` accept
    /// it, which is why it is an explicit choice rather than the default.
    static func insertText(_ text: String, into element: AXUIElement?) -> JSONValue {
        guard let element else {
            return jsonObject([
                "inserted": .bool(false),
                "reason": .string("no focused element was found to insert into"),
            ])
        }
        let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
        guard error == .success else {
            return jsonObject([
                "inserted": .bool(false),
                "reason": .string("the focused element rejected AXValue: \(error.readableName)"),
            ])
        }
        return jsonObject(["inserted": .bool(true), "characters": .int(text.count)])
    }

    private static func post(_ event: CGEvent, route: Pointer.Route, pid: pid_t?) {
        switch route {
        case .post:
            event.post(tap: .cghidEventTap)
        case .pid:
            if let pid {
                event.postToPid(pid)
            } else {
                event.post(tap: .cghidEventTap)
            }
        }
    }
}
