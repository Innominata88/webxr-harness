# Native Cross-Device Comparison Plan

Last updated: 2026-07-24

## Goal

Add a native comparison branch that answers a narrower question than the browser study:

- On the same device, how far are the browser results from a platform-native renderer under the same workload shape?

This should be treated as a companion study, not a replacement for the browser results.

## Key Decision

Do **not** try to build one monolithic native app for every device first.

Use three native harness families that share the same experimental contract:

1. `Apple / Metal`
2. `Android / Vulkan / OpenXR`
3. `Windows / D3D11 / OpenXR`

That is the smallest design that is still technically defensible.

## Why This Split Is Better Than "One Native App"

- The repo already has a working `macOS` `Metal` runner:
  - `native/NativeBenchmark/SETUP.md`
  - `native/NativeBenchmark/NativeBenchmark/BenchmarkRunner.swift`
  - `native/NativeBenchmark/NativeBenchmark/ManifestLoader.swift`
- `AVP`, `iPad Air`, and `MacBook Pro` naturally belong in the same `Metal` family.
- `Pixel 8a`, `Samsung FE`, `Quest`, and `Magic Leap 2` naturally belong in the same `Android` family.
- `HP Laptop` and `HoloLens 2` naturally belong in the same `Windows` family.
- Trying to force one rendering/runtime stack across Apple, Android, and Windows mixed-reality devices would create more framework work than benchmark work.

## Shared Experimental Contract

Every native family should preserve the following from the browser study:

- same asset
- same instance ladders
- same trial counts
- same duration / warmup / cooldown semantics
- same layout and spacing semantics
- same seeded condition shuffle
- same JSONL output schema where possible
- same summary metrics:
  - `mean_ms`
  - `p95_ms`
  - `fps_effective`

The current `Metal` runner already does most of this by reading the same manifest rows and emitting schema-compatible JSONL:

- manifest compatibility:
  - `native/NativeBenchmark/NativeBenchmark/ManifestLoader.swift`
- condition order compatibility:
  - `native/NativeBenchmark/NativeBenchmark/ConditionPlan.swift`
- output record compatibility:
  - `native/NativeBenchmark/NativeBenchmark/BenchmarkRunner.swift`

### Current Metal Runner Audit

The current runner is a useful implementation seed, but it is not yet ready for
native material collection.

Two issues must be fixed before collecting paper data:

1. The renderer only implements the flat, solid-white path.
   - `native/NativeBenchmark/NativeBenchmark/Shaders.metal` has no UV,
     base-color-factor, texture, sampler, or per-primitive material support.
   - Loading a `material_complexity` manifest therefore does not produce the
     same workload as browser `surfaceMode=basecolor`.
   - Native output must not be labeled `material` until visual and renderer
     parity checks pass.
2. The manifest runner executes every browser API row.
   - A paired full manifest has five WebGL2 rows and five WebGPU rows.
   - Running all rows produces ten Metal runs rather than five independent
     Metal repetitions.
   - The native plan must select one parameter template and generate its own
     five-run schedule.

These are implementation gaps, not problems with the collected browser data.
They should be closed before the first native pilot.

## Important Method Rule

Do **not** force a fake "native canvas" result onto devices where the natural native path is immersive.

Use this comparison rule instead:

- `desktop / tablet / phone windowed content`:
  - compare browser `canvas` to native `windowed/canvas`
- `XR headsets and spatial devices`:
  - compare browser `XR` to native `immersive XR`
- `phone AR / passthrough AR`:
  - compare browser `immersive-ar` to native `AR`

This matters because browser `canvas` on a headset is often a 2D browser surface in the system compositor, which is not the same as a native immersive rendering loop.

## Recommended Native Matrix

