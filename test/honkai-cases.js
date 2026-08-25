/* 崩坏职业规则与卡表专项测试入口。只构造新职业的核心机制，不依赖三套预设名称。 */
import { loadCards, PRESET_IDS } from '../src/loader.js?v=roles-2';
import * as S from '../src/state.js';
import * as E from '../src/engine.js';
import * as AI from '../src/ai.js?v=honkai-ai-2';

const out = [];
function t(name, fn) { try { fn(); out.push({ name, ok: true }); } catch (e) { out.push({ name, ok: false, err: e.message }); } }
function ok(v, m) { if (!v) throw new Error(m || '断言失败'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ''} 期望 ${b}，实际 ${a}`); }
function mk(name, extra = {}) { return { id: name, name, class: '崩坏', type: '随从', cost: 1, atk: 2, hp: 2, formTier: 1, characterId: 'test', ...extra }; }
function setup() {
  const d0 = Array.from({ length: 40 }, () => mk('base'));
  const d1 = Array.from({ length: 40 }, () => mk('enemy', { characterId: 'other' }));
  const s = S.createGame(d0, d1, 9); s.__cardIndex = {};
  for (const d of [mk('base'), mk('mid', { formTier: 2, cost: 3, atk: 4, hp: 4, replaceCost: 1, crossTierCost: 3 }), mk('high', { formTier: 3, cost: 6, atk: 7, hp: 7, replaceCost: 2, crossTierCost: 3 }), mk('other', { characterId: 'other' })]) s.__cardIndex[d.name] = d;
  return s;
}
function addHand(s, pi, def) { s.players[pi].hand.push(S.makeCardInstance(def)); return s.players[pi].hand.length - 1; }

export async function runHonkai() {
  out.length = 0;
  let cards;
  try { cards = await loadCards('cards-honkai.tsv'); } catch (e) { out.push({ name: '崩坏卡表可加载', ok: false, err: e.message }); return out; }
  t('崩坏卡表素材类型边界', () => {
    const vals = cards.all.filter(c => !c.isToken);
    ok(vals.filter(c => c.type === '随从').every(c => c.sourceType === '女武神'), '随从必须来自女武神');
    ok(vals.filter(c => c.type === '法术').every(c => c.sourceType === '圣痕'), '法术必须来自圣痕');
    ok(vals.filter(c => c.type === '护符').every(c => ['人偶', '协同者'].includes(c.sourceType)), '护符必须来自人偶或协同者');
  });
  t('同角色唯一与相邻替换费用', () => {
    const s = setup(); const base = s.__cardIndex.base, mid = s.__cardIndex.mid; E.placeUnit(s.players[0], S.makeUnit(base, -99));
    let i = addHand(s, 0, base); s.players[0].pp = 10; s.active = 0;
    eq(E.canPlay(s, i).ok, false, '已有同角色时不能再打出相同或更低形态');
    s.players[0].hand.splice(i, 1);
    i = addHand(s, 0, mid); s.players[0].pp = 1;
    eq(E.formPlayPlan(s, s.players[0].hand[i]).mode, 'replace', '应进入相邻替换');
    eq(E.canPlay(s, i).cost, 1, '应使用替换费用'); E.playCard(s, i);
    eq(s.players[0].board[0].name, 'mid', '应替换原格'); eq(s.players[0].board[0].lowerForms.length, 1, '应保存真实下层');
  });
  t('2→3相邻替换与1→3跨阶替换分别使用正确费用', () => {
    const adjacent = setup();
    E.placeUnit(adjacent.players[0], S.makeUnit(adjacent.__cardIndex.mid, -99));
    let i = addHand(adjacent, 0, adjacent.__cardIndex.high); adjacent.players[0].pp = 2;
    eq(E.formPlayPlan(adjacent, adjacent.players[0].hand[i]).mode, 'replace', '2→3应为相邻替换');
    eq(E.canPlay(adjacent, i).cost, 2, '2→3应使用replaceCost');
    E.playCard(adjacent, i); eq(adjacent.players[0].board[0].name, 'high', '2→3应替换成功');

    const cross = setup();
    E.placeUnit(cross.players[0], S.makeUnit(cross.__cardIndex.base, -99));
    i = addHand(cross, 0, cross.__cardIndex.high); cross.players[0].pp = 3;
    eq(E.formPlayPlan(cross, cross.players[0].hand[i]).mode, 'cross-replace', '1→3应为跨阶替换');
    eq(E.canPlay(cross, i).cost, 3, '1→3应使用crossTierCost');
    E.playCard(cross, i); eq(cross.players[0].board[0].lowerForms.length, 1, '跨阶只保存真实1阶，不虚构2阶');
  });
  t('换装保留行动历史，但重置伤害、增益、进化与关键词', () => {
    const s = setup(), u = S.makeUnit(s.__cardIndex.base, -99); E.placeUnit(s.players[0], u);
    u.summonedTurn = -7; u.attacksUsed = 1; u.atk = 9; u.hp = 1; u.maxHp = 9;
    u.evolved = true; u.keywords.add('storm'); u.counters.keep = 4; u.marks.add('buff');
    const i = addHand(s, 0, s.__cardIndex.mid); s.players[0].pp = 1; E.playCard(s, i);
    const next = s.players[0].board[0];
    eq(next.uid, u.uid, '换装应沿用同一场上实体uid'); eq(next.summonedTurn, -7, '应保留登场回合');
    eq(next.attacksUsed, 1, '应保留已攻击次数'); eq(next.atk, 4, '攻击应重置为新形态基础值');
    eq(next.hp, 4, '生命应以新形态满血登场'); eq(next.maxHp, 4, '生命上限应重置');
    eq(next.evolved, false, '进化不应继承'); eq(next.keywords.size, 0, '临时关键词不应继承');
    eq(Object.keys(next.counters).length, 0, '单位计数器不应继承'); eq(next.marks.size, 0, '单位正面标记不应继承');
  });
  t('换装不触发旧形态谢幕曲', () => {
    const s = setup();
    const base = mk('lastWordsBase', { effect: 'onDeath: dmg(selfLeader,5)', clauses: [{ trigger: 'onDeath', args: [], cond: null, actions: [{ op: 'dmg', args: ['selfLeader', '5'] }] }] });
    s.__cardIndex.lastWordsBase = base; E.placeUnit(s.players[0], S.makeUnit(base, -99));
    const i = addHand(s, 0, s.__cardIndex.mid); s.players[0].pp = 1;
    const hp = s.players[0].hp; E.playCard(s, i); eq(s.players[0].hp, hp, '替换旧形态不应结算谢幕曲');
  });
  t('被击破时仍结算当前形态谢幕曲', () => {
    const s = setup();
    const base = mk('retreatLastWords', { effect: 'onDeath: dmg(selfLeader,5)', clauses: [{ trigger: 'onDeath', args: [], cond: null, actions: [{ op: 'dmg', args: ['selfLeader', '5'] }] }] });
    s.__cardIndex.retreatLastWords = base; E.placeUnit(s.players[0], S.makeUnit(base, -99));
    const hp = s.players[0].hp; E.dealDamage(s, s.players[0].board[0], 99, null);
    eq(s.players[0].hp, hp - 5, '敌方击破形态时应结算谢幕曲'); ok(s.players[0].slots[0].echo, '结算谢幕曲后仍应留下残影');
  });
  t('场满仍可替换', () => {
    const s = setup(); const base = s.__cardIndex.base, mid = s.__cardIndex.mid;
    E.placeUnit(s.players[0], S.makeUnit(base, -99));
    for (let i = 1; i < 5; i++) E.placeUnit(s.players[0], S.makeUnit(mk('x'+i, { characterId: 'x'+i }), -99));
    const slot = s.players[0].board.find(u => u.characterId === 'test').slot.idx;
    const i = addHand(s, 0, mid); s.players[0].pp = 1; eq(E.canPlay(s, i).ok, true, '满场仍可换装');
    E.playCard(s, i); eq(s.players[0].board.length, 5, '换装不应增加场上单位数');
    eq(s.players[0].board.find(u => u.characterId === 'test').slot.idx, slot, '换装应留在原格');
    const high = addHand(s, 0, s.__cardIndex.high); s.players[0].pp = 3;
    eq(E.canPlay(s, high).ok, true, '满场仍应允许1→3跨阶换装');
  });
  t('击破后按真实堆栈逐级退阶并回复满血', () => {
    const s = setup();
    E.placeUnit(s.players[0], S.makeUnit(s.__cardIndex.base, -99));
    let i = addHand(s, 0, s.__cardIndex.mid); s.players[0].pp = 1; E.playCard(s, i);
    i = addHand(s, 0, s.__cardIndex.high); s.players[0].pp = 2; E.playCard(s, i);
    eq(s.players[0].board[0].lowerForms.length, 2, '3阶下方应存有真实1阶和2阶');
    E.dealDamage(s, s.players[0].board[0], 99, null);
    eq(s.players[0].board[0].name, 'mid', '第一次击破应退回2阶');
    eq(s.players[0].board[0].hp, 4, '复归2阶应回复满血');
    eq(s.players[0].board[0].lowerForms.length, 1, '退阶后应保留剩余真实1阶');
    E.dealDamage(s, s.players[0].board[0], 99, null);
    eq(s.players[0].board[0].name, 'base', '第二次击破应退回1阶');
    eq(s.players[0].board[0].hp, 2, '复归1阶应回复满血');
  });
  t('无下层时生成中文残影并可在原格再部署', () => {
    const s = setup(); const base = { ...s.__cardIndex.base, tag: '测试角色' }; s.__cardIndex.base = base;
    const u = S.makeUnit(base, -99); E.placeUnit(s.players[0], u); const slot = u.slot.idx; E.dealDamage(s, u, 99, null);
    ok(s.players[0].slots[slot].echo, '应生成残影'); eq(s.players[0].slots[slot].echo.characterName, '测试角色', '残影应保存中文角色名');
    eq(s.players[0].board.length, 0, '残影不应占用场上容量');
    const i = addHand(s, 0, base); s.players[0].pp = 1; eq(E.canPlay(s, i).ok, true, '残影上应可再部署');
    E.playCard(s, i, { slot }); const restored = s.players[0].board.find(x => x.characterId === 'test');
    ok(restored, '应从残影回到原格'); eq(restored.slot.idx, slot, '应使用残影原格'); eq(s.players[0].board.length, 1, '残影复归应只产生一个实体');
  });
  t('真实一阶换装继承攻击资格，残影换装视为新登场', () => {
    const real = setup(); const u = S.makeUnit(real.__cardIndex.base, -7); E.placeUnit(real.players[0], u);
    let i = addHand(real, 0, real.__cardIndex.mid); real.players[0].pp = 1; E.playCard(real, i);
    eq(E.canAttack(real, real.players[0].board[0]), true, '存活过回合的一阶换装后应可直接攻击');

    const echo = setup(); const old = S.makeUnit(echo.__cardIndex.base, -7); E.placeUnit(echo.players[0], old); E.dealDamage(echo, old, 99, null);
    i = addHand(echo, 0, echo.__cardIndex.mid); echo.players[0].pp = 1; E.playCard(echo, i);
    eq(echo.players[0].board[0].summonedTurn, echo.turn, '从残影换装应重置登场回合');
    eq(E.canAttack(echo, echo.players[0].board[0]), false, '从残影换装不能继承旧一阶攻击资格');
  });
  t('残影在控制者下个回合结束时消散', () => {
    const s = setup(); const u = S.makeUnit(s.__cardIndex.base, -99); E.placeUnit(s.players[0], u); E.dealDamage(s, u, 99, null);
    const slot = u.slot.idx; ok(s.players[0].slots[slot].echo, '应先留下残影');
    E.endTurn(s); ok(s.players[0].slots[slot].echo, '对手回合开始前不应消散');
    E.startTurn(s); E.endTurn(s); ok(s.players[0].slots[slot].echo, '对手回合结束时不应消散');
    E.startTurn(s); E.endTurn(s); ok(!s.players[0].slots[slot].echo, '控制者下个回合结束时应消散');
  });
  t('己方牺牲和变形绕过残影，高阶回手返回全形态并留下残影', () => {
    const sacrifice = setup(); let u = S.makeUnit(sacrifice.__cardIndex.base, -99); E.placeUnit(sacrifice.players[0], u); E.killUnit(sacrifice, u, 'sacrifice', 0); ok(!sacrifice.players[0].slots[0].echo, '己方牺牲不应生成残影');

    const bounce = setup(); u = S.makeUnit(bounce.__cardIndex.base, -99); E.placeUnit(bounce.players[0], u);
    E.runActions(bounce, [{ op: 'bounce', args: ['allyOne'] }], { ownerIdx: 0, chosen: u, source: null });
    eq(bounce.players[0].board.length, 0, '己方回手应直接离场'); eq(bounce.players[0].hand.at(-1).def.name, 'base', '一阶应返回手牌');
    ok(bounce.players[0].slots[0].echo, '崩坏角色回手后应留下残影');

    const enemyBounce = setup(); u = S.makeUnit(enemyBounce.__cardIndex.high, -99);
    u.lowerForms = [enemyBounce.__cardIndex.base, enemyBounce.__cardIndex.mid]; E.placeUnit(enemyBounce.players[0], u);
    const before = enemyBounce.players[0].hand.length;
    E.runActions(enemyBounce, [{ op: 'bounce', args: ['enemyOne'] }], { ownerIdx: 1, chosen: u, source: null });
    eq(enemyBounce.players[0].board.length, 0, '敌方回手应从目标控制者场上移除');
    eq(enemyBounce.players[0].hand.length, before + 3, '1、2、3阶应全部返回目标控制者手牌');
    eq(enemyBounce.players[0].hand.slice(-3).map(x => x.def.name).join('/'), 'base/mid/high', '回手形态顺序应从低到高');
    ok(enemyBounce.players[0].slots[0].echo, '全形态回手后原格应留下残影');

    const transform = setup(); u = S.makeUnit(transform.__cardIndex.base, -99); u.lowerForms = [transform.__cardIndex.base]; E.placeUnit(transform.players[0], u);
    E.runActions(transform, [{ op: 'transform', args: ['allyOne', 'other'] }], { ownerIdx: 0, chosen: u, source: null });
    eq(transform.players[0].board[0].name, 'other', '变形应直接改写当前单位'); eq(transform.players[0].board[0].characterId, 'other', '变形应更新角色身份');
    eq(transform.players[0].board[0].lowerForms.length, 0, '变形应清空旧形态堆栈'); ok(!transform.players[0].slots[0].echo, '变形不应生成残影');
  });
  t('敌方消灭可触发残影，己方主动消灭直接离场', () => {
    const enemy = setup(); let u = S.makeUnit(enemy.__cardIndex.base, -99); E.placeUnit(enemy.players[0], u);
    E.killUnit(enemy, u, 'effect', 1); ok(enemy.players[0].slots[0].echo, '敌方消灭应触发残影');

    const friendly = setup(); u = S.makeUnit(friendly.__cardIndex.base, -99); E.placeUnit(friendly.players[0], u);
    E.killUnit(friendly, u, 'effect', 0); ok(!friendly.players[0].slots[0].echo, '己方主动消灭应绕过残影');
  });
  t('崩坏手牌不会因使用圣痕法术获得演算层数', () => {
    const s = setup();
    const spell = { id: 'stigma', name: '圣痕测试', class: '崩坏', type: '法术', cost: 0, effect: 'spell: draw(1)' };
    const boost = { id: 'boost', name: '演算测试', class: '智识', type: '随从', cost: 2, atk: 2, hp: 2,
      effect: 'costIf(spellboost/2)[spellboost>=2]' };
    s.players[0].hand = [S.makeCardInstance(spell), S.makeCardInstance(s.__cardIndex.base), S.makeCardInstance(boost)];
    s.players[0].pp = 0; E.playCard(s, 0);
    eq(s.players[0].hand.find(x => x.def.id === 'base').spellboost, 0, '崩坏形态不应获得演算层数');
    eq(s.players[0].hand.find(x => x.def.id === 'boost').spellboost, 1, '实际使用演算机制的牌应正常累积');
  });
  t('AI：保留1→2换装链，无锚点时换走高阶', () => {
    const s = setup();
    s.players[0].hand = [S.makeCardInstance(s.__cardIndex.base), S.makeCardInstance(s.__cardIndex.mid)];
    ok(!AI.mulligan(s, 0).includes(1), '有同角色1阶时应保留2阶形成换装链');
    s.players[0].hand = [S.makeCardInstance(s.__cardIndex.high), S.makeCardInstance(s.__cardIndex.other)];
    ok(AI.mulligan(s, 0).includes(0), '没有锚点时应换走高阶');
  });
  t('三套牌：每套2个三阶、3个二阶，且跨套复用符合限制', () => {
    const roleUses = new Map(), coreUses = new Map();
    for (const deck of ['装甲轮转', '律者跃迁', '休伯利安支援']) {
      const src = PRESET_IDS[`崩坏｜${deck}`];
      const ids = src.split(/\s+/).map(x => x.replace(/\*\d+$/, ''));
      const chars = new Map();
      for (const id of ids) {
        const d = cards.byId[id];
        if (!d?.characterId) continue;
        const tiers = chars.get(d.characterId) || new Set(); tiers.add(d.formTier); chars.set(d.characterId, tiers);
      }
      const cores = [...chars].filter(([, tiers]) => Math.max(...tiers) === 3).map(([id]) => id);
      const supports = [...chars].filter(([, tiers]) => Math.max(...tiers) === 2).map(([id]) => id);
      eq(cores.length, 2, `${deck}三阶角色数`); eq(supports.length, 3, `${deck}二阶角色数`);
      for (const id of chars.keys()) roleUses.set(id, (roleUses.get(id) || 0) + 1);
      for (const id of cores) coreUses.set(id, (coreUses.get(id) || 0) + 1);
    }
    ok([...coreUses.values()].every(n => n === 1), '三阶角色不能跨牌组重复');
    ok([...roleUses.values()].every(n => n <= 2), '二阶角色最多进入两套牌');
  });
  return out;
}
