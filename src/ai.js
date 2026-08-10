/* 对手 AI —— 对战页与平衡测试共用同一套。
 *
 * 上一版是「按费用从高到低把手牌打光，然后闷头攻击」。那个 AI 造成两个后果：
 *   1) 单人对战没有对手感，它会自己把血打光
 *   2) 平衡测量失真——快攻卡组一律超模、控制/连锁卡组一律垫底，
 *      因为它不会留随从防守，也不会「先攒资源再一次性引爆」
 * 所以这一版做三件事：先算斩杀 → 出牌用「模拟后评分」而不是拍费用 → 攻击分清换与打脸。
 *
 * 不做搜索树：单回合内的贪心 + 局面评分已经能覆盖绝大多数正确决策，
 * 而全搜索在 1000 局自对弈里跑不动。
 */

import * as S from './state.js';
import * as E from './engine.js';

/* ---------------- 局面评分 ----------------
 * 全部从「视角方 me」出发，越大越好。
 * 权重的取法：主战者血量是胜负本身，所以最重；场面按攻+血算，攻略高于血
 * （攻击力才是推进胜利的部分）；手牌有期权价值；施加在敌方身上的负面状态
 * 也算我方资产，否则 AI 永远不肯先铺【持续伤害】再引爆。 */
/* 主战者血量的效用曲线（凹函数）。20 血时每点约值 1.1 分，3 血时每点约值 3.2 分。 */
const hpVal = h => 30 * Math.log(1 + Math.max(0, h) / 6);

function evaluate(s, me) {
  const you = S.opp(me);
  const P = s.players[me], F = s.players[you];
  if (s.winner === me) return 1e6;
  if (s.winner === you) return -1e6;

  let v = 0;
  /* 血量的边际价值是递减的：20→15 掉那 5 点远不如 8→3 掉的 5 点致命。
   * 原来按 2.2/点 线性计价，于是「自伤换资源」永远是亏的——毁灭要把自己压到 10 血
   * 才能解锁【入魔】，线性口径下那一步等于 -22 分，AI 死也不肯走，
   * 结果地狱变有 22 张卡出场率不到 35%，整套在测量里等于不存在。
   * 反过来，这个口径也让 AI 更愿意补最后几点伤害去结束比赛（对手 3→2 比 20→19 值 3 倍）。 */
  v += (hpVal(P.hp) - hpVal(F.hp)) * 0.9;
  v += P.keywords.has('barrier') ? 3 : 0;

  const side = (p, sign) => {
    for (const u of p.board) {
      if (u.type === '护符') { v += sign * (3 + (u.countdown || 0) * 0.4); continue; }
      let w = E.effAtk(s, u) * 1.5 + u.hp;
      if (u.keywords.has('ward')) w += 3;
      if (u.keywords.has('bane')) w += 2;
      if (u.keywords.has('barrier')) w += 2;
      if (u.keywords.has('storm')) w += 1.5;
      if (u.keywords.has('drain')) w += 1;
      v += sign * w;
    }
  };
  side(P, 1);
  side(F, -1);

  v += P.hand.length * 1.4;
  v += P.ep * 1.5;

  /* 职业资源计数器（欢愉的笑点、智识的解读、同谐的蓄能…）。
   * 一分不给的话，「纯攒资源」的卡在 AI 眼里永远是负收益：
   * 攻击性阅读物、风举云飞的勇烈 的出场率是 0% 和 2%，
   * 于是笑点狂欢 / 解读演算 这类靠计数器兑现的卡组被系统性低估。
   * 估值贴着兑现口径来：天国@直播间 是「笑点/3 点伤害」，1 点笑点≈0.33 点伤害，
   * 打个对折的兑现概率 ≈ 0.35 分。封顶是防某个计数器暴涨后主导整个评分。 */
  for (const n of Object.values(P.counters)) v += Math.min(n, 24) * 0.35;

  /* 【入魔】：血量≤10 才解锁的效果。不给它加分，AI 就只把自伤看成掉血，
   * 而毁灭几乎每张牌都自伤——地狱变有 23 张卡出场率不到 35%，等于整套不打。
   * 只在「已经入魔且手里有能吃到红利的牌」时加分，这样跨过阈值这一步
   * 会在试算里表现为正收益，AI 才会主动去踩。 */
  if (S.isMara(P)) {
    let ready = 0;
    for (const h of P.hand) {
      for (const cl of (h.def.clauses || [])) {
        if (cl.cond && cl.cond.trim() === 'mara') { ready++; break; }
      }
    }
    v += Math.min(ready, 3) * 3.5;
  }

  /* 沉淀在对手主战者身上的【侵蚀】是随时可以引爆的弹药，比随从身上的层数更值：
   * 随从会死、层数会跟着走，脸上的层数不会。不给它权重，AI 就不肯打
   * 「让带层数的随从死掉」这条线，虚无的整个终结路线在测量里等于不存在。 */
  /* 每层的估值贴着「引爆时能兑现的伤害」来：主流引爆倍率是 2，兑现概率约一半，
   * 所以 1 层 ≈ 1 点伤害 ≈ 2.2 分。估低了 AI 会拿 4 层去换 4 点伤害（白亏一半），
   * 峰值层数永远停在 4 上下、攒资源型卡组因此测不出真实强度。 */
  v += F.dots * (2.0 + (F.aura || 0) * 0.6);
  // 敌方身上的负面状态是我方资产（侵蚀层数、标记、弱点、缺陷）
  for (const u of F.board) {
    v += u.dots * (1.1 + (u.aura || 0) * 0.5);
    v += u.shocked ? 1.2 : 0;
    v += u.vuln * 0.8;
    v += u.flaws.size * 0.7;
    v += u.marks.has('标记') ? 0.6 : 0;
  }
  // 牌库见底是输，别为了过牌把自己抽死
  if (P.deck.length <= 4) v -= (5 - P.deck.length) * 6;
  return v;
}

