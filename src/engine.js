/* 规则引擎：回合流转、出牌、攻击、进化、效果结算
 *
 * 设计约定
 *  - 所有改变状态的入口都是纯函数式调用 fn(state, ...) → 直接改 state 并返回结果对象。
 *    自对弈时对 state 做 structuredClone 即可回溯。
 *  - 效果由 dsl.js 解析出的 clause 驱动，引擎只实现有限的原子动作。
 *  - 需要玩家选目标的动作（allyOne/enemyOne）由调用方通过 opts.choose 提供，
 *    没提供时退化为「自动选一个合法目标」，保证 AI 与测试都能跑通。
 */

import { parseEffect, evalCond } from './dsl.js';
import * as S from './state.js';

const { RULES } = S;

/* ---------------- 触发与效果 ---------------- */

function clausesOf(u) {
  if (!u.__clauses) u.__clauses = parseEffect(u.def.effect, u.def.name);
  return u.silenced ? [] : u.__clauses;
}

/** 构造条件求值上下文 */
function condCtx(s, ownerIdx, source, chosen) {
  const p = s.players[ownerIdx];
  const mc = { ownerIdx, source };
  return {
    mara: S.isMara(p),
    resonance: S.isResonance(p),
    marked: chosen && chosen.slot ? chosen.slot.marks.has('标记') : false,
    evolved: source ? source.evolved : false,
    ctr: name => (source && source.counters && source.counters[name] != null)
      ? source.counters[name]
      : S.ctrOf(p, name),
    // 其余条件量统一走 metricOf，与动作参数里的动态数值共用一套词汇
    metric: name => metricOf(s, name, mc),
  };
}

/** 触发一个时机。ctx: { ownerIdx, source, chosen, extra } */
export function fireTrigger(s, trigger, ctx = {}) {
  const scan = [];
  for (let pi = 0; pi < 2; pi++) {
    for (const u of s.players[pi].board.slice()) scan.push([pi, u]);
  }
  for (const [pi, u] of scan) {
    if (!u.def) continue;
    if (ctx.ownerOnly != null && pi !== ctx.ownerOnly) continue;
    // 自身触发类时机只对来源单位生效
    if ((trigger === 'onPlay' || trigger === 'onReplace' || trigger === 'onRetreat'
      || trigger === 'onDeath' || trigger === 'onAttack'
      || trigger === 'onEvolve' || trigger === 'onDamaged') && ctx.source !== u) continue;
    for (const c of clausesOf(u)) {
      if (c.trigger !== trigger) continue;
      if (trigger === 'onCtr') {
        const [nm, thr] = [c.args[0], parseInt(c.args[1], 10)];
        if (S.unitCtr(u, nm) < thr) continue;
      }
      if (!evalCond(c.cond, condCtx(s, pi, u, ctx.chosen))) continue;
      runActions(s, c.actions, { ownerIdx: pi, source: u, chosen: ctx.chosen, attacker: ctx.attacker });
    }
  }
}

/** 解析目标 spec → 单位数组 或 'leader' 标记 */
function resolveTarget(s, spec, ctx) {
  const me = ctx.ownerIdx, you = S.opp(ctx.ownerIdx);
  const P = s.players[me], E = s.players[you];
  // 带参数的标签目标：allyTag(蛰虫) / enemyTag(虚卒)
  const tm = /^(allyTag|enemyTag)\(([^)]+)\)$/.exec(spec);
  if (tm) {
    const side = tm[1] === 'allyTag' ? P : E;
    return S.minionsOf(side).filter(u => S.hasTag(u, tm[2]));
  }
  // enemyFlaw(2)：拥有 2 个以上【缺陷】的敌方随从
  const fm = /^enemyFlaw\((\d+)\)$/.exec(spec);
  if (fm) return S.minionsOf(E).filter(u => u.slot.flaws.size >= parseInt(fm[1], 10));
  switch (spec) {
    case 'self':        return ctx.source ? [ctx.source] : [];
    case 'selfLeader':  return [{ __leader: me }];
    case 'enemyLeader': return [{ __leader: you }];
    case 'bothLeader':  return [{ __leader: me }, { __leader: you }];
    case 'allyAll':     return S.minionsOf(P).slice();
    case 'enemyAll':    return S.minionsOf(E).slice();
    case 'allyOther':   return S.minionsOf(P).filter(u => u !== ctx.source);
    case 'allyOne':     return pickOne(ctx.chosenAlly || S.minionsOf(P).find(u => u !== ctx.source) || S.minionsOf(P)[0]);
    case 'enemyOne':    return pickOne(ctx.chosen || S.minionsOf(E)[0]);
    // 随机 1 个敌方随从；对方空场时没有目标（不会溢出去打主战者）
    case 'enemyRandom': {
      const arr = S.minionsOf(E);
      return arr.length ? [arr[Math.floor(s.rng() * arr.length)]] : [];
    }
    // 随机 1 个敌方目标：随从与主战者同在一个池子里
    case 'enemyRandomAny': {
      const pool = [...S.minionsOf(E), { __leader: you }];
      return [pool[Math.floor(s.rng() * pool.length)]];
    }
    case 'enemyMarked':  return S.minionsOf(E).filter(u => u.slot.marks.has('标记'));
    case 'enemyBroken':  return S.minionsOf(E).filter(u => u.slot.marks.has('破绽'));
    case 'enemyShocked': return S.minionsOf(E).filter(u => u.slot.shocked);
    case 'enemyDotted':  return S.minionsOf(E).filter(u => u.slot.dots > 0);
    /* 「敌方全体的【持续伤害】」——随从（场地）加上带【侵蚀】的主战者。
     * 引爆类卡牌用这个目标，才能把场地上和脸上的层数一起炸掉。 */
    case 'enemyDottedAny': {
      const arr = S.minionsOf(E).filter(u => u.slot.dots > 0);
      if (E.dots > 0) arr.push({ __leader: you });
      return arr;
    }
    case 'enemyFlawed':  return S.minionsOf(E).filter(u => u.slot.flaws.size > 0);
    case 'enemyPatron':  return S.minionsOf(E).filter(u => u.marks.has('老主顾'));
    case 'enemyHighestHp': {
      const arr = S.minionsOf(E);
      return arr.length ? [arr.reduce((b, u) => (u.hp > b.hp ? u : b))] : [];
    }
    case 'enemyLowestHp': {
      const arr = S.minionsOf(E);
      return arr.length ? [arr.reduce((b, u) => (u.hp < b.hp ? u : b))] : [];
    }
    // 【军功】相关：allyMedal 取 1 个还没升爵位的，allyAllMedal 取全体带军功的
    case 'allyMedal': {
      const arr = S.minionsOf(P).filter(u => u.marks.has('军功') && !u.marks.has('爵位'));
      return arr.length ? [arr[0]] : [];
    }
    case 'allyAllMedal': return S.minionsOf(P).filter(u => u.marks.has('军功'));
    case 'allyRandom': {
      const arr = S.minionsOf(P);
      return arr.length ? [arr[Math.floor(s.rng() * arr.length)]] : [];
    }
    case 'allyToken':   return P.board.filter(u => u.def && u.def.isToken);
    case 'allyAmulet':  return S.amuletsOf(P).slice();
    case 'allyCountdown': return S.amuletsOf(P).filter(u => u.countdown != null);
    case 'enemyAmulet': return E.board.filter(u => u.type === '护符');
    // 「敌方主战者或1个敌方随从」：玩家指定了就打那个，没指定就打脸（所以永远有合法目标）
    case 'enemyAny':    return [ctx.chosen || { __leader: you }];
    // 造成本次伤害的那个单位（配合 onDamaged 使用）
    case 'dmgSource':   return ctx.attacker ? [ctx.attacker] : [];
    case 'dmgSourceOrLeader': return ctx.attacker ? [ctx.attacker] : [{ __leader: you }];
    default: return [];
  }
  function pickOne(u) { return u ? [u] : []; }
}

export function runActions(s, actions, ctx) {
  for (const a of actions) runAction(s, a, ctx);
}

