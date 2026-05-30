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
    ? `한 장에 여러 해의 일기가 섞여 있을 수 있습니다. 각 일기의 연도를 독립적으로 판단하세요. ` +
      `일기/이미지에 연도가 보이면(예: 2019년, 24년, '19) 그 연도를 그 항목의 year 로 적으세요. ` +
      `연도 표기가 전혀 없는 항목만 사용자가 선택한 ${year}년으로 가정하세요.`
    : '이미지에 연도가 안 나오면 그 항목은 응답에서 빼세요. 연도가 보이면 그 연도를 year 로 적으세요.';

  const prompt =
    '당신은 한글 캡처 이미지에서 일기 텍스트를 정확히 추출하는 OCR 전문가입니다. ' +
    '이미지는 한 장에 여러 날짜의 일기가 담긴 캡처일 수 있습니다.\n' +
    '\n' +
    '【최우선 — 한글 정확도 규칙. 반드시 지킬 것】\n' +
    '1. 본문의 한글은 원문 글자를 한 자도 빠뜨리거나 바꾸지 마세요. 임의 교정 금지.\n' +
    '2. 띄어쓰기·줄바꿈(\\n)·문장부호·이모지·숫자도 원문 그대로 옮기세요.\n' +
    '3. 비슷한 글자를 헷갈리지 말 것:\n' +
    '   - 모음: ㅏ↔ㅑ, ㅓ↔ㅕ, ㅗ↔ㅛ, ㅜ↔ㅠ, ㅐ↔ㅔ, ㅙ↔ㅞ, ㅡ↔ㅓ\n' +
    '   - 자음: ㅁ↔ㅂ, ㄴ↔ㄷ↔ㄹ, ㅎ↔ㅊ, ㅅ↔ㅆ↔ㅈ, ㄱ↔ㅋ\n' +
    '   - 받침 유무 (예: 가/각, 사/산, 마/맏)\n' +
    '4. 의심스러운 글자는 이미지의 다른 단어들과 글꼴·간격·맥락을 비교해 확정하세요.\n' +
    '5. 정말 못 읽는 글자만 [?] 로 표시 (글자 단위, 절대 추측 금지).\n' +
    '6. 캡처면 대부분 인쇄체 디지털 텍스트입니다 — 손글씨가 아니면 한 글자도 틀리지 않게 옮길 수 있어야 정상입니다.\n' +
    '7. 출력 직전 본문을 다시 이미지와 대조하며 검증하세요. 의심 글자는 다시 보세요.\n' +
    '\n' +
    yearHint + '\n' +
    '\n' +
    '순수 JSON 배열만 응답하세요 (설명·코드블록·마크다운 금지). 각 원소:\n' +
    '{\n' +
    '  "date_md": "MM-DD 형식. 예: 12-03. 못 읽으면 빈 문자열",\n' +
    '  "year": "이 일기에 연도가 보이면 4자리 숫자 문자열(예: 2019). 두 자리만 보이면 그대로(예: 19). 안 보이면 빈 문자열",\n' +
    '  "weekday": "월요일/화요일/... 또는 빈 문자열",\n' +
    '  "title": "그 날의 제목이 있으면 그대로 옮기고, 없으면 빈 문자열",\n' +
    '  "content": "그 날의 본문. 위 정확도 규칙을 모두 적용. 줄바꿈은 \\n. 본문에 [그림: ...] 같은 메타 표기 금지.",\n' +
    '  "tags": ["본문에서 자연스럽게 도출되는 감정·주제 키워드", "..."],\n' +
    '  "photo_bboxes": [[x, y, w, h], ...]  // 해당 날짜 영역 안에 사진(이모지/아이콘이 아닌 실제 이미지) 이 있으면 0~1 정규화 좌표. 좌상단=[0,0], 우하단=[1,1]. 없으면 빈 배열.\n' +
    '}\n' +
    '\n' +
    '기타:\n' +
    '- 날짜를 못 읽거나 본문·사진이 모두 비어있는 항목은 배열에서 제외\n' +
    '- 날짜 형식 자유롭게 인식 (12/3, 12.03, 12월 3일 등)\n' +
    '- photo_bboxes: 해당 일자 텍스트 바로 다음/아래의 사진들. 다음 날짜 시작 직전까지를 그 날에 귀속\n' +
    '- 일자 하나만 있어도 길이 1 배열\n' +
    '- 시간 순서대로 정렬';

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
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
    return normalizeEntries(text, year);
  } catch (e) {
    return { error: 'fetch_failed', detail: String(e && e.message || e) };
  }
}

