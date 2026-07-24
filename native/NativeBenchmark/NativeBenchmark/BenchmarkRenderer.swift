// BenchmarkRenderer.swift
// Metal renderer for separate flat and unlit base-color benchmark workloads.

import Metal
import MetalKit
import simd

enum BenchmarkSurfaceMode: String {
    case flat
    case basecolor
}

enum BenchmarkRendererError: Error, LocalizedError {
    case invalidSurfaceMode(String)
    case materialSceneUnavailable
    case textureDecodeFailed(Int)

    var errorDescription: String? {
        switch self {
        case .invalidSurfaceMode(let mode): return "Unsupported surface mode: \(mode)"
        case .materialSceneUnavailable: return "Material mode requires material primitives."
        case .textureDecodeFailed(let index): return "Failed to decode material texture \(index)."
        }
    }
}

private struct MaterialGPUPrimitive {
    var positionBuffer: MTLBuffer
    var texcoordBuffer: MTLBuffer
    var indexBuffer: MTLBuffer
    var indexCount: Int
    var baseColorFactor: SIMD4<Float>
    var texture: MTLTexture
    var sampler: MTLSamplerState
}

class BenchmarkRenderer: NSObject, MTKViewDelegate {
    let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private var flatPipelineState: MTLRenderPipelineState!
    private var materialPipelineState: MTLRenderPipelineState!
    private var depthState: MTLDepthStencilState!

    private var flatVertexBuffer: MTLBuffer?
    private var flatIndexBuffer: MTLBuffer?
    private var flatIndexCount = 0
    private var materialPrimitives: [MaterialGPUPrimitive] = []
    private var whiteTexture: MTLTexture!
    private var defaultSampler: MTLSamplerState!

    private var instanceBuffer: MTLBuffer?
    private var instanceCount = 0
    private(set) var surfaceMode: BenchmarkSurfaceMode = .flat
    private(set) var loadedMeshMeta: GLBMeta?

    enum Phase { case idle, warmup, measuring, cooldown, done }
    private var phase: Phase = .idle
    private var warmupMs: Double = 500
    private var durationMs: Double = 10_000
    private var minFrames = 30
    private var phaseStartTime: Double = 0
    private var lastFrameTime: Double?
    private var frameTimes: [Double] = []
    private var measureStartWall: Double = 0
    private var measureEndWall: Double = 0

    var onTrialComplete: (([Double], Double) -> Void)?
    private var viewProjMatrix = matrix_identity_float4x4

    init(mtkView: MTKView) {
        device = mtkView.device!
        commandQueue = device.makeCommandQueue()!
        super.init()

        buildPipelines(mtkView: mtkView)
        buildDepthState()
        whiteTexture = makeWhiteTexture()
        defaultSampler = makeSampler(.gltfDefault)
    }

    func uploadMesh(_ mesh: GLBMesh) throws {
        flatVertexBuffer = makeBuffer(mesh.positions)
        flatIndexBuffer = makeBuffer(mesh.indices)
        flatIndexCount = mesh.indices.count
        loadedMeshMeta = mesh.meta

        let textureLoader = MTKTextureLoader(device: device)
        var gpuTextures: [Int: MTLTexture] = [:]
        var gpuSamplers: [Int: MTLSamplerState] = [:]

        for (textureIndex, texture) in mesh.textures {
            let usesMipmaps = needsMipmaps(texture.sampler.minFilter)
            let options: [MTKTextureLoader.Option: Any] = [
                .SRGB: false,
                .origin: MTKTextureLoader.Origin.topLeft,
                .generateMipmaps: usesMipmaps,
            ]
            guard let gpuTexture = try? textureLoader.newTexture(
                data: texture.data,
                options: options
            ) else {
                throw BenchmarkRendererError.textureDecodeFailed(textureIndex)
            }
            gpuTextures[textureIndex] = gpuTexture
            gpuSamplers[textureIndex] = makeSampler(texture.sampler)
        }

        materialPrimitives = try mesh.materialPrimitives.map { primitive in
            guard let positionBuffer = makeBuffer(primitive.positions),
                  let texcoordBuffer = makeBuffer(primitive.texcoords),
                  let indexBuffer = makeBuffer(primitive.indices)
            else {
                throw BenchmarkRendererError.materialSceneUnavailable
            }

            let texture: MTLTexture
            let sampler: MTLSamplerState
            if let textureIndex = primitive.baseColorTextureIndex,
               let resolvedTexture = gpuTextures[textureIndex] {
                texture = resolvedTexture
                sampler = gpuSamplers[textureIndex] ?? defaultSampler
            } else {
                texture = whiteTexture
                sampler = defaultSampler
            }

            return MaterialGPUPrimitive(
                positionBuffer: positionBuffer,
                texcoordBuffer: texcoordBuffer,
                indexBuffer: indexBuffer,
                indexCount: primitive.indices.count,
                baseColorFactor: primitive.baseColorFactor,
                texture: texture,
                sampler: sampler
            )
        }
    }

