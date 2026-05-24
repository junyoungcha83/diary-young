// diary-young — 모바일 일기 PWA
// 상태는 JSON 한 덩어리(entries) → localStorage 캐시 + 서버 KV 동기화.
// 사진은 클라이언트에서 축소 후 base64로 entry.photos[].url 에 저장.

const STORAGE_KEY = 'diary-young-state-v1';
const TOKEN_KEY   = 'diary-young-edit-token';
const API_BASE    = 'https://diary-young-api.junyoung-cha83.workers.dev';
const SAVE_DEBOUNCE_MS = 800;

const PHOTO_MAX_DIM = 1024;        // 최대 한 변 1024px 로 축소
const PHOTO_JPEG_QUALITY = 0.78;

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
  const title = e.title
    ? `<div class="title">${escapeHtml(e.title)}</div>`
    : `<div class="title untitled">(제목 없음)</div>`;
  const tags = (e.tags || []).length
    ? `<div class="tags">${e.tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  const photos = (e.photos || []).length
    ? `<div class="photos">${e.photos.map(p => `<img src="${escapeAttr(p.url)}" alt="" />`).join('')}</div>`
    : '';
  const content = e.content
    ? `<div class="content">${escapeHtml(e.content)}</div>`
    : '';
  return `
    <article class="diary-card" data-id="${escapeAttr(e.id)}">
      <div class="card-head">
        ${title}
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
  const dlg = document.getElementById('diaryDialog');
  const fDate = document.getElementById('fDate');
  const fTitle = document.getElementById('fTitle');
  const fContent = document.getElementById('fContent');
  const fTags = document.getElementById('fTags');
  const footer = dlg.querySelector('.dialog-footer');
  const title = document.getElementById('diaryDialogTitle');

  if (editEntryId) {
    const e = state.entries.find(x => x.id === editEntryId);
    if (!e) { editEntryId = null; return; }
    title.textContent = '일기 편집';
    fDate.value = e.date || todayStr();
    fTitle.value = e.title || '';
    fContent.value = e.content || '';
    fTags.value = (e.tags || []).join(', ');
    editingPhotos = (e.photos || []).map(p => ({ id: p.id, url: p.url }));
    footer.classList.remove('hidden');
  } else {
    title.textContent = '새 일기';
    fDate.value = selectedDate || todayStr();
    fTitle.value = '';
    fContent.value = '';
    fTags.value = '';
    editingPhotos = [];
    footer.classList.add('hidden');
  }
  renderPhotoThumbs();
  if (!dlg.open) dlg.showModal();

  // 편집 권한 없으면 입력 잠금 (열람만)
  const readOnly = !getEditToken();
  [fDate, fTitle, fContent, fTags].forEach(el => { el.readOnly = readOnly; el.disabled = readOnly && el === fDate; });
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
    };
    t.querySelector('img').onclick = () => openPhotoViewer(t.querySelector('img').src);
  });
}

function saveDiary() {
  if (!ensureEditable()) return;
  const date = document.getElementById('fDate').value || todayStr();
  const title = document.getElementById('fTitle').value.trim();
  const content = document.getElementById('fContent').value.trim();
  const tagsRaw = document.getElementById('fTags').value;
  const tags = tagsRaw.split(/[,\s]+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean);

  if (!content && !title && !editingPhotos.length) {
    alert('제목, 본문, 사진 중 하나는 있어야 합니다.');
    return;
  }

  if (editEntryId) {
    const e = state.entries.find(x => x.id === editEntryId);
    if (!e) return;
    e.date = date;
    e.title = title;
    e.content = content;
    e.tags = tags;
    e.photos = editingPhotos.slice();
    e.updated_at = nowIso();
  } else {
    state.entries.push({
      id: nextEntryId(),
      date, title, content, tags,
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
  if (!dlg.open) dlg.showModal();
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
function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.tab !== tab));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  render();
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
  document.getElementById('diaryDialog').addEventListener('cancel', (e) => { e.preventDefault(); closeDiaryDialog(); });
  document.getElementById('diaryForm').addEventListener('submit', (e) => { e.preventDefault(); saveDiary(); });
  document.getElementById('diaryDelete').onclick = deleteDiary;
  document.getElementById('fPhoto').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      try {
        const p = await processPhotoFile(f);
        if (p) editingPhotos.push(p);
      } catch (err) {
        alert('사진 처리 실패: ' + (err.message || err));
      }
    }
    e.target.value = '';
    renderPhotoThumbs();
  });

  // 사진 뷰어
  document.getElementById('photoClose').onclick = () => {
    const dlg = document.getElementById('photoViewer');
    if (dlg.open) dlg.close();
  };
  document.getElementById('photoViewer').addEventListener('click', (e) => {
    if (e.target.id === 'photoViewer') {
      const dlg = document.getElementById('photoViewer');
      if (dlg.open) dlg.close();
    }
  });

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

async function bootstrap() {
  bindUI();
  updateEditUI();
  state = await loadInitial();
  // 이번 달에 일기가 있고 오늘 데이터가 비어있으면, viewMonth 만 따라간다
  viewMonth = monthKey(new Date());
  selectedDate = todayStr();
  setSyncStatus(getEditToken() ? 'idle' : 'readonly');
  render();
}

bootstrap();
