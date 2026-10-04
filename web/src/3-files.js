
/* ---------- state ---------- */
const S = { stores: [], store: null, path: '', items: [], q: '', view: keep.get('view') === 'list' ? 'list' : 'grid', sec: 'files', workers: [], has: {}, authed: false, me: null, peopleStore: null };
const segs = p => p ? p.split('/') : [];
const ROLE = { R: 'просмотр', W: 'редактор', A: 'админ' };
const ICON = { folder: 'folder', image: 'image', video: 'movie', pdf: 'picture_as_pdf', archive: 'folder_zip', audio: 'music_note', sheet: 'description', doc: 'description' };
function kindOf(name, isFile = true) {
  if (!isFile) return 'folder';
  const e = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'heic', 'webp', 'gif', 'svg', 'bmp', 'avif'].includes(e)) return 'image';
  if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'].includes(e)) return 'video';
  if (e === 'pdf') return 'pdf';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2'].includes(e)) return 'archive';
  if (['mp3', 'flac', 'wav', 'ogg', 'm4a', 'opus', 'aac'].includes(e)) return 'audio';
  if (['xlsx', 'xls', 'csv', 'ods'].includes(e)) return 'sheet';
  return 'doc';
}
const TONES = ['signal', 'mint', 'ember'];

/* ---------- routing: #/files/<id>/<path>, #/bots, #/people/<id> ---------- */
function hashFor(sec, id, path = '') {
  if (sec === 'files') return id ? `#/files/${id}${path ? '/' + encPath(path) : ''}` : '#/files';
  if (sec === 'people') return `#/people${id ? '/' + id : ''}`;
  return '#/' + sec;
}
function setHash(h, push) { if (location.hash !== h) history[push ? 'pushState' : 'replaceState'](null, '', h); }
function parseHash() {
  const [sec, id, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  let path = '';
  try { path = rest.map(decodeURIComponent).join('/'); } catch (e) { }
  return { sec: sec || 'files', id: id || null, path };
}
addEventListener('popstate', () => { if (S.authed) route(parseHash(), false); });
function route(r, push) {
  if (r.sec === 'bots') return showSection('bots', push);
  if (r.sec === 'people') { if (r.id) S.peopleStore = r.id; return showSection('people', push); }
  const st = S.stores.find(s => s.id === r.id) || S.store || S.stores[0];
  if (!st) { S.store = null; showSection('files', push); renderNoStores(); return; }
  openStore(st, st.id === r.id ? r.path : '', push);
}

/* ---------- storages ---------- */
// Pentaract hides a storage from its list when it holds folders but no files,
// so every storage this browser has seen is remembered and fetched directly.
const knownKey = () => 'known:' + ((S.me && S.me.sub) || 'anon');
async function loadStores() {
  const res = await API.storages();
  const list = ((res && res.storages) || []).map(s => ({ ...s }));
  let known = [];
  try { known = JSON.parse(keep.get(knownKey()) || '[]'); } catch (e) { }
  for (const id of known.filter(id => !list.some(s => s.id === id))) {
    try { const s = await API.storage(id); if (s) list.push({ ...s, size: 0, files_amount: 0 }); } catch (e) { if (e.status === 401) return; }
  }
  S.stores = list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  keep.set(knownKey(), JSON.stringify(S.stores.map(s => s.id)));
  if (S.store) S.store = S.stores.find(s => s.id === S.store.id) || S.store;
  renderStores(); fillSelects();
}
async function loadWorkers() {
  try { S.workers = (await API.workers()) || []; } catch (e) { if (e.status !== 401) S.workers = []; }
  $('#bots-count').textContent = S.workers.length || '';
}
async function storeHasBots(id, force = false) {
  if (!force && id in S.has) return S.has[id];
  try { S.has[id] = !!(await API.hasWorkers(id)).has; } catch (e) { S.has[id] = true; }
  return S.has[id];
}
function renderStores() {
  const box = $('#stores'); $$('.store', box).forEach(e => e.remove());
  for (const s of S.stores) {
    const b = document.createElement('button'), files = s.files_amount || 0;
    b.type = 'button'; b.dataset.id = s.id;
    b.className = 'store' + (S.store && s.id === S.store.id && S.sec === 'files' ? ' is-active' : '');
    b.style.setProperty('--tone', `var(--${TONES[hash(s.id) % 3]})`);
    b.innerHTML = `<span class="av">${esc((s.name[0] || '?').toUpperCase())}</span><span class="t"><span class="n">${esc(s.name)}</span><span class="m">${nf0.format(files)} ${plural(files, W_FILE)} · ${fmtSize(s.size || 0)}</span></span>`;
    b.addEventListener('click', () => openStore(s, ''));
    box.appendChild(b);
  }
  movePill();
}
function movePill() {
  const pill = $('#store-pill'), a = $('.store.is-active');
  if (!a) { pill.style.opacity = 0; return; }
  pill.style.opacity = 1; pill.style.transform = `translateY(${a.offsetTop}px)`; pill.style.height = a.offsetHeight + 'px';
}
function fillSelects() {
  const opts = S.stores.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  for (const id of ['#bot-store', '#p-store']) { const el = $(id), v = el.value; el.innerHTML = opts; if (v && S.stores.some(s => s.id === v)) el.value = v; }
  if (S.store) $('#bot-store').value = S.store.id;
}
function showSection(sec, push = true) {
  S.sec = sec;
  $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + sec; });
  $$('#nav button').forEach(b => b.classList.toggle('is-active', b.dataset.sec === sec));
  $$('.store').forEach(b => b.classList.toggle('is-active', sec === 'files' && !!S.store && b.dataset.id === S.store.id));
  movePill(); closeDrawer();
  if (sec === 'bots') { setHash('#/bots', push); renderBots(); loadWorkers().then(renderBots); }
  if (sec === 'people') { setHash(hashFor('people', S.peopleStore), push); renderPeople(); }
  scrollTo({ top: 0, behavior: reduced.matches ? 'auto' : 'smooth' });
}

