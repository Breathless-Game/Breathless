import type { BreathSource } from './breath';
import { t as tr } from './i18n';

// A guided 2.5-minute breath test. The screen tells the player when to hold
// and when to breathe, so every second of the recording is labeled without
// them having to press anything. The sensor saves the session to
// sensor/recordings/, and analyze.mjs tunes the detector against it.

type Kind = 'connecting' | 'warmup' | 'ready' | 'hold' | 'breathe' | 'done';

interface Step {
  kind: Kind;
  secs: number;
  title: [string, string];
  sub: [string, string];
}

const ROUNDS = 4;
const SCRIPT: Step[] = [
  { kind: 'warmup', secs: 30, title: ['Breathe normally', '正常呼吸'], sub: ['Sit still, face and chest in view', '坐稳，脸和胸口保持在画面内'] },
  ...Array.from({ length: ROUNDS }, (_, i): Step[] => [
    { kind: 'ready', secs: 3, title: [`Get ready to hold (${i + 1}/${ROUNDS})`, `准备憋气 (${i + 1}/${ROUNDS})`], sub: ['Breathe in when it says HOLD', '看到“憋气”时吸气'] },
    { kind: 'hold', secs: 15, title: ['HOLD your breath', '憋气'], sub: ['Stay still, don’t talk', '保持不动，不要说话'] },
    { kind: 'breathe', secs: 15, title: ['Breathe normally', '正常呼吸'], sub: ['Breathe normally', '正常呼吸'] },
  ]).flat(),
];

const $ = (id: string) => document.getElementById(id)!;

interface HoldResult {
  detectedAfter: number | null; // seconds into the hold, or null if never
}

export class BreathTest {
  private panel = $('test');
  private title = $('test-title');
  private sub = $('test-sub');
  private count = $('test-count');
  private bar = $('test-bar');
  private seen = $('test-seen');
  private result = $('test-result');
  private timer = 0;
  private step = -1;
  private stepStart = 0;
  private connectingSince = 0;
  private holds: HoldResult[] = [];
  private breatheTicks = 0;
  private falseHoldTicks = 0;
  running = false;

  constructor(private breath: BreathSource) {}

  get open() {
    return !this.panel.classList.contains('hidden');
  }

  start() {
    this.running = true;
    this.step = -1;
    this.holds = [];
    this.breatheTicks = 0;
    this.falseHoldTicks = 0;
    this.connectingSince = performance.now();
    this.panel.classList.remove('hidden');
    this.result.classList.add('hidden');
    $('overlay').classList.add('testing');
    this.render({ kind: 'connecting', secs: 0, title: ['Starting camera and Presage…', '正在启动摄像头和 Presage…'], sub: ['Connecting', '正在连接'] }, 0);
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  stop() {
    clearInterval(this.timer);
    this.running = false;
    this.breath.sendLabel(false);
    this.breath.sendCalib('test-stop');
    this.panel.classList.add('hidden');
    $('overlay').classList.remove('testing');
  }

  private tick() {
    const s = this.breath.state;
    const now = performance.now();
    this.seen.textContent = s.holding ? tr('Sensor sees: HOLDING', '传感器识别：憋气') : tr('Sensor sees: BREATHING', '传感器识别：呼吸');
    this.seen.className = `test-seen ${s.holding ? 'holding' : ''}`;

    if (this.step < 0) {
      // Wait for the camera frames to turn into a breathing trace.
      if (s.connected && s.trace.length > 0) {
        this.breath.sendCalib('test-start');
        this.enter(0, now);
      } else {
        const waited = (now - this.connectingSince) / 1000;
        this.sub.textContent = s.error
          ? s.error
          : !s.connected
            ? tr('Breath sensor offline: is `npm run sensor` running?', '呼吸传感器离线：`npm run sensor` 在运行吗？')
            : s.hint || tr(`Waiting for Presage… ${waited.toFixed(0)} s`, `等待 Presage… ${waited.toFixed(0)} 秒`);
      }
      return;
    }

    const st = SCRIPT[this.step];
    const t = (now - this.stepStart) / 1000;
    const sub = tr(...st.sub);
    if (st.kind === 'hold') {
      const h = this.holds.at(-1)!;
      if (s.holding && h.detectedAfter == null) h.detectedAfter = t;
    } else if ((st.kind === 'breathe' || st.kind === 'warmup') && t > 4) {
      // Skip the first seconds after a hold: the detector is allowed to catch up.
      this.breatheTicks++;
      if (s.holding) this.falseHoldTicks++;
    }
    this.sub.textContent = s.hint && st.kind !== 'hold' ? `${sub} · ${s.hint}` : sub;
    this.render(st, t);
    if (t >= st.secs) this.enter(this.step + 1, now);
  }

  private enter(i: number, now: number) {
    this.step = i;
    this.stepStart = now;
    if (i >= SCRIPT.length) return this.finish();
    const st = SCRIPT[i];
    this.breath.sendLabel(st.kind === 'hold');
    if (st.kind === 'hold') this.holds.push({ detectedAfter: null });
    this.panel.dataset.kind = st.kind;
    this.title.textContent = tr(...st.title);
    this.sub.textContent = tr(...st.sub);
  }

  private render(st: Step, t: number) {
    this.panel.dataset.kind = st.kind;
    this.title.textContent = tr(...st.title);
    if (st.kind === 'connecting') {
      this.count.textContent = '';
      this.bar.style.width = '0%';
      return;
    }
    this.count.textContent = String(Math.max(0, Math.ceil(st.secs - t)));
    const done = SCRIPT.slice(0, this.step).reduce((a, x) => a + x.secs, 0) + Math.min(t, st.secs);
    const total = SCRIPT.reduce((a, x) => a + x.secs, 0);
    this.bar.style.width = `${(done / total) * 100}%`;
  }

  private finish() {
    clearInterval(this.timer);
    this.running = false;
    this.breath.sendLabel(false);
    this.breath.sendCalib('test-end');
    this.panel.dataset.kind = 'done';
    this.title.textContent = tr('Done', '完成');
    this.count.textContent = '';
    this.bar.style.width = '100%';
    const hit = this.holds.filter((h) => h.detectedAfter != null);
    const avg = hit.length ? hit.reduce((a, h) => a + h.detectedAfter!, 0) / hit.length : null;
    const falsePct = this.breatheTicks ? (this.falseHoldTicks / this.breatheTicks) * 100 : 0;
    this.sub.textContent = tr('Recording saved on the sensor (sensor/recordings/).', '数据已保存到传感器 (sensor/recordings/)。');
    this.result.classList.remove('hidden');
    this.result.innerHTML = `
      <div><b>${hit.length}/${this.holds.length}</b> ${tr('holds detected', '次憋气被识别')}${avg != null ? tr(`, after ${avg.toFixed(1)} s on average`, `，平均 ${avg.toFixed(1)} 秒后`) : ''}</div>
      <div><b>${falsePct.toFixed(0)}%</b> ${tr('of normal breathing was wrongly seen as holding', '的正常呼吸被误判为憋气')}</div>`;
  }
}
