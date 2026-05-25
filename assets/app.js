// diary-young — 모바일 일기 PWA
// 상태는 JSON 한 덩어리(entries) → localStorage 캐시 + 서버 KV 동기화.
// 사진은 클라이언트에서 축소 후 base64로 entry.photos[].url 에 저장.

const STORAGE_KEY = 'diary-young-state-v1';
const DRAFT_KEY   = 'diary-young-draft-v1';
const TOKEN_KEY   = 'diary-young-edit-token';
const API_BASE    = 'https://diary-young-api.junyoung-cha83.workers.dev';
const SAVE_DEBOUNCE_MS = 800;
const DRAFT_DEBOUNCE_MS = 400;

const PHOTO_MAX_DIM = 1600;        // 최대 한 변 1600px (OCR 정확도 + crop 품질 균형)
const PHOTO_JPEG_QUALITY = 0.78;
const CROP_MAX_DIM = 1024;         // bbox crop 결과는 1024px 로 줄여 저장

const DEFAULT_STATE = {
  version: 1,
  entries: [],
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let activeTab = 'diary';
let viewMonth = monthKey(new Date());
let selectedDate = todayStr();
let editEntryId = null;
let editingPhotos = [];   // 모달에서 편집 중인 photos 배열 (저장 시 entry.photos 로 커밋)
let multiEntries = [];    // OCR이 N>1편 감지 시 — 각 원소 { date, weekday, title, content, tags, excluded }
let searchQuery = '';
let activeTagFilter = '';

// ── 유틸 ────────────────────────────────────────
function monthKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtMonth(mk) {
  const [y, m] = mk.split('-');
  return `${y}년 ${parseInt(m,10)}월`;
}
function fmtDate(ds) {
  if (!ds) return '';
  const [y, m, d] = ds.split('-');
  return `${y}.${m}.${d}`;
}
function fmtDateLong(ds) {
  if (!ds) return '';
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  return `${y}년 ${m}월 ${d}일 (${weekdays[dt.getDay()]})`;
}
function shiftMonth(mk, delta) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}
function nextEntryId() {
  return 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}
function nextPhotoId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
function nowIso() { return new Date().toISOString(); }

// ── 영속화 / 동기화 ──────────────────────────────
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch (e) {}
  return null;
}

function migrate(loaded) {
  if (!loaded || typeof loaded !== 'object') return JSON.parse(JSON.stringify(DEFAULT_STATE));
  const entries = Array.isArray(loaded.entries) ? loaded.entries.map(e => ({
    id: e.id || nextEntryId(),
    date: e.date || todayStr(),
    title: e.title || '',
    content: e.content || '',
    tags: Array.isArray(e.tags) ? e.tags.filter(Boolean).map(String) : [],
    photos: Array.isArray(e.photos) ? e.photos.filter(p => p && p.url).map(p => ({
      id: p.id || nextPhotoId(),
      url: p.url,
    })) : [],
    created_at: e.created_at || nowIso(),
    updated_at: e.updated_at || e.created_at || nowIso(),
  })) : [];
  return { version: 1, entries };
}

let _saveTimer = null;
let _saveCtrl  = null;

function setSyncStatus(s) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const map = {
    idle:        { text: '',          cls: '' },
    pending:     { text: '변경됨',    cls: 'pending' },
    saving:      { text: '저장중…',   cls: 'saving' },
    saved:       { text: '저장됨 ✓',  cls: 'saved' },
    error:       { text: '오프라인',  cls: 'error' },
    unauthorized:{ text: '토큰 오류', cls: 'error' },
    readonly:    { text: '읽기전용',  cls: 'readonly' },
  };
  const m = map[s] || map.idle;
  el.textContent = m.text;
  el.className   = 'sync-status ' + m.cls;
}

function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { alert('localStorage 저장 실패 — 용량 초과 가능성'); }

  const token = getEditToken();
  if (!token) { setSyncStatus('readonly'); return; }

  setSyncStatus('pending');
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(pushToServer, SAVE_DEBOUNCE_MS);
}

