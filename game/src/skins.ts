import * as THREE from 'three';
import { DiverConcept } from './diver-designs';
import { skinUnlocked,skinTrials,useSkinTrial } from './skin-access';
import { onLangChange, t } from './i18n';
export const SKINS = [
  {zh:'逐浪者',en:'Current Runner',map:'fjord',scene:['Fjord','峡湾'],bonus:['Swim speed +10%','游泳速度 +10%'],zhText:'轻装自由潜水员，擅长浅水巡游与快速推进。',enText:'An agile freediver built for shallow-water exploration and swift travel.',color:'#83ead5'},
  {zh:'潮汐探险家',en:'Tidal Explorer',map:'tianchi',scene:['Heaven Lake','天池'],bonus:['Catch reach +10%','捕鱼范围 +10%'],zhText:'玻璃头套下的沉静探索者，擅长湖泊与沉木水域采集。',enText:'A patient explorer specializing in lake habitats and submerged forests.',color:'#ddc38a'},
  {zh:'深渊侦察员',en:'Abyss Scout',map:'ocean',scene:['Open Ocean','外海'],bonus:['Lamp range +15%','照明距离 +15%'],zhText:'低阻力科技潜水服与横向视窗，为深水侦察而设计。',enText:'A streamlined technical suit and panoramic visor designed for deep-water reconnaissance.',color:'#8ed9ff'},
] as const;

