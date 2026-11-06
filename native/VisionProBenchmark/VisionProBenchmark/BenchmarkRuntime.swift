@preconcurrency import CompositorServices
import Foundation

struct NativeTrialMeasurement {
    var frameTimesMs: [Double]
    var wallFrameTimesMs: [Double]
    var durationMs: Double
    var aborted: Bool
    var abortCode: String
    var abortReason: String
}

struct NativeRenderRequest: Equatable {
    var generation = 0
    var instances = 1
    var layout = "xrwall"
    var spacing: Float = 0.35
    var frontMinZ: Float = -2.5
    var yOffset: Float = 1.4
}

struct NativeRuntimeEnvironment {
    var rendererReady = false
    var gpuRenderer = ""
    var viewCount = 0
    var drawableWidth = 0
    var drawableHeight = 0
    var colorFormat = ""
    var depthFormat = ""
    var layerLayout = "dedicated"
    var foveationEnabled = false
    var meshMeta: GLBMeta?
    var visibilityDiagnostic: NativeVisibilityDiagnostic?
}

struct NativeVisibilityDiagnostic {
    var requestGeneration: Int
    var modelWorldCenter: SIMD3<Float>
    var cameraWorldCenter: SIMD3<Float>
    var modelViewCenter: SIMD3<Float>
    var modelClipCenter: SIMD4<Float>
    var modelNDCCenter: SIMD3<Float>?
    var centerInsideClipVolume: Bool
}

final class BenchmarkRuntime: @unchecked Sendable {
    private struct ActiveTrial {
        var warmupMs: Double
        var durationMs: Double
        var minFrames: Int
        var startWallMs: Double
        var measureStartWallMs: Double?
        var previousPresentation: LayerRenderer.Clock.Instant?
        var previousWallMs: Double?
        var frameTimesMs: [Double] = []
        var wallFrameTimesMs: [Double] = []
        var completion: (NativeTrialMeasurement) -> Void
    }

    private let lock = NSLock()
    private var renderRequest = NativeRenderRequest()
    private var activeTrial: ActiveTrial?
    private var environment = NativeRuntimeEnvironment()
    private var diagnosticCaptureRequested = false

    var onStatus: ((String) -> Void)?
    var onReadyChanged: ((Bool) -> Void)?
    var onDiagnosticCapture: ((Data?, String?) -> Void)?

    func requestRender(
        instances: Int,
        layout: String,
        spacing: Float,
        frontMinZ: Float,
        yOffset: Float
    ) {
        lock.lock()
        renderRequest.generation += 1
        renderRequest.instances = instances
        renderRequest.layout = layout
        renderRequest.spacing = spacing
        renderRequest.frontMinZ = frontMinZ
        renderRequest.yOffset = yOffset
        lock.unlock()
    }

    func renderSnapshot() -> NativeRenderRequest {
        lock.lock()
        defer { lock.unlock() }
        return renderRequest
    }