async function pushToServer() {
  const token = getEditToken();
  if (!token) return;
  if (_saveCtrl) _saveCtrl.abort();
  _saveCtrl = new AbortController();
  setSyncStatus('saving');
  try {
    const res = await fetch(`${API_BASE}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
      body: JSON.stringify(state),
      signal: _saveCtrl.signal,
    });
    if (res.ok) setSyncStatus('saved');
    else if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      updateEditUI();
      setSyncStatus('unauthorized');
      alert('편집 비밀번호가 잘못됐습니다 — 다시 입력하세요.');
    }
    else if (res.status === 413) {
      setSyncStatus('error');
      alert('데이터 크기 초과 — 사진을 줄이거나 오래된 일기를 정리하세요.');
    }
    else setSyncStatus('error');
  } catch (e) {
    if (e.name !== 'AbortError') setSyncStatus('error');
  }
}

// ── 모달 드래프트 자동 저장 — 백그라운드/리로드 후에도 입력 살아남게 ──
let _draftTimer = null;
function snapshotDraft() {
  const dlg = document.getElementById('diaryDialog');
  if (!dlg || !dlg.open) return null;
  if (multiEntries.length > 0) {
    return {
      open: true, kind: 'multi',
      year: parseInt(document.getElementById('fYear').value, 10) || null,
      editEntryId,
      multiEntries: multiEntries.map(e => ({
        date: e.date, weekday: e.weekday, content: e.content,
        tags: e.tags.slice(), photos: e.photos.map(p => ({ id: p.id, url: p.url })),
        excluded: !!e.excluded,
      })),
    };
  }
  return {
    open: true, kind: 'single',
    editEntryId,
    year: parseInt(document.getElementById('fYear').value, 10) || null,
    date: document.getElementById('fDate').value,
    content: document.getElementById('fContent').value,
    tags: document.getElementById('fTags').value,
    editingPhotos: editingPhotos.map(p => ({ id: p.id, url: p.url })),
  };
}
function saveDraftNow() {
  try {
    const snap = snapshotDraft();
    if (snap) localStorage.setItem(DRAFT_KEY, JSON.stringify(snap));
    else      localStorage.removeItem(DRAFT_KEY);
  } catch (e) {}
}
function saveDraftDebounced() {
  if (_draftTimer) clearTimeout(_draftTimer);
  _draftTimer = setTimeout(saveDraftNow, DRAFT_DEBOUNCE_MS);
}
function clearDraft() {
  if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d && d.open && (d.kind === 'single' || d.kind === 'multi')) return d;
  } catch (e) {}
  return null;
}

// ── 뒤로가기 처리 — 모달/뷰어/탭을 이전 단계로 ──
// 각 "깊은" UI 상태(모달·뷰어·비기본탭)에 진입할 때 history.pushState 로
// 가짜 레이어를 쌓아두고, popstate(뒤로가기) 가 오면 그 레이어를 닫는다.
function pushLayer(layer) {
  history.pushState({ app: 'diary-young', layer }, '');
}
function popLayerIfMatches(layer) {
  if (history.state && history.state.app === 'diary-young' && history.state.layer === layer) {
    history.back();
  }
}
function bindBackButton() {
  window.addEventListener('popstate', () => {
    const photoDlg = document.getElementById('photoViewer');
    const diaryDlg = document.getElementById('diaryDialog');
    if (photoDlg && photoDlg.open) {
      photoDlg.close();
      return;
    }
    if (diaryDlg && diaryDlg.open) {
      closeDiaryDialog();
      return;
    }
    if (activeTab !== 'diary') {
      setActiveTab('diary', { fromBack: true });
      return;
    }
    // 더 닫을 게 없으면 그대로 둠 (브라우저가 한 칸 뒤로 갔을 뿐)
  });
}

function setOcrStatus(text, cls) {
  const el = document.getElementById('ocrStatus');
  if (!el) return;
  el.className = 'ocr-status' + (cls ? ' ' + cls : '');
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = text;
}

// 사진을 OCR 해서 N편 (1편 또는 여러편) 으로 분리 — 사용자 선택 연도와 결합.
async function ocrFirstPhoto(photo) {
  const token = getEditToken();
  if (!token) return;
  const yearInput = document.getElementById('fYear');
  const year = parseInt(yearInput.value, 10) || new Date().getFullYear();
  setOcrStatus(`🔍 ${year}년 기준으로 사진에서 일자별 일기 추출 중…`);
  try {
    const res = await fetch(`${API_BASE}/api/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
      body: JSON.stringify({ image: photo.url, year }),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok || !out || !out.ok) {
      const code = out && out.error ? out.error : `HTTP ${res.status}`;
      const detail = out && (out.detail || out.raw || out.hint);
      setOcrStatus(`✗ 자동 인식 실패 (${code})${detail ? ' — ' + String(detail).slice(0, 80) : ''}`, 'error');
      console.warn('[ocr] failed', out);
      return;
    }
    const entries = Array.isArray(out.entries) ? out.entries : [];
    if (entries.length === 0) {
      setOcrStatus('인식된 일기 없음 — 직접 입력해 주세요', 'error');
      return;
    }
    if (entries.length === 1) {
      // 단일 편 — 기존처럼 단일 폼 채움
      const e = entries[0];
      const fDate = document.getElementById('fDate');
      const fContent = document.getElementById('fContent');
      const fTags = document.getElementById('fTags');
      let filled = [];
      if (e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && fDate.value === todayStr()) {
        fDate.value = e.date; filled.push('날짜');
      }
      if (e.content && !fContent.value.trim()) { fContent.value = e.content; filled.push('본문'); }
      if (e.tags && e.tags.length && !fTags.value.trim()) {
        fTags.value = e.tags.join(', '); filled.push('태그');
      }
      setOcrStatus(filled.length ? `✓ ${filled.join('·')} 자동 입력됨 (확인·수정 가능)`
                                  : '인식했지만 채울 항목 없음');
      setTimeout(() => setOcrStatus(''), 4000);
      return;
    }
    // N편 — 다중 모드 진입. bbox 있는 항목은 사진을 잘라내 photos 로 첨부.
    const totalBboxes = entries.reduce((s, e) => s + (e.photo_bboxes || []).length, 0);
    if (totalBboxes > 0) setOcrStatus(`🖼 ${totalBboxes}장의 사진 잘라내는 중…`);
    multiEntries = await Promise.all(entries.map(async (e) => {
      const photos = [];
      for (const bbox of (e.photo_bboxes || [])) {
        try {
          const p = await cropPhotoFromBbox(photo.url, bbox);
          if (p) photos.push(p);
        } catch (err) { console.warn('[ocr] crop failed', err); }
      }
      return {
        date: e.date || '',
        weekday: e.weekday || '',
        content: e.content || '',
        tags: Array.isArray(e.tags) ? e.tags : [],
        photos,
        excluded: false,
      };
    }));
    enterMultiMode();
    setOcrStatus(`✓ ${entries.length}편 인식됨${totalBboxes ? ` (사진 ${totalBboxes}장 자동 첨부)` : ''} — 검토 후 저장`);
    setTimeout(() => setOcrStatus(''), 4000);
  } catch (e) {
    setOcrStatus('✗ 네트워크 오류 — 직접 입력해 주세요', 'error');
  }
}