function runAction(s, a, ctx) {
  const me = ctx.ownerIdx, you = S.opp(ctx.ownerIdx);
  const P = s.players[me];
  const A = a.args;
  switch (a.op) {
    case 'dmg': {
      let n = num(s, A[1], ctx);
      // 可选第三参 = 上限，对应卡面的「最多15点」
      if (A[2] != null) n = Math.min(n, num(s, A[2], ctx));
      for (const t of resolveTarget(s, A[0], ctx)) dealDamage(s, t, n, ctx.source);
      break;
    }
    case 'maxHpDown': {   // 使自己主战者生命上限 -N（毁灭的自我献祭）
      const n = num(s, A[0], ctx);
      P.maxHp = Math.max(1, P.maxHp - n);
      if (P.hp > P.maxHp) { const d = P.hp - P.maxHp; P.hp = P.maxHp; afterLeaderDamage(s, me, d); }
      break;
    }
    case 'maxHpUp': P.maxHp += num(s, A[0], ctx); break;
    case 'halveHp': {     // 将自己主战者的生命值减半（向上取整）
      const now = Math.ceil(P.hp / 2), d = P.hp - now;
      if (d > 0) { P.hp = now; afterLeaderDamage(s, me, d); }
      break;
    }
    case 'addHand': {     // 生成卡牌加入手牌；超上限则进墓场（官方规则）
      const name = A[0], n = A[1] ? num(s, A[1], ctx) : 1;
      const def = s.__cardIndex && s.__cardIndex[name];
      if (!def) { S.log(s, `找不到卡定义 ${name}`); break; }
      for (let i = 0; i < n; i++) {
        if (P.hand.length >= RULES.HAND_LIMIT) { S.addToGrave(P, def); continue; }
        P.hand.push(S.makeCardInstance(def));
      }
      break;
    }
    case 'copy': {        // 官方【复制】：继承伤害与附加效果，不继承本回合是否攻击过
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        if (S.boardFull(P)) { S.log(s, `场地已满，${t.name} 复制失败`); break; }
        const c = S.makeUnit(t.def, s.turn);
        c.atk = t.atk; c.hp = t.hp; c.maxHp = t.maxHp; c.evolved = t.evolved;
        c.keywords = new Set(t.keywords); c.marks = new Set(t.marks);   // 只继承正面标记，负面状态属于格子不继承
        c.counters = { ...t.counters };
        c.atkPlusExpr = t.atkPlusExpr; c.reduceExpr = t.reduceExpr;
        placeUnit(P, c);
        S.log(s, `复制出 ${c.name}`);
      }
      break;
    }
    case 'heal': {
      const n = num(s, A[1], ctx);
      for (const t of resolveTarget(s, A[0], ctx)) healTarget(s, t, n);
      break;
    }
    case 'draw': {  // 第二参 = 上限，对应卡面的「最多4张」
      let n = num(s, A[0], ctx);
      if (A[1] != null) n = Math.min(n, num(s, A[1], ctx));
      for (let i = 0; i < n; i++) {
        S.drawCard(s, me);
        updateResonance(s, me);
      }
      break;
    }
    case 'drawKind': {  // 从牌库里抽指定类型的卡（法术/随从/护符），抽不到就跳过
      const kind = A[0], n = A[1] ? num(s, A[1], ctx) : 1;
      for (let i = 0; i < n; i++) {
        const at = P.deck.findIndex(d => d.type === kind);
        if (at < 0) break;
        const [def] = P.deck.splice(at, 1);
        S.drawDef(s, me, def);
        updateResonance(s, me);
      }
      break;
    }
    case 'drawTag': {
      const tag = A[0], n = A[1] ? num(s, A[1], ctx) : 1;
      for (let i = 0; i < n; i++) {
        const at = P.deck.findIndex(d => String(d.tag || '').split('/').includes(tag));
        if (at < 0) break;
        const [def] = P.deck.splice(at, 1);
        S.drawDef(s, me, def);
        updateResonance(s, me);
      }
      break;
    }
    case 'drawToken': {
      const n = A[0] ? num(s, A[0], ctx) : 1;
      for (let i = 0; i < n; i++) {
        const at = P.deck.findIndex(d => d.isToken);
        if (at < 0) break;
        const [def] = P.deck.splice(at, 1);
        S.drawDef(s, me, def);
        updateResonance(s, me);
      }
      break;
    }
    case 'discard': {
      const n = A[0] ? num(s, A[0], ctx) : 1;
      for (let i = 0; i < n && P.hand.length; i++) {
        const at = Math.floor(s.rng() * P.hand.length);
        const [inst] = P.hand.splice(at, 1);
        S.traceCard(s, { kind: 'discard', player: me, uid: inst.uid,
          cardId: inst.def.id, name: inst.def.name });
        S.addToGrave(P, inst.def);
      }
      break;
    }
    case 'spellboost': { // 只使手牌中实际使用【演算层数】的卡累积
      const n = A[0] ? num(s, A[0], ctx) : 1;
      for (const h of P.hand) if (usesSpellboost(h.def)) h.spellboost += n;
      break;
    }
    case 'earthSigil': { // 生成通用【演算模块】护符；模块解析只认该标签
      const n = A[0] ? num(s, A[0], ctx) : 1;
      const def = s.__tokenIndex && s.__tokenIndex['演算模块'];
      if (!def) { S.log(s, '找不到衍生物定义 演算模块'); break; }
      for (let i = 0; i < n; i++) {
        if (S.boardFull(P)) break;
        const u = S.makeUnit(def, s.turn);
        placeUnit(P, u);
        S.log(s, '召唤 演算模块');
      }
      break;
    }
    case 'earthRite': { // 消耗一个演算模块，并把成功状态写入来源供同卡后续触发读取
      const sigil = P.board.find(u => S.hasTag(u, '演算模块'));
      if (ctx.source && ctx.source.counters) ctx.source.counters['模块解析'] = sigil ? 1 : 0;
      if (sigil) killUnit(s, sigil);
      break;
    }
    case 'shuffleDeck': { // 将指定卡洗入牌库，支持忆质衍生卡形成检索循环
      const name = A[0], n = A[1] ? num(s, A[1], ctx) : 1;
      const def = s.__cardIndex && s.__cardIndex[name];
      if (!def) { S.log(s, `找不到卡定义 ${name}`); break; }
      for (let i = 0; i < n; i++) P.deck.push(def);
      S.shuffle(P.deck, s.rng);
      updateResonance(s, me);
      break;
    }
    case 'necromancy': { // 消耗残响值；成功状态写入来源供 [ctr(残响调用)>=1] 使用
      const n = num(s, A[0], ctx);
      const ok = P.shadows >= n;
      if (ok) P.shadows -= n;
      if (ctx.source && ctx.source.counters) ctx.source.counters['残响调用'] = ok ? 1 : 0;
      break;
    }
    case 'destroyAlly':
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader == null && t !== ctx.source && S.ownerOf(s, t.uid) === me) killUnit(s, t, 'sacrifice');
      }
      break;
    case 'countdownDown': {
      const n = num(s, A[1], ctx) || 1;
      for (const t of resolveTarget(s, A[0], ctx).slice()) {
        if (t.__leader != null || t.type !== '护符' || t.countdown == null) continue;
        t.countdown -= n;
        if (t.countdown <= 0) killUnit(s, t, 'countdown', me);
      }
      break;
    }
    case 'buff': {
      const [da, dh] = [num(s, A[1], ctx), num(s, A[2], ctx)];
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        t.atk += da; t.hp += dh; t.maxHp += dh;
      }
      break;
    }
    case 'grant':
      for (const t of resolveTarget(s, A[0], ctx)) {
        // 【屏障】可以挂在主战者身上，所以关键词要能落到 leader
        if (t.__leader != null) s.players[t.__leader].keywords.add(A[1]);
        else t.keywords.add(A[1]);
      }
      break;
    case 'summon': {
      const name = A[0], n = A[1] ? num(s, A[1], ctx) : 1;
      for (let i = 0; i < n; i++) {
        if (S.boardFull(P)) { S.log(s, `场地已满，${name} 召唤失败`); break; }
        const def = s.__tokenIndex && s.__tokenIndex[name];
        if (!def) { S.log(s, `找不到衍生物定义 ${name}`); break; }
        const u = S.makeUnit(def, s.turn);
        placeUnit(P, u);
        // 召唤出的单位同样要生效常驻能力（守护、必杀…）；
        // 但官方【入场曲】「从手牌或牌组直接进入战场，或是生成卡牌进入战场时不会发动」，
        // 所以这里只跑 static，绝不跑 onPlay。
        for (const c of clausesOf(u)) {
          if (c.trigger === 'static') runActions(s, c.actions, { ownerIdx: me, source: u });
        }
        S.log(s, `召唤 ${u.name}`);
        fireTrigger(s, 'onAllySummon', { ownerOnly: me, ownerIdx: me, extra: u });
      }
      break;
    }
    case 'destroy':
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        // 「不会受到消灭与破坏效果影响」只挡效果，致死伤害照样能杀
        if (t.keywords.has('undestroyable')) { S.log(s, `${t.name} 不受消灭/破坏影响`); continue; }
        killUnit(s, t, 'effect', me);
      }
      break;
    /* 计数器分两种作用域，靠动作名区分：
     *   ctr  = 单位计数器（火种/充能等），onCtr 阈值读这一种
     *   pctr = 玩家计数器，只给少量需要跨单位保存的卡使用；职业即时状态不再伪装成计数器 */
    case 'ctr': {
      const delta = parseInt(A[1], 10);
      if (ctx.source) S.addUnitCtr(ctx.source, A[0], delta);
      else S.addCtr(P, A[0], delta);
      break;
    }
    case 'pctr': S.addCtr(P, A[0], parseInt(A[1], 10)); break;
    case 'buffHand': {  // 强化手牌里的随从卡（打出时带着增益进场）
      const da = num(s, A[0], ctx), dh = num(s, A[1], ctx);
      const cand = P.hand.filter(h => h.def.type === '随从');
      if (cand.length) {
        const h = cand[Math.floor(s.rng() * cand.length)];
        h.atkMod += da; h.hpMod += dh;
        S.log(s, `手牌中的 ${h.def.name} 获得 +${da}/+${dh}`);
      }
      break;
    }
    case 'buffHandTag': {
      const tag = A[0], da = num(s, A[1], ctx), dh = num(s, A[2], ctx);
      const cand = P.hand.filter(h => h.def.type === '随从' && S.hasTag({ def: h.def }, tag));
      if (cand.length) {
        const h = cand[Math.floor(s.rng() * cand.length)];
        h.atkMod += da; h.hpMod += dh;
      }
      break;
    }
    case 'cleanse':     // 解除负面效果（持续伤害/触电/弱点/缺陷/标记）
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        const sl = t.slot;
        sl.dots = 0; sl.aura = 0; sl.vuln = 0; sl.shocked = false;
        sl.flaws.clear();
        sl.marks.clear();                             // 标记 / 破绽（迁到格子的负面）
        for (const k of ['老主顾', '织线']) t.marks.delete(k);
      }
      break;
    case 'maxAtk':      // 每回合攻击次数上限（与 extraAtk 不同，这个不会在回合开始时清零）
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader == null) t.maxAttacks = Math.max(1, num(s, A[1], ctx));
      }
      break;
    case 'setLeaderHp': {
      const n = num(s, A[0], ctx);
      if (P.hp > n) { const d = P.hp - n; P.hp = n; afterLeaderDamage(s, me, d); }
      break;
    }
    case 'refundPP': P.pp = Math.min(P.pp + num(s, A[0], ctx), Math.min(RULES.PP_MAX, P.ppMax + P.ppBonus)); break;
    case 'refundEP': P.ep += num(s, A[0], ctx); break;
    case 'ppMaxUp': {
      const room = Math.max(0, RULES.PP_MAX - (P.ppMax + P.ppBonus));
      P.ppBonus += Math.min(room, num(s, A[0], ctx));
      break;
    }
    case 'ppUp': {   // 本回合临时 PP 上限 +N（回合开始时 PP 已回满，refundPP 无效；这个能突破上限）
      const n = num(s, A[0], ctx);
      P.tempPP += n; P.pp += n;
      break;
    }
    case 'extraAtk':
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.extraAttacks += num(s, A[1], ctx) || 1;
      break;
    case 'transform': {
      const def = s.__cardIndex && s.__cardIndex[A[1]];
      if (!def) { S.log(s, `找不到变身目标 ${A[1]}`); break; }
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        const was = t.name;
        // 官方【变身】：所受的伤害、附加效果、此回合是否有进行过攻击或启动均不继承；
        // 变身为随从时「从下一回合开始」才可攻击 → summonedTurn 重置为当前回合。
        // 变身不算离场，所以不触发谢幕曲（这里不走 killUnit 即可）。
        t.def = def; t.cardId = def.id; t.name = def.name; t.type = def.type;
        t.atk = def.atk | 0; t.hp = def.hp | 0; t.maxHp = def.hp | 0;
        t.keywords = new Set(); t.__clauses = null; t.counters = {};
        t.marks = new Set();                       // 清正面标记（军功/爵位/老主顾/织线）
        t.evolved = false; t.attacksUsed = 0; t.extraAttacks = 0;
        t.silenced = false;
        t.atkPlusExpr = null; t.reduceExpr = null;
        // 格子的负面效果（场地污染）保留——它跟格子绑定，不跟这张卡绑定
        t.summonedTurn = s.turn;
        t.transformedTurn = s.turn;
        t.countdown = def.countdown ?? null;
        t.characterId = def.characterId || ''; t.formTier = def.formTier || 0; t.lowerForms = [];
        for (const c of clausesOf(t)) if (c.trigger === 'static') runActions(s, c.actions, { ownerIdx: me, source: t });
        S.log(s, `${was} 变身为 ${t.name}`);
      }
      break;
    }
    case 'bounce':
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        const owner = S.ownerOf(s, t.uid);
        if (owner < 0) continue;
        const side = s.players[owner], i = side.board.indexOf(t);
        if (i < 0) continue;
        halfSlot(s, t);   // 回手也算离场，格子的负面效果减半残留
        side.board.splice(i, 1);

        const forms = t.characterId ? [...(t.lowerForms || []), t.def] : [t.def];
        for (const def of forms) {
          const inst = S.makeCardInstance(def);
          // 回手后费用与临时增益恢复原价；溢出的形态按现有规则进入墓场。
          if (side.hand.length < RULES.HAND_LIMIT) side.hand.push(inst);
          else S.addToGrave(side, def);
        }
        if (t.characterId) {
          const base = forms.find(def => Number(def.formTier || 0) === 1)
            || (s.__cardIndex && Object.values(s.__cardIndex).find(def =>
              def.characterId === t.characterId && Number(def.formTier || 0) === 1));
          t.slot.echo = {
            characterId: t.characterId,
            characterName: characterDisplayName(t, base),
            baseName: base?.name || '',
            expireOnTurn: nextTurnForPlayer(s, owner),
          };
          fireTrigger(s, 'onEcho', { ownerOnly: owner, chosen: null });
          S.log(s, `${t.name} 与真实下层全部返回手牌，在${t.slot.idx + 1}号格留下残影`);
        }
      }
      break;
    case 'mark':        // 【标记】受到的伤害 +1，挂在该随从所在的格子上
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.slot.marks.add('标记');
      break;
    case 'break':       // 【破绽】受到的伤害 +1，挂在该随从所在的格子上（通用，非命途专属）
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.slot.marks.add('破绽');
      break;
    case 'vuln':        // 【弱点】每层使其受到的伤害 +1（标记的可叠加版），挂格子
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader == null) t.slot.vuln += (num(s, A[1], ctx) || 1);
      }
      break;
    case 'dot': {       // 【持续伤害N层】自己的回合结束时结算；指向主战者时是【侵蚀】
      const n = num(s, A[1], ctx) || 1;
      let any = false;
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) {
          const lp = s.players[t.__leader];
          lp.dots += n; any = true;
          S.log(s, `${lp.name} 的主战者获得 ${n} 层侵蚀（共 ${lp.dots} 层）`);
          continue;
        }
        t.slot.dots += n; any = true;
        /* 这里原本会把场上 dotAura 随从的加成「刻」进 t.aura。那是重复计算：
         * settleDots / detonate 已经用 dotAuraBonus 动态算了一遍，
         * 于是海瑟音在场时 1 层持续伤害结算成 3 点。dotAura 是在场光环，
         * 不该留下永久痕迹，所以这一步删掉，只保留【奥迹】（黑天鹅）作为可叠加层。 */
      }
      // 「每当敌方场上持续伤害层数增加」（椒丘）
      if (any) fireTrigger(s, 'onDot', { ownerOnly: me });
      break;
    }
    case 'detonate': {  // 立即引爆【持续伤害】：每层造成 mult 点伤害，然后清空层数
      const mult = A[1] ? num(s, A[1], ctx) : 1;
      const cap = A[2] ? num(s, A[2], ctx) : 0;
      for (const t of resolveTarget(s, A[0], ctx)) {
        // 引爆主战者身上的【侵蚀】：这是虚无唯一稳定的终结手段，不依赖对手有没有随从
        if (t.__leader != null) {
          const lp = s.players[t.__leader];
          if (lp.dots <= 0) continue;
          let n = lp.dots * mult * (1 + (lp.aura || 0) + auraGranters(s, S.opp(t.__leader)));
          if (cap > 0) n = Math.min(n, cap);
          lp.dots = 0; lp.aura = 0;
          S.log(s, `引爆 ${lp.name} 的侵蚀，${n} 点`);
          dealDamage(s, { __leader: t.__leader }, n, ctx.source);
          continue;
        }
        if (t.slot.dots <= 0) continue;
        let n = t.slot.dots * mult * (1 + (t.slot.aura || 0) + dotAuraBonus(s, t));
        if (cap > 0) n = Math.min(n, cap);
        t.slot.dots = 0;
        /* 溢出穿透：超过目标剩余生命值的部分打到它主人的主战者身上。
         * 【持续伤害】原本只能打随从，虚无因此清得掉场面却完全没有获胜手段
         * （自对弈里两套侵蚀卡组 15% / 21%）。让引爆能溢出到脸，
         * 侵蚀才从「拖时间」变成真正的终结路线。 */
        const owner = S.ownerOf(s, t.uid);
        const over = Math.max(0, n - t.hp);
        S.log(s, `引爆 ${t.name} 的持续伤害 ${n} 点`);
        dealDamage(s, t, n, ctx.source);
        if (over > 0 && owner >= 0) {
          S.log(s, `溢出 ${over} 点穿透到主战者`);
          dealDamage(s, { __leader: owner }, over, ctx.source);
        }
      }
      break;
    }
    /* 唯一叠加型衍生物（忆质）：一方场上只允许存在 1 个。
     * 场上没有 → 召唤，层数 1；已有 → 只叠层数并按层加攻血。
     * 这样「铺 5 个 1/1」变成「一个越来越大的随从」，不再和真随从抢那 5 格。
     * 伤害是记在 hp 上的，所以叠层用 buff 而不是按层数重算数值，挨过的打不会被洗掉。 */
    case 'stackSummon': {
      const name = A[0], n = A[1] ? num(s, A[1], ctx) : 1;
      if (n <= 0) break;
      const def = s.__tokenIndex && s.__tokenIndex[name];
      if (!def) { S.log(s, `找不到衍生物定义 ${name}`); break; }
      let u = P.board.find(x => x.name === name);
      let add = n;
      if (!u) {
        if (S.boardFull(P)) { S.log(s, `场地已满，${name} 召唤失败`); break; }
        u = S.makeUnit(def, s.turn);
        S.addUnitCtr(u, '层数', 1);
        placeUnit(P, u);
        for (const c of clausesOf(u)) {
          if (c.trigger === 'static') runActions(s, c.actions, { ownerIdx: me, source: u });
        }
        S.log(s, `召唤 ${u.name}`);
        fireTrigger(s, 'onAllySummon', { ownerOnly: me, ownerIdx: me, extra: u });
        add = n - 1;
      }
      if (add > 0) {
        S.addUnitCtr(u, '层数', add);
        u.atk += add; u.hp += add; u.maxHp += add;
        S.log(s, `${u.name} 叠至 ${S.unitCtr(u, '层数')} 层（${u.atk}/${u.hp}）`);
      }
      break;
    }
    case 'reanimate': { // 从真实墓场移除随从卡并召还，不能重复利用同一张墓场牌
      const n = num(s, A[0], ctx) || 1;
      for (let i = 0; i < n; i++) {
        const choices = P.graveyard.map((d, at) => ({ d, at })).filter(x => x.d.type === '随从');
        if (!choices.length || S.boardFull(P)) break;
        const pick = choices[Math.floor(s.rng() * choices.length)];
        const [def] = P.graveyard.splice(pick.at, 1);
        const u = S.makeUnit(def, s.turn);
        u.atk = 2; u.hp = 2; u.maxHp = 2;
        placeUnit(P, u);
        for (const c of clausesOf(u)) {
          if (c.trigger === 'static') runActions(s, c.actions, { ownerIdx: me, source: u });
        }
        S.log(s, `从记录区召还 ${u.name}（2/2）`);
        fireTrigger(s, 'onAllySummon', { ownerOnly: me, ownerIdx: me, extra: u });
      }
      break;
    }
    case 'aura':        // 【奥迹】使该目标每层持续伤害的结算值 +1
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader == null) t.slot.aura += (num(s, A[1], ctx) || 1);
      }
      break;
    case 'shock':       // 【触电】自己的回合结束时受固定 2 点
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.slot.shocked = true;
      break;
    case 'flaw': {      // 【缺陷】迟缓 / 脆弱 / 衰弱；不指定种类则随机三选一
      const KINDS = ['迟缓', '脆弱', '衰弱'];
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        const k = (!A[1] || A[1] === 'random') ? KINDS[Math.floor(s.rng() * KINDS.length)] : A[1];
        if (!KINDS.includes(k)) { S.log(s, `未知缺陷种类 ${k}`); continue; }
        t.slot.flaws.add(k);
        S.log(s, `${t.name} 获得【缺陷·${k}】`);
      }
      break;
    }
    case 'medal': {     // 【军功】+1/+1，可叠加；第二参 = 层数
      const layers = A[1] ? num(s, A[1], ctx) : 1;
      if (layers <= 0) break;
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        t.marks.add('军功');
        t.atk += RULES.MEDAL_ATK * layers;
        t.hp += RULES.MEDAL_HP * layers;
        t.maxHp += RULES.MEDAL_HP * layers;
      }
      break;
    }
    case 'title':       // 【爵位】必须先有【军功】，额外 +2/+2 并获得必杀
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null || !t.marks.has('军功') || t.marks.has('爵位')) continue;
        t.marks.add('爵位');
        t.atk += RULES.TITLE_ATK; t.hp += RULES.TITLE_HP; t.maxHp += RULES.TITLE_HP;
        t.keywords.add('bane');
        S.log(s, `${t.name} 升级为【爵位】`);
      }
      break;
    case 'patron':      // 【老主顾】场上唯一，所以先清掉旧的
      for (const pl of s.players) for (const u of pl.board) u.marks.delete('老主顾');
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.marks.add('老主顾');
      break;
    case 'weave':       // 【间隙织线】己方随从攻击该目标时攻击力 +2
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.marks.add('织线');
      break;
    case 'atkPlus':     // 攻击力额外增加（动态，如 lostHp/2、sumVuln）
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.atkPlusExpr = A[1];
      break;
    case 'reduce':      // 受到的伤害减少（动态，如 lostHp/4）
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.reduceExpr = A[1];
      break;
    case 'evolveFree':
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) doEvolve(s, me, t, true);
      break;
    case 'costDown':    // 自己手牌全部费用 -N（不需要目标）
      for (const inst of P.hand) inst.costMod -= num(s, A[0], ctx);
      break;
    case 'costDownTag': { // 指定标签的手牌费用 -N（玩偶兑现等）
      const tag = A[0], n = num(s, A[1], ctx);
      for (const inst of P.hand) if (S.hasTag({ def: inst.def }, tag)) inst.costMod -= n;
      break;
    }
    case 'consumeHandTag': { // 消耗最多N张指定标签手牌，数量写入来源计数器
      const tag = A[0], cap = A[1] ? num(s, A[1], ctx) : RULES.HAND_LIMIT;
      let used = 0;
      for (let i = P.hand.length - 1; i >= 0 && used < cap; i--) {
        const inst = P.hand[i];
        if (!S.hasTag({ def: inst.def }, tag)) continue;
        P.hand.splice(i, 1); S.addToGrave(P, inst.def); used++;
      }
      if (ctx.source) { ctx.source.counters ||= {}; ctx.source.counters['消耗手牌'] = used; }
      break;
    }
    case 'custom': S.log(s, `[custom:${A[0]}] 未实现的特例效果`); break;
    default: S.log(s, `未实现动作 ${a.op}`);
  }
}

