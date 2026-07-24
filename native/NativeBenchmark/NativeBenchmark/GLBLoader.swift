// GLBLoader.swift
// Loads both benchmark surface paths from one GLB:
//   - flat: all primitives merged into one normalized position/index mesh
//   - basecolor: normalized source primitives with UVs, factors, and textures

import Foundation
import simd

struct GLBMesh {
    var positions: [Float]
    var indices: [UInt32]
    var materialPrimitives: [GLBMaterialPrimitive]
    var textures: [Int: GLBTexture]
    var meta: GLBMeta
}

struct GLBMaterialPrimitive {
    var positions: [Float]
    var texcoords: [Float]
    var indices: [UInt32]
    var baseColorFactor: SIMD4<Float>
    var baseColorTextureIndex: Int?
}

struct GLBTexture {
    var data: Data
    var sampler: GLBSampler
}

struct GLBSampler {
    var magFilter: Int?
    var minFilter: Int?
    var wrapS: Int
    var wrapT: Int

    static let gltfDefault = GLBSampler(
        magFilter: nil,
        minFilter: nil,
        wrapS: 10497,
        wrapT: 10497
    )
}

struct GLBMeta {
    var vertexCount: Int
    var indexCount: Int
    var triangleCount: Int
    var primitiveCount: Int
    var texturedPrimitiveCount: Int
    var materialCount: Int
    var imageCount: Int
    var textureCount: Int
    var materialTextureCount: Int
    var normScale: Float
    var normCenter: SIMD3<Float>
    var normMaxDim: Float
}

private struct RawPrimitive {
    var positions: [Float]
    var texcoords: [Float]
    var indices: [UInt32]
    var materialIndex: Int?
}

private struct Normalization {
    var scale: Float
    var center: SIMD3<Float>
    var maxDim: Float
}

enum GLBError: Error, LocalizedError {
    case badMagic
    case unsupportedVersion(UInt32)
    case missingChunk(String)
    case missingAccessor(Int)
    case unsupportedComponentType(UInt32)
    case unsupportedAccessorType(String)
    case boundsOutOfRange
    case noGeometry
    case invalidImage(Int)

    var errorDescription: String? {
        switch self {
        case .badMagic: return "The selected file is not a valid GLB."
        case .unsupportedVersion(let version): return "Unsupported GLB version \(version)."
        case .missingChunk(let name): return "GLB is missing its \(name) chunk."
        case .missingAccessor(let index): return "GLB accessor \(index) is missing."
        case .unsupportedComponentType(let type): return "Unsupported GLB component type \(type)."
        case .unsupportedAccessorType(let type): return "Unsupported GLB accessor type \(type)."
        case .boundsOutOfRange: return "GLB buffer data is out of range."
        case .noGeometry: return "GLB contains no benchmark geometry."
        case .invalidImage(let index): return "GLB image \(index) cannot be loaded."
        }
    }
}

func loadGLBMesh(data: Data) throws -> GLBMesh {
    let (gltf, bin) = try parseGLB(data: data)
    let rawPrimitives = try collectPrimitives(gltf: gltf, bin: bin)
    guard !rawPrimitives.isEmpty else { throw GLBError.noGeometry }

    let (rawMergedPositions, mergedIndices) = mergePrimitives(rawPrimitives)
    let normalization = calculateNormalization(rawMergedPositions)
    let normalizedPositions = normalize(rawMergedPositions, using: normalization)
    let materialPrimitives = buildMaterialPrimitives(
        rawPrimitives,
        gltf: gltf,
        normalization: normalization
    )
    let requiredTextures = Set(materialPrimitives.compactMap(\.baseColorTextureIndex))
    let textures = try loadTextures(
        requiredTextureIndices: requiredTextures,
        gltf: gltf,
        bin: bin
    )

    let materials = gltf["materials"] as? [[String: Any]] ?? []
    let images = gltf["images"] as? [[String: Any]] ?? []
    let allTextures = gltf["textures"] as? [[String: Any]] ?? []
    let meta = GLBMeta(
        vertexCount: normalizedPositions.count / 3,
        indexCount: mergedIndices.count,
        triangleCount: mergedIndices.count / 3,
        primitiveCount: materialPrimitives.count,
        texturedPrimitiveCount: materialPrimitives.filter {
            guard let textureIndex = $0.baseColorTextureIndex else { return false }
            return textures[textureIndex] != nil
        }.count,
        materialCount: materials.count,
        imageCount: images.count,
        textureCount: allTextures.count,
        materialTextureCount: textures.count,
        normScale: normalization.scale,
        normCenter: normalization.center,
        normMaxDim: normalization.maxDim
    )

    return GLBMesh(
        positions: normalizedPositions,
        indices: mergedIndices,
        materialPrimitives: materialPrimitives,
        textures: textures,
        meta: meta
    )
}