| Device | Existing browser modes | Native family | Recommended native API/runtime | Native v1 target |
| --- | --- | --- | --- | --- |
| `MacBook Pro M1` | `canvas` | Apple | `Metal` | windowed `canvas` |
| `iPad Air` | `canvas` | Apple | `Metal` | windowed `canvas` |
| `AVP` | `canvas`, `xr` | Apple | `Metal` + visionOS immersive path | windowed + immersive |
| `Pixel 8a` | `canvas`, `xr`, `ar` | Android | `Vulkan` + `ARCore` for AR | windowed + AR |
| `Samsung FE` | `canvas`, `xr`, `ar` | Android | `Vulkan` + `ARCore` for AR | windowed + AR |
| `Quest 2` | `canvas`, `xr` | Android | `OpenXR` + `Vulkan` | immersive XR |
| `Magic Leap 2` | browser branch failed | Android | `OpenXR` + `Vulkan` | immersive AR/XR |
| `HP Laptop` | `canvas` | Windows | `D3D11` | windowed `canvas` |
| `HoloLens 2` | browser branch caveated | Windows | `OpenXR` + `D3D11` | immersive AR/XR |

## Platform Choices

### 1. Apple Family

Use `Metal` everywhere.

Devices:
- `MacBook Pro M1`
- `iPad Air`
- `AVP`

Why:
- the existing repo already has a `Metal` benchmark runner
- Apple documents `Metal` as the low-level rendering path for iOS / iPadOS AR and for visionOS immersive rendering

Primary sources:
- ARKit + Metal:
  - https://developer.apple.com/documentation/arkit/displaying-an-ar-experience-with-metal
- visionOS migration guidance:
  - https://developer.apple.com/documentation/visionos/bringing-your-arkit-app-to-visionos
- Metal / visionOS overview:
  - https://developer.apple.com/documentation/metal

Recommendation:
- extend the current `NativeBenchmark` app family instead of starting over
- keep `MacBook Pro` as the first completed native branch
- then port the same renderer logic to `iPad Air`
- then adapt the renderer to `AVP` for immersive mode

### 2. Android Family

Use `Vulkan` as the primary native renderer.

Devices:
- `Pixel 8a`
- `Samsung FE`
- `Quest 2`
- `Magic Leap 2`

Why:
- Android supports native `Vulkan`
- ARCore now exposes a documented Vulkan path for native AR apps
- Quest native development is centered on native `OpenXR` samples and runtime support
- Magic Leap 2 native development strongly recommends `Vulkan`

Primary sources:
- Android NDK Vulkan:
  - https://developer.android.com/ndk/guides/graphics/
  - https://developer.android.com/ndk/guides/graphics/getting-started
- ARCore Vulkan native path:
  - https://developers.google.com/ar/develop/vulkan
  - https://developers.google.com/ar/develop/c/vulkan
- Meta Quest native OpenXR SDK:
  - https://github.com/meta-quest/Meta-OpenXR-SDK
- Magic Leap 2 native setup:
  - https://ml2-developer.magicleap.com/learn/docs/guides/native/getting-started/native-setup-overview
- Magic Leap 2 OpenXR extensions:
  - https://developer-docs.magicleap.cloud/docs/guides/openxr/magic-leap-extensions/

Recommendation:
- build one shared `Android NDK` benchmark app with:
  - `windowed / canvas-like` mode for `Pixel` and `Samsung`
  - `ARCore` mode for phone AR comparison
  - `OpenXR` mode for `Quest` and `Magic Leap 2`
- use `Vulkan` first
- only add `OpenGL ES` later if you decide you need a native `GLES` vs `Vulkan` comparison on Android

### 3. Windows Family

Use `D3D11` as the primary native renderer.

Devices:
- `HP Laptop`
- `HoloLens 2`

Why:
- `HoloLens 2` native development is documented around `OpenXR`
- Microsoft documents `Direct3D 11/12` integration for OpenXR on mixed-reality devices
- `HP Laptop` can use the same rendering family for the desktop `canvas` case

Primary sources:
- HoloLens / Windows Mixed Reality OpenXR:
  - https://learn.microsoft.com/en-us/windows/mixed-reality/develop/native/openxr
  - https://learn.microsoft.com/en-us/windows/mixed-reality/develop/native/openxr-getting-started
- Native development overview:
  - https://learn.microsoft.com/en-us/windows/mixed-reality/develop/native/directx-development-overview

Recommendation:
- create a small `Windows` renderer core in `D3D11`
- run it windowed on `HP Laptop`
- use the same mesh / transform / timing logic under `OpenXR` on `HoloLens 2`

## What "Comparable" Means In Practice

The native branch does **not** need to reproduce browser internals. It needs to preserve workload structure.

That means:
- same asset revision
- same transform normalization
- same instance placement
- same one-draw-call instancing pattern if possible
- same timing summaries
- same per-trial JSONL structure

