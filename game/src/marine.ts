import * as THREE from 'three';
import type { FishMesh, FishSpec, MarineGene } from './fish';

type Architecture = 'salmon' | 'tuna' | 'octopus' | 'ray' | 'angler' | 'eel' | 'hammerhead' | 'jelly' | 'nautilus' | 'sawshark' | 'turtle' | 'squid' | 'whaleshark';
const ARCHITECTURES: Record<string, Architecture> = {
  'Atlantic Salmon': 'salmon', 'Bluefin Tuna': 'tuna', 'Reef Octopus': 'octopus',
  'Manta Ray': 'ray', 'Lantern Angler': 'angler', 'Ribbon Moray': 'eel',
  'Hammerhead Shark': 'hammerhead', 'Moon Jellyfish': 'jelly', 'Chambered Nautilus': 'nautilus',
  'Lionmane Jellyfish': 'jelly', 'Sawshark': 'sawshark', 'Golden Sea Turtle': 'turtle',
  'Starcoil Eel': 'eel', 'Vampire Squid': 'squid', 'Coralback Titan Turtle': 'turtle',
  'Green Sea Turtle': 'turtle', 'Whale Shark': 'whaleshark',
  'Abyssal Giant Octopus': 'octopus', 'Prism Crown Jellyfish': 'jelly',
  'Suncrest Spearfish':'hammerhead','Jade Shell Turtle':'turtle',
};

/**
 * Independent body architectures; +X is forward, +Y up, Z is lateral. `gene`: the fish's shape gene
 * (fish.ts marineGene), or undefined for the species' standard creature, drawn exactly as
 * before genes. With one, the body's proportions and limbs are rescaled (baked into the geometry, so
 * the card's pose and every view keep them) and its colours move around the species' own.
 */
