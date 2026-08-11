/* 声音分两层，来源不同：
 *
 * ① 音效（抽卡 / 出牌 / 召唤 / 攻击 / 受击 / 进化 / 屏障 / 引爆 / 最后一击 / 胜负）
 *    —— 用 Web Audio 现场合成，不加载任何文件。
 *    理由：这类短音本来就是「一下」，合成完全够用；零体积（GitHub Pages 免费额度
 *    100GB/月，音频是最容易吃掉它的东西）；来源干净；想让攻击声更闷改个数字就行。
 *    代价说清楚：不如真人采样「厚」，但统一、不出错。
 *    以后要换采样：把 SOUNDS 里的分支换成 AudioBufferSourceNode，调用方一行都不用改。
 *
 * ② BGM 与随从语音 —— 必须用真实音频文件，见文件下半部分。
 *    合成的旋律做不了「崩铁的音乐」，合成也做不出人声。硬凑不如没有，
 *    所以做成「有文件就放，没有就完全静默」的可插拔机制。
 */

const LS_KEY = 'hsrccg.audio.v1';

/* 浏览器不允许在用户做出手势之前发声（自动播放策略）。
 * 所以 AudioContext 必须懒创建：在第一次点击时才建，否则会建出一个
 * 永久 suspended 的实例，之后怎么 resume 都不响。 */
let ctx = null, master = null, sfxGain = null, bgmGain = null, noiseBuf = null, verb = null;

const st = {
  muted: false,
  sfx: 0.7,
  bgm: 0.35,
};
try {
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  if (typeof saved.muted === 'boolean') st.muted = saved.muted;
  if (typeof saved.sfx === 'number') st.sfx = Math.min(1, Math.max(0, saved.sfx));
  if (typeof saved.bgm === 'number') st.bgm = Math.min(1, Math.max(0, saved.bgm));
} catch (e) { /* 隐私模式下 localStorage 会抛错，用默认值即可 */ }

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch (e) {}
}

/** 生成一段白噪声缓冲，供所有噪声类音效复用（每次现算太浪费） */
function makeNoise() {
  const n = Math.floor(ctx.sampleRate * 1.2);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/** 一段指数衰减的噪声当脉冲响应 —— 廉价但足够的混响，只给最后一击这类大音用 */
function makeVerb() {
  const dur = 1.4, n = Math.floor(ctx.sampleRate * dur);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6);
    }
  }
  const c = ctx.createConvolver();
  c.buffer = b;
  return c;
}

/** 第一次用户手势时调用。反复调用是安全的。 */
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;                       // 老浏览器：整个模块降级为静音
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = st.muted ? 0 : 1;
    master.connect(ctx.destination);
    sfxGain = ctx.createGain(); sfxGain.gain.value = st.sfx; sfxGain.connect(master);
    bgmGain = ctx.createGain(); bgmGain.gain.value = st.bgm; bgmGain.connect(master);
    noiseBuf = makeNoise();
    verb = makeVerb();
    const vg = ctx.createGain(); vg.gain.value = 0.5;
    verb.connect(vg); vg.connect(sfxGain);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return true;
}

export function isMuted() { return st.muted; }
export function volumes() { return { sfx: st.sfx, bgm: st.bgm }; }

export function setMuted(m) {
  st.muted = !!m; save();
  if (master) master.gain.value = st.muted ? 0 : 1;
}
export function setSfx(v) {
  st.sfx = Math.min(1, Math.max(0, v)); save();
  if (sfxGain) sfxGain.gain.value = st.sfx;
}
export function setBgm(v) {
  st.bgm = Math.min(1, Math.max(0, v)); save();
  if (bgmGain) bgmGain.gain.value = st.bgm;
}

/* ---------------- 合成积木 ---------------- */

/** 一个带包络的振荡器。f 可以是数字，也可以是 [起始, 结束] 表示滑音。 */
function tone(f, t0, dur, { type = 'sine', peak = 0.3, attack = 0.005, out = null,
                            detune = 0 } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.detune.value = detune;
  const [f0, f1] = Array.isArray(f) ? f : [f, f];
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  // 用指数衰减而不是线性：听起来才像「敲一下」而不是「淡出」
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(out || sfxGain);
  o.start(t0); o.stop(t0 + dur + 0.02);
  return { o, g };
}

