import ARKit
import CompositorServices
import CoreGraphics
import Foundation
import ImageIO
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

private struct DiagnosticCaptureReadback {
    var buffer: MTLBuffer
    var width: Int
    var height: Int
    var bytesPerRow: Int
}

// Browser clears are specified as sRGB display values. Metal clear values for
// an sRGB attachment are linear, so convert them before the render pass.
private let benchmarkClearColor = MTLClearColor(
    red: 0.00393594,
    green: 0.00393594,
    blue: 0.00719441,
    alpha: 1
)
private let benchmarkIdleClearColor = MTLClearColor(
    red: 0,
    green: 0,
    blue: 0,
    alpha: 1
)

// Supply a finite background depth just inside the 100 m far plane. Exact
// reverse-Z zero leaves no background surface for late reprojection.
private let benchmarkBackgroundDepth = 0.000_001

enum ImmersiveRendererError: LocalizedError {
    case missingModel
    case missingCommandQueue
    case missingShader(String)
    case pipeline(String)
    case textureDecode(Int, String)
    case materialSceneUnavailable
    case diagnosticCapture(String)

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
        case .textureDecode(let index, let reason):
            return "Material texture \(index) could not be decoded: \(reason)"
        case .materialSceneUnavailable:
            return "The GLB did not contain a material scene."
        case .diagnosticCapture(let reason):
            return "Render preview failed: \(reason)"
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
    private var diagnosedRequestGeneration = -1
    private var firstInstanceCenter: SIMD3<Float>?
    private var anchorPlacement: AnchorPlacement?

    init(layerRenderer: LayerRenderer, runtime: BenchmarkRuntime) throws {
        self.layerRenderer = layerRenderer
        self.runtime = runtime
        device = layerRenderer.device
        guard let queue = device.makeCommandQueue() else {
            throw ImmersiveRendererError.missingCommandQueue
        }
        commandQueue = queue

        if #available(visionOS 26.0, *),
           layerRenderer.configuration.isFoveationEnabled {
            layerRenderer.renderQuality = LayerRenderer.RenderQuality(rawValue: 1.0)
        }

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
        let drawables = queryDrawables(for: frame)
        // A failed drawable query invalidates the frame; ending its submission aborts.
        guard !drawables.isEmpty else { return }
        let presentationSeconds = secondsSinceEpoch(timing.presentationTime)
        let anchor = worldTracking.queryDeviceAnchor(atTimestamp: presentationSeconds)
        if let anchor, anchorPlacement == nil, anchor.isTracked {
            anchorPlacement = placement(from: anchor.originFromAnchorTransform)
        }

        updateInstancesIfNeeded(request)
        let captureRequested = runtime.consumeDiagnosticCaptureRequest()
        var captureHandled = false
        var recordedDrawable = false
        for drawable in drawables {
            if let anchor {
                drawable.deviceAnchor = anchor
            }
            guard let commandBuffer = commandQueue.makeCommandBuffer() else { continue }

            if !recordedDrawable, let firstView = drawable.views.first {
                let viewport = firstView.textureMap.viewport
                let textureIndex = firstView.textureMap.textureIndex
                let colorTexture = drawable.colorTextures.indices.contains(textureIndex)
                    ? drawable.colorTextures[textureIndex]
                    : nil
                let rateMap = drawable.rasterizationRateMaps.indices.contains(textureIndex)
                    ? drawable.rasterizationRateMaps[textureIndex]
                    : nil
                runtime.updateDrawable(
                    width: Int(viewport.width),
                    height: Int(viewport.height),
                    textureWidth: colorTexture?.width ?? 0,
                    textureHeight: colorTexture?.height ?? 0,
                    viewCount: drawable.views.count,
                    rasterizationRateMapCount: drawable.rasterizationRateMaps.count,
                    rasterizationScreenWidth: rateMap?.screenSize.width ?? 0,
                    rasterizationScreenHeight: rateMap?.screenSize.height ?? 0
                )
            }

            if let anchor, anchor.isTracked, instanceBuffer != nil {
                encodeScene(
                    drawable: drawable,
                    anchor: anchor,
                    commandBuffer: commandBuffer
                )
            } else {
                encodeClear(drawable: drawable, commandBuffer: commandBuffer)
            }

            if captureRequested, !captureHandled,
               let anchor, anchor.isTracked, instanceBuffer != nil {
                do {
                    let readback = try encodeDiagnosticCapture(
                        drawable: drawable,
                        anchor: anchor,
                        commandBuffer: commandBuffer
                    )
                    let runtime = runtime
                    commandBuffer.addCompletedHandler { completedBuffer in
                        if let error = completedBuffer.error {
                            runtime.completeDiagnosticCapture(
                                data: nil,
                                error: error.localizedDescription
                            )
                            return
                        }
                        do {
                            let data = try Self.makePNGData(from: readback)
                            runtime.completeDiagnosticCapture(data: data, error: nil)
                        } catch {
                            runtime.completeDiagnosticCapture(
                                data: nil,
                                error: error.localizedDescription
                            )
                        }
                    }
                    captureHandled = true
                } catch {
                    runtime.completeDiagnosticCapture(
                        data: nil,
                        error: error.localizedDescription
                    )
                    captureHandled = true
                }
            }

            drawable.encodePresent(commandBuffer: commandBuffer)
            commandBuffer.commit()
            recordedDrawable = true
        }
        frame.endSubmission()

        if captureRequested, !captureHandled {
            runtime.completeDiagnosticCapture(
                data: nil,
                error: "No tracked drawable was available. Try again while wearing the headset."
            )
        }

        if let anchor, anchor.isTracked, instanceBuffer != nil {
            runtime.recordFrame(
                presentationTime: timing.presentationTime,
                wallTimeMs: monotonicMilliseconds()
            )
        } else {
            runtime.recordUnavailableFrame(wallTimeMs: monotonicMilliseconds())
        }
    }