/**
 * 打出这张牌之后，自己主战者大概还剩几点血。用「剩多少」而不是「掉多少」来判断，
 * 是因为 setLeaderHp(1) 这类卡把血设成一个固定正数、永远不会致死，
 * 但按掉血量算的话它总是等于 hp-1，会被「掉血 >= hp-1 就跳过」的护栏永久封禁
 * —— 可可利亚，虚妄之母 的出场率因此是 0%。
 */
function postHp(s, inst) {
  const p = S.self(s);
  let hp = p.hp;
  for (const cl of (inst.def.clauses || [])) {
    if (!['onPlay', 'spell', 'static'].includes(cl.trigger)) continue;
    if (cl.cond && cl.cond.trim() === 'mara' && !S.isMara(p)) continue;   // 没入魔就不会触发
    for (const a of cl.actions) {
      if (a.op === 'dmg' && (a.args[0] === 'selfLeader' || a.args[0] === 'bothLeader')) {
        hp -= parseInt(a.args[1], 10) || 0;
      } else if (a.op === 'halveHp') hp = Math.ceil(hp / 2);
      else if (a.op === 'setLeaderHp') { const t = parseInt(a.args[0], 10) || 0; if (hp > t) hp = t; }
      else if (a.op === 'maxHpDown') hp -= parseInt(a.args[0], 10) || 0;
      else if (a.op === 'heal' && a.args[0] === 'selfLeader') hp += parseInt(a.args[1], 10) || 0;
    }
  }
  return hp;
}

/* ---------------- 攻击计划 ---------------- */

/** 本回合我方全部可用攻击力（用于算斩杀） */
function reach(s, me) {
  let n = 0;
  for (const u of S.minionsOf(s.players[me])) {
    if (!E.canAttack(s, u)) continue;
    const times = (u.maxAttacks + u.extraAttacks) - u.attacksUsed;
    n += E.effAtk(s, u) * Math.max(1, times);
  }
  return n;
}

/** 对手下回合大概能打我多少（用来决定该换场还是该打脸） */
function threat(s, me) {
  const F = s.players[S.opp(me)];
  let n = 0;
  for (const u of S.minionsOf(F)) n += E.effAtk(s, u) * (u.maxAttacks || 1);
  return n;
}

