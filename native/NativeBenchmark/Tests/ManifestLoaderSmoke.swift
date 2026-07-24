import Foundation

@main
struct ManifestLoaderSmoke {
    static func main() throws {
        guard CommandLine.arguments.count == 3 else {
            throw SmokeError.usage
        }

        let material = try loadNativeManifest(
            url: URL(fileURLWithPath: CommandLine.arguments[1])
        )
        try expect(material.api == "metal", "material API")
        try expect(material.surfaceMode == "basecolor", "material surface mode")
        try expect(material.rows.allSatisfy { $0.renderScale == 1 }, "material render scale")
        try expect(material.rows.count == 5, "material run count")
        try expect(
            material.rows.allSatisfy { $0.surfaceMode == "basecolor" },
            "material row surface mode"
        )

        let flat = try loadNativeManifest(
            url: URL(fileURLWithPath: CommandLine.arguments[2])
        )
        try expect(flat.surfaceMode == "flat", "flat surface mode")
        try expect(flat.rows.count == 5, "flat run count")

        print("Manifest loader smoke passed: 5 material runs and 5 flat runs")
    }

    private static func expect(_ condition: Bool, _ name: String) throws {
        guard condition else { throw SmokeError.failed(name) }
    }
}

enum SmokeError: Error, LocalizedError {
    case usage
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: ManifestLoaderSmoke <material-plan.json> <flat-plan.json>"
        case .failed(let name):
            return "Manifest loader smoke failed: \(name)"
        }
    }
}