export class SkinPicker {
  private root=document.createElement('div');
  private model:DiverConcept|null=null;
  private scene=new THREE.Scene();
  private rig=new THREE.Group();
  private camera=new THREE.PerspectiveCamera(32,1,.1,50);
  private renderer:THREE.WebGLRenderer|null=null;
  private index=0;
  private frame=0;
  private started=0;
  private chosen=0;
  get open(){return !this.root.hidden;}
  constructor(private apply:(index:number)=>void,private pause:(open:boolean)=>void,private context:()=>string,private previewOnly=false){
    const style=document.createElement('style');style.textContent=`
    .skin-overlay{position:fixed;inset:0;z-index:10000;background:#061820ed;display:grid;place-items:center;backdrop-filter:blur(14px);font-family:system-ui;color:#e7f4f4}.skin-overlay[hidden]{display:none}.skin-panel{width:min(540px,100%);height:min(860px,100dvh);overflow:auto;background:linear-gradient(160deg,#153941,#091c29);border:1px solid #7cc9c43a;padding:24px;position:relative}.skin-top{display:flex;justify-content:space-between;align-items:center;font:11px monospace;letter-spacing:2px;color:#8fb8bf}.skin-overlay button{cursor:pointer;color:inherit;background:#ffffff08;border:1px solid #a8d8de45;padding:11px 17px;border-radius:3px}.skin-view{height:290px;touch-action:pan-y;position:relative}.skin-view canvas{display:block;width:100%;height:100%}.skin-nav{display:flex;justify-content:space-between;align-items:center;color:#93b9bf;font:12px monospace}.skin-title{margin:22px 0 5px;font-size:30px}.skin-en{font:12px monospace;letter-spacing:2px;color:#94bdc4}.skin-desc{line-height:1.7;color:#bed1d5;margin:18px 0}.skin-desc span{display:block;font-size:13px;color:#90aab3;margin-top:7px}.skin-specialty{padding:17px;background:#05141b80;border-left:3px solid var(--skin-color);line-height:1.8}.skin-specialty small{display:block;color:#8caab6;font:10px monospace;letter-spacing:2px}.skin-bonus{color:var(--skin-color);font-weight:600}.skin-status{font-size:12px;color:#aac0c9;margin-top:8px}.skin-apply{width:100%;margin-top:22px;background:var(--skin-color)!important;color:#09212a!important;font-weight:700}.skin-hint{position:fixed;bottom:95px;left:50%;transform:translateX(-50%);font:12px system-ui;color:#d9f5f4;background:#102c36cc;padding:7px 14px;border-radius:20px;pointer-events:none;z-index:25;white-space:nowrap}@media(max-height:720px){.skin-view{height:200px}.skin-panel{padding:16px}.skin-title{margin-top:12px}.skin-desc{margin:12px 0}}
    `;document.head.append(style);
    style.textContent+=`.skin-overlay{background:radial-gradient(ellipse at 15% 15%,#6cacb442,transparent 60%),#06182080;backdrop-filter:blur(12px)}.skin-panel{background:linear-gradient(135deg,#d6f8ff24,#b6e6f00b 48%,#79b3ce20);border:1px solid #e3faff50;border-radius:20px;box-shadow:inset 0 1px 0 #fff5,inset 1px 0 0 #fff2,0 24px 80px #0005;backdrop-filter:blur(28px) saturate(145%)}.skin-specialty{background:linear-gradient(120deg,#d9faff13,#d9faff05);border-top:1px solid #fff2;border-bottom:1px solid #fff1;border-radius:8px}.skin-overlay button{border-radius:9px;background:linear-gradient(140deg,#ffffff20,#ffffff06);box-shadow:inset 0 1px 0 #ffffff20}.skin-view:after{content:'右键拖拽旋转 / Right-drag to rotate';position:absolute;bottom:8px;left:0;right:0;text-align:center;font:10px monospace;color:#b7d3da;pointer-events:none}`;
    style.textContent+=`.skin-panel{width:min(490px,calc(100% - 24px));height:min(780px,calc(100dvh - 24px));padding:21px;border-radius:18px}.skin-view{height:255px}.skin-title{font-size:27px;margin-top:18px}.skin-en{font-size:11px}.skin-desc{font-size:13px;margin:15px 0}.skin-desc span{font-size:12px}.skin-specialty{padding:14px;font-size:13px}.skin-overlay button{padding:9px 14px}.skin-apply{margin-top:18px}@media(max-height:720px){.skin-panel{padding:16px}.skin-view{height:180px}.skin-title{margin-top:12px}.skin-desc{margin:11px 0}}`;
    style.textContent+=`.skin-panel{width:min(441px,calc(100% - 28px));height:min(702px,calc(100dvh - 28px));padding:19px;border-radius:16px}.skin-view{height:230px}.skin-title{font-size:24px;margin-top:16px}.skin-en{font-size:10px}.skin-desc{font-size:12px;margin:13px 0}.skin-desc span{font-size:11px}.skin-specialty{padding:12px;font-size:12px}.skin-overlay button{padding:8px 13px}.skin-apply{margin-top:16px}@media(max-height:720px){.skin-panel{padding:14px}.skin-view{height:162px}.skin-title{margin-top:11px}.skin-desc{margin:10px 0}}`;
    this.scene.add(this.rig);
    this.root.className='skin-overlay';this.root.hidden=true;this.root.setAttribute('role','dialog');this.root.setAttribute('aria-modal','true');
    this.root.innerHTML=`<section class="skin-panel"><div class="skin-top"><span data-head></span><button data-close>✕</button></div><div class="skin-view"></div><div class="skin-nav"><button data-prev>←</button><span data-count></span><button data-next>→</button></div><h2 class="skin-title"></h2><div class="skin-en"></div><p class="skin-desc"></p><div class="skin-specialty"><small data-specialty></small><div data-scene></div><div class="skin-bonus"></div><div class="skin-status"></div></div><button class="skin-apply"></button></section>`;
    document.body.append(this.root);
    onLangChange(()=>{if(this.open)this.renderCard();});
    this.root.querySelector('[data-close]')!.addEventListener('click',()=>this.close());
    this.root.querySelector('[data-prev]')!.addEventListener('click',()=>this.change(-1));
    this.root.querySelector('[data-next]')!.addEventListener('click',()=>this.change(1));
    this.root.querySelector('.skin-apply')!.addEventListener('click',()=>{
      if(!this.previewOnly&&this.index!==this.chosen&&!useSkinTrial(this.index)){this.renderCard();return;}
      this.chosen=this.index;this.apply(this.index);this.close();
    });
    let x=0,y=0;
    const view=this.root.querySelector<HTMLElement>('.skin-view')!;
    let gesture:'rotate'|'swipe'|null=null,activePointer:number|null=null,lastX=0,lastY=0;
    const resetGesture=()=>{gesture=null;activePointer=null;};
    view.addEventListener('contextmenu',e=>e.preventDefault());
    view.addEventListener('pointerdown',e=>{
      if(activePointer!==null || (e.button!==0&&e.button!==2))return;
      gesture=e.button===2?'rotate':'swipe';activePointer=e.pointerId;
      x=lastX=e.clientX;y=lastY=e.clientY;view.setPointerCapture(e.pointerId);
      if(gesture==='rotate')e.preventDefault();
    });
    view.addEventListener('pointermove',e=>{
      if(gesture!=='rotate'||e.pointerId!==activePointer)return;
      this.rig.rotation.y+=(e.clientX-lastX)*0.009;
      this.rig.rotation.x=THREE.MathUtils.clamp(this.rig.rotation.x+(e.clientY-lastY)*0.007,-1,1);
      lastX=e.clientX;lastY=e.clientY;
    });
    view.addEventListener('pointerup',e=>{
      if(e.pointerId!==activePointer)return;
      const swipe=gesture==='swipe'&&e.button===0;
      resetGesture();
      if(!swipe)return;
      const dx=e.clientX-x;
      if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(e.clientY-y))this.change(dx<0?1:-1);
    });
    view.addEventListener('pointercancel',resetGesture);
    view.addEventListener('lostpointercapture',resetGesture);
    this.root.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(e.key==='Escape')this.close();if(e.key==='ArrowLeft')this.change(-1);if(e.key==='ArrowRight')this.change(1);
      if(e.key==='Tab'){
        const buttons=[...this.root.querySelectorAll<HTMLButtonElement>('button')];
        const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();buttons[(index+(e.shiftKey?-1:1)+buttons.length)%buttons.length].focus();
      }
    });
  }
  show(){if(this.open)return;this.index=this.chosen;this.root.hidden=false;this.pause(true);this.renderCard();this.root.querySelector<HTMLButtonElement>('[data-close]')!.focus();this.started=performance.now();this.animate();}
  close(){this.root.hidden=true;cancelAnimationFrame(this.frame);this.pause(false);}
  resetChoice(){this.chosen=0;}
  private change(delta:number){this.index=(this.index+delta+SKINS.length)%SKINS.length;this.renderCard();}
  private renderCard(){
    const skin=SKINS[this.index];this.root.style.setProperty('--skin-color',skin.color);
    this.root.setAttribute('aria-label',t('Diver skins','潜水员皮肤'));
    this.root.querySelector('[data-head]')!.textContent=t('DIVER','角色换装');
    this.root.querySelector('[data-close]')!.setAttribute('aria-label',t('Close','关闭'));
    this.root.querySelector('[data-prev]')!.setAttribute('aria-label',t('Previous','上一款'));
    this.root.querySelector('[data-next]')!.setAttribute('aria-label',t('Next','下一款'));
    this.root.querySelector('[data-specialty]')!.textContent=t('SCENE SPECIALTY','场景专精');
    this.root.querySelector('.skin-title')!.textContent=t(skin.en,skin.zh);this.root.querySelector('.skin-en')!.textContent='';
    this.root.querySelector('[data-count]')!.textContent=`0${this.index+1} / 03 · ${t('SWIPE','左右滑动')}`;
    this.root.querySelector('.skin-desc')!.textContent=t(skin.enText,skin.zhText);
    this.root.querySelector('[data-scene]')!.textContent=t(skin.scene[0],skin.scene[1]);this.root.querySelector('.skin-bonus')!.textContent=t(skin.bonus[0],skin.bonus[1]);
    this.root.querySelector('.skin-status')!.textContent=this.context()===skin.map?t('Specialty active here','当前场景：专精加成生效'):t('No specialty bonus in this scene','当前场景不触发专精加成');
    const unlocked=skinUnlocked(this.index),remaining=skinTrials(this.index);
    const equipped=this.index===this.chosen;
    const button=this.root.querySelector<HTMLButtonElement>('.skin-apply')!;
    button.disabled=!unlocked&&remaining===0&&!equipped;
    button.textContent=equipped?t('Equipped','已装备'):unlocked?t('Equip diver','使用角色'):remaining>0?t(`Try skin · ${remaining}/2 left`,`试玩一次 · 剩余 ${remaining}/2`):t('Locked · no trials left','待解锁 · 试玩已用完');
    if(!unlocked){
      this.root.querySelector('.skin-status')!.textContent=t(`Play ${this.index===1?'map 2 · Heaven Lake':'map 3 · Open Ocean'} to unlock · trials ${remaining}/2 (this dive)`,`待解锁：游玩地图${this.index===1?'二 · 天池':'三 · 外海'} · 试玩 ${remaining}/2（本次下潜有效）`);
    }
    if(!this.renderer){this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.root.querySelector('.skin-view')!.append(this.renderer.domElement);this.scene.add(new THREE.HemisphereLight('#e4ffff','#18324b',2.4));const light=new THREE.DirectionalLight('#fff',3);light.position.set(2,5,6);this.scene.add(light);}
    if(this.model){this.rig.remove(this.model.group);this.model.group.traverse(obj=>{if(obj instanceof THREE.Mesh){obj.geometry.dispose();const mats=Array.isArray(obj.material)?obj.material:[obj.material];mats.forEach(m=>m.dispose());}});}
    this.rig.rotation.set(0,0,0);
    this.model=new DiverConcept(this.index);this.rig.add(this.model.group);
  }
  private animate=()=>{if(!this.open)return;const view=this.root.querySelector<HTMLElement>('.skin-view')!;const width=view.clientWidth,height=view.clientHeight;this.renderer!.setSize(width,height,false);this.camera.aspect=width/height;this.camera.position.set(.2,1.3,Math.max(6,4/(Math.tan(THREE.MathUtils.degToRad(16))*this.camera.aspect)));this.camera.lookAt(-.6,0,0);this.camera.updateProjectionMatrix();this.model!.update((performance.now()-this.started)/1000);this.renderer!.render(this.scene,this.camera);this.frame=requestAnimationFrame(this.animate);};
}