/* ---------- files ---------- */
async function openStore(st, path = '', push = true) {
  S.store = st; S.path = path; S.q = ''; $('#q').value = '';
  showSection('files', false);
  setHash(hashFor('files', st.id, path), push);
  await loadTree();
}
async function loadTree(quiet = false) {
  const st = S.store, path = S.path;
  if (!st) return;
  if (!quiet) renderSkeleton();
  try {
    const [items] = await Promise.all([API.tree(st.id, path), storeHasBots(st.id)]);
    if (!S.store || S.store.id !== st.id || S.path !== path) return;
    S.items = items || [];
    renderFiles(quiet);
  } catch (e) {
    if (e.status === 401 || !S.store || S.store.id !== st.id) return;
    $('#grid').innerHTML = `<div class="empty glass"><span class="ms" aria-hidden="true">close</span><h3>Не получилось открыть</h3><p>${esc(errText(e))}</p></div>`;
  }
}
function renderSkeleton() {
  const g = $('#grid'); g.classList.toggle('is-list', S.view === 'list'); g.classList.add('quiet');
  g.innerHTML = '<div class="skel"></div>'.repeat(6);
}
function renderNoStores() {
  $('#crumbs').innerHTML = ''; $('#title').textContent = 'Добро пожаловать'; $('#sub').textContent = 'Хранилищ пока нет.';
  for (const id of ['#st-size', '#st-files', '#st-bots']) { $(id).textContent = '0'; $(id).dataset.v = 0; }
  $('#grid').innerHTML = `<div class="empty glass"><span class="ms" aria-hidden="true">database</span><h3>Создай первое хранилище</h3><p>Хранилище — это приватный канал в Telegram, куда боты складывают куски твоих файлов.</p><button class="btn primary" type="button" data-act="new-store">Создать хранилище</button></div>`;
}
function cardHTML(n, i, extra = '') {
  const k = kindOf(n.name, n.is_file), h = hash(n.name) % 360, ext = (n.name.includes('.') ? n.name.split('.').pop() : '').toUpperCase();
  let sub, dots = '';
  if (!n.is_file) sub = n.size ? fmtSize(n.size) : 'пустая';
  else {
    sub = fmtSize(n.size); const c = chunksOf(n.size);
    dots = `<span class="dots" title="${c} ${plural(c, W_CHUNK)} по 20 МБ">${'<i></i>'.repeat(Math.min(c, 6))}${c > 6 ? `<em>+${c - 6}</em>` : ''}</span>`;
  }
  const badge = (k === 'image' || k === 'video') && ext ? `<span class="badge">${esc(ext)}</span>` : '';
  return `<button type="button" class="card glass ${extra}" data-path="${esc(n.path)}" style="--i:${Math.min(i, 24)}"><span class="thumb k-${k}" style="--h:${h}"><span class="ms" aria-hidden="true">${ICON[k]}</span>${badge}</span><span class="cmeta"><span class="cname" title="${esc(n.name)}">${esc(n.name)}</span><span class="csub"><span>${sub}</span>${dots}</span></span></button>`;
}
function renderFiles(quiet = false) {
  const st = S.store, q = S.q.trim().toLowerCase();
  let items = S.items.slice().sort((a, b) => a.is_file === b.is_file ? a.name.localeCompare(b.name, 'ru', { numeric: true }) : a.is_file ? 1 : -1);
  if (q) items = items.filter(n => n.name.toLowerCase().includes(q));
  const cr = $('#crumbs'); cr.innerHTML = '';
  const parts = [{ name: st.name, path: '' }, ...segs(S.path).map((n, i, a) => ({ name: n, path: a.slice(0, i + 1).join('/') }))];
  parts.forEach((p, i) => {
    if (i) cr.insertAdjacentHTML('beforeend', '<span class="ms" aria-hidden="true">chevron_right</span>');
    const b = document.createElement('button'); b.type = 'button'; b.textContent = p.name;
    if (i === parts.length - 1) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', () => openStore(st, p.path));
    cr.appendChild(b);
  });
  if (S.path) {
    const d = document.createElement('button'); d.type = 'button'; d.className = 'crumb-del'; d.style.color = 'var(--danger)';
    d.innerHTML = '<span class="ms" aria-hidden="true" style="color:inherit">delete</span>'; d.setAttribute('aria-label', 'Удалить эту папку');
    d.addEventListener('click', confirmFolderDelete); cr.appendChild(d);
  }
  const title = $('#title'); title.textContent = S.path ? segs(S.path).pop() : st.name; if (!quiet) restart(title);
  const own = S.workers.filter(w => w.storage_id === st.id).length, has = S.has[st.id];
  $('#sub').innerHTML = `Канал <span class="mono">${chatLabel(st.chat_id)}</span> · ${own ? `${own} ${plural(own, W_BOT)} на связи` : has ? 'боты подключены' : 'ботов пока нет'}`;
  const size = S.items.reduce((a, n) => a + (n.size || 0), 0), files = S.items.filter(n => n.is_file).length;
  countTo($('#st-size'), size, fmtSize);
  countTo($('#st-files'), files, v => nf0.format(Math.round(v))); $('#st-files-l').textContent = plural(files, W_FILE);
  $('#st-bots').textContent = own ? own : has ? 'есть' : '0'; $('#st-bots').dataset.v = own; $('#st-bots-l').textContent = own ? plural(own, W_BOT) : 'ботов';
  const g = $('#grid'); g.classList.toggle('is-list', S.view === 'list'); g.classList.toggle('quiet', quiet);
  if (!items.length) {
    if (q) g.innerHTML = `<div class="empty glass"><span class="ms" aria-hidden="true">search</span><h3>Ничего не нашлось</h3><p>В этой папке нет файлов, в названии которых есть «${esc(S.q.trim())}».</p></div>`;
    else if (has === false) g.innerHTML = `<div class="empty glass"><span class="ms" aria-hidden="true">smart_toy</span><h3>Сначала нужен бот</h3><p>Добавь бота для «${esc(st.name)}» в разделе «Боты». Через него файлы будут уходить в канал.</p><button class="btn primary" type="button" data-go="bots">К ботам</button></div>`;
    else g.innerHTML = `<div class="empty glass"><span class="ms" aria-hidden="true">send</span><h3>Папка пустая</h3><p>Перетащи сюда файлы или нажми «Загрузить». Каждый файл уйдёт в канал кусками по 20 МБ.</p></div>`;
    return;
  }
  g.innerHTML = items.map((n, i) => cardHTML(n, i)).join('');
}
function highlight(path) { const el = $$('.card').find(c => c.dataset.path === path); if (el) { el.classList.add('fresh'); el.scrollIntoView({ block: 'nearest', behavior: reduced.matches ? 'auto' : 'smooth' }); } }
$('#grid').addEventListener('click', e => {
  const go = e.target.closest('[data-go]'); if (go) { showSection(go.dataset.go); return; }
  if (e.target.closest('[data-act="new-store"]')) { openStoreModal(); return; }
  const c = e.target.closest('.card'); if (!c) return;
  const n = S.items.find(x => x.path === c.dataset.path); if (!n) return;
  if (!n.is_file) openStore(S.store, n.path); else openDrawer(n, c);
});
$('#grid').addEventListener('pointermove', e => { const c = e.target.closest('.card'); if (!c) return; const r = c.getBoundingClientRect(); c.style.setProperty('--mx', (e.clientX - r.left) + 'px'); c.style.setProperty('--my', (e.clientY - r.top) + 'px'); });
$('#q').addEventListener('input', e => { S.q = e.target.value; if (S.store) renderFiles(true); });
function setView(v) { S.view = v; keep.set('view', v); $('#v-grid').setAttribute('aria-pressed', v === 'grid'); $('#v-list').setAttribute('aria-pressed', v === 'list'); if (S.store) renderFiles(); }
$('#v-grid').addEventListener('click', () => setView('grid'));
$('#v-list').addEventListener('click', () => setView('list'));
function confirmFolderDelete() {
  const st = S.store, path = S.path, name = segs(path).pop();
  askConfirm('Удалить папку?', `«${name}» и всё, что в ней лежит, пропадёт из хранилища. Сами куски останутся в канале Telegram.`, async () => {
    await API.remove(st.id, path + '/');
    toast(`Папка «${name}» удалена`, 'delete');
    loadStores().catch(() => { });
    openStore(S.stores.find(s => s.id === st.id) || st, segs(path).slice(0, -1).join('/'), false);
  });
}