    private func queryDrawables(
        for frame: LayerRenderer.Frame
    ) -> [LayerRenderer.Drawable] {
        if #available(visionOS 26.0, *) {
            return frame.queryDrawables()
        }
        return frame.queryDrawable().map { [$0] } ?? []
    }

    private func updateInstancesIfNeeded(_ request: NativeRenderRequest) {
        guard request.generation != appliedRequestGeneration else { return }

        if request.instances <= 0 {
            instanceBuffer = nil
            instanceCount = 0
            firstInstanceCenter = nil
            appliedRequestGeneration = request.generation
            diagnosedRequestGeneration = request.generation
            return
        }

        guard let anchorPlacement else { return }

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
        firstInstanceCenter = offsets.first.map { SIMD3<Float>($0.x, $0.y, $0.z) }
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
                depth: drawable.depthTextures[map.textureIndex],
                slice: map.sliceIndex,
                rasterizationRateMap: drawable.rasterizationRateMaps.indices.contains(
                    map.textureIndex
                ) ? drawable.rasterizationRateMaps[map.textureIndex] : nil
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
            let viewMatrix = simd_inverse(originFromView)
            var viewProjection = drawable.computeProjection(
                convention: .rightUpBack,
                viewIndex: viewIndex
            ) * viewMatrix
            if viewIndex == 0 {
                diagnoseVisibilityIfNeeded(
                    originFromView: originFromView,
                    viewMatrix: viewMatrix,
                    viewProjection: viewProjection
                )
            }
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
                depth: drawable.depthTextures[textureIndex],
                slice: view.textureMap.sliceIndex,
                rasterizationRateMap: drawable.rasterizationRateMaps.indices.contains(
                    textureIndex
                ) ? drawable.rasterizationRateMaps[textureIndex] : nil,
                clearColor: benchmarkIdleClearColor
            )
            commandBuffer.makeRenderCommandEncoder(descriptor: descriptor)?.endEncoding()
        }
    }

    private func encodeDiagnosticCapture(
        drawable: LayerRenderer.Drawable,
        anchor: DeviceAnchor,
        commandBuffer: MTLCommandBuffer
    ) throws -> DiagnosticCaptureReadback {
        guard let instanceBuffer,
              let view = drawable.views.first
        else {
            throw ImmersiveRendererError.diagnosticCapture("No first-eye view was available.")
        }

        let colorFormat = layerRenderer.configuration.colorFormat
        guard colorFormat == .bgra8Unorm || colorFormat == .bgra8Unorm_srgb
        else {
            throw ImmersiveRendererError.diagnosticCapture(
                "Unsupported color format \(colorFormat)."
            )
        }

        let sourceViewport = view.textureMap.viewport
        let width = Int(sourceViewport.width)
        let height = Int(sourceViewport.height)
        guard width > 0, height > 0 else {
            throw ImmersiveRendererError.diagnosticCapture("The first-eye viewport was empty.")
        }

        let colorDescriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: colorFormat,
            width: width,
            height: height,
            mipmapped: false
        )
        colorDescriptor.storageMode = .private
        colorDescriptor.usage = .renderTarget
        guard let colorTexture = device.makeTexture(descriptor: colorDescriptor) else {
            throw ImmersiveRendererError.diagnosticCapture("Metal could not allocate color storage.")
        }

        let depthDescriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: layerRenderer.configuration.depthFormat,
            width: width,
            height: height,
            mipmapped: false
        )
        depthDescriptor.storageMode = .private
        depthDescriptor.usage = .renderTarget
        guard let depthTexture = device.makeTexture(descriptor: depthDescriptor) else {
            throw ImmersiveRendererError.diagnosticCapture("Metal could not allocate depth storage.")
        }

        let descriptor = renderPassDescriptor(color: colorTexture, depth: depthTexture)
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else {
            throw ImmersiveRendererError.diagnosticCapture("Metal could not create a render encoder.")
        }
        encoder.label = "AVP first-eye diagnostic capture"
        encoder.setViewport(MTLViewport(
            originX: 0,
            originY: 0,
            width: Double(width),
            height: Double(height),
            znear: sourceViewport.znear,
            zfar: sourceViewport.zfar
        ))
        encoder.setDepthStencilState(depthState)
        encoder.setRenderPipelineState(pipelineState)
        encoder.setVertexBuffer(instanceBuffer, offset: 0, index: 2)

        let originFromView = anchor.originFromAnchorTransform * view.transform
        let viewMatrix = simd_inverse(originFromView)
        var viewProjection = drawable.computeProjection(
            convention: .rightUpBack,
            viewIndex: 0
        ) * viewMatrix
        encoder.setVertexBytes(
            &viewProjection,
            length: MemoryLayout<float4x4>.size,
            index: 1
        )
        encodeMaterialPrimitives(with: encoder)
        encoder.endEncoding()

        let unalignedBytesPerRow = width * 4
        let bytesPerRow = (unalignedBytesPerRow + 255) & ~255
        guard let buffer = device.makeBuffer(
            length: bytesPerRow * height,
            options: .storageModeShared
        ), let blit = commandBuffer.makeBlitCommandEncoder() else {
            throw ImmersiveRendererError.diagnosticCapture("Metal could not allocate readback storage.")
        }
        blit.copy(
            from: colorTexture,
            sourceSlice: 0,
            sourceLevel: 0,
            sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
            sourceSize: MTLSize(width: width, height: height, depth: 1),
            to: buffer,
            destinationOffset: 0,
            destinationBytesPerRow: bytesPerRow,
            destinationBytesPerImage: bytesPerRow * height
        )
        blit.endEncoding()

        return DiagnosticCaptureReadback(
            buffer: buffer,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow
        )
    }

    private func encodeMaterialPrimitives(with encoder: MTLRenderCommandEncoder) {
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

    private static func makePNGData(from readback: DiagnosticCaptureReadback) throws -> Data {
        let byteCount = readback.bytesPerRow * readback.height
        let pixels = Data(bytes: readback.buffer.contents(), count: byteCount)
        guard let provider = CGDataProvider(data: pixels as CFData),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
        else {
            throw ImmersiveRendererError.diagnosticCapture("Core Graphics rejected the readback data.")
        }

        let bitmapInfo = CGBitmapInfo.byteOrder32Little.union(
            CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue)
        )
        guard let image = CGImage(
            width: readback.width,
            height: readback.height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: readback.bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo,
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        ) else {
            throw ImmersiveRendererError.diagnosticCapture("Core Graphics could not create an image.")
        }

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            "public.png" as CFString,
            1,
            nil
        ) else {
            throw ImmersiveRendererError.diagnosticCapture("ImageIO could not create a PNG writer.")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw ImmersiveRendererError.diagnosticCapture("ImageIO could not finish the PNG.")
        }
        return output as Data
    }

    private func renderPassDescriptor(
        color: MTLTexture,
        depth: MTLTexture,
        slice: Int = 0,
        rasterizationRateMap: MTLRasterizationRateMap? = nil,
        clearColor: MTLClearColor = benchmarkClearColor
    ) -> MTLRenderPassDescriptor {
        let descriptor = MTLRenderPassDescriptor()
        descriptor.colorAttachments[0].texture = color
        descriptor.colorAttachments[0].slice = slice
        descriptor.colorAttachments[0].loadAction = .clear
        descriptor.colorAttachments[0].storeAction = .store
        descriptor.colorAttachments[0].clearColor = clearColor
        descriptor.depthAttachment.texture = depth
        descriptor.depthAttachment.slice = slice
        descriptor.depthAttachment.loadAction = .clear
        descriptor.depthAttachment.storeAction = .store
        descriptor.depthAttachment.clearDepth = benchmarkBackgroundDepth
        descriptor.rasterizationRateMap = rasterizationRateMap
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
            let generateMipmaps = needsMipmaps(texture.sampler.minFilter)
            let options: [MTKTextureLoader.Option: Any] = [
                // glTF base-color textures are encoded in the sRGB color space.
                .SRGB: true,
                .origin: MTKTextureLoader.Origin.topLeft,
                .generateMipmaps: generateMipmaps,
            ]
            let gpuTexture: MTLTexture
            do {
                gpuTexture = try textureLoader.newTexture(
                    data: texture.data,
                    options: options
                )
            } catch {
                do {
                    gpuTexture = try makeRGBA8Texture(
                        data: texture.data,
                        generateMipmaps: generateMipmaps
                    )
                } catch let fallbackError {
                    throw ImmersiveRendererError.textureDecode(
                        textureIndex,
                        "MetalKit: \(error.localizedDescription); "
                            + "RGBA fallback: \(fallbackError.localizedDescription)"
                    )
                }
            }
            gpuTexture.label = "GLB base-color texture \(textureIndex)"
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

    private func makeRGBA8Texture(
        data: Data,
        generateMipmaps: Bool
    ) throws -> MTLTexture {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width > 0,
              image.height > 0,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
        else {
            throw ImmersiveRendererError.materialSceneUnavailable
        }

        let width = image.width
        let height = image.height
        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
        let rendered = pixels.withUnsafeMutableBytes { bytes -> Bool in
            guard let baseAddress = bytes.baseAddress,
                  let context = CGContext(
                    data: baseAddress,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
                        | CGImageAlphaInfo.noneSkipLast.rawValue
                  )
            else { return false }

            // Bitmap rows already match Metal's top-left texture orientation.
            // Flipping here moves the indexed-PNG chest logo to the wrong UV region.
            context.draw(
                image,
                in: CGRect(x: 0, y: 0, width: width, height: height)
            )
            return true
        }
        guard rendered else {
            throw ImmersiveRendererError.materialSceneUnavailable
        }
        for alphaOffset in stride(from: 3, to: pixels.count, by: 4) {
            pixels[alphaOffset] = 255
        }

        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm_srgb,
            width: width,
            height: height,
            mipmapped: generateMipmaps
        )
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            throw ImmersiveRendererError.materialSceneUnavailable
        }
        pixels.withUnsafeBytes { bytes in
            texture.replace(
                region: MTLRegionMake2D(0, 0, width, height),
                mipmapLevel: 0,
                withBytes: bytes.baseAddress!,
                bytesPerRow: bytesPerRow
            )
        }

        if generateMipmaps {
            guard let commandBuffer = commandQueue.makeCommandBuffer(),
                  let blitEncoder = commandBuffer.makeBlitCommandEncoder()
            else {
                throw ImmersiveRendererError.materialSceneUnavailable
            }
            blitEncoder.generateMipmaps(for: texture)
            blitEncoder.endEncoding()
            commandBuffer.commit()
            commandBuffer.waitUntilCompleted()
            if let error = commandBuffer.error {
                throw error
            }
        }
        return texture
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
        // Preserve an opaque full-immersion target while blending texture edges.
        descriptor.colorAttachments[0].sourceAlphaBlendFactor = .one
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
        // Reverse-Z equivalent of the browser renderers' strict `less` test.
        descriptor.depthCompareFunction = .greater
        descriptor.isDepthWriteEnabled = true
        return device.makeDepthStencilState(descriptor: descriptor)!
    }

    private static func makeDefaultResources(
        device: MTLDevice
    ) throws -> (texture: MTLTexture, sampler: MTLSamplerState) {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm_srgb,
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

    private func diagnoseVisibilityIfNeeded(
        originFromView: simd_float4x4,
        viewMatrix: simd_float4x4,
        viewProjection: simd_float4x4
    ) {
        guard diagnosedRequestGeneration != appliedRequestGeneration,
              let firstInstanceCenter
        else { return }

        let worldCenter = SIMD4<Float>(firstInstanceCenter, 1)
        let viewCenter = viewMatrix * worldCenter
        let clipCenter = viewProjection * worldCenter
        let ndcCenter: SIMD3<Float>?
        let insideClip: Bool
        if clipCenter.w > 0, clipCenter.w.isFinite {
            let ndc = SIMD3<Float>(clipCenter.x, clipCenter.y, clipCenter.z) / clipCenter.w
            ndcCenter = ndc
            insideClip = abs(ndc.x) <= 1
                && abs(ndc.y) <= 1
                && ndc.z >= 0
                && ndc.z <= 1
        } else {
            ndcCenter = nil
            insideClip = false
        }

        let diagnostic = NativeVisibilityDiagnostic(
            requestGeneration: appliedRequestGeneration,
            modelWorldCenter: firstInstanceCenter,
            cameraWorldCenter: originFromView.columns.3.xyz,
            modelViewCenter: viewCenter.xyz,
            modelClipCenter: clipCenter,
            modelNDCCenter: ndcCenter,
            centerInsideClipVolume: insideClip
        )
        runtime.updateVisibilityDiagnostic(diagnostic)
        diagnosedRequestGeneration = appliedRequestGeneration

        let ndcText = ndcCenter.map {
            String(format: "(%.3f, %.3f, %.3f)", $0.x, $0.y, $0.z)
        } ?? "unavailable"
        print(
            "AVP visibility diagnostic generation=\(appliedRequestGeneration) "
                + "insideClip=\(insideClip) "
                + String(
                    format: "view=(%.3f, %.3f, %.3f) ",
                    viewCenter.x,
                    viewCenter.y,
                    viewCenter.z
                )
                + "ndc=\(ndcText)"
        )
    }

    private func secondsSinceEpoch(_ instant: LayerRenderer.Clock.Instant) -> TimeInterval {
        let components = LayerRenderer.Clock.Instant.epoch.duration(to: instant).components
        return Double(components.seconds)
            + Double(components.attoseconds) / 1_000_000_000_000_000_000
    }
}

private extension SIMD4 where Scalar == Float {
    var xyz: SIMD3<Float> { SIMD3<Float>(x, y, z) }
}