/* ---------------- 动态数值 ----------------
 * 卡面里真正出现的动态量只有下面这些，所以求值器故意做得很小：
 *   整数          3
 *   指标          lostHp / spellboost / shadows / cardsPlayed …
 *   指标除以常数   lostHp/4   （向下取整，对应卡面的「÷4（向下取整）」）
 * 写了不认识的量会抛错，不会静默算成 0。
 */
export function metricOf(s, name, ctx) {
  const me = ctx.ownerIdx == null ? 0 : ctx.ownerIdx, you = S.opp(me);
  const P = s.players[me], E = s.players[you];
  const c = /^ctr\(([^)]+)\)$/.exec(name);
  if (c) {
    const nm = c[1];
    if (ctx.source && ctx.source.counters && ctx.source.counters[nm] != null) return S.unitCtr(ctx.source, nm);
    return S.ctrOf(P, nm);
  }
  // tagCount(蛰虫) / enemyTagCount(虚卒)
  const tg = /^(tagCount|enemyTagCount)\(([^)]+)\)$/.exec(name);
  if (tg) {
    const side = tg[1] === 'tagCount' ? P : E;
    return S.minionsOf(side).filter(u => S.hasTag(u, tg[2])).length;
  }
  switch (name) {
    case 'lostHp':      return Math.max(0, P.maxHp - P.hp);   // 自己主战者已损失生命值
    case 'enemyLostHp': return Math.max(0, E.maxHp - E.hp);
    case 'selfHp':      return P.hp;
    case 'sumVuln':     return S.minionsOf(E).reduce((a, u) => a + u.slot.vuln, 0);
    case 'flawCount':   return S.minionsOf(E).reduce((a, u) => a + u.slot.flaws.size, 0);
    // 敌方全部【持续伤害】层数：场上格子的 + 已沉淀到敌方主战者身上的【侵蚀】
    case 'dotLayers':   return S.minionsOf(E).reduce((a, u) => a + u.slot.dots, 0) + (E.dots || 0);
    case 'leaderDots':  return E.dots || 0;
    case 'tokenCount':  return P.board.filter(u => u.def && u.def.isToken).length;
    case 'allyCount':   return S.minionsOf(P).length;
    case 'enemyCount':  return S.minionsOf(E).length;
    case 'graveCount':  return P.shadows || 0;
    case 'cardsPlayed': return P.cardsPlayedThisTurn;
    case 'ppMax':       return Math.min(RULES.PP_MAX, P.ppMax + P.ppBonus);
    /* 记忆的「忆质与忆灵数量」。忆质现在是唯一叠加的，所以数它的层数；
     * 忆灵（长夜/迷迷/小伊卡/衣匠）仍是各自独立的随从，按个数算。 */
    case 'memCount': {
      let n = 0;
      for (const u of S.minionsOf(P)) {
        if (u.name === '忆质') n += Math.max(1, S.unitCtr(u, '层数'));
        else if (S.hasTag(u, '忆质')) n += 1;
      }
      return n;
    }
    case 'spellboost':   return ctx.source ? (ctx.source.spellboost || 0) : 0;
    case 'earthSigils':  return P.board.filter(u => S.hasTag(u, '演算模块')).length;
    case 'shadows':      return P.shadows || 0;
    case 'evolves':      return P.evolves || 0;
    case 'selfDamageTurn': return P.selfDamageThisTurn || 0;
    case 'resonance':    return S.isResonance(P) ? 1 : 0;
    case 'markedCount': return S.minionsOf(E).filter(u => u.slot.marks.has('标记')).length;
    case 'selfAtk':     return ctx.source ? effAtk(s, ctx.source) : 0;
    case 'myAttacks':   return ctx.source ? ctx.source.attacksUsed : 0;
    case 'targetAtk':   return (ctx.chosen && ctx.chosen.__leader == null) ? effAtk(s, ctx.chosen) : 0;
    default: return null;
  }
}

