import * as THREE from 'three';
import { buildNetAssembly } from './fishing-net';

/**
 * The live diver uses the same modular fishing net as the workbench. The
 * optional equipment references are exposed so a loadout can attach a torch
 * or recovery reel without rebuilding the shaft and bag.
 */
export interface FishingNetMesh {
  /** Group attached to the diver's shoulder and rotated during a swing. */
  group: THREE.Group;
  /** Mouth pivot; only the hoop and fabric scale as equipment is upgraded. */
  mouth: THREE.Group;
  /** World-space catch marker, aligned with the inside of the net bag. */
  tip: THREE.Object3D;
  /** Optional equipment model, hidden until the lamp slot is equipped. */
  lamp: THREE.Group;
  /** Optional recovery reel, enabled by the runtime loadout. */
  reel: THREE.Group;
  /** The reusable shaft clamp where the torch is attached. */
  lampMount: THREE.Group;
}

/**
 * Build the reusable fishing tool asset. The runtime keeps a recovery reel as
 * part of the starting net, while the torch remains a separate loadout item.
 */
export function buildFishingNetMesh(): FishingNetMesh {
  const assembly = buildNetAssembly({ netLevel: 1, shaftLevel: 1, reelLevel: 1, lampLevel: 0 });
  assembly.group.name = 'HackRU_Faceted_Fishing_Net';
  assembly.group.userData = {
    ...assembly.group.userData,
    runtimeModel: 'buildFishingNetMesh',
    modelRole: 'diver-fishing-net',
    mouthName: assembly.mouth.name,
    tipName: assembly.tip.name,
    catchCentreX: assembly.mouth.position.x + assembly.tip.position.x,
    structure: 'rigid-shaft-wide-diamond-net-bag',
  };
  return assembly;
}
