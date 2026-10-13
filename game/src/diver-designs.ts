import * as THREE from 'three';
export class DiverConcept {
  group = new THREE.Group();
  legs: THREE.Group[] = [];
  private knees: THREE.Group[] = [];
  private ankles: THREE.Group[] = [];
  private holdingArm: THREE.Group | null = null;
  private upperBody = new THREE.Group();
  private headPose = new THREE.Group();
  /** Gear and effects use this frame so they follow the visible head in every pose. */
  get headFrame(): THREE.Group { return this.headPose; }
  private snorkel: THREE.Mesh | null = null;
  private snorkelRest: Float32Array | null = null;
  private arms: THREE.Group[] = [];
  private hipBridges: THREE.Mesh[] = [];
  private armFlex: {geometry:THREE.BufferGeometry;rest:Float32Array;elbow:THREE.Vector3;cuff:THREE.Mesh;hand:THREE.Mesh;cuffRest:THREE.Vector3;handRest:THREE.Vector3;cuffRotation:THREE.Quaternion}[] = [];
  private swingStart = -100;
  private swingFrom = -0.08;
  private time = 0;
  swing(force=false) {
    if (force || this.time-this.swingStart>0.34) {
      this.swingFrom=this.holdingArm?.rotation.z ?? -0.08;
      this.swingStart=this.time;
    }
  }
  attachTool(tool:THREE.Object3D) {
    const arm=this.holdingArm ?? this.arms[1];
    if(!arm) return;
    tool.position.set(0.18,0.1,0.1);
    arm.add(tool);
  }
  private blades: { geometry: THREE.BufferGeometry; rest: Float32Array; length: number }[] = [];
  constructor(public variant: number) {
    const palette = [['#164e58','#ff8656','#81f5d6'],['#506752','#d4ac68','#c3e3d1'],['#252b4b','#d1dced','#60dfff']][variant];
    const mats = palette.map(color => new THREE.MeshStandardMaterial({color,flatShading:true,roughness:0.55}));
    const black = new THREE.MeshStandardMaterial({color:'#101c28',flatShading:true});
    const glow = new THREE.MeshStandardMaterial({color:palette[2],emissive:palette[2],emissiveIntensity:0.35,metalness:0.25,roughness:0.2});
    const add = (parent:THREE.Object3D,g:THREE.BufferGeometry,m:THREE.Material,x:number,y:number,z:number) => {const obj=new THREE.Mesh(g,m);obj.position.set(x,y,z);parent.add(obj);return obj;};
    const box = (p:THREE.Object3D,s:[number,number,number],m:THREE.Material,x:number,y:number,z:number) => add(p,new THREE.BoxGeometry(...s),m,x,y,z);
    const bone = (p:THREE.Object3D,l:number,r:number,m:THREE.Material,x:number,y:number,z:number) => {const obj=add(p,new THREE.CylinderGeometry(r*0.75,r,l,6),m,x,y,z);obj.rotation.z=Math.PI/2;return obj;};
    const bulk=[0.86,0.92,1.05][variant];
    if (variant === 0) {
      const profile=[[-0.73,0],[-0.73,0.26],[-0.54,0.28],[-0.3,0.235],[0.02,0.255],[0.3,0.295],[0.46,0.30],[0.6,0.245],[0.72,0.17],[0.86,0.15],[0.86,0]];
      const shell=new THREE.LatheGeometry(profile.map(([x,r])=>new THREE.Vector2(r,x)),12);
      // Flatten the chest slightly while keeping broad shoulders and a defined waist.
      const torso=add(this.group,shell,mats[0],0,0,0);torso.rotation.z=-Math.PI/2;torso.scale.x=0.82;
      const hood=add(this.group,new THREE.IcosahedronGeometry(0.29,1),mats[0],0.97,0.015,0);
      hood.scale.set(1.13,0.96,1);
      const face=add(this.group,new THREE.IcosahedronGeometry(0.21,1),new THREE.MeshStandardMaterial({color:'#d6ac89',flatShading:true,roughness:0.8}),1.11,-0.055,0);
      face.scale.set(0.92,0.86,0.95);
      const belt=bone(this.group,0.06,0.242,mats[1],-0.31,0,0);belt.scale.x=0.82;
      // Solid face skirt and nose bridge join both lenses into one diving mask.
      box(this.group,[0.075,0.16,0.39],black,1.275,0.035,0);
      box(this.group,[0.09,0.115,0.055],black,1.32,0.015,0);
    } else {
      const profile=variant===1
        ? [[-0.73,0],[-0.73,0.25],[-0.5,0.265],[-0.25,0.235],[0.02,0.26],[0.15,0.30],[0.42,0.32],[0.58,0.25],[0.72,0.18],[0.88,0.16],[0.88,0]]
        : [[-0.73,0],[-0.73,0.255],[-0.5,0.26],[-0.25,0.22],[0.02,0.245],[0.15,0.285],[0.42,0.305],[0.58,0.245],[0.72,0.18],[0.88,0.16],[0.88,0]];
      const torso=add(this.group,new THREE.LatheGeometry(profile.map(([x,r])=>new THREE.Vector2(r*bulk,x)),variant===1?10:8),mats[0],0,0,0);
      torso.rotation.z=-Math.PI/2;
      torso.scale.x=variant===1?0.84:0.73;
      const hood=add(this.group,new THREE.IcosahedronGeometry(0.32,1),mats[0],0.99,0.015,0);
      hood.scale.set(1.08,1,1);
      const belt=bone(this.group,0.065,(variant===1?0.257:0.244)*bulk,mats[1],-0.39,0,0);
      belt.scale.x=variant===1?0.84:0.73;
    }
    for(const side of [-1,1]) {
      if (variant===0) {
        const trimPath=new THREE.CatmullRomCurve3([
          new THREE.Vector3(-0.17,0.015,side*0.24),
          new THREE.Vector3(0.04,0.055,side*0.252),
          new THREE.Vector3(0.29,0.065,side*0.287),
          new THREE.Vector3(0.43,0.03,side*0.298),
        ]);
        add(this.group,new THREE.TubeGeometry(trimPath,10,0.019,5,false),mats[1],0,0,0);
      } else {
        const panel=box(this.group,[0.34,0.115,0.035],mats[1],0.15,0.035,side*(variant===1?0.29:0.28)*bulk);
        panel.rotation.y=side*-0.08;
        box(this.group,[0.24,0.025,0.03],glow,0.16,0.045,side*(variant===1?0.312:0.302)*bulk);
      }
      if (variant === 0) {
        // Flat optical panes face forward, rather than glowing bulges on the temples.
        const outline = (width:number,height:number,cut:number) => {
          const shape = new THREE.Shape();
          const points = [[-width+cut,-height],[width-cut,-height],[width,-height+cut],[width,height-cut],[width-cut,height],[-width+cut,height],[-width,height-cut],[-width,-height+cut]];
          points.forEach(([x,y],i)=>i===0?shape.moveTo(x,y):shape.lineTo(x,y));
          shape.closePath();
          return shape;
        };
        const rim=outline(0.092,0.085,0.025);
        const aperture=outline(0.068,0.060,0.018);
        rim.holes.push(new THREE.Path(aperture.getPoints().reverse()));
        const frame=add(this.group,new THREE.ExtrudeGeometry(rim,{depth:0.036,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:0.004,bevelThickness:0.004}),black,1.315,0.054,side*0.105);
        frame.name='bevelled-mask-frame';
        frame.rotation.y=Math.PI/2-side*0.16;
        const lensMaterial=new THREE.MeshPhysicalMaterial({color:'#72b8c4',roughness:0.15,metalness:0.05,transparent:true,opacity:0.68,clearcoat:1,depthWrite:false,flatShading:true});
        const lens=add(this.group,new THREE.ExtrudeGeometry(aperture,{depth:0.008,bevelEnabled:false}),lensMaterial,1.341,0.054,side*0.105);
        lens.name='recessed-mask-lens';
        lens.rotation.y=frame.rotation.y;
        const strapPath = new THREE.CatmullRomCurve3([
          new THREE.Vector3(1.29,0.05,side*0.19),
          new THREE.Vector3(1.12,0.055,side*0.25),
          new THREE.Vector3(0.94,0.055,side*0.29),
          new THREE.Vector3(0.76,0.045,side*0.2),
          new THREE.Vector3(0.69,0.04,0),
        ]);
        add(this.group,new THREE.TubeGeometry(strapPath,8,0.024,5,false),black,0,0,0);
      } else {
        const strap=new THREE.CatmullRomCurve3([
          new THREE.Vector3(1.15,0.045,side*0.25),
          new THREE.Vector3(0.97,0.045,side*0.327),
          new THREE.Vector3(0.79,0.035,side*0.255),
          new THREE.Vector3(0.68,0.03,0),
        ]);
        add(this.group,new THREE.TubeGeometry(strap,10,0.025,5,false),black,0,0,0);
      }
      // A single tapered sleeve replaces disconnected shoulder/elbow primitives.
      // The root is buried in the suit; shared rings leave no joint seams.
      const armPath = new THREE.CatmullRomCurve3(variant===0 ? [
        new THREE.Vector3(0.35,-0.025,side*0.2),
        new THREE.Vector3(0.52,-0.06,side*0.3),
        new THREE.Vector3(0.74,-0.16,side*0.34),
        new THREE.Vector3(0.91,-0.23,side*0.32),
        new THREE.Vector3(1.17,-0.2,side*0.27),
        new THREE.Vector3(1.31,-0.17,side*0.24),
      ] : variant===2 ? [
        new THREE.Vector3(0.32,-0.025,side*0.18*bulk),
        new THREE.Vector3(0.52,-0.055,side*0.28*bulk),
        new THREE.Vector3(0.72,-0.145,side*0.30*bulk),
        new THREE.Vector3(0.9,-0.235,side*0.30*bulk),
        new THREE.Vector3(1.16,-0.27,side*0.29*bulk),
        new THREE.Vector3(1.28,-0.27,side*0.29*bulk),
      ] : [
        new THREE.Vector3(0.32,-0.045,side*0.17*bulk),
        new THREE.Vector3(0.52,-0.085,side*0.29*bulk),
        new THREE.Vector3(0.72,-0.18,side*0.34*bulk),
        new THREE.Vector3(0.9,-0.27,side*0.35*bulk),
        new THREE.Vector3(1.16,-0.3,side*0.35*bulk),
        new THREE.Vector3(1.28,-0.3,side*0.35*bulk),
      ]);
      const armPositions:number[]=[];
      const armIndices:number[]=[];
      const armSteps=14, armSides=10;
      for(let row=0;row<=armSteps;row++){
        const u=row/armSteps;
        const center=armPath.getPoint(u);
        const tangent=armPath.getTangent(u).normalize();
        const normal=new THREE.Vector3(0,1,0).addScaledVector(tangent,-tangent.y).normalize();
        const binormal=new THREE.Vector3().crossVectors(tangent,normal).normalize();
        const radius=THREE.MathUtils.lerp(variant===0?0.13:variant===1?0.14:0.132,0.075,u);
        for(let col=0;col<armSides;col++){
          const angle=col/armSides*Math.PI*2;
          const p=center.clone().addScaledVector(normal,Math.cos(angle)*radius).addScaledVector(binormal,Math.sin(angle)*radius);
          armPositions.push(p.x,p.y,p.z);
        }
      }
      for(let row=0;row<armSteps;row++)for(let col=0;col<armSides;col++){
        const a=row*armSides+col,b=row*armSides+(col+1)%armSides;
        armIndices.push(a,b,a+armSides,b,b+armSides,a+armSides);
      }
      const armGeometry=new THREE.BufferGeometry();
      armGeometry.setAttribute('position',new THREE.Float32BufferAttribute(armPositions,3));
      armGeometry.setIndex(armIndices);armGeometry.computeVertexNormals();
      const armMesh=add(this.group,armGeometry,mats[0],0,0,0);
      const wrist=armPath.getPoint(0.91);
      const cuff=add(this.group,new THREE.CylinderGeometry(0.085,0.092,0.06,10),mats[1],wrist.x,wrist.y,wrist.z);
      cuff.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),armPath.getTangent(0.91).normalize());
      const hand=armPath.getPoint(1);
      const glove=add(this.group,new THREE.IcosahedronGeometry(0.105,1),black,hand.x+0.065,hand.y,hand.z);
      glove.scale.set(1.25,0.75,0.82);
      const thumb=add(glove,new THREE.IcosahedronGeometry(0.047,0),black,0.012,-0.06,-side*0.065);
      thumb.scale.set(1.35,0.75,0.9);
      {
        const pivot=armPath.getPoint(0);
        const arm=new THREE.Group();arm.position.copy(pivot);this.group.add(arm);
        armGeometry.translate(-pivot.x,-pivot.y,-pivot.z);
        arm.add(armMesh);
        cuff.position.sub(pivot);glove.position.sub(pivot);arm.add(cuff,glove);
        this.arms.push(arm);
        this.armFlex.push({geometry:armGeometry,rest:new Float32Array((armGeometry.getAttribute('position') as THREE.BufferAttribute).array),elbow:armPath.getPoint(0.48).sub(pivot),cuff,hand:glove,cuffRest:cuff.position.clone(),handRest:glove.position.clone(),cuffRotation:cuff.quaternion.clone()});
        if(side===1) this.holdingArm=arm;
      }
      const leg=new THREE.Group();leg.position.set(-0.57,0,side*0.19);
      // Rounded hip and tapered thigh are one closed surface, with the root
      // overlapping the pelvis throughout the full kick instead of a flat cut.
      const thighProfile=[[0.23,0],[0.20,0.105],[0.13,0.165],[0.04,0.18],[-0.09,0.18],[-0.22,0.165],[-0.4,0.145],[-0.58,0.13],[-0.66,0.12],[-0.68,0]];
      const thighMaterial=mats[0].clone();thighMaterial.flatShading=false;
      const thigh=add(leg,new THREE.LatheGeometry(thighProfile.map(([x,r])=>new THREE.Vector2(r,x<0?x*1.13:x)),12),thighMaterial,0,0,0);
      thigh.rotation.z=-Math.PI/2;
      thigh.scale.x=0.9;
      const knee=new THREE.Group();knee.position.x=-0.712;leg.add(knee);
      add(knee,new THREE.IcosahedronGeometry(0.13,0),mats[1],0,0,0);
      const calfProfile=[[0.08,0],[0.055,0.105],[-0.06,0.128],[-0.22,0.132],[-0.39,0.113],[-0.56,0.083],[-0.67,0.079],[-0.69,0]];
      const calf=add(knee,new THREE.LatheGeometry(calfProfile.map(([x,r])=>new THREE.Vector2(r,x)),10),mats[0],0,0,0);
      calf.name='tapered-calf';calf.rotation.z=-Math.PI/2;calf.scale.x=0.88;
      const ankle=new THREE.Group();ankle.position.set(-0.64,0,0);knee.add(ankle);
      box(ankle,[0.3,0.16,0.23],black,-0.1,0,0);
      const len=[1.22,0.92,1.08][variant];
      // Broad webbed blade: width increases away from the foot, with a scalloped tip.
      const positions:number[]=[];const indices:number[]=[];
      for(let row=0;row<=6;row++){
        const u=row/6;const width=0.105+Math.sin(u*Math.PI/2)*[0.40,0.44,0.42][variant];
        for(let col=0;col<5;col++){
          const v=col/4*2-1;
          const x=-0.19-len*u+(row===6?0.07*(1-Math.abs(v)):0);
          positions.push(x,-0.06+Math.abs(v)*0.035,v*width);
        }
      }
      for(let row=0;row<6;row++)for(let col=0;col<4;col++){
        const a=row*5+col;indices.push(a,a+5,a+1,a+1,a+5,a+6);
      }
      // Closed blade edges keep the fin readable edge-on and during a kick.
      const topCount=positions.length/3;
      for(let vertex=0;vertex<topCount;vertex++) positions.push(positions[vertex*3],positions[vertex*3+1]-0.018,positions[vertex*3+2]);
      const topIndices=[...indices];
      for(let i=0;i<topIndices.length;i+=3) indices.push(topIndices[i]+topCount,topIndices[i+2]+topCount,topIndices[i+1]+topCount);
      const perimeter=[0,1,2,3,4,9,14,19,24,29,34,33,32,31,30,25,20,15,10,5];
      for(let i=0;i<perimeter.length;i++){
        const a=perimeter[i],b=perimeter[(i+1)%perimeter.length];
        indices.push(a,b,a+topCount,b,b+topCount,a+topCount);
      }
      const bladeGeo=new THREE.BufferGeometry();bladeGeo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));bladeGeo.setIndex(indices);bladeGeo.computeVertexNormals();
      const bladeMat=mats[1].clone();bladeMat.side=THREE.DoubleSide;
      const blade=add(ankle,bladeGeo,bladeMat,0,0,0);blade.rotation.x=side*0.25;
      this.blades.push({geometry:bladeGeo,rest:new Float32Array(positions),length:len});
      this.knees.push(knee);this.ankles.push(ankle);
      this.group.add(leg);this.legs.push(leg);
      const hipGeometry=new THREE.BufferGeometry();
      hipGeometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(9*12*3),3));
      const hipIndices:number[]=[];
      for(let row=0;row<8;row++)for(let col=0;col<12;col++){
        const a=row*12+col,b=row*12+(col+1)%12;
        hipIndices.push(a,b,a+12,b,b+12,a+12);
      }
      hipGeometry.setIndex(hipIndices);
      const hip=add(this.group,hipGeometry,thighMaterial,0,0,0);
      this.hipBridges.push(hip);
    }
    if(variant===0){
      const snorkelPath=new THREE.CatmullRomCurve3([
        new THREE.Vector3(1.19,-0.1,-0.17),
        new THREE.Vector3(1.09,-0.1,-0.25),
        new THREE.Vector3(0.99,0.04,-0.28),
        new THREE.Vector3(0.99,0.3,-0.27),
        new THREE.Vector3(1.02,0.57,-0.25),
      ]);
      this.snorkel=add(this.group,new THREE.TubeGeometry(snorkelPath,14,0.032,6,false),mats[1],0,0,0);
      this.snorkelRest=new Float32Array((this.snorkel.geometry.getAttribute('position') as THREE.BufferAttribute).array);
      box(this.group,[0.075,0.07,0.065],black,0.99,0.1,-0.28);
      box(this.group,[0.09,0.065,0.08],black,1.18,-0.1,-0.17);
    }
    if(variant===1){
      const brass=new THREE.MeshStandardMaterial({color:'#b58d51',metalness:0.55,roughness:0.5,flatShading:true});
      const faceMaterial=new THREE.MeshStandardMaterial({color:'#d6ad8d',roughness:0.8,flatShading:true});
      const face=add(this.group,new THREE.IcosahedronGeometry(0.23,1),faceMaterial,1.105,-0.025,0);
      face.scale.set(0.95,0.92,0.95);
      // Frosted pale-blue glass: a reflective skin, not a clear view into the head.
      const glass=new THREE.MeshPhysicalMaterial({color:'#a9c5d0',emissive:'#91c9dc',emissiveIntensity:0.65,transparent:true,opacity:0.79,roughness:0.28,metalness:0.08,clearcoat:1,clearcoatRoughness:0.12,ior:1.46,specularIntensity:0.85,depthWrite:false,side:THREE.FrontSide,flatShading:true});
      const helmet=add(this.group,new THREE.IcosahedronGeometry(0.375,1),glass,1.015,0.02,0);
      helmet.scale.set(1.1,1,1);
      helmet.renderOrder=3;
      const collar=add(this.group,new THREE.CylinderGeometry(0.235,0.25,0.055,12),brass,0.735,0,0);
      collar.rotation.z=Math.PI/2;
      for(const side of [-1,1]){
        box(this.group,[0.2,0.115,0.04],black,-0.4,-0.065,side*0.245);
        box(this.group,[0.17,0.04,0.025],mats[1],-0.4,-0.03,side*0.27);
      }
    }
    if(variant===2){
      const armor=new THREE.MeshStandardMaterial({color:'#303b50',metalness:0.55,roughness:0.38,flatShading:true});
      const shell=add(this.group,new THREE.IcosahedronGeometry(0.335,1),armor,0.99,0.015,0);
      shell.scale.set(1.08,0.94,0.96);
      // One wraparound visor, with chamfered corners instead of two protruding eyes.
      const visorRibbon=(height:number,y:number,offset:number,material:THREE.Material)=>{
        const outline=[[1.07,-0.285],[1.22,-0.255],[1.325,-0.17],[1.325,0.17],[1.22,0.255],[1.07,0.285]];
        const positions:number[]=[],indices:number[]=[];
        for(const [x,z] of outline) positions.push(x+offset,y-height/2,z,x+offset,y+height/2,z);
        for(let i=0;i<outline.length-1;i++){const a=i*2;indices.push(a,a+2,a+1,a+1,a+2,a+3);}
        const geometry=new THREE.BufferGeometry();
        geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
        geometry.setIndex(indices);geometry.computeVertexNormals();
        const surface=add(this.group,geometry,material,0,0,0);
        surface.material.side=THREE.DoubleSide;
      };
      visorRibbon(0.145,0.045,0,black);
      const visorMaterial=new THREE.MeshStandardMaterial({color:'#75c9dc',emissive:'#54bdd6',emissiveIntensity:0.65,metalness:0.35,roughness:0.23,flatShading:true,side:THREE.DoubleSide});
      visorRibbon(0.045,0.045,0.012,visorMaterial);
      visorRibbon(0.035,0.132,0.005,armor);
      // Recessed rectangular headlight sits within the brow, not on a stalk.
      box(this.group,[0.07,0.07,0.18],black,1.235,0.202,0);
      box(this.group,[0.012,0.025,0.115],glow,1.276,0.202,0);
      box(this.group,[0.13,0.025,0.21],armor,1.20,0.248,0);
      for(const side of [-1,1]){
        const jaw=box(this.group,[0.22,0.065,0.045],armor,1.15,-0.095,side*0.235);
        jaw.rotation.y=side*0.35;
        const guard=add(this.group,new THREE.IcosahedronGeometry(0.13,1),mats[1],0.47,-0.01,side*0.28);
        guard.scale.set(1.12,0.6,0.6);
        box(this.group,[0.075,0.025,0.025],glow,0.47,0.005,side*0.35);
      }
    }
    this.initializeRig();
  }
  private initializeRig() {
    // A waist pivot lets the chest lead the stroke without moving the hips.
    if(this.upperBody.parent===null){
      this.upperBody.position.x=-0.3;
      for(const child of [...this.group.children]){
        if(this.legs.includes(child as THREE.Group)||this.hipBridges.includes(child as THREE.Mesh)) continue;
        child.position.x+=0.3;
        this.upperBody.add(child);
      }
      this.group.add(this.upperBody);
      this.headPose.position.set(1.02,0,0);
      for(const child of [...this.upperBody.children]){
        if(!(child instanceof THREE.Mesh)) continue;
        child.geometry.computeBoundingBox();
        const front=child.position.x+(child.geometry.boundingBox?.min.x ?? 0);
        if(child.position.x>0.98 || front>0.98){
          child.position.sub(this.headPose.position);this.headPose.add(child);
        }
      }
      this.upperBody.add(this.headPose);
    }
    this.headPose.name='diver-head-frame';
  }
  update(t:number,toolSwing?:number){
    this.time=t;
    this.headPose.rotation.z=0;
    this.shapeSnorkel(0);
    const kickPhase=t*2.8;
    // Alternate shoulder roll with the legs; each kick produces a smaller chest pulse.
    const leftKick=Math.sin(kickPhase-0.35);
    const rightKick=Math.sin(kickPhase+Math.PI-0.35);
    const shoulderRoll=(leftKick-rightKick)*0.5;
    this.upperBody.rotation.x=shoulderRoll*0.075;
    this.upperBody.rotation.z=Math.sin(kickPhase*2-0.7)*0.035;
    this.upperBody.rotation.y=shoulderRoll*0.028;
    this.arms.forEach((arm,i)=>{
      const phase=kickPhase+i*Math.PI;
      const lift=Math.sin(phase-0.8);
      arm.rotation.z=lift*0.216+Math.max(0,lift)**2*0.144;
      arm.rotation.y=Math.sin(phase-1.1)*0.099;
      const flex=this.armFlex[i];
      const bend=Math.sin(phase-1.25)*0.234;
      const deform=(point:THREE.Vector3)=>{
        const weight=THREE.MathUtils.smoothstep(point.x,flex.elbow.x-0.16,flex.elbow.x+0.19);
        const angle=bend*weight;
        const dx=point.x-flex.elbow.x,dy=point.y-flex.elbow.y;
        point.x=flex.elbow.x+dx*Math.cos(angle)-dy*Math.sin(angle);
        point.y=flex.elbow.y+dx*Math.sin(angle)+dy*Math.cos(angle);
        return point;
      };
      const attr=flex.geometry.getAttribute('position') as THREE.BufferAttribute;
      const point=new THREE.Vector3();
      for(let v=0;v<attr.count;v++){
        deform(point.fromArray(flex.rest,v*3));attr.setXYZ(v,point.x,point.y,point.z);
      }
      attr.needsUpdate=true;flex.geometry.computeVertexNormals();
      flex.cuff.position.copy(deform(flex.cuffRest.clone()));
      flex.hand.position.copy(deform(flex.handRest.clone()));
      const turn=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),bend);
      flex.cuff.quaternion.copy(turn).multiply(flex.cuffRotation);
      flex.hand.rotation.z=bend+Math.sin(phase-1.65)*0.045;
    });
    if(this.holdingArm){
      const elapsed=t-this.swingStart;
      // Anticipate, sweep the scoop, then settle back to the swimming pose.
      const holdingLift=Math.sin(kickPhase+Math.PI-0.8);
      let angle=-0.08+holdingLift*0.216+Math.max(0,holdingLift)**2*0.144;
      const progress=toolSwing!==undefined?1-toolSwing:elapsed/0.94;
      const active=toolSwing!==undefined?toolSwing>0:elapsed<0.94;
      if(active){
        const smooth=(u:number)=>{u=THREE.MathUtils.clamp(u,0,1);return u*u*(3-2*u);};
        if(progress<0.16) angle=THREE.MathUtils.lerp(this.swingFrom,0.352,smooth(progress/0.16));
        else if(progress<0.48) angle=THREE.MathUtils.lerp(0.352,-0.728,smooth((progress-0.16)/0.32));
        else angle=THREE.MathUtils.lerp(-0.728,angle,smooth((progress-0.48)/0.52));
      }
      this.holdingArm.rotation.z=angle;
    }
    this.legs.forEach((leg,i)=>{
      const phase=kickPhase+i*Math.PI;
      leg.rotation.z=Math.sin(phase)*0.24;
      this.knees[i].rotation.z=-0.16-0.28*(0.5+0.5*Math.sin(phase-0.7));
      this.ankles[i].rotation.z=0.12+Math.sin(phase-1.1)*0.2;
      const blade=this.blades[i];const attr=blade.geometry.getAttribute('position') as THREE.BufferAttribute;
      for(let vertex=0;vertex<attr.count;vertex++){
        const x=blade.rest[vertex*3];const u=Math.max(0,(-x-0.19)/blade.length);
        attr.setY(vertex,blade.rest[vertex*3+1]+Math.sin(phase-1.6-u*0.65)*0.18*u*u);
      }
      attr.needsUpdate=true;blade.geometry.computeVertexNormals();
    });
    this.updateHips();
    this.group.position.y=Math.sin(kickPhase*2-1.1)*0.035;
    this.group.rotation.z=Math.sin(kickPhase*2-0.9)*0.018;
  }
  restPose(legAngle:number,armAngle:number,kneeAngle=-0.22,headAngle=0,time=0) {
    this.group.position.y=0;this.group.rotation.z=0;
    this.upperBody.rotation.set(0,0,0);
    this.headPose.rotation.z=headAngle;
    this.shapeSnorkel(THREE.MathUtils.clamp(Math.abs(headAngle)/1.12,0,1));
    this.legs.forEach((leg,i)=>leg.rotation.z=legAngle+Math.sin(time*1.2+i*1.8)*0.025);
    this.arms.forEach((arm,i)=>arm.rotation.set(0,0,armAngle+Math.sin(time*0.9+i)*0.025));
    this.knees.forEach((knee,i)=>knee.rotation.z=kneeAngle+Math.sin(time*1.2+i*1.8-0.5)*0.035);
    this.ankles.forEach(ankle=>ankle.rotation.z=0.1);
    this.updateHips();
  }
  private shapeSnorkel(seated:number) {
    if(!this.snorkel || !this.snorkelRest) return;
    const attr=this.snorkel.geometry.getAttribute('position') as THREE.BufferAttribute;
    for(let i=0;i<attr.count;i++){
      const x=this.snorkelRest[i*3],y=this.snorkelRest[i*3+1],z=this.snorkelRest[i*3+2];
      const top=THREE.MathUtils.smoothstep(y,0.1,0.57)*seated;
      attr.setXYZ(i,x-top*0.18,y-top*0.32,z+top*0.025);
    }
    attr.needsUpdate=true;this.snorkel.geometry.computeVertexNormals();
    this.snorkel.geometry.computeBoundingSphere();
  }
  private updateHips() {
    this.upperBody.updateMatrix();
    this.hipBridges.forEach((hip,i)=>{
      const side=i===0?-1:1,leg=this.legs[i];leg.updateMatrix();
      const attr=hip.geometry.getAttribute('position') as THREE.BufferAttribute;
      for(let row=0;row<=8;row++){
        const u=row/8,w=u*u*(3-2*u);
        const radius=THREE.MathUtils.lerp(0.175,0.172,u);
        for(let col=0;col<12;col++){
          const angle=col/12*Math.PI*2;
          const y=Math.cos(angle)*radius*0.9,z=Math.sin(angle)*radius;
          const pelvis=new THREE.Vector3(-0.15,y,side*0.12+z).applyMatrix4(this.upperBody.matrix);
          const thigh=new THREE.Vector3(-0.22,y,z).applyMatrix4(leg.matrix);
          pelvis.lerp(thigh,w);attr.setXYZ(row*12+col,pelvis.x,pelvis.y,pelvis.z);
        }
      }
      attr.needsUpdate=true;hip.geometry.computeVertexNormals();
      hip.geometry.computeBoundingSphere();
    });
  }
}