function num(s, v, ctx) {
  if (v == null) return 0;
  const str = String(v).trim();
  if (/^-?\d+$/.test(str)) return parseInt(str, 10);
  const div = /^(.+?)\/(\d+)$/.exec(str);
  if (div) {
    const base = metricOf(s, div[1].trim(), ctx);
    if (base == null) throw new Error(`未知动态数值 "${str}"`);
    return Math.floor(base / parseInt(div[2], 10));
  }
  const mul = /^(.+?)\*(\d+)$/.exec(str);
  if (mul) {
    const base = metricOf(s, mul[1].trim(), ctx);
    if (base == null) throw new Error(`未知动态数值 "${str}"`);
    return base * parseInt(mul[2], 10);
  }
  const m = metricOf(s, str, ctx);
  if (m == null) throw new Error(`未知动态数值 "${str}"`);
  return m;
}

/** 有效攻击力 = 基础 + 动态加成 −【缺陷·衰弱】，不小于 0 */
export function effAtk(s, u) {
  let n = u.atk;
  if (u.atkPlusExpr) {
    const pi = S.ownerOf(s, u.uid);
    n += num(s, u.atkPlusExpr, { ownerIdx: pi < 0 ? 0 : pi, source: u });
  }
  if (u.slot.flaws.has('衰弱')) n -= 1;
  return Math.max(0, n);
}

