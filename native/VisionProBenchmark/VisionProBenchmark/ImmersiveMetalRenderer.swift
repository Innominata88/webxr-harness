import ARKit
import CompositorServices
import Foundation
import Metal
import MetalKit
import simd

private struct MaterialGPUPrimitive {
    var positionBuffer: MTLBuffer
    var texcoordBuffer: MTLBuffer
    var indexBuffer: MTLBuffer
    var indexCount: Int
    var baseColorFactor: SIMD4<Float>
    var texture: MTLTexture
    var sampler: MTLSamplerState
}

private struct AnchorPlacement {
    var x: Float
    var z: Float
    var yaw: Float
}

enum ImmersiveRendererError: LocalizedError {
    case missingModel
    case missingCommandQueue
    case missingShader(String)
    case pipeline(String)
    case textureDecode(Int)
    case materialSceneUnavailable

    var errorDescription: String? {
        switch self {
        case .missingModel:
            return "The bundled Spider-Man GLB is missing."
        case .missingCommandQueue:
            return "Metal could not create a command queue."
        case .missingShader(let name):
            return "Metal shader \(name) is missing."
        case .pipeline(let reason):
            return "Metal pipeline creation failed: \(reason)"
        case .textureDecode(let index):
            return "Material texture \(index) could not be decoded."
        case .materialSceneUnavailable:
            return "The GLB did not contain a material scene."
        }
    }
}

final class ImmersiveMetalRenderer {
    private let layerRenderer: LayerRenderer
    private let runtime: BenchmarkRuntime
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let arSession = ARKitSession()
    private let worldTracking = WorldTrackingProvider()

    private var pipelineState: MTLRenderPipelineState
    private var depthState: MTLDepthStencilState
    private var materialPrimitives: [MaterialGPUPrimitive] = []
    private var whiteTexture: MTLTexture
    private var defaultSampler: MTLSamplerState
    private var instanceBuffer: MTLBuffer?
    private var instanceCount = 0
    private var appliedRequestGeneration = -1
    private var anchorPlacement: AnchorPlacement?

    init(layerRenderer: LayerRenderer, runtime: BenchmarkRuntime) throws {
        self.layerRenderer = layerRenderer
        self.runtime = runtime
        device = layerRenderer.device
        guard let queue = device.makeCommandQueue() else {
            throw ImmersiveRendererError.missingCommandQueue
        }
        commandQueue = queue

        let resources = try Self.makeDefaultResources(device: device)
        whiteTexture = resources.texture
        defaultSampler = resources.sampler
        pipelineState = try Self.makePipeline(
            device: device,
            colorFormat: layerRenderer.configuration.colorFormat,
            depthFormat: layerRenderer.configuration.depthFormat
        )
        depthState = Self.makeDepthState(device: device)

        guard let modelURL = Bundle.main.url(
            forResource: "spiderman_2002_movie_version_sam_raimi_0",
            withExtension: "glb"
        ) else {
            throw ImmersiveRendererError.missingModel
        }
        let mesh = try loadGLBMesh(data: Data(contentsOf: modelURL))
        try upload(mesh: mesh)

        runtime.rendererReady(
            gpuRenderer: device.name,
            colorFormat: String(describing: layerRenderer.configuration.colorFormat),
            depthFormat: String(describing: layerRenderer.configuration.depthFormat),
            layerLayout: "dedicated",
            foveationEnabled: layerRenderer.configuration.isFoveationEnabled,
            meshMeta: mesh.meta
        )
    }

    func run() {
        Task {
            do {
                try await arSession.run([worldTracking])
            } catch {
                runtime.rendererStopped(
                    reason: "ARKit world tracking failed: \(error.localizedDescription)"
                )
            }
        }

        while true {
            switch layerRenderer.state {
            case .paused:
                layerRenderer.waitUntilRunning()
            case .running:
                autoreleasepool { renderFrame() }
            case .invalidated:
                runtime.rendererStopped(reason: "The immersive renderer was closed.")
                return
            @unknown default:
                runtime.rendererStopped(reason: "The immersive renderer entered an unknown state.")
                return
            }
        }
    }