// Claude 응답 텍스트(JSON 배열 또는 객체)를 정규화된 entries 배열로.
// photo_bboxes 도 처리 — 텍스트 입력이면 항상 빈 배열.
function normalizeEntries(text, year) {
  let jsonText = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonText = fence[1].trim();
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch (e) {
    return { ok: false, error: 'parse_failed', raw: text.slice(0, 500) };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  // 선택 연도는 '폴백' — 항목 자체에 연도가 보이면 그쪽을 우선(여러 해 혼합 업로드 지원).
  const fallbackYear = (typeof year === 'number' && year >= 1900 && year <= 2100) ? year : null;
  const entries = arr.map(e => {
    const md = String(e.date_md || '').trim();
    const mdMatch = /^(\d{1,2})[-/.](\d{1,2})$/.exec(md);
    // 항목별 연도 추출 — 4자리 우선, 두 자리는 19xx/20xx 보정
    let entryYear = fallbackYear;
    const yRaw = String(e.year == null ? '' : e.year).trim();
    const yMatch = /(\d{4})/.exec(yRaw) || /^(\d{2})$/.exec(yRaw);
    if (yMatch) {
      let yy = parseInt(yMatch[1], 10);
      if (yy < 100) yy += (yy >= 70 ? 1900 : 2000);
      if (yy >= 1900 && yy <= 2100) entryYear = yy;
    }
    let date = '';
    if (mdMatch && entryYear) {
      const mm = String(parseInt(mdMatch[1], 10)).padStart(2, '0');
      const dd = String(parseInt(mdMatch[2], 10)).padStart(2, '0');
      date = `${entryYear}-${mm}-${dd}`;
    }
    const bboxes = Array.isArray(e.photo_bboxes) ? e.photo_bboxes
                 : Array.isArray(e.photo_bbox) ? [e.photo_bbox]
                 : [];
    const cleanBboxes = bboxes
      .filter(b => Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number' && isFinite(n)))
      .map(([x, y, w, h]) => [
        Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y)),
        Math.max(0, Math.min(1, w)), Math.max(0, Math.min(1, h)),
      ])
      .filter(([x, y, w, h]) => w > 0.02 && h > 0.02 && !(x === 0 && y === 0 && w >= 0.98 && h >= 0.98));
    return {
      date,
      date_md: md,
      weekday: typeof e.weekday === 'string' ? e.weekday : '',
      title: typeof e.title === 'string' ? e.title : '',
      content: typeof e.content === 'string' ? e.content : '',
      tags: Array.isArray(e.tags) ? e.tags.filter(t => typeof t === 'string') : [],
      photo_bboxes: cleanBboxes,
    };
  }).filter(e => e.content || e.title || e.photo_bboxes.length);
  return { ok: true, entries };
}