    func requestDiagnosticCapture() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard activeTrial == nil, !diagnosticCaptureRequested else { return false }
        diagnosticCaptureRequested = true
        return true
    }

    func consumeDiagnosticCaptureRequest() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard diagnosticCaptureRequested else { return false }
        diagnosticCaptureRequested = false
        return true
    }

    func completeDiagnosticCapture(data: Data?, error: String?) {
        onDiagnosticCapture?(data, error)
    }

    func beginTrial(
        warmupMs: Double,
        durationMs: Double,
        minFrames: Int,
        completion: @escaping (NativeTrialMeasurement) -> Void
    ) {
        lock.lock()
        let replaced = activeTrial
        activeTrial = ActiveTrial(
            warmupMs: warmupMs,
            durationMs: durationMs,
            minFrames: minFrames,
            startWallMs: monotonicMilliseconds(),
            completion: completion
        )
        lock.unlock()

        replaced?.completion(NativeTrialMeasurement(
            frameTimesMs: [],
            wallFrameTimesMs: [],
            durationMs: 0,
            aborted: true,
            abortCode: "trial_replaced",
            abortReason: "A new trial replaced an unfinished trial."
        ))
    }

    func recordFrame(
        presentationTime: LayerRenderer.Clock.Instant,
        wallTimeMs: Double
    ) {
        var completed: ActiveTrial?

        lock.lock()
        if var trial = activeTrial {
            if trial.measureStartWallMs == nil {
                if wallTimeMs - trial.startWallMs >= trial.warmupMs {
                    trial.measureStartWallMs = wallTimeMs
                    trial.previousPresentation = presentationTime
                    trial.previousWallMs = wallTimeMs
                }
            } else {
                if let previous = trial.previousPresentation {
                    let interval = milliseconds(previous.duration(to: presentationTime))
                    if interval > 0, interval.isFinite {
                        trial.frameTimesMs.append(interval)
                    }
                }
                if let previousWallMs = trial.previousWallMs {
                    let interval = wallTimeMs - previousWallMs
                    if interval > 0, interval.isFinite {
                        trial.wallFrameTimesMs.append(interval)
                    }
                }
                trial.previousPresentation = presentationTime
                trial.previousWallMs = wallTimeMs

                let elapsed = wallTimeMs - (trial.measureStartWallMs ?? wallTimeMs)
                if elapsed >= trial.durationMs && trial.frameTimesMs.count >= trial.minFrames {
                    completed = trial
                    activeTrial = nil
                }
            }
            if completed == nil {
                activeTrial = trial
            }
        }
        lock.unlock()

        if let completed {
            let measuredDuration = wallTimeMs - (completed.measureStartWallMs ?? wallTimeMs)
            completed.completion(NativeTrialMeasurement(
                frameTimesMs: completed.frameTimesMs,
                wallFrameTimesMs: completed.wallFrameTimesMs,
                durationMs: measuredDuration,
                aborted: false,
                abortCode: "",
                abortReason: ""
            ))
        }
    }

    func recordUnavailableFrame(wallTimeMs: Double) {
        var timedOut: ActiveTrial?
        lock.lock()
        if let trial = activeTrial,
           wallTimeMs - trial.startWallMs > trial.warmupMs + trial.durationMs + 5_000,
           trial.frameTimesMs.count < trial.minFrames {
            timedOut = trial
            activeTrial = nil
        }
        lock.unlock()

        timedOut?.completion(NativeTrialMeasurement(
            frameTimesMs: timedOut?.frameTimesMs ?? [],
            wallFrameTimesMs: timedOut?.wallFrameTimesMs ?? [],
            durationMs: 0,
            aborted: true,
            abortCode: "tracking_or_drawable_timeout",
            abortReason: "No tracked stereo frames arrived before the trial timeout."
        ))
    }

    func abortActiveTrial(code: String, reason: String) {
        lock.lock()
        let trial = activeTrial
        activeTrial = nil
        lock.unlock()
        trial?.completion(NativeTrialMeasurement(
            frameTimesMs: trial?.frameTimesMs ?? [],
            wallFrameTimesMs: trial?.wallFrameTimesMs ?? [],
            durationMs: 0,
            aborted: true,
            abortCode: code,
            abortReason: reason
        ))
    }

    func rendererReady(
        gpuRenderer: String,
        colorFormat: String,
        depthFormat: String,
        layerLayout: String,
        foveationEnabled: Bool,
        meshMeta: GLBMeta
    ) {
        lock.lock()
        environment.rendererReady = true
        environment.gpuRenderer = gpuRenderer
        environment.colorFormat = colorFormat
        environment.depthFormat = depthFormat
        environment.layerLayout = layerLayout
        environment.foveationEnabled = foveationEnabled
        environment.meshMeta = meshMeta
        lock.unlock()
        onReadyChanged?(true)
        onStatus?("Immersive Metal renderer ready. Keep the headset on while collecting.")
    }

    func updateDrawable(width: Int, height: Int, viewCount: Int) {
        lock.lock()
        environment.drawableWidth = width
        environment.drawableHeight = height
        environment.viewCount = viewCount
        lock.unlock()
    }

    func updateVisibilityDiagnostic(_ diagnostic: NativeVisibilityDiagnostic) {
        lock.lock()
        environment.visibilityDiagnostic = diagnostic
        lock.unlock()
    }

    func rendererStopped(reason: String) {
        lock.lock()
        environment.rendererReady = false
        lock.unlock()
        onReadyChanged?(false)
        abortActiveTrial(code: "renderer_stopped", reason: reason)
        onStatus?(reason)
    }

    func environmentSnapshot() -> NativeRuntimeEnvironment {
        lock.lock()
        defer { lock.unlock() }
        return environment
    }
}

func monotonicMilliseconds() -> Double {
    ProcessInfo.processInfo.systemUptime * 1_000
}

private func milliseconds(_ duration: Duration) -> Double {
    let components = duration.components
    return Double(components.seconds) * 1_000
        + Double(components.attoseconds) / 1_000_000_000_000_000
}