    private func renderFrame() {
        guard let frame = layerRenderer.queryNextFrame(),
              let timing = frame.predictTiming()
        else { return }

        frame.startUpdate()
        let request = runtime.renderSnapshot()
        frame.endUpdate()

        LayerRenderer.Clock().wait(until: timing.optimalInputTime)
        frame.startSubmission()
        defer { frame.endSubmission() }

        guard let drawable = frame.queryDrawable() else { return }
        let presentationSeconds = secondsSinceEpoch(timing.presentationTime)
        let anchor = worldTracking.queryDeviceAnchor(atTimestamp: presentationSeconds)
        if let anchor {
            drawable.deviceAnchor = anchor
            if anchorPlacement == nil, anchor.isTracked {
                anchorPlacement = placement(from: anchor.originFromAnchorTransform)
            }
        }

        updateInstancesIfNeeded(request)
        guard let commandBuffer = commandQueue.makeCommandBuffer() else { return }

        let views = drawable.views
        if let firstView = views.first {
            let viewport = firstView.textureMap.viewport
            runtime.updateDrawable(
                width: Int(viewport.width),
                height: Int(viewport.height),
                viewCount: views.count
            )
        }

        if let anchor, anchor.isTracked, instanceBuffer != nil {
            encodeScene(drawable: drawable, anchor: anchor, commandBuffer: commandBuffer)
        } else {
            encodeClear(drawable: drawable, commandBuffer: commandBuffer)
        }

        drawable.encodePresent(commandBuffer: commandBuffer)
        commandBuffer.commit()

        if let anchor, anchor.isTracked, instanceBuffer != nil {
            runtime.recordFrame(
                presentationTime: timing.presentationTime,
                wallTimeMs: monotonicMilliseconds()
            )
        } else {
            runtime.recordUnavailableFrame(wallTimeMs: monotonicMilliseconds())
        }
    }

    private func updateInstancesIfNeeded(_ request: NativeRenderRequest) {
        guard request.generation != appliedRequestGeneration,
              let anchorPlacement else { return }

        let baseOffsets: [InstanceOffset]
        switch request.layout {
        case "xrwall":
            baseOffsets = xrwallOffsets(n: request.instances, spacing: request.spacing)
        case "grid":
            baseOffsets = gridOffsets(n: request.instances, spacing: request.spacing)
        default:
            baseOffsets = lineOffsets(n: request.instances, spacing: request.spacing)
        }

        let cosine = cos(anchorPlacement.yaw)
        let sine = sin(anchorPlacement.yaw)
        let offsets = baseOffsets.map { source -> InstanceOffset in
            let localX = source.x
            let localZ = source.z + request.frontMinZ
            return InstanceOffset(
                x: anchorPlacement.x + localX * cosine + localZ * sine,
                y: source.y + request.yOffset,
                z: anchorPlacement.z - localX * sine + localZ * cosine
            )
        }

        instanceBuffer = makeBuffer(offsets)
        instanceCount = request.instances
        appliedRequestGeneration = request.generation
    }

    private func encodeScene(
        drawable: LayerRenderer.Drawable,
        anchor: DeviceAnchor,
        commandBuffer: MTLCommandBuffer
    ) {
        guard let instanceBuffer else { return }
        let views = drawable.views

        for (viewIndex, view) in views.enumerated() {
            let map = view.textureMap
            guard drawable.colorTextures.indices.contains(map.textureIndex),
                  drawable.depthTextures.indices.contains(map.textureIndex)
            else { continue }

            let descriptor = renderPassDescriptor(
                color: drawable.colorTextures[map.textureIndex],
                depth: drawable.depthTextures[map.textureIndex]
            )
            guard let encoder = commandBuffer.makeRenderCommandEncoder(
                descriptor: descriptor
            ) else { continue }

            encoder.label = "AVP material view \(viewIndex)"
            encoder.setViewport(map.viewport)
            encoder.setDepthStencilState(depthState)
            encoder.setRenderPipelineState(pipelineState)
            encoder.setVertexBuffer(instanceBuffer, offset: 0, index: 2)

            let originFromView = anchor.originFromAnchorTransform * view.transform
            var viewProjection = drawable.computeProjection(
                convention: .rightUpBack,
                viewIndex: viewIndex
            ) * simd_inverse(originFromView)
            encoder.setVertexBytes(
                &viewProjection,
                length: MemoryLayout<float4x4>.size,
                index: 1
            )

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
            encoder.endEncoding()
        }
    }

