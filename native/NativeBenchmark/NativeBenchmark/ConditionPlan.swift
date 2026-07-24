// ConditionPlan.swift
// Mirrors buildPlan() + shuffleInPlace() + mulberry32() from app-webgl.js exactly.
//
// The web harness builds a flat list of (instances, trial) pairs and optionally
// shuffles it with a seeded PRNG. The native app must reproduce this exactly
// so the condition order matches the paired web runs.
//
// mulberry32 is the same PRNG used in renderer-webgl.js for instance offsets.

import Foundation

struct Condition {
    var instances: Int
    var trial: Int          // 1-based, same as web harness
    var conditionIndex: Int // position in the (possibly shuffled) plan
}

// MARK: - Plan builder
// Mirrors buildPlan() in app-webgl.js:
//   for each inst in instancesList:
//     for t in 1..trials:
//       plan.push({ instances: inst, trial: t })
//   if (shuffle) shuffleInPlace(plan, seed)

func buildConditionPlan(instancesList: [Int], trialsPerInstance: Int, shuffle: Bool, seed: UInt32) -> [Condition] {
    var plan: [(instances: Int, trial: Int)] = []
    for inst in instancesList {
        for t in 1 ... trialsPerInstance {
            plan.append((inst, t))
        }
    }

    if shuffle {
        plan = shuffled(plan, seed: seed)
    }

    return plan.enumerated().map { idx, pair in
        Condition(instances: pair.instances, trial: pair.trial, conditionIndex: idx)
    }
}

// MARK: - mulberry32 PRNG
// Exact port of mulberry32() in renderer-webgl.js:
//   let a = seed >>> 0
//   a |= 0; a = (a + 0x6D2B79F5) | 0
//   let t = Math.imul(a ^ (a >>> 15), 1 | a)
//   t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
//   return ((t ^ (t >>> 14)) >>> 0) / 4294967296

func mulberry32(_ seed: UInt32) -> () -> Double {
    var a = seed
    return {
        a = a &+ 0x6D2B79F5
        var t = (a ^ (a >> 15)) &* (1 | a)
        t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
        return Double(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

// MARK: - Fisher-Yates shuffle using mulberry32
// Mirrors shuffleInPlace() from app-webgl.js

private func shuffled(_ array: [(instances: Int, trial: Int)], seed: UInt32) -> [(instances: Int, trial: Int)] {
    var arr = array
    let rng = mulberry32(seed)
    var n = arr.count
    while n > 1 {
        let k = Int(rng() * Double(n))
        n -= 1
        arr.swapAt(n, k)
    }
    return arr
}