/** 受到伤害的加成：【标记】+1、【破绽】+1、【弱点】每层+1、【缺陷·脆弱】+1（都读格子） */
function dmgTakenBonus(u) {
  return (u.slot.marks.has('标记') ? 1 : 0) + (u.slot.marks.has('破绽') ? 1 : 0)
    + (u.slot.vuln || 0) + (u.slot.flaws.has('脆弱') ? 1 : 0);
}

function reduceOf(s, u) {
  if (!u.reduceExpr) return 0;
  const pi = S.ownerOf(s, u.uid);
  return num(s, u.reduceExpr, { ownerIdx: pi < 0 ? 0 : pi, source: u });
}

/* ---------------- 伤害 / 治疗 / 死亡 ---------------- */

/**
 * 造成伤害。opts.combat=true 表示这次伤害来自交战（攻击或被攻击），
 * 【必杀】只在交战时生效——官方定义是「因进行攻击或被攻击对对手的随从造成伤害时，
 * 破坏对手的随从。即使攻击力为0，或因对手的能力导致造成的伤害变为0，依然会发动」。
 * 所以必杀判定必须绕过「伤害≤0 直接返回」这条捷径，且不适用于法术等非交战伤害。
 */
export function dealDamage(s, target, n, source, opts = {}) {
  const bane = opts.combat === true && target.__leader == null && target.type === '随从'
    && source && source.keywords && source.keywords.has('bane');

  if (target.__leader != null) {
    if (n <= 0) return 0;
    const p = s.players[target.__leader];
    if (p.keywords.has('barrier')) {                  // 【屏障】：伤害变 0，发动 1 次后失效
      p.keywords.delete('barrier');
      S.log(s, `${p.name} 的屏障吸收了 ${n} 点伤害`);
      return 0;
    }
    n += p.vuln || 0;                                  // 【易伤】：主战者受到的伤害 +N
    p.hp -= n;
    afterLeaderDamage(s, target.__leader, n);
    return n;
  }

  // 官方：护符「无法进行攻击，也不会被攻击」，也不承受伤害；要移除护符只能用「破坏」效果。
  if (target.type !== '随从') return 0;

  // 官方：「使伤害增减的能力，会先于将伤害变为特定数值的能力发动」
  // → 先算【标记】【弱点】【脆弱】的加成与减免，再判【屏障】能否把伤害归零
  if (n > 0) n = Math.max(0, n + dmgTakenBonus(target) - reduceOf(s, target));
  if (n <= 0 && !bane) return 0;

  if (target.keywords.has('barrier')) {
    target.keywords.delete('barrier');
    S.log(s, `${target.name} 的屏障吸收了 ${n} 点伤害`);
    // 官方必杀：「即使…因对手的能力导致造成的伤害变为0，依然会发动」→ 屏障挡不住必杀
    if (bane) { target.hp = 0; killUnit(s, target, opts.combat ? 'combat' : 'damage'); }
    return 0;
  }

  if (n > 0) {
    target.hp -= n;
    // attacker 传下去，卡面才能写「给予攻击者N点伤害」这类反击效果
    fireTrigger(s, 'onDamaged', { source: target, attacker: source || null });
    // 「每当敌方随从受到伤害」——只对被伤害者的对手一侧触发
    const owner = S.ownerOf(s, target.uid);
    if (owner >= 0) fireTrigger(s, 'onEnemyDamaged', { ownerOnly: S.opp(owner), chosen: target });
  }
  if (bane) target.hp = 0;
  if (target.hp <= 0) killUnit(s, target, opts.combat ? 'combat' : 'damage');
  return Math.max(0, n);
}

function afterLeaderDamage(s, pi, n) {
  const p = s.players[pi];
  if (n > 0 && pi === s.active) p.selfDamageThisTurn += 1;
  fireTrigger(s, 'onLeaderDamaged', { ownerOnly: pi });
  // 主战者受伤会喂养单位计数器（刃的充能、白厄的火种），所以必须紧接着扫阈值。
  // 各卡的 onCtr 子句都以 ctr(名,-N) 开头先清零，因此不会自我递归。
  checkCtrTriggers(s, pi);
  if (s.players[pi].hp <= 0) s.winner = S.opp(pi);
}

export function healTarget(s, target, n) {
  if (target.__leader != null) {
    const p = s.players[target.__leader];
    p.hp = Math.min(p.hp + n, p.maxHp);
    fireTrigger(s, 'onLeaderHeal', { ownerOnly: target.__leader });
    return;
  }
  target.hp = Math.min(target.hp + n, target.maxHp);
}

export function killUnit(s, u, reason = 'destroyed', actorIdx = null) {
  /* 同一个单位只能死一次。
   *
   * 【谢幕曲】是在单位还留在场上时结算的（fireTrigger 靠它在场才找得到那条子句），
   * 于是「谢幕曲：给敌方全体随从伤害」能杀掉对面同样带这种谢幕曲的随从，
   * 对面那条又打回来、再次命中这个 hp≤0 但尚未移除的单位——
   * killUnit → 谢幕曲 → dealDamage → killUnit，无限递归，整局卡死。
   * 双方同时在场才会触发，所以 1512 局自对弈没撞上；消融实验换掉一张卡后撞出来了。 */
  if (u.__dying) return;
  const pi = S.ownerOf(s, u.uid);
  if (pi < 0) return;
  u.__dying = true;
  const wasMinion = u.type === '随从';
  // 崩坏角色只会因伤害/交战，或明确来自对手的消灭效果而退阶。
  // 回手、变形、倒数、己方牺牲以及己方主动破坏都绕过退阶与残影。
  const enemyRemoved = reason === 'effect' && actorIdx != null && actorIdx !== pi;
  const canRetreat = wasMinion && u.characterId
    && (reason === 'damage' || reason === 'combat' || enemyRemoved);
  fireTrigger(s, 'onDeath', { source: u, ownerIdx: pi });   // 【谢幕曲】

  if (canRetreat && S.ownerOf(s, u.uid) === pi) {
    const p = s.players[pi], slot = u.slot;
    S.addToGrave(p, u.def);                  // 被击破的顶层形态正常进入墓场
    if (u.lowerForms && u.lowerForms.length) {
      const lower = u.lowerForms.pop();
      const remaining = u.lowerForms.slice();
      const from = u.name;
      applyUnitForm(u, lower, s.turn, false);
      u.lowerForms = remaining;
      // 复归形态在下一次控制者回合可以攻击；若于自己回合被击破，则本回合不能立即攻击。
      u.summonedTurn = s.turn;
      for (const c of clausesOf(u)) {
        if (c.trigger === 'static') runActions(s, c.actions, { ownerIdx: pi, source: u });
      }
      // 任一崩坏护符在场时，本敌方回合首次退阶会为复归形态提供屏障，避免一次回合连续击穿。
      const protectedBySupport = p.board.some(x => x !== u && x.type === '护符' && x.def.class === '崩坏');
      if (protectedBySupport && S.ctrOf(p, '崩坏退阶保护回合') !== s.turn) {
        u.keywords.add('barrier');
        p.counters['崩坏退阶保护回合'] = s.turn;
        S.log(s, `${u.name} 受到支援保护并获得屏障`);
      }
      fireTrigger(s, 'onRetreat', { source: u, ownerIdx: pi });
      fireTrigger(s, 'onAllyRetreat', { ownerOnly: pi, chosen: u });
      S.log(s, `${from} 被击破，退阶为 ${u.name}`);
      fireTrigger(s, 'onAllyDeath', { ownerOnly: pi, chosen: u });
      fireTrigger(s, 'onEnemyDeath', { ownerOnly: S.opp(pi), chosen: u });
      return;
    }
    p.board.splice(p.board.indexOf(u), 1);
    const base = (s.__cardIndex && Object.values(s.__cardIndex).find(def =>
      def.characterId === u.characterId && Number(def.formTier || 0) === 1)) || null;
    slot.echo = {
      characterId: u.characterId,
      characterName: characterDisplayName(u, base),
      baseName: base?.name || '',
      expireOnTurn: nextTurnForPlayer(s, pi),
    };
    fireTrigger(s, 'onEcho', { ownerOnly: pi, chosen: null });
    S.log(s, `${u.name} 被击破，在${slot.idx + 1}号格留下1阶残影`);
  } else {
    removeUnit(s, u);
  }
  // 「每当敌方随从被消灭」只数随从，护符离场不算
  if (wasMinion) {
    fireTrigger(s, 'onAllyDeath', { ownerOnly: pi, chosen: u });
    fireTrigger(s, 'onEnemyDeath', { ownerOnly: S.opp(pi), chosen: u });
  }
}

function characterDisplayName(u, base = null) {
  const raw = String(base?.tag || u?.def?.tag || '').trim();
  if (raw && !['女武神', '随从'].includes(raw)) return raw;
  return base?.name || u?.name || '角色';
}

