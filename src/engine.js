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
    marked: chosen && chosen.marks ? chosen.marks.has('标记') : false,
    evolved: source ? source.evolved : false,
    ctr: name => (source && source.counters[name] != null)
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
    if ((trigger === 'onPlay' || trigger === 'onDeath' || trigger === 'onAttack'
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
  if (fm) return S.minionsOf(E).filter(u => u.flaws.size >= parseInt(fm[1], 10));
  switch (spec) {
    case 'self':        return ctx.source ? [ctx.source] : [];
    case 'selfLeader':  return [{ __leader: me }];
    case 'enemyLeader': return [{ __leader: you }];
    case 'bothLeader':  return [{ __leader: me }, { __leader: you }];
    case 'allyAll':     return S.minionsOf(P).slice();
    case 'enemyAll':    return S.minionsOf(E).slice();
    case 'allyOther':   return S.minionsOf(P).filter(u => u !== ctx.source);
    case 'allyOne':     return pickOne(ctx.chosenAlly || S.minionsOf(P).filter(u => u !== ctx.source)[0] || S.minionsOf(P)[0]);
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
    case 'enemyMarked':  return S.minionsOf(E).filter(u => u.marks.has('标记'));
    case 'enemyBroken':  return S.minionsOf(E).filter(u => u.marks.has('破绽'));
    case 'enemyShocked': return S.minionsOf(E).filter(u => u.shocked);
    case 'enemyDotted':  return S.minionsOf(E).filter(u => u.dots > 0);
    /* 「敌方全体的【持续伤害】」——随从加上带【侵蚀】的主战者。
     * 引爆类卡牌用这个目标，才能把沉淀在脸上的层数一起炸掉。 */
    case 'enemyDottedAny': {
      const arr = S.minionsOf(E).filter(u => u.dots > 0);
      if (E.dots > 0) arr.push({ __leader: you });
      return arr;
    }
    case 'enemyFlawed':  return S.minionsOf(E).filter(u => u.flaws.size > 0);
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
        if (P.hand.length >= RULES.HAND_LIMIT) { P.graveyard.push(def); continue; }
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
        c.keywords = new Set(t.keywords); c.marks = new Set(t.marks); c.flaws = new Set(t.flaws);
        c.counters = { ...t.counters };
        c.vuln = t.vuln; c.dots = t.dots; c.aura = t.aura; c.shocked = t.shocked;
        c.atkPlusExpr = t.atkPlusExpr; c.reduceExpr = t.reduceExpr;
        P.board.push(c);
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
      for (let i = 0; i < n; i++) S.drawCard(s, me);
      break;
    }
    case 'drawKind': {  // 从牌库里抽指定类型的卡（法术/随从/护符），抽不到就跳过
      const kind = A[0], n = A[1] ? num(s, A[1], ctx) : 1;
      for (let i = 0; i < n; i++) {
        const at = P.deck.findIndex(d => d.type === kind);
        if (at < 0) break;
        const [def] = P.deck.splice(at, 1);
        if (P.hand.length >= RULES.HAND_LIMIT) { P.graveyard.push(def); continue; }
        P.hand.push(S.makeCardInstance(def));
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
        P.board.push(u);
        // 召唤出的单位同样要生效常驻能力（守护、必杀…）；
        // 但官方【入场曲】「从手牌或牌组直接进入战场，或是生成卡牌进入战场时不会发动」，
        // 所以这里只跑 static，绝不跑 onPlay。
        for (const c of clausesOf(u)) {
          if (c.trigger === 'static') runActions(s, c.actions, { ownerIdx: me, source: u });
        }
        S.log(s, `召唤 ${u.name}`);
        fireTrigger(s, 'onAllySummon', { ownerIdx: me, extra: u });
      }
      break;
    }
    case 'destroy':
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        // 「不会受到消灭与破坏效果影响」只挡效果，致死伤害照样能杀
        if (t.keywords.has('undestroyable')) { S.log(s, `${t.name} 不受消灭/破坏影响`); continue; }
        killUnit(s, t);
      }
      break;
    /* 计数器分两种作用域，靠动作名区分（不再靠硬编码名单猜，那会让 onCtr 永远等不到）：
     *   ctr  = 单位计数器（火种/充能/兴致…），onCtr 阈值触发读的就是这一种
     *   pctr = 玩家的职业计数器（解读/蓄能/笑点），本局累积，用条件 [ctr(笑点)>=5] 判读 */
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
    case 'cleanse':     // 解除负面效果（持续伤害/触电/弱点/缺陷/标记）
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        t.dots = 0; t.aura = 0; t.vuln = 0; t.shocked = false;
        t.flaws.clear();
        for (const k of ['标记', '破绽', '老主顾', '织线']) t.marks.delete(k);
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
    case 'refundPP': P.pp = Math.min(P.pp + num(s, A[0], ctx), P.ppMax + P.ppBonus); break;
    case 'refundEP': P.ep += num(s, A[0], ctx); break;
    case 'ppMaxUp':  P.ppBonus += num(s, A[0], ctx); break;
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
        t.def = def; t.name = def.name; t.type = def.type;
        t.atk = def.atk | 0; t.hp = def.hp | 0; t.maxHp = def.hp | 0;
        t.keywords = new Set(); t.__clauses = null; t.counters = {};
        t.marks = new Set(); t.dots = 0; t.aura = 0; t.flaws = new Set();
        t.evolved = false; t.attacksUsed = 0; t.extraAttacks = 0;
        t.silenced = false;
        t.vuln = 0; t.shocked = false; t.atkPlusExpr = null; t.reduceExpr = null;
        t.summonedTurn = s.turn;
        t.transformedTurn = s.turn;
        t.countdown = def.countdown ?? null;
        for (const c of clausesOf(t)) if (c.trigger === 'static') runActions(s, c.actions, { ownerIdx: me, source: t });
        S.log(s, `${was} 变身为 ${t.name}`);
      }
      break;
    }
    case 'bounce':
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        const i = P.board.indexOf(t);
        if (i >= 0) {
          spillDots(s, t, P);   // 回手也算离场，身上的层数照样沉淀成【侵蚀】
          P.board.splice(i, 1);
          const inst = S.makeCardInstance(t.def);
          inst.costMod = -99;   // 费用变 0
          if (P.hand.length < RULES.HAND_LIMIT) P.hand.push(inst);
        }
      }
      break;
    case 'mark':        // 【标记】受到的伤害 +1，持续到该随从离场
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.marks.add('标记');
      break;
    case 'break':       // 【破绽】受到的伤害 +1，持续到该随从离场（通用，非命途专属）
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.marks.add('破绽');
      break;
    case 'vuln':        // 【弱点】每层使其受到的伤害 +1（标记的可叠加版）
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader == null) t.vuln += (num(s, A[1], ctx) || 1);
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
        t.dots += n; any = true;
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
        if (t.dots <= 0) continue;
        let n = t.dots * mult * (1 + (t.aura || 0) + dotAuraBonus(s, t));
        if (cap > 0) n = Math.min(n, cap);
        t.dots = 0;
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
        P.board.push(u);
        for (const c of clausesOf(u)) {
          if (c.trigger === 'static') runActions(s, c.actions, { ownerIdx: me, source: u });
        }
        S.log(s, `召唤 ${u.name}`);
        fireTrigger(s, 'onAllySummon', { ownerIdx: me, extra: u });
        add = n - 1;
      }
      if (add > 0) {
        S.addUnitCtr(u, '层数', add);
        u.atk += add; u.hp += add; u.maxHp += add;
        S.log(s, `${u.name} 叠至 ${S.unitCtr(u, '层数')} 层（${u.atk}/${u.hp}）`);
      }
      break;
    }
    case 'reanimate': { // 从自己墓场随机召唤 N 张随从卡，攻血视为 2/2
      const n = num(s, A[0], ctx) || 1;
      const pool = P.graveyard.filter(d => d.type === '随从');
      for (let i = 0; i < n && pool.length; i++) {
        if (S.boardFull(P)) { S.log(s, '场地已满，亡者召还失败'); break; }
        const def = pool.splice(Math.floor(s.rng() * pool.length), 1)[0];
        const u = S.makeUnit(def, s.turn);
        u.atk = 2; u.hp = 2; u.maxHp = 2;
        P.board.push(u);
        for (const c of clausesOf(u)) {
          if (c.trigger === 'static') runActions(s, c.actions, { ownerIdx: me, source: u });
        }
        S.log(s, `从墓场召还 ${u.name}（2/2）`);
      }
      break;
    }
    case 'aura':        // 【奥迹】使该目标每层持续伤害的结算值 +1
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader == null) t.aura += (num(s, A[1], ctx) || 1);
      }
      break;
    case 'shock':       // 【触电】自己的回合结束时受固定 2 点
      for (const t of resolveTarget(s, A[0], ctx)) if (t.__leader == null) t.shocked = true;
      break;
    case 'flaw': {      // 【缺陷】迟缓 / 脆弱 / 衰弱；不指定种类则随机三选一
      const KINDS = ['迟缓', '脆弱', '衰弱'];
      for (const t of resolveTarget(s, A[0], ctx)) {
        if (t.__leader != null) continue;
        const k = (!A[1] || A[1] === 'random') ? KINDS[Math.floor(s.rng() * KINDS.length)] : A[1];
        if (!KINDS.includes(k)) { S.log(s, `未知缺陷种类 ${k}`); continue; }
        t.flaws.add(k);
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
    case 'custom': S.log(s, `[custom:${A[0]}] 未实现的特例效果`); break;
    default: S.log(s, `未实现动作 ${a.op}`);
  }
}

