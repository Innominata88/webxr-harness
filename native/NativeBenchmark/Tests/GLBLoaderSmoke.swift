import Foundation

@main
struct GLBLoaderSmoke {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            throw SmokeError.usage
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let mesh = try loadGLBMesh(data: data)

        try expect(mesh.meta.primitiveCount == 15, "primitive count")
        try expect(mesh.meta.texturedPrimitiveCount == 11, "textured primitive count")
        try expect(mesh.meta.materialCount == 15, "material count")
        try expect(mesh.meta.imageCount == 18, "image count")
        try expect(mesh.meta.textureCount == 18, "texture count")
        try expect(mesh.meta.materialTextureCount == 9, "base-color texture count")
        try expect(mesh.materialPrimitives.count == 15, "material scene count")
        try expect(mesh.positions.count / 3 == mesh.meta.vertexCount, "vertex metadata")
        try expect(mesh.indices.count == mesh.meta.indexCount, "index metadata")

        print(
            "GLB loader smoke passed:",
            "\(mesh.meta.vertexCount) vertices,",
            "\(mesh.meta.primitiveCount) primitives,",
            "\(mesh.meta.materialTextureCount) base-color textures"
        )
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
            return "Usage: GLBLoaderSmoke <asset.glb>"
        case .failed(let name):
            return "GLB loader smoke failed: \(name)"
        }
    }
}