export function buildMarineCreature(spec: FishSpec, glow: number, gene?: MarineGene): FishMesh | undefined {
  const kind = ARCHITECTURES[spec.species];
  if (!kind) return undefined;
  const flippers: { pivot: THREE.Group; side: number; front: boolean }[] = [];
  const group = new THREE.Group();
  const tail = new THREE.Group();
  const high = spec.rarity === 'mythic';
  const golden = spec.rarity === 'legendary';
  // With a gene, a species that took the fish's hue takes one around its rarity's old hue band instead
  // (the range its fish had before random colours; fish.ts marineGene bandHue), so it stays in its palette.
  const fixedHue = kind === 'salmon' || kind === 'tuna' || kind.includes('shark') || (kind === 'turtle' && !golden && !high);
  const hue = kind === 'salmon' ? 0.55 : kind === 'tuna' || kind.includes('shark') ? 0.57
    : kind === 'turtle' && !golden && !high ? 0.27 : (gene ? gene.bandHue : spec.hue) / 360;
  const mythicHue = kind === 'squid' ? 0.97 : kind === 'turtle' ? 0.48 : 0.65;
  const organic = ['Chambered Nautilus','Green Sea Turtle','Ribbon Moray','Lantern Angler','Manta Ray'].includes(spec.species);
  // A body whose hue came from bandHue has already moved by the gene; every other colour (a fixed
  // species colour, a mythic's, an organic palette) moves by hueShift instead. A banded body is drawn
  // a little more saturated with a gene, or its hues all wash out to the same pastel.
  const banded = !fixedHue && !high && !organic;
  const color = new THREE.Color().setHSL(high ? mythicHue : hue, golden || high ? 0.52 : gene && banded ? 0.46 : 0.32, high ? 0.24 : 0.4);
  let material = new THREE.MeshStandardMaterial({
    color, flatShading: true, roughness: 1, metalness: 0,
    emissive: color, emissiveIntensity: 0, side: THREE.DoubleSide,
  });
  // Stable rarity language: green / cyan / violet / gold / prismatic cyan.
  const rarityHue = { common: 0.1, uncommon: 0.38, rare: 0.53, epic: 0.76, legendary: 0.12, mythic: 0.5 }[spec.rarity];
  const accent = material.clone(); accent.color.setHSL(rarityHue, golden || high ? 0.65 : 0.4, golden ? 0.46 : 0.48);
  const belly = material.clone(); belly.color.setHSL(hue, 0.15, 0.82); belly.emissiveIntensity = 0;
  const dark = material.clone(); dark.color.setHSL(hue, 0.25, 0.12); dark.emissiveIntensity = 0;
  const luminous = accent.clone(); luminous.emissive.copy(accent.color); luminous.emissiveIntensity = Math.max(0.5, glow * 0.9);
  if(kind==='salmon'||kind==='tuna') {
    material.color.setHSL(0.57,kind==='salmon'?0.18:0.36,0.27);
    accent.color.setHSL(0.57,0.25,0.26);
    belly.color.setHSL(0.57,0.08,0.65);
  }
  if(organic) {
    const palette: Record<string, [number,number,number]> = {
      'Chambered Nautilus':[0.09,0.27,0.63], 'Green Sea Turtle':[0.23,0.26,0.25],
      'Ribbon Moray':[0.57,0.36,0.25], 'Lantern Angler':[0.09,0.16,0.18],
      'Manta Ray':[0.58,0.14,0.16],
    };
    const [h,s,l]=palette[spec.species];
    material.color.setHSL(h,s,l);material.emissiveIntensity=0;material.metalness=0;material.roughness=0.98;
    accent.color.setHSL(h,s*0.65,Math.min(0.68,l+0.11));accent.emissiveIntensity=0;accent.metalness=0;accent.roughness=1;
    belly.color.setHSL(0.1,0.16,0.63);belly.metalness=0;belly.roughness=1;
    dark.color.setHSL(h,0.15,0.07);dark.metalness=0;dark.roughness=1;
    luminous.color.setHSL(0.14,0.5,0.7);luminous.emissive.copy(luminous.color);luminous.emissiveIntensity=1.2;luminous.metalness=0;
  }
  const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
  function ellipsoid(x: number, y: number, z: number, sx: number, sy: number, sz: number, mat = material, parent: THREE.Object3D = group) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), mat);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); parent.add(mesh); return mesh;
  }
  function facet(points: number[][], mat = accent, parent: THREE.Object3D = group) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, mat); parent.add(mesh); return mesh;
  }
  function tube(points: THREE.Vector3[], radius: number, mat = material, parent: THREE.Object3D = group) {
    const curve = new THREE.CatmullRomCurve3(points);
    const geometry = new THREE.TubeGeometry(curve, 16, radius, 6, false);
    const mesh = new THREE.Mesh(geometry, mat); parent.add(mesh); return mesh;
  }
  function taperedArm(points: THREE.Vector3[], radius: number, mat = material, parent: THREE.Object3D = tail) {
    const curve = new THREE.CatmullRomCurve3(points);
    const frames = curve.computeFrenetFrames(24, false), vertices: number[] = [], indices: number[] = [];
    for (let i = 0; i <= 24; i++) {
      const center = curve.getPointAt(i / 24), r = radius * (1 - i / 24 * 0.96);
      for (let j = 0; j < 6; j++) {
        const a = j / 6 * Math.PI * 2;
        const p = center.clone().addScaledVector(frames.normals[i], Math.cos(a) * r).addScaledVector(frames.binormals[i], Math.sin(a) * r);
        vertices.push(p.x, p.y, p.z);
        if (i < 24) {
          const k = i * 6 + j, n = i * 6 + (j + 1) % 6;
          indices.push(k, n, k + 6, n, n + 6, k + 6);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices);geometry.computeVertexNormals();
    parent.add(new THREE.Mesh(geometry, mat)); return curve;
  }
  /** Eight-sided longitudinal stations, with an actual tail peduncle and wedge nose. */
  function hull(stations: number[][], mat = material, lower = belly) {
    for(let i = 0; i < stations.length - 1; i++) for(let j = 0; j < 8; j++) {
      const a = j / 8 * Math.PI * 2, b = (j + 1) / 8 * Math.PI * 2;
      const [x,h,w] = stations[i], [nx,nh,nw] = stations[i+1];
      const p=[x,Math.sin(a)*h,Math.cos(a)*w],q=[x,Math.sin(b)*h,Math.cos(b)*w];
      const r=[nx,Math.sin(a)*nh,Math.cos(a)*nw],s=[nx,Math.sin(b)*nh,Math.cos(b)*nw];
      facet([p,r,q],Math.sin(a)+Math.sin(b)<-0.7?lower:mat);
      facet([q,r,s],Math.sin(a)+Math.sin(b)<-0.7?lower:mat);
    }
  }
  function eyes(x: number, y: number, width: number, radius = 0.075) {
    for (const s of [-1, 1]) {
      ellipsoid(x, y, s * width, radius * 1.25, radius * 1.25, radius * 0.6, belly);
      ellipsoid(x + 0.025, y, s * (width + radius * 0.45), radius * 0.65, radius * 0.7, radius * 0.3, dark);
    }
  }
  function fins(x: number, span: number) {
    for (const s of [-1, 1]) facet([[x + 0.25, 0, s * 0.2], [x - 0.4, -0.08, s * span], [x - 0.25, 0, s * 0.25]]);
  }
  function crescentTail(x: number, height: number) {
    tail.position.x = x;
    for (const s of [-1, 1]) facet([[0, 0, 0], [-0.65, s * height, 0], [-0.3, s * height * 0.2, 0]], accent, tail);
  }
  if(kind==='whaleshark') {
    // Separate architecture: broad blunt head, long heavy trunk, narrow caudal peduncle.
    material.color.setHSL(0.56,0.18,0.22);accent.color.setHSL(0.12,0.45,0.36);
    hull([[-2.1,0.04,0.055],[-1.75,0.12,0.15],[-1.15,0.25,0.36],
      [-0.45,0.4,0.61],[0.3,0.43,0.7],[0.85,0.32,0.71],[1.27,0.2,0.66],[1.4,0.16,0.6]]);
    // A closed flat snout and a wide transverse mouth, not a pointed fish nose.
    facet([[1.4,0.16,-0.6],[1.4,0.16,0.6],[1.4,-0.16,0.6]],material);
    facet([[1.4,0.16,-0.6],[1.4,-0.16,0.6],[1.4,-0.16,-0.6]],belly);
    tube([v(1.412,-0.06,-0.53),v(1.425,-0.1,0),v(1.412,-0.06,0.53)],0.016,dark);
    eyes(1.12,0.11,0.63,0.047);
    for(const s of [-1,1]){
      facet([[0.55,-0.04,s*0.52],[-0.45,-0.16,s*1.34],[-0.3,-0.07,s*0.51]],material);
      facet([[-0.9,-0.1,s*0.31],[-1.42,-0.15,s*0.62],[-1.3,-0.12,s*0.25]],material);
      for(let i=0;i<5;i++)tube([v(0.72-i*0.11,0.18,s*(0.67-i*0.018)),v(0.64-i*0.11,-0.16,s*(0.67-i*0.018))],0.015,dark);
    }
    facet([[-0.7,0.37,0],[-0.1,0.4,0],[-0.6,0.95,0]],material);
    facet([[-1.3,0.21,0],[-0.95,0.29,0],[-1.23,0.58,0]],material);
    tail.position.x=-2.05;
    facet([[0,0,0],[-0.63,0.95,0],[-0.32,0.08,0]],material,tail);
    facet([[0,0,0],[-0.5,-0.58,0],[-0.28,-0.06,0]],material,tail);
    // Flush white skin marks, sampled directly from the polygonal trunk surface.
    const skin=belly.clone();skin.color.setHSL(0.1,0.04,0.76);
    const stations=[[-1.15,0.25,0.36],[-0.45,0.4,0.61],[0.3,0.43,0.7],[0.85,0.32,0.71]];
    for(let col=0;col<13;col++) {
      const x=-1.08+col*0.145;
      const si=x<-.45?0:x<.3?1:2;
      const [ax,ah,aw]=stations[si],[bx,bh,bw]=stations[si+1],t=(x-ax)/(bx-ax);
      const h=THREE.MathUtils.lerp(ah,bh,t),w=THREE.MathUtils.lerp(aw,bw,t);
      for(const side of [-1,1]) for(let row=0;row<4;row++) {
        const a=(row+0.35)/4*Math.PI/2,j=Math.floor(a/(Math.PI/4)),fraction=a/(Math.PI/4)-j;
        const y=THREE.MathUtils.lerp(Math.sin(j*Math.PI/4),Math.sin((j+1)*Math.PI/4),fraction)*h;
        const z=side*THREE.MathUtils.lerp(Math.cos(j*Math.PI/4),Math.cos((j+1)*Math.PI/4),fraction)*w;
        ellipsoid(x,y+0.005,z,0.021,0.009,0.021,skin);
      }
    }
    // Legendary identity is a restrained ochre fin edge, not a row of spikes.
    tube([v(-0.7,0.37,0),v(-0.6,0.95,0),v(-0.1,0.4,0)],0.015,accent);
  } else if (kind === 'salmon' || kind === 'tuna') {
    const tuna=kind==='tuna';
    // Separate silhouettes: deep torpedo tuna and a long, lean salmon.
    const stations=tuna?
      [[-1.65,.035,.035],[-1.25,.09,.06],[-.85,.24,.16],[-.35,.43,.29],[.2,.46,.31],[.65,.34,.25],[1,.19,.16],[1.28,.055,.055]]:
      [[-1.65,.04,.035],[-1.25,.1,.06],[-.8,.21,.13],[-.2,.29,.19],[.4,.28,.19],[.85,.21,.15],[1.2,.12,.09],[1.4,.035,.035]];
    hull(stations);
    const finMat=accent.clone();finMat.color.setHSL(tuna?.13:.08,tuna?.45:.18,tuna?.4:.31);
    facet([[-.55,.32,0],[.12,.44,0],[-.2,tuna?.86:.62,0]],material);
    facet([[-.9,.17,0],[-.58,.3,0],[-.75,.43,0]],finMat);
    for(const s of [-1,1]) {
      facet([[.53,.02,s*.23],[-.38,-.16,s*(tuna?.62:.4)],[.08,-.1,s*.2]],material);
      facet([[-.15,-.26,s*.1],[-.55,-.48,s*.23],[-.65,-.22,s*.12]],finMat);
      tube([v(.83,.18,s*.16),v(.69,0,s*.24),v(.8,-.18,s*.16)],.008,dark);
      if(tuna)for(let i=0;i<6;i++) {
        const x=-.75-i*.12,y=.2-i*.022;
        facet([[x,y,0],[x-.09,y+.1,0],[x-.14,y-.025,0]],finMat);
        facet([[x,-y,0],[x-.09,-y-.1,0],[x-.14,-y+.025,0]],finMat);
      }
    }
    tail.position.set(-1.6,0,0);
    facet([[0,.04,0],[-.48,tuna?.73:.48,0],[-.32,.12,0]],material,tail);
    facet([[0,-.04,0],[-.48,tuna?-.73:-.48,0],[-.32,-.12,0]],material,tail);
    eyes(tuna?1.02:1.17,.08,tuna?.14:.09);
    tube([v(tuna?1.12:1.28,-.035,-.04),v(tuna?1.29:1.41,-.02,0),v(tuna?1.12:1.28,-.035,.04)],.008,dark);
    if(!tuna)for(let i=0;i<21;i++)for(const s of [-1,1]) {
      const x=-.7+(i%7)*.22,y=.09+Math.floor(i/7)*.045;
      const w=.19*Math.sqrt(Math.max(.1,1-(x+.05)**2/1.5));
      ellipsoid(x,y,s*w*.8,.012,.009,.005,dark);
    }
  } else if (kind === 'hammerhead' || kind === 'sawshark') {
    const shark = kind === 'hammerhead' || kind === 'sawshark';
    const width = 0.28;
    hull([[-1.4,0.035,0.035],[-1.1,0.1,width*0.25],[-0.65,0.23,width*0.65],
      [-0.2,0.32,width],[0.24,0.29,width*0.93],
      [0.65,shark?0.28:0.23,width*0.78],[1.02,0.1,width*0.36],[1.26,0.015,width*0.04]]);
    fins(0.25, shark ? 1.0 : 0.65);
    facet([[-0.25, 0.25, 0], [0.25, 0.25, 0], [-0.12, shark ? 0.9 : 0.58, 0]]);
    crescentTail(-1.2, shark ? 0.8 : 0.58);
    if (kind === 'hammerhead') {
      const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.32,0.18,1.75),material);
      hammer.position.set(1.02,0,0);group.add(hammer);
      eyes(1.12, 0.06, 0.81);
    } else {
      eyes(0.92, 0.1, width * 0.65);
    }
    if (kind === 'sawshark') {
      const saw = new THREE.Mesh(new THREE.BoxGeometry(1.45,0.065,0.12),material);
      saw.position.set(1.75,0,0);group.add(saw);
      for (let i = 0; i < 9; i++) for (const s of [-1, 1])
        facet([[1.15 + i * 0.15, 0, s * 0.06], [1.2 + i * 0.15, 0, s * 0.23], [1.25 + i * 0.15, 0, s * 0.06]], belly);
    }
    for(const s of [-1,1]) tube([v(-0.65,0,s*width*0.65),v(0.1,0.05,s*width),v(0.7,0.05,s*width*0.83)],0.012,accent);
    tube([v(1.02,-0.1,-width*0.35),v(1.23,-0.07,0),v(1.02,-0.1,width*0.35)],0.013,dark);
    if(golden) {
      for(let i=0;i<7;i++)for(const s of [-1,1])
        facet([[-0.6+i*0.2,0.25,s*0.2],[-0.5+i*0.2,0.48,s*0.23],[-0.42+i*0.2,0.23,s*0.22]],accent);
    }
    for (let i = 0; i < 4 && shark; i++) for (const s of [-1, 1])
      tube([v(0.35 - i * 0.1, 0.18, s * width), v(0.3 - i * 0.1, -0.16, s * width)], 0.012, dark);
  } else if (kind === 'turtle') {
    ellipsoid(0, 0, 0, 0.9, 0.42, 0.66);
    ellipsoid(0, -0.2, 0, 0.85, 0.16, 0.62, belly);
    ellipsoid(0.98, -0.05, 0, 0.34, 0.23, 0.25);
    eyes(1.13, 0.04, 0.2);
    for (const x of [-0.55, 0.48]) for (const s of [-1, 1]) {
      const pivot=new THREE.Group();pivot.position.set(x,-0.16,s*0.48);group.add(pivot);
      const flipper = ellipsoid(-0.2, -0.04, s * 0.25, 0.55, 0.06, 0.21, accent,pivot);
      flipper.rotation.y = s * (x > 0 ? -0.65 : 0.5);
      flippers.push({pivot,side:s,front:x>0});
    }
    for (let i = 0; i < 7; i++) {
      // A true hexagonal tiling, stretched as one layout, with narrow shared seams.
      const a = Math.PI/6+i/6*Math.PI*2;
      const x = i===6?0:Math.cos(a)*Math.sqrt(3)*0.22*1.4;
      const z = i===6?0:Math.sin(a)*Math.sqrt(3)*0.22;
      {
        const shell=material.clone();shell.userData.shell=true;shell.color.setHSL(high?0.48:golden?0.12:0.08,high?0.4:golden?0.5:0.26,0.21+(i%3)*0.035);
        const surface=(px:number,pz:number)=>0.43*Math.sqrt(Math.max(0.08,1-px*px/0.81-pz*pz/0.4356));
        const ring=Array.from({length:6},(_,j)=>{
          const a=j/6*Math.PI*2,px=x+Math.cos(a)*0.215*1.4,pz=z+Math.sin(a)*0.215;
          return [px,surface(px,pz)+0.014,pz];
        });
        for(let j=0;j<6;j++)facet([[x,surface(x,z)+0.035,z],ring[j],ring[(j+1)%6]],shell);
        // Straight edges: closed Catmull-Rom outlines overshot the corners.
        // Inset each plate so neighbouring boundaries never touch or cross.
        for(let j=0;j<6;j++) {
          const p=ring[j],q=ring[(j+1)%6];
          tube([v(p[0],p[1]+0.004,p[2]),v(q[0],q[1]+0.004,q[2])],0.002,dark);
        }
      }
    }
    tail.position.set(-0.8, -0.12, 0); facet([[0,0,0],[-0.35,-0.08,0],[0,0.1,0]], material, tail);
    if (high) for (let i = 0; i < 7; i++) {
      const x = -0.6 + i * 0.2, z = Math.sin(i * 2) * 0.22;
      tube([v(x,0.35,z),v(x,0.7,z),v(x + 0.12,1.05,z + 0.15)],0.04,accent);
      tube([v(x,0.65,z),v(x - 0.17,0.9,z - 0.18)],0.028,luminous);
    }
    for(const s of [-1,1]) {
      tube([v(0.85,0.09,s*0.2),v(1.1,0.14,s*0.23),v(1.21,0.02,s*0.13)],0.012,accent);
    }
  } else if (kind === 'octopus' || kind === 'squid') {
    const squid = kind === 'squid';
    // Mantle behind a clearly separate head; arms fan forward rather than form a ball.
    if(squid) {
      hull([[-1.2,0.02,0.02],[-0.8,0.3,0.28],[-0.25,0.42,0.4],[0.3,0.26,0.27],[0.5,0.18,0.19]]);
      for(const s of [-1,1]) {
        facet([[-0.8,0,s*0.24],[-0.45,0.15,s*0.86],[0.15,0,s*0.3]],accent);
        tube([v(-0.8,0,s*0.24),v(-0.45,0.15,s*0.86),v(0.15,0,s*0.3)],0.025,luminous);
      }
    } else {
      ellipsoid(-0.45,0.25,0,0.65,0.55,0.45);
      // A pointed rear mantle and brow make the octopus read even at icon size.
      ellipsoid(0.12,0.03,0,0.32,0.25,0.32);
    }
    eyes(0.28,0.13,0.29,0.12);
    tube([v(0.35,0.22,-0.24),v(0.25,0.31,0),v(0.35,0.22,0.24)],0.025,accent);
    tail.position.set(0.38,-0.1,0);
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      const y = Math.cos(a), z = Math.sin(a);
      const length = 1.35 + (i%3)*0.16;
      const points = [v(0,y*0.13,z*0.18),v(0.4,y*0.48,z*0.5),
        v(0.85,y*0.8,z*0.9),v(length,y*0.85-0.12,z*1.05),
        v(length+0.12,y*0.62-0.08,z*0.87),v(length-0.09,y*0.5,z*0.78)];
      const curve = taperedArm(points,high?0.16:0.11,i%2?accent:material);
      for(let j=0;j<9;j++){
        const p=curve.getPointAt(0.13+j*0.07);
        const radius=(high?0.045:0.032)*(1-j*0.065);
        for(const s of [-1,1]) {
          const sucker = new THREE.Mesh(new THREE.TorusGeometry(radius,0.009,4,8),belly);
          sucker.position.copy(p).add(v(0,-0.07*(1-j*0.08),s*radius));
          sucker.rotation.x=Math.PI/2;tail.add(sucker);
        }
      }
      if(squid) {
        const next=(i+1)/8*Math.PI*2;
        facet([[0,y*0.13,z*0.18],[0.65,y*0.62,z*0.7],
          [0.8,Math.cos(a+Math.PI/8)*0.48,Math.sin(a+Math.PI/8)*0.55],
          [0,y*0.13,z*0.18],[0.8,Math.cos(a+Math.PI/8)*0.48,Math.sin(a+Math.PI/8)*0.55],
          [0.65,Math.cos(next)*0.62,Math.sin(next)*0.7]],material,tail);
      }
    }
    if(high&&!squid){
      for(let i=0;i<9;i++){
        const x=-0.9+i*0.14;
        ellipsoid(x,0.63-Math.abs(x+0.45)*0.35,0,0.035,0.035,0.035,luminous);
      }
      for(const s of [-1,1])tube([v(-0.9,0.3,s*0.12),v(-0.5,0.66,s*0.2),v(0.05,0.35,s*0.2)],0.025,luminous);
      for(let i=0;i<3;i++){
        const crown=new THREE.Mesh(new THREE.OctahedronGeometry(0.12),luminous);
        crown.position.set(-0.6+i*0.2,0.83,0);crown.scale.y=1.8;group.add(crown);
      }
    }
  } else if (kind === 'jelly') {
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.7,12,6,0,Math.PI * 2,0,Math.PI / 2), material);
    bell.position.y = 0.2; group.add(bell);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.69,0.065,5,16),accent);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.2;group.add(ring);
    ellipsoid(0,0.3,0,0.3,0.22,0.3,luminous);
    for(let i=0;i<8;i++){
      const a=i/8*Math.PI*2;
      tube([v(0,0.88,0),v(Math.cos(a)*0.46,0.65,Math.sin(a)*0.46),
        v(Math.cos(a)*0.67,0.26,Math.sin(a)*0.67)],0.014,high||golden?luminous:accent);
    }
    tail.position.y = 0.2;
    const count = spec.species === 'Lionmane Jellyfish' ? 24 : high ? 16 : 10;
    for(let i=0;i<count;i++) {
      const a=i/count*Math.PI*2, x=Math.cos(a)*0.5,z=Math.sin(a)*0.5,length=0.9+(i%4)*0.2;
      tube([v(x,0,z),v(x*0.8,-length*0.4,z*0.8),v(x*1.1+0.15,-length*0.8,z),v(x*0.8,-length,z*0.7)],0.018+(i%3)*0.007,i%2?accent:material,tail);
    }
    if(high) for(let i=0;i<7;i++){
      const a=i/7*Math.PI*2;
      const mesh=new THREE.Mesh(new THREE.OctahedronGeometry(0.15),luminous);
      mesh.position.set(Math.cos(a)*0.48,0.75,Math.sin(a)*0.48);mesh.scale.y=2;group.add(mesh);
    }
  } else if(kind === 'eel') {
    const pts=Array.from({length:25},(_,i)=>v(1.5-i*0.145,0,0));
    taperedArm(pts,0.15,material,group);
    ellipsoid(1.48,0,0,0.3,0.17,0.18);eyes(1.56,0.07,0.15,0.055);
    for(let i=1;i<pts.length;i++){
      const a=pts[i-1],b=pts[i];
      const finHeight=organic?0.09:0.3;
      facet([[a.x,a.y+0.12,a.z],[b.x,b.y+0.12,b.z],[b.x,b.y+finHeight+0.12,b.z]]);
      if(organic)facet([[a.x,a.y+0.12,a.z],[b.x,b.y+finHeight+0.12,b.z],[a.x,a.y+finHeight+0.12,a.z]]);
    }
    tail.position.copy(pts[pts.length-1]);
    for(const s of [-1,1]) tube(pts.map(p=>p.clone().add(v(0,0.02,s*0.14))),0.014,high?luminous:accent);
    for(let i=1;!organic&&i<16;i++) {
      const p=pts[i];
      ellipsoid(p.x,p.y+0.08,0.135,0.025,0.045,0.012,high?luminous:belly);
    }
    facet([[0,0,0],[-0.4,0.25,0],[-0.4,-0.15,0]],accent,tail);
    if(high) for(let i=0;i<3;i++){
      const ring=new THREE.Mesh(new THREE.TorusGeometry(0.35,0.025,5,16),luminous);
      ring.position.copy(pts[3+i*5]);ring.rotation.y=Math.PI/2;group.add(ring);
    }
  } else if(kind === 'ray'){
    ellipsoid(0,0,0,0.6,0.12,0.4);
    for(const s of [-1,1]){
      facet([[0.55,0,s*0.2],[-0.6,0,s*0.25],[-0.2,0.22,s*1.45]]);
      facet([[0.55,0,s*0.2],[-0.2,0.22,s*1.45],[0.25,0.12,s*0.85]],belly);
      tube([v(0.5,0,s*0.15),v(0.8,0.1,s*0.22),v(0.85,0.1,s*0.4)],0.05);
      for(let i=0;!organic&&i<5;i++){
        const z=s*(0.3+i*0.2);
        tube([v(0.28-i*0.07,0.02,z),v(-0.2,0.15,z+s*0.15)],0.013,accent);
      }
      for(let i=0;i<4;i++)tube([v(0.16-i*0.07,-0.09,s*0.3),v(0.11-i*0.07,-0.09,s*0.5)],0.012,dark);
    }
    eyes(0.3,0.12,0.21,0.05);
    tail.position.x=-0.55;tube([v(0,0),v(-0.6,-0.06),v(-1.4,0.12)],0.025,material,tail);
  } else if(kind === 'nautilus'){
    // One continuous chambered shell, with a visible logarithmic spiral on both faces.
    const shellIvory=belly.clone();shellIvory.color.setHSL(0.09,0.22,0.7);
    ellipsoid(-0.2,0.22,0,0.7,0.7,0.35,shellIvory);
    for(const side of [-1,1]){
      const spiral=Array.from({length:56},(_,i)=>{
        const t=i/55, a=t*Math.PI*4.1, r=0.035+0.61*t*t;
        return v(-0.2+Math.cos(a)*r,0.22+Math.sin(a)*r,side*(0.35*Math.sqrt(Math.max(0.05,1-r*r/0.49))+0.006));
      });
      tube(spiral,0.008,dark);
      for(let i=0;i<12;i++){
        const a=i/12*Math.PI*2;
        tube([v(-0.2+Math.cos(a)*0.41,0.22+Math.sin(a)*0.41,side*0.29),
          v(-0.2+Math.cos(a+0.14)*0.63,0.22+Math.sin(a+0.14)*0.63,side*0.16)],0.008,material);
      }
    }
    ellipsoid(0.45,-0.12,0,0.26,0.22,0.24,material);
    eyes(0.56,-0.04,0.22,0.085);
    tail.position.set(0.64,-0.18,0);
    for(let i=0;i<14;i++){
      const spread=(i-6.5)/6.5;
      taperedArm([v(0,spread*0.05,spread*0.05),v(0.28,spread*0.16,spread*0.12),
        v(0.63,spread*0.3-0.12,spread*0.22),v(0.76,spread*0.22-0.27,spread*0.25)],0.025,accent);
    }
  } else if(kind === 'angler'){
    // Broad wedge skull, recessed jaw, separate lips: not a sphere with a dark dot.
    hull([[-0.75,0.03,0.03],[-0.45,0.26,0.32],[0,0.44,0.58],[0.58,0.38,0.51],[0.8,0.2,0.38]]);
    eyes(0.32,0.36,0.4,0.11);
    ellipsoid(0.79,-0.02,0,0.045,0.27,0.37,dark);
    const mouth=Array.from({length:17},(_,i)=>{
      const a=i/16*Math.PI*2;return v(0.81,Math.sin(a)*0.28-0.02,Math.cos(a)*0.38);
    });
    tube(mouth,0.035,accent);
    for(let i=0;i<10;i++) for(const s of [-1,1]){
      const z=(i-4.5)*0.066,y=s*(0.24-Math.abs(z)*0.25)-0.02;
      facet([[0.84,y,z-0.015],[0.86,y-s*(0.08+(i%3)*0.025),z],[0.84,y,z+0.015]],belly);
    }
    tube([v(-0.1,0.4),v(-0.15,0.98),v(0.4,1.12),v(0.95,0.87),v(1.06,0.56)],0.032,accent);
    ellipsoid(1.06,0.56,0,0.14,0.16,0.14,luminous);
    for(const s of [-1,1]) {
      facet([[-0.2,0,s*0.35],[-0.65,-0.12,s*0.9],[0.15,-0.04,s*0.48]],accent);
      for(let i=0;i<4;i++)tube([v(0.15,-0.04,s*0.48),v(-0.65+i*0.14,-0.12,s*(0.9-i*0.1))],0.015,belly);
    }
    for(let i=0;i<5;i++)facet([[-0.45+i*0.13,0.28,0],[-0.52+i*0.13,0.56+(i%2)*0.1,0],[-0.3+i*0.13,0.28,0]],accent);
    crescentTail(-0.72,0.34);
  }
  group.add(tail);
  const hsl = { h: 0, s: 0, l: 0 };
  /** The gene's colour offset around the species' own colour (every surface: body, belly, accent, dark). */
  const hueShift = gene && !banded ? gene.hueShift : 0;
  const jitter = (c: THREE.Color, hueExtra = 0) => {
    if (!gene) return;
    c.getHSL(hsl);
    c.setHSL(THREE.MathUtils.euclideanModulo(hsl.h + hueShift + hueExtra, 1), THREE.MathUtils.clamp(hsl.s + gene.satShift, 0, 1), THREE.MathUtils.clamp(hsl.l * gene.lightScale, 0, 1));
  };
  if (gene) {
    // The accent takes its own extra hue offset first, so its pairing with the body varies too.
    accent.color.offsetHSL(gene.accentShift, 0, 0);
    jitter(luminous.color, gene.accentShift); luminous.emissive.copy(luminous.color);
    jitter(dark.color);
  }
  {
    // All bodies use baked, seeded pigmentation; luminous organs are kept separate.
    group.updateMatrixWorld(true);
    const pigmented = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
    const replaced = new Set<THREE.BufferGeometry>();
    group.traverse(object=>{
      if(!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial))return;
      if(object.material===luminous || object.material===dark)return;
      const geometry=object.geometry.index?object.geometry.toNonIndexed():object.geometry.clone();
      const positions=geometry.getAttribute('position'),colors:number[]=[];
      const source=object.material.color;
      // A turtle's shell plates keep their own hue (brown, gold, jade): any shift reads as red or pink
      // on them. Their saturation and lightness still move.
      const shellHue=object.material.userData.shell?-hueShift:0;
      for(let i=0;i<positions.count;i+=3) {
        const p=new THREE.Vector3();
        for(let j=0;j<3;j++)p.add(new THREE.Vector3().fromBufferAttribute(positions,i+j));
        p.divideScalar(3).applyMatrix4(object.matrixWorld);
        const n=Math.sin(p.x*83.7+p.y*171.3+p.z*119.9+spec.seed)*43758.5453;
        const noise=n-Math.floor(n);
        let c=source.clone().multiplyScalar(0.76+noise*0.35);
        if(kind==='nautilus'&&p.x<0.4) {
          const angle=Math.atan2(p.y-0.22,p.x+0.2);
          if(Math.sin(angle*13+(p.x*p.x+p.y*p.y)*2)>0.58)c.setHSL(0.045,0.32,0.32+noise*0.08);
        } else if(kind==='eel'&&organic) {
          if(Math.sin(p.x*29+p.y*47+p.z*31)>0.55)c.multiplyScalar(0.45);
        } else if(kind==='ray') {
          if(p.y<0)c.setHSL(0.1,0.08,0.59+noise*0.12);
          else c.multiplyScalar(0.7+noise*0.25);
        } else if(kind==='angler'&&noise<0.13)c.multiplyScalar(0.48);
        else if(kind==='octopus'||kind==='squid'){
          if(noise<0.18)c.multiplyScalar(0.65);
        } else if(kind==='turtle'){
          if(noise<0.2)c.multiplyScalar(0.7);
        } else if(kind==='salmon'||kind==='tuna'||kind.includes('shark')){
          // Very subtle skin mottling, rather than a uniformly coloured toy.
          c.multiplyScalar(0.9+Math.sin(p.x*15+p.z*11)*0.06);
          if((kind==='salmon'||kind==='tuna')&&object.material===material) {
            if(p.y>0.16)c.setHSL(0.58,kind==='tuna'?0.4:0.18,0.17+noise*0.06);
            else if(p.y>-0.12)c.setHSL(kind==='salmon'&&Math.abs(p.y)<0.045?0.03:0.56,0.1,0.45+noise*0.12);
            else c.setHSL(0.1,0.07,0.64+noise*0.06);
          }
        }
        if(gene)jitter(c,shellHue);
        for(let j=0;j<3;j++)colors.push(c.r,c.g,c.b);
      }
      geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
      let mat=pigmented.get(object.material);
      if(!mat){
        mat=object.material.clone();mat.color.setRGB(1,1,1);mat.vertexColors=true;
        mat.metalness=0;mat.roughness=1;mat.emissiveIntensity=0;
        pigmented.set(object.material,mat);
      }
      replaced.add(object.geometry);
      object.geometry=geometry;object.material=mat;
    });
    replaced.forEach(geometry=>geometry.dispose());
    const liveMaterials=new Set<THREE.Material>();
    group.traverse(object=>{if(object instanceof THREE.Mesh)liveMaterials.add(object.material as THREE.Material);});
    const skin=pigmented.get(material) ?? material;
    for(const source of pigmented.keys())if(!liveMaterials.has(source))source.dispose();
    material=skin;
  }
  const primary=group.children.find(object=>object instanceof THREE.Mesh);
  if(primary)primary.userData.bodySurface=true;
  batchMarineMeshes(group);
  // A jellyfish is radial: tapering its bell along x would only tip it over.
  if (gene) shapeByGene(group, tail, flippers.map(f => f.pivot), gene, kind === 'jelly' ? 0 : gene.taper);
  group.userData.swimPhase=((Math.imul(spec.seed>>>0,0x9e3779b1)>>>0)/0x100000000)*Math.PI*2;
  group.scale.setScalar(spec.scale*0.9*(kind==='turtle'?1:0.97)*(kind==='octopus'?0.95:1)*(kind==='turtle'?1.04*(high?0.62:0.45):kind==='eel'?0.75:1));
  group.name=spec.species;
  let animate: FishMesh['animate'];
  const turtleClock=swimClock(group.userData.swimPhase);
  if(kind==='turtle')animate=(time,speed)=>{
    const cycle=turtleClock(time,2.1+Math.min(Math.max(0,speed),3)*0.6);
    for(const f of flippers){
      const phase=cycle+(f.front?0:Math.PI*0.65);
      f.pivot.rotation.x=f.side*Math.sin(phase)*(f.front?0.85:0.4);
      f.pivot.rotation.y=f.side*Math.cos(phase)*(f.front?0.35:0.2);
      f.pivot.rotation.z=Math.sin(phase+0.8)*0.18;
    }
    tail.rotation.y=Math.sin(cycle)*0.1;tail.rotation.z=0;
  };
  if(kind!=='turtle')animate=swimmingAnimation(group,tail,kind);
  const body=group.children.find(o=>o instanceof THREE.Mesh && o.userData.bodySurface) as THREE.Mesh;
  // Cephalopods are built arms-forward (+x) but jet mantle- or shell-first, arms trailing.
  const swimYaw=kind==='octopus'||kind==='squid'||kind==='nautilus'?Math.PI:0;
  return {group,tail,material,animate,body,size:{len:3,height:1,width:1},swimYaw};
}