/** 一段过滤后的噪声。用来做挥动、撞击、爆炸。 */
function noise(t0, dur, { lo = 200, hi = 6000, peak = 0.25, q = 0.7, out = null,
                          sweepTo = null, type = 'bandpass' } = {}) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.playbackRate.value = 1;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(type === 'lowpass' ? hi : (lo + hi) / 2, t0);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + Math.min(0.02, dur * 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  s.connect(f); f.connect(g); g.connect(out || sfxGain);
  s.start(t0, Math.random() * 0.3, dur + 0.05);
  return { s, g };
}

/* ---------------- 八命途的召唤动机 ----------------
 * 每个命途一个三音短句 + 一种音色。目的是「听声音就知道是哪一路的随从上场了」，
 * 而不是 24 套卡组共用同一个 duang。
 * 半音相对值，基频由下面的 base 给。 */
const PATH_MOTIF = {
  '毁灭':     { type: 'sawtooth', base: 110, notes: [0, -5, -12], dur: 0.16 },  // 下坠、粗糙
  '存护丰饶': { type: 'triangle', base: 196, notes: [0, 4, 7],    dur: 0.17 },  // 稳、大三和弦
  '巡猎':     { type: 'square',   base: 330, notes: [0, 7, 12],   dur: 0.10 },  // 快、锐利
  '智识':     { type: 'sine',     base: 262, notes: [0, 2, 5],    dur: 0.13 },  // 清、疑问感
  '同谐':     { type: 'triangle', base: 262, notes: [0, 5, 9],    dur: 0.19 },  // 舒展
  '虚无':     { type: 'sawtooth', base: 98,  notes: [0, -1, -6],  dur: 0.22 },  // 半音下行，不安
  '欢愉':     { type: 'square',   base: 392, notes: [0, 4, 2],    dur: 0.09 },  // 跳、俏
  '记忆':     { type: 'sine',     base: 220, notes: [0, 7, 14],   dur: 0.20 },  // 空、上行
};
const semi = (base, n) => base * Math.pow(2, n / 12);

/* ---------------- 音效表 ---------------- */