// 텍스트 파일을 서버에 보내 일자별 분리 — OCR 멀티모드와 동일한 UI 진입
async function importTextFile(file) {
  if (!ensureEditable()) return;
  if (!file) return;
  const token = getEditToken();
  if (!token) return;
  const yearInput = document.getElementById('fYear');
  const year = parseInt(yearInput.value, 10) || new Date().getFullYear();

  let text;
  try {
    text = await file.text();
  } catch (e) {
    setOcrStatus('✗ 파일 읽기 실패: ' + (e.message || e), 'error');
    return;
  }
  if (!text.trim()) {
    setOcrStatus('파일이 비어있어요', 'error');
    return;
  }
  if (text.length > 200_000) {
    setOcrStatus(`✗ 파일이 너무 큼 (${(text.length/1024).toFixed(0)}KB, 한도 200KB)`, 'error');
    return;
  }

  setOcrStatus(`📄 ${year}년 기준으로 ${file.name} 일자별 분리 중…`);
  try {
    const res = await fetch(`${API_BASE}/api/parse-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
      body: JSON.stringify({ text, year }),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok || !out || !out.ok) {
      const code = out && out.error ? out.error : `HTTP ${res.status}`;
      const detail = out && (out.detail || out.raw || out.hint);
      setOcrStatus(`✗ 텍스트 파싱 실패 (${code})${detail ? ' — ' + String(detail).slice(0, 80) : ''}`, 'error');
      console.warn('[parse-text] failed', out);
      return;
    }
    const entries = Array.isArray(out.entries) ? out.entries : [];
    if (!entries.length) {
      setOcrStatus('파싱된 일기 없음 — 텍스트에 날짜가 있는지 확인하세요', 'error');
      return;
    }
    multiEntries = entries.map(e => ({
      date: e.date || '', weekday: e.weekday || '',
      content: e.content || '',
      tags: Array.isArray(e.tags) ? e.tags : [],
      photos: [], excluded: false,
    }));
    enterMultiMode();
    setOcrStatus(`✓ ${entries.length}편 인식됨 — 검토 후 저장`);
    setTimeout(() => setOcrStatus(''), 4000);
  } catch (e) {
    setOcrStatus('✗ 네트워크 오류 — 잠시 후 다시 시도', 'error');
  }
}

function enterMultiMode() {
  document.getElementById('singleEntrySection').classList.add('hidden');
  document.getElementById('multiSection').classList.remove('hidden');
  document.getElementById('diaryDialogTitle').textContent = `여러 일기 가져오기`;
  renderMultiEntries();
  saveDraftNow();
}

function exitMultiMode() {
  multiEntries = [];
  document.getElementById('singleEntrySection').classList.remove('hidden');
  document.getElementById('multiSection').classList.add('hidden');
  document.getElementById('diaryDialogTitle').textContent = editEntryId ? '일기 편집' : '새 일기';
  saveDraftNow();
}

function renderMultiEntries() {
  const list = document.getElementById('multiList');
  const count = document.getElementById('multiCount');
  const active = multiEntries.filter(e => !e.excluded).length;
  count.textContent = `${active} / ${multiEntries.length}`;
  list.innerHTML = multiEntries.map((e, idx) => {
    const photos = (e.photos || []);
    const photosHtml = photos.length ? `
      <div class="multi-photos">
        ${photos.map((p, pIdx) => `
          <div class="multi-photo-thumb" data-pidx="${pIdx}">
            <img src="${escapeAttr(p.url)}" alt="" />
            <button type="button" class="del" aria-label="사진 삭제">×</button>
          </div>
        `).join('')}
      </div>
    ` : '';
    return `
      <div class="multi-card${e.excluded ? ' excluded' : ''}" data-idx="${idx}">
        <button type="button" class="toggle-exclude">${e.excluded ? '포함' : '제외'}</button>
        <div class="head">
          <input type="date" class="date-in" value="${escapeAttr(e.date)}" />
          ${e.weekday ? `<span class="weekday">${escapeHtml(e.weekday)}</span>` : ''}
        </div>
        <textarea class="content-in" rows="4" placeholder="본문">${escapeHtml(e.content)}</textarea>
        <input type="text" class="tags-in" placeholder="태그 (쉼표로 구분)" value="${escapeAttr(e.tags.join(', '))}" />
        ${photosHtml}
      </div>
    `;
  }).join('');
  list.querySelectorAll('.multi-card').forEach(card => {
    const idx = parseInt(card.dataset.idx, 10);
    card.querySelector('.toggle-exclude').onclick = () => {
      multiEntries[idx].excluded = !multiEntries[idx].excluded;
      renderMultiEntries();
      saveDraftDebounced();
    };
    card.querySelector('.date-in').onchange = (ev) => { multiEntries[idx].date = ev.target.value; saveDraftDebounced(); };
    card.querySelector('.content-in').onchange = (ev) => { multiEntries[idx].content = ev.target.value; saveDraftDebounced(); };
    card.querySelector('.tags-in').onchange = (ev) => {
      multiEntries[idx].tags = ev.target.value.split(/[,\s]+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean);
      saveDraftDebounced();
    };
    card.querySelectorAll('.multi-photo-thumb').forEach(thumb => {
      const pIdx = parseInt(thumb.dataset.pidx, 10);
      thumb.querySelector('.del').onclick = (ev) => {
        ev.stopPropagation();
        multiEntries[idx].photos.splice(pIdx, 1);
        renderMultiEntries();
        saveDraftDebounced();
      };
      thumb.querySelector('img').onclick = () => openPhotoViewer(thumb.querySelector('img').src);
    });
  });
}

async function fetchFromServer() {
  try {
    const res = await fetch(`${API_BASE}/api/data`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && Array.isArray(json.entries)) return json;
  } catch (e) {}
  return null;
}

async function loadInitial() {
  const remote = await fetchFromServer();
  if (remote) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(remote)); } catch (e) {}
    return migrate(remote);
  }
  const local = loadLocal();
  if (local) return migrate(local);
  try {
    const res = await fetch('data/default.json?t=' + Date.now());
    if (res.ok) {
      const json = await res.json();
      if (json) return migrate(json);
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

// ── 편집 토큰 ─────────────────────────────────
function getEditToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

function promptEditToken() {
  const cur = getEditToken();
  const v = prompt(cur ? '편집 비밀번호 (비우면 로그아웃):' : '편집 비밀번호를 입력하세요:', cur);
  if (v === null) return;
  if (v === '') localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, v.trim());
  updateEditUI();
  if (getEditToken()) pushToServer();
  else setSyncStatus('readonly');
}

function updateEditUI() {
  const has = !!getEditToken();
  document.body.classList.toggle('read-only', !has);
  const btn = document.getElementById('btnEdit');
  if (btn) btn.textContent = has ? '🔓' : '🔒';
  if (!has) setSyncStatus('readonly');
}

function ensureEditable() {
  if (!getEditToken()) {
    alert('편집하려면 비밀번호를 먼저 설정하세요. (설정 → 편집 권한)');
    return false;
  }
  return true;
}

// ── 사진 처리 (브라우저에서 축소) ────────────────
async function processPhotoFile(file) {
  if (!file || !file.type.startsWith('image/')) return null;
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImage(dataUrl);
  const { canvas, mime } = drawScaled(img, PHOTO_MAX_DIM);
  const out = canvas.toDataURL(mime, PHOTO_JPEG_QUALITY);
  return { id: nextPhotoId(), url: out };
}
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}
function drawScaled(img, maxDim) {
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (w > maxDim || h > maxDim) {
    if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
    else        { w = Math.round(w * maxDim / h); h = maxDim; }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas: c, mime: 'image/jpeg' };
}

// 정규화 bbox [x,y,w,h] (0~1) 기준으로 sourceDataUrl 에서 잘라내 photo 객체 반환
async function cropPhotoFromBbox(sourceDataUrl, bbox) {
  const [nx, ny, nw, nh] = bbox;
  const img = await loadImage(sourceDataUrl);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  // 픽셀 좌표 (가벼운 패딩 — claude 좌표가 살짝 빗나가도 잘림 줄이려고 2% margin)
  const pad = 0.005;
  const sx = Math.max(0, Math.round((nx - pad) * W));
  const sy = Math.max(0, Math.round((ny - pad) * H));
  const sw = Math.min(W - sx, Math.round((nw + pad * 2) * W));
  const sh = Math.min(H - sy, Math.round((nh + pad * 2) * H));
  if (sw <= 0 || sh <= 0) return null;
  // 우선 원본 픽셀 그대로 캔버스에
  const c1 = document.createElement('canvas');
  c1.width = sw; c1.height = sh;
  c1.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  // CROP_MAX_DIM 으로 축소 (저장 용량 절감)
  let outW = sw, outH = sh;
  if (outW > CROP_MAX_DIM || outH > CROP_MAX_DIM) {
    if (outW >= outH) { outH = Math.round(outH * CROP_MAX_DIM / outW); outW = CROP_MAX_DIM; }
    else              { outW = Math.round(outW * CROP_MAX_DIM / outH); outH = CROP_MAX_DIM; }
  }
  const c2 = document.createElement('canvas');
  c2.width = outW; c2.height = outH;
  c2.getContext('2d').drawImage(c1, 0, 0, outW, outH);
  return { id: nextPhotoId(), url: c2.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY) };
}

// ── 집계 ────────────────────────────────────────
function entriesOfDate(ds) {
  return state.entries.filter(e => e.date === ds);
}
function entriesOfMonth(mk) {
  return state.entries.filter(e => (e.date || '').slice(0, 7) === mk);
}
function allTags() {
  const counts = {};
  for (const e of state.entries) {
    for (const t of (e.tags || [])) {
      const k = String(t).trim();
      if (!k) continue;
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// ── 렌더 ────────────────────────────────────────
function render() {
  document.getElementById('monthLabel').textContent = fmtMonth(viewMonth);
  renderCalendar();
  if (activeTab === 'diary')    renderDayList();
  if (activeTab === 'search')   renderSearch();
  if (activeTab === 'settings') renderSettings();
}

function renderCalendar() {
  const cal = document.getElementById('calendar');
  const [y, m] = viewMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const prevDays = new Date(y, m - 1, 0).getDate();
  const today = todayStr();

  const monthEntries = entriesOfMonth(viewMonth);
  const hasEntryByDay = {};
  for (const e of monthEntries) {
    const d = parseInt((e.date || '').slice(8, 10), 10);
    if (d) hasEntryByDay[d] = true;
  }

  let html = `
    <div class="cal-weekdays">
      <div class="sun">일</div><div>월</div><div>화</div><div>수</div><div>목</div><div>금</div><div class="sat">토</div>
    </div>
    <div class="cal-grid">
  `;

  // 이전 달 빈칸
  for (let i = startWeekday - 1; i >= 0; i--) {
    const d = prevDays - i;
    html += `<button class="cal-cell other-month" disabled><span class="day-num">${d}</span></button>`;
  }
  // 이번 달
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const weekday = new Date(y, m - 1, d).getDay();
    const cls = [
      'cal-cell',
      weekday === 0 ? 'sun' : '',
      weekday === 6 ? 'sat' : '',
      ds === today ? 'today' : '',
      ds === selectedDate ? 'selected' : '',
      hasEntryByDay[d] ? 'has-entry' : '',
    ].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-date="${ds}"><span class="day-num">${d}</span></button>`;
  }
  // 다음 달 빈칸 (7의 배수로)
  const totalCells = startWeekday + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= trailing; i++) {
    html += `<button class="cal-cell other-month" disabled><span class="day-num">${i}</span></button>`;
  }
  html += `</div>`;
  cal.innerHTML = html;

  cal.querySelectorAll('.cal-cell[data-date]').forEach(btn => {
    btn.onclick = () => {
      selectedDate = btn.dataset.date;
      render();
    };
  });
}

