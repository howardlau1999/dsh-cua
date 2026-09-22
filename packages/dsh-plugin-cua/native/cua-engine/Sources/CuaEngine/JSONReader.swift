import Foundation

/// A typed reader over one request's `params` object. Every accessor names the
/// offending parameter and the type it expected, so a malformed call from the
/// plugin surfaces as an actionable message rather than a crash.
public struct ParamsReader {
    private let members: [String: JSONValue]
    private let method: String

    public init(_ value: JSONValue?, method: String) throws {
        self.method = method
        switch value {
        case .none, .some(.null):
            self.members = [:]
        case .some(.object(let members)):
            self.members = members
        case .some(let other):
            throw JSONFault(reason: "\(method): params must be an object, received \(other.typeName)")
        }
    }

    /// The raw value of one optional member.
    public func raw(_ key: String) -> JSONValue? {
        members[key]
    }

    /// Whether the caller supplied a member at all.
    ///
    /// Key presence, not truthiness: `element: 0` and `x: 0` are real requests,
    /// and testing the value instead of the key silently drops them.
    public func has(_ key: String) -> Bool {
        members[key] != nil
    }

    /// Whether the caller supplied a non-null member.
    public func supplies(_ key: String) -> Bool {
        if let value = members[key], value != .null { return true }
        return false
    }

    private func require(_ key: String) throws -> JSONValue {
        guard let value = members[key], value != .null else {
            throw JSONFault(reason: "\(method): missing required parameter \"\(key)\"")
        }
        return value
    }

    private func mismatch(_ key: String, _ expected: String, _ actual: JSONValue) -> JSONFault {
        JSONFault(reason: "\(method): parameter \"\(key)\" must be \(expected), received \(actual.typeName)")
    }

    /// A required string member.
    public func string(_ key: String) throws -> String {
        let value = try require(key)
        guard let text = value.stringValue else { throw mismatch(key, "a string", value) }
        return text
    }

    /// A required non-empty string member.
    public func nonEmptyString(_ key: String) throws -> String {
        let text = try string(key)
        guard !text.isEmpty else {
            throw JSONFault(reason: "\(method): parameter \"\(key)\" must not be empty")
        }
        return text
    }

    /// An optional string member.
    public func string(_ key: String, default fallback: String) -> String {
        members[key]?.stringValue ?? fallback
    }

    /// An optional string member that stays absent when omitted.
    public func optionalString(_ key: String) -> String? {
        members[key]?.stringValue
    }

    /// A required integral member.
    public func int(_ key: String) throws -> Int {
        let value = try require(key)
        guard let number = value.intValue else { throw mismatch(key, "an integer", value) }
        return number
    }

    /// An optional integral member, absent when omitted or null.
    public func optionalInt(_ key: String) -> Int? {
        members[key]?.intValue
    }

    /// An integral member with a default and an inclusive range check.
    public func int(_ key: String, default fallback: Int, in range: ClosedRange<Int>) throws -> Int {
        guard let value = members[key], value != .null else { return fallback }
        guard let number = value.intValue else { throw mismatch(key, "an integer", value) }
        guard range.contains(number) else {
            throw JSONFault(reason: "\(method): parameter \"\(key)\" must be within \(range.lowerBound)...\(range.upperBound), received \(number)")
        }
        return number
    }

    /// A required numeric member.
    public func double(_ key: String) throws -> Double {
        let value = try require(key)
        guard let number = value.doubleValue else { throw mismatch(key, "a number", value) }
        return number
    }

    /// An optional numeric member, absent when omitted or null.
    public func optionalDouble(_ key: String) -> Double? {
        members[key]?.doubleValue
    }

    /// An optional numeric member with a default and an inclusive range check.
    public func double(_ key: String, default fallback: Double, in range: ClosedRange<Double>) throws -> Double {
        guard let value = members[key], value != .null else { return fallback }
        guard let number = value.doubleValue else { throw mismatch(key, "a number", value) }
        guard range.contains(number) else {
            throw JSONFault(reason: "\(method): parameter \"\(key)\" must be within \(range.lowerBound)...\(range.upperBound), received \(number)")
        }
        return number
    }

    /// A boolean member with a default.
    public func bool(_ key: String, default fallback: Bool) -> Bool {
        members[key]?.boolValue ?? fallback
    }

    /// A string-list member accepting either a single string or an array.
    public func stringList(_ key: String) throws -> [String] {
        guard let value = members[key], value != .null else { return [] }
        switch value {
        case .string(let single):
            return [single]
        case .array(let items):
            return try items.map { item in
                guard let text = item.stringValue else { throw mismatch(key, "an array of strings", item) }
                return text
            }
        default:
            throw mismatch(key, "a string or an array of strings", value)
        }
    }
}

// MARK: - Result construction

/// Build a JSON object from literal members, dropping `nil` values so optional
/// details never reach the wire as explicit nulls.
public func jsonObject(_ members: [String: JSONValue?]) -> JSONValue {
    var result: [String: JSONValue] = [:]
    result.reserveCapacity(members.count)
    for (key, value) in members {
        if let value { result[key] = value }
    }
    return .object(result)
}

/// Build a JSON object where every member is present.
///
/// A separate overload rather than one signature with a default: keeping the two
/// element types distinct stops the type checker from having to solve a large
/// literal against `JSONValue?` in both directions, which on the bigger result
/// objects is slow enough to hit the expression-complexity limit.
public func jsonObject(_ members: [String: JSONValue]) -> JSONValue {
    .object(members)
}

public extension JSONValue {
    static func of(_ value: String) -> JSONValue { .string(value) }
    static func of(_ value: Int) -> JSONValue { .int(value) }
    static func of(_ value: Double) -> JSONValue { .double(value) }
    static func of(_ value: Bool) -> JSONValue { .bool(value) }
    static func of(_ values: [JSONValue]) -> JSONValue { .array(values) }
}

public extension Optional where Wrapped == String {
    /// A present-or-null JSON field. Protocol results keep every documented key
    /// present so a caller can distinguish "absent" from "no value" without
    /// branching on `in` checks.
    var jsonField: JSONValue { self.map { JSONValue.string($0) } ?? .null }
}

public extension Optional where Wrapped == Int {
    /// A present-or-null JSON field.
    var jsonField: JSONValue { self.map { JSONValue.int($0) } ?? .null }
}

public extension Optional where Wrapped == Double {
    /// A present-or-null JSON field.
    var jsonField: JSONValue { self.map { JSONValue.double($0) } ?? .null }
}