    func setSurfaceMode(_ rawMode: String) throws {
        guard let mode = BenchmarkSurfaceMode(rawValue: rawMode.lowercased()) else {
            throw BenchmarkRendererError.invalidSurfaceMode(rawMode)
        }
        if mode == .basecolor && materialPrimitives.isEmpty {
            throw BenchmarkRendererError.materialSceneUnavailable
        }
        surfaceMode = mode
    }

    func setInstances(n: Int, layout: String = "xrwall", spacing: Float = 0.35) {
        let offsets: [InstanceOffset]
        switch layout {
        case "xrwall": offsets = xrwallOffsets(n: n, spacing: spacing)
        case "grid": offsets = gridOffsets(n: n, spacing: spacing)
        default: offsets = lineOffsets(n: n, spacing: spacing)
        }

        instanceCount = n
        instanceBuffer = makeBuffer(offsets)
    }

    func startTrial(
        warmupMs: Double = 500,
        durationMs: Double = 10_000,
        minFrames: Int = 30
    ) {
        self.warmupMs = warmupMs
        self.durationMs = durationMs
        self.minFrames = minFrames
        frameTimes = []
        lastFrameTime = nil
        phaseStartTime = CACurrentMediaTime() * 1000
        phase = .warmup
    }

    func updateCamera(drawableSize: CGSize) {
        let aspect = Float(drawableSize.width / drawableSize.height)
        let fieldOfView: Float = 60 * .pi / 180
        let near: Float = 0.1
        let far: Float = 100
        let focal = 1 / tan(fieldOfView / 2)

        var projection = matrix_identity_float4x4
        projection.columns.0 = SIMD4<Float>(focal / aspect, 0, 0, 0)
        projection.columns.1 = SIMD4<Float>(0, focal, 0, 0)
        projection.columns.2 = SIMD4<Float>(
            0,
            0,
            (far + near) / (near - far),
            -1
        )
        projection.columns.3 = SIMD4<Float>(
            0,
            0,
            (2 * far * near) / (near - far),
            0
        )

        var view = matrix_identity_float4x4
        view.columns.3 = SIMD4<Float>(0, 0, -2, 1)
        viewProjMatrix = projection * view
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        updateCamera(drawableSize: size)
    }

    func draw(in view: MTKView) {
        let now = CACurrentMediaTime() * 1000

        switch phase {
        case .idle, .done:
            renderFrame(in: view)
            return
        case .warmup:
            if now - phaseStartTime >= warmupMs {
                phase = .measuring
                measureStartWall = now
                lastFrameTime = nil
            }
            renderFrame(in: view)
            return
        case .cooldown:
            renderFrame(in: view)
            return
        case .measuring:
            break
        }

        if let last = lastFrameTime {
            frameTimes.append(now - last)
        }
        lastFrameTime = now
        renderFrame(in: view)

        let elapsed = now - measureStartWall
        if elapsed >= durationMs && frameTimes.count >= minFrames {
            measureEndWall = now
            phase = .done
            onTrialComplete?(frameTimes, measureEndWall - measureStartWall)
        }
    }

