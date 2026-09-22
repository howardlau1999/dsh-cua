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
        )
    ]
)
