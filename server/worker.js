/* 崩铁 CCG — 战绩接收端（Cloudflare Worker）
 *
 * 在 Cloudflare 后台「Workers & Pages → 创建 → Worker」里，把这整个文件的内容
 * 粘贴进在线编辑器覆盖默认代码，然后绑定一个名为 DB 的 D1 数据库即可。
 * 不需要 Node、不需要 wrangler、不需要命令行。
 *
 * 三个路由：
 *   POST /report   接收战绩（客户端调这个）
 *   GET  /stats    按卡组汇总胜率（我用来看数据；只读、可公开）
 *   GET  /raw      导出原始行（需要 ?key=<ADMIN_KEY>，用于拉全量做深入分析）
 *
 * 刻意的取舍：
 *   - 只接受白名单来源（ALLOW_ORIGINS），免得别人拿你的额度当免费数据库
 *   - 每次请求限量 50 条，字段长度限死，防止一次灌进来一堆垃圾
 *   - 不存 IP，只存 Cloudflare 给的国家代码
 *   - 落库失败也返回 200：客户端拿到失败会一直重试，反而浪费额度；
 *     真正的错误写在响应体里，我用 /stats 就能发现异常
 */

const ALLOW_ORIGINS = [
  'https://qq24122.github.io',
  'http://127.0.0.1:8848',
  'http://localhost:8848',
];

const MAX_ROWS = 50;          // 单次请求最多接收多少条
const MAX_STR  = 64;          // 字符串字段最长多少字符

function cors(origin) {
  const ok = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
  };
}
const json = (obj, status, hdrs) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { 'content-type': 'application/json; charset=utf-8', ...(hdrs || {}) },
});

/** 把客户端来的一行洗成可入库的形状；不合格返回 null 而不是抛错 */
function clean(r) {
  const s = (v) => (typeof v === 'string' ? v.slice(0, MAX_STR) : null);
  const n = (v) => (Number.isFinite(+v) ? Math.trunc(+v) : null);
  const row = {
    client_ts: n(r.ts),
    build: s(r.build) || 'unknown',
    sid: s(r.sid),
    mode: ['ai', 'pvp'].includes(r.mode) ? r.mode : 'ai',
    me_cls: s(r.meCls), me_deck: s(r.meDeck),
    foe_cls: s(r.foeCls), foe_deck: s(r.foeDeck),
    first: r.first ? 1 : 0,
    result: r.result === 'win' ? 'win' : r.result === 'lose' ? 'lose' : null,
    turns: n(r.turns), me_hp: n(r.meHp), foe_hp: n(r.foeHp),
    dur_ms: n(r.durMs), mull: n(r.mull),
  };
  // 少了这几样就没法用于统计，直接丢
  if (!row.sid || !row.result || !row.me_cls || !row.me_deck || !row.foe_cls || !row.foe_deck) {
    return null;
  }
  // 明显不合理的值（有人手改上报）：回合数与血量都有物理上限
  if (row.turns != null && (row.turns < 0 || row.turns > 200)) return null;
  if (row.me_hp != null && row.me_hp > 60) return null;
  return row;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const H = cors(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });

    /* ---------- 接收战绩 ---------- */
    if (url.pathname === '/report' && request.method === 'POST') {
      if (origin && !ALLOW_ORIGINS.includes(origin)) {
        return json({ ok: false, err: 'origin not allowed' }, 403, H);
      }
      let body;
      try { body = await request.json(); }
      catch (e) { return json({ ok: false, err: 'bad json' }, 400, H); }

      const rows = Array.isArray(body && body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
      if (!rows.length) return json({ ok: true, saved: 0 }, 200, H);

      const cc = request.headers.get('CF-IPCountry') || null;
      const now = Date.now();
      let saved = 0, dropped = 0;

      try {
        const stmt = env.DB.prepare(
          `INSERT OR IGNORE INTO matches
           (ins_at, client_ts, build, sid, mode, me_cls, me_deck, foe_cls, foe_deck,
            first, result, turns, me_hp, foe_hp, dur_ms, mull, ip_cc)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const batch = [];
        for (const raw of rows) {
          const r = clean(raw);
          if (!r) { dropped++; continue; }
          batch.push(stmt.bind(now, r.client_ts, r.build, r.sid, r.mode,
            r.me_cls, r.me_deck, r.foe_cls, r.foe_deck, r.first, r.result,
            r.turns, r.me_hp, r.foe_hp, r.dur_ms, r.mull, cc));
        }
        if (batch.length) { await env.DB.batch(batch); saved = batch.length; }
      } catch (e) {
        // 落库失败仍返回 200：让客户端把这批丢掉，否则它会无限重试烧额度
        return json({ ok: true, saved: 0, warn: String(e && e.message || e) }, 200, H);
      }
      return json({ ok: true, saved, dropped }, 200, H);
    }

    /* ---------- 按卡组汇总（我看数据用） ---------- */
    if (url.pathname === '/stats' && request.method === 'GET') {
      const build = url.searchParams.get('build');   // 不传 = 全部版本
      try {
        const where = build ? 'WHERE build = ?' : '';
        const q = `SELECT me_cls, me_deck, build,
                     COUNT(*) AS n,
                     SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS w,
                     ROUND(AVG(turns),1) AS avg_turns,
                     ROUND(AVG(foe_hp),1) AS avg_foe_hp,
                     ROUND(AVG(me_hp),1)  AS avg_me_hp
                   FROM matches ${where}
                   GROUP BY build, me_cls, me_deck
                   ORDER BY n DESC`;
        const st = build ? env.DB.prepare(q).bind(build) : env.DB.prepare(q);
        const { results } = await st.all();
        const tot = await (build
          ? env.DB.prepare('SELECT COUNT(*) c FROM matches WHERE build=?').bind(build)
          : env.DB.prepare('SELECT COUNT(*) c FROM matches')).first();
        return json({
          ok: true, total: tot && tot.c,
          decks: (results || []).map(r => ({ ...r, rate: r.n ? Math.round(r.w / r.n * 100) : 0 })),
        }, 200, H);
      } catch (e) {
        return json({ ok: false, err: String(e && e.message || e) }, 500, H);
      }
    }

    /* ---------- 原始数据导出（要口令） ---------- */
    if (url.pathname === '/raw' && request.method === 'GET') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
        return json({ ok: false, err: 'need key' }, 401, H);
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '5000', 10) || 5000, 20000);
      const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      try {
        const { results } = await env.DB.prepare(
          'SELECT * FROM matches WHERE id > ? ORDER BY id LIMIT ?').bind(since, limit).all();
        return json({ ok: true, rows: results || [] }, 200, H);
      } catch (e) {
        return json({ ok: false, err: String(e && e.message || e) }, 500, H);
      }
    }

    return json({ ok: true, service: 'hsr-ccg stats', routes: ['/report', '/stats', '/raw'] }, 200, H);
  },
};
