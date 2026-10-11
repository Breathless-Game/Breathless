import { storageKey } from './wallet';
type Progress={mapRank:number;used:number[]};
const fallback=new Map<string,Progress>();
const key=()=>storageKey('breathless-skin-access-v1');
function read():Progress{
  try{const data=JSON.parse(localStorage.getItem(key())??'null');if(data)return {mapRank:Math.max(0,Math.min(2,Number(data.mapRank)||0)),used:[0,...[1,2].map(i=>Math.max(0,Math.min(2,Number(data.used?.[i])||0)))]};}catch{}
  return fallback.get(key())??{mapRank:0,used:[0,0,0]};
}
function save(data:Progress){fallback.set(key(),data);try{localStorage.setItem(key(),JSON.stringify(data));}catch{}}
export function visitSkinMap(map:string){const data=read();data.mapRank=Math.max(data.mapRank,map==='ocean'?2:map==='tianchi'?1:0);save(data);}
export function skinUnlocked(index:number){return index===0||read().mapRank>=index;}
export function skinTrials(index:number){return Math.max(0,2-(read().used[index]??0));}
export function useSkinTrial(index:number){if(skinUnlocked(index))return true;const data=read();if((data.used[index]??0)>=2)return false;data.used[index]=(data.used[index]??0)+1;save(data);return true;}