/* ---------------- 动态数值 ----------------
 * 卡面里真正出现的动态量只有下面这些，所以求值器故意做得很小：
 *   整数          3
 *   指标          lostHp / sumVuln / tokenCount / ctr(蓄能) …
 *   指标除以常数   lostHp/4   （向下取整，对应卡面的「÷4（向下取整）」）
 * 写了不认识的量会抛错，不会静默算成 0。
 */
export function metricOf(s, name, ctx) {
  const me = ctx.ownerIdx == null ? 0 : ctx.ownerIdx, you = S.opp(me);
  const P = s.players[me], E = s.players[you];
  const c = /^ctr\(([^)]+)\)$/.exec(name);
  if (c) {
    const nm = c[1];
    if (ctx.source && ctx.source.counters[nm] != null) return S.unitCtr(ctx.source, nm);
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
    case 'sumVuln':     return S.minionsOf(E).reduce((a, u) => a + u.vuln, 0);
    case 'flawCount':   return S.minionsOf(E).reduce((a, u) => a + u.flaws.size, 0);
    // 敌方全部【持续伤害】层数：场上随从的 + 已沉淀到敌方主战者身上的【侵蚀】
    case 'dotLayers':   return S.minionsOf(E).reduce((a, u) => a + u.dots, 0) + (E.dots || 0);
    case 'leaderDots':  return E.dots || 0;
    case 'tokenCount':  return P.board.filter(u => u.def && u.def.isToken).length;
    case 'allyCount':   return S.minionsOf(P).length;
    case 'enemyCount':  return S.minionsOf(E).length;
    case 'graveCount':  return P.graveyard.length;
    case 'cardsPlayed': return P.cardsPlayedThisTurn;
    case 'ppMax':       return P.ppMax + P.ppBonus;
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
    case 'markedCount': return S.minionsOf(E).filter(u => u.marks.has('标记')).length;
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
  if (u.flaws.has('衰弱')) n -= 1;
  return Math.max(0, n);
}