function renderDayList() {
  const list = document.getElementById('diaryList');
  const label = document.getElementById('selectedDateLabel');
  const count = document.getElementById('dayCount');

  label.textContent = selectedDate === todayStr() ? `오늘 — ${fmtDateLong(selectedDate)}` : fmtDateLong(selectedDate);

  const dayEntries = entriesOfDate(selectedDate)
    .slice()
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

  count.textContent = dayEntries.length ? `${dayEntries.length}편` : '';

  if (!dayEntries.length) {
    list.innerHTML = `<div class="diary-empty">이 날엔 일기가 없어요. <br>오른쪽 아래 ＋ 로 첫 일기를 써보세요.</div>`;
    return;
  }
  list.innerHTML = dayEntries.map(diaryCardHtml).join('');
  bindCardClicks(list);
}

function diaryCardHtml(e) {
  const tags = (e.tags || []).length
    ? `<div class="tags">${e.tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  const photos = (e.photos || []).length
    ? `<div class="photos">${e.photos.map(p => `<img src="${escapeAttr(p.url)}" alt="" />`).join('')}</div>`
    : '';
  const content = e.content
    ? `<div class="content">${escapeHtml(e.content)}</div>`
    : `<div class="content muted">(내용 없음)</div>`;
  return `
    <article class="diary-card" data-id="${escapeAttr(e.id)}">
      <div class="card-head">
        <span class="date">${escapeHtml(fmtDate(e.date))}</span>
      </div>
      ${content}
      ${tags}
      ${photos}
    </article>
  `;
}

function bindCardClicks(container) {
  container.querySelectorAll('.diary-card').forEach(card => {
    card.onclick = (ev) => {
      // 사진 클릭 시 뷰어 모달
      const img = ev.target.closest('.photos img');
      if (img) {
        ev.stopPropagation();
        openPhotoViewer(img.src);
        return;
      }
      openDiaryDialog(card.dataset.id);
    };
  });
}

function renderSearch() {
  const tagCloud = document.getElementById('tagCloud');
  const tagsCount = document.getElementById('tagsCount');
  const results = document.getElementById('searchResults');
  const searchCount = document.getElementById('searchCount');
  const tags = allTags();
  tagsCount.textContent = tags.length ? `${tags.length}개` : '';

  if (!tags.length) {
    tagCloud.innerHTML = `<span class="muted">아직 태그가 없어요.</span>`;
  } else {
    tagCloud.innerHTML = tags.map(([t, c]) => `
      <button type="button" class="tag-chip${activeTagFilter === t ? ' active' : ''}" data-tag="${escapeAttr(t)}">
        #${escapeHtml(t)}<span class="count">${c}</span>
      </button>
    `).join('');
    tagCloud.querySelectorAll('.tag-chip').forEach(chip => {
      chip.onclick = () => {
        activeTagFilter = (activeTagFilter === chip.dataset.tag) ? '' : chip.dataset.tag;
        renderSearch();
      };
    });
  }

  const q = searchQuery.trim().toLowerCase();
  let filtered = state.entries.slice();
  if (activeTagFilter) {
    filtered = filtered.filter(e => (e.tags || []).includes(activeTagFilter));
  }
  if (q) {
    filtered = filtered.filter(e =>
      (e.title || '').toLowerCase().includes(q) ||
      (e.content || '').toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }
  filtered.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.created_at || '').localeCompare(a.created_at || ''));

  searchCount.textContent = filtered.length ? `${filtered.length}편` : '';
  if (!filtered.length) {
    results.innerHTML = `<div class="diary-empty">${q || activeTagFilter ? '결과가 없어요.' : '검색어나 태그를 선택하세요.'}</div>`;
    return;
  }
  results.innerHTML = filtered.map(diaryCardHtml).join('');
  bindCardClicks(results);
}

function renderSettings() {
  const hint = document.getElementById('storageHint');
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || '';
    const kb = Math.round(raw.length / 1024);
    const total = state.entries.length;
    const photoCount = state.entries.reduce((s, e) => s + (e.photos || []).length, 0);
    hint.textContent = `총 ${total}편 · 사진 ${photoCount}장 · 저장 크기 ${kb.toLocaleString()} KB`;
  } catch (e) {
    hint.textContent = '';
  }
}

// ── 다이얼로그 ─────────────────────────────────
function openDiaryDialog(editId) {
  if (!editId && !ensureEditable()) return;
  editEntryId = editId || null;
  multiEntries = [];
  const dlg = document.getElementById('diaryDialog');
  const fYear = document.getElementById('fYear');
  const fDate = document.getElementById('fDate');
  const fContent = document.getElementById('fContent');
  const fTags = document.getElementById('fTags');
  const footer = dlg.querySelector('.dialog-footer');
  const title = document.getElementById('diaryDialogTitle');

  // single 영역 보이게 (multi 잔존 방지)
  document.getElementById('singleEntrySection').classList.remove('hidden');
  document.getElementById('multiSection').classList.add('hidden');

  if (editEntryId) {
    const e = state.entries.find(x => x.id === editEntryId);
    if (!e) { editEntryId = null; return; }
    title.textContent = '일기 편집';
    fYear.value = (e.date || '').slice(0, 4) || new Date().getFullYear();
    fDate.value = e.date || todayStr();
    fContent.value = e.content || '';
    fTags.value = (e.tags || []).join(', ');
    editingPhotos = (e.photos || []).map(p => ({ id: p.id, url: p.url }));
    footer.classList.remove('hidden');
  } else {
    title.textContent = '새 일기';
    const baseDate = selectedDate || todayStr();
    fYear.value = baseDate.slice(0, 4);
    fDate.value = baseDate;
    fContent.value = '';
    fTags.value = '';
    editingPhotos = [];
    footer.classList.add('hidden');
  }
  renderPhotoThumbs();
  setOcrStatus('');
  if (!dlg.open) {
    dlg.showModal();
    pushLayer('diary-modal');
  }
  saveDraftNow();

  // 편집 권한 없으면 입력 잠금 (열람만)
  const readOnly = !getEditToken();
  [fDate, fContent, fTags, fYear].forEach(el => { el.readOnly = readOnly; el.disabled = readOnly && (el === fDate || el === fYear); });
  document.getElementById('diarySave').style.display = readOnly ? 'none' : '';
  document.getElementById('fPhoto').disabled = readOnly;
  document.querySelector('.photo-add-btn').style.display = readOnly ? 'none' : '';
  if (readOnly) footer.classList.add('hidden');
}

function closeDiaryDialog() {
  const dlg = document.getElementById('diaryDialog');
  if (dlg.open) dlg.close();
  editEntryId = null;
  editingPhotos = [];
  multiEntries = [];
  clearDraft();
  popLayerIfMatches('diary-modal');
}

function renderPhotoThumbs() {
  const wrap = document.getElementById('photoThumbs');
  wrap.innerHTML = editingPhotos.map(p => `
    <div class="photo-thumb" data-id="${escapeAttr(p.id)}">
      <img src="${escapeAttr(p.url)}" alt="" />
      <button type="button" class="del" aria-label="삭제">×</button>
    </div>
  `).join('');
  wrap.querySelectorAll('.photo-thumb').forEach(t => {
    const id = t.dataset.id;
    t.querySelector('.del').onclick = (ev) => {
      ev.stopPropagation();
      editingPhotos = editingPhotos.filter(p => p.id !== id);
      renderPhotoThumbs();
      saveDraftDebounced();
    };
    t.querySelector('img').onclick = () => openPhotoViewer(t.querySelector('img').src);
  });
}

function saveDiary() {
  if (!ensureEditable()) return;

  // 다중 모드 — multiEntries 중 excluded 아닌 것들 일괄 저장 (사진은 첨부 안 함)
  if (multiEntries.length > 0) {
    const toSave = multiEntries.filter(e => !e.excluded);
    const invalid = toSave.filter(e => !e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !e.content);
    if (invalid.length) {
      alert(`${invalid.length}편의 항목에 날짜 또는 본문이 없습니다. 수정하거나 '제외' 처리하세요.`);
      return;
    }
    if (!toSave.length) {
      alert('저장할 일기가 없습니다. 최소 1편은 포함하세요.');
      return;
    }
    const ts = nowIso();
    for (const e of toSave) {
      state.entries.push({
        id: nextEntryId(),
        date: e.date,
        content: e.content || '',
        tags: e.tags || [],
        photos: (e.photos || []).slice(),
        created_at: ts,
        updated_at: ts,
      });
    }
    selectedDate = toSave[0].date;
    saveLocal();
    closeDiaryDialog();
    render();
    return;
  }

  // 단일 모드 — 기존 동작
  const date = document.getElementById('fDate').value || todayStr();
  const content = document.getElementById('fContent').value.trim();
  const tagsRaw = document.getElementById('fTags').value;
  const tags = tagsRaw.split(/[,\s]+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean);

  if (!content && !editingPhotos.length) {
    alert('본문 또는 사진은 있어야 합니다.');
    return;
  }

  if (editEntryId) {
    const e = state.entries.find(x => x.id === editEntryId);
    if (!e) return;
    e.date = date;
    e.content = content;
    e.tags = tags;
    e.photos = editingPhotos.slice();
    e.updated_at = nowIso();
    delete e.title;   // 옛 데이터에 남아있던 title 제거 (필드 자체 삭제)
  } else {
    state.entries.push({
      id: nextEntryId(),
      date, content, tags,
      photos: editingPhotos.slice(),
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }
  selectedDate = date;
  saveLocal();
  closeDiaryDialog();
  render();
}

function deleteDiary() {
  if (!ensureEditable() || !editEntryId) return;
  if (!confirm('이 일기를 삭제할까요?')) return;
  state.entries = state.entries.filter(e => e.id !== editEntryId);
  saveLocal();
  closeDiaryDialog();
  render();
}

function openPhotoViewer(src) {
  const dlg = document.getElementById('photoViewer');
  document.getElementById('photoViewerImg').src = src;
  if (!dlg.open) {
    dlg.showModal();
    pushLayer('photo-viewer');
  }
}
function closePhotoViewer() {
  const dlg = document.getElementById('photoViewer');
  if (dlg.open) dlg.close();
  popLayerIfMatches('photo-viewer');
}

// ── 데이터 내보내기/가져오기 ────────────────────
function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `diary-young-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importJson(file) {
  if (!ensureEditable()) return;
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.entries)) {
      alert('형식이 올바르지 않습니다 (entries 배열 필요).');
      return;
    }
    if (!confirm(`${parsed.entries.length}편의 일기로 덮어쓸까요? (현재 데이터는 사라집니다)`)) return;
    state = migrate(parsed);
    saveLocal();
    render();
  } catch (e) {
    alert('JSON 파싱 실패');
  }
}

