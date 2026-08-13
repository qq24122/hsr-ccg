/* 效果 DSL —— 单列配置的解析器
 *
 * 一张卡的全部效果写在表格的一个单元格里，语法：
 *
 *   触发[条件]: 动作(参数), 动作(参数) ; 触发2: 动作
 *
 * 例：
 *   static: ward
 *   onPlay: dmg(bothLeader,1)
 *   onAttack: dmg(selfLeader,1), draw(1)
 *   onPlay[!mara]: dmg(selfLeader,2)
 *   onPlay[mara]: dmg(enemyLeader,2)
 *   countdown(4); turnEnd: dmg(bothLeader,1)
 *   onLeaderDamaged: ctr(火种,+1); onCtr(火种,4): ctr(火种,-4), transform(self,卡厄斯兰那)
 *
 * 分号分隔多个 clause；逗号分隔同一 clause 内的多个动作。
 * 解析失败会抛出带原文的错误，避免静默生成一张没效果的卡。
 */

/** @typedef {{trigger:string, args:string[], cond:?string, actions:{op:string,args:string[]}[]}} Clause */

const TRIGGERS = new Set([
  'static',          // 静态关键词 / 光环
  'spell',           // 法术即时结算
  'onPlay',          // 入场曲
  'onDeath',         // 谢幕曲
  'onAttack',        // 攻击时
  'onEvolve',        // 进化时
  'onDamaged',       // 此单位受到伤害后
  'turnStart',       // 自己的回合开始时
  'turnEnd',         // 自己的回合结束时
  'onLeaderDamaged', // 自己的主战者受到伤害
  'onLeaderHeal',    // 自己的主战者回复生命
  'onSpell',         // 每当自己使用法术卡
  'onCard',          // 每当自己使用卡牌
  'onAllySummon',    // 每当随从进入自己的战场
  'onAllyAttack',    // 自己的随从攻击后
  'onEnemySummon',   // 每当敌方随从进入战场
  'onEnemyDeath',    // 每当敌方随从被消灭
  'onEnemyDamaged',  // 每当敌方随从受到伤害
  'onAllyEvolve',    // 每当自己的随从进化
  'onDot',           // 每当敌方场上【持续伤害】层数增加
  'onCtr',           // 计数器达到阈值 onCtr(名称,N)
  'countdown',       // 护符倒数 countdown(N)
  'costIf',          // 手牌费用变动 costIf(N)[条件]：满足条件时此牌费用 -N
]);

const ACTIONS = new Set([
  'dmg', 'heal', 'draw', 'drawKind', 'buff', 'grant', 'summon', 'destroy',
  'stackSummon', // 唯一叠加型衍生物（忆质）：场上没有就召唤，已有就叠层数并按层加攻血
  'detonate',  // 引爆【持续伤害】：detonate(目标, 每层倍率, 上限)，结算后清空层数
               // 目标为主战者时引爆它身上的【侵蚀】——虚无唯一不依赖对手场面的终结手段
  'reanimate', // 从自己墓场随机召唤 N 张随从卡（视为 2/2）
  'ctr',       // 单位计数器（onCtr 阈值读的是这一种）
  'pctr',      // 玩家的职业计数器：解读 / 蓄能 / 笑点
  'setLeaderHp', 'refundPP', 'refundEP', 'ppMaxUp', 'extraAtk', 'transform',
  'bounce', 'evolveFree', 'costDown', 'custom',
  'cleanse',   // 解除负面效果
  'buffHand',  // 强化手牌里的随从卡
  'maxAtk',    // 每回合攻击次数上限（不会在回合开始时清零）
  // 职业机制
  'mark',      // 巡猎【标记】受到的伤害 +1
  'break',     // 通用【破绽】受到的伤害 +1（非命途专属，供毁灭/同谐等命途自洽使用）
  'vuln',      // 智识【弱点】每层受到的伤害 +1
  'dot',       // 虚无【持续伤害N层】；指向主战者时为【侵蚀】（每回合固定 1 点，层数不消耗）
  'aura',      // 虚无【奥迹】放大持续伤害
  'flaw',      // 虚无【缺陷】迟缓/脆弱/衰弱，不给种类则随机
  'shock',     // 智识【触电】回合结束受 2 点
  'medal',     // 同谐【军功】+1/+1
  'title',     // 同谐【爵位】需先有军功，额外 +2/+2 并获得必杀
  'patron',    // 虚无【老主顾】场上唯一
  'weave',     // 记忆【间隙织线】
  'atkPlus',   // 攻击力额外增加（动态值）
  'reduce',    // 受到的伤害减少（动态值）
  'maxHpDown', // 使自己主战者生命上限 -N
  'maxHpUp',
  'halveHp',   // 将自己主战者生命值减半（向上取整）
  'addHand',   // 生成卡牌加入手牌
  'copy',      // 复制场上的随从
]);