/**
 * Bake the gene's proportions into the creature's geometry (each mesh has its own; nothing is
 * shared): the limbs (the tail rig, the turtle's flipper pivots) scale about their roots, then the
 * whole body by length × height × girth in the creature's frame, with the rigs' roots moved along
 * so they stay attached; then, with a `taper`, height and girth grow toward one end and shrink toward
 * the other (front-heavy or back-heavy), by up to ±taper at the tips. Baked rather than set on
 * group.scale, which the card pose and the views overwrite; run once at build time, before
 * swimmingAnimation records the rest pose.
 */
function shapeByGene(group: THREE.Group, tail: THREE.Object3D, pivots: THREE.Object3D[], gene: MarineGene, taper: number) {
  group.updateMatrixWorld(true);
  const toGroup = group.matrixWorld.clone().invert();
  const body = new THREE.Matrix4().makeScale(gene.length, gene.height, gene.girth);
  const rigs = [tail, ...pivots];
  const rigOf = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p && p !== group; p = p.parent) if (rigs.includes(p)) return p;
    return null;
  };
  // Each mesh's matrix in the group's frame, and the gene's transform of the group's frame for it.
  const meshes: { mesh: THREE.Mesh; to: THREE.Matrix4 }[] = [];
  const reach = new THREE.Box3();
  const point = new THREE.Vector3();
  group.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    const rig = rigOf(o);
    const change = body.clone();
    if (rig) {
      const root = rig.position; // rigs are the group's children: their position is in its frame
      change.multiply(new THREE.Matrix4().makeTranslation(root.x, root.y, root.z))
        .multiply(new THREE.Matrix4().makeScale(gene.limbs, gene.limbs, gene.limbs))
        .multiply(new THREE.Matrix4().makeTranslation(-root.x, -root.y, -root.z));
    }
    const to = change.multiply(toGroup.clone().multiply(o.matrixWorld));
    if (taper) {
      const position = o.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) reach.expandByPoint(point.fromBufferAttribute(position, i).applyMatrix4(to));
    }
    meshes.push({ mesh: o, to });
  });
  // The taper runs about the reshaped body's middle along its length.
  const middle = (reach.min.x + reach.max.x) / 2, half = Math.max(1e-6, (reach.max.x - reach.min.x) / 2);
  const swell = (p: THREE.Vector3) => {
    const k = 1 + taper * THREE.MathUtils.clamp((p.x - middle) / half, -1, 1);
    return p.set(p.x, p.y * k, p.z * k);
  };
  for (const rig of rigs) if (rig.parent === group) {
    rig.position.applyMatrix4(body);
    if (taper) swell(rig.position);
  }
  group.updateMatrixWorld(true);
  const seen = new Set<THREE.BufferGeometry>();
  for (const { mesh, to } of meshes) {
    if (seen.has(mesh.geometry)) mesh.geometry = mesh.geometry.clone();
    seen.add(mesh.geometry);
    const back = toGroup.clone().multiply(mesh.matrixWorld).invert();
    if (!taper) {
      mesh.geometry.applyMatrix4(back.multiply(to));
      continue;
    }
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      swell(point.fromBufferAttribute(position, i).applyMatrix4(to)).applyMatrix4(back);
      position.setXYZ(i, point.x, point.y, point.z);
    }
    position.needsUpdate = true;
    if (mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
  }
}