    private func renderFrame(in view: MTKView) {
        guard let drawable = view.currentDrawable,
              let descriptor = view.currentRenderPassDescriptor,
              let instanceBuffer,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor)
        else { return }

        encoder.setDepthStencilState(depthState)
        switch surfaceMode {
        case .flat:
            drawFlat(encoder: encoder, instanceBuffer: instanceBuffer)
        case .basecolor:
            drawMaterial(encoder: encoder, instanceBuffer: instanceBuffer)
        }

        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    private func drawFlat(encoder: MTLRenderCommandEncoder, instanceBuffer: MTLBuffer) {
        guard let vertexBuffer = flatVertexBuffer,
              let indexBuffer = flatIndexBuffer
        else { return }

        encoder.setRenderPipelineState(flatPipelineState)
        encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
        var viewProjection = viewProjMatrix
        encoder.setVertexBytes(
            &viewProjection,
            length: MemoryLayout<float4x4>.size,
            index: 1
        )
        encoder.setVertexBuffer(instanceBuffer, offset: 0, index: 2)
        encoder.drawIndexedPrimitives(
            type: .triangle,
            indexCount: flatIndexCount,
            indexType: .uint32,
            indexBuffer: indexBuffer,
            indexBufferOffset: 0,
            instanceCount: instanceCount
        )
    }

    private func drawMaterial(encoder: MTLRenderCommandEncoder, instanceBuffer: MTLBuffer) {
        encoder.setRenderPipelineState(materialPipelineState)
        var viewProjection = viewProjMatrix
        encoder.setVertexBytes(
            &viewProjection,
            length: MemoryLayout<float4x4>.size,
            index: 1
        )
        encoder.setVertexBuffer(instanceBuffer, offset: 0, index: 2)

        for primitive in materialPrimitives {
            encoder.setVertexBuffer(primitive.positionBuffer, offset: 0, index: 0)
            encoder.setVertexBuffer(primitive.texcoordBuffer, offset: 0, index: 3)
            var factor = primitive.baseColorFactor
            encoder.setFragmentBytes(
                &factor,
                length: MemoryLayout<SIMD4<Float>>.size,
                index: 0
            )
            encoder.setFragmentTexture(primitive.texture, index: 0)
            encoder.setFragmentSamplerState(primitive.sampler, index: 0)
            encoder.drawIndexedPrimitives(
                type: .triangle,
                indexCount: primitive.indexCount,
                indexType: .uint32,
                indexBuffer: primitive.indexBuffer,
                indexBufferOffset: 0,
                instanceCount: instanceCount
            )
        }
    }