private func parseGLB(data: Data) throws -> ([String: Any], Data) {
    guard data.count >= 12 else { throw GLBError.badMagic }

    let magic = try data.readU32(at: 0)
    let version = try data.readU32(at: 4)
    guard magic == 0x46546C67 else { throw GLBError.badMagic }
    guard version == 2 else { throw GLBError.unsupportedVersion(version) }

    var offset = 12
    var jsonData: Data?
    var binData: Data?

    while offset + 8 <= data.count {
        let chunkLength = Int(try data.readU32(at: offset))
        let chunkType = try data.readU32(at: offset + 4)
        offset += 8
        guard chunkLength >= 0, offset + chunkLength <= data.count else {
            throw GLBError.boundsOutOfRange
        }
        let chunk = data.subdata(in: offset ..< offset + chunkLength)
        offset += chunkLength
        if chunkType == 0x4E4F534A {
            jsonData = chunk
        } else if chunkType == 0x004E4942 {
            binData = chunk
        }
    }

    guard let jsonChunk = jsonData else { throw GLBError.missingChunk("JSON") }
    guard let binChunk = binData else { throw GLBError.missingChunk("BIN") }
    guard let gltf = try JSONSerialization.jsonObject(with: jsonChunk) as? [String: Any] else {
        throw GLBError.missingChunk("valid JSON")
    }
    return (gltf, binChunk)
}

private func collectPrimitives(gltf: [String: Any], bin: Data) throws -> [RawPrimitive] {
    let meshes = gltf["meshes"] as? [[String: Any]] ?? []
    let accessors = gltf["accessors"] as? [[String: Any]] ?? []
    let bufferViews = gltf["bufferViews"] as? [[String: Any]] ?? []
    var result: [RawPrimitive] = []

    for mesh in meshes {
        for primitive in mesh["primitives"] as? [[String: Any]] ?? [] {
            let attributes = primitive["attributes"] as? [String: Any] ?? [:]
            guard let positionAccessor = attributes["POSITION"] as? Int else { continue }

            let positions = try readAccessorAsFloats(
                accessorIndex: positionAccessor,
                accessors: accessors,
                bufferViews: bufferViews,
                bin: bin
            )
            let vertexCount = positions.count / 3
            guard vertexCount > 0 else { continue }

            let texcoords: [Float]
            if let uvAccessor = attributes["TEXCOORD_0"] as? Int {
                texcoords = try readAccessorAsFloats(
                    accessorIndex: uvAccessor,
                    accessors: accessors,
                    bufferViews: bufferViews,
                    bin: bin
                )
            } else {
                texcoords = [Float](repeating: 0, count: vertexCount * 2)
            }

            let indices: [UInt32]
            if let indexAccessor = primitive["indices"] as? Int {
                indices = try readAccessorAsUInt32(
                    accessorIndex: indexAccessor,
                    accessors: accessors,
                    bufferViews: bufferViews,
                    bin: bin
                )
            } else {
                indices = (0 ..< vertexCount).map(UInt32.init)
            }

            result.append(RawPrimitive(
                positions: positions,
                texcoords: texcoords.count == vertexCount * 2
                    ? texcoords
                    : [Float](repeating: 0, count: vertexCount * 2),
                indices: indices,
                materialIndex: primitive["material"] as? Int
            ))
        }
    }
    return result
}

private func mergePrimitives(_ primitives: [RawPrimitive]) -> ([Float], [UInt32]) {
    var positions: [Float] = []
    var indices: [UInt32] = []
    var baseVertex: UInt32 = 0

    for primitive in primitives {
        positions.append(contentsOf: primitive.positions)
        indices.append(contentsOf: primitive.indices.map { $0 + baseVertex })
        baseVertex += UInt32(primitive.positions.count / 3)
    }
    return (positions, indices)
}

private func calculateNormalization(_ positions: [Float]) -> Normalization {
    var minValue = SIMD3<Float>(repeating: .infinity)
    var maxValue = SIMD3<Float>(repeating: -.infinity)

    for index in stride(from: 0, to: positions.count, by: 3) {
        let point = SIMD3<Float>(
            positions[index],
            positions[index + 1],
            positions[index + 2]
        )
        minValue = simd_min(minValue, point)
        maxValue = simd_max(maxValue, point)
    }

    let center = (minValue + maxValue) / 2
    let dimensions = maxValue - minValue
    let maxDim = max(dimensions.x, max(dimensions.y, dimensions.z))
    return Normalization(
        scale: maxDim > 0 ? 1 / maxDim : 1,
        center: center,
        maxDim: maxDim
    )
}

