# Native Experiment Plans

All files use `native-benchmark-manifest/v1`. Browser paired manifests are
parameter sources only; they are never replayed directly by a native runner.

## Ready Plans

| Device | Mode | Surface | Render scale | Smoke | Full |
| --- | --- | --- | ---: | ---: | ---: |
| MacBook Pro M1 | Canvas | material/basecolor | 1.00 | 1 run, 1 condition | 5 runs, 30 conditions/run |
| MacBook Pro M1 | Canvas | flat | 1.00 | 1 run, 1 condition | 5 runs, 50 conditions/run |
| Pixel 8a | Canvas | material/basecolor | 0.50 | 1 run, 1 condition | 5 runs, 30 conditions/run |
| Pixel 8a | Canvas | flat | 0.50 | 1 run, 1 condition | 5 runs, 30 conditions/run |
| Samsung Galaxy FE | Canvas | material/basecolor | 0.75 | 1 run, 1 condition | 5 runs, 30 conditions/run |
| Samsung Galaxy FE | Canvas | flat | 0.75 | 1 run, 1 condition | 5 runs, 50 conditions/run |

Smoke plans are visual/schema gates, not experimental cohorts. Full plans must
not be run until the matching smoke plan is visually correct and its output
passes `tools/validate-native-results.mjs`.

## Surface Separation

- `surface_mode=basecolor` is used only by suite IDs containing `MATERIAL`.
- `surface_mode=flat` is used only by non-material suites.
- Native result validation rejects a mismatch in either direction.

## Render Scale

`render_scale` comes from the source browser manifest's
`canvasScaleFactor`. It is part of the workload definition:

- MacBook Pro M1: `1.00`
- Pixel 8a: `0.50`
- Samsung Galaxy FE: `0.75`

The generator rejects source rows that mix render scales. Native runners must
apply the value and report the requested scale and resulting drawable size.

## AR Plans Are Not Generated Yet

Phone AR material and stress sources exist in dated manifest packs, but AR
plans require additional fields that the current canvas generator deliberately
does not model:

- ARCore camera passthrough requirement
- tracking and stable-pose start gate
- placement/anchor mode
- native object scale and offset
- tracking-loss grace and abort rules

Generating AR plans before those fields are part of the native schema would
produce incomplete protocol artifacts. Add a dedicated AR conversion path only
after the ARCore runtime contract is implemented and tested.
