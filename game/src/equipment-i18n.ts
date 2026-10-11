// Chinese display text and language-aware helpers for equipment.ts data.
// Kept out of equipment.ts so that file stays import-free (tests load it standalone).
import { lang } from './i18n';
import { EQUIPMENT_TIERS, ROD_TIERS, type EquipmentPathDef, type UpgradeSlot } from './equipment';


/** Chinese display text for each slot tier: [name, effect]. Net effect is built from ROD_TIERS. */
const SLOT_TIER_ZH: Record<Exclude<UpgradeSlot, 'net'>, readonly (readonly [string, string])[]> = {
  rod: [['短杆身', '基础工具长度'], ['伸缩杆身', '工具长度 +0.2 m'], ['深渊杆身', '工具长度 +0.4 m']],
  reel: [['手摇线轮', '基础挥网恢复'], ['滚珠线轮', '恢复加快 20%'], ['磁力线轮', '恢复加快 40%']],
  fins: [['标准脚蹼', '游速 7.5 m/s'], ['顺流脚蹼', '游速 8.5 m/s'], ['洋流脚蹼', '游速 9.5 m/s']],
  tank: [['无备用气', '紧急返回 3.2 s'], ['应急气瓶', '紧急返回 4.2 s'], ['双备用气瓶', '紧急返回 5.2 s']],
  lamp: [['面镜灯', '光束 18 m'], ['长焦反射杯', '光束 28 m'], ['广角扩散罩', '宽光束 38 m']],
  sonar: [['深海声纳', '线缆 10 m · 3 个脉冲节点'], ['长线声纳', '线缆 17 m · 4 个脉冲节点'], ['深渊声纳', '线缆 26 m · 5 个脉冲节点']],
};
const NET_NAME_ZH = ['基础网', '加固网', '深渊网'];

/** Language-aware tier name for the current UI language. */
export function tierName(slot: UpgradeSlot, level: number): string {
  const tier = EQUIPMENT_TIERS[slot][level - 1] ?? EQUIPMENT_TIERS[slot][0];
  if (lang() !== 'zh') return tier.name;
  if (slot === 'net') return NET_NAME_ZH[tier.level - 1] ?? tier.name;
  return SLOT_TIER_ZH[slot][tier.level - 1]?.[0] ?? tier.name;
}

/** Language-aware tier effect for the current UI language. */
export function tierEffect(slot: UpgradeSlot, level: number): string {
  const tier = EQUIPMENT_TIERS[slot][level - 1] ?? EQUIPMENT_TIERS[slot][0];
  if (lang() !== 'zh') return tier.effect;
  if (slot === 'net') {
    const rod = ROD_TIERS[tier.level - 1] ?? ROD_TIERS[0];
    return `${rod.capacity} 条鱼 · 捕获半径 ${rod.catchRadius.toFixed(1)} m`;
  }
  return SLOT_TIER_ZH[slot][tier.level - 1]?.[1] ?? tier.effect;
}
/** Chinese display text per path: [summary, [effect1, effect2, effect3]]. */
const PATH_ZH: Record<string, readonly [string, readonly [string, string, string]]> = {
  'rod:far': ['射程更远，回收稍慢。', ['基础射程', '射程 +0.18 m · 恢复 −4%', '射程 +0.36 m · 恢复 −8%']],
  'rod:fast': ['射程更短，连续挥动更快。', ['基础操作', '射程 −0.12 m · 恢复 +12%', '射程 −0.24 m · 恢复 +24%']],
  'net:wide': ['容量更大，挥动时阻力更多。', ['基础网目', '容量 +1 · 半径 +0.12 m · 恢复 −5%', '容量 +2 · 半径 +0.24 m · 恢复 −10%']],
  'net:fine': ['捕获范围更大，容量较小。', ['基础网目', '半径 +0.28 m · 恢复 +3%', '半径 +0.56 m · 恢复 +6%']],
  'fins:sprint': ['极速和加速度更高。', ['基础推力', '速度 +0.7 m/s · 加速度 +2', '速度 +1.4 m/s · 加速度 +4']],
  'fins:silent': ['速度加成较小，游动节奏更稳。', ['基础推力', '速度 +0.2 m/s · 加速度 +0.5', '速度 +0.4 m/s · 加速度 +1']],
  'tank:long': ['确认水下换气后，应急返回时间更长。', ['基础储备', '应急时间 +0.8 s', '应急时间 +1.6 s']],
  'tank:light': ['轻量储备方案：用返回时间换取一点游速。', ['基础储备', '储备 +0.35 s · 速度 +0.15 m/s', '储备 +0.7 s · 速度 +0.3 m/s']],
  'lamp:focus': ['光束更窄更亮，适合深处目标。', ['基础光束', '距离 +5 m · 亮度 +10 · 角度 −0.12 rad', '距离 +10 m · 亮度 +20 · 角度 −0.24 rad']],
  'lamp:wideLamp': ['看清周围更大范围，代价是照射距离。', ['基础光束', '角度 +0.18 rad · 亮度 −4', '角度 +0.36 rad · 亮度 −8']],
  'reel:fastReel': ['两次挥动之间恢复更短。', ['基础恢复', '恢复 +12%', '恢复 +24%']],
  'reel:silentReel': ['挥动节奏平稳，恢复增益较小。', ['基础恢复', '恢复 +5%', '恢复 +10%']],
};

/** Language-aware path name. */
export function pathName(path: EquipmentPathDef): string {
  return lang() === 'zh' ? path.nameZh : path.name;
}
/** Language-aware path summary. */
export function pathSummary(path: EquipmentPathDef): string {
  return lang() === 'zh' ? PATH_ZH[`${path.slot}:${path.id}`]?.[0] ?? path.summary : path.summary;
}
/** Language-aware effect text of a path at level 1-3. */
export function pathEffect(path: EquipmentPathDef, level: number): string {
  const i = Math.max(0, Math.min(2, level - 1));
  const en = path.tiers[i].effect;
  return lang() === 'zh' ? PATH_ZH[`${path.slot}:${path.id}`]?.[1][i] ?? en : en;
}