/** 受到伤害的加成：【标记】+1、【破绽】+1、【弱点】每层+1、【缺陷·脆弱】+1 */
function dmgTakenBonus(u) {
  return (u.marks.has('标记') ? 1 : 0) + (u.marks.has('破绽') ? 1 : 0)
    + (u.vuln || 0) + (u.flaws.has('脆弱') ? 1 : 0);
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
    if (bane) { target.hp = 0; killUnit(s, target); }
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
  if (target.hp <= 0) killUnit(s, target);
  return Math.max(0, n);
}

function afterLeaderDamage(s, pi, n) {
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

export function killUnit(s, u) {
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
  fireTrigger(s, 'onDeath', { source: u, ownerIdx: pi });   // 【谢幕曲】
  removeUnit(s, u);
  // 「每当敌方随从被消灭」只数随从，护符离场不算
  if (wasMinion) fireTrigger(s, 'onEnemyDeath', { ownerOnly: S.opp(pi) });
}

function removeUnit(s, u) {
  for (const p of s.players) {
    const i = p.board.indexOf(u);
    if (i >= 0) { spillDots(s, u, p); p.board.splice(i, 1); p.graveyard.push(u.def); return; }
  }
}

/* 随从离场时，它身上还没结算完的【持续伤害】沉淀到它主人的主战者身上，成为【侵蚀】。
 * 这是虚无的核心修复：场面来去太快，层数原本随随从一起蒸发，
 * 攒层数的卡组因此永远攒不到能赢的量（引爆卡组自对弈只有 26%）。 */
function spillDots(s, u, p) {
  if (!u || u.type !== '随从' || !(u.dots > 0)) return;
  p.dots += u.dots;
  if ((u.aura || 0) > p.aura) p.aura = u.aura;   // 【奥迹】取较高的一份，不逐个累加
  S.log(s, `${u.name} 的 ${u.dots} 层持续伤害沉淀为侵蚀（共 ${p.dots} 层）`);
  u.dots = 0;
}

/* ---------------- 回合与行动 ---------------- */

export function startTurn(s) {
  if (s.winner != null) return s;
  s.turn += 1;
  const p = S.self(s);
  // 官方：「在自己的回合开始时，能量点最大值＋1且回复至上限。能量点的上限不会大于10。」
  // PP 上限 = 该玩家自己经历的回合数（第1回合1点，每回合+1，最多10）
  p.ppMax = Math.min(turnOfPlayer(s), RULES.PP_MAX);
  p.pp = p.ppMax + p.ppBonus;
  p.tempPP = 0;                        // 清掉上一回合的临时 PP（ppUp）
  p.cardsPlayedThisTurn = 0;
  p.spellsPlayedThisTurn = 0;
  p.evolvedThisTurn = false;
  for (const u of p.board) { u.attacksUsed = 0; u.extraAttacks = 0; }
  S.drawCard(s, s.active);
  if (s.winner != null) return s;      // 牌库耗尽已判负，不再结算后续时机
  fireTrigger(s, 'turnStart', { ownerOnly: s.active });
  tickCountdowns(s, s.active);         // 官方【倒数】：自己的回合开始时 -1，为 0 时被破坏
  return s;
}

/** 当前行动方经历的回合序号（各自独立计数，用于 PP 上限） */
function turnOfPlayer(s) { return Math.ceil(s.turn / 2); }

export function endTurn(s) {
  fireTrigger(s, 'turnEnd', { ownerOnly: s.active });
  settleDots(s, S.opp(s.active));   // 敌方单位在你回合结束时结算持续伤害
  s.active = S.opp(s.active);
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
    if (u.dots > 0) dealDamage(s, u, u.dots * (1 + (u.aura || 0) + dotAuraBonus(s, u)), null);
    if (u.shocked) dealDamage(s, u, RULES.SHOCK_DMG, null);
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
export function handCost(s, inst) {
  let c = inst.def.cost + inst.costMod;
  const clauses = inst.def.clauses || parseEffect(inst.def.effect, inst.def.name);
  for (const cl of clauses) {
    if (cl.trigger !== 'costIf') continue;
    if (!evalCond(cl.cond, condCtx(s, s.active, null, null))) continue;
    c -= parseInt(cl.args[0], 10) || 0;
  }
  return Math.max(0, c);
}

/**
 * 这张卡打出时需要玩家指定目标吗？返回 null 或 'enemyOne' / 'allyOne' / 'enemyAny'。
 * 界面靠它决定「点了牌是直接打出，还是进入选目标状态」。
 * 引擎在没拿到 opts.target 时会自动挑第一个合法目标——那是给自对弈兜底的，
 * 真人对局必须让玩家自己点，否则等于卡效被随机化。
 */
export function needsTarget(def) {
  const clauses = def.clauses || parseEffect(def.effect, def.name);
  for (const c of clauses) {
    if (!['spell', 'onPlay'].includes(c.trigger)) continue;
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
  const cost = handCost(s, inst);
  if (cost > p.pp) return { ok: false, why: `PP 不足（需 ${cost}，有 ${p.pp}）` };
  if (inst.def.type !== '法术' && S.boardFull(p)) return { ok: false, why: '场地已满（上限 5）' };
  // 官方【选择】：「拥有选择能力的法术，只能在可以选择全部指定数量的情况下使用。
  // 拥有选择能力入场曲的随从或护符，在无法选择全部指定数量的情况下也能使用。」
  // 所以只卡法术，随从/护符照常可打。
  if (inst.def.type === '法术') {
    const miss = missingSpellTarget(s, inst.def);
    if (miss) return { ok: false, why: `没有合法目标（需要${miss}）` };
  }
  return { ok: true, cost };
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

export function playCard(s, handIndex, opts = {}) {
  const chk = canPlay(s, handIndex);
  if (!chk.ok) return chk;
  const me = s.active, p = S.self(s);
  const inst = p.hand.splice(handIndex, 1)[0];
  p.pp -= chk.cost;
  p.cardsPlayedThisTurn += 1;
  if (inst.def.type === '法术') p.spellsPlayedThisTurn += 1;
  S.log(s, `打出 ${inst.def.name}（${chk.cost} PP）`);

  const ctx = { ownerIdx: me, chosen: opts.target, chosenAlly: opts.ally };

  if (inst.def.type === '法术') {
    for (const c of parseEffect(inst.def.effect, inst.def.name)) {
      if (c.trigger !== 'spell' && c.trigger !== 'onPlay') continue;
      if (!evalCond(c.cond, condCtx(s, me, null, opts.target))) continue;
      runActions(s, c.actions, ctx);
    }
    p.graveyard.push(inst.def);
  } else {
    const u = S.makeUnit(inst.def, s.turn);
    // 在手牌里拿到的增益要带进场
    if (inst.atkMod) u.atk += inst.atkMod;
    if (inst.hpMod) { u.hp += inst.hpMod; u.maxHp += inst.hpMod; }
    p.board.push(u);
    for (const c of clausesOf(u)) {
      if (c.trigger === 'static') runActions(s, c.actions, { ...ctx, source: u });
    }
    ctx.source = u;
    for (const c of clausesOf(u)) {
      if (c.trigger !== 'onPlay') continue;
      if (!evalCond(c.cond, condCtx(s, me, u, opts.target))) continue;
      runActions(s, c.actions, ctx);
    }
    fireTrigger(s, 'onAllySummon', { ownerIdx: me, extra: u });
    fireTrigger(s, 'onEnemySummon', { ownerOnly: S.opp(me) });
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
    || (a.keywords.has('ignoreWard') && t.marks.has('标记'));
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
    S.log(s, `${a.name} 攻击主战者 ${dealt}`);
    fireTrigger(s, 'onAllyAttack', { ownerOnly: me });
    return { ok: true };
  }

  /* 交战伤害是同时发生的，所以两边的攻击力都要在任何伤害结算之前快照下来，
   * 否则先死的一方会因为已离场而算不出自己的动态攻击力。 */
  const bonus = (t.marks.has('老主顾') || t.marks.has('织线')) ? RULES.PATRON_BONUS : 0;
  const myAtk = effAtk(s, a) + bonus;
  // 「无法进行防御」与【缺陷·迟缓】的随从被攻击时不反击
  const hisAtk = (t.keywords.has('noCounter') || t.flaws.has('迟缓')) ? 0 : effAtk(s, t);

  let dealt = dealDamage(s, t, myAtk, a, { combat: true });
  if (a.keywords.has('sweep')) {          // 「攻击时同时攻击敌方全体随从」
    for (const o of S.minionsOf(E).slice()) {
      if (o !== t) dealt += dealDamage(s, o, myAtk, a, { combat: true });
    }
  }
  drain(s, me, a, dealt);
  // 官方【攻击】：攻击对手随从时会受到反击，受到与交战对手攻击力等量的伤害。
  if (hisAtk > 0) dealDamage(s, a, hisAtk, t, { combat: true });
  S.log(s, `${a.name}(${myAtk}) 交换 ${t.name}(${hisAtk})`);
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
