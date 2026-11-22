// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "DSHCore", platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "DSHCore", targets: ["DSHCore"])],
    targets: [.target(name: "DSHCore"), .testTarget(name: "DSHCoreTests", dependencies: ["DSHCore"])])