private func normalize(_ positions: [Float], using normalization: Normalization) -> [Float] {
    var result = [Float](repeating: 0, count: positions.count)
    for index in stride(from: 0, to: positions.count, by: 3) {
        result[index] = (positions[index] - normalization.center.x) * normalization.scale
        result[index + 1] = (positions[index + 1] - normalization.center.y) * normalization.scale
        result[index + 2] = (positions[index + 2] - normalization.center.z) * normalization.scale
    }
    return result
}

private func buildMaterialPrimitives(
    _ rawPrimitives: [RawPrimitive],
    gltf: [String: Any],
    normalization: Normalization
) -> [GLBMaterialPrimitive] {
    let materials = gltf["materials"] as? [[String: Any]] ?? []

    return rawPrimitives.map { primitive in
        let material: [String: Any]
        if let index = primitive.materialIndex, materials.indices.contains(index) {
            material = materials[index]
        } else {
            material = [:]
        }

        let pbr = material["pbrMetallicRoughness"] as? [String: Any] ?? [:]
        let factorValues = pbr["baseColorFactor"] as? [NSNumber] ?? []
        let factor = SIMD4<Float>(
            factorValues.indices.contains(0) ? factorValues[0].floatValue : 1,
            factorValues.indices.contains(1) ? factorValues[1].floatValue : 1,
            factorValues.indices.contains(2) ? factorValues[2].floatValue : 1,
            factorValues.indices.contains(3) ? factorValues[3].floatValue : 1
        )
        let textureInfo = pbr["baseColorTexture"] as? [String: Any]
        let textureIndex = textureInfo?["index"] as? Int

        return GLBMaterialPrimitive(
            positions: normalize(primitive.positions, using: normalization),
            texcoords: primitive.texcoords,
            indices: primitive.indices,
            baseColorFactor: factor,
            baseColorTextureIndex: textureIndex
        )
    }
}

private func loadTextures(
    requiredTextureIndices: Set<Int>,
    gltf: [String: Any],
    bin: Data
) throws -> [Int: GLBTexture] {
    let textures = gltf["textures"] as? [[String: Any]] ?? []
    let images = gltf["images"] as? [[String: Any]] ?? []
    let samplers = gltf["samplers"] as? [[String: Any]] ?? []
    let bufferViews = gltf["bufferViews"] as? [[String: Any]] ?? []
    var result: [Int: GLBTexture] = [:]

    for textureIndex in requiredTextureIndices {
        guard textures.indices.contains(textureIndex) else { continue }
        let texture = textures[textureIndex]
        guard let sourceIndex = texture["source"] as? Int,
              images.indices.contains(sourceIndex)
        else { continue }

        let image = images[sourceIndex]
        guard let viewIndex = image["bufferView"] as? Int,
              bufferViews.indices.contains(viewIndex)
        else { throw GLBError.invalidImage(sourceIndex) }
        let view = bufferViews[viewIndex]
        let offset = view["byteOffset"] as? Int ?? 0
        let length = view["byteLength"] as? Int ?? 0
        guard offset >= 0, length > 0, offset + length <= bin.count else {
            throw GLBError.boundsOutOfRange
        }

        let sampler: GLBSampler
        if let samplerIndex = texture["sampler"] as? Int,
           samplers.indices.contains(samplerIndex) {
            let source = samplers[samplerIndex]
            sampler = GLBSampler(
                magFilter: source["magFilter"] as? Int,
                minFilter: source["minFilter"] as? Int,
                wrapS: source["wrapS"] as? Int ?? 10497,
                wrapT: source["wrapT"] as? Int ?? 10497
            )
        } else {
            sampler = .gltfDefault
        }

        result[textureIndex] = GLBTexture(
            data: bin.subdata(in: offset ..< offset + length),
            sampler: sampler
        )
    }
    return result
}

private func readAccessorAsFloats(
    accessorIndex: Int,
    accessors: [[String: Any]],
    bufferViews: [[String: Any]],
    bin: Data
) throws -> [Float] {
    guard accessors.indices.contains(accessorIndex) else {
        throw GLBError.missingAccessor(accessorIndex)
    }
    let accessor = accessors[accessorIndex]
    guard let count = accessor["count"] as? Int,
          let type = accessor["type"] as? String,
          let componentValue = accessor["componentType"] as? Int,
          let viewIndex = accessor["bufferView"] as? Int,
          bufferViews.indices.contains(viewIndex)
    else { throw GLBError.missingAccessor(accessorIndex) }

    let components: Int
    switch type {
    case "SCALAR": components = 1
    case "VEC2": components = 2
    case "VEC3": components = 3
    case "VEC4": components = 4
    default: throw GLBError.unsupportedAccessorType(type)
    }

    let componentType = UInt32(componentValue)
    let componentBytes = try bytesPerComponent(componentType)
    let view = bufferViews[viewIndex]
    let byteOffset = (view["byteOffset"] as? Int ?? 0)
        + (accessor["byteOffset"] as? Int ?? 0)
    let byteStride = view["byteStride"] as? Int ?? componentBytes * components
    let normalized = accessor["normalized"] as? Bool ?? false
    var result: [Float] = []
    result.reserveCapacity(count * components)

    for element in 0 ..< count {
        let elementOffset = byteOffset + element * byteStride
        for component in 0 ..< components {
            result.append(try readFloat(
                bin,
                offset: elementOffset + component * componentBytes,
                componentType: componentType,
                normalized: normalized
            ))
        }
    }
    return result
}

