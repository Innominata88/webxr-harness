@preconcurrency import CompositorServices
import Combine
import Darwin
import Foundation

@MainActor
final class VisionBenchmarkCoordinator: ObservableObject {
    let runtime = BenchmarkRuntime()

    @Published var selectedPlan: VisionPlanChoice = .regularSmoke {
        didSet { loadSelectedPlan() }
    }
    @Published private(set) var plan: NativeXRPlan?
    @Published private(set) var status = "Open the immersive space to initialize Metal."
    @Published private(set) var progress: Double = 0
    @Published private(set) var isRunning = false
    @Published private(set) var rendererReady = false
    @Published var immersiveOpen = false
    @Published private(set) var latestOutputURL: URL?
    @Published private(set) var outputURLs: [URL] = []
    @Published private(set) var latestCaptureURL: URL?
    @Published var nativeHarnessCommit: String = "" {
        didSet {
            UserDefaults.standard.set(nativeHarnessCommit, forKey: "nativeHarnessCommit")
        }
    }

    private var runTask: Task<Void, Never>?

    init() {
        nativeHarnessCommit = UserDefaults.standard.string(
            forKey: "nativeHarnessCommit"
        ) ?? ""
        runtime.onStatus = { [weak self] message in
            DispatchQueue.main.async { self?.status = message }
        }
        runtime.onReadyChanged = { [weak self] ready in
            DispatchQueue.main.async { self?.rendererReady = ready }
        }
        runtime.onDiagnosticCapture = { [weak self] data, error in
            DispatchQueue.main.async {
                self?.finishDiagnosticCapture(data: data, error: error)
            }
        }
        loadSelectedPlan()
    }

    var planSummary: String {
        guard let plan else { return "Plan unavailable" }
        return [
            "\(plan.runCount) runs",
            "\(plan.instances.map(String.init).joined(separator: ",")) instances",
            "\(plan.trialsPerInstance) trials per count",
            "\(Int(plan.durationMs / 1_000)) seconds per trial",
        ].joined(separator: " | ")
    }

    func startRenderer(_ layerRenderer: LayerRenderer) {
        let runtime = runtime
        Thread.detachNewThread {
            Thread.current.name = "AVP Native Benchmark Renderer"
            Thread.current.qualityOfService = .userInteractive
            do {
                let renderer = try ImmersiveMetalRenderer(
                    layerRenderer: layerRenderer,
                    runtime: runtime
                )
                renderer.run()
            } catch {
                runtime.rendererStopped(
                    reason: "Metal renderer failed: \(error.localizedDescription)"
                )
            }
        }
    }

    func startSelectedPlan() {
        guard !isRunning else { return }
        guard rendererReady else {
            status = "Enter the immersive space and wait for Metal renderer ready."
            return
        }
        guard let plan else {
            status = "The selected plan could not be loaded."
            return
        }
        guard !nativeHarnessCommit.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            status = "Enter the native Git commit (append -dirty for an uncommitted build)."
            return
        }

