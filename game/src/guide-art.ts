import { lang } from './i18n';
/** Original pen-and-wash diagrams for the field notebook; no downloaded game assets. */
export type GuideArt = 'bench' | 'net' | 'gear' | 'dive' | 'return' | 'sonar';
const paths: Record<GuideArt, string> = {
  bench: `<path fill="#b99571" d="m26 91 88-18 157 15-91 30z"/><path d="m26 91 154 27 91-30M44 100v51m197-51v51m-65-34v51"/><path fill="#e3d4aa" d="m87 86 31-7 27 8-1 21-30-4-27 3z"/><path d="m115 83-1 21m5-8 6-6 6 7 6-3"/><path fill="#91a899" d="m195 85 44 5-8 16-43-6z"/><path d="m191 97 41 6"/><ellipse cx="68" cy="82" rx="16" ry="8" fill="#e1b858"/><path d="m60 86-13 7m162-2 18 3"/><path class="guide-dash" d="m69 60 128 7"/><path d="m183 60 14 7-15 5"/><text x="48" y="51">①</text><text x="108" y="66">②</text><text x="215" y="72">③</text>`,
  net: `<path d="m23 134 72-45" stroke-width="8"/><path d="m22 133 32-21" stroke="#a17d56" stroke-width="10"/><path d="m89 89 16-12"/><path class="guide-dash" d="m109 75 30-17m35-14 27-11"/><path d="m126 57 12 1-4 11m54-38 12 1-4 11"/><ellipse cx="158" cy="61" rx="17" ry="19" fill="#d6b35b" transform="rotate(-33 158 61)"/><path d="m146 65 18-9m-8 7 10 13 12-5"/><ellipse cx="236" cy="57" rx="32" ry="41" fill="#9db8ad" transform="rotate(-33 236 57)"/><path d="m212 25 17 85m-8-92 25 85m-8-84 23 64m-54-40 49 36m-51-22 43 32m-28-62 46 34" stroke-width="1"/><path d="m216 88-10 8" stroke-width="5"/><text x="29" y="160">1 × 杆身</text><text x="124" y="112">1 × 线轮</text><text x="209" y="137">1 × 网圈</text>`,
  gear: `<path fill="#709c96" d="m36 45 26-6 10 18 19 62-39 12-14-70z"/><path d="m42 58 25-8m-11 18 15 52m-22-51 11 54"/><rect x="123" y="31" width="42" height="100" rx="17" fill="#d6b35b"/><path d="m137 31v-9h14v9m-31 20h48m-48 57h48"/><path d="m166 45q24-14 23 22"/><path fill="#789fba" d="m212 47 54 5-6 32-54-5z"/><ellipse cx="238" cy="66" rx="13" ry="14" fill="#f3df92"/><path class="guide-dash" d="m267 55 17-6m-18 19 20 1m-24 12 16 9"/><text x="33" y="158">脚蹼</text><text x="123" y="158">气瓶</text><text x="211" y="158">探照灯</text>`,
  dive: `<path d="M15 38q19-10 38 0t38 0 38 0 38 0 38 0 38 0 38 0" stroke="#668e95"/><path fill="#89aaa9" opacity=".3" d="M15 45h269v114H15z"/><circle cx="118" cy="69" r="13" fill="#d6b35b"/><path d="m128 78 33 33m-27-24-30 12m44 0 26-3m-13 14-11 25m11-25 22 23" stroke-width="7"/><path d="m146 136 17 9m17-10 18 6" stroke="#668e95" stroke-width="8"/><path class="guide-dash" d="m213 63v62"/><path d="m204 113 9 13 9-13"/><text x="226" y="107">3 m</text><rect x="24" y="111" width="65" height="28" rx="5" fill="#e9dcba"/><text x="31" y="131">Shift ↓</text>`,
  return: `<path d="M15 56q19-10 38 0t38 0 38 0 38 0 38 0 38 0 38 0" stroke="#668e95"/><path fill="#b99571" d="m157 29 81 2-18 27h-48z"/><path d="m183 30 2-20h21v20"/><circle cx="118" cy="102" r="11" fill="#d6b35b"/><path d="m110 113-19 20m19-15 26 1m-32 7-5 24m-1-17-18 12" stroke-width="6"/><ellipse cx="151" cy="123" rx="18" ry="12" fill="#91a899"/><path d="m138 122-10-8v15z"/><path class="guide-dash" d="m117 82 1-38"/><path d="m109 55 9-12 9 12"/><text x="39" y="70">W / ↑</text><text x="196" y="93">存入 ✓</text>`,
  sonar: `<path d="M22 33q17-8 34 0t34 0 34 0 34 0 34 0 34 0 34 0" stroke="#668e95"/><rect x="126" y="23" width="38" height="17" rx="6" fill="#d6b35b"/><path d="m145 40v88"/><circle cx="145" cy="133" r="12" fill="#709c96"/><circle cx="145" cy="60" r="4" fill="#709c96"/><circle cx="145" cy="85" r="4" fill="#709c96"/><circle cx="145" cy="110" r="4" fill="#709c96"/><path class="guide-dash" d="m123 121q-18 13 0 26m-14-36q-33 22 0 45m58-35q18 13 0 26m14-36q33 22 0 45"/><text x="44" y="80">V 投放</text><text x="192" y="80">脉冲指路</text>`,
};
// The sketches' pencilled labels are written in Chinese; English swaps them at render time.
const LABELS_EN: Record<string, string> = {
  '1 × 杆身': '1 × Rod', '1 × 线轮': '1 × Reel', '1 × 网圈': '1 × Net hoop',
  '脚蹼': 'Fins', '气瓶': 'Tank', '探照灯': 'Lamp', '存入 ✓': 'Banked ✓', 'V 投放': 'V to drop', '脉冲指路': 'Pulse path',
};

export function guideArt(kind: GuideArt) {
  const svg = guideSvg(kind);
  return lang() === 'zh' ? svg : svg.replace(/>([^<]+)<\/text>/g, (m, label: string) => (LABELS_EN[label] ? `>${LABELS_EN[label]}</text>` : m));
}

function guideSvg(kind: GuideArt) {
  return `<svg viewBox="0 0 300 180" class="guide-sketch" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg>`;
}
