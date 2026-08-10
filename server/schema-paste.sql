CREATE TABLE IF NOT EXISTS matches (id INTEGER PRIMARY KEY AUTOINCREMENT, ins_at INTEGER NOT NULL, client_ts INTEGER, build TEXT NOT NULL, sid TEXT NOT NULL, mode TEXT NOT NULL, me_cls TEXT NOT NULL, me_deck TEXT NOT NULL, foe_cls TEXT NOT NULL, foe_deck TEXT NOT NULL, first INTEGER NOT NULL, result TEXT NOT NULL, turns INTEGER, me_hp INTEGER, foe_hp INTEGER, dur_ms INTEGER, mull INTEGER, ip_cc TEXT);
CREATE INDEX IF NOT EXISTS idx_matches_build ON matches(build, me_cls, me_deck);
CREATE INDEX IF NOT EXISTS idx_matches_time ON matches(ins_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_dedup ON matches(sid, client_ts, me_deck, result);