    private func encodeClear(
        drawable: LayerRenderer.Drawable,
        commandBuffer: MTLCommandBuffer
    ) {
        for view in drawable.views {
            let textureIndex = view.textureMap.textureIndex
            guard drawable.colorTextures.indices.contains(textureIndex),
                  drawable.depthTextures.indices.contains(textureIndex)
            else { continue }
            let descriptor = renderPassDescriptor(
                color: drawable.colorTextures[textureIndex],
                depth: drawable.depthTextures[textureIndex]
            )
            commandBuffer.makeRenderCommandEncoder(descriptor: descriptor)?.endEncoding()
        }
    }

    private func renderPassDescriptor(
        color: MTLTexture,
        depth: MTLTexture
    ) -> MTLRenderPassDescriptor {
        let descriptor = MTLRenderPassDescriptor()
        descriptor.colorAttachments[0].texture = color
        descriptor.colorAttachments[0].loadAction = .clear
        descriptor.colorAttachments[0].storeAction = .store
        descriptor.colorAttachments[0].clearColor = MTLClearColor(
            red: 0.05,
            green: 0.05,
            blue: 0.08,
            alpha: 1
        )
        descriptor.depthAttachment.texture = depth
        descriptor.depthAttachment.loadAction = .clear
        descriptor.depthAttachment.storeAction = .dontCare
        descriptor.depthAttachment.clearDepth = 0
        return descriptor
    }

    private func upload(mesh: GLBMesh) throws {
        guard !mesh.materialPrimitives.isEmpty else {
            throw ImmersiveRendererError.materialSceneUnavailable
        }

        let textureLoader = MTKTextureLoader(device: device)
        var gpuTextures: [Int: MTLTexture] = [:]
        var gpuSamplers: [Int: MTLSamplerState] = [:]
        for (textureIndex, texture) in mesh.textures {
            let options: [MTKTextureLoader.Option: Any] = [
                .SRGB: false,
                .origin: MTKTextureLoader.Origin.topLeft,
                .generateMipmaps: needsMipmaps(texture.sampler.minFilter),
            ]
            guard let gpuTexture = try? textureLoader.newTexture(
                data: texture.data,
                options: options
            ) else {
                throw ImmersiveRendererError.textureDecode(textureIndex)
            }
            gpuTextures[textureIndex] = gpuTexture
            gpuSamplers[textureIndex] = makeSampler(texture.sampler)
        }

        materialPrimitives = try mesh.materialPrimitives.map { primitive in
            guard let positions = makeBuffer(primitive.positions),
                  let texcoords = makeBuffer(primitive.texcoords),
                  let indices = makeBuffer(primitive.indices)
            else {
                throw ImmersiveRendererError.materialSceneUnavailable
            }
            let texture = primitive.baseColorTextureIndex.flatMap { gpuTextures[$0] }
                ?? whiteTexture
            let sampler = primitive.baseColorTextureIndex.flatMap { gpuSamplers[$0] }
                ?? defaultSampler
            return MaterialGPUPrimitive(
                positionBuffer: positions,
                texcoordBuffer: texcoords,
                indexBuffer: indices,
                indexCount: primitive.indices.count,
                baseColorFactor: primitive.baseColorFactor,
                texture: texture,
                sampler: sampler
            )
        }
    }

