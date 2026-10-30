import CompositorServices
import Metal
import SwiftUI

struct BenchmarkLayerConfiguration: CompositorLayerConfiguration {
    func makeConfiguration(
        capabilities: LayerRenderer.Capabilities,
        configuration: inout LayerRenderer.Configuration
    ) {
        let colorFormats = capabilities.supportedColorFormats
        if colorFormats.contains(.bgra8Unorm_srgb) {
            configuration.colorFormat = .bgra8Unorm_srgb
        } else if let first = colorFormats.first {
            configuration.colorFormat = first
        }

        if capabilities.supportedDepthFormats.contains(.depth32Float) {
            configuration.depthFormat = .depth32Float
        } else if let first = capabilities.supportedDepthFormats.first {
            configuration.depthFormat = first
        }

        let layouts = capabilities.supportedLayouts(options: [])
        if layouts.contains(.dedicated) {
            configuration.layout = .dedicated
        }
        configuration.isFoveationEnabled = false
        configuration.defaultDepthRange = SIMD2<Float>(100, 0.1)
    }
}

@main
struct VisionProBenchmarkApp: App {
    @StateObject private var coordinator = VisionBenchmarkCoordinator()

    var body: some Scene {
        WindowGroup {
            ControlView()
                .environmentObject(coordinator)
        }

        ImmersiveSpace(id: "BenchmarkSpace") {
            CompositorLayer(configuration: BenchmarkLayerConfiguration()) { layerRenderer in
                coordinator.startRenderer(layerRenderer)
            }
        }
    }
}
