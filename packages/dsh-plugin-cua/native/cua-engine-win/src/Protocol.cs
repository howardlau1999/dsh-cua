using System.Text.Json;
using System.Text.Json.Nodes;

namespace CuaEngine;

/// <summary>
/// Bumped whenever the wire contract changes in a way the plugin must notice.
/// </summary>
/// <remarks>Kept in lockstep with the Swift engine's <c>engineProtocolVersion</c>.</remarks>
public static class ProtocolVersion
{
    public const int Value = 1;
}

/// <summary>
/// The engine's identity, reported by <c>engine.status</c> and <c>--version</c>.
/// </summary>
public static class EngineIdentity
{
    public const string Version = "0.2.0";
}

/// <summary>
/// The protocol's error vocabulary.
/// </summary>
/// <remarks>
/// Codes are part of the contract: the plugin maps them onto stable tool
/// failures, so a new code is a protocol decision rather than a detail. The
/// Windows backend raises exactly the same six and adds no seventh.
/// </remarks>
public enum CuaErrorCode
{
    /// <summary>The request is not valid JSON, or a parameter has the wrong shape/type.</summary>
    InvalidRequest,
    /// <summary>The method name is not part of this engine's surface.</summary>
    UnknownMethod,
    /// <summary>The named target (pid, window, element, or app) does not exist.</summary>
    NotFound,
    /// <summary>The operating system is withholding something this method needs.</summary>
    PermissionDenied,
    /// <summary>The target exists but refused or could not complete the operation.</summary>
    OperationFailed,
    /// <summary>The engine is not running on the platform this build targets.</summary>
    UnsupportedPlatform,
}

/// <summary>A structured failure carried back to the caller as <c>error</c>.</summary>
public sealed class CuaException : Exception
{
    public CuaErrorCode Code { get; }

    /// <summary>Extra actionable fields, such as the settings page that unblocks it.</summary>
    public JsonObject Details { get; }

    public CuaException(CuaErrorCode code, string message, JsonObject? details = null)
        : base(message)
    {
        Code = code;
        Details = details ?? new JsonObject();
    }

    public string CodeText => Code switch
    {
        CuaErrorCode.InvalidRequest => "invalid_request",
        CuaErrorCode.UnknownMethod => "unknown_method",
        CuaErrorCode.NotFound => "not_found",
        CuaErrorCode.PermissionDenied => "permission_denied",
        CuaErrorCode.OperationFailed => "operation_failed",
        CuaErrorCode.UnsupportedPlatform => "unsupported_platform",
        _ => "operation_failed",
    };

    public static CuaException Invalid(string message) => new(CuaErrorCode.InvalidRequest, message);
    public static CuaException UnknownMethod(string message) => new(CuaErrorCode.UnknownMethod, message);
    public static CuaException NotFound(string message) => new(CuaErrorCode.NotFound, message);
    public static CuaException Failed(string message) => new(CuaErrorCode.OperationFailed, message);
    public static CuaException Unsupported(string message) => new(CuaErrorCode.UnsupportedPlatform, message);

    public static CuaException Permission(string message, string hint) =>
        new(CuaErrorCode.PermissionDenied, message, new JsonObject { ["hint"] = hint });
}

/// <summary>One decoded request line.</summary>
public sealed record EngineRequest(JsonNode? Id, string Method, JsonNode? Params)
{
    /// <summary>Decode one request line, rejecting anything without an id/method pair.</summary>
    public static EngineRequest Decode(string line)
    {
        JsonNode? parsed;
        try
        {
            parsed = JsonNode.Parse(line);
        }
        catch (JsonException error)
        {
            throw CuaException.Invalid($"request is not valid JSON: {error.Message}");
        }

        if (parsed is not JsonObject root)
        {
            throw CuaException.Invalid("request must be a JSON object");
        }
        if (!root.TryGetPropertyValue("id", out var id) || id is null)
        {
            throw CuaException.Invalid("request is missing \"id\"");
        }
        if (root["method"] is not JsonValue methodValue
            || !methodValue.TryGetValue(out string? method)
            || string.IsNullOrEmpty(method))
        {
            throw CuaException.Invalid("request is missing a non-empty \"method\"");
        }
        root.TryGetPropertyValue("params", out var parameters);
        return new EngineRequest(id, method, parameters);
    }
}

/// <summary>One response line: exactly one of <c>result</c> or <c>error</c>.</summary>
public static class EngineResponse
{
    public static string Result(JsonNode? id, JsonNode value) =>
        Json.Encode(new JsonObject { ["id"] = id?.DeepClone(), ["result"] = value });

    public static string Failure(JsonNode? id, CuaException error)
    {
        var details = (JsonObject)error.Details.DeepClone();
        details["code"] = error.CodeText;
        details["message"] = error.Message;
        return Json.Encode(new JsonObject { ["id"] = id?.DeepClone(), ["error"] = details });
    }

    /// <summary>
    /// Translate any thrown value into the protocol's error vocabulary.
    /// </summary>
    /// <remarks>
    /// A backend that let a raw <c>AutomationElement</c> COM error escape would
    /// turn "that window closed while we were reading it" into an opaque
    /// HRESULT. Everything that is not already a <see cref="CuaException"/> is
    /// either a caller mistake or an OS refusal, never a new code.
    /// </remarks>
    public static CuaException AsCuaError(Exception error) => error switch
    {
        CuaException cua => cua,
        JsonException json => CuaException.Invalid(json.Message),
        OperationCanceledException => CuaException.Failed("the operation timed out"),
        _ => CuaException.Failed($"{error.GetType().Name}: {error.Message}"),
    };
}
