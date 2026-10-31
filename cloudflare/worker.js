/**
 * Oxford Word Knight — 同步 + 只读统计 Worker
 *
 * 路由
 *   GET  /api/state/:code      家庭码读取（KV）
 *   POST /api/state/:code      家庭码写入（KV）
 *   POST /api/log              上报一次闯关 / 一道答题（D1）
 *   GET  /admin?key=…          后台页面（HTML，需要 ADMIN_KEY）
 *   GET  /api/admin/data?key=… 后台数据（JSON，需要 ADMIN_KEY）
 *
 * 隐私边界：不存 IP、不存孩子的原始输入、不存任何可识别信息。
 * 后台只有一个人看，所以不做账号体系——一个口令够用。
 */

const CODE_RE = /^\/api\/state\/([A-Za-z0-9]{4,12})$/;
const MAX_BODY = 16 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', ...CORS };

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

function bad(msg, status = 400) {
  return json({ error: msg }, status);
}

function clean(v, max = 40) {
  return String(v == null ? '' : v).slice(0, max);
}

/* 定时比较，避免提前返回泄露长度/前缀信息 */
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('body too large');
  return JSON.parse(text || '{}');
}

/* ───────────────────────── 上报 ───────────────────────── */

async function handleLog(request, env) {
  if (request.method !== 'POST') return bad('method not allowed', 405);

  let b;
  try { b = await readBody(request); } catch (e) { return bad('bad json'); }

  const code = clean(b.code, 12).toUpperCase();
  const kind = clean(b.kind, 12);

  if (kind === 'round') {
    const r = b.round || {};
    const res = await env.owk_stats.prepare(`
      INSERT INTO rounds (code, character, level, score, correct, total, max_combo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      code,
      clean(r.character, 16),
      clean(r.level, 8),
      Number(r.score) || 0,
      Number(r.correct) || 0,
      Number(r.total) || 0,
      Number(r.max_combo) || 0
    ).run();
    return json({ ok: true, id: res.meta && res.meta.last_row_id });
  }

  if (kind === 'answer') {
    const a = b.answer || {};
    await env.owk_stats.prepare(`
      INSERT INTO answers (round_id, code, type, word, correct, ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      Number(a.round_id) || 0,
      code,
      clean(a.type, 24),
      clean(a.word, 40).toLowerCase(),
      a.correct ? 1 : 0,
      Number(a.ms) || 0
    ).run();
    return json({ ok: true });
  }

  return bad('unknown kind');
}

/* ───────────────────────── 后台数据 ───────────────────────── */

async function adminData(env, days) {
  const since = `-${Number(days) || 7} days`;

  const [totals, recent, weakWords, byType] = await env.owk_stats.batch([
    env.owk_stats.prepare(`
      SELECT COUNT(*) AS rounds,
             COALESCE(SUM(correct), 0) AS correct,
             COALESCE(SUM(total), 0)   AS total,
             COUNT(DISTINCT code)      AS families
      FROM rounds WHERE created_at >= datetime('now', ?)
    `).bind(since),

    env.owk_stats.prepare(`
      SELECT id, code, character, level, score, correct, total, created_at
      FROM rounds WHERE created_at >= datetime('now', ?)
      ORDER BY id DESC LIMIT 20
    `).bind(since),

    env.owk_stats.prepare(`
      SELECT word, COUNT(*) AS tries, SUM(correct) AS ok
      FROM answers WHERE created_at >= datetime('now', ?)
      GROUP BY word HAVING tries >= 2
      ORDER BY (1.0 * ok / tries) ASC, tries DESC LIMIT 12
    `).bind(since),

    env.owk_stats.prepare(`
      SELECT type, COUNT(*) AS n, SUM(correct) AS ok
      FROM answers WHERE created_at >= datetime('now', ?)
      GROUP BY type ORDER BY n DESC
    `).bind(since),
  ]);

  return {
    window_days: Number(days) || 7,
    totals: (totals.results && totals.results[0]) || {},
    recent: recent.results || [],
    weak_words: weakWords.results || [],
    by_type: byType.results || [],
  };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pct(a, b) {
  return b ? Math.round((a / b) * 100) : 0;
}

function adminPage(d) {
  const t = d.totals || {};
  const acc = pct(t.correct || 0, t.total || 0);

  const rows = (d.recent || []).map(r => `
    <tr>
      <td class="dim">${esc(r.created_at)}</td>
      <td>${esc(r.character || '—')}</td>
      <td class="num">${esc(r.score)}</td>
      <td class="num">${pct(r.correct, r.total)}%</td>
      <td class="num dim">${esc(r.correct)}/${esc(r.total)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="dim" style="text-align:center;padding:18px">还没有数据</td></tr>';

  const weak = (d.weak_words || []).map(w => `
    <li><b>${esc(w.word)}</b><span class="dim">${esc(w.ok)}/${esc(w.tries)}</span></li>`).join('')
    || '<li class="dim">还不够数据</li>';

  const types = (d.by_type || []).map(x => `
    <li><span>${esc(x.type)}</span><span class="dim">${pct(x.ok, x.n)}% · ${esc(x.n)} 题</span></li>`).join('')
    || '<li class="dim">—</li>';

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Word Knight · 学情</title>
<style>
  :root{--bg:#1a1410;--panel:#241c16;--line:#3a2e24;--fg:#f0e6d8;--dim:#9c8b7a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,"PingFang SC",system-ui,sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:22px 16px 60px}
  h1{font-size:17px;margin:0 0 4px;letter-spacing:.5px}
  .sub{color:var(--dim);font-size:12.5px;margin-bottom:20px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:18px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
  .card .k{color:var(--dim);font-size:11.5px;margin-bottom:6px}
  .card .v{font-size:26px;font-weight:700}
  .card .v small{font-size:13px;font-weight:400;color:var(--dim)}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:14px}
  .panel h2{font-size:12.5px;color:var(--dim);margin:0 0 10px;font-weight:600;letter-spacing:.4px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--dim);font-weight:500;font-size:11.5px;padding:0 6px 6px;border-bottom:1px solid var(--line)}
  td{padding:7px 6px;border-bottom:1px solid rgba(58,46,36,.5)}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .dim{color:var(--dim)}
  ul{list-style:none;margin:0;padding:0}
  li{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(58,46,36,.5);font-size:13px}
  li:last-child{border-bottom:none}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:620px){.two{grid-template-columns:1fr}}
  .foot{color:var(--dim);font-size:11.5px;margin-top:18px;text-align:center}
</style></head>
<body><div class="wrap">
  <h1>🎮 Word Knight · 学情</h1>
  <div class="sub">最近 ${esc(d.window_days)} 天 · 不含 IP、不含原始输入</div>

  <div class="cards">
    <div class="card"><div class="k">闯关次数</div><div class="v">${esc(t.rounds || 0)}</div></div>
    <div class="card"><div class="k">平均正确率</div><div class="v">${acc}<small>%</small></div></div>
    <div class="card"><div class="k">答题总数</div><div class="v">${esc(t.total || 0)}</div></div>
    <div class="card"><div class="k">活跃家庭码</div><div class="v">${esc(t.families || 0)}</div></div>
  </div>

  <div class="panel">
    <h2>最近闯关</h2>
    <table>
      <thead><tr><th>时间</th><th>角色</th><th class="num">得分</th><th class="num">正确率</th><th class="num">题数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="two">
    <div class="panel"><h2>最需要巩固的词</h2><ul>${weak}</ul></div>
    <div class="panel"><h2>各题型正确率</h2><ul>${types}</ul></div>
  </div>

  <div class="foot">刷新即最新 · 数据来自 Cloudflare D1</div>
</div></body></html>`;
}

/* ───────────────────────── 主入口 ───────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    /* 家庭码同步 */
    const m = path.match(CODE_RE);
    if (m) {
      const code = m[1].toUpperCase();
      const key = 'state:' + code;

      if (request.method === 'GET') {
        const raw = await env.OWK_KV.get(key);
        if (!raw) return json({ code, payload: null, updated_at: null });
        let rec;
        try { rec = JSON.parse(raw); } catch (e) { rec = {}; }
        return json({ code, payload: rec.payload || null, updated_at: rec.updated_at || null });
      }

      if (request.method === 'POST') {
        let body;
        try { body = await readBody(request); } catch (e) { return bad('bad json'); }
        const payload = body && typeof body.payload === 'object' && body.payload ? body.payload : null;
        if (!payload) return bad('payload required');
        if (JSON.stringify(payload).length > 100000) return json({ error: 'payload too large' }, 413);
        const updated_at = new Date().toISOString();
        await env.OWK_KV.put(key, JSON.stringify({ payload, updated_at }));
        return json({ ok: true, code, updated_at });
      }

      return bad('method not allowed', 405);
    }

    /* 上报 */
    if (path === '/api/log') return handleLog(request, env);

    /* 后台：口令校验 */
    if (path === '/admin' || path === '/api/admin/data') {
      const expected = env.ADMIN_KEY;
      if (!expected) return bad('ADMIN_KEY 未配置：wrangler secret put ADMIN_KEY', 503);

      const given = url.searchParams.get('key') || '';
      if (!safeEqual(given, expected)) {
        return new Response('401 Unauthorized', {
          status: 401,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90);
      const data = await adminData(env, days);

      if (path === '/api/admin/data') return json(data);
      return new Response(adminPage(data), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    return json({ error: 'not found' }, 404);
  },
};
