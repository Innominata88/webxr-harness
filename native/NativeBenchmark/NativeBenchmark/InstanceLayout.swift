// InstanceLayout.swift
// Mirrors genOffsets() in renderer-webgl.js for the layouts used in your manifests.
//
// Your macbook/canvas manifests use layout=xrwall, spacing=0.35.
// The xrwall layout places N instances in a 16:9 grid on the Z=0 plane,
// facing the camera which is at Z=+2.0.

import simd

struct InstanceOffset {
    var x: Float
    var y: Float
    var z: Float
}

// MARK: - xrwall layout
// Exact port of the xrwall branch in genOffsets():
//   targetAspect = 16/9
//   cols = ceil(sqrt(N * 16/9))
//   rows = ceil(N / cols)
//   offset.x = (c - xHalf) * spacing
//   offset.y = (yHalf - r) * spacing
//   offset.z = 0.0

func xrwallOffsets(n: Int, spacing: Float = 0.35) -> [InstanceOffset] {
    let targetAspect: Double = 16.0 / 9.0
    let cols = max(1, Int(ceil(sqrt(Double(n) * targetAspect))))
    let rows = max(1, Int(ceil(Double(n) / Double(cols))))
    let xHalf = Float(cols - 1) / 2.0
    let yHalf = Float(rows - 1) / 2.0

    var offsets = [InstanceOffset]()
    offsets.reserveCapacity(n)
    for i in 0 ..< n {
        let c = i % cols
        let r = i / cols
        offsets.append(InstanceOffset(
            x: (Float(c) - xHalf) * spacing,
            y: (yHalf - Float(r)) * spacing,
            z: 0.0
        ))
    }
    return offsets
}

// MARK: - grid layout (included for completeness)
// side = ceil(sqrt(n)), centered, spacing in X and -Z

func gridOffsets(n: Int, spacing: Float = 0.35) -> [InstanceOffset] {
    let side = Int(ceil(sqrt(Double(n))))
    let half = Float(side - 1) / 2.0
    var offsets = [InstanceOffset]()
    offsets.reserveCapacity(n)
    for i in 0 ..< n {
        let gx = Float(i % side) - half
        let gz = Float(i / side) - half
        offsets.append(InstanceOffset(x: gx * spacing, y: 0, z: -gz * spacing))
    }
    return offsets
}

// MARK: - line layout (default in web harness when no layout param)

func lineOffsets(n: Int, spacing: Float = 0.35) -> [InstanceOffset] {
    return (0 ..< n).map { i in
        InstanceOffset(x: 0, y: 0, z: -Float(i) * spacing)
    }
}
