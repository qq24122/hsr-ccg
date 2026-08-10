/* 卡表加载：TSV → 卡定义
 *
 * 表格是唯一数据源，改 data/cards.tsv 后刷新页面即生效，无需改代码。
 * 列：id name class type quality cost atk hp countdown token tag effect note
 *   tag 是卡牌标签（多个用 / 分隔），供 allyTag(蛰虫) 这类目标与 tagCount(盾卫) 这类指标使用
 * 其中 effect 一列承载全部卡效（DSL，见 dsl.js）；note 是给人看的中文描述，引擎不读。
 */

import { parseEffect } from './dsl.js';
import { RULES, shuffle } from './state.js';

const NUM_COLS = ['cost', 'atk', 'hp', 'countdown', 'token'];

export function parseTSV(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim().length && !l.startsWith('#'));
  if (!lines.length) throw new Error('卡表为空');
  const head = lines[0].split('\t').map(s => s.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const o = {};
    head.forEach((h, j) => { o[h] = (cells[j] ?? '').trim(); });
    for (const k of NUM_COLS) {
      o[k] = o[k] === '' || o[k] == null ? null : Number(o[k]);
    }
    o.isToken = o.token === 1;
    o.countdown = o.countdown ?? null;
    rows.push(o);
  }
  return { head, rows };
}

/* 8 个职业各一个文件，对应设计 Excel 的 8 个页签。
 * 文件名用官方英文命途名（避免中文文件名在 URL 里的编码问题），class 列仍是中文。 */
export const CLASS_FILES = [
  ['毁灭',     'cards-destruction.tsv'],
  ['存护丰饶', 'cards-preservation.tsv'],
  ['巡猎',     'cards-hunt.tsv'],
  ['智识',     'cards-erudition.tsv'],
  ['同谐',     'cards-harmony.tsv'],
  ['虚无',     'cards-nihility.tsv'],
  ['欢愉',     'cards-elation.tsv'],
  ['记忆',     'cards-remembrance.tsv'],
];

/* 卡表目录锚定在本模块自身的位置上，而不是相对调用页面。
 *
 * fetch('../data/x.tsv') 是相对「文档 URL」解析的，不是相对模块 URL。
 * 之前这么写只在「页面正好位于站点根目录」时侥幸能用——play.html 在 /play.html，
 * 浏览器把 /../data/ 夹回了 /data/。一旦站点挂在子路径下（GitHub Pages 的
 * /仓库名/play.html），它会去找 /data/ 而不是 /仓库名/data/，整站白屏。
 * 用 import.meta.url 锚定后，无论调用页在哪一层、站点挂在哪个子路径都正确。 */
const DATA_DIR = new URL('../data/', import.meta.url).href;

/**
 * 加载并校验卡表。任何一张卡的 DSL 写错都会在这里抛错并指名卡名，
 * 而不是在对局中静默变成一张无效果的牌。
 * 传单个文件名只读一个文件；传 'ALL' 则读全部 8 个职业文件并合并。
 */
export async function loadCards(url = 'cards.tsv') {
  if (url === 'ALL') return loadAllClasses();
  const abs = new URL(url.replace(/^\.\.\/data\//, ''), DATA_DIR).href;
  const res = await fetch(abs, { cache: 'no-store' });
  if (!res.ok) throw new Error(`加载卡表失败 ${res.status} ${abs}`);
  return buildIndex(parseTSV(await res.text()).rows, url);
}

/** 读全部 8 个职业文件；缺文件会明确报出是哪个职业，不会静默少卡 */
export async function loadAllClasses(dir = DATA_DIR) {
  const rows = [], missing = [];
  for (const [cls, file] of CLASS_FILES) {
    const res = await fetch(new URL(file, dir).href, { cache: 'no-store' });
    if (!res.ok) { missing.push(`${cls}(${file}) → ${res.status}`); continue; }
    const got = parseTSV(await res.text()).rows;
    for (const r of got) r.__file = file;
    rows.push(...got);
  }
  if (missing.length) throw new Error('以下职业卡表缺失：\n  ' + missing.join('\n  '));
  return buildIndex(rows, 'ALL');
}

function buildIndex(rows, srcLabel) {
  const errors = [];
  for (const r of rows) {
    if (!r.id || !r.name) { errors.push(`缺少 id 或 name: ${JSON.stringify(r)}`); continue; }
    if (!['随从', '法术', '护符'].includes(r.type)) errors.push(`[${r.name}] 类型非法: ${r.type}`);
    if (r.type === '随从' && (r.atk == null || r.hp == null)) errors.push(`[${r.name}] 随从缺少攻/血`);
    try { r.clauses = parseEffect(r.effect, r.name); }
    catch (e) { errors.push(e.message); }
  }
  // 重名会让 byName 索引互相覆盖，进而让 summon/transform 找错卡，必须当成错误
  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.name)) errors.push(`[${r.name}] 卡名重复：${seen.get(r.name)} 与 ${r.__file || srcLabel}`);
    else seen.set(r.name, r.__file || srcLabel);
  }
  if (errors.length) throw new Error(`卡表校验失败（${srcLabel}，共 ${errors.length} 项）：\n  ` + errors.join('\n  '));

  const byId = {}, byName = {};
  for (const r of rows) { byId[r.id] = r; byName[r.name] = r; }
  return { all: rows, byId, byName, tokens: rows.filter(r => r.isToken) };
}

