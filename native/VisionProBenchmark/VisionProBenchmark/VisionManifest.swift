import Foundation

enum VisionPlanChoice: String, CaseIterable, Identifiable {
    case regularSmoke
    case regularSanity
    case regularFull
    case stressSmoke
    case stressSanity
    case stressFull

    var id: String { rawValue }

    var title: String {
        switch self {
        case .regularSmoke: return "Regular smoke (1 run)"
        case .regularSanity: return "Regular sanity (2 runs)"
        case .regularFull: return "Regular full (10 runs)"
        case .stressSmoke: return "Stress smoke (1 run)"
        case .stressSanity: return "Stress sanity (2 runs)"
        case .stressFull: return "Stress full (10 runs)"
        }
    }

    var resourceName: String {
        switch self {
        case .regularSmoke:
            return "avp_native_xr_material_complexity_regular_smoke_1sets"
        case .regularSanity:
            return "avp_native_xr_material_complexity_regular_sanity_2sets"
        case .regularFull:
            return "avp_native_xr_material_complexity_regular_10sets"
        case .stressSmoke:
            return "avp_native_xr_material_stress_a_smoke_1sets"
        case .stressSanity:
            return "avp_native_xr_material_stress_a_sanity_2sets"
        case .stressFull:
            return "avp_native_xr_material_stress_a_10sets"
        }
    }
}

struct NativeXRRun: Decodable {
    let runNumber: Int
    let runId: String
    let suiteId: String

    enum CodingKeys: String, CodingKey {
        case runNumber = "run_number"
        case runId = "run_id"
        case suiteId = "suite_id"
    }
}

struct NativeXRPlan: Decodable {
    let schema: String
    let planId: String
    let sourceManifest: String
    let sourceHarnessCommit: String
    let sourceHarnessVersion: String
    let assetRevision: String
    let deviceGroup: String
    let cohortGroup: String
    let runtimeFamily: String
    let api: String
    let mode: String
    let presentationMode: String
    let surfaceMode: String
    let renderScale: Double
    let sourceRenderScale: Double
    let layout: String
    let spacing: Float
    let instances: [Int]
    let trialsPerInstance: Int
    let durationMs: Double
    let warmupMs: Double
    let cooldownMs: Double
    let betweenInstancesMs: Double
    let betweenRunsMs: Double
    let minFrames: Int
    let seed: UInt32
    let shuffle: Bool
    let runCount: Int
    let xrFrontMinZ: Float
    let xrYOffset: Float
    let xrAnchorToFirstPose: Bool
    let xrAnchorMode: String
    let xrStartOnFirstPose: Bool
    let runs: [NativeXRRun]

    enum CodingKeys: String, CodingKey {
        case schema
        case planId = "plan_id"
        case sourceManifest = "source_manifest"
        case sourceHarnessCommit = "source_harness_commit"
        case sourceHarnessVersion = "source_harness_version"
        case assetRevision = "asset_revision"
        case deviceGroup = "device_group"
        case cohortGroup = "cohort_group"
        case runtimeFamily = "runtime_family"
        case api, mode
        case presentationMode = "presentation_mode"
        case surfaceMode = "surface_mode"
        case renderScale = "render_scale"
        case sourceRenderScale = "source_render_scale"
        case layout, spacing, instances
        case trialsPerInstance = "trials_per_instance"
        case durationMs = "duration_ms"
        case warmupMs = "warmup_ms"
        case cooldownMs = "cooldown_ms"
        case betweenInstancesMs = "between_instances_ms"
        case betweenRunsMs = "between_runs_ms"
        case minFrames = "min_frames"
        case seed, shuffle
        case runCount = "run_count"
        case xrFrontMinZ = "xr_front_min_z"
        case xrYOffset = "xr_y_offset"
        case xrAnchorToFirstPose = "xr_anchor_to_first_pose"
        case xrAnchorMode = "xr_anchor_mode"
        case xrStartOnFirstPose = "xr_start_on_first_pose"
        case runs
    }

    static func bundled(_ choice: VisionPlanChoice) throws -> NativeXRPlan {
        guard let url = Bundle.main.url(
            forResource: choice.resourceName,
            withExtension: "json"
        ) else {
            throw VisionManifestError.missingResource(choice.resourceName)
        }
        let plan = try JSONDecoder().decode(
            NativeXRPlan.self,
            from: Data(contentsOf: url)
        )
        try plan.validate()
        return plan
    }

    func validate() throws {
        guard schema == "native-benchmark-manifest/v1" else {
            throw VisionManifestError.invalid("schema must be native-benchmark-manifest/v1")
        }
        guard runtimeFamily == "native-apple", api == "metal" else {
            throw VisionManifestError.invalid("runtime must be native-apple/metal")
        }
        guard deviceGroup == "avp", mode == "xr", presentationMode == "immersive-vr" else {
            throw VisionManifestError.invalid("plan must target AVP immersive VR")
        }
        guard surfaceMode == "basecolor", cohortGroup.contains("material") else {
            throw VisionManifestError.invalid("only the material workload is accepted")
        }
        guard renderScale == 1, sourceRenderScale > 0, sourceRenderScale <= 1 else {
            throw VisionManifestError.invalid("render-scale metadata is invalid")
        }
        guard layout == "xrwall", spacing > 0, !instances.isEmpty,
              instances.allSatisfy({ $0 > 0 }) else {
            throw VisionManifestError.invalid("instance layout is invalid")
        }
        guard trialsPerInstance > 0, durationMs > 0, warmupMs >= 0,
              cooldownMs >= 0, betweenInstancesMs >= 0, betweenRunsMs >= 0,
              minFrames > 0 else {
            throw VisionManifestError.invalid("trial timing is invalid")
        }
        guard xrAnchorToFirstPose, xrAnchorMode == "session", xrStartOnFirstPose else {
            throw VisionManifestError.invalid("XR anchoring must match the browser campaign")
        }
        guard runCount == runs.count, runCount > 0,
              Set(runs.map(\.runId)).count == runs.count else {
            throw VisionManifestError.invalid("run count or run IDs are invalid")
        }
    }
}

enum VisionManifestError: LocalizedError {
    case missingResource(String)
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case .missingResource(let name):
            return "Bundled plan \(name).json is missing."
        case .invalid(let reason):
            return "Native XR plan rejected: \(reason)."
        }
    }
}
