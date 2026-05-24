// diary-young 데이터 동기화 API
// - GET  /api/data  : 누구나 읽기 (전체 JSON 반환)
// - PUT  /api/data  : X-Edit-Token 헤더가 EDIT_TOKEN 과 일치할 때만 저장
//
// KV: DIARY (단일 키 "diary-data")
// Secret: EDIT_TOKEN (편집 비밀번호)

const KEY = 'diary-data';
const MAX_BYTES = 24 * 1024 * 1024;  // 24MB — KV 값 한도(25MB) 내 안전 마진

const ALLOWED_ORIGINS = [
  'https://junyoungcha83.github.io',
  'http://localhost:8002',
  'http://localhost:8001',
  'http://localhost:8000',
  'http://127.0.0.1:8002',
];

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function isValidShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  return Array.isArray(parsed.entries);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === '/api/data') {
      if (req.method === 'GET') {
        const raw = await env.DIARY.get(KEY);
        return new Response(raw || 'null', {
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      if (req.method === 'PUT') {
        const token = req.headers.get('X-Edit-Token') || '';
        if (!env.EDIT_TOKEN || token !== env.EDIT_TOKEN) {
          return json({ error: 'unauthorized' }, 401, cors);
        }
        const body = await req.text();
        if (body.length > MAX_BYTES) {
          return json({ error: 'too_large', limit: MAX_BYTES, size: body.length }, 413, cors);
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json({ error: 'invalid_json' }, 400, cors);
        }
        if (!isValidShape(parsed)) {
          return json({ error: 'invalid_shape' }, 400, cors);
        }
        await env.DIARY.put(KEY, body);
        return json({ ok: true, bytes: body.length }, 200, cors);
      }

      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'diary-young-api' }, 200, cors);
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};
