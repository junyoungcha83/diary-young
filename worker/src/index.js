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
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// Claude vision으로 일기 사진에서 날짜/내용 추출
async function ocrDiaryPhoto(env, dataUrl) {
  if (!env.ANTHROPIC_API_KEY) {
    return { error: 'ocr_not_configured', hint: 'Worker에 ANTHROPIC_API_KEY secret 설정 필요' };
  }
  // data URL 에서 mime + base64 분리
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return { error: 'invalid_image' };
  const mediaType = m[1];
  const b64 = m[2];

  const prompt =
    '이 이미지는 일기장의 한 페이지 또는 일기로 쓰일 사진입니다. ' +
    '다음을 JSON 형식으로만 응답하세요 (다른 설명·코드블록·마크다운 없이 순수 JSON):\n' +
    '{\n' +
    '  "date": "YYYY-MM-DD 또는 빈 문자열 (페이지에서 날짜를 찾을 수 없으면)",\n' +
    '  "weekday": "월요일/화요일/... 또는 빈 문자열",\n' +
    '  "title": "페이지 제목이 보이면 적고 없으면 빈 문자열",\n' +
    '  "content": "본문 텍스트. 손글씨도 최대한 그대로 옮겨 적되, 줄바꿈은 \\n 으로. 그림이 있으면 본문 끝에 [그림: 무엇무엇] 형태로 한 줄 덧붙이세요.",\n' +
    '  "tags": ["감정·주제 키워드", "..."]\n' +
    '}\n' +
    '날짜를 정확히 못 읽으면 date는 빈 문자열로 두세요. 추측하지 마세요.';

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: prompt },
      ],
    }],
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      return { error: 'anthropic_error', status: res.status, detail: text.slice(0, 500) };
    }
    const out = await res.json();
    const text = (out.content && out.content[0] && out.content[0].text || '').trim();
    // JSON 추출 — Claude가 ```json 블록을 끼는 경우 방어
    let jsonText = text;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch {
      return { error: 'parse_failed', raw: text.slice(0, 500) };
    }
    return {
      ok: true,
      date: typeof parsed.date === 'string' ? parsed.date : '',
      weekday: typeof parsed.weekday === 'string' ? parsed.weekday : '',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      content: typeof parsed.content === 'string' ? parsed.content : '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter(t => typeof t === 'string') : [],
    };
  } catch (e) {
    return { error: 'fetch_failed', detail: String(e && e.message || e) };
  }
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

    // OCR — 일기 사진에서 날짜/내용 추출 (편집 토큰 필요)
    if (url.pathname === '/api/ocr' && req.method === 'POST') {
      const token = req.headers.get('X-Edit-Token') || '';
      if (!env.EDIT_TOKEN || token !== env.EDIT_TOKEN) {
        return json({ error: 'unauthorized' }, 401, cors);
      }
      let body;
      try { body = await req.json(); }
      catch { return json({ error: 'invalid_json' }, 400, cors); }

      const dataUrl = String(body.image || '');
      if (!dataUrl.startsWith('data:image/')) {
        return json({ error: 'invalid_image' }, 400, cors);
      }
      const result = await ocrDiaryPhoto(env, dataUrl);
      const status = result.error ? 422 : 200;
      return json(result, status, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'diary-young-api' }, 200, cors);
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};
