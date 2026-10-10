# Low-poly underwater habitats

Rocks, plants and their substrate share a seeded layout. Large outcrops anchor smaller talus; exclusion distances leave open sand channels. Vegetation grows beside these groups with separated roots and varied heights. The darker deep shelf stays sparse while the rising rear reef supports shallower vegetation. A reduced quality tier keeps the same main rocks and plant identities. A separate seed adds 35 small stones per map without moving the earlier rocks or roots; the added stones avoid the full plant pool.

Terrain vertices and rooted objects share a height model. Roots sample the **rendered triangle** with barycentric interpolation, rather than only the smooth height function, so a coarse sloping mesh cannot leave a root hovering above it. Boulders are partly buried. Coral and drowned trunks also sit on the substrate. Connected bedrock supports streamed trench blocks, with overlapping corners and a shared world-coordinate profile at chunk boundaries; the diving lane remains clear.

Rock shapes use coherent fracture planes, asymmetric shoulders and small clipped corners. Fixed per-triangle pigments restore the multicolor polygon artwork on the seabed, rocks and walls, including coplanar triangles. Map palettes distinguish cold teal/slate Fjord, ochre/jade Heaven Lake, and cyan/blue Open Ocean. Colors are written at generation time and cannot flicker during animation.

Water plants have three seeded forms: long narrow ribbons (55% selection weight), the original strap with triangular side leaves (30%), and broader curved fronds (15%). The seed also varies width, curl, orientation, phase and pigment. Existing height/root identities survive rebuilds and quality changes. All three forms appear at every quality tier on all three maps. The current bends each plant continuously, fixes its root and delays the tip response. Branch joints sample the same displacement as their attachment points. Flat normals come from the displaced triangles, so light changes with the moving facets.

## Source study

The following GitHub sources were read for this work. The project code was written independently; no external source or assets were copied.

- [kchapelier/poisson-disk-sampling — variable-density sampler](https://github.com/kchapelier/poisson-disk-sampling/blob/9536e50c682c8e1d5a5add44a729b7414a276c61/src/implementations/variable-density.js), MIT: position-dependent density, exclusion distances and deterministic sampling. Our small habitat uses bounded rejection sampling around outcrop groups, rather than importing the sampler.
- [olafmeerbeek/Blender-Rock-Generator](https://github.com/olafmeerbeek/Blender-Rock-Generator/blob/main/__init__.py), MIT: seeded shape families, proportions, squash and deliberate bevels. Our mesh uses clipped fracture planes rather than independent radial vertex noise.
- [al-ro grass shader](https://github.com/al-ro/al-ro.github.io/blob/820d1b16e1a3e7418d87bef77f362dc834d08551/projects/grass/grass.js): fixed roots, continuous spatial flow, segmented curved blades and root-to-tip color. The repository does not declare a license; only these general techniques informed the independently written aquatic ribbon geometry and current model.

## Device budgets

| | Low | Medium | High |
| --- | ---: | ---: | ---: |
| Maximum plants | 16 | 40 | 72 |
| Ribbon vertices per plant | 54 | 81 | 108 |
| Legacy strap vertices per plant | 77 | 89 | 101 |
| Broad frond vertices per plant | 102 | 123 | 204 |
| Water plant draw calls | 1 | 1 | 1 |
| Rock detail | Main outcrops | + companions | + small talus |

Heaven Lake has at most 38 plants. The high-tier fields have 9,083 / 4,802 / 8,877 vertices for Fjord / Heaven Lake / Open Ocean. Thin forms allow denser growth with fewer vertices than the former all-broad-frond field. Trench density is independent of plant count, so increasing vegetation does not change the existing wall layout. Rock bodies use 44 triangles at low detail and about 88–92 with chipped corners. Static outcrops are batched into one material draw. Kelp updates shader uniforms each frame; it does not upload vertices, rebuild normals or update hundreds of hierarchical segment transforms. A frozen game clock holds its pose while paused. Quality or map changes dispose the old buffers and materials. These budgets do not claim measured frame rates on specific weak hardware.

## Validation

Geometry checks cover closed rock edges, winding, bounds, deterministic shapes, attached kelp branches and finite bounded motion. Habitat tests check spacing, repeated layouts, persistent low-quality anchors, submerged tips and contact with the actual terrain triangles. Browser checks cover maps, quality tiers, underwater viewpoints, day/night, shader compilation, animation without vertex uploads, and resource stability across repeated rebuilds.
