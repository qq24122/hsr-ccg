/* 游戏状态与查询辅助
 *
 * 规则常量集中在 RULES，方便调平衡时单点修改。
 * 状态是普通对象（可 structuredClone 深拷贝），便于回放、撤销与自对弈。
 */

/* 规则常量 —— 全部取自《影之诗》初代（Shadowverse 1）。
 * 凡与《Shadowverse: Worlds Beyond》(2 代) 不同之处已在注释里标出，本作一律不采用 2 代版本：
 *   - 2 代双方各 2 进化点，后手补偿改为「额外能量点」(+1PP，可用 2 次)；本作用初代的先手2/后手3。
 *   - 2 代另有超进化(+3/+3、2 点)；本作不实现。
 *   - 2 代开局双方各抽 4 张 + 重抽；本作用初代的先手3/后手4。
 */
export const RULES = {
  SHOCK_DMG: 2,          // 【触电】每次结算的固定伤害
  MEDAL_ATK: 1,          // 【军功】+1/+1
  MEDAL_HP: 1,
  TITLE_ATK: 2,          // 【爵位】在军功之上额外 +2/+2 并获得必杀
  TITLE_HP: 2,
  PATRON_BONUS: 2,       // 己方随从攻击【老主顾】/【间隙织线】目标时攻击力 +2
  LEADER_HP: 20,
  DECK_SIZE: 40,
  MAX_COPIES: 3,
  HAND_LIMIT: 9,         // 超出上限抽到的卡不入手，直接进墓场
  BOARD_LIMIT: 5,        // 随从与护符共享
  PP_MAX: 10,
  EP_FIRST: 2,           // 先手进化点（初代规则）
  EP_SECOND: 3,          // 后手进化点（初代规则；2 代改为双方 2 点 + 额外能量点）
  EP_TURN_FIRST: 5,      // 先手从第 5 回合起可进化
  EP_TURN_SECOND: 4,     // 后手从第 4 回合起可进化
  EVOLVE_ATK: 2,
  EVOLVE_HP: 2,
  START_HAND_FIRST: 3,
  START_HAND_SECOND: 4,
  MARA_THRESHOLD: 10,    // 入魔（对应初代吸血鬼【复仇】）：自己主战者生命值 ≤ 此值
};

/** 可复现的伪随机（自对弈需要确定性） */
export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

let UID = 1;
export function nextUid() { return UID++; }
export function resetUid() { UID = 1; }

/** 从卡定义创建一个手牌实例 */
export function makeCardInstance(def) {
  return {
    uid: nextUid(),
    cardId: def.id,
    def,
    costMod: 0,          // 费用增减（costDown 等）
    atkMod: 0,           // 在手牌里就被强化的攻/血（银鬃射手那类）
    hpMod: 0,
    spellboost: 0,       // 巫师【法术增幅】：此卡在手牌中见过多少次己方法术
    counters: {},        // 法术也可暂存土之秘术/死灵术是否成功
  };
}

/** 从卡定义创建一个场上单位 */
export function makeUnit(def, turn) {
  const u = {
    uid: nextUid(),
    cardId: def.id,
    def,
    name: def.name,
    type: def.type,                 // 随从 / 护符
    atk: def.atk | 0,
    hp: def.hp | 0,
    maxHp: def.hp | 0,
    keywords: new Set(),
    counters: {},                   // 火种/朔望/兴致…
    spellboost: 0,                  // 从手牌带入的法术增幅次数
    marks: new Set(),               // 正面标记：军功 / 爵位 / 老主顾 / 织线（负面标记迁到 slot）
    slot: null,                     // 所在场地格子（slot 对象引用；负面状态存在这里）
    atkPlusExpr: null,              // 动态攻击力加成表达式（如 lostHp/2）
    reduceExpr: null,               // 动态伤害减免表达式（如 lostHp/4）
    attacksUsed: 0,
    maxAttacks: 1,
    extraAttacks: 0,
    evolved: false,
    summonedTurn: turn,
    transformedTurn: -99,           // 变身发生的回合；官方规定变身当回合不能攻击（疾驰也不例外）
    countdown: def.countdown ?? null,  // 护符倒数
    silenced: false,
  };
  return u;
}

/* 场地格子：负面状态（延迟爆发/非直接伤害）挂在格子上，而不是随从身上。
 * 随从站到哪一格，就受哪一格的负面效果影响；随从死亡时格子效果减半残留，
 * 新随从放进这个格子会吃到残留。这样「标记/弱点/脆弱/持续伤害」不再随目标死亡而蒸发。 */