private func readAccessorAsUInt32(
    accessorIndex: Int,
    accessors: [[String: Any]],
    bufferViews: [[String: Any]],
    bin: Data
) throws -> [UInt32] {
    guard accessors.indices.contains(accessorIndex) else {
        throw GLBError.missingAccessor(accessorIndex)
    }
    let accessor = accessors[accessorIndex]
    guard let count = accessor["count"] as? Int,
          let componentValue = accessor["componentType"] as? Int,
          let viewIndex = accessor["bufferView"] as? Int,
          bufferViews.indices.contains(viewIndex)
    else { throw GLBError.missingAccessor(accessorIndex) }

    let componentType = UInt32(componentValue)
    let componentBytes = try bytesPerComponent(componentType)
    let view = bufferViews[viewIndex]
    let byteOffset = (view["byteOffset"] as? Int ?? 0)
        + (accessor["byteOffset"] as? Int ?? 0)
    let byteStride = view["byteStride"] as? Int ?? componentBytes

    return try (0 ..< count).map { element in
        try readUInt32(
            bin,
            offset: byteOffset + element * byteStride,
            componentType: componentType
        )
    }
}

private func bytesPerComponent(_ type: UInt32) throws -> Int {
    switch type {
    case 5120, 5121: return 1
    case 5122, 5123: return 2
    case 5125, 5126: return 4
    default: throw GLBError.unsupportedComponentType(type)
    }
}

private func readFloat(
    _ data: Data,
    offset: Int,
    componentType: UInt32,
    normalized: Bool
) throws -> Float {
    switch componentType {
    case 5126:
        return try data.readUnaligned(at: offset, as: Float.self)
    case 5121:
        let value = try data.readByte(at: offset)
        return normalized ? Float(value) / 255 : Float(value)
    case 5123:
        let value: UInt16 = try data.readUnaligned(at: offset, as: UInt16.self)
        return normalized ? Float(value) / 65535 : Float(value)
    case 5120:
        let value = Int8(bitPattern: try data.readByte(at: offset))
        return normalized ? max(Float(value) / 127, -1) : Float(value)
    case 5122:
        let raw: UInt16 = try data.readUnaligned(at: offset, as: UInt16.self)
        let value = Int16(bitPattern: raw)
        return normalized ? max(Float(value) / 32767, -1) : Float(value)
    default:
        throw GLBError.unsupportedComponentType(componentType)
    }
}

private func readUInt32(
    _ data: Data,
    offset: Int,
    componentType: UInt32
) throws -> UInt32 {
    switch componentType {
    case 5125:
        return try data.readUnaligned(at: offset, as: UInt32.self)
    case 5123:
        let value: UInt16 = try data.readUnaligned(at: offset, as: UInt16.self)
        return UInt32(value)
    case 5121:
        return UInt32(try data.readByte(at: offset))
    default:
        throw GLBError.unsupportedComponentType(componentType)
    }
}

private extension Data {
    func readByte(at offset: Int) throws -> UInt8 {
        guard indices.contains(offset) else { throw GLBError.boundsOutOfRange }
        return self[offset]
    }

    func readU32(at offset: Int) throws -> UInt32 {
        try readUnaligned(at: offset, as: UInt32.self)
    }

    func readUnaligned<T>(at offset: Int, as type: T.Type) throws -> T {
        let size = MemoryLayout<T>.size
        guard offset >= 0, offset + size <= count else {
            throw GLBError.boundsOutOfRange
        }
        return withUnsafeBytes { rawBuffer in
            let source = rawBuffer.baseAddress!.advanced(by: offset)
            let storage = UnsafeMutableRawPointer.allocate(
                byteCount: size,
                alignment: MemoryLayout<T>.alignment
            )
            defer { storage.deallocate() }
            storage.copyMemory(from: source, byteCount: size)
            return storage.load(as: T.self)
        }
    }
}