    private static func makePipeline(
        device: MTLDevice,
        colorFormat: MTLPixelFormat,
        depthFormat: MTLPixelFormat
    ) throws -> MTLRenderPipelineState {
        guard let library = device.makeDefaultLibrary() else {
            throw ImmersiveRendererError.missingShader("default library")
        }
        guard let vertex = library.makeFunction(name: "material_vertex"),
              let fragment = library.makeFunction(name: "material_fragment")
        else {
            throw ImmersiveRendererError.missingShader("material_vertex/material_fragment")
        }

        let vertexDescriptor = MTLVertexDescriptor()
        vertexDescriptor.attributes[0].format = .float3
        vertexDescriptor.attributes[0].bufferIndex = 0
        vertexDescriptor.layouts[0].stride = MemoryLayout<Float>.size * 3
        vertexDescriptor.attributes[1].format = .float2
        vertexDescriptor.attributes[1].bufferIndex = 3
        vertexDescriptor.layouts[3].stride = MemoryLayout<Float>.size * 2

        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.label = "AVP unlit base-color material"
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.vertexDescriptor = vertexDescriptor
        descriptor.colorAttachments[0].pixelFormat = colorFormat
        descriptor.depthAttachmentPixelFormat = depthFormat
        descriptor.colorAttachments[0].isBlendingEnabled = true
        descriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
        descriptor.colorAttachments[0].sourceAlphaBlendFactor = .sourceAlpha
        descriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        descriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        do {
            return try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            throw ImmersiveRendererError.pipeline(error.localizedDescription)
        }
    }

    private static func makeDepthState(device: MTLDevice) -> MTLDepthStencilState {
        let descriptor = MTLDepthStencilDescriptor()
        descriptor.depthCompareFunction = .greaterEqual
        descriptor.isDepthWriteEnabled = true
        return device.makeDepthStencilState(descriptor: descriptor)!
    }

    private static func makeDefaultResources(
        device: MTLDevice
    ) throws -> (texture: MTLTexture, sampler: MTLSamplerState) {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm,
            width: 1,
            height: 1,
            mipmapped: false
        )
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            throw ImmersiveRendererError.materialSceneUnavailable
        }
        let pixel: [UInt8] = [255, 255, 255, 255]
        pixel.withUnsafeBytes { bytes in
            texture.replace(
                region: MTLRegionMake2D(0, 0, 1, 1),
                mipmapLevel: 0,
                withBytes: bytes.baseAddress!,
                bytesPerRow: 4
            )
        }
        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        guard let sampler = device.makeSamplerState(descriptor: samplerDescriptor) else {
            throw ImmersiveRendererError.materialSceneUnavailable
        }
        return (texture, sampler)
    }

    private func makeSampler(_ source: GLBSampler) -> MTLSamplerState {
        let descriptor = MTLSamplerDescriptor()
        descriptor.sAddressMode = addressMode(source.wrapS)
        descriptor.tAddressMode = addressMode(source.wrapT)
        descriptor.magFilter = source.magFilter == 9728 ? .nearest : .linear
        switch source.minFilter {
        case 9728, 9984, 9986: descriptor.minFilter = .nearest
        default: descriptor.minFilter = .linear
        }
        switch source.minFilter {
        case 9984, 9985: descriptor.mipFilter = .nearest
        case 9986, 9987: descriptor.mipFilter = .linear
        default: descriptor.mipFilter = .notMipmapped
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

    private func placement(from transform: simd_float4x4) -> AnchorPlacement {
        let quaternion = simd_quatf(transform).vector
        let yaw = atan2(
            2 * (quaternion.w * quaternion.y + quaternion.x * quaternion.z),
            1 - 2 * (quaternion.y * quaternion.y + quaternion.z * quaternion.z)
        )
        return AnchorPlacement(
            x: transform.columns.3.x,
            z: transform.columns.3.z,
            yaw: yaw
        )
    }

    private func secondsSinceEpoch(_ instant: LayerRenderer.Clock.Instant) -> TimeInterval {
        let components = LayerRenderer.Clock.Instant.epoch.duration(to: instant).components
        return Double(components.seconds)
            + Double(components.attoseconds) / 1_000_000_000_000_000_000
    }
}