/* 动态数值可用的指标（写别的会在结算时抛错）：
 * lostHp 自己主战者已损失生命值 / enemyLostHp 对手已损失 / selfHp 自己当前生命值
 * sumVuln 敌方全体弱点层数总和 / flawCount 敌方全体缺陷总数
 * dotLayers 敌方随从的持续伤害层数 + 敌方主战者的【侵蚀】层数 / leaderDots 只数主战者的侵蚀
 * tokenCount 自己场上衍生物数 / allyCount 自己随从数 / enemyCount 敌方随从数
 * graveCount 自己墓场数 / cardsPlayed 本回合已用卡数 / ppMax 当前PP上限 / ctr(名) 计数器
 * memCount 忆质层数 + 忆灵个数（忆质是唯一叠加的，所以数层数不数个数）
 * markedCount 敌方被标记数 / selfAtk 自身攻击力 / targetAtk 目标攻击力 / myAttacks 本回合已攻击次数
 * tagCount(标签) / enemyTagCount(标签)
 * 支持「指标/常数」向下取整与「指标*常数」，例如 lostHp/4、memCount*2 */

const TARGETS = new Set([
  'self', 'selfLeader', 'enemyLeader', 'bothLeader',
  'allyOne', 'enemyOne', 'allyAll', 'enemyAll', 'allyOther',
  'enemyRandom',      // 随机 1 个敌方随从（空场则无目标）
  'enemyRandomAny',   // 随机 1 个敌方目标（随从与主战者同池）
  'allyRandom',
  'enemyMarked',      // 全部被【标记】的敌方随从
  'enemyBroken',      // 全部被【破绽】的敌方随从
  'enemyShocked',     // 全部【触电】的敌方随从
  'enemyDotted',      // 全部带【持续伤害】的敌方随从
  'enemyDottedAny',   // 同上 + 带【侵蚀】的敌方主战者（引爆类卡牌用它才能炸到脸）
  'enemyFlawed',      // 全部带【缺陷】的敌方随从
  'enemyPatron',      // 【老主顾】
  'enemyHighestHp', 'enemyLowestHp',
  'enemyFlaw',        // enemyFlaw(2)：拥有 2 个以上【缺陷】的敌方随从
  'allyMedal',        // 1 个拥有【军功】但还没升【爵位】的自己随从
  'allyAllMedal',     // 自己全体拥有【军功】的随从
  'allyToken',
  'enemyAmulet',      // 敌方全部护符（史瓦罗的破坏效果）
  'enemyAny',         // 敌方主战者或 1 个敌方随从（玩家指定，未指定则打主战者）
  'dmgSource',        // 造成本次伤害的单位（配合 onDamaged）
  'dmgSourceOrLeader',
  'allyTag',          // allyTag(蛰虫)：自己场上带该标签的全部随从
  'enemyTag',
]);