// 텍스트 파일(여러 날짜 일기) 을 일자별로 분리 — 이미지가 아닌 텍스트 입력 버전
async function parseTextDiary(env, text, year) {
  if (!env.ANTHROPIC_API_KEY) {
    return { error: 'ocr_not_configured', hint: 'Worker에 ANTHROPIC_API_KEY secret 설정 필요' };
  }
  if (!text || !text.trim()) return { error: 'empty_text' };

  const yearHint = (typeof year === 'number' && year >= 1900 && year <= 2100)
    ? `한 입력에 여러 해의 일기가 섞여 있을 수 있습니다. 각 일기의 연도를 독립적으로 판단하세요. ` +
      `일기에 연도가 보이면(예: 2019년, 24년, '19) 그 연도를 그 항목의 year 로 적으세요. ` +
      `연도 표기가 전혀 없는 항목만 사용자가 선택한 ${year}년으로 가정하세요.`
    : '텍스트에 연도가 없으면 그 항목은 응답에서 빼세요. 연도가 보이면 그 연도를 year 로 적으세요.';

  const prompt =
    '당신은 한글 일기 텍스트를 일자별로 정확히 분리하는 도우미입니다.\n' +
    '\n' +
    '【최우선 규칙】\n' +
    '1. 본문 글자는 원문 그대로 옮기세요. 임의 교정 금지.\n' +
    '2. 띄어쓰기·줄바꿈(\\n)·문장부호·이모지·숫자도 원문 그대로.\n' +
    '3. 한 입력 안에 여러 날짜의 일기가 있을 수 있습니다. 각 날짜별로 분리하세요.\n' +
    '4. 날짜 형식은 자유롭게 인식: 12/3, 12.3, 12월 3일, 2024-12-03, 12-03 (월) 등.\n' +
    '5. 날짜를 못 읽거나 본문이 없는 항목은 결과에서 제외.\n' +
    '\n' +
    yearHint + '\n' +
    '\n' +
    '순수 JSON 배열만 응답 (설명·코드블록·마크다운 금지). 각 원소:\n' +
    '{\n' +
    '  "date_md": "MM-DD",\n' +
    '  "year": "이 일기에 연도가 보이면 4자리 숫자 문자열(예: 2019). 두 자리만 보이면 그대로(예: 19). 안 보이면 빈 문자열",\n' +
    '  "weekday": "월요일/화요일/... 또는 빈 문자열",\n' +
    '  "title": "그 날의 제목이 있으면, 없으면 빈 문자열",\n' +
    '  "content": "그 날의 본문 (위 규칙 준수, 줄바꿈은 \\n)",\n' +
    '  "tags": ["감정·주제 키워드"]\n' +
    '}\n' +
    '\n' +
    '- 일자가 하나만 있어도 길이 1 배열\n' +
    '- 시간 순서대로 정렬\n' +
    '\n' +
    '--- 일기 텍스트 시작 ---\n' +
    text +
    '\n--- 일기 텍스트 끝 ---';

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
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
      const detail = await res.text();
      console.error('[parse-text] anthropic error', res.status, detail.slice(0, 500));
      return { error: 'anthropic_error', status: res.status, detail: detail.slice(0, 500) };
    }
    const out = await res.json();
    const replyText = (out.content && out.content[0] && out.content[0].text || '').trim();
    console.log('[parse-text] claude returned', replyText.slice(0, 500));
    return normalizeEntries(replyText, year);
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

    // 텍스트 파일 — 여러 날짜 일기를 일자별 entries 로 분리 (편집 토큰 필요)
    if (url.pathname === '/api/parse-text' && req.method === 'POST') {
      const token = req.headers.get('X-Edit-Token') || '';
      if (!env.EDIT_TOKEN || token !== env.EDIT_TOKEN) {
        return json({ error: 'unauthorized' }, 401, cors);
      }
      let body;
      try { body = await req.json(); }
      catch { return json({ error: 'invalid_json' }, 400, cors); }

      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) return json({ error: 'empty_text' }, 400, cors);
      if (text.length > 200_000) return json({ error: 'too_large', size: text.length, limit: 200_000 }, 413, cors);

      const year = Number.isFinite(body.year) ? Math.trunc(body.year) : null;
      const result = await parseTextDiary(env, text, year);
      const status = result.error ? 422 : 200;
      return json(result, status, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'diary-young-api' }, 200, cors);
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};