export function makeSlot(idx) {
  return {
    idx,                            // 0-4
    marks: new Set(),               // 负面标记：标记 / 破绽
    vuln: 0,                        // 【弱点】层数，每层使站此格的随从受伤 +1
    flaws: new Set(),               // 【缺陷】迟缓 / 脆弱 / 衰弱
    dots: 0,                        // 【持续伤害】层数
    aura: 0,                        // 【奥迹】层数（放大 dots 每层结算值）
    shocked: false,                 // 【触电】站此格的随从回合结束受 2 点
  };
}

export function makePlayer(name, deckDefs, isFirst) {
  return {
    name,
    cls: '',                        // 由开局页写入；规则/UI 不再从显示字符串反推职业
    deckName: '',                   // 当前预设卡组名，供机制显示与测试核验
    hp: RULES.LEADER_HP,
    maxHp: RULES.LEADER_HP,
    keywords: new Set(),        // 主战者身上的关键词（目前只有【屏障】）
    /* 【侵蚀】= 主战者身上的【持续伤害】层数。随从离场时，它身上没结算完的层数
     * 会沉淀到它主人的主战者身上。随从来去太快，层数原本会跟着蒸发，
     * 虚无因此攒不起任何东西；沉淀到脸上之后「引爆」才是一条稳定的终结路线。 */
    dots: 0,
    aura: 0,                    // 主战者身上的【奥迹】（放大侵蚀每层的引爆值）
    vuln: 0,                    // 主战者身上的【易伤】：受到的伤害 +N（随从死亡时增伤效果概率转移而来）
    pp: 0,
    ppMax: 0,
    ppBonus: 0,                 // 花火之类的 PP 上限加成
    tempPP: 0,                  // 本回合临时 PP（ppUp 动作），回合开始时清零
    ep: isFirst ? RULES.EP_FIRST : RULES.EP_SECOND,
    isFirst,
    deck: deckDefs.slice(),
    hand: [],
    board: [],
    slots: Array.from({ length: RULES.BOARD_LIMIT }, (_, i) => makeSlot(i)),
    graveyard: [],
    shadows: 0,                   // 死灵术可消费墓场；单位/护符/法术入墓时增加
    counters: {},                 // 少量卡牌/职业计数器
    cardsPlayedThisTurn: 0,
    spellsPlayedThisTurn: 0,
    selfDamageThisTurn: 0,        // 本回合自己的主战者实际受到伤害的次数
    evolvedThisTurn: false,
    evolves: 0,                   // 本局己方随从进化次数
    wasResonance: deckDefs.length % 2 === 0, // 复仇者【共鸣】前一状态，用于进出共鸣触发
    deckOut: false,               // 牌库耗尽（判负）
  };
}

export function createGame(deck0, deck1, seed = 1) {
  resetUid();
  const rng = makeRng(seed);
  const s = {
    turn: 0,
    active: 0,
    players: [makePlayer('P0', deck0, true), makePlayer('P1', deck1, false)],
    log: [],
    winner: null,
    rng,
    seed,
    pendingChoices: [],   // 需要玩家选择目标的动作（阶段0由 AI/测试直接给定）
    __aiTrace: null,       // 诊断页按需启用；默认不记录，避免污染真实对局
    __cardTrace: null,     // 卡牌实例生命周期；只在平衡诊断启用
  };
  shuffle(s.players[0].deck, rng);
  shuffle(s.players[1].deck, rng);
  for (let i = 0; i < RULES.START_HAND_FIRST; i++) drawCard(s, 0);
  for (let i = 0; i < RULES.START_HAND_SECOND; i++) drawCard(s, 1);
  return s;
}

export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function log(s, msg) { s.log.push(`T${s.turn} P${s.active} ${msg}`); }

export function traceCard(s, event) {
  if (!s.__cardTrace || s.__sim) return;
  s.__cardTrace.push({ turn: s.turn, ...event });
}

export function drawDef(s, pi, def) {
  const p = s.players[pi];
  if (p.hand.length >= RULES.HAND_LIMIT) {
    // 官方：「超过手牌上限时，超出的卡牌不会加入手牌，而是增加墓场数量。」
    addToGrave(p, def);
    traceCard(s, { kind: 'draw', player: pi, cardId: def.id, name: def.name, zone: 'burned' });
    log(s, `手牌已满（${RULES.HAND_LIMIT}），${def.name} 进入墓场`);
    return null;
  }
  const inst = makeCardInstance(def);
  p.hand.push(inst);
  traceCard(s, { kind: 'draw', player: pi, uid: inst.uid, cardId: def.id, name: def.name, zone: 'hand' });
  return inst;
}

