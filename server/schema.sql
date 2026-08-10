-- 战绩表。在 Cloudflare 后台 D1 的 Console 里整段粘贴执行一次即可。
--
-- 设计要点：
--   ins_at 由服务端写，client_ts 是客户端自报的时间——两者都留着，
--   因为客户端时间可以是错的（时区没设、系统时间不准），排序统计一律用 ins_at。
--   build 是必须的：没有它就分不清一条数据来自哪一版卡表，混在一起等于没有数据。

CREATE TABLE IF NOT EXISTS matches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ins_at     INTEGER NOT NULL,       -- 服务端接收时间（毫秒）
  client_ts  INTEGER,                -- 客户端自报时间（仅参考）
  build      TEXT    NOT NULL,       -- 卡表/代码版本（git 短哈希）
  sid        TEXT    NOT NULL,       -- 匿名会话 id
  mode       TEXT    NOT NULL,       -- 'ai' | 之后的 'pvp'
  me_cls     TEXT    NOT NULL,
  me_deck    TEXT    NOT NULL,
  foe_cls    TEXT    NOT NULL,
  foe_deck   TEXT    NOT NULL,
  first      INTEGER NOT NULL,       -- 1 = 玩家先手
  result     TEXT    NOT NULL,       -- 'win' | 'lose'
  turns      INTEGER,
  me_hp      INTEGER,
  foe_hp     INTEGER,
  dur_ms     INTEGER,
  mull       INTEGER,
  ip_cc      TEXT                    -- 只存国家代码，不存 IP
);

-- 统计查询几乎都会按版本 + 卡组过滤，建个索引
CREATE INDEX IF NOT EXISTS idx_matches_build ON matches(build, me_cls, me_deck);
CREATE INDEX IF NOT EXISTS idx_matches_time  ON matches(ins_at);

-- 简单去重用：同一个人同一时刻同一结果只算一条
CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_dedup
  ON matches(sid, client_ts, me_deck, result);