// ── 탭 ─────────────────────────────────────────
function setActiveTab(tab, opts) {
  const prev = activeTab;
  activeTab = tab;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.tab !== tab));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  render();

  // history 동기화 (뒤로가기로 들어온 경우엔 건드리지 않음)
  if (opts && opts.fromBack) return;
  const onDefault = tab === 'diary';
  const wasOnDefault = prev === 'diary';
  if (onDefault && !wasOnDefault) {
    popLayerIfMatches('tab');
  } else if (!onDefault && wasOnDefault) {
    pushLayer('tab');
  } else if (!onDefault && !wasOnDefault) {
    // 비기본 탭끼리 전환 — 레이어 누적 대신 replace
    history.replaceState({ app: 'diary-young', layer: 'tab' }, '');
  }
}

// ── 부트스트랩 ───────────────────────────────────
function bindUI() {
  document.getElementById('btnPrevMonth').onclick = () => { viewMonth = shiftMonth(viewMonth, -1); render(); };
  document.getElementById('btnNextMonth').onclick = () => { viewMonth = shiftMonth(viewMonth, +1); render(); };
  document.getElementById('monthLabel').onclick = () => {
    const v = prompt('이동할 달 (YYYY-MM):', viewMonth);
    if (v && /^\d{4}-\d{2}$/.test(v)) { viewMonth = v; render(); }
  };
  document.getElementById('btnEdit').onclick = promptEditToken;
  document.getElementById('btnAdd').onclick = () => openDiaryDialog(null);

  document.querySelectorAll('.tab-btn').forEach(b => {
    b.onclick = () => setActiveTab(b.dataset.tab);
  });

  // 다이얼로그
  document.getElementById('diaryCancel').onclick = closeDiaryDialog;
  document.getElementById('btnMultiReset').onclick = () => {
    if (multiEntries.length && !confirm('인식된 일기 검토를 취소하고 단일 입력으로 돌아갈까요?')) return;
    exitMultiMode();
  };
  document.getElementById('diaryDialog').addEventListener('cancel', (e) => { e.preventDefault(); closeDiaryDialog(); });
  document.getElementById('diaryForm').addEventListener('submit', (e) => { e.preventDefault(); saveDiary(); });
  document.getElementById('diaryDelete').onclick = deleteDiary;

  // 단일 모드 입력 — 드래프트 자동 저장
  ['fYear', 'fDate', 'fContent', 'fTags'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', saveDraftDebounced);
  });
  document.getElementById('fTextFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    await importTextFile(file);
  });
  document.getElementById('fPhoto').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    const wasEmpty = editingPhotos.length === 0;
    const isNewEntry = !editEntryId;
    let firstAdded = null;
    for (const f of files) {
      try {
        const p = await processPhotoFile(f);
        if (p) {
          editingPhotos.push(p);
          if (!firstAdded) firstAdded = p;
        }
      } catch (err) {
        alert('사진 처리 실패: ' + (err.message || err));
      }
    }
    e.target.value = '';
    renderPhotoThumbs();
    saveDraftDebounced();
    // 새 일기 + 첫 사진 → OCR 자동 인식
    if (firstAdded && wasEmpty && isNewEntry) {
      ocrFirstPhoto(firstAdded);
    }
  });

  // 사진 뷰어
  document.getElementById('photoClose').onclick = closePhotoViewer;
  document.getElementById('photoViewer').addEventListener('click', (e) => {
    if (e.target.id === 'photoViewer') closePhotoViewer();
  });
  document.getElementById('photoViewer').addEventListener('cancel', (e) => { e.preventDefault(); closePhotoViewer(); });

  // 검색
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderSearch();
  });
  document.getElementById('btnClearSearch').onclick = () => {
    searchInput.value = '';
    searchQuery = '';
    activeTagFilter = '';
    renderSearch();
  };

  // 설정
  document.getElementById('btnTokenEdit').onclick = promptEditToken;
  document.getElementById('btnExport').onclick = exportJson;
  document.getElementById('fileImport').addEventListener('change', (e) => {
    importJson(e.target.files && e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('btnRefresh').onclick = async () => {
    setSyncStatus('saving');
    const remote = await fetchFromServer();
    if (remote) {
      state = migrate(remote);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
      setSyncStatus(getEditToken() ? 'saved' : 'readonly');
      render();
    } else {
      setSyncStatus('error');
    }
  };
}

function restoreDraftIfAny() {
  const d = loadDraft();
  if (!d) return;
  // 권한 없으면 복원 불가 (편집 불가능)
  if (!getEditToken()) { clearDraft(); return; }
  if (d.kind === 'multi' && Array.isArray(d.multiEntries) && d.multiEntries.length) {
    editEntryId = d.editEntryId || null;
    editingPhotos = [];
    multiEntries = d.multiEntries.map(e => ({
      date: e.date || '', weekday: e.weekday || '',
      content: e.content || '',
      tags: Array.isArray(e.tags) ? e.tags.slice() : [],
      photos: Array.isArray(e.photos) ? e.photos.map(p => ({ id: p.id, url: p.url })) : [],
      excluded: !!e.excluded,
    }));
    const dlg = document.getElementById('diaryDialog');
    const footer = dlg.querySelector('.dialog-footer');
    footer.classList.add('hidden');
    document.getElementById('fYear').value = d.year || new Date().getFullYear();
    enterMultiMode();
    if (!dlg.open) { dlg.showModal(); pushLayer('diary-modal'); }
    setOcrStatus('💾 이전 작업 복원됨');
    setTimeout(() => setOcrStatus(''), 3000);
  } else if (d.kind === 'single') {
    editEntryId = d.editEntryId || null;
    editingPhotos = Array.isArray(d.editingPhotos) ? d.editingPhotos.map(p => ({ id: p.id, url: p.url })) : [];
    const dlg = document.getElementById('diaryDialog');
    const footer = dlg.querySelector('.dialog-footer');
    document.getElementById('singleEntrySection').classList.remove('hidden');
    document.getElementById('multiSection').classList.add('hidden');
    document.getElementById('diaryDialogTitle').textContent = editEntryId ? '일기 편집' : '새 일기';
    document.getElementById('fYear').value = d.year || new Date().getFullYear();
    document.getElementById('fDate').value = d.date || todayStr();
    document.getElementById('fContent').value = d.content || '';
    document.getElementById('fTags').value = d.tags || '';
    renderPhotoThumbs();
    if (editEntryId) footer.classList.remove('hidden'); else footer.classList.add('hidden');
    if (!dlg.open) { dlg.showModal(); pushLayer('diary-modal'); }
    setOcrStatus('💾 이전 작업 복원됨');
    setTimeout(() => setOcrStatus(''), 3000);
  } else {
    clearDraft();
  }
}

async function bootstrap() {
  bindUI();
  bindBackButton();
  updateEditUI();
  state = await loadInitial();
  viewMonth = monthKey(new Date());
  selectedDate = todayStr();
  setSyncStatus(getEditToken() ? 'idle' : 'readonly');
  render();
  restoreDraftIfAny();
  // 백그라운드 진입 / 페이지 숨김 시 드래프트 즉시 저장 (iOS 메모리 회수 대비)
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveDraftNow(); });
  window.addEventListener('pagehide', saveDraftNow);
  window.addEventListener('beforeunload', saveDraftNow);
}

bootstrap();
