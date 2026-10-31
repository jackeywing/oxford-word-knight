/**
 * Oxford Word Knight — 家庭码学情同步 Worker
 *
 * 静态版跑在 GitHub Pages，没有后端。这个 Worker 只做一件事：
 * 用 KV 存一份 {payload, updated_at}，key 是 6 位家庭码。
 *
 * 部署：
 *   npm i -g wrangler
 *   wrangler kv namespace create OWK_KV          # 把返回的 id 填进 wrangler.toml
 *   wrangler deploy
 *   OWK_SYNC_URL=https://<你的域名> node build-pages.js
 *
 * 安全边界：码就是钥匙。6 位取自 32 个字符表 ≈ 10 亿种，够挡住随手猜。
 * 但请理解这是「不设防的分区键」，不要往里塞任何隐私信息。
 */

const CODE_RE = /^\/api\/state\/([A-Za-z0-9]{4,12})$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const m = url.pathname.match(CODE_RE);
    if (!m) return json({ error: 'not found' }, 404);

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
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const payload = body && typeof body.payload === 'object' && body.payload ? body.payload : null;
      if (!payload) return json({ error: 'payload required' }, 400);
      if (JSON.stringify(payload).length > 100000) return json({ error: 'payload too large' }, 413);

      const updated_at = new Date().toISOString();
      await env.OWK_KV.put(key, JSON.stringify({ payload, updated_at }));
      return json({ ok: true, code, updated_at });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};
