// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "cua-engine",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "cua-engine",
            path: "Sources/CuaEngine",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
        // The engine's pure decision logic, tested without a desktop, a
        // permission, or a window server. This is the only part of the package
        // that can run on a CI runner, and it is where the mistakes that a real
        // screen cannot cross-check live: a coordinate flipped into the wrong
        // origin, a region clipped against the wrong rectangle, an ambiguous
        // query resolved to a background helper.
        .testTarget(
            name: "CuaEngineTests",
            dependencies: ["cua-engine"],
            path: "Tests/CuaEngineTests",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
    ]
)