function nextTurnForPlayer(s, pi) {
  let turn = s.turn + 1;
  let active = S.opp(s.active);
  while (active !== pi) { turn += 1; active = S.opp(active); }
  return turn;
}

function removeUnit(s, u) {
  for (const p of s.players) {
    const i = p.board.indexOf(u);
    if (i >= 0) { halfSlot(s, u); p.board.splice(i, 1); S.addToGrave(p, u.def); return; }
  }
}

function applyUnitForm(u, def, turn, preserveActions) {
  const summonedTurn = preserveActions ? u.summonedTurn : turn;
  const attacksUsed = preserveActions ? u.attacksUsed : 0;
  const slot = u.slot;
  u.cardId = def.id; u.def = def; u.name = def.name; u.type = def.type;
  u.atk = def.atk | 0; u.hp = def.hp | 0; u.maxHp = def.hp | 0;
  u.keywords = new Set(); u.counters = {}; u.spellboost = 0; u.marks = new Set();
  u.atkPlusExpr = null; u.reduceExpr = null;
  u.attacksUsed = attacksUsed; u.maxAttacks = 1; u.extraAttacks = 0;
  u.evolved = false; u.summonedTurn = summonedTurn; u.transformedTurn = -99;
  u.countdown = def.countdown ?? null; u.silenced = false; u.__clauses = null;
  u.characterId = def.characterId || ''; u.formTier = def.formTier || 0;
  u.slot = slot;
  delete u.__dying;
  return u;
}

/* 把单位放进某个场地格子。slotIdx 为空时自动找第一个空位。
 * board 保持「非空单位数组」但按格位排序，所以 minionsOf 等 filter 照常工作。 */
export function placeUnit(p, u, slotIdx) {
  if (slotIdx == null) {
    const used = new Set(p.board.map(x => x.slot.idx));
    slotIdx = [0, 1, 2, 3, 4].find(i => !used.has(i));
    if (slotIdx == null) return false;
  }
  u.slot = p.slots[slotIdx];
  if (u.slot.echo) u.slot.echo = null;
  p.board.push(u);
  p.board.sort((a, b) => a.slot.idx - b.slot.idx);
  return true;
}

/* 随从离场时，它所在格子的负面效果减半残留（不再转移、也不再沉淀）。
 * 「延迟爆发/非直接伤害」的效果挂在场地上：卡走了，污染还留在格子里，
 * 新随从站进来就吃到残留——所以换掉带 debuff 的随从不再是白赚。
 * 减半规则：数字层数 floor/ceil 各 50%（7→3或4）；集合/布尔 50% 概率保留。
 * 用 s.rng()，自对弈同一 seed 可复现。 */
function halfSlot(s, u) {
  if (!u || !u.slot || u.type !== '随从') return;
  const sl = u.slot;
  const half = n => (s.rng() < 0.5 ? Math.floor(n / 2) : Math.ceil(n / 2));
  const keep = () => s.rng() < 0.5;

  if (sl.dots > 0) { const o = sl.dots; sl.dots = half(o); if (sl.dots !== o) S.log(s, `${u.name} 离场，格子的持续伤害 ${o}→${sl.dots}`); }
  if (sl.vuln > 0) { const o = sl.vuln; sl.vuln = half(o); if (sl.vuln !== o) S.log(s, `${u.name} 离场，格子的弱点 ${o}→${sl.vuln}`); }
  if (sl.aura > 0 && !keep()) { sl.aura = 0; S.log(s, `${u.name} 离场，格子的奥迹消散`); }
  for (const m of [...sl.marks]) if (!keep()) { sl.marks.delete(m); S.log(s, `${u.name} 离场，格子的「${m}」消散`); }
  for (const f of [...sl.flaws]) if (!keep()) { sl.flaws.delete(f); S.log(s, `${u.name} 离场，格子的「${f}」消散`); }
  if (sl.shocked && !keep()) { sl.shocked = false; S.log(s, `${u.name} 离场，格子的触电消散`); }
}

/* ---------------- 回合与行动 ---------------- */

export function startTurn(s) {
  if (s.winner != null) return s;
  s.turn += 1;
  const p = S.self(s);
  // 官方：「在自己的回合开始时，能量点最大值＋1且回复至上限。能量点的上限不会大于10。」
  // PP 上限 = 该玩家自己经历的回合数（第1回合1点，每回合+1，最多10）
  p.ppMax = Math.min(turnOfPlayer(s), RULES.PP_MAX);
  p.pp = Math.min(RULES.PP_MAX, p.ppMax + p.ppBonus);
  p.tempPP = 0;                        // 清掉上一回合的临时 PP（ppUp）
  p.selfDamageThisTurn = 0;
  p.cardsPlayedThisTurn = 0;
  p.spellsPlayedThisTurn = 0;
  p.evolvedThisTurn = false;
  for (const u of p.board) { u.attacksUsed = 0; u.extraAttacks = 0; }
  S.drawCard(s, s.active);
  updateResonance(s, s.active);
  if (s.winner != null) return s;      // 牌库耗尽已判负，不再结算后续时机
  fireTrigger(s, 'turnStart', { ownerOnly: s.active });
  tickCountdowns(s, s.active);         // 官方【倒数】：自己的回合开始时 -1，为 0 时被破坏
  return s;
}

/** 当前行动方经历的回合序号（各自独立计数，用于 PP 上限） */
function turnOfPlayer(s) { return Math.ceil(s.turn / 2); }

function expireEchoesAtEnd(s, pi) {
  for (const sl of s.players[pi].slots) {
    if (sl.echo && sl.echo.expireOnTurn <= s.turn) {
      S.log(s, `${sl.echo.characterName || sl.echo.baseName || sl.echo.characterId} 的残影消散`);
      sl.echo = null;
    }
  }
}

export function endTurn(s) {
  const ending = s.active;
  fireTrigger(s, 'turnEnd', { ownerOnly: ending });
  settleDots(s, S.opp(ending));   // 敌方单位在你回合结束时结算持续伤害
  // 持续伤害可能在回合结束结算中制造残影；仍应保留到受害者的下个回合结束。
  expireEchoesAtEnd(s, ending);
  s.active = S.opp(ending);
  return s;
}

/* 海瑟音 / 忘归人的在场光环：【持续伤害】的结算数值 +1。
 * 刻意不叠加：两张同时在场时若线性 +2，每层就从 2 点跳到 3 点（+50%），
 * 而这两张都是 5 费虹卡、中盘一起站场并不难，持续侵蚀因此直接冲到 71%。
 * 「在场时 +1」这类同类光环按一份算，是与【老主顾】场上唯一同一路的裁定。 */
function auraGranters(s, pi) {
  return s.players[pi].board.some(u => u.keywords.has('dotAura')) ? 1 : 0;
}
/** 对某个受害单位而言，来自对手场面的持续伤害加成 */
function dotAuraBonus(s, victim) {
  const owner = S.ownerOf(s, victim.uid);
  return owner < 0 ? 0 : auraGranters(s, S.opp(owner));
}

/* 【持续伤害】与【触电】都在「施加方的回合结束时」结算，所以这里传进来的是对手。
 * 每层持续伤害的结算值受【奥迹】与场上的 dotAura 随从加成。 */
function settleDots(s, pi) {
  for (const u of s.players[pi].board.slice()) {
    const sl = u.slot;
    if (sl.dots > 0) dealDamage(s, u, sl.dots * (1 + (sl.aura || 0) + dotAuraBonus(s, u)), null);
    if (sl.shocked) dealDamage(s, u, RULES.SHOCK_DMG, null);
  }
  /* 主战者身上的【侵蚀】：每回合结算，层数不消耗，伤害随层数成长。
   *
   * 原来是固定 1 点，层数纯粹是「攒给引爆的弹药」。消融实验证明这条设计不成立：
   * 引爆卡在没层数时等于空放，而对局只有 6~7 个自己的回合，
   * 「施加 → 攒够 → 抽到引爆 → 层数足够多」这条 4 步链条根本走不完，
   * 于是三张引爆卡实测都不如一张同费白板（蚀刻残响 +9.5%）。
   * 现在层数本身就是递进的压力，引爆从「唯一出口」变成「提前兑现」。
   * 上限 4 点是为了不让它在中盘直接结束比赛。 */
  const P = s.players[pi];
  if (P.dots > 0) {
    // 曲线是量出来的：1+层数/3 上限4 让引爆奥迹从 44% 冲到 75%，太陡；放缓成 1+层数/5 上限3（/3和/4在常见的3~8层区间给出的值几乎一样，等于没调）
    const scale = Math.min(3, 1 + Math.floor(P.dots / 5));
    dealDamage(s, { __leader: pi }, scale + (P.aura || 0) + auraGranters(s, S.opp(pi)), null);
  }
}

function updateResonance(s, pi) {
  const p = s.players[pi];
  if (p.__updatingResonance) return;
  p.__updatingResonance = true;
  try {
    const now = S.isResonance(p);
    const before = p.wasResonance;
    p.wasResonance = now; // 触发前先提交状态，避免触发内抽牌递归再次看到旧状态
    if (now) fireTrigger(s, 'onResonance', { ownerOnly: pi });
    if (now !== before) {
      fireTrigger(s, now ? 'onEnterResonance' : 'onLeaveResonance', { ownerOnly: pi });
    }
  } finally {
    p.__updatingResonance = false;
  }
}

function tickCountdowns(s, pi) {
  for (const u of s.players[pi].board.slice()) {
    if (u.type !== '护符' || u.countdown == null) continue;
    u.countdown -= 1;
    // 官方：「倒计数变为0时卡牌将被破坏」——是被破坏，所以要触发谢幕曲、进墓场
    if (u.countdown <= 0) killUnit(s, u);
  }
}