export function drawCard(s, pi) {
  const p = s.players[pi];
  if (!p.deck.length) {
    // 官方：「牌组剩余0张时继续抽牌的话，对战失败。」
    // 是直接判负，不是炉石的疲劳伤害。
    p.deckOut = true;
    if (s.winner == null) s.winner = opp(pi);
    log(s, `${p.name} 牌库耗尽，判负`);
    return null;
  }
  return drawDef(s, pi, p.deck.shift());
}

/* ---------------- 供 AI 试算用的深拷贝 ----------------
 * AI 要「先模拟再决定」，就必须能复制局面。注意 state 里有 Set 与闭包 rng，
 * structuredClone 会在 rng 上直接失败，所以只能手写。
 * def 是不可变的卡定义，共享引用即可；log 不复制（试算不需要，且很占内存）。 */
function cloneUnit(u) {
  return { ...u, keywords: new Set(u.keywords), marks: new Set(u.marks), counters: { ...u.counters } };
}
function clonePlayer(p) {
  const slots = p.slots.map(sl => ({ ...sl, marks: new Set(sl.marks), flaws: new Set(sl.flaws) }));
  const board = p.board.map(u => {
    const nu = cloneUnit(u);
    if (nu.slot) nu.slot = slots[nu.slot.idx];   // 重新绑定到副本的格子
    return nu;
  });
  return { ...p, keywords: new Set(p.keywords), counters: { ...p.counters },
    deck: p.deck.slice(), graveyard: p.graveyard.slice(),
    hand: p.hand.map(h => ({ ...h, counters: { ...(h.counters || {}) } })), board, slots };
}
export function cloneForSim(s) {
  return {
    turn: s.turn, active: s.active, winner: s.winner,
    seed: s.seed, log: [], pendingChoices: [],
    // 试算用的随机源不需要与真局同源，只要能跑通带随机的卡效
    rng: makeRng(0x5eed),
    __cardIndex: s.__cardIndex, __tokenIndex: s.__tokenIndex, __cls: s.__cls,
    __sim: true, __aiTrace: null, __cardTrace: null,
    players: s.players.map(clonePlayer),
  };
}

export const opp = pi => 1 - pi;
export const self = s => s.players[s.active];
export const foe = s => s.players[opp(s.active)];

export function boardFull(p) { return p.board.length >= RULES.BOARD_LIMIT; }

export function isMara(p) { return p.hp <= RULES.MARA_THRESHOLD; }

/** 复仇者【共鸣】：自己的牌库剩余张数为偶数时成立。抽牌与塞牌都会立刻切换。 */
export function isResonance(p) { return p.deck.length % 2 === 0; }

/** 统一记录进入墓场；死灵术消费的是 shadows，墓场仍保留对局历史。 */
export function addToGrave(p, def) {
  p.graveyard.push(def);
  p.shadows += 1;
}

export function ctrOf(p, name) { return p.counters[name] || 0; }
export function addCtr(p, name, n) {
  p.counters[name] = (p.counters[name] || 0) + n;
  if (p.counters[name] < 0) p.counters[name] = 0;
  return p.counters[name];
}

export function unitCtr(u, name) { return (u.counters && u.counters[name]) || 0; }
export function addUnitCtr(u, name, n) {
  u.counters ||= {};
  u.counters[name] = (u.counters[name] || 0) + n;
  if (u.counters[name] < 0) u.counters[name] = 0;
  return u.counters[name];
}

/** 敌方必须优先攻击的单位。官方【守护】：只要拥有守护的随从在场，就无法攻击其他随从或主战者。 */
export function tauntTargets(p) {
  return p.board.filter(u => u.type === '随从' && u.keywords.has('ward') && !u.silenced);
}

/** 卡牌标签（tag 列，多个用 / 分隔）：盾卫、蛰虫、忆质、涂鸦、虚卒… */
export function hasTag(u, tag) {
  const t = u.def && u.def.tag;
  if (!t) return false;
  return t.split('/').some(x => x.trim() === tag);
}

export function minionsOf(p) { return p.board.filter(u => u.type === '随从'); }
export function amuletsOf(p) { return p.board.filter(u => u.type === '护符'); }

export function findUnit(s, uid) {
  for (const p of s.players) {
    const u = p.board.find(x => x.uid === uid);
    if (u) return u;
  }
  return null;
}

export function ownerOf(s, uid) {
  for (let i = 0; i < 2; i++) if (s.players[i].board.some(u => u.uid === uid)) return i;
  return -1;
}
