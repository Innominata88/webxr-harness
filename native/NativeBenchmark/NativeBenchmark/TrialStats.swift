// TrialStats.swift
// Mirrors RunStats.summarize() and deriveExtras() from the web harness exactly.
//
// IMPORTANT — percentile formula:
//   index = floor(p * (n - 1))   ← floor-of-index (NOT linear interpolation)
// This matches the web harness. It differs from R's default (type 7) and
// Python/pandas default. Document this in your methods section.

import Foundation

struct TrialSummary {
    // mirrors summary block
    var frames: Int
    var duration_ms: Double
    var mean_ms: Double
    var p50_ms: Double
    var p95_ms: Double
    var p99_ms: Double

    // mirrors extras block
    var fps_effective: Double
    var fps_from_mean: Double
    var max_frame_ms: Double
    var jank_p99_over_p50: Double
    var missed_1p5x: Int
    var missed_1p5x_pct: Double
    var missed_2x: Int
    var target_ms: Double
}

// MARK: - Main computation

func computeTrialStats(frameTimes: [Double], durationMs: Double) -> TrialSummary {
    let n = frameTimes.count
    guard n > 0 else {
        return TrialSummary(
            frames: 0, duration_ms: durationMs,
            mean_ms: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0,
            fps_effective: 0, fps_from_mean: 0, max_frame_ms: 0,
            jank_p99_over_p50: 0, missed_1p5x: 0, missed_1p5x_pct: 0,
            missed_2x: 0, target_ms: 0
        )
    }

    let sorted = frameTimes.sorted()

    // percentile: floor-of-index on sorted array (mirrors web harness exactly)
    func q(_ p: Double) -> Double {
        let idx = min(n - 1, Int(floor(p * Double(n - 1))))
        return sorted[idx]
    }

    let mean   = frameTimes.reduce(0, +) / Double(n)
    let p50    = q(0.50)
    let p95    = q(0.95)
    let p99    = q(0.99)
    let maxFt  = sorted[n - 1]

    // fps_effective = frames / (duration_ms / 1000)
    // fps_from_mean = 1000 / mean_ms
    let fpsEffective = Double(n) / (durationMs / 1000.0)
    let fpsFromMean  = mean > 0 ? 1000.0 / mean : 0

    // target_ms: snap p50 to nearest standard display period
    let targetMs = nearestTargetMs(p50)

    // jank counts: frames exceeding 1.5x or 2x the target period
    let thresh1p5 = targetMs * 1.5
    let thresh2x  = targetMs * 2.0
    let missed1p5 = frameTimes.filter { $0 > thresh1p5 }.count
    let missed2x  = frameTimes.filter { $0 > thresh2x  }.count
    let missed1p5Pct = Double(missed1p5) / Double(n)

    let jank = p50 > 0 ? p99 / p50 : 0

    return TrialSummary(
        frames: n,
        duration_ms: durationMs,
        mean_ms: mean,
        p50_ms: p50,
        p95_ms: p95,
        p99_ms: p99,
        fps_effective: fpsEffective,
        fps_from_mean: fpsFromMean,
        max_frame_ms: maxFt,
        jank_p99_over_p50: jank,
        missed_1p5x: missed1p5,
        missed_1p5x_pct: missed1p5Pct,
        missed_2x: missed2x,
        target_ms: targetMs
    )
}

// MARK: - nearestTargetMs
// Matches nearestTargetMs() in app-webgl.js:
// snaps p50 to {120, 90, 72, 60 Hz} display periods

private let targetHz: [Double] = [120, 90, 72, 60]

func nearestTargetMs(_ p50: Double) -> Double {
    var best = 1000.0 / 60.0
    var bestDiff = Double.infinity
    for hz in targetHz {
        let period = 1000.0 / hz
        let diff = abs(p50 - period)
        if diff < bestDiff { bestDiff = diff; best = period }
    }
    return best
}
