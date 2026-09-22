using System.Globalization;
using System.Text.Json.Nodes;

namespace CuaEngine;

/// <summary>
/// Typed, strict access to a request's <c>params</c> object.
/// </summary>
/// <remarks>
/// Strictness is the point. The plugin's own schema already validates what the
/// model is allowed to send, but the engine is also driven by hand from a shell
/// and by the smoke test, and a coordinate written as a string must fail loudly
/// rather than quietly degrade into "click the element centre" — that turns one
/// arithmetic mistake into a click somewhere else entirely.
/// </remarks>
public sealed class Params
{
    private readonly JsonObject _values;
    private readonly string _method;

    public Params(JsonNode? source, string method)
    {
        _method = method;
        switch (source)
        {
            case null:
                _values = new JsonObject();
                break;
            case JsonObject obj:
                _values = obj;
                break;
            default:
                throw CuaException.Invalid($"\"params\" for {method} must be a JSON object");
        }
    }

    /// <summary>Whether the caller supplied this key at all.</summary>
    public bool Has(string key) => _values.TryGetPropertyValue(key, out var value) && value is not null;

    private JsonNode? Raw(string key) =>
        _values.TryGetPropertyValue(key, out var value) ? value : null;

    private CuaException WrongType(string key, string expected) =>
        CuaException.Invalid($"\"{key}\" for {_method} must be {expected}");

    /// <summary>Reject any parameter name the method does not know.</summary>
    /// <remarks>
    /// Silently ignoring an unrecognised key is how a typo becomes a mystery:
    /// <c>maxdepth</c> instead of <c>maxDepth</c> would look like the engine
    /// ignored the budget. The protocol's rule is that a wrong call fails.
    /// </remarks>
    public void RejectUnknown(params string[] known)
    {
        var allowed = new HashSet<string>(known, StringComparer.Ordinal);
        foreach (var pair in _values)
        {
            if (!allowed.Contains(pair.Key))
            {
                throw CuaException.Invalid(
                    $"unknown parameter \"{pair.Key}\" for {_method}; accepted: {string.Join(", ", known)}");
            }
        }
    }

    /// <summary>Read an optional string, rejecting anything of another type.</summary>
    public string? String(string key)
    {
        var node = Raw(key);
        if (node is null) return null;
        if (node is JsonValue value && value.TryGetValue(out string? text)) return text;
        throw WrongType(key, "a string");
    }

    /// <summary>Read a required, non-empty string.</summary>
    public string RequiredString(string key) =>
        String(key) is { Length: > 0 } text
            ? text
            : throw CuaException.Invalid($"\"{key}\" is required for {_method} and must be a non-empty string");

    /// <summary>Read an optional whole number.</summary>
    public int? Int(string key)
    {
        var node = Raw(key);
        if (node is null) return null;
        if (node is JsonValue value)
        {
            if (value.TryGetValue(out int number)) return number;
            if (value.TryGetValue(out long wide))
            {
                if (wide is < int.MinValue or > int.MaxValue) throw WrongType(key, "a 32-bit integer");
                return (int)wide;
            }
            // A fractional value for a count or a limit is a caller bug, not
            // something to round on their behalf.
            if (value.TryGetValue(out double fractional))
            {
                throw CuaException.Invalid(
                    $"\"{key}\" for {_method} must be a whole number, not {fractional.ToString(CultureInfo.InvariantCulture)}");
            }
        }
        throw WrongType(key, "an integer");
    }

    /// <summary>Read an optional number, accepting integers as numbers.</summary>
    public double? Double(string key)
    {
        var node = Raw(key);
        if (node is null) return null;
        if (node is JsonValue value)
        {
            if (value.TryGetValue(out double number)) return number;
            if (value.TryGetValue(out long wide)) return wide;
        }
        throw WrongType(key, "a number");
    }

    /// <summary>Read an optional boolean.</summary>
    public bool? Bool(string key)
    {
        var node = Raw(key);
        if (node is null) return null;
        if (node is JsonValue value && value.TryGetValue(out bool flag)) return flag;
        throw WrongType(key, "a boolean");
    }

    /// <summary>Read a boolean with a default.</summary>
    public bool Bool(string key, bool fallback) => Bool(key) ?? fallback;

    /// <summary>Read an optional array of strings.</summary>
    public string[]? StringArray(string key)
    {
        var node = Raw(key);
        if (node is null) return null;
        if (node is JsonArray array)
        {
            var result = new string[array.Count];
            for (var index = 0; index < array.Count; index++)
            {
                if (array[index] is JsonValue value && value.TryGetValue(out string? text))
                {
                    result[index] = text;
                    continue;
                }
                throw CuaException.Invalid($"\"{key}[{index}]\" for {_method} must be a string");
            }
            return result;
        }
        throw WrongType(key, "an array of strings");
    }

    /// <summary>Read a required number.</summary>
    public double RequiredDouble(string key) =>
        Double(key) ?? throw CuaException.Invalid($"\"{key}\" is required for {_method} and must be a number");

    /// <summary>Read an optional value constrained to a fixed vocabulary.</summary>
    public string? Enum(string key, IReadOnlyList<string> allowed)
    {
        var text = String(key);
        if (text is null) return null;
        if (allowed.Contains(text, StringComparer.Ordinal)) return text;
        throw CuaException.Invalid(
            $"\"{key}\" for {_method} must be one of {string.Join(", ", allowed)}, not \"{text}\"");
    }

    /// <summary>Read a value constrained to a fixed vocabulary, with a default.</summary>
    public string Enum(string key, IReadOnlyList<string> allowed, string fallback) =>
        Enum(key, allowed) ?? fallback;
}