/* ---------- file drawer ---------- */
let drawerNode = null, drawerFrom = null, dlBusy = false;
function openDrawer(n, from) {
  drawerNode = n; drawerFrom = from;
  const k = kindOf(n.name, true), h = hash(n.name) % 360, ch = chunksOf(n.size), ext = (n.name.includes('.') ? n.name.split('.').pop() : '').toUpperCase(), st = S.store, d = $('#drawer');
  d.innerHTML = `<div class="dr-h"><span class="chip">Файл</span><button class="icon-btn" type="button" id="dr-x" aria-label="Закрыть"><span class="ms" aria-hidden="true">close</span></button></div>
  <div class="thumb k-${k}" style="--h:${h}"><span class="ms" aria-hidden="true">${ICON[k]}</span>${(k === 'image' || k === 'video') && ext ? `<span class="badge">${esc(ext)}</span>` : ''}</div>
  <h2 class="dr-title">${esc(n.name)}</h2>
  <dl class="facts"><div><dt>Размер</dt><dd>${fmtSize(n.size)}</dd></div><div><dt>Куски</dt><dd>${ch === 1 ? '1 кусок' : `${ch} × 20 МБ`}</dd></div><div class="wide"><dt>Путь</dt><dd>${esc([st.name, ...segs(n.path)].join(' / '))}</dd></div><div class="wide"><dt>Канал</dt><dd>${chatLabel(st.chat_id)}</dd></div></dl>
  <div class="dr-sec"><div class="dr-sec-h"><span>Карта кусков</span><span id="dl-state">${ch} ${plural(ch, W_CHUNK)} в канале</span></div><div class="cmap big" id="dmap">${Array.from({ length: Math.min(ch, 400) }, (_, i) => `<i title="Кусок ${i + 1}"></i>`).join('')}</div></div>
  <div class="dr-actions"><button class="btn primary" type="button" id="dl"><span class="ms" aria-hidden="true">download</span><span id="dl-l">Скачать</span></button><button class="btn danger" type="button" id="rm"><span class="ms" aria-hidden="true">delete</span>Удалить</button></div>
  <div class="confirm" id="confirm" hidden><p>Удалить «${esc(n.name)}»? Файл пропадёт из хранилища, а его куски останутся в канале Telegram.</p><p class="err" hidden></p><div class="actions"><button class="btn" type="button" id="rm-no">Отмена</button><button class="btn danger solid" type="button" id="rm-yes">Удалить</button></div></div>`;
  d.inert = false; d.classList.add('on');
  $('#dr-x').addEventListener('click', closeDrawer);
  $('#dl').addEventListener('click', () => doDownload(n));
  $('#rm').addEventListener('click', () => { $('#confirm').hidden = false; $('#rm-yes').focus(); });
  $('#rm-no').addEventListener('click', () => { $('#confirm').hidden = true; });
  $('#rm-yes').addEventListener('click', e => busy(e.currentTarget, async () => {
    try {
      await API.remove(st.id, n.path);
      closeDrawer();
      const card = $$('.card').find(c => c.dataset.path === n.path);
      if (card && !reduced.matches) { card.classList.add('leaving'); await new Promise(r => setTimeout(r, 430)); }
      toast(`Удалено: ${n.name}`, 'delete');
      await loadTree(true); loadStores().catch(() => { });
    } catch (err) { if (err.status !== 401) { const p = $('#confirm .err'); if (p) { p.textContent = errText(err); p.hidden = false; } } }
  }));
  setTimeout(() => { const x = $('#dr-x'); if (x) x.focus({ preventScroll: true }); }, 80);
  requestAnimationFrame(() => $$('#dmap i').forEach((c, i) => setTimeout(() => { c.className = 'ok'; }, reduced.matches ? 0 : Math.min(i, 120) * 6)));
}
function closeDrawer() {
  const d = $('#drawer'); if (!d.classList.contains('on')) return;
  d.classList.remove('on'); d.inert = true;
  if (drawerFrom && document.contains(drawerFrom)) drawerFrom.focus({ preventScroll: true });
  drawerNode = null;
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function doDownload(n) {
  if (dlBusy) return; dlBusy = true;
  const cells = $$('#dmap i'), map = $('#dmap'), lbl = $('#dl-l'), state = $('#dl-state'), total = chunksOf(n.size);
  const set = (el, t) => { if (el && el.isConnected) el.textContent = t; };
  cells.forEach(c => { c.className = ''; }); map.classList.add('wait');
  set(lbl, 'Собираю…'); set(state, `Сервер забирает ${total} ${plural(total, W_CHUNK)} из Telegram`);
  try {
    const res = await API.download(S.store.id, n.path);
    map.classList.remove('wait');
    let blob;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader(), parts = []; let got = 0;
      for (; ;) {
        const { done, value } = await reader.read(); if (done) break;
        parts.push(value); got += value.length;
        const k = Math.min(1, got / Math.max(1, n.size)), lit = Math.round(k * cells.length);
        for (let i = 0; i < lit; i++) if (!cells[i].className) cells[i].className = 'ok';
        set(lbl, `Скачиваю ${Math.round(k * 100)}%`);
      }
      blob = new Blob(parts, { type: res.headers.get('content-type') || 'application/octet-stream' });
    } else blob = await res.blob();
    saveBlob(blob, n.name);
    toast(`«${n.name}» скачан`, 'download');
  } catch (e) { if (e.status !== 401) toast(errText(e), 'close', true); }
  finally {
    dlBusy = false; map.classList.remove('wait'); cells.forEach(c => { c.className = 'ok'; });
    set(lbl, 'Скачать'); set(state, `${total} ${plural(total, W_CHUNK)} в канале`);
  }
}