/* 关键词 —— 只列引擎真正实现了的，写了没实现的会在加载时直接报错，不会静默变成一张废卡。
 * ward    守护  只要它在场，对手无法攻击其他随从或主战者
 * rush    突进  进入战场的回合即可攻击随从
 * storm   疾驰  进入战场的回合即可攻击（含主战者）
 * bane    必杀  交战造成伤害时破坏对方随从；攻击力0或伤害被屏障归零也照样发动
 * barrier 屏障  受到伤害时伤害变为0，发动1次后失效；可挂在随从或主战者身上
 * drain   虹吸  通过攻击造成伤害时，回复自己主战者等量生命值
 * noCounter 无法进行防御  被随从攻击时不造成反击伤害（【缺陷·迟缓】也会赋予）
 * sweep   攻击随从时同时攻击敌方全体随从
 * undestroyable 不受「消灭」与「破坏」效果影响（致死伤害照样能杀）
 * 尚未实现（暂不可用）：潜行、威慑、灵气、启动、爆能强化、结晶、模式、融合、瞬念召唤 */
const KEYWORDS = new Set(['ward', 'rush', 'storm', 'bane', 'barrier', 'drain',
  'noCounter', 'sweep', 'undestroyable',
  'ignoreWard',   // 攻击被【标记】的目标时无视守护
  'leaderOnly',   // 此随从只能攻击敌方的主战者
  'pierce',       // 攻击无视守护（无条件）
  'dotAura']);    // 在场时【持续伤害】每层的结算数值 +1（海瑟音、忘归人）

/**
 * 把 "name(a,b)" 拆成 {name, args}。
 * 参数里允许嵌套括号（buff(allyTag(盾卫),0,1)、atkPlus(self,tagCount(蛰虫))），
 * 所以只能按「顶层逗号」切分，不能用 [^)]* 这种一遇右括号就停的正则。
 */
function parseCall(text) {
  const t = text.trim();
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*([\s\S]*)$/.exec(t);
  if (!m) return null;
  const name = m[1], rest = m[2].trim();
  if (!rest) return { name, args: [] };
  if (rest[0] !== '(' || rest[rest.length - 1] !== ')') return null;

  const args = [];
  let depth = 0, buf = '';
  for (const ch of rest.slice(1, -1)) {
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return null; }
    if (ch === ',' && depth === 0) { args.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (depth !== 0) return null;             // 括号没闭合
  if (buf.trim()) args.push(buf.trim());
  return { name, args: args.filter(a => a.length) };
}

/**
 * 解析一整个 effect 单元格。
 * @param {string} src
 * @param {string} cardName 仅用于报错定位
 * @returns {Clause[]}
 */
export function parseEffect(src, cardName = '?') {
  const out = [];
  if (!src || !src.trim() || src.trim() === '—') return out;

  for (const rawClause of src.split(';')) {
    const clause = rawClause.trim();
    if (!clause) continue;

    // 拆 "触发[条件]: 动作..."
    const ci = clause.indexOf(':');
    let head, body;
    if (ci >= 0) {
      head = clause.slice(0, ci).trim();
      body = clause.slice(ci + 1).trim();
    } else {
      /* 没有冒号时有两种情况：
       *   整段本身就是一个合法触发（countdown(3)、costIf(4)[mara]）→ 视为无动作子句
       *   否则是 static 的简写（"ward" == "static: ward"） */
      const bare = clause.replace(/\[[^\]]*\]\s*$/, '').trim();
      const bc = parseCall(bare);
      if (bc && TRIGGERS.has(bc.name)) { head = clause; body = ''; }
      else { head = 'static'; body = clause; }
    }

    // 抽出 [条件]
    let cond = null;
    const cm = /\[([^\]]*)\]\s*$/.exec(head);
    if (cm) {
      cond = cm[1].trim();
      head = head.slice(0, cm.index).trim();
    }

    const hc = parseCall(head);
    if (!hc || !TRIGGERS.has(hc.name)) {
      throw new Error(`[${cardName}] 未知触发时机 "${head}"，原文: ${clause}`);
    }

    const actions = [];
    // 动作之间用逗号分隔，但要跳过括号内的逗号
    let depth = 0, buf = '';
    const flush = () => { if (buf.trim()) actions.push(buf.trim()); buf = ''; };
    for (const ch of body) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { flush(); continue; }
      buf += ch;
    }
    flush();

    const parsedActions = [];
    for (const a of actions) {
      const pc = parseCall(a);
      if (!pc) throw new Error(`[${cardName}] 无法解析动作 "${a}"`);
      if (KEYWORDS.has(pc.name)) {
        // 关键词简写：ward → grant(self,ward)
        parsedActions.push({ op: 'grant', args: ['self', pc.name] });
        continue;
      }
      if (!ACTIONS.has(pc.name)) {
        throw new Error(`[${cardName}] 未知动作 "${pc.name}"，可用: ${[...ACTIONS].join(',')}`);
      }
      // 目标合法性检查（第一个参数是目标的动作）
      const needTarget = ['dmg', 'heal', 'buff', 'grant', 'destroy', 'extraAtk', 'transform', 'bounce',
        'evolveFree', 'mark', 'break', 'vuln', 'dot', 'aura', 'flaw', 'shock', 'medal', 'title', 'patron', 'weave',
        'atkPlus', 'reduce', 'cleanse', 'maxAtk', 'copy', 'detonate'];
      if (needTarget.includes(pc.name) && pc.args.length) {
        const t = pc.args[0].replace(/\(.*/, '');
        if (!TARGETS.has(t)) {
          throw new Error(`[${cardName}] 动作 ${pc.name} 的目标 "${t}" 不认识，可用: ${[...TARGETS].join(',')}`);
        }
      }
      parsedActions.push({ op: pc.name, args: pc.args });
    }

    out.push({ trigger: hc.name, args: hc.args, cond, actions: parsedActions });
  }
  return out;
}