/**
 * 一张手牌当前的实际费用。除了 costMod（外部降费）之外，还要算上卡牌自己的
 * costIf 子句——对应「若已入魔，此牌在手牌中的费用-4」这类写法。
 * 出牌、AI 选牌、界面显示都必须走这一个函数，否则三处会算出不同的费用。
 */
function handCostFor(s, inst, ownerIdx) {
  let c = inst.def.cost + inst.costMod;
  const clauses = inst.def.clauses || parseEffect(inst.def.effect, inst.def.name);
  for (const cl of clauses) {
    if (cl.trigger !== 'costIf') continue;
    if (!evalCond(cl.cond, condCtx(s, ownerIdx, inst, null))) continue;
    c -= num(s, cl.args[0], { ownerIdx, source: inst });
  }
  return Math.max(0, c);
}

function baseHandCost(s, inst, ownerIdx) {
  return handCostFor(s, inst, ownerIdx);
}

/**
 * 崩坏随从的实际出牌路径。场上已有同角色或其残影时，位置与费用由该锚点决定；
 * 没有锚点时才是普通登场。返回值同时供引擎、界面和 AI 使用，避免三套判定分叉。
 */
export function formPlayPlan(s, inst, ownerIdx = s.active) {
  const def = inst && inst.def;
  const p = s.players[ownerIdx];
  const fullCost = inst ? baseHandCost(s, inst, ownerIdx) : 0;
  if (!def || def.type !== '随从' || !def.characterId) {
    return { ok: true, mode: 'normal', cost: fullCost, slot: null };
  }

  const current = p.board.find(u => u.characterId === def.characterId);
  const echoSlot = p.slots.find(sl => sl.echo && sl.echo.characterId === def.characterId);
  if (current && echoSlot) {
    return { ok: false, why: '同一角色的场上形态与残影不能同时存在' };
  }
  if (current) {
    if ((def.formTier || 0) <= (current.formTier || 0)) {
      return { ok: false, why: `场上已有${current.formTier}阶${current.name}，只能向更高阶替换` };
    }
    const gap = def.formTier - current.formTier;
    const raw = gap === 1 ? def.replaceCost : def.crossTierCost;
    if (raw == null) return { ok: false, why: '该形态没有对应的替换费用' };
    const supportDown = 0;
    return { ok: true, mode: gap === 1 ? 'replace' : 'cross-replace',
      cost: Math.max(0, raw + (inst.costMod || 0) - supportDown), slot: current.slot.idx, current };
  }
  if (echoSlot) {
    if (def.formTier === 1) {
      return { ok: true, mode: 'echo-deploy', cost: fullCost, slot: echoSlot.idx, echo: echoSlot.echo };
    }
    const raw = def.formTier === 2 ? def.replaceCost : def.crossTierCost;
    if (raw == null) return { ok: false, why: '该形态无法从1阶残影替换' };
    const supportDown = 0;
    return { ok: true, mode: def.formTier === 2 ? 'echo-replace' : 'echo-cross-replace',
      cost: Math.max(0, raw + (inst.costMod || 0) - supportDown), slot: echoSlot.idx, echo: echoSlot.echo };
  }
  return { ok: true, mode: 'normal', cost: fullCost, slot: null };
}

export function handCost(s, inst, ownerIdx = s.active) {
  return formPlayPlan(s, inst, ownerIdx).cost;
}

/**
 * 这张卡打出时需要玩家指定目标吗？返回 null 或 'enemyOne' / 'allyOne' / 'enemyAny'。
 * 界面靠它决定「点了牌是直接打出，还是进入选目标状态」。
 * 引擎在没拿到 opts.target 时会自动挑第一个合法目标——那是给自对弈兜底的，
 * 真人对局必须让玩家自己点，否则等于卡效被随机化。
 */
export function needsTarget(def, s = null, ownerIdx = null) {
  const clauses = def.clauses || parseEffect(def.effect, def.name);
  for (const c of clauses) {
    if (s && c.cond) {
      const pi = ownerIdx == null ? s.active : ownerIdx;
      if (!evalCond(c.cond, condCtx(s, pi, null, null))) continue;
    }
    if (!['spell', 'onPlay', 'onReplace'].includes(c.trigger)) continue;
    for (const a of c.actions) {
      const t = a.args[0];
      if (t === 'enemyAny') return 'enemyAny';
      if (t === 'enemyOne') return 'enemyOne';
      if (t === 'allyOne') return 'allyOne';
    }
  }
  return null;
}

export function canPlay(s, handIndex) {
  const p = S.self(s);
  const inst = p.hand[handIndex];
  if (!inst) return { ok: false, why: '手牌索引无效' };
  const plan = formPlayPlan(s, inst);
  if (!plan.ok) return plan;
  const cost = plan.cost;
  if (cost > p.pp) return { ok: false, why: `PP 不足（需 ${cost}，有 ${p.pp}）` };
  // 换装与残影复归沿用原格，不增加场上单位，所以满场时仍可进行。
  if (inst.def.type !== '法术' && plan.mode === 'normal' && S.boardFull(p)) {
    return { ok: false, why: '场地已满（上限 5）' };
  }
  // 官方【选择】：「拥有选择能力的法术，只能在可以选择全部指定数量的情况下使用。
  // 拥有选择能力入场曲的随从或护符，在无法选择全部指定数量的情况下也能使用。」
  // 所以只卡法术，随从/护符照常可打。
  if (inst.def.type === '法术') {
    const miss = missingSpellTarget(s, inst.def);
    if (miss) return { ok: false, why: `没有合法目标（需要${miss}）` };
  }
  return { ok: true, cost, plan };
}

/** 法术若引用 enemyOne/allyOne 而场上没有对应随从，返回缺失的目标描述，否则 null */
function missingSpellTarget(s, def) {
  const me = s.active;
  for (const c of parseEffect(def.effect, def.name)) {
    if (c.trigger !== 'spell' && c.trigger !== 'onPlay') continue;
    // 条件不成立的子句本来就不结算，不该因它缺目标而封掉整张卡
    if (!evalCond(c.cond, condCtx(s, me, null, null))) continue;
    for (const a of c.actions) {
      if (!a.args.length) continue;
      const t = a.args[0];
      if (t === 'enemyOne' && !S.minionsOf(S.foe(s)).length) return '1个敌方随从';
      if (t === 'allyOne' && !S.minionsOf(S.self(s)).length) return '1个自己的随从';
    }
  }
  return null;
}

function usesSpellboost(def) {
  return /\bspellboost\b/.test(String(def?.effect || ''));
}

export function playCard(s, handIndex, opts = {}) {
  const chk = canPlay(s, handIndex);
  if (!chk.ok) return chk;
  const me = s.active, p = S.self(s);
  const inst = p.hand.splice(handIndex, 1)[0];
  p.pp -= chk.cost;
  p.cardsPlayedThisTurn += 1;
  if (inst.def.type === '法术') {
    p.spellsPlayedThisTurn += 1;
    for (const h of p.hand) if (usesSpellboost(h.def)) h.spellboost += 1;
  }
  S.log(s, `打出 ${inst.def.name}（${chk.cost} PP）`);
  S.traceCard(s, { kind: 'play', player: me, uid: inst.uid,
    cardId: inst.def.id, name: inst.def.name, cost: chk.cost });

  const ctx = { ownerIdx: me, chosen: opts.target, chosenAlly: opts.ally, source: inst };

  if (inst.def.type === '法术') {
    for (const c of parseEffect(inst.def.effect, inst.def.name)) {
      if (c.trigger !== 'spell' && c.trigger !== 'onPlay') continue;
      if (!evalCond(c.cond, condCtx(s, me, inst, opts.target))) continue;
      runActions(s, c.actions, ctx);
    }
    S.addToGrave(p, inst.def);
  } else {
    const plan = chk.plan;
    const replacing = plan && plan.mode.includes('replace');
    let u;
    if (replacing) {
      if (plan.current) {
        const old = plan.current;
        const preserved = {
          uid: old.uid,
          slot: old.slot,
          lowerForms: old.lowerForms || [],
          summonedTurn: old.summonedTurn,
          attacksUsed: old.attacksUsed,
        };
        u = S.makeUnit(inst.def, s.turn);
        u.uid = preserved.uid;
        u.slot = preserved.slot;
        u.lowerForms = [...preserved.lowerForms, old.def];
        u.summonedTurn = preserved.summonedTurn;
        u.attacksUsed = preserved.attacksUsed;
        p.board[p.board.indexOf(old)] = u;
        p.board.sort((a, b) => a.slot.idx - b.slot.idx);
      } else {
        // 残影视作该角色的1阶锚点；高阶在原格换装，并保存真实1阶用于被击破后的复归。
        u = S.makeUnit(inst.def, s.turn);
        const base = (s.__cardIndex && Object.values(s.__cardIndex).find(d =>
          d.characterId === u.characterId && d.formTier === 1)) || null;
        if (base) u.lowerForms = [base];
        placeUnit(p, u, plan.slot);
      }
      // 从残影换装属于一次新的部署：真实一阶已经离场，不继承其存活回合或攻击历史。
      if (plan.mode.startsWith('echo-')) {
        u.summonedTurn = s.turn;
        u.attacksUsed = 0;
      }
      u.spellboost = inst.spellboost || 0;
      if (inst.atkMod) u.atk += inst.atkMod;
      if (inst.hpMod) { u.hp += inst.hpMod; u.maxHp += inst.hpMod; }
      for (const c of clausesOf(u)) {
        if (c.trigger === 'static') runActions(s, c.actions, { ...ctx, source: u });
      }
      ctx.source = u;
      for (const c of clausesOf(u)) {
        if (c.trigger !== 'onReplace') continue;
        if (!evalCond(c.cond, condCtx(s, me, u, opts.target))) continue;
        runActions(s, c.actions, ctx);
      }
      const echo = plan.mode.startsWith('echo-');
      const cross = plan.mode.includes('cross');
      S.log(s, `${u.name} ${echo ? '从残影' : ''}完成${cross ? '跨阶' : '相邻'}换装`);
    } else {
      u = S.makeUnit(inst.def, s.turn);
      u.spellboost = inst.spellboost || 0;
      // 在手牌里拿到的增益要带进场
      if (inst.atkMod) u.atk += inst.atkMod;
      if (inst.hpMod) { u.hp += inst.hpMod; u.maxHp += inst.hpMod; }
      const slot = plan && plan.slot != null ? plan.slot : opts.slot;
      placeUnit(p, u, slot);
      for (const c of clausesOf(u)) {
        if (c.trigger === 'static') runActions(s, c.actions, { ...ctx, source: u });
      }
      ctx.source = u;
      for (const c of clausesOf(u)) {
        if (c.trigger !== 'onPlay') continue;
        if (!evalCond(c.cond, condCtx(s, me, u, opts.target))) continue;
        runActions(s, c.actions, ctx);
      }
      fireTrigger(s, 'onAllySummon', { ownerOnly: me, ownerIdx: me, extra: u });
      fireTrigger(s, 'onEnemySummon', { ownerOnly: S.opp(me) });
    }
  }
  fireTrigger(s, 'onCard', { ownerOnly: me });
  if (inst.def.type === '法术') fireTrigger(s, 'onSpell', { ownerOnly: me });
  checkCtrTriggers(s, me);
  return { ok: true };
}

