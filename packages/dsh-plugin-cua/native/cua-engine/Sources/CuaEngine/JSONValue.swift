import Foundation

/// A lossless-JSON value. The engine's entire wire surface is expressed in this
/// type so that protocol handling stays free of `[String: Any]` casting.
public enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// The JSON `type` name used in validation errors.
    public var typeName: String {
        switch self {
        case .null: return "null"
        case .bool: return "boolean"
        case .int, .double: return "number"
        case .string: return "string"
        case .array: return "array"
        case .object: return "object"
        }
    }
}

// MARK: - Foundation bridging

public extension JSONValue {
    /// Convert to a Foundation graph accepted by `JSONSerialization`.
    var foundationValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .int(let value): return value
        case .double(let value): return value
        case .string(let value): return value
        case .array(let items): return items.map(\.foundationValue)
        case .object(let members): return members.mapValues(\.foundationValue)
        }
    }

    /// Convert a value produced by `JSONSerialization`.
    ///
    /// `NSNumber` is matched before `Bool`/`Int`/`Double`, and booleans are told
    /// apart from numbers by CoreFoundation type id rather than by a Swift cast.
    /// Casting an unbridged `NSNumber` out of an `[String: Any]` is not
    /// reliable — the same object can answer to `as? Int` and to `as? Bool`
    /// depending on bridging order — which silently turned `{"element": 1}`
    /// into a missing parameter.
    static func from(foundation value: Any) -> JSONValue {
        switch value {
        case is NSNull:
            return .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return .bool(number.boolValue)
            }
            let double = number.doubleValue
            if double.rounded() == double, double.magnitude < 9_007_199_254_740_992 {
                return .int(number.intValue)
            }
            return .double(double)
        case let value as String:
            return .string(value)
        case let value as [Any]:
            return .array(value.map(JSONValue.from(foundation:)))
        case let value as [String: Any]:
            var members: [String: JSONValue] = [:]
            members.reserveCapacity(value.count)
            for (key, member) in value {
                members[key] = JSONValue.from(foundation: member)
            }
            return .object(members)
        default:
            return .null
        }
    }

    /// Decode UTF-8 JSON text.
    static func parse(_ text: String) throws -> JSONValue {
        guard let data = text.data(using: .utf8) else {
            throw JSONFault(reason: "request is not valid UTF-8")
        }
        return try parse(data)
    }

    /// Decode one JSON document from bytes.
    static func parse(_ data: Data) throws -> JSONValue {
        let decoded: Any
        do {
            decoded = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            throw JSONFault(reason: "request is not valid JSON: \(error.localizedDescription)")
        }
        return JSONValue.from(foundation: decoded)
    }

    /// Encode as UTF-8 JSON text with deterministically sorted object keys.
    func encoded() throws -> Data {
        var options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
        if #available(macOS 13.0, *) {
            options.insert(.withoutEscapingSlashes)
        }
        return try JSONSerialization.data(withJSONObject: foundationValue, options: options)
    }
}

/// A malformed-request fault raised by the JSON reader.
public struct JSONFault: Error, Sendable {
    public let reason: String

    public init(reason: String) {
        self.reason = reason
    }
}

// MARK: - Accessors

public extension JSONValue {
    /// Read one member of an object.
    subscript(key: String) -> JSONValue? {
        guard case .object(let members) = self else { return nil }
        return members[key]
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var intValue: Int? {
        switch self {
        case .int(let value): return value
        case .double(let value) where value.rounded() == value: return Int(value)
        default: return nil
        }
    }

    var doubleValue: Double? {
        switch self {
        case .int(let value): return Double(value)
        case .double(let value): return value
        default: return nil
        }
    }

    var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    var arrayValue: [JSONValue]? {
        guard case .array(let items) = self else { return nil }
        return items
    }

    var objectValue: [String: JSONValue]? {
        guard case .object(let members) = self else { return nil }
        return members
    }
}