    private func buildPipelines(mtkView: MTKView) {
        let library = device.makeDefaultLibrary()!

        let flatVertexDescriptor = MTLVertexDescriptor()
        flatVertexDescriptor.attributes[0].format = .float3
        flatVertexDescriptor.attributes[0].offset = 0
        flatVertexDescriptor.attributes[0].bufferIndex = 0
        flatVertexDescriptor.layouts[0].stride = MemoryLayout<Float>.size * 3
        flatVertexDescriptor.layouts[0].stepFunction = .perVertex

        let flatDescriptor = MTLRenderPipelineDescriptor()
        flatDescriptor.vertexFunction = library.makeFunction(name: "flat_vertex")
        flatDescriptor.fragmentFunction = library.makeFunction(name: "flat_fragment")
        flatDescriptor.vertexDescriptor = flatVertexDescriptor
        flatDescriptor.colorAttachments[0].pixelFormat = mtkView.colorPixelFormat
        flatDescriptor.depthAttachmentPixelFormat = mtkView.depthStencilPixelFormat
        flatPipelineState = try! device.makeRenderPipelineState(descriptor: flatDescriptor)

        let materialVertexDescriptor = MTLVertexDescriptor()
        materialVertexDescriptor.attributes[0].format = .float3
        materialVertexDescriptor.attributes[0].offset = 0
        materialVertexDescriptor.attributes[0].bufferIndex = 0
        materialVertexDescriptor.layouts[0].stride = MemoryLayout<Float>.size * 3
        materialVertexDescriptor.layouts[0].stepFunction = .perVertex
        materialVertexDescriptor.attributes[1].format = .float2
        materialVertexDescriptor.attributes[1].offset = 0
        materialVertexDescriptor.attributes[1].bufferIndex = 3
        materialVertexDescriptor.layouts[3].stride = MemoryLayout<Float>.size * 2
        materialVertexDescriptor.layouts[3].stepFunction = .perVertex

        let materialDescriptor = MTLRenderPipelineDescriptor()
        materialDescriptor.vertexFunction = library.makeFunction(name: "material_vertex")
        materialDescriptor.fragmentFunction = library.makeFunction(name: "material_fragment")
        materialDescriptor.vertexDescriptor = materialVertexDescriptor
        materialDescriptor.colorAttachments[0].pixelFormat = mtkView.colorPixelFormat
        materialDescriptor.depthAttachmentPixelFormat = mtkView.depthStencilPixelFormat
        materialDescriptor.colorAttachments[0].isBlendingEnabled = true
        materialDescriptor.colorAttachments[0].rgbBlendOperation = .add
        materialDescriptor.colorAttachments[0].alphaBlendOperation = .add
        materialDescriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
        materialDescriptor.colorAttachments[0].sourceAlphaBlendFactor = .sourceAlpha
        materialDescriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        materialDescriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        materialPipelineState = try! device.makeRenderPipelineState(descriptor: materialDescriptor)
    }

    private func buildDepthState() {
        let descriptor = MTLDepthStencilDescriptor()
        descriptor.depthCompareFunction = .lessEqual
        descriptor.isDepthWriteEnabled = true
        depthState = device.makeDepthStencilState(descriptor: descriptor)!
    }

    private func makeWhiteTexture() -> MTLTexture {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm,
            width: 1,
            height: 1,
            mipmapped: false
        )
        descriptor.usage = .shaderRead
        let texture = device.makeTexture(descriptor: descriptor)!
        let pixel: [UInt8] = [255, 255, 255, 255]
        pixel.withUnsafeBytes { bytes in
            texture.replace(
                region: MTLRegionMake2D(0, 0, 1, 1),
                mipmapLevel: 0,
                withBytes: bytes.baseAddress!,
                bytesPerRow: 4
            )
        }
        return texture
    }

    private func makeSampler(_ source: GLBSampler) -> MTLSamplerState {
        let descriptor = MTLSamplerDescriptor()
        descriptor.sAddressMode = addressMode(source.wrapS)
        descriptor.tAddressMode = addressMode(source.wrapT)
        descriptor.magFilter = source.magFilter == 9728 ? .nearest : .linear

        switch source.minFilter {
        case 9728, 9984, 9986:
            descriptor.minFilter = .nearest
        default:
            descriptor.minFilter = .linear
        }
        switch source.minFilter {
        case 9984, 9985:
            descriptor.mipFilter = .nearest
        case 9986, 9987:
            descriptor.mipFilter = .linear
        default:
            descriptor.mipFilter = .notMipmapped
        }
        return device.makeSamplerState(descriptor: descriptor)!
    }

    private func addressMode(_ value: Int) -> MTLSamplerAddressMode {
        switch value {
        case 33071: return .clampToEdge
        case 33648: return .mirrorRepeat
        default: return .repeat
        }
    }

    private func needsMipmaps(_ value: Int?) -> Bool {
        guard let value else { return false }
        return [9984, 9985, 9986, 9987].contains(value)
    }

    private func makeBuffer<T>(_ values: [T]) -> MTLBuffer? {
        guard !values.isEmpty else { return nil }
        return values.withUnsafeBufferPointer { buffer in
            guard let baseAddress = buffer.baseAddress else { return nil }
            return device.makeBuffer(
                bytes: baseAddress,
                length: buffer.count * MemoryLayout<T>.stride,
                options: .storageModeShared
            )
        }
    }
}