/** Deform in a shared bind space, keeping eyes, markings and fins attached. */

export function swimmingAnimation(group:THREE.Group,tail:THREE.Object3D,kind:string): NonNullable<FishMesh['animate']> {
  group.updateMatrixWorld(true);
  const rootInverse=group.matrixWorld.clone().invert();
  const point=new THREE.Vector3();
  const surfaces:{mesh:THREE.Mesh;rest:Float32Array;inverse:THREE.Matrix4}[]=[];
  const bounds=new THREE.Box3();
  group.traverse(o=>{if(o instanceof THREE.Mesh){
    const bind=rootInverse.clone().multiply(o.matrixWorld),inverse=bind.clone().invert();
    const p=o.geometry.getAttribute('position'),rest=new Float32Array(p.count*3);
    p.setUsage(THREE.DynamicDrawUsage);
    for(let i=0;i<p.count;i++){
      point.fromBufferAttribute(p,i).applyMatrix4(bind);bounds.expandByPoint(point);
      rest.set([point.x,point.y,point.z],i*3);
    }
    // Dynamic silhouettes can leave the static geometry bounds.
    o.frustumCulled=false;
    surfaces.push({mesh:o,rest,inverse});
  }});
  const length=Math.max(.1,bounds.max.x-bounds.min.x);
  const spineX=new Float32Array(65),spineZ=new Float32Array(65),spineAngle=new Float32Array(65);
  const clock=swimClock(group.userData.swimPhase ?? 0);
  let lastFrame=-Infinity;
  return (time,speed)=>{
    if(!Number.isFinite(time))return;
    const activity=Number.isFinite(speed)?THREE.MathUtils.clamp(speed/2.5,0,1):0;
    const cycle=clock(time,(kind==='jelly'?1.8:kind==='ray'?2.3:kind==='eel'?3.5:kind==='tuna'?5:4)+activity*3);
    if(time<lastFrame)lastFrame=-Infinity;
    tail.rotation.set(0,0,0);
    if(time-lastFrame<1/30)return;lastFrame=time;
    if(kind==='eel'){
      // Integrate a travelling heading wave rather than stretching the body
      // sideways. Each spine segment retains its length through the stroke.
      spineX[0]=bounds.max.x;spineZ[0]=0;spineAngle[0]=0;
      for(let j=1;j<=64;j++){
        const t=(j-.5)/64;
        const envelope=THREE.MathUtils.smoothstep(t,.04,.65);
        const angle=Math.sin(cycle-t*Math.PI*4)*envelope*(.95+activity*.25);
        spineAngle[j]=angle;
        spineX[j]=spineX[j-1]-Math.cos(angle)*length/64;
        spineZ[j]=spineZ[j-1]+Math.sin(angle)*length/64;
      }
    }
    for(const {mesh,rest,inverse}of surfaces){
      const p=mesh.geometry.getAttribute('position');
      for(let i=0;i<p.count;i++){
        const x=rest[i*3],y=rest[i*3+1],z=rest[i*3+2];point.set(x,y,z);
        const aft=THREE.MathUtils.clamp((bounds.max.x-x)/length,0,1);
        if(kind==='eel'){
          const sample=aft*64,a=Math.min(63,Math.floor(sample)),blend=sample-a;
          const angle=THREE.MathUtils.lerp(spineAngle[a],spineAngle[a+1],blend);
          const sx=THREE.MathUtils.lerp(spineX[a],spineX[a+1],blend);
          const sz=THREE.MathUtils.lerp(spineZ[a],spineZ[a+1],blend);
          // Cross sections rotate with the spine; head and mouth remain steady.
          // Swim in an oblique plane so the S-wave reads in the side camera.
          const lateral=y*.8+z*.6,normal=-y*.6+z*.8;
          const bent=sz+Math.cos(angle)*lateral;
          point.x=sx+Math.sin(angle)*lateral;
          point.y=bent*.8-normal*.6;
          point.z=bent*.6+normal*.8;
        }else if(kind==='ray'){
          const wing=Math.min(1,Math.abs(z)/1.4);
          point.y+=Math.sin(cycle-wing*1.6)*wing*wing*(.5+activity*.22);
          point.z*=1-wing*.12*(1+Math.sin(cycle-wing*1.6));
        }else if(kind==='jelly'){
          if(y>=.2){
            const pulse=Math.pow((1+Math.sin(cycle))/2,2);
            point.x*=1-pulse*.22;point.z*=1-pulse*.22;point.y=.2+(y-.2)*(1+pulse*.18);
          }else{
            const drop=Math.max(0,.2-y),phase=cycle-drop*2+Math.atan2(z,x);
            point.x+=Math.sin(phase)*drop*.18;point.z+=Math.cos(phase)*drop*.18;
          }
        }else if(kind==='octopus'||kind==='squid'||kind==='nautilus'){
          const reach=Math.max(0,x-(kind==='nautilus'?.65:.3));
          const armPhase=Math.atan2(z,y)*2;
          point.y+=Math.sin(cycle-reach*3+armPhase)*reach*.22;
          point.z+=Math.cos(cycle-reach*2.5+armPhase)*reach*.18;
          if(kind==='squid'&&x<.3)point.z*=1+Math.sin(cycle)*.06;
        }else{
          const wave=Math.sin(cycle-aft*4.4);
          const envelope=THREE.MathUtils.smoothstep(aft,.18,1);
          point.z+=wave*envelope*envelope*length*(kind==='tuna'?.045+activity*.025:.065+activity*.035);
          point.y+=Math.sin(cycle*.5-aft*3)*aft*.035;
        }
        point.applyMatrix4(inverse);p.setXYZ(i,point.x,point.y,point.z);
      }
      p.needsUpdate=true;
      // Flat-shaded materials derive face normals from view-position derivatives
      // in the fragment shader. Rebuilding/uploading CPU normals cannot change them.
      const needsNormals=Array.isArray(mesh.material)
        ? mesh.material.some(material=>!(material as THREE.MeshStandardMaterial).flatShading)
        : !(mesh.material as THREE.MeshStandardMaterial).flatShading;
      if(needsNormals) mesh.geometry.computeVertexNormals();
    }
  };
}

