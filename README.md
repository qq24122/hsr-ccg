# 崩坏：星穹铁道 CCG

以《崩坏：星穹铁道》为题材的同人集换式卡牌游戏，玩法框架取自《影之诗》初代。
纯静态网页，无后端，打开即玩（对手为内置 AI）。

**在线试玩：** https://qq24122.github.io/hsr-ccg/

## 现状

- 363 张卡，8 个命途职业，每职业 3 套预设卡组（共 24 套）
- 24 套卡组自对弈胜率全部落在 41–59%（1512 局，每对卡组 3 个发牌种子）
- 51 条规则单元测试，全部通过
- 单人对战 AI 与平衡测试共用同一套决策代码

## 目录

| 路径 | 说明 |
|---|---|
| `play.html` | 对战界面（卡牌详情面板、动效） |
| `src/engine.js` | 规则引擎：伤害时序、关键词、8 个职业机制 |
| `src/state.js` | 局面结构与规则常数 |
| `src/dsl.js` | 卡牌效果 DSL 的解析器与词汇白名单 |
| `src/ai.js` | 对手 AI（局面评分 + 模拟试算） |
| `src/loader.js` | 卡表读取与按费用配额的组牌器 |
| `data/cards-*.tsv` | 八个职业的卡表，改这里就能改数值 |
| `img/` | 卡面配图，按卡牌 id 命名 |
| `test/index.html` | 规则单元测试 |
| `test/validate.html` | 全卡库校验 + 卡组两两自对弈 |
| `test/diag.html` | 24 套卡组诊断（残血、打不出来的卡） |
| `test/probe.html` | 单卡组深挖 |

## 卡牌效果怎么写

卡表的 `effect` 列是一行 DSL：

```
触发[条件]: 动作(参数), 动作 ; 触发2: 动作
```

例：

```
static: ward
onPlay: dmg(bothLeader,1)
onPlay[mara]: dmg(enemyLeader,2)
countdown(3); turnEnd: dot(enemyAll,1)
onLeaderDamaged: ctr(火种,+1); onCtr(火种,3): ctr(火种,-3), transform(self,卡厄斯兰那)
```

写了引擎不认识的动作或关键词会在加载时直接报错并指名卡牌，不会静默变成一张没效果的废卡。
词汇表在 `src/dsl.js` 顶部。

## 本地运行

任意静态服务器即可（不能用 `file://`，ES 模块需要 http）。仓库自带一个只依赖 Perl 核心模块的：

```
perl serve.pl 8848 .
```

然后打开 http://127.0.0.1:8848/

## 免责声明

非官方同人作品，非商业用途，与米哈游无关。
《崩坏：星穹铁道》的角色、名称及美术素材版权归米哈游所有；卡面配图取自米游社官方 WIKI。
玩法规则参考《Shadowverse》初代，版权归 Cygames 所有。
如版权方要求，将立即移除相关素材。