        isRunning = true
        progress = 0
        outputURLs = []
        latestOutputURL = nil
        runTask = Task { [weak self] in
            guard let self else { return }
            await self.execute(plan)
        }
    }

    func cancel() {
        guard isRunning else { return }
        runTask?.cancel()
        runtime.abortActiveTrial(
            code: "operator_cancelled",
            reason: "The operator cancelled the collection."
        )
        status = "Cancelling after the current operation."
    }

    func captureRenderPreview() {
        guard rendererReady else {
            status = "Enter the immersive space before capturing a render preview."
            return
        }
        guard !isRunning else {
            status = "Render previews are disabled during measured collection."
            return
        }
        guard runtime.requestDiagnosticCapture() else {
            status = "A render preview is already pending."
            return
        }
        status = "Exporting the first-eye Metal render target..."
    }

    private func loadSelectedPlan() {
        do {
            plan = try NativeXRPlan.bundled(selectedPlan)
            status = "Plan ready. Enter the immersive space."
        } catch {
            plan = nil
            status = error.localizedDescription
        }
    }

    private func execute(_ plan: NativeXRPlan) async {
        defer {
            runtime.requestIdle()
            isRunning = false
            runTask = nil
        }

        let conditionCount = plan.instances.count * plan.trialsPerInstance
        let totalConditions = conditionCount * plan.runs.count
        var completedConditions = 0

        for (runIndex, run) in plan.runs.enumerated() {
            if Task.isCancelled {
                status = "Collection cancelled."
                return
            }
            guard rendererReady else {
                status = "Collection stopped because the immersive renderer closed."
                return
            }

            let outputURL: URL
            do {
                outputURL = try prepareOutput(plan: plan, run: run)
                latestOutputURL = outputURL
                outputURLs.append(outputURL)
            } catch {
                status = "Could not create output: \(error.localizedDescription)"
                return
            }

            let conditions = buildConditionPlan(
                instancesList: plan.instances,
                trialsPerInstance: plan.trialsPerInstance,
                shuffle: plan.shuffle,
                seed: plan.seed
            )
            var previousInstances: Int?

            for condition in conditions {
                if Task.isCancelled {
                    status = "Collection cancelled. Partial JSONL was retained."
                    return
                }
                if let previousInstances,
                   previousInstances != condition.instances,
                   !(await pause(milliseconds: plan.betweenInstancesMs)) {
                    status = "Collection cancelled. Partial JSONL was retained."
                    return
                }
                previousInstances = condition.instances

                runtime.requestRender(
                    instances: condition.instances,
                    layout: plan.layout,
                    spacing: plan.spacing,
                    frontMinZ: plan.xrFrontMinZ,
                    yOffset: plan.xrYOffset
                )
                status = [
                    "Run \(runIndex + 1)/\(plan.runs.count)",
                    "condition \(condition.conditionIndex + 1)/\(conditions.count)",
                    "\(condition.instances) instances",
                    "trial \(condition.trial)/\(plan.trialsPerInstance)",
                ].joined(separator: " | ")

                let startedAt = ISO8601DateFormatter().string(from: Date())
                let measurement = await performTrial(plan: plan)
                let record = buildRecord(
                    plan: plan,
                    run: run,
                    condition: condition,
                    conditionCount: conditions.count,
                    startedAt: startedAt,
                    measurement: measurement
                )

                do {
                    try append(record: record, to: outputURL)
                } catch {
                    status = "Could not append output: \(error.localizedDescription)"
                    return
                }
                if measurement.aborted {
                    status = "Trial aborted: \(measurement.abortReason)"
                    return
                }

                completedConditions += 1
                progress = Double(completedConditions) / Double(totalConditions)
                if condition.conditionIndex < conditions.count - 1,
                   !(await pause(milliseconds: plan.cooldownMs)) {
                    status = "Collection cancelled. Partial JSONL was retained."
                    return
                }
            }

            if runIndex < plan.runs.count - 1 {
                runtime.requestIdle()
                if !(await betweenRunCooldown(
                    milliseconds: plan.betweenRunsMs,
                    nextRun: runIndex + 2,
                    totalRuns: plan.runs.count
                )) {
                    status = "Collection cancelled. Partial JSONL was retained."
                    return
                }
            }
        }
        progress = 1
        status = "Selected native plan complete. Export the most recent JSONL file."
    }

    private func performTrial(plan: NativeXRPlan) async -> NativeTrialMeasurement {
        await withCheckedContinuation { continuation in
            runtime.beginTrial(
                warmupMs: plan.warmupMs,
                durationMs: plan.durationMs,
                minFrames: plan.minFrames
            ) { measurement in
                continuation.resume(returning: measurement)
            }
        }
    }

    private func pause(milliseconds: Double) async -> Bool {
        guard milliseconds > 0 else { return !Task.isCancelled }
        do {
            try await Task.sleep(nanoseconds: UInt64(milliseconds * 1_000_000))
            return !Task.isCancelled
        } catch {
            return false
        }
    }

    private func betweenRunCooldown(
        milliseconds: Double,
        nextRun: Int,
        totalRuns: Int
    ) async -> Bool {
        var remaining = Int(ceil(milliseconds / 1_000))
        while remaining > 0 {
            status = "Cooldown before run \(nextRun)/\(totalRuns): \(remaining) seconds"
            if !(await pause(milliseconds: min(1_000, Double(remaining) * 1_000))) {
                return false
            }
            remaining -= 1
        }
        return true
    }

    private func buildRecord(
        plan: NativeXRPlan,
        run: NativeXRRun,
        condition: Condition,
        conditionCount: Int,
        startedAt: String,
        measurement: NativeTrialMeasurement
    ) -> [String: Any] {
        let environment = runtime.environmentSnapshot()
        var record: [String: Any] = [
            "schema_version": "1.1.0",
            "api": "metal",
            "mode": "xr",
            "surface_mode": "basecolor",
            "surfaceMode": "basecolor",
            "render_scale": plan.renderScale,
            "source_webxr_scale_factor": plan.sourceRenderScale,
            "modelUrl": plan.assetRevision,
            "trial": condition.trial,
            "trials": plan.trialsPerInstance,
            "instances": condition.instances,
            "condition_index": condition.conditionIndex,
            "condition_count": conditionCount,
            "suiteId": run.suiteId,
            "runId": run.runId,
            "startedAt": startedAt,
            "layout": plan.layout,
            "spacing": plan.spacing,
            "seed": plan.seed,
            "shuffle": plan.shuffle,
            "durationMs": plan.durationMs,
            "warmupMs": plan.warmupMs,
            "cooldownMs": plan.cooldownMs,
            "betweenInstancesMs": plan.betweenInstancesMs,
            "minFrames": plan.minFrames,
            "collectPerf": false,
            "perfDetail": false,
            "aborted": measurement.aborted,
            "abort_code": measurement.abortCode,
            "abort_reason": measurement.abortReason,
        ]

        var env = [
            "platform": "visionOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
            "device_model": hardwareModel(),
            "os_version": ProcessInfo.processInfo.operatingSystemVersionString,
            "runtime_family": plan.runtimeFamily,
            "runtime_mode": plan.presentationMode,
            "xr_runtime": "CompositorServices",
            "renderer_path": "metal-compositorservices-basecolor",
            "surface_mode": plan.surfaceMode,
            "surfaceMode": plan.surfaceMode,
            "render_scale": plan.renderScale,
            "source_webxr_scale_factor": plan.sourceRenderScale,
            "render_scale_semantics": "system_compositor_native",
            "drawable_width": environment.drawableWidth,
            "drawable_height": environment.drawableHeight,
            "view_count": environment.viewCount,
            "gpu_renderer": environment.gpuRenderer,
            "color_format": environment.colorFormat,
            "depth_format": environment.depthFormat,
            "layer_layout": environment.layerLayout,
            "foveation_enabled": environment.foveationEnabled,
            "timing_source_primary": "compositorservices_predicted_presentation_time",
            "timing_source_secondary": "processinfo_system_uptime",
            "timing_scope": "application_compositor_cadence_not_gpu_execution",
            "browser": "native",
            "harness_version": "native-vision-1.0.0",
            "harness_commit": nativeHarnessCommit,
            "source_web_harness_commit": plan.sourceHarnessCommit,
            "source_harness_version": plan.sourceHarnessVersion,
            "asset_revision": plan.assetRevision,
            "plan_id": plan.planId,
            "source_manifest": plan.sourceManifest,
            "xr_anchor_to_first_pose": plan.xrAnchorToFirstPose,
            "xr_anchor_mode": plan.xrAnchorMode,
            "xr_front_min_z": plan.xrFrontMinZ,
            "xr_y_offset": plan.xrYOffset,
            "hardwareConcurrency": ProcessInfo.processInfo.activeProcessorCount,
        ] as [String: Any]
        if let diagnostic = environment.visibilityDiagnostic {
            var visibility = [
                "request_generation": diagnostic.requestGeneration,
                "model_world_center": array(diagnostic.modelWorldCenter),
                "camera_world_center": array(diagnostic.cameraWorldCenter),
                "model_view_center": array(diagnostic.modelViewCenter),
                "model_clip_center": array(diagnostic.modelClipCenter),
                "center_inside_clip_volume": diagnostic.centerInsideClipVolume,
            ] as [String: Any]
            if let ndc = diagnostic.modelNDCCenter {
                visibility["model_ndc_center"] = array(ndc)
            }
            env["visibility_diagnostic"] = visibility
        }
        record["env"] = env

        if let meta = environment.meshMeta {
            record["scene"] = [
                "surface_mode": plan.surfaceMode,
                "vertex_count": meta.vertexCount,
                "index_count": meta.indexCount,
                "triangle_count": meta.triangleCount,
                "primitives_loaded": meta.primitiveCount,
                "textured_primitives_loaded": meta.texturedPrimitiveCount,
                "materials_total": meta.materialCount,
                "images_total": meta.imageCount,
                "textures_total": meta.textureCount,
                "material_scene_primitives": meta.primitiveCount,
                "material_scene_textures": meta.materialTextureCount,
                "norm_scale": meta.normScale,
                "norm_center": [meta.normCenter.x, meta.normCenter.y, meta.normCenter.z],
                "norm_max_dim": meta.normMaxDim,
            ] as [String: Any]
        }

        guard !measurement.aborted else { return record }
        let stats = computeTrialStats(
            frameTimes: measurement.frameTimesMs,
            durationMs: measurement.durationMs
        )
        let wallStats = computeTrialStats(
            frameTimes: measurement.wallFrameTimesMs,
            durationMs: measurement.durationMs
        )
        record["summary"] = [
            "frames": stats.frames,
            "duration_ms": stats.duration_ms,
            "mean_ms": stats.mean_ms,
            "p50_ms": stats.p50_ms,
            "p95_ms": stats.p95_ms,
            "p99_ms": stats.p99_ms,
        ] as [String: Any]
        record["extras"] = [
            "fps_effective": stats.fps_effective,
            "fps_from_mean": stats.fps_from_mean,
            "max_frame_ms": stats.max_frame_ms,
            "jank_p99_over_p50": stats.jank_p99_over_p50,
            "missed_1p5x": stats.missed_1p5x,
            "missed_1p5x_pct": stats.missed_1p5x_pct,
            "missed_2x": stats.missed_2x,
            "target_ms": stats.target_ms,
            "wall_mean_ms": wallStats.mean_ms,
            "wall_p95_ms": wallStats.p95_ms,
            "wall_p99_ms": wallStats.p99_ms,
        ] as [String: Any]
        return record
    }

    private func prepareOutput(plan: NativeXRPlan, run: NativeXRRun) throws -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let timestamp = formatter.string(from: Date())
        let filename = [
            "results__run=\(safe(run.runId))",
            "a=metal",
            "m=xr",
            "s=basecolor",
            "d=avp",
            "ts=\(timestamp).jsonl",
        ].joined(separator: "__")
        let documents = FileManager.default.urls(
            for: .documentDirectory,
            in: .userDomainMask
        ).first!
        let directory = documents
            .appendingPathComponent("AVP Native XR", isDirectory: true)
            .appendingPathComponent(plan.cohortGroup, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let url = directory.appendingPathComponent(filename)
        try Data().write(to: url, options: .atomic)
        return url
    }

    private func finishDiagnosticCapture(data: Data?, error: String?) {
        if let error {
            status = "Render preview failed: \(error)"
            return
        }
        guard let data else {
            status = "Render preview failed without image data."
            return
        }

        do {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyyMMdd-HHmmss"
            let timestamp = formatter.string(from: Date())
            let documents = FileManager.default.urls(
                for: .documentDirectory,
                in: .userDomainMask
            ).first!
            let directory = documents
                .appendingPathComponent("AVP Native XR", isDirectory: true)
                .appendingPathComponent("Diagnostics", isDirectory: true)
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            let url = directory.appendingPathComponent(
                "avp-native-render-preview__ts=\(timestamp).png"
            )
            try data.write(to: url, options: .atomic)
            latestCaptureURL = url
            status = "First-eye render target exported. Share the PNG below."
        } catch {
            status = "Could not save render preview: \(error.localizedDescription)"
        }
    }

    private func append(record: [String: Any], to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try handle.write(contentsOf: Data([0x0A]))
        try handle.synchronize()
    }

    private func safe(_ value: String) -> String {
        value.replacingOccurrences(
            of: #"[^A-Za-z0-9._-]+"#,
            with: "-",
            options: .regularExpression
        )
    }

    private func array(_ value: SIMD3<Float>) -> [Float] {
        [value.x, value.y, value.z]
    }

    private func array(_ value: SIMD4<Float>) -> [Float] {
        [value.x, value.y, value.z, value.w]
    }

    private func hardwareModel() -> String {
        var size = 0
        guard sysctlbyname("hw.machine", nil, &size, nil, 0) == 0, size > 0 else {
            return "Apple Vision Pro"
        }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.machine", &bytes, &size, nil, 0) == 0 else {
            return "Apple Vision Pro"
        }
        return String(cString: bytes)
    }
}
