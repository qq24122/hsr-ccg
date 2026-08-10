/* 对局战绩记录与上报。
 *
 * 设计前提：
 *   1) 上报失败绝不能影响对局。所有对外调用都包在 try/catch 里，出错只写控制台。
 *   2) 先写本地、再尝试上传，上传成功才从本地队列里删。这样离线、超额度、
 *      接收端还没搭好的情况下都不丢数据，下次打开会自动补传。
 *   3) 玩家能关掉，也能看到自己被记了什么。收别人的数据不说清楚是不行的。
 *
 * 采集字段只有对局信息，没有任何个人信息：
 *   双方职业与卡组 / 先后手 / 胜负 / 回合数 / 双方终局血量 / 对局时长 / 重抽张数
 *   外加一个本地随机生成的匿名 id（用来把同一个人的多局归到一起、以及去重）。
 *
 * 注意：整个游戏在浏览器里跑，所以上报内容是可以伪造的。
 * 这批数据适合当平衡参考，不适合当权威结论。
 */

import { BUILD } from './version.js';

/* 接收端地址。空字符串 = 只存本地、不上传。
 * 部署好 Cloudflare Worker 后把它填成 https://xxx.workers.dev/report 即可。 */
export const ENDPOINT = '';

const K_QUEUE = 'hsr.stats.queue';    // 待上传队列
const K_DONE  = 'hsr.stats.done';     // 已上传的本地留档（给玩家看自己的战绩）
const K_SID   = 'hsr.stats.sid';
const K_OFF   = 'hsr.stats.off';
const MAX_KEEP = 400;                 // 本地最多留这么多局，避免 localStorage 撑爆

const PAYLOAD_VERSION = 1;

/* ---------------- 基础存取 ---------------- */
function read(key, dflt) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; }
  catch (e) { return dflt; }
}
function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { return false; }   // 隐私模式 / 配额满
}

/** 匿名会话 id：本地随机生成，和任何账号无关，清浏览器数据就没了 */
export function sessionId() {
  let id = read(K_SID, null);
  if (!id) {
    const b = new Uint8Array(8);
    (self.crypto || {}).getRandomValues ? self.crypto.getRandomValues(b)
      : b.forEach((_, i) => b[i] = Math.floor(Math.random() * 256));
    id = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    write(K_SID, id);
  }
  return id;
}

export function isOptedOut() { return read(K_OFF, false) === true; }
export function setOptOut(off) {
  write(K_OFF, !!off);
  if (off) write(K_QUEUE, []);        // 关掉时把还没传的也清掉，别偷偷留着
}

/* ---------------- 记录一局 ---------------- */

/**
 * @param {object} m 对局结果
 *   { meCls, meDeck, foeCls, foeDeck, first:boolean, win:boolean,
 *     turns, meHp, foeHp, durMs, mull, mode }
 */
export function recordMatch(m) {
  try {
    const row = {
      v: PAYLOAD_VERSION,
      build: BUILD.id,
      sid: sessionId(),
      ts: Date.now(),
      mode: m.mode || 'ai',
      meCls: m.meCls, meDeck: m.meDeck,
      foeCls: m.foeCls, foeDeck: m.foeDeck,
      first: m.first ? 1 : 0,
      result: m.win ? 'win' : 'lose',
      turns: m.turns | 0,
      meHp: m.meHp | 0, foeHp: m.foeHp | 0,
      durMs: m.durMs | 0,
      mull: m.mull | 0,
    };
    // 本地留档永远记（玩家自己的战绩页要用），不受关闭开关影响
    const done = read(K_DONE, []);
    done.push(row);
    write(K_DONE, done.slice(-MAX_KEEP));

    /* 即使接收端还没配好也照样入队：等接收端上线后，这些先打的局会被自动补传，
     * 不然「上线第一天的对局」全都白丢了。关闭上传的人不入队。 */
    if (isOptedOut()) return;
    const q = read(K_QUEUE, []);
    q.push(row);
    write(K_QUEUE, q.slice(-MAX_KEEP));
    flush();                          // 不 await：上传快慢不该拖住界面
  } catch (e) {
    console.warn('战绩记录失败（不影响对局）', e);
  }
}

/** 把队列里的战绩发出去。成功才出队；失败保留，下次再试。 */
export async function flush() {
  if (isOptedOut() || !ENDPOINT) return { sent: 0, left: 0 };
  let q = read(K_QUEUE, []);
  if (!q.length) return { sent: 0, left: 0 };
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: q }),
      keepalive: true,               // 玩家关页面时也尽量发出去
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    write(K_QUEUE, []);
    return { sent: q.length, left: 0 };
  } catch (e) {
    console.warn('战绩上传失败，留到下次再传', e.message);
    return { sent: 0, left: q.length };
  }
}

/* ---------------- 给玩家看的本地战绩 ---------------- */

export function allMatches() { return read(K_DONE, []); }

/** 按「我的卡组」汇总自己的胜负 */
export function summary() {
  const rows = allMatches();
  const by = new Map();
  for (const r of rows) {
    const k = `${r.meCls}｜${r.meDeck}`;
    const o = by.get(k) || { deck: k, w: 0, l: 0 };
    r.result === 'win' ? o.w++ : o.l++;
    by.set(k, o);
  }
  const list = [...by.values()].sort((a, b) => (b.w + b.l) - (a.w + a.l));
  const w = rows.filter(r => r.result === 'win').length;
  return { total: rows.length, w, l: rows.length - w, byDeck: list,
    queued: read(K_QUEUE, []).length };
}

export function exportJSON() {
  return JSON.stringify({ build: BUILD, sid: sessionId(), matches: allMatches() }, null, 1);
}

export function clearLocal() {
  write(K_DONE, []); write(K_QUEUE, []);
}

/* 打开页面时先把上次没传成功的补传掉 */
if (typeof window !== 'undefined') {
  setTimeout(() => { flush().catch(() => {}); }, 1500);
}