const SOUNDS = {
  click(t) { tone(1150, t, 0.035, { type: 'square', peak: 0.06 }); },

  /** 抽卡：一声轻轻的抽纸声（噪声带通向上扫） */
  draw(t) {
    noise(t, 0.20, { lo: 700, hi: 2600, sweepTo: 5200, peak: 0.13, q: 1.1 });
    tone([520, 900], t, 0.10, { type: 'sine', peak: 0.045 });
  },

  /** 打出手牌：落在桌上的一下 */
  play(t, o = {}) {
    const d = o.foe ? 0.86 : 1;                 // 对手的声音略低一点，方便分辨是谁在动
    tone([190 * d, 72 * d], t, 0.17, { type: 'sine', peak: 0.3 });
    noise(t, 0.07, { lo: 900, hi: 4200, peak: 0.14, q: 0.6 });
  },

  /** 召唤随从：按命途走不同的三音动机 */
  summon(t, o = {}) {
    const m = PATH_MOTIF[o.path] || PATH_MOTIF['智识'];
    const d = o.foe ? 0.84 : 1;
    // 先垫一下身体感，再上动机，否则纯旋律显得轻飘
    tone([150 * d, 80 * d], t, 0.14, { type: 'sine', peak: 0.16 });
    m.notes.forEach((n, i) => {
      tone(semi(m.base * d, n), t + i * m.dur * 0.66, m.dur * 1.5,
        { type: m.type, peak: i === 0 ? 0.16 : 0.12 });
    });
  },

  /** 攻击：短促的挥击 + 撞击 */
  attack(t, o = {}) {
    const d = o.foe ? 0.88 : 1;
    noise(t, 0.09, { lo: 1200, hi: 5000, sweepTo: 700, peak: 0.2, q: 0.8 });
    tone([320 * d, 110 * d], t + 0.03, 0.13, { type: 'triangle', peak: 0.22 });
  },

  /** 受击（主战者掉血） */
  hit(t, o = {}) {
    const big = Math.min(3, Math.max(1, o.dmg || 1));
    tone([130, 46], t, 0.10 + big * 0.03, { type: 'sine', peak: 0.16 + big * 0.05 });
    noise(t, 0.08, { type: 'lowpass', hi: 900, sweepTo: 200, peak: 0.12 });
  },

  /** 随从交换（互撞） */
  trade(t, o = {}) {
    SOUNDS.attack(t, o);
    noise(t + 0.05, 0.13, { lo: 300, hi: 1800, sweepTo: 400, peak: 0.15, q: 0.5 });
  },

  /** 进化：上行琶音 + 一点亮 */
  evolve(t) {
    [0, 4, 7, 12].forEach((n, i) =>
      tone(semi(330, n), t + i * 0.055, 0.30, { type: 'triangle', peak: 0.13 }));
    noise(t + 0.06, 0.34, { lo: 3000, hi: 9000, peak: 0.06, q: 0.4 });
  },

  /** 屏障吸收：金属般的一声 */
  barrier(t) {
    tone(880, t, 0.42, { type: 'sine', peak: 0.13 });
    tone(1320, t, 0.34, { type: 'sine', peak: 0.08 });
    noise(t, 0.10, { lo: 4000, hi: 9000, peak: 0.06 });
  },

  /** 引爆：闷响 + 下坠 */
  boom(t, o = {}) {
    const big = Math.min(4, Math.max(1, (o.dmg || 2) / 2));
    noise(t, 0.34, { type: 'lowpass', hi: 1600, sweepTo: 120, peak: 0.16 + big * 0.03,
                     out: verb });
    tone([180, 34], t, 0.40, { type: 'sawtooth', peak: 0.14 + big * 0.03 });
  },

  /** 回合开始：一声轻钟 */
  turn(t) {
    tone(660, t, 0.5, { type: 'sine', peak: 0.09 });
    tone(990, t + 0.01, 0.34, { type: 'sine', peak: 0.05 });
  },

  /** 最后一击：先吸气（上扫），再砸下去 */
  lethal(t) {
    noise(t, 0.34, { lo: 300, hi: 1000, sweepTo: 7000, peak: 0.12, q: 1.3 });   // 起势
    const b = t + 0.30;
    tone([120, 28], b, 0.95, { type: 'sine', peak: 0.42, out: verb });
    tone([90, 24], b, 0.80, { type: 'sawtooth', peak: 0.2 });
    noise(b, 0.75, { type: 'lowpass', hi: 3200, sweepTo: 90, peak: 0.3, out: verb });
    noise(b, 0.12, { lo: 2000, hi: 9000, peak: 0.2 });
  },

  win(t) {
    [0, 4, 7, 12].forEach((n, i) =>
      tone(semi(392, n), t + i * 0.11, 0.7, { type: 'triangle', peak: 0.16, out: verb }));
  },
  lose(t) {
    [0, -3, -8].forEach((n, i) =>
      tone(semi(294, n), t + i * 0.17, 0.9, { type: 'sine', peak: 0.15, out: verb }));
    noise(t, 0.9, { type: 'lowpass', hi: 700, sweepTo: 120, peak: 0.08 });
  },
};

/** 放一个音效。名字不存在时静默忽略（宁可没声音，也不要抛错打断对局）。
 *  opts.delay：延后几秒再响。连续召唤时卡面亮相是错开 620ms 的，声音要跟着错开，
 *  否则三个召唤音叠在同一瞬间会糊成一团噪音。 */
export function play(name, opts = {}) {
  if (!ctx || st.muted) return;
  const fn = SOUNDS[name];
  if (!fn) return;
  try {
    fn(ctx.currentTime + 0.001 + Math.max(0, opts.delay || 0), opts);
  } catch (e) { /* 音频不该让游戏崩 */ }
}

/* ================= BGM 与语音：用真实音频文件 =================
 *
 * 这两样都不合成。合成的旋律做不了「崩铁的音乐」，合成也做不出人声——
 * 硬凑出来的东西不如没有。所以走「有文件就放，没有就完全静默」的可插拔机制，
 * 和卡图一模一样的思路。
 *
 * ---- 怎么加 ----
 * 1) 建目录 game/audio/ ，把音频放进去（mp3 / ogg / m4a 都行）
 * 2) 建 game/audio/manifest.json：
 *
 *      {
 *        "bgm": ["bgm-battle.mp3", "bgm-menu.mp3"],
 *        "voice": { "H001": "voice-H001.mp3", "N022": "voice-N022.mp3" }
 *      }
 *
 *    bgm 是一个列表，每局开始随机挑一首循环播放。
 *    voice 的键是卡牌 id（卡表第一列），召唤那张随从时会放对应文件。
 *
 * 3) 没有 manifest.json 时：BGM 和语音整体关闭，只发出一次 404 请求，此后不再请求。
 *    音效（抽卡/出牌/攻击/最后一击）不受影响，那些是合成的，一直都在。
 *
 * ---- 为什么要 manifest ----
 * 不然每召唤一张没有语音的卡都要试一次 fetch，一局几十个 404，
 * 既慢又把访问日志刷满。有了清单就只请求真实存在的文件。
 */

