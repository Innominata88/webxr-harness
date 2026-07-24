// BenchmarkRunner.swift
// Runs native-benchmark-manifest/v1 plans and emits schema-compatible JSONL.

import Foundation
import MetalKit
import Darwin

struct BenchmarkConfig {
    var instancesList: [Int] = [64, 128, 192, 256, 320]
    var trialsPerInstance = 10
    var durationMs: Double = 6_000
    var warmupMs: Double = 500
    var cooldownMs: Double = 250
    var betweenInstancesMs: Double = 800
    var minFrames = 30
    var layout = "xrwall"
    var spacing: Float = 0.35
    var seed: UInt32 = 12345
    var shuffle = true
    var surfaceMode = "flat"
    var renderScale: Double = 1
    var deviceGroup = "macbookpro_m1"
    var cohortGroup = "canvas_primary_regular"
    var harnessVersion = "native-1.0.0"
    var harnessCommit = ""
    var assetRevision = ""
    var suiteId = ""
}

@MainActor
class BenchmarkRunner: ObservableObject {
    @Published var status = "Ready"
    @Published var progress: Double = 0
    @Published var isRunning = false
    @Published var loadedManifest: ManifestFile?

    var mesh: GLBMesh?
    private var renderer: BenchmarkRenderer?

    func loadModel(url: URL) async throws {
        status = "Loading model..."
        let data = try Data(contentsOf: url)
        let loaded = try loadGLBMesh(data: data)
        mesh = loaded
        status = [
            "Model loaded:",
            "\(loaded.meta.vertexCount) verts,",
            "\(loaded.meta.primitiveCount) material primitives,",
            "\(loaded.meta.materialTextureCount) base-color textures",
        ].joined(separator: " ")
    }

    func loadManifest(url: URL) throws {
        let manifest = try loadNativeManifest(url: url)
        loadedManifest = manifest
        status = [
            "Native plan loaded:",
            "\(manifest.rows.count) \(manifest.api) runs,",
            "\(manifest.surfaceMode),",
            "\(manifest.deviceGroup)/\(manifest.cohortGroup)",
        ].joined(separator: " ")
    }

    func runFromManifest(
        renderer: BenchmarkRenderer,
        mtkView: MTKView,
        rowLimit: Int = 0
    ) async {
        guard let manifest = loadedManifest else {
            status = "No native plan loaded"
            return
        }
        guard !manifest.rows.isEmpty else {
            status = "Native plan has no runs"
            return
        }
        guard let mesh else {
            status = "No model loaded"
            return
        }

        self.renderer = renderer
        do {
            try renderer.uploadMesh(mesh)
        } catch {
            status = "Model upload failed: \(error.localizedDescription)"
            return
        }

        isRunning = true
        progress = 0
        defer { isRunning = false }

        let rows = rowLimit > 0
            ? Array(manifest.rows.prefix(rowLimit))
            : manifest.rows
        for (index, row) in rows.enumerated() {
            do {
                try renderer.setSurfaceMode(row.surfaceMode)
                applyRenderScale(row.renderScale, to: mtkView)
            } catch {
                status = "Run rejected: \(error.localizedDescription)"
                return
            }

            status = "Native run \(index + 1)/\(rows.count): \(row.runId)"
            let completed = await executeRow(
                row,
                deviceGroup: manifest.deviceGroup,
                cohortGroup: manifest.cohortGroup
            )
            guard completed else { return }
            progress = Double(index + 1) / Double(rows.count)

            if index < rows.count - 1 && row.cooldownAfterMs > 0 {
                let seconds = Int(row.cooldownAfterMs / 1000)
                status = "Between-run cooldown: \(seconds) seconds"
                try? await Task.sleep(
                    nanoseconds: UInt64(row.cooldownAfterMs * 1_000_000)
                )
            }
        }
        status = "All native runs complete."
    }

