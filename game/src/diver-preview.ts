import * as THREE from 'three';
import { DiverConcept } from './diver-designs';
const views = [0,1,2].map(i=>{
  const host=document.querySelector<HTMLElement>(`#view-${i}`)!;
  const scene=new THREE.Scene();scene.background=new THREE.Color(['#123139','#333c33','#17223b'][i]);
  const camera=new THREE.PerspectiveCamera(32,1,0.1,50);camera.position.set(1,2.8,11.5);camera.lookAt(-0.3,0,0);
  const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));host.append(renderer.domElement);
  scene.add(new THREE.HemisphereLight('#dcfff8','#162132',2.5));const light=new THREE.DirectionalLight('#fff',3);light.position.set(2,5,6);scene.add(light);
  const diver=new DiverConcept(i);scene.add(diver.group);let rotating=false;
  document.querySelector(`#rotate-${i}`)!.addEventListener('click',()=>{rotating=!rotating;});
  const button=document.createElement('button');button.textContent='手臂动作';button.style.marginLeft='8px';button.addEventListener('click',()=>diver.swing());document.querySelector(`#rotate-${i}`)!.after(button);
  const resize=()=>{const rect=host.getBoundingClientRect();renderer.setSize(rect.width,rect.height);camera.aspect=rect.width/rect.height;const distance=Math.max(4.8,(i===0?3.6:3.1)/(Math.tan(THREE.MathUtils.degToRad(16))*camera.aspect));camera.position.set(0.6,distance*0.18,distance);camera.lookAt(i===0?0:-0.45,0,0);camera.updateProjectionMatrix();};new ResizeObserver(resize).observe(host);resize();
  return {scene,camera,renderer,diver,rotate:()=>rotating};
});
const clock=new THREE.Clock();
function frame(){const dt=Math.min(clock.getDelta(),0.05);for(const v of views){v.diver.update(clock.elapsedTime);if(v.rotate())v.diver.group.rotation.y+=dt*0.6;v.renderer.render(v.scene,v.camera);}requestAnimationFrame(frame);}frame();