let manifest = null;                  // null=没查过；false=没配置；对象=已加载
let bgmEl = null, bgmSrcNode = null, bgmOn = false;

async function loadManifest() {
  if (manifest !== null) return manifest;
  manifest = false;
  try {
    const url = new URL('../audio/manifest.json', import.meta.url).href;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return manifest;      // 没配音频是正常状态，不报错
    const j = await res.json();
    if (j && typeof j === 'object') manifest = j;
  } catch (e) { /* 同上 */ }
  return manifest;
}

/** 在开局时调一次。会去读 manifest，决定 BGM 和语音是否可用。 */
export async function initFiles() { await loadManifest(); }

export function hasBgm() {
  return !!(manifest && Array.isArray(manifest.bgm) && manifest.bgm.length);
}
export function hasVoice() {
  return !!(manifest && manifest.voice && Object.keys(manifest.voice).length);
}

const fileUrl = rel => new URL('../audio/' + rel, import.meta.url).href;

/** 开始放 BGM。没有配置文件就什么都不做。 */
export async function startBgm() {
  if (!ctx || bgmOn) return;
  await loadManifest();
  if (!hasBgm()) return;
  const list = manifest.bgm;
  const pick = list[Math.floor(Math.random() * list.length)];
  try {
    /* 用 <audio> 而不是 decodeAudioData：整首曲子解码成 AudioBuffer 会把几分钟的
     * PCM 全塞进内存（一首 3 分钟的立体声约 60MB），而 <audio> 是边下边播。
     * 再用 MediaElementSource 接进 Web Audio 图，这样音量和静音仍然走同一套控制。 */
    bgmEl = new Audio(fileUrl(pick));
    bgmEl.loop = true;
    bgmEl.preload = 'auto';
    bgmEl.crossOrigin = 'anonymous';
    bgmSrcNode = ctx.createMediaElementSource(bgmEl);
    bgmSrcNode.connect(bgmGain);
    bgmGain.gain.value = st.bgm;
    await bgmEl.play();
    bgmOn = true;
  } catch (e) {
    // 文件名写错、格式不支持、或自动播放仍被拦——静默降级，不影响对局
    bgmOn = false;
    if (bgmEl) { try { bgmEl.pause(); } catch (e2) {} }
    bgmEl = null; bgmSrcNode = null;
  }
}

export function stopBgm(fadeSec = 1.2) {
  if (!bgmOn || !bgmEl || !ctx) return;
  bgmOn = false;
  const g = bgmGain.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(g.value, ctx.currentTime);
  g.linearRampToValueAtTime(0.0001, ctx.currentTime + fadeSec);
  const el = bgmEl, node = bgmSrcNode;
  bgmEl = null; bgmSrcNode = null;
  setTimeout(() => {
    try { el.pause(); el.src = ''; node.disconnect(); } catch (e) {}
    if (!bgmOn && bgmGain) bgmGain.gain.value = st.bgm;   // 音量放回去，供下一局用
  }, (fadeSec + 0.2) * 1000);
}

/** 放某张卡的语音。manifest 里没有这张卡就什么都不做。 */
const voiceCache = new Map();
export async function playVoice(cardId) {
  if (!ctx || st.muted || !hasVoice()) return;
  const rel = manifest.voice[cardId];
  if (!rel) return;
  try {
    let buf = voiceCache.get(cardId);
    if (!buf) {
      const res = await fetch(fileUrl(rel));
      if (!res.ok) { delete manifest.voice[cardId]; return; }
      // 语音都是一两秒的短音，解码进内存没问题，而且要能和音效精确同时响
      buf = await ctx.decodeAudioData(await res.arrayBuffer());
      voiceCache.set(cardId, buf);
    }
    const s = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = 0.95;
    s.buffer = buf;
    s.connect(g); g.connect(sfxGain);
    s.start();
  } catch (e) { delete manifest.voice[cardId]; }
}