    func runManual(
        config: BenchmarkConfig,
        renderer: BenchmarkRenderer,
        mtkView: MTKView
    ) async {
        guard let mesh else {
            status = "No model loaded"
            return
        }

        self.renderer = renderer
        do {
            try renderer.uploadMesh(mesh)
            try renderer.setSurfaceMode(config.surfaceMode)
            applyRenderScale(config.renderScale, to: mtkView)
        } catch {
            status = "Manual run rejected: \(error.localizedDescription)"
            return
        }

        isRunning = true
        progress = 0
        defer { isRunning = false }

        let row = ManifestRunConfig(
            runNumber: 1,
            suiteId: config.suiteId.isEmpty
                ? "MACBOOKPRO_M1_NATIVE_CANVAS_FLAT_MANUAL"
                : config.suiteId,
            runId: "macbookpro_m1_native_manual_\(Int(Date().timeIntervalSince1970))",
            cooldownAfterMs: 0,
            surfaceMode: config.surfaceMode,
            renderScale: config.renderScale,
            instancesList: config.instancesList,
            trialsPerInstance: config.trialsPerInstance,
            durationMs: config.durationMs,
            warmupMs: config.warmupMs,
            cooldownMs: config.cooldownMs,
            betweenInstancesMs: config.betweenInstancesMs,
            minFrames: config.minFrames,
            layout: config.layout,
            spacing: config.spacing,
            seed: config.seed,
            shuffle: config.shuffle,
            runtimeFamily: "native-apple",
            planId: "manual",
            sourceManifest: "",
            harnessCommit: config.harnessCommit,
            harnessVersion: config.harnessVersion,
            assetRevision: config.assetRevision
        )

        let completed = await executeRow(
            row,
            deviceGroup: config.deviceGroup,
            cohortGroup: config.cohortGroup
        )
        status = completed ? "Manual run complete." : status
    }

    private func applyRenderScale(_ scale: Double, to view: MTKView) {
        view.autoResizeDrawable = false
        let backingSize = view.convertToBacking(view.bounds).size
        view.drawableSize = CGSize(
            width: max(1, backingSize.width * scale),
            height: max(1, backingSize.height * scale)
        )
    }

    private func executeRow(
        _ row: ManifestRunConfig,
        deviceGroup: String,
        cohortGroup: String
    ) async -> Bool {
        guard let renderer else { return false }

        let plan = buildConditionPlan(
            instancesList: row.instancesList,
            trialsPerInstance: row.trialsPerInstance,
            shuffle: row.shuffle,
            seed: row.seed
        )

        let outputURL: URL
        do {
            outputURL = try prepareOutput(
                row: row,
                deviceGroup: deviceGroup,
                cohortGroup: cohortGroup
            )
        } catch {
            status = "Could not create output: \(error.localizedDescription)"
            return false
        }

        var lastInstances: Int?
        for (planIndex, condition) in plan.enumerated() {
            if let previous = lastInstances, previous != condition.instances {
                try? await Task.sleep(
                    nanoseconds: UInt64(row.betweenInstancesMs * 1_000_000)
                )
            }
            lastInstances = condition.instances
            renderer.setInstances(
                n: condition.instances,
                layout: row.layout,
                spacing: row.spacing
            )

            let startedAt = ISO8601DateFormatter().string(from: Date())
            status = [
                "Run \(row.runNumber):",
                "\(condition.instances)i,",
                "trial \(condition.trial)/\(row.trialsPerInstance),",
                "condition \(planIndex + 1)/\(plan.count)",
            ].joined(separator: " ")

            let result = await runSingleTrial(
                renderer: renderer,
                warmupMs: row.warmupMs,
                durationMs: row.durationMs,
                minFrames: row.minFrames
            )
            let record = buildRecord(
                row: row,
                condition: condition,
                totalConditions: plan.count,
                startedAt: startedAt,
                frameTimes: result.frameTimes,
                durationMs: result.durationMs,
                aborted: result.aborted,
                abortCode: result.abortCode
            )

            guard let line = encodeJSONLine(record) else {
                status = "Could not encode result for \(row.runId)"
                return false
            }
            do {
                try append(line: line, to: outputURL)
            } catch {
                status = "Could not append result: \(error.localizedDescription)"
                return false
            }

            if planIndex < plan.count - 1 {
                try? await Task.sleep(
                    nanoseconds: UInt64(row.cooldownMs * 1_000_000)
                )
            }
        }

        status = "Saved: \(outputURL.lastPathComponent)"
        return true
    }

    private struct TrialResult {
        var frameTimes: [Double]
        var durationMs: Double
        var aborted: Bool
        var abortCode: String
    }

    private func runSingleTrial(
        renderer: BenchmarkRenderer,
        warmupMs: Double,
        durationMs: Double,
        minFrames: Int
    ) async -> TrialResult {
        await withCheckedContinuation { continuation in
            renderer.onTrialComplete = { frameTimes, measuredDurationMs in
                renderer.onTrialComplete = nil
                continuation.resume(returning: TrialResult(
                    frameTimes: frameTimes,
                    durationMs: measuredDurationMs,
                    aborted: false,
                    abortCode: ""
                ))
            }
            renderer.startTrial(
                warmupMs: warmupMs,
                durationMs: durationMs,
                minFrames: minFrames
            )
        }
    }