It does **not** mean:
- same shaders byte-for-byte across all platforms
- same compositor path
- same present model
- same driver behavior

The browser-vs-native question is therefore:

- how much overhead / behavioral difference is introduced by the browser/runtime path on each platform?

not:

- can native and browser be made physically identical in every rendering detail?

## Minimum Viable Native Program

Do this in phases.

### Phase 1: Finish One Native Family End-to-End

Start with the family that already has code in the repo:

1. `MacBook Pro M1 native Metal canvas`
2. `iPad Air native Metal canvas`
3. `AVP native immersive Metal`

Deliverable:
- one complete Apple-native comparison branch using the same asset and matching manifest-driven parameters

Why first:
- lowest implementation risk
- immediate leverage from existing `NativeBenchmark`
- fastest route to a complete native comparison

Before the first full run:
- implement separate `flat` and `basecolor` renderer paths
- add material parity screenshots at `1i` and `16i`
- generate five native repetitions instead of replaying all ten paired-browser rows
- validate the output with the existing ingestion and quality tools

### Phase 2: Build the Shared Android Native Harness

Start with phones before XR headsets:

1. `Pixel 8a native Vulkan canvas`
2. `Samsung FE native Vulkan canvas`
3. `Pixel 8a native ARCore Vulkan AR`
4. `Samsung FE native ARCore Vulkan AR`

Then extend to headsets:

5. `Quest native OpenXR Vulkan`
6. `Magic Leap 2 native OpenXR Vulkan`

Why this order:
- phones give the cleanest browser-vs-native comparison because you already have strong browser results there
- Quest and Magic Leap can reuse the Android native core but swap the runtime layer to `OpenXR`

### Phase 3: Build the Windows Native Harness

1. `HP Laptop native D3D11 canvas`
2. `HoloLens 2 native OpenXR D3D11`

Why last:
- separate toolchain
- least code reuse with the current repo
- but still valuable because it closes the desktop Windows and enterprise headset branch

## Recommended Output Schema Changes

Keep the current JSONL schema shape and add only the fields needed to identify the native runtime cleanly.

Retain:
- `api`
- `mode`
- `summary`
- `extras`
- `env`
- `suiteId`
- `runId`
- `instances`
- `trial`

Set `api` to one of:
- `metal`
- `vulkan`
- `d3d11`
- optional later: `opengles`

Add inside `env`:
- `runtime_family`
  - `native-apple`
  - `native-android`
  - `native-windows`
- `xr_runtime`
  - `openxr`
  - `arkit`
  - `arcore`
  - `visionos-immersive`
  - empty for plain canvas
- `device_model`
- `os_version`
- `graphics_driver` where available

Do **not** overload `browser` to carry native runtime identity long-term. The current macOS runner sets `browser=native-metal`; that is workable temporarily, but this should become explicit runtime metadata if native becomes a real study branch.

## What Not To Do

- Do not try to build native `XR` for every device before you finish one complete family.
- Do not require two native graphics APIs per platform in the first pass.
- Do not force "canvas" onto immersive headsets when immersive is the natural native path.
- Do not invent a second benchmark schema if the current JSONL format can be preserved.
- Do not block native work on the unresolved browser-headset caveats.

## Recommended Immediate Work

Use this sequence to move from planning into validated collection:

1. `Promote native from optional to required in your working narrative`
   - stop describing it as future work
2. `Finish the current Mac Metal branch end-to-end`
   - correct native run scheduling
   - implement and visually validate `basecolor`
   - smoke + full material
   - then flat/primary as a separate suite
3. `Write the Android native app spec`
   - one renderer core
   - `windowed`, `ARCore`, and `OpenXR` run modes
4. `Define the native JSONL contract`
   - do this before you write device-specific code
5. `Pick one Android pilot device`
   - `Pixel 8a` is the best first pilot because the browser results are already clean and interesting

## Repo Follow-Up

This doc supersedes the older assumption that native is only a `Mac canvas` side branch:
- `docs/remaining-experiments-checklist.md`
- `docs/remaining-experiments-tracker.md`
- `analysis/imc-2026-short-paper-outline.md`

Those files should be updated later after you decide whether to expand native into the main paper or keep it as a companion extension.