/**
 * 条件求值。ctx 提供 { mara, ctr(name), marked, cardsPlayed, ... }
 * 支持：mara / !mara / ctr(名)>=N / marked / cardsPlayed>=N / hp<=N
 */
export function evalCond(cond, ctx) {
  if (!cond) return true;
  let neg = false;
  let c = cond.trim();
  if (c.startsWith('!')) { neg = true; c = c.slice(1).trim(); }

  let val;
  const cmp = /^(.+?)\s*(>=|<=|==|>|<)\s*(-?\d+)$/.exec(c);
  if (cmp) {
    const [, lhsRaw, op, nStr] = cmp;
    const n = parseInt(nStr, 10);
    const lhs = readMetric(lhsRaw.trim(), ctx);
    switch (op) {
      case '>=': val = lhs >= n; break;
      case '<=': val = lhs <= n; break;
      case '>':  val = lhs > n;  break;
      case '<':  val = lhs < n;  break;
      default:   val = lhs === n;
    }
  } else {
    val = !!readFlag(c, ctx);
  }
  return neg ? !val : val;
}

function readMetric(expr, ctx) {
  const call = parseCall(expr);
  if (call && call.name === 'ctr') return ctx.ctr(call.args[0]) || 0;
  if (expr === 'hp') return ctx.metric('selfHp') || 0;   // hp<=N 是 selfHp 的惯用写法
  const v = ctx.metric(expr);
  if (v == null) throw new Error(`未知条件量 "${expr}"`);
  return v;
}

function readFlag(name, ctx) {
  switch (name) {
    case 'mara':   return ctx.mara;
    case 'marked': return ctx.marked;
    case 'evolved':return ctx.evolved;
    default: throw new Error(`未知条件 "${name}"`);
  }
}

export const DSL_VOCAB = { TRIGGERS, ACTIONS, TARGETS, KEYWORDS };