/** 检查所有 onCtr 阈值（放在动作之后统一扫，避免递归） */
function checkCtrTriggers(s, pi) {
  for (const u of s.players[pi].board.slice()) {
    for (const c of clausesOf(u)) {
      if (c.trigger !== 'onCtr') continue;
      const nm = c.args[0], thr = parseInt(c.args[1], 10);
      if (S.unitCtr(u, nm) >= thr) {
        runActions(s, c.actions, { ownerIdx: pi, source: u });
      }
    }
  }
}

export function canAttack(s, u) {
  if (!u || u.type !== '随从') return false;
  const limit = u.maxAttacks + u.extraAttacks;
  if (u.attacksUsed >= limit) return false;
  /* 官方【变身】：「变身为随从时，从下一回合开始，可攻击对手的主战者或随从。」
   * 变身不算「进入战场」，所以疾驰/突进都不能豁免这一条。 */
  if (u.transformedTurn === s.turn) return false;
  const fresh = u.summonedTurn === s.turn;
  if (fresh && !u.keywords.has('rush') && !u.keywords.has('storm') && !u.evolved) return false;
  return true;
}

/**
 * 攻击的合法性校验，不改动任何状态。
 * attack() 与界面共用这一个函数——否则界面会自己写一套判定，
 * 迟早和引擎的规则对不上（比如漏掉「无视守护」的例外）。
 */
export function checkAttack(s, attackerUid, targetUid) {
  const P = S.self(s), F = S.foe(s);
  const a = P.board.find(u => u.uid === attackerUid);
  if (!canAttack(s, a)) return { ok: false, why: '该随从本回合无法攻击' };

  const taunts = S.tauntTargets(F);
  const wantLeader = targetUid === 'leader';

  if (wantLeader) {
    const fresh = a.summonedTurn === s.turn;
    if (fresh && !a.keywords.has('storm')) return { ok: false, why: '突进/进化只能攻击随从，无法打主战者' };
    // 官方【守护】：「只要拥有守护能力的随从在战场上，就无法攻击其他随从或主战者。」
    if (taunts.length) return { ok: false, why: '对方有守护随从，必须先处理' };
    return { ok: true, a, t: null, wantLeader: true, taunts };
  }

  if (a.keywords.has('leaderOnly')) return { ok: false, why: '此随从只能攻击敌方的主战者' };
  const t = F.board.find(u => u.uid === targetUid);
  if (!t) return { ok: false, why: '目标不存在' };
  // 官方：护符「无法进行攻击，也不会被攻击」
  if (t.type !== '随从') return { ok: false, why: '护符不会被攻击' };
  // pierce 无条件无视守护；ignoreWard 只对【标记】过的目标生效（丹恒）
  const canPierce = a.keywords.has('pierce')
    || (a.keywords.has('ignoreWard') && t.slot.marks.has('标记'));
  if (taunts.length && !taunts.includes(t) && !canPierce) return { ok: false, why: '必须先攻击守护随从' };
  return { ok: true, a, t, wantLeader: false, taunts };
}

/** 界面高亮用：这次攻击合法吗（布尔版） */
export function attackAllowed(s, attackerUid, targetUid) {
  return checkAttack(s, attackerUid, targetUid).ok;
}

export function attack(s, attackerUid, targetUid) {
  const me = s.active, E = S.foe(s);
  /* 先跑完全部合法性校验，再动状态；
   * 否则一次被拒绝的攻击会白白消耗攻击次数，并错误触发【攻击时】。 */
  const chk = checkAttack(s, attackerUid, targetUid);
  if (!chk.ok) return chk;
  const { a, t, wantLeader } = chk;

  a.attacksUsed += 1;
  fireTrigger(s, 'onAttack', { source: a, ownerIdx: me, chosen: t });   // 【攻击时】在互相造成伤害前发动

  if (wantLeader) {
    const atk = effAtk(s, a);
    const dealt = dealDamage(s, { __leader: S.opp(me) }, atk, a, { combat: true });
    drain(s, me, a, dealt);
    S.log(s, `${a.name}#${a.uid} 攻击主战者 ${dealt}`);
    fireTrigger(s, 'onAllyAttack', { ownerOnly: me });
    return { ok: true };
  }

  /* 交战伤害是同时发生的，所以两边的攻击力都要在任何伤害结算之前快照下来，
   * 否则先死的一方会因为已离场而算不出自己的动态攻击力。 */
  const bonus = (t.marks.has('老主顾') || t.marks.has('织线')) ? RULES.PATRON_BONUS : 0;
  const myAtk = effAtk(s, a) + bonus;
  // 「无法进行防御」与【缺陷·迟缓】的随从被攻击时不反击
  const hisAtk = (t.keywords.has('noCounter') || t.slot.flaws.has('迟缓')) ? 0 : effAtk(s, t);

  let dealt = dealDamage(s, t, myAtk, a, { combat: true });
  if (a.keywords.has('sweep')) {          // 「攻击时同时攻击敌方全体随从」
    for (const o of S.minionsOf(E).slice()) {
      if (o !== t) dealt += dealDamage(s, o, myAtk, a, { combat: true });
    }
  }
  drain(s, me, a, dealt);
  // 官方【攻击】：攻击对手随从时会受到反击，受到与交战对手攻击力等量的伤害。
  if (hisAtk > 0) dealDamage(s, a, hisAtk, t, { combat: true });
  S.log(s, `${a.name}#${a.uid}(${myAtk}) 交换 ${t.name}#${t.uid}(${hisAtk})`);
  fireTrigger(s, 'onAllyAttack', { ownerOnly: me });
  return { ok: true };
}

/** 【虹吸】官方：「通过攻击造成伤害时，将回复主战者与该伤害等量的生命值。」被屏障挡掉则回复 0。 */
function drain(s, pi, attacker, dealt) {
  if (dealt > 0 && attacker.keywords.has('drain')) healTarget(s, { __leader: pi }, dealt);
}

export function canEvolve(s) {
  const p = S.self(s);
  const need = p.isFirst ? RULES.EP_TURN_FIRST : RULES.EP_TURN_SECOND;
  return p.ep > 0 && !p.evolvedThisTurn && turnOfPlayer(s) >= need;
}

export function evolve(s, uid) {
  if (!canEvolve(s)) return { ok: false, why: '进化点不足或未到可进化回合' };
  const p = S.self(s);
  const u = p.board.find(x => x.uid === uid && x.type === '随从');
  if (!u) return { ok: false, why: '目标不存在' };
  p.ep -= 1;
  p.evolvedThisTurn = true;
  doEvolve(s, s.active, u, false);
  return { ok: true };
}

function doEvolve(s, pi, u, free) {
  if (u.evolved) return;
  u.evolved = true;
  s.players[pi].evolves += 1;
  u.atk += RULES.EVOLVE_ATK;
  u.hp += RULES.EVOLVE_HP;
  u.maxHp += RULES.EVOLVE_HP;
  S.log(s, `${u.name} 进化${free ? '（免费）' : ''} → ${u.atk}/${u.hp}`);
  for (const c of clausesOf(u)) {
    if (c.trigger === 'onEvolve') runActions(s, c.actions, { ownerIdx: pi, source: u });
  }
  fireTrigger(s, 'onAllyEvolve', { ownerOnly: pi });
  checkCtrTriggers(s, pi);
}

export function checkWin(s) {
  for (let i = 0; i < 2; i++) if (s.players[i].hp <= 0) s.winner = S.opp(i);
  return s.winner;
}