/**
 * 执行本回合的攻击。
 * 有守护必须先处理；能斩杀就全力打脸；否则逐个随从在「换掉谁」与「打脸」之间选收益最大的。
 */
function doAttacks(s, me) {
  const P = s.players[me], you = S.opp(me);
  const lethal = reach(s, me) >= s.players[you].hp && S.tauntTargets(s.players[you]).length === 0;
  const pressured = P.hp <= threat(s, me) + 2;   // 下回合可能被打死，优先清场

  for (const u of S.minionsOf(P).slice()) {
    // 攻击力 0 的随从（护盾墙之类）打过去什么也不会发生，只有【必杀】例外
    if (E.effAtk(s, u) <= 0 && !u.keywords.has('bane')) continue;
    let guard = 0;
    while (E.canAttack(s, u) && guard++ < 8) {
      if (s.winner != null) return;
      const F = s.players[you];
      const taunts = S.tauntTargets(F);
      let target = null;

      if (taunts.length) {
        // 只能打守护：挑一个能打死的，打不死就挑最肉的顶一下
        const killable = taunts.filter(t => E.effAtk(s, u) >= t.hp);
        target = (killable.sort((a, b) => (E.effAtk(s, b) + b.hp) - (E.effAtk(s, a) + a.hp))[0]
          || taunts.sort((a, b) => (E.effAtk(s, b) + b.hp) - (E.effAtk(s, a) + a.hp))[0]).uid;
      } else if (lethal) {
        target = 'leader';
      } else {
        const my = E.effAtk(s, u);
        let best = { uid: 'leader', score: my * (pressured ? 0.7 : 1.25) };
        for (const t of S.minionsOf(F)) {
          if (!E.attackAllowed(s, u.uid, t.uid)) continue;
          const ta = E.effAtk(s, t);
          const kills = my >= t.hp || u.keywords.has('bane');
          const dies = ta >= u.hp && !u.keywords.has('barrier');
          if (!kills && !dies) continue;          // 互相都打不死，不如打脸
          let sc = 0;
          if (kills) sc += ta * 1.5 + t.hp + (t.keywords.has('ward') ? 3 : 0);
          if (dies) sc -= (my * 1.5 + u.hp) * 0.85;
          if (pressured) sc *= 1.5;               // 被逼到墙角时换场更值
          if (sc > best.score) best = { uid: t.uid, score: sc };
        }
        target = best.uid;
      }
      if (!target || !E.attack(s, u.uid, target).ok) break;
    }
  }
}

/* ---------------- 出牌 ---------------- */

/**
 * 反复挑「模拟打出后评分提升最大」的那张牌，直到没有正收益。
 * 这样条件没满足的卡（没有侵蚀层时的引爆、笑点不够时的爆发）自然会被跳过，
 * 不需要为每张卡写专门的判断。
 */
function doPlays(s, me) {
  for (let round = 0; round < 8; round++) {
    const p = S.self(s);
    /* 基准也要把攻击走完，否则「打这张牌的收益」里混进了「本来就能攻击的收益」，
     * 每张牌看起来都是大幅正收益，「没有正收益就停手」这条护栏会失效。 */
    const baseSim = S.cloneForSim(s);
    try { doAttacks(baseSim, me); } catch (e) { /* 同上 */ }
    const base = evaluate(baseSim, me);
    let best = null;

    for (let i = 0; i < p.hand.length; i++) {
      if (!E.canPlay(s, i).ok) continue;
      const inst = p.hand[i];
      if (postHp(s, inst) <= 0) continue;               // 别把自己打死

      for (const opt of targetOptions(s, i, me)) {
        const sim = S.cloneForSim(s);
        let ok = false;
        try { ok = E.playCard(sim, i, remapOpt(sim, opt)).ok; } catch (e) { ok = false; }
        if (!ok) continue;
        /* 试算里把攻击也走完再评分。出牌决策发生在攻击之前，只看「打完这张牌的场面分」
         * 的话，凡是「让随从能多打一次 / 当回合就能打」的牌收益全是 0：
         * 舞！舞！舞！和 夜色流光溢彩 的出场率是 0%，突进/疾驰也被严重低估。
         * doEvolve 本来就是这么做的，这里统一。 */
        try { doAttacks(sim, me); } catch (e) { /* 试算里的异常不该影响真局 */ }
        const gain = evaluate(sim, me) - base;
        if (!best || gain > best.gain) best = { i, gain, opt };
      }
    }

    // 允许极小的负收益（多数随从入场后场面分本来就涨，真正没用的牌会被这条挡掉）
    if (!best || best.gain < -0.5) return;
    if (!E.playCard(s, best.i, best.opt).ok) return;
    if (s.winner != null) return;
  }
}

