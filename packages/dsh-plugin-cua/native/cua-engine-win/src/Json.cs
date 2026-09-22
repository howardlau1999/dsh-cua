using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CuaEngine;

/// <summary>
/// The engine's JSON value helpers.
/// </summary>
/// <remarks>
/// <see cref="JsonNode"/> is the DOM: it preserves member order, round-trips
/// through <c>ToJsonString</c>, and can carry an arbitrary decoded request.
/// These helpers exist so response construction reads as data rather than as
/// ceremony, and so every response goes out through one encoder.
/// </remarks>
public static class Json
{
    /// <summary>
    /// The one encoder every response uses.
    /// </summary>
    /// <remarks>
    /// <see cref="JavaScriptEncoder.Default"/> escapes everything outside
    /// ASCII. The protocol is one JSON object per line, so an unescaped newline
    /// or an unpaired surrogate smuggled in from a window title would split the
    /// stream; escaping also means the bytes on the wire are identical no matter
    /// what code page the console happens to be in.
    /// </remarks>
    public static readonly JsonSerializerOptions Options = new()
    {
        Encoder = JavaScriptEncoder.Default,
        WriteIndented = false,
    };

    /// <summary>Build an object from ordered name/value pairs, dropping nulls.</summary>
    public static JsonObject Obj(params (string Name, JsonNode? Value)[] members)
    {
        var result = new JsonObject();
        foreach (var (memberName, value) in members)
        {
            // A null member means "this field has no value here", and the
            // contract is that documented fields are present with `null` only
            // where a number is genuinely unknown. Omitting is the safer default
            // because it cannot be mistaken for a real zero.
            if (value is not null) result[memberName] = value;
        }
        return result;
    }

    /// <summary>Build an array from a sequence of values.</summary>
    public static JsonArray Arr(IEnumerable<JsonNode?> items)
    {
        var result = new JsonArray();
        foreach (var item in items) result.Add(item);
        return result;
    }

    /// <summary>Build an array of strings.</summary>
    public static JsonArray Strings(IEnumerable<string> items) =>
        Arr(items.Select(item => (JsonNode?)JsonValue.Create(item)));

    /// <summary>Build an array of numbers.</summary>
    public static JsonArray Numbers(IEnumerable<double> items) =>
        Arr(items.Select(item => (JsonNode?)JsonValue.Create(item)));

    /// <summary>Serialise one value with the protocol encoder.</summary>
    public static string Encode(JsonNode value) => value.ToJsonString(Options);
}

/// <summary>Convenience conversions so response literals stay readable.</summary>
public static class JsonNodeExtensions
{
    public static JsonNode? Node(this string? value) => value is null ? null : JsonValue.Create(value);
    public static JsonNode? Node(this bool value) => JsonValue.Create(value);
    public static JsonNode? Node(this int value) => JsonValue.Create(value);
    public static JsonNode? Node(this long value) => JsonValue.Create(value);
    public static JsonNode? Node(this double value) => JsonValue.Create(value);
}
