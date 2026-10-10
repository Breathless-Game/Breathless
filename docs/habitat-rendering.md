# Low-poly underwater habitats

Rocks, plants and their substrate share a seeded layout. Large outcrops anchor smaller talus; exclusion distances leave open sand channels. Vegetation grows beside these groups with separated roots and varied heights. The darker deep shelf stays sparse while the rising rear reef supports shallower vegetation. A reduced quality tier keeps the same main rocks and plant identities.

Terrain vertices and rooted objects share a height model. Roots sample the **rendered triangle** with barycentric interpolation, rather than only the smooth height function, so a coarse sloping mesh cannot leave a root hovering above it. Boulders are partly buried. Coral and drowned trunks also sit on the substrate. Connected bedrock supports streamed trench blocks, with overlapping corners and a shared world-coordinate profile at chunk boundaries; the diving lane remains clear.

Rock shapes use coherent fracture planes, asymmetric shoulders and small clipped corners. Flat faces stay intact, with restrained mineral colors and darker undersides. Kelp uses tapered, curved ribbons with a raised midrib and attached side leaves. The current bends the whole plant continuously, fixes its root and delays the tip response. Branch joints sample the same displacement as their attachment points. Flat normals come from the displaced triangles, so light changes with the moving facets.

## Source study

The following GitHub sources were read for this work. The project code was written independently; no external source or assets were copied.

- [kchapelier/poisson-disk-sampling — variable-density sampler](https://github.com/kchapelier/poisson-disk-sampling/blob/9536e50c682c8e1d5a5add44a729b7414a276c61/src/implementations/variable-density.js), MIT: position-dependent density, exclusion distances and deterministic sampling. Our small habitat uses bounded rejection sampling around outcrop groups, rather than importing the sampler.
- [olafmeerbeek/Blender-Rock-Generator](https://github.com/olafmeerbeek/Blender-Rock-Generator/blob/main/__init__.py), MIT: seeded shape families, proportions, squash and deliberate bevels. Our mesh uses clipped fracture planes rather than independent radial vertex noise.
- [al-ro grass shader](https://github.com/al-ro/al-ro.github.io/blob/820d1b16e1a3e7418d87bef77f362dc834d08551/projects/grass/grass.js): fixed roots, continuous spatial flow, segmented curved blades and root-to-tip color. The repository does not declare a license; only these general techniques informed the independently written aquatic ribbon geometry and current model.

## Device budgets

| | Low | Medium | High |
| --- | ---: | ---: | ---: |
| Maximum plants | 12 | 30 | 55 |
| Vertices per plant | 73 | 117 | 231 |
| Triangles per plant | 84 | 140 | 284 |
| Water plant draw calls | 1 | 1 | 1 |
| Rock detail | Main outcrops | + companions | + small talus |

Heaven Lake has at most 26 plants. Rock bodies use 44 triangles at low detail and about 88–92 with chipped corners. Static outcrops are batched into one material draw. Kelp updates shader uniforms each frame; it does not upload vertices, rebuild normals or update hundreds of hierarchical segment transforms. A frozen game clock holds its pose while paused. Quality or map changes dispose the old buffers and materials. These budgets do not claim measured frame rates on specific weak hardware.

## Validation

Geometry checks cover closed rock edges, winding, bounds, deterministic shapes, attached kelp branches and finite bounded motion. Habitat tests check spacing, repeated layouts, persistent low-quality anchors, submerged tips and contact with the actual terrain triangles. Browser checks cover maps, quality tiers, underwater viewpoints, day/night, shader compilation, animation without vertex uploads, and resource stability across repeated rebuilds.