/**
 * 一张需要指名目标的卡，值得试算的几个目标。
 * 只给「最肉的随从」一个候选是不够的：引爆类卡牌该打的是层数最多的那个，
 * 而【侵蚀】攒在脸上时最该打的是主战者——只试一个目标会让这类卡永远打错地方，
 * 于是它们在平衡测量里看起来是废牌。候选控制在 3 个以内，试算成本才不会失控。
 */
function targetOptions(s, handIndex, me) {
  const p = s.players[s.active];
  const inst = p.hand[handIndex];
  if (!inst) return [{}];
  const need = E.needsTarget(inst.def);
  if (!need) return [{}];
  const byBody = arr => arr.slice().sort((a, b) => (E.effAtk(s, b) + b.hp) - (E.effAtk(s, a) + a.hp));

  if (need === 'allyOne') {
    const arr = byBody(S.minionsOf(p));
    return arr.length ? [{ ally: arr[0] }] : [{}];
  }
  const foes = byBody(S.minionsOf(s.players[S.opp(s.active)]));
  const opts = [];
  if (foes.length) {
    opts.push({ target: foes[0] });
    const dotty = foes.slice().sort((a, b) => b.dots - a.dots)[0];
    if (dotty !== foes[0] && dotty.dots > 0) opts.push({ target: dotty });
  }
  if (need === 'enemyAny') opts.push({ target: { __leader: S.opp(s.active) } });
  return opts.length ? opts : [{}];
}

/** 把「真实局面里的目标」换成试算副本里的同一个单位（按 uid 认人） */
function remapOpt(sim, opt) {
  const out = {};
  for (const k of ['target', 'ally']) {
    const v = opt[k];
    if (!v) continue;
    if (v.__leader != null) { out[k] = { __leader: v.__leader }; continue; }
    for (const q of sim.players) {
      const u = q.board.find(x => x.uid === v.uid);
      if (u) { out[k] = u; break; }
    }
  }
  return out;
}

/* ---------------- 进化 ---------------- */
function doEvolve(s, me) {
  if (!E.canEvolve(s)) return;
  const p = S.self(s);
  const base = evaluate(s, me);
  let best = null;
  for (const u of S.minionsOf(p)) {
    if (u.evolved) continue;
    const sim = S.cloneForSim(s);
    const t = S.minionsOf(sim.players[me]).find(x => x.uid === u.uid);
    if (!t) continue;
    try { if (!E.evolve(sim, t.uid).ok) continue; } catch (e) { continue }
    // 进化后立刻算上它能换掉什么
    doAttacks(sim, me);
    const gain = evaluate(sim, me) - base;
    if (!best || gain > best.gain) best = { uid: u.uid, gain };
  }
  if (best) E.evolve(s, best.uid);
}

/**
 * 走完 AI 的一个回合（不含 startTurn / endTurn，由调用方控制节奏）。
 * 返回分几步执行的闭包数组，界面可以逐步播放让玩家看清；
 * 测试直接全部跑完即可。
 */
export function planTurn(s, me) {
  return [
    () => doPlays(s, me),
    () => doEvolve(s, me),
    () => doAttacks(s, me),
  ];
}

/** 一次性跑完（自对弈用） */
export function takeTurn(s, me) {
  for (const step of planTurn(s, me)) {
    if (s.winner != null) return;
    step();
  }
}