/** Speed changes alter frequency, not the accumulated stroke phase. */
function swimClock(initial: number) {
  let previous: number | undefined, cycle = Number.isFinite(initial) ? initial : 0;
  return (time: number, frequency: number) => {
    if (!Number.isFinite(time)) return cycle;
    const dt = previous === undefined ? 0 : THREE.MathUtils.clamp(time - previous, 0, 0.1);
    previous = time;
    cycle = (cycle + dt * (Number.isFinite(frequency) ? frequency : 2.1)) % (Math.PI * 4);
    return cycle;
  };
}

/** Merge by material inside each rig pivot, preserving all seeded vertex pigmentation. */
function batchMarineMeshes(parent: THREE.Group) {
  for (const child of [...parent.children]) if (child instanceof THREE.Group) batchMarineMeshes(child);
  const batches = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of parent.children) if (child instanceof THREE.Mesh) {
    const material = child.material as THREE.Material;
    const batch = batches.get(material) ?? [];
    batch.push(child); batches.set(material, batch);
  }
  const disposed = new Set<THREE.BufferGeometry>();
  for (const [material, meshes] of batches) {
    if (meshes.length < 2) continue;
    const parts = meshes.map(mesh => {
      mesh.updateMatrix();
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      geometry.applyMatrix4(mesh.matrix);
      disposed.add(mesh.geometry); parent.remove(mesh);
      return geometry;
    });
    const geometry = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', ...((material as THREE.MeshStandardMaterial).vertexColors ? ['color'] : [])]) {
      const count = parts.reduce((sum, part) => sum + part.getAttribute(name).array.length, 0);
      const array = new Float32Array(count); let offset = 0;
      for (const part of parts) { const data = part.getAttribute(name).array; array.set(data, offset); offset += data.length; }
      geometry.setAttribute(name, new THREE.BufferAttribute(array, 3));
    }
    const mesh = new THREE.Mesh(geometry, material); mesh.name = 'marine-batched-surface';
    mesh.userData.bodySurface=meshes.some(part=>part.userData.bodySurface);
    parent.add(mesh);
    parts.forEach(part => part.dispose());
  }
  disposed.forEach(geometry => geometry.dispose());
}
