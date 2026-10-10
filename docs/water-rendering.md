# Water rendering

The water is a continuous, gently rolling triangle mesh. Its flat face normals come from the displaced vertices. A fixed spatial pigment field supplies blue, teal and green polygon colors; slope-based shading changes their brightness continuously. Sun/moon reflection follows the actual face normal and view direction. This preserves obvious geometric color blocks across the sea, including outside the bright reflection path, with no detached reflection masks. The reflected sky is restrained to preserve the blue-green body color. Above water, the surface hides deep rock silhouettes that previously resembled enormous facets; crossing the waterline eases into a translucent underside.

## Source references

The following GitHub implementations were read before the rewrite:

- [José Villegas — LowPolyWater, no-geometry-stage shader](https://github.com/jose-villegas/LowPolyWater/blob/92c7d5e97002fd4f14623294e46213c14fc12dae/Assets/Shaders/LowPolyWater%20%28No%20Geometry%20Stage%29.shader): sums of directional waves, slope-based lighting, specular and Fresnel response. MIT licensed.
- [Daniel Zeller — Lowpoly Water](https://github.com/danielzeller/Lowpoly-Water-Unity/blob/4551e67512ff57abdc5e0872ec8e8644ae1a9e01/Assets/Scripts/Water.cs) and [its shader](https://github.com/danielzeller/Lowpoly-Water-Unity/blob/4551e67512ff57abdc5e0872ec8e8644ae1a9e01/Assets/Shaders/FlatShadedWaterWithEdgeBlend.shader): the wave geometry and face normal determine low-poly lighting. MIT licensed.
- [Three.js r170 flat normal calculation](https://github.com/mrdoob/three.js/blob/r170/src/renderers/shaders/ShaderChunk/normal_fragment_begin.glsl.js): screen derivatives of the displaced position produce a face normal even when the geometry shares indexed vertices.

This implementation was written for the existing Three.js material, time, weather and quality systems. No source files or assets from the Unity examples were copied. It uses neither their CPU mesh updates nor their offscreen reflection/depth passes.

## Geometry and device budgets

| | Low | Medium | High |
| --- | ---: | ---: | ---: |
| Grid | 64 × 32 | 96 × 48 | 128 × 72 |
| Triangles | 4,096 | 9,216 | 18,432 |
| Shared vertices | 2,145 | 4,753 | 9,417 |
| Directional waves | 2 | 3 | 4 |
| Vertex + index buffer size | 91 KiB | 203 KiB | 402 KiB |

The grid varies its spacing across the visible area, with staggered rows, deterministic offsets and short diagonals. Large and small facets mix without gaps or a straight seam down the view. A flat shader varying derives each face pigment from existing coordinates, adding no vertex attributes. Indexed vertices replace duplicated triangles and the two old per-face attributes. High quality has finer faces while using fewer unique vertices than the prior 12,960-vertex surface. All index buffers fit in 16 bits.

Waves run in the vertex shader. Flat normals are derived in the existing material shader; no water position/normal buffer is uploaded per frame. Water still uses one draw, with no new texture or render target. Existing pixel caps, antialias settings, weak-device defaults and automatic downgrades apply. These are workload budgets, not measured frame-rate guarantees for specific phones or integrated GPUs.

## Shared motion

`water-waves.ts` defines the wave coefficients once and generates the GLSL from them. CPU boat/buoy heights and slopes use those same coefficients, quality tier, map amplitude, wind swell and frozen game-time clock. Paused previews can re-pose objects without advancing the waves.

## Validation

Geometry tests cover triangle winding, area, closed shared edges, shape quality and deterministic reconstruction. Wave tests cover bounded long-running motion, analytic slopes versus numerical derivatives, small quality-tier differences, shared-corner motion and repeatable paused samples. Browser checks cover day/night, maps, weather, quality changes, effects off and underwater views, plus animated GPU waves with unchanged position buffers.
