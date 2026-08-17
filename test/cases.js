/* 单元测试：覆盖阶段0的全部核心规则
 * 每个用例都直接构造局面（不依赖随机抽牌），断言失败会记下卡名与期望值。
 */

import { loadCards, buildDeck } from '../src/loader.js';
import { parseEffect } from '../src/dsl.js';
import * as S from '../src/state.js';
import * as E from '../src/engine.js';

const results = [];
let CARDS = null;

function t(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function eq(actual, expect, what = '') {
  if (actual !== expect) throw new Error(`${what} 期望 ${expect}，实际 ${actual}`);
}
function ok(cond, what = '') { if (!cond) throw new Error(what || '断言失败'); }

/* ---- 局面构造辅助 ---- */
function game(deckNames = ['丰饶扑满'], deckNames2 = ['丰饶扑满']) {
  const d0 = deckNames.map(n => CARDS.byName[n]);
  const d1 = deckNames2.map(n => CARDS.byName[n]);
  while (d0.length < 40) d0.push(CARDS.byName['丰饶扑满']);
  while (d1.length < 40) d1.push(CARDS.byName['丰饶扑满']);
  const s = S.createGame(d0, d1, 12345);
  s.__cardIndex = CARDS.byName;
  s.__tokenIndex = CARDS.byName;
  return s;
}
function hand(s, pi, name) {
  const inst = S.makeCardInstance(CARDS.byName[name]);
  s.players[pi].hand.push(inst);
  return s.players[pi].hand.length - 1;
}
/** 直接把一个单位放到场上。默认 summonedTurn 设为很早，即「已在场一回合」可攻击 */
function board(s, pi, name, opts = {}) {
  const u = S.makeUnit(CARDS.byName[name], opts.fresh ? s.turn : -99);
  s.players[pi].board.push(u);
  for (const c of (u.def.clauses || [])) {
    if (c.trigger === 'static') E.runActions(s, c.actions, { ownerIdx: pi, source: u });
  }
  return u;
}
function turnTo(s, n) { while (s.turn < n) { E.startTurn(s); if (s.turn < n) E.endTurn(s); } }

/* ---------------- 用例 ---------------- */
export async function runAll() {
  results.length = 0;
  CARDS = await loadCards('../data/cards.tsv');

  t('卡表加载与 DSL 全部通过校验', () => {
    ok(CARDS.all.length >= 20, `卡表只有 ${CARDS.all.length} 张`);
    for (const c of CARDS.all) ok(Array.isArray(c.clauses), `${c.name} 未解析出 clauses`);
  });

  t('PP：第1回合1点，每回合+1，上限10', () => {
    const s = game();
    E.startTurn(s); eq(s.players[0].pp, 1, 'P0 第1回合 PP');
    E.endTurn(s); E.startTurn(s); eq(s.players[1].pp, 1, 'P1 第1回合 PP');
    E.endTurn(s); E.startTurn(s); eq(s.players[0].pp, 2, 'P0 第2回合 PP');
    turnTo(s, 25); ok(s.players[s.active].pp <= 10, 'PP 不应超过 10');
  });

  t('出牌扣 PP，PP 不足时拒绝', () => {
    const s = game(); E.startTurn(s);
    const i = hand(s, 0, '虚卒·掠夺者');           // 1 费
    eq(E.playCard(s, i).ok, true, '1费卡应可打出');
    eq(s.players[0].pp, 0, '打完 PP 应为 0');
    const j = hand(s, 0, '重子');                  // 2 费
    eq(E.playCard(s, j).ok, false, 'PP 不足应拒绝');
  });

  t('入场曲：虚卒·掠夺者 给双方主战者各1点', () => {
    const s = game(); E.startTurn(s);
    const i = hand(s, 0, '虚卒·掠夺者');
    E.playCard(s, i);
    eq(s.players[0].hp, 19, '自己应受1点');
    eq(s.players[1].hp, 19, '对手应受1点');
  });

  t('场地上限 5：第6个随从无法打出', () => {
    const s = game(); turnTo(s, 11);   // 让 P0 有足够 PP
    for (let k = 0; k < 5; k++) board(s, 0, '存护扑满');
    eq(s.players[0].board.length, 5, '应有5个单位');
    const i = hand(s, 0, '存护扑满');
    const r = E.playCard(s, i);
    eq(r.ok, false, '场地满时应拒绝');
    ok(/场地/.test(r.why), `报错信息应提到场地，实际: ${r.why}`);
  });

  t('场地上限 5：召唤溢出被丢弃而非报错', () => {
    const s = game(); turnTo(s, 11);
    for (let k = 0; k < 4; k++) board(s, 0, '存护扑满');
    const i = hand(s, 0, '丰饶玄鹿');   // 6费，入场召唤2只次蛰虫，但只剩0位（自己占第5位）
    E.playCard(s, i);
    eq(s.players[0].board.length, 5, '场地应恰好5个，多余召唤被丢弃');
  });

  t('守护：对方有守护时不能打主战者', () => {
    const s = game(); turnTo(s, 5);
    const atk = board(s, 0, '毁灭扑满');
    board(s, 1, '存护扑满');           // 守护
    const r = E.attack(s, atk.uid, 'leader');
    eq(r.ok, false, '应被守护拦下');
    ok(/守护|壁垒/.test(r.why), `报错应提到守护，实际: ${r.why}`);
  });

  t('护符：不会被攻击，也不拦住打脸', () => {
    const s = game(); turnTo(s, 5);
    const atk = board(s, 0, '毁灭扑满');
    const am = board(s, 1, '龙骨盾');
    const r = E.attack(s, atk.uid, am.uid);
    eq(r.ok, false, '护符不能被指定为攻击目标');
    eq(atk.attacksUsed, 0, '被拒绝的攻击不应消耗攻击次数');
    eq(E.attack(s, atk.uid, 'leader').ok, true, '护符不是守护，不该拦住打脸');
    eq(s.players[1].hp, 19, '打脸应生效');
    E.dealDamage(s, am, 99, null);
    ok(s.players[1].board.includes(am), '护符也不承受伤害');
  });

  t('入魔条件：血>10 时不触发，≤10 时改为打对手', () => {
    const s = game(); turnTo(s, 9);            // 需要 4+ PP 才能连打两张 2 费
    const i = hand(s, 0, '虚卒·抹消者');
    eq(E.playCard(s, i).ok, true, '第一张应可打出');
    eq(s.players[0].hp, 18, '未入魔应自伤2点');
    s.players[0].hp = 9;                       // 手动压到入魔
    const j = hand(s, 0, '虚卒·抹消者');
    eq(E.playCard(s, j).ok, true, '第二张应可打出（PP 足够）');
    eq(s.players[0].hp, 9, '已入魔不应再自伤');
    eq(s.players[1].hp, 18, '已入魔应改为打对手2点');
  });

  t('setLeaderHp：践踏者把血精确设为10，且不会自杀', () => {
    const s = game(); turnTo(s, 7);
    const i = hand(s, 0, '虚卒·践踏者');
    E.playCard(s, i);
    eq(s.players[0].hp, 10, '应精确设为10');
    ok(s.players[0].hp > 0, '不应自杀');
    const before = s.players[0].hp;
    const j = hand(s, 0, '虚卒·践踏者');
    E.playCard(s, j);
    eq(s.players[0].hp, before, '已入魔时不应再设血');
  });

  t('计数器阈值：刃 攒5层充能后全场4点+回5血', () => {
    const s = game(); turnTo(s, 11);
    const blade = board(s, 0, '刃');
    board(s, 1, '承露天人');                    // 2/5
    s.players[0].hp = 14;
    for (let k = 0; k < 5; k++) E.dealDamage(s, { __leader: 0 }, 1, null);
    eq(S.unitCtr(blade, '充能'), 0, '触发后充能应清零');
    eq(s.players[1].board[0].hp, 1, '敌方随从应受4点（5-4=1）');
    ok(s.players[0].hp >= 14, `应回过血，实际 ${s.players[0].hp}`);
  });

  t('变身：白厄 4层火种 → 卡厄斯兰那 8/8 必杀', () => {
    const s = game(); turnTo(s, 9);
    const bai = board(s, 0, '白厄');
    for (let k = 0; k < 4; k++) E.dealDamage(s, { __leader: 0 }, 1, null);
    eq(bai.name, '卡厄斯兰那', '应已变身');
    eq(bai.atk, 8, '变身后攻击力');
    ok(bai.keywords.has('bane'), '变身后应有必杀');
  });

  t('屏障（随从）：杰帕德完全免疫一次伤害，之后失效', () => {
    const s = game(); turnTo(s, 9);
    const jeep = board(s, 0, '杰帕德');            // 3/6 守护 +【屏障】
    ok(jeep.keywords.has('ward'), '应带守护');
    ok(jeep.keywords.has('barrier'), '应带屏障');
    E.dealDamage(s, jeep, 99, null);
    eq(jeep.hp, 6, '屏障应把 99 点伤害完全归零');
    ok(!jeep.keywords.has('barrier'), '屏障发动1次后应失效');
    E.dealDamage(s, jeep, 4, null);
    eq(jeep.hp, 2, '第二次伤害正常结算');
  });

  t('屏障（主战者）：龙骨盾入场后免疫一次伤害', () => {
    const s = game(); turnTo(s, 5);
    const i = hand(s, 0, '龙骨盾');
    eq(E.playCard(s, i).ok, true, '龙骨盾应可打出');
    ok(s.players[0].keywords.has('barrier'), '主战者应获得屏障');
    E.dealDamage(s, { __leader: 0 }, 7, null);
    eq(s.players[0].hp, 20, '屏障应吸收全部 7 点');
    ok(!s.players[0].keywords.has('barrier'), '屏障应失效');
    E.dealDamage(s, { __leader: 0 }, 3, null);
    eq(s.players[0].hp, 17, '第二次伤害正常结算');
  });

  t('屏障挡不住必杀（官方裁定：伤害变0也照样发动）', () => {
    const s = game(); turnTo(s, 9);
    const kill = board(s, 0, '卡厄斯兰那');        // 8/8 必杀
    const jeep = board(s, 1, '杰帕德');            // 守护 +【屏障】
    E.attack(s, kill.uid, jeep.uid);
    ok(!s.players[1].board.includes(jeep), '必杀应穿透屏障直接破坏');
  });

  t('虹吸：阿兰攻击造成伤害后回复等量生命', () => {
    const s = game(); turnTo(s, 7);
    const alan = board(s, 0, '阿兰');              // 2/3 【虹吸】
    ok(alan.keywords.has('drain'), '应带虹吸');
    s.players[0].hp = 12;
    E.attack(s, alan.uid, 'leader');
    eq(s.players[1].hp, 18, '应打对手 2 点');
    eq(s.players[0].hp, 14, '虹吸应回复自己 2 点');
  });

  t('虹吸：伤害被屏障归零时不回血', () => {
    const s = game(); turnTo(s, 9);
    const alan = board(s, 0, '阿兰');
    const jeep = board(s, 1, '杰帕德');            // 守护 +【屏障】
    s.players[0].hp = 12;
    E.attack(s, alan.uid, jeep.uid);
    eq(s.players[0].hp, 12, '伤害被屏障归零，虹吸不应回血');
    eq(jeep.hp, 6, '杰帕德应毫发无伤');
  });

  t('治疗联动：加拉赫在场时每次回血打对手1点', () => {
    const s = game(); turnTo(s, 7);
    board(s, 0, '加拉赫');
    s.players[0].hp = 15;
    const i = hand(s, 0, '好运饼干');            // 回3血
    E.playCard(s, i);
    eq(s.players[0].hp, 18, '应回3血');
    eq(s.players[1].hp, 19, '加拉赫应打对手1点');
  });

  t('谢幕曲与召唤：幼蛰虫死亡后留下次蛰虫', () => {
    const s = game(); turnTo(s, 5);
    const larva = board(s, 0, '幼蛰虫');
    E.dealDamage(s, larva, 99, null);
    const names = s.players[0].board.map(u => u.name);
    ok(names.includes('次蛰虫'), `应召唤次蛰虫，实际场上: ${names.join(',')}`);
  });

  t('进化：+2/+2 且当回合可攻击随从但不能打脸', () => {
    const s = game(); turnTo(s, 9);            // P0 第5回合，可进化
    const i = hand(s, 0, '存护扑满');
    E.playCard(s, i);
    const u = s.players[0].board[s.players[0].board.length - 1];
    const a0 = u.atk, h0 = u.hp;
    const r = E.evolve(s, u.uid);
    eq(r.ok, true, `应可进化: ${r.why || ''}`);
    eq(u.atk, a0 + 2, '进化后攻击力');
    eq(u.hp, h0 + 2, '进化后生命值');
    eq(E.canAttack(s, u), true, '进化后应可攻击');
    eq(E.attack(s, u.uid, 'leader').ok, false, '进化不赋予疾驰，不能打脸');
  });

  t('新入场随从当回合不能攻击（无突进/疾驰）', () => {
    const s = game(); turnTo(s, 7);
    const i = hand(s, 0, '娜塔莎');
    E.playCard(s, i);
    const u = s.players[0].board[s.players[0].board.length - 1];
    eq(E.canAttack(s, u), false, '当回合不应能攻击');
  });

  t('回合结束治疗：玲可每回合结束回2血', () => {
    const s = game(); turnTo(s, 7);
    board(s, 0, '玲可');
    s.players[0].hp = 15;
    E.endTurn(s);
    eq(s.players[0].hp, 17, '回合结束应回2血');
  });

  t('胜负：主战者血量≤0 判负', () => {
    const s = game(); turnTo(s, 3);
    E.dealDamage(s, { __leader: 1 }, 99, null);
    eq(E.checkWin(s), 0, 'P0 应获胜');
  });

  t('护符倒数：到期后离场', () => {
    const s = game(); turnTo(s, 5);            // s.turn=5 时 active=P0
    const sh = board(s, 0, '龙骨盾');
    sh.countdown = 1;
    // 倒数只在护符拥有者的回合开始时递减，所以要整整过一轮回到 P0
    E.endTurn(s); E.startTurn(s);              // → P1 的回合
    ok(s.players[0].board.includes(sh), 'P1 回合不应影响 P0 的护符倒数');
    E.endTurn(s); E.startTurn(s);              // → 回到 P0，倒数 1→0
    ok(!s.players[0].board.includes(sh), '倒数结束应离场');
  });

  /* ---- 以下为对照官方规则书补充的用例 ---- */

  t('守护：不只挡主战者，也挡对其他随从的攻击', () => {
    const s = game(); turnTo(s, 5);
    const atk = board(s, 0, '毁灭扑满');
    board(s, 1, '存护扑满');                    // 守护
    const soft = board(s, 1, '丰饶扑满');        // 无守护
    const r = E.attack(s, atk.uid, soft.uid);
    eq(r.ok, false, '有守护在场时不能越过它打其他随从');
    eq(atk.attacksUsed, 0, '被拒绝的攻击不应消耗攻击次数');
    eq(E.canAttack(s, atk), true, '被拒绝后本回合仍应能攻击');
    eq(E.attack(s, atk.uid, s.players[1].board[0].uid).ok, true, '改打守护随从应成功');
  });

  t('牌库耗尽：继续抽牌直接判负（不是疲劳伤害）', () => {
    const s = game();
    s.players[0].deck = [];
    const hpBefore = s.players[0].hp;
    E.startTurn(s);
    eq(s.winner, 1, 'P0 牌库耗尽应判 P1 获胜');
    eq(s.players[0].hp, hpBefore, '不应扣血——影之诗没有疲劳机制');
  });

  t('手牌上限 9：溢出的卡进墓场而非凭空消失', () => {
    const s = game();
    while (s.players[0].hand.length < 9) hand(s, 0, '丰饶扑满');
    const graveBefore = s.players[0].graveyard.length;
    const deckBefore = s.players[0].deck.length;
    S.drawCard(s, 0);
    eq(s.players[0].hand.length, 9, '手牌不应超过 9');
    eq(s.players[0].deck.length, deckBefore - 1, '牌确实从牌库抽出了');
    eq(s.players[0].graveyard.length, graveBefore + 1, '溢出的卡应进墓场');
  });

  t('变身：官方规定变身后从下一回合起才能攻击', () => {
    const s = game(); turnTo(s, 9);
    const bai = board(s, 0, '白厄');            // summonedTurn=-99，本已可攻击
    eq(E.canAttack(s, bai), true, '变身前应可攻击');
    for (let k = 0; k < 4; k++) E.dealDamage(s, { __leader: 0 }, 1, null);
    eq(bai.name, '卡厄斯兰那', '应已变身');
    eq(E.canAttack(s, bai), false, '变身当回合不应能攻击');
    E.endTurn(s); E.startTurn(s); E.endTurn(s); E.startTurn(s);   // 回到 P0
    eq(E.canAttack(s, bai), true, '下一个自己的回合应可攻击');
  });

  t('必杀：攻击力为0也能破坏，但法术伤害不触发', () => {
    const s = game(); turnTo(s, 9);
    const kill = board(s, 0, '卡厄斯兰那');
    kill.atk = 0;                               // 官方：即使攻击力为0，必杀依然发动
    const victim = board(s, 1, '承露天人');      // 2/5
    E.attack(s, kill.uid, victim.uid);
    ok(!s.players[1].board.includes(victim), '0攻的必杀随从交战后应破坏对手随从');
    eq(kill.hp, 8 - 2, '同时应承受反击伤害');

    const v2 = board(s, 1, '承露天人');
    E.dealDamage(s, v2, 1, kill);                // 非交战伤害，不带 combat 标记
    ok(s.players[1].board.includes(v2), '必杀不应作用于非交战伤害');
    eq(v2.hp, 4, '只该正常掉 1 点血');
  });

  t('召唤：生效常驻能力，但不触发入场曲', () => {
    const s = game(); turnTo(s, 5);
    // 临时注册一个同时带 static 与 onPlay 的测试衍生物
    s.__tokenIndex = Object.assign({}, CARDS.byName, {
      测试盾卫: {
        id: 'X001', name: '测试盾卫', class: '存护丰饶', type: '随从', quality: '衍生',
        cost: 0, atk: 1, hp: 1, countdown: null, isToken: true,
        effect: 'static: ward; onPlay: dmg(selfLeader,5)',
      },
    });
    const src = board(s, 0, '幼蛰虫');
    E.runActions(s, [{ op: 'summon', args: ['测试盾卫', '1'] }], { ownerIdx: 0, source: src });
    const u = s.players[0].board.find(x => x.name === '测试盾卫');
    ok(u, '应召唤出测试盾卫');
    ok(u.keywords.has('ward'), '召唤出的单位应获得常驻的守护');
    eq(s.players[0].hp, 20, '召唤不应触发入场曲（否则会自伤5点）');
  });

  t('选择：指向性法术在对方空场时无法使用', () => {
    const s = game(); turnTo(s, 5);
    const i = hand(s, 0, '炎之爪牙');            // dmg(enemyOne,3)
    const r = E.canPlay(s, i);
    eq(r.ok, false, '对方无随从时不应能使用');
    ok(/目标/.test(r.why), `报错应提到目标，实际: ${r.why}`);
    eq(s.players[0].hp, 20, '被拒绝时不应结算自伤部分');
    board(s, 1, '丰饶扑满');
    eq(E.canPlay(s, i).ok, true, '对方有随从后应可使用');
  });

  t('选择：随从的入场曲在目标不足时仍可打出', () => {
    const s = game(); turnTo(s, 5);
    const i = hand(s, 0, '重子');                // 有 onPlay，但不指向敌方随从
    eq(E.canPlay(s, i).ok, true, '随从不受法术的选择限制');
  });

  /* ---- 8 职业机制（为 355 张卡扩展的部分）---- */
  const act = (s, pi, ...ops) => E.runActions(s, ops, { ownerIdx: pi });

  t('标记：被标记的随从受到的伤害+1', () => {
    const s = game(); turnTo(s, 5);
    const v = board(s, 1, '承露天人');            // 2/5
    act(s, 0, { op: 'mark', args: ['enemyOne'] });
    ok(v.marks.has('标记'), '应被标记');
    E.dealDamage(s, v, 2, null);
    eq(v.hp, 2, '2点应变成3点（5-3=2）');
  });

  t('弱点：可叠加，每层使受到的伤害+1', () => {
    const s = game(); turnTo(s, 5);
    const v = board(s, 1, '承露天人');            // 2/5
    act(s, 0, { op: 'vuln', args: ['enemyOne', '2'] });
    eq(v.vuln, 2, '应有2层弱点');
    E.dealDamage(s, v, 1, null);
    eq(v.hp, 2, '1点应变成3点');
  });

  t('缺陷：脆弱使受伤+1，衰弱使攻击力-1', () => {
    const s = game(); turnTo(s, 5);
    const v = board(s, 1, '承露天人');            // 2/5
    act(s, 0, { op: 'flaw', args: ['enemyOne', '脆弱'] });
    E.dealDamage(s, v, 1, null);
    eq(v.hp, 3, '脆弱应使伤害+1');
    const w = board(s, 1, '丰饶扑满');             // 1/2
    act(s, 0, { op: 'flaw', args: ['enemyLowestHp', '衰弱'] });
    ok(w.flaws.has('衰弱'), '生命值最低者应获得衰弱');
    eq(E.effAtk(s, w), 0, '1攻减1应为0且不小于0');
  });

  t('缺陷·迟缓 / 无法进行防御：被攻击时不反击', () => {
    const s = game(); turnTo(s, 5);
    const atk = board(s, 0, '毁灭扑满');           // 1/1
    const def = board(s, 1, '承露天人');           // 2/5
    act(s, 0, { op: 'flaw', args: ['enemyOne', '迟缓'] });
    E.attack(s, atk.uid, def.uid);
    ok(s.players[0].board.includes(atk), '迟缓目标不反击，攻击者应存活');
    eq(atk.hp, 1, '攻击者不该掉血');
    eq(def.hp, 4, '目标应正常受伤');
  });

  t('触电：施加方回合结束时该随从受2点', () => {
    const s = game(); turnTo(s, 5);               // active = P0
    const v = board(s, 1, '承露天人');            // 2/5
    act(s, 0, { op: 'shock', args: ['enemyOne'] });
    ok(v.shocked, '应触电');
    E.endTurn(s);
    eq(v.hp, 3, '应受2点');
  });

  t('持续伤害与奥迹：奥迹使每层结算值+1', () => {
    const s = game(); turnTo(s, 5);
    const v = board(s, 1, '承露天人');            // 2/5
    act(s, 0, { op: 'dot', args: ['enemyOne', '2'] }, { op: 'aura', args: ['enemyOne', '1'] });
    eq(v.dots, 2, '2层持续伤害');
    eq(v.aura, 1, '1层奥迹');
    E.endTurn(s);
    eq(v.hp, 1, '2层×(1+1) = 4点，5-4=1');
  });

  t('军功与爵位：没有军功不能升爵位', () => {
    const s = game(); turnTo(s, 5);
    const u = board(s, 0, '承露天人');            // 2/5
    act(s, 0, { op: 'title', args: ['allyOne'] });
    ok(!u.marks.has('爵位'), '无军功时不该升爵位');
    eq(u.atk, 2, '不该加攻');
    act(s, 0, { op: 'medal', args: ['allyOne'] });
    eq(u.atk, 3, '军功 +1/+1');
    eq(u.hp, 6, '军功也加血上限');
    act(s, 0, { op: 'title', args: ['allyMedal'] });
    ok(u.marks.has('爵位'), '有军功后应可升爵位');
    eq(u.atk, 5, '爵位额外 +2/+2');
    ok(u.keywords.has('bane'), '爵位应获得必杀');
  });

  t('老主顾：场上唯一，己方攻击它时攻击力+2', () => {
    const s = game(); turnTo(s, 7);
    const atk = board(s, 0, '毁灭扑满');           // 1/1
    const a1 = board(s, 1, '娜塔莎');              // 2/4，无守护
    const a2 = board(s, 1, '丰饶扑满');            // 1/2
    act(s, 0, { op: 'patron', args: ['enemyHighestHp'] });
    ok(a1.marks.has('老主顾'), '生命值最高者应成为老主顾');
    act(s, 0, { op: 'patron', args: ['enemyLowestHp'] });
    ok(!a1.marks.has('老主顾'), '老主顾场上唯一，旧的应被清掉');
    ok(a2.marks.has('老主顾'), '新的应成为老主顾');
    E.attack(s, atk.uid, a2.uid);                 // 1攻 +2 = 3 点
    ok(!s.players[1].board.includes(a2), '3点应打死 1/2');
  });

  t('动态数值：lostHp/4 减伤、lostHp/2 加攻', () => {
    const s = game(); turnTo(s, 5);
    const u = board(s, 0, '承露天人');            // 2/5
    act(s, 0, { op: 'reduce', args: ['allyOne', 'lostHp/4'] },
               { op: 'atkPlus', args: ['allyOne', 'lostHp/2'] });
    s.players[0].hp = 12;                         // 已损失 8
    eq(E.effAtk(s, u), 6, '攻击力应 2 + 8/2 = 6');
    E.dealDamage(s, u, 5, null);
    eq(u.hp, 2, '伤害应减 8/4=2，实际吃 3 点');
  });

  t('横扫：攻击随从时同时攻击敌方全体随从', () => {
    const s = game(); turnTo(s, 9);
    const atk = board(s, 0, '刃');                // 4/5
    atk.keywords.add('sweep');
    const a1 = board(s, 1, '丰饶扑满');            // 1/2
    board(s, 1, '幼蛰虫');                        // 2/1
    E.attack(s, atk.uid, a1.uid);
    ok(!s.players[1].board.includes(a1), '主目标应被打死');
    ok(!s.players[1].board.some(u => u.name === '幼蛰虫'), '旁边的也应被横扫打死');
  });

  t('时序：伤害加成先算，屏障再把结果整个归零', () => {
    const s = game(); turnTo(s, 9);
    const jeep = board(s, 1, '杰帕德');            // 守护 +【屏障】
    act(s, 0, { op: 'mark', args: ['enemyOne'] });
    E.dealDamage(s, jeep, 3, null);
    eq(jeep.hp, 6, '加成后的 4 点也应被屏障全部归零');
    ok(!jeep.keywords.has('barrier'), '屏障已消耗');
  });

  t('DSL：新机制词汇全部可解析', () => {
    const src = 'static: noCounter, sweep; '
      + 'onPlay: mark(enemyOne), vuln(enemyAll,2), dot(enemyOne,3), aura(enemyOne,1), '
      + 'shock(enemyShocked), flaw(enemyRandom), medal(allyAll), title(allyAllMedal), '
      + 'patron(enemyHighestHp), weave(enemyOne), atkPlus(self,sumVuln), '
      + 'reduce(self,lostHp/4), ppMaxUp(1), costDown(1)';
    const cl = parseEffect(src, '测试卡');
    eq(cl.length, 2, `应解析出 2 个 clause，实际 ${cl.length}`);
    eq(cl[1].actions.length, 14, `第二个 clause 应有 14 个动作，实际 ${cl[1].actions.length}`);
  });

  t('忆质：唯一叠加，不占多个场地位', () => {
    const s = game(); turnTo(s, 9);
    // 借用测试卡表里的次蛰虫当被叠加的衍生物（cards.tsv 里没有忆质）
    s.__tokenIndex = CARDS.byName;
    const src = board(s, 0, '幼蛰虫');
    const before = s.players[0].board.length;
    for (let k = 0; k < 4; k++) {
      E.runActions(s, [{ op: 'stackSummon', args: ['次蛰虫', '1'] }], { ownerIdx: 0, source: src });
    }
    const all = s.players[0].board.filter(u => u.name === '次蛰虫');
    eq(all.length, 1, '叠加 4 次也只应有 1 个');
    eq(s.players[0].board.length, before + 1, '只多占 1 个场地位');
    eq(S.unitCtr(all[0], '层数'), 4, '层数应为 4');
    eq(all[0].atk, 1 + 3, '攻击力 = 基础1 + 叠3层');
    eq(all[0].hp, 1 + 3, '生命值同步叠加');
  });

  t('忆质：叠加不会洗掉已受的伤害', () => {
    const s = game(); turnTo(s, 9);
    s.__tokenIndex = CARDS.byName;
    const src = board(s, 0, '幼蛰虫');
    E.runActions(s, [{ op: 'stackSummon', args: ['次蛰虫', '3'] }], { ownerIdx: 0, source: src });
    const u = s.players[0].board.find(x => x.name === '次蛰虫');
    eq(u.hp, 3, '3 层应是 3/3');
    E.dealDamage(s, u, 2, null);
    eq(u.hp, 1, '挨了 2 点');
    E.runActions(s, [{ op: 'stackSummon', args: ['次蛰虫', '1'] }], { ownerIdx: 0, source: src });
    eq(u.hp, 2, '再叠 1 层是 1+1=2，而不是回满到 4');
    eq(u.atk, 4, '攻击力照常叠到 4');
  });

  t('侵蚀：带持续伤害的随从离场，层数沉淀到它主人的主战者身上', () => {
    const s = game(); turnTo(s, 9);
    const v = board(s, 1, '幼蛰虫');            // 敌方随从
    E.runActions(s, [{ op: 'dot', args: ['enemyOne', '3'] }], { ownerIdx: 0, source: null });
    eq(v.dots, 3, '随从身上 3 层');
    eq(s.players[1].dots, 0, '还没离场，脸上是 0');
    E.killUnit(s, v);
    eq(s.players[1].dots, 3, '离场后 3 层沉淀成【侵蚀】');
  });

  t('侵蚀：每回合伤害随层数成长、层数不消耗，引爆按层数一次性结算', () => {
    // 1+floor(层数/5)，上限 3：1~4层→1点、5~9层→2点、10层以上→3点
    for (const [layers, expect] of [[1,1],[4,1],[5,2],[9,2],[10,3],[30,3]]) {
      const s = game(); turnTo(s, 9);
      s.players[1].dots = layers;
      const hp0 = s.players[1].hp;
      s.active = 0; E.endTurn(s);                // 施加方回合结束时结算
      eq(hp0 - s.players[1].hp, expect, `${layers} 层应造成 ${expect} 点`);
      eq(s.players[1].dots, layers, '层数不消耗');
    }
    const s = game(); turnTo(s, 9);
    s.players[1].dots = 5;
    const hp0 = s.players[1].hp;
    E.runActions(s, [{ op: 'detonate', args: ['enemyLeader'] }], { ownerIdx: 0, source: null });
    eq(hp0 - s.players[1].hp, 5, '引爆按层数一次性打 5 点');
    eq(s.players[1].dots, 0, '引爆后清空');
  });

  t('侵蚀：引爆可以带倍率与上限，dotLayers 把脸上的层数算进去', () => {
    const s = game(); turnTo(s, 9);
    s.players[1].dots = 4;
    eq(E.metricOf(s, 'dotLayers', { ownerIdx: 0 }), 4, 'dotLayers 含主战者的侵蚀');
    const hp0 = s.players[1].hp;
    E.runActions(s, [{ op: 'detonate', args: ['enemyLeader', '3', '9'] }], { ownerIdx: 0, source: null });
    eq(s.players[1].hp, hp0 - 9, '4×3=12 被上限 9 截断');
  });

  t('持续伤害：dotAura 只在场时生效，不再重复计算成 3 倍', () => {
    const s = game(); turnTo(s, 9);
    board(s, 0, '三月七').keywords.add('dotAura');   // 海瑟音/忘归人的在场光环
    const v = board(s, 1, '幼蛰虫'); v.hp = 9; v.maxHp = 9;
    E.runActions(s, [{ op: 'dot', args: ['enemyOne', '1'] }], { ownerIdx: 0, source: null });
    eq(v.aura, 0, 'dotAura 不该把加成刻进随从身上');
    s.active = 0; E.endTurn(s);
    eq(v.hp, 7, '1 层 ×（1+海瑟音1）= 2 点，不是 3 点');
  });

  t('谢幕曲互杀不会无限递归（同一个单位只能死一次）', () => {
    const s = game(); turnTo(s, 9);
    /* 双方各放一个「谢幕曲：给敌方全体随从 5 点」的随从。
     * A 死 → 打死 B → B 的谢幕曲又打到还没被移除的 A → 以前会无限递归卡死整局。 */
    // 注意：引擎是从 def.effect 现解析的（clausesOf），预设 clauses 不起作用
    const mk = name => ({ id: 'X', name, class: '测试', type: '随从', quality: '铜',
      cost: 1, atk: 1, hp: 1, effect: 'onDeath: dmg(enemyAll,5)' });
    const a = S.makeUnit(mk('回响甲'), -99); s.players[0].board.push(a);
    const b = S.makeUnit(mk('回响乙'), -99); s.players[1].board.push(b);
    let threw = null;
    try { E.dealDamage(s, a, 5, null); } catch (e) { threw = e.message; }
    eq(threw, null, '不该抛异常（以前是 Maximum call stack size exceeded）');
    eq(s.players[0].board.length, 0, 'A 已离场');
    ok(b.hp <= 0, `B 应被 A 的谢幕曲打死，实际 hp=${b.hp}`);
    eq(s.players[1].board.map(x => `${x.name}(${x.hp})`).join(','), '',
      'B 也应离场');
  });

  t('DSL：写尚未实现的关键词会报错而不是静默失效', () => {
    let threw = false;
    try { parseEffect('static: ambush', '测试卡'); } catch (e) { threw = true; }
    ok(threw, '潜行尚未实现，解析时就该报错');
  });

  t('onAllySummon 只对自己一方生效（对面召唤不触发我方）', () => {
    const s = game(); turnTo(s, 9);
    s.__tokenIndex = CARDS.byName;
    /* 我方放一张「onAllySummon: buff(self,1,0)」的随从（金血忆灵·雉形的效果）。
     * 对面召唤随从时，我方这张不该 +1/+0——onAllySummon 是「自己的随从进入自己的战场」。 */
    const mk = name => ({ id: 'X', name, class: '测试', type: '随从', quality: '铜',
      cost: 1, atk: 1, hp: 1, effect: 'onAllySummon: buff(self,1,0)' });
    const mine = S.makeUnit(mk('守望者'), -99); s.players[0].board.push(mine);
    const atk0 = mine.atk;
    // 对面（player 1）召唤随从：走真实 summon 动作，我方 onAllySummon 不该触发
    s.active = 1;
    E.runActions(s, [{ op: 'summon', args: ['幼蛰虫', '1'] }], { ownerIdx: 1, source: null });
    eq(mine.atk, atk0, '对面召唤时，我方 onAllySummon 不该触发');
    // 我方（player 0）召唤时：应触发 +1/+0
    const before = mine.atk;
    s.active = 0;
    E.runActions(s, [{ op: 'summon', args: ['幼蛰虫', '1'] }], { ownerIdx: 0, source: null });
    eq(mine.atk, before + 1, '我方召唤时，onAllySummon 触发 +1/+0');
  });

  return results;
}
