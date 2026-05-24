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

// Claude vision으로 일기 사진에서 (여러) 날짜·내용 추출
// 사용자가 지정한 year 와 결합해 YYYY-MM-DD 생성. year 가 없으면 MM-DD 만.
async function ocrDiaryPhoto(env, dataUrl, year) {
  if (!env.ANTHROPIC_API_KEY) {
    return { error: 'ocr_not_configured', hint: 'Worker에 ANTHROPIC_API_KEY secret 설정 필요' };
  }
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return { error: 'invalid_image' };
  const mediaType = m[1];
  const b64 = m[2];

  const yearHint = (typeof year === 'number' && year >= 1900 && year <= 2100)
    ? `이미지에 연도가 안 나와도, 사용자가 선택한 연도는 ${year}년입니다. 모든 일자는 이 연도로 가정하세요.`
    : '이미지에 연도가 안 나오면 그 항목은 응답에서 빼세요.';

  const prompt =
    '이 이미지는 한 장에 여러 날짜의 일기가 담긴 캡처일 수 있습니다. ' +
    '이미지에서 식별 가능한 모든 날짜별로 일기를 분리하여, 순수 JSON 배열만 응답하세요 (설명·코드블록·마크다운 금지).\n' +
    yearHint + '\n' +
    '각 원소는 다음 형식:\n' +
    '{\n' +
    '  "date_md": "MM-DD 형식. 예: 12-03. 못 읽으면 빈 문자열",\n' +
    '  "weekday": "월요일/화요일/... 또는 빈 문자열",\n' +
    '  "title": "그 날의 제목이 있으면 적고, 없으면 빈 문자열",\n' +
    '  "content": "그 날의 본문. 손글씨도 그대로 옮기되, 줄바꿈은 \\n. 그림이 있으면 본문 끝에 [그림: 무엇] 한 줄.",\n' +
    '  "tags": ["감정·주제 키워드", "..."]\n' +
    '}\n' +
    '규칙:\n' +
    '- 날짜를 못 읽거나 본문이 비어있는 항목은 배열에서 제외하세요\n' +
    '- 날짜 형식은 자유롭게 인식하세요 (12/3, 12.03, 12월 3일 등)\n' +
    '- 일자가 하나만 있어도 길이 1인 배열로 반환\n' +
    '- 시간 순서대로 정렬';

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
      console.error('[ocr] anthropic error', res.status, text.slice(0, 500));
      return { error: 'anthropic_error', status: res.status, detail: text.slice(0, 500) };
    }
    const out = await res.json();
    const text = (out.content && out.content[0] && out.content[0].text || '').trim();
    console.log('[ocr] claude returned', text.slice(0, 500));
    // JSON 추출 — Claude가 ```json 블록을 끼는 경우 방어
    let jsonText = text;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (e) {
      console.error('[ocr] parse failed', text.slice(0, 500));
      return { error: 'parse_failed', raw: text.slice(0, 500) };
    }
    // Claude 가 단일 객체로 응답한 경우(예전 포맷) 배열로 감쌈
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const validYear = (typeof year === 'number' && year >= 1900 && year <= 2100) ? year : null;
    const entries = arr.map(e => {
      const md = String(e.date_md || '').trim();
      const mdMatch = /^(\d{1,2})[-/.](\d{1,2})$/.exec(md);
      let date = '';
      if (mdMatch && validYear) {
        const mm = String(parseInt(mdMatch[1], 10)).padStart(2, '0');
        const dd = String(parseInt(mdMatch[2], 10)).padStart(2, '0');
        date = `${validYear}-${mm}-${dd}`;
      }
      return {
        date,                                                                    // YYYY-MM-DD (없으면 빈 문자열)
        date_md: md,
        weekday: typeof e.weekday === 'string' ? e.weekday : '',
        title: typeof e.title === 'string' ? e.title : '',
        content: typeof e.content === 'string' ? e.content : '',
        tags: Array.isArray(e.tags) ? e.tags.filter(t => typeof t === 'string') : [],
      };
    }).filter(e => e.content || e.title);
    return { ok: true, entries };
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
      const year = Number.isFinite(body.year) ? Math.trunc(body.year) : null;
      const result = await ocrDiaryPhoto(env, dataUrl, year);
      const status = result.error ? 422 : 200;
      return json(result, status, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'diary-young-api' }, 200, cors);
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};