/** 列出每个职业有哪些卡组：{ 毁灭: ['地狱变', ...], ... } */
export function listDecks(cards) {
  const out = {};
  for (const c of cards.all) {
    if (!c.decks) continue;
    for (const d of String(c.decks).split('/')) {
      const name = d.trim();
      if (!name) continue;
      (out[c.class] ||= []);
      if (!out[c.class].includes(name)) out[c.class].push(name);
    }
  }
  return out;
}

/** 某套卡组可用的卡（不含衍生卡） */
export function deckPool(cards, cls, deckName) {
  return cards.all.filter(c => !c.isToken && c.class === cls
    && String(c.decks || '').split('/').some(d => d.trim() === deckName));
}

/* 40 张牌的费用配额。取自我对 2065 副真实影之诗卡组的统计：
 * 峰值在 2 费（约三分之一），越贵越少，且必须留出终结牌的位置。
 * 直接「从最便宜的开始塞满 40 张」会得到一副没有大牌的废组——
 * 这正是之前测试用的组牌方式，所以那批胜率数字不能信。 */
const COST_QUOTA = { 1: 6, 2: 10, 3: 8, 4: 6, 5: 4, 6: 3, 7: 2, 8: 1 };
const MAX_COPIES = 3;

/**
 * 按卡组名构建一副 40 张的牌。
 * 每个费用档按配额从该档的卡里取，同名最多 3 张；某档缺卡就把名额让给相邻档。
 */
export function buildDeckFor(cards, cls, deckName, rng = Math.random) {
  const pool = deckPool(cards, cls, deckName);
  if (!pool.length) throw new Error(`卡组「${cls}｜${deckName}」没有任何卡`);

  const band = c => Math.min(8, Math.max(1, c.cost || 1));
  const byBand = {};
  for (const c of pool) (byBand[band(c)] ||= []).push(c);
  for (const k of Object.keys(byBand)) shuffle(byBand[k], rng);

  const copies = new Map();          // card → 份数
  const total = () => [...copies.values()].reduce((a, b) => a + b, 0);

  const take = (list, quota) => {
    let got = 0;
    // 轮转发牌，让同一档里的卡都能上，而不是前几张吃满 3 份
    for (let round = 0; round < MAX_COPIES && got < quota; round++) {
      for (const c of list) {
        if (got >= quota) break;
        if ((copies.get(c) || 0) >= MAX_COPIES) continue;
        copies.set(c, (copies.get(c) || 0) + 1);
        got++;
      }
    }
    return got;
  };

  let spill = 0;
  for (const b of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const quota = (COST_QUOTA[b] || 0) + spill;
    const got = take(byBand[b] || [], quota);
    spill = quota - got;             // 这一档没卡，名额顺延给更贵的档
  }
  // 还差的话，从便宜到贵补份数（此时高费档已经吃饱，剩下的名额只能给低费）
  if (total() < RULES.DECK_SIZE) {
    const asc = pool.slice().sort((a, b) => (a.cost || 0) - (b.cost || 0));
    for (let round = 0; round < MAX_COPIES && total() < RULES.DECK_SIZE; round++) {
      for (const c of asc) {
        if (total() >= RULES.DECK_SIZE) break;
        if ((copies.get(c) || 0) >= MAX_COPIES) continue;
        copies.set(c, (copies.get(c) || 0) + 1);
      }
    }
  }

  const deck = [];
  for (const [c, n] of copies) for (let i = 0; i < n; i++) deck.push(c);
  // 配额之和正好 40，理论上不会超；真超了就从最贵的开始砍
  while (deck.length > RULES.DECK_SIZE) {
    let worst = 0;
    for (let i = 1; i < deck.length; i++) if ((deck[i].cost || 0) > (deck[worst].cost || 0)) worst = i;
    deck.splice(worst, 1);
  }
  return deck;
}

/** 按 40 张、同名最多 3 张组一副牌；不足则循环填充（阶段0便于测试） */
export function buildDeck(pool, size = 40, maxCopies = 3) {
  const playable = pool.filter(c => !c.isToken);
  const deck = [];
  let i = 0;
  while (deck.length < size) {
    const c = playable[i % playable.length];
    const have = deck.filter(x => x.id === c.id).length;
    if (have < maxCopies) deck.push(c);
    i++;
    if (i > size * playable.length) break;   // 兜底，避免卡池过小时死循环
  }
  return deck;
}