    private func buildRecord(
        row: ManifestRunConfig,
        condition: Condition,
        totalConditions: Int,
        startedAt: String,
        frameTimes: [Double],
        durationMs: Double,
        aborted: Bool,
        abortCode: String
    ) -> [String: Any] {
        var record: [String: Any] = [
            "schema_version": "1.1.0",
            "api": "metal",
            "mode": "canvas",
            "surface_mode": row.surfaceMode,
            "surfaceMode": row.surfaceMode,
            "canvasScaleFactor": row.renderScale,
            "render_scale": row.renderScale,
            "modelUrl": row.assetRevision,
            "trial": condition.trial,
            "trials": row.trialsPerInstance,
            "instances": condition.instances,
            "condition_index": condition.conditionIndex,
            "condition_count": totalConditions,
            "suiteId": row.suiteId,
            "runId": row.runId,
            "startedAt": startedAt,
            "layout": row.layout,
            "spacing": row.spacing,
            "seed": row.seed,
            "shuffle": row.shuffle,
            "durationMs": row.durationMs,
            "warmupMs": row.warmupMs,
            "cooldownMs": row.cooldownMs,
            "betweenInstancesMs": row.betweenInstancesMs,
            "minFrames": row.minFrames,
            "collectPerf": false,
            "perfDetail": false,
            "aborted": aborted,
            "abort_code": abortCode,
            "abort_reason": aborted ? "Trial did not complete." : "",
        ]

        record["env"] = [
            "platform": "macOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
            "device_model": hardwareModel(),
            "os_version": ProcessInfo.processInfo.operatingSystemVersionString,
            "runtime_family": row.runtimeFamily,
            "runtime_mode": "window",
            "xr_runtime": "none",
            "renderer_path": "metal-\(row.surfaceMode)",
            "surface_mode": row.surfaceMode,
            "surfaceMode": row.surfaceMode,
            "render_scale": row.renderScale,
            "drawable_width": renderer?.drawableSize.width ?? 0,
            "drawable_height": renderer?.drawableSize.height ?? 0,
            "gpu_renderer": renderer?.device.name ?? "",
            "timing_source_primary": "mtkview_draw_callback",
            "browser": "native",
            "harness_version": row.harnessVersion,
            "harness_commit": row.harnessCommit,
            "asset_revision": row.assetRevision,
            "plan_id": row.planId,
            "source_manifest": row.sourceManifest,
            "hardwareConcurrency": ProcessInfo.processInfo.activeProcessorCount,
        ] as [String: Any]

        if let meta = renderer?.loadedMeshMeta {
            record["scene"] = [
                "surface_mode": row.surfaceMode,
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
                "norm_center": [
                    meta.normCenter.x,
                    meta.normCenter.y,
                    meta.normCenter.z,
                ],
                "norm_max_dim": meta.normMaxDim,
            ] as [String: Any]
        }

        guard !aborted else { return record }
        let stats = computeTrialStats(
            frameTimes: frameTimes,
            durationMs: durationMs
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
        ] as [String: Any]
        return record
    }

    private func prepareOutput(
        row: ManifestRunConfig,
        deviceGroup: String,
        cohortGroup: String
    ) throws -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let timestamp = formatter.string(from: Date())
        let filename = [
            "results__run=\(safe(row.runId))",
            "a=metal",
            "m=canvas",
            "s=\(safe(row.surfaceMode))",
            "d=\(safe(deviceGroup))",
            "ts=\(timestamp).jsonl",
        ].joined(separator: "__")
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Downloads/Data Collection")
            .appendingPathComponent(deviceGroup)
            .appendingPathComponent(cohortGroup)

        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let outputURL = directory.appendingPathComponent(filename)
        try Data().write(to: outputURL, options: .atomic)
        return outputURL
    }

    private func append(line: String, to url: URL) throws {
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        guard let data = "\(line)\n".data(using: .utf8) else {
            throw CocoaError(.fileWriteInapplicableStringEncoding)
        }
        try handle.write(contentsOf: data)
        try handle.synchronize()
    }

    private func safe(_ value: String) -> String {
        value.replacingOccurrences(
            of: #"[^A-Za-z0-9._-]+"#,
            with: "-",
            options: .regularExpression
        )
    }

    private func hardwareModel() -> String {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else {
            return ""
        }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &bytes, &size, nil, 0) == 0 else {
            return ""
        }
        return String(cString: bytes)
    }

    private func encodeJSONLine(_ record: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(
            withJSONObject: record,
            options: [.sortedKeys]
        ) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
