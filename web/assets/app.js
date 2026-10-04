'use strict';
/* Pentaract web UI: talks to the stock Pentaract API under /api. */

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const MB = 1048576, GB = MB * 1024, CHUNK = 20 * MB, BIG_FILE = 300 * MB;
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }), nf0 = new Intl.NumberFormat('ru-RU');
const fmtSize = b => b < 1024 ? `${Math.round(b)} Б` : b < MB ? `${nf.format(b / 1024)} КБ` : b < GB ? `${nf.format(b / MB)} МБ` : `${nf.format(b / GB)} ГБ`;
const plural = (n, f) => { n = Math.abs(Math.round(n)); const a = n % 10, b = n % 100; return f[a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? 1 : 2]; };
const W_FILE = ['файл', 'файла', 'файлов'], W_CHUNK = ['кусок', 'куска', 'кусков'], W_BOT = ['бот', 'бота', 'ботов'];
const chunksOf = s => Math.max(1, Math.ceil(s / CHUNK));
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = s => { let h = 7; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; };
const keep = {
  get(k) { try { return localStorage.getItem('pentaract:' + k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('pentaract:' + k, v); } catch (e) { } },
  del(k) { try { localStorage.removeItem('pentaract:' + k); } catch (e) { } },
};
const isDarkNow = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches; };
const restart = el => { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; };
// Channel ids are stored by Pentaract without the -100 prefix; people copy them with it.
const chatLabel = id => `-100${Math.abs(id)}`;

/* ---------- auth ---------- */
const auth = {
  get token() { return keep.get('token'); },
  set(t) { keep.set('token', t); },
  clear() { keep.del('token'); },
  claims() {
    const t = this.token; if (!t) return null;
    try {
      let p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      p += '='.repeat((4 - p.length % 4) % 4);
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p), c => c.charCodeAt(0))));
    } catch (e) { return null; }
  },
  valid() { const c = this.claims(); return !!c && (!c.exp || c.exp * 1000 > Date.now() + 5000); },
};

/* ---------- API client ---------- */
class ApiError extends Error { constructor(status, text) { super(text || ''); this.status = status; } }
let onUnauthorized = () => { };
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch('/api' + path, { method, headers, body: payload }); }
  catch (e) { throw new ApiError(0, ''); }
  if (res.status === 401 && path !== '/auth/login') { onUnauthorized(); throw new ApiError(401, 'not authenticated'); }
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''));
  if (raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const API = {
  login: (email, password) => api('/auth/login', { method: 'POST', body: { email, password } }),
  storages: () => api('/storages'),
  storage: id => api(`/storages/${id}`),
  createStorage: (name, chat_id) => api('/storages', { method: 'POST', body: { name, chat_id } }),
  tree: (id, path) => api(`/storages/${id}/files/tree/${encPath(path)}`),
  createFolder: (id, path, folder_name) => api(`/storages/${id}/files/create_folder`, { method: 'POST', body: { path, folder_name } }),
  remove: (id, path) => api(`/storages/${id}/files/${encPath(path)}`, { method: 'DELETE' }),
  download: (id, path) => api(`/storages/${id}/files/download/${encPath(path)}`, { raw: true }),
  workers: () => api('/storage_workers'),
  createWorker: (name, token, storage_id) => api('/storage_workers', { method: 'POST', body: { name, token, storage_id } }),
  hasWorkers: id => api(`/storage_workers/has_workers?storage_id=${encodeURIComponent(id)}`),
  access: id => api(`/storages/${id}/access`),
  grant: (id, user_email, access_type) => api(`/storages/${id}/access`, { method: 'POST', body: { user_email, access_type } }),
  revoke: (id, user_id) => api(`/storages/${id}/access`, { method: 'DELETE', body: { user_id } }),
};
function errText(e, ctx = '') {
  if (!(e instanceof ApiError)) return 'Что-то пошло не так. Попробуй ещё раз';
  const t = e.message.toLowerCase();
  if (e.status === 0) return 'Нет связи с сервером. Проверь интернет';
  if (t.includes('does not have workers') || t.includes('at least 1 storage worker')) return 'У хранилища нет ботов. Подключи бота в разделе «Боты»';
  if (t.includes('storage with such name')) return 'Хранилище с таким названием уже есть';
  if (t.includes('chat id')) return 'Этот канал уже подключён к другому хранилищу';
  if (t.includes('storage worker with such name')) return 'Бот с таким названием уже есть';
  if (t.includes('token must be unique')) return 'Этот бот уже добавлен';
  if (t.includes('manage access of yourself')) return 'Свой собственный доступ менять нельзя';
  if (t.includes('invalid folder name')) return 'В названии папки не должно быть символа «/»';
  if (t.includes('invalid path')) return 'Недопустимое название';
  if (t.includes('already exists')) return 'Здесь уже есть папка или файл с таким названием';
  if (e.status === 404 && ctx === 'grant') return 'Такого аккаунта нет. Проверь почту';
  if (e.status === 404 && ctx === 'access') return 'Управлять доступом может только админ этого хранилища';
  if (e.status === 404) return 'Не найдено или нет доступа';
  if (e.status === 401) return ctx === 'login' ? 'Неверная почта или пароль' : 'Сессия закончилась. Войди снова';
  if (e.status === 403) return e.message || 'Нет прав на это действие';
  if (e.status === 413) return 'Файл слишком большой для сервера';
  if (e.status >= 500) return ctx === 'upload'
    ? 'Telegram не принял файл. Проверь, что бот — администратор канала и ID канала указан верно'
    : 'Сервер не справился. Попробуй ещё раз';
  return e.message || 'Что-то пошло не так';
}

/* ---------- small UI helpers ---------- */
function toast(msg, icon = 'check', bad = false) {
  const box = $('#toasts'), el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="ms" aria-hidden="true"${bad ? ' style="color:var(--danger)"' : ''}>${icon}</span><span>${esc(msg)}</span>`;
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 380); }, bad ? 6000 : 3400);
}
function countTo(el, to, fmt) {
  const from = +el.dataset.v || 0; el.dataset.v = to;
  if (reduced.matches || from === to || document.hidden) { el.textContent = fmt(to); return; }
  setTimeout(() => { if (+el.dataset.v === to) el.textContent = fmt(to); }, 900);
  const s = performance.now();
  (function f(n) { const k = Math.min(1, (n - s) / 800), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(f); })(s);
}
function fieldErr(form, inp, msg) {
  const e = form.querySelector('.err'); e.textContent = msg; e.hidden = false;
  if (inp) { inp.setAttribute('aria-invalid', 'true'); inp.focus(); }
}
function clearErr(form) { const e = form.querySelector('.err'); if (e) e.hidden = true; $$('[aria-invalid]', form).forEach(i => i.removeAttribute('aria-invalid')); }
document.addEventListener('input', e => { const f = e.target.closest('form'); if (!f) return; e.target.removeAttribute('aria-invalid'); const er = f.querySelector('.err'); if (er) er.hidden = true; });
async function busy(btn, fn) {
  if (btn.classList.contains('busy')) return;
  const html = btn.innerHTML; btn.classList.add('busy'); btn.innerHTML = '<span class="spin" aria-hidden="true"></span>' + btn.textContent.trim();
  try { return await fn(); } finally { btn.classList.remove('busy'); btn.innerHTML = html; }
}
/* ---------- background: a turning five-dimensional cube ---------- */
const sky=(()=>{
  const cv=$('#sky'),ctx=cv.getContext('2d');
  let W=0,H=0,raf=0,last=0,C={void:'#05080F',signal:'#40C4FF',ember:'#FF8A5C',mint:'#4BE3B0',light:false};
  const t0=performance.now(),V=[],E=[],kind=[];
  for(let i=0;i<32;i++)V.push([0,1,2,3,4].map(d=>(i>>d)&1?1:-1));
  for(let i=0;i<32;i++)for(let d=0;d<5;d++){const j=i^(1<<d);if(i<j){E.push([i,j]);kind.push(d===4?2:(i>>4)&1)}}
  const adj=V.map((_,i)=>E.map((e,k)=>e[0]===i||e[1]===i?k:-1).filter(k=>k>=0));
  const packs=Array.from({length:16},()=>({e:(Math.random()*E.length)|0,t:Math.random(),dir:1,s:.25+Math.random()*.45}));
  const MODES={app:{x:.76,y:.58,s:.19,a:.72},login:{x:.5,y:.27,s:.15,a:1}};
  const NARROW={app:{x:.66,y:.84,s:.26,a:.45},login:{x:.5,y:.17,s:.2,a:1}};
  let mode='app',now={x:.76,y:.58,s:.19,a:.72},px=0,py=0,tx=0,ty=0;
  const rgba=(h,a)=>{const n=parseInt(h.replace('#','').slice(0,6),16);return`rgba(${n>>16&255},${n>>8&255},${n&255},${a})`};
  function colors(){const cs=getComputedStyle(document.documentElement),g=(k,d)=>{const v=cs.getPropertyValue(k).trim();return/^#[0-9a-f]{6}$/i.test(v)?v:d};C={void:g('--void','#05080F'),signal:g('--signal','#40C4FF'),ember:g('--ember','#FF8A5C'),mint:g('--mint','#4BE3B0'),light:!isDarkNow()};if(reduced.matches)draw(9)}
  function resize(){const dpr=Math.min(1.75,devicePixelRatio||1);W=innerWidth;H=innerHeight;cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);if(reduced.matches)draw(9)}
  function rot(p,a,b,ang){const c=Math.cos(ang),s=Math.sin(ang),x=p[a],y=p[b];p[a]=c*x-s*y;p[b]=s*x+c*y}
  function project(t){return V.map(v=>{const p=v.slice();rot(p,0,4,t*.23);rot(p,1,3,t*.19);rot(p,2,4,t*.13);rot(p,0,3,t*.09);rot(p,3,4,t*.16);rot(p,1,2,.5+py*.6);rot(p,0,2,.35+px*.6);
    let f=1/(1-p[4]*.16),x=p[0]*f,y=p[1]*f,z=p[2]*f,w=p[3]*f;f=1/(1-w*.11);x*=f;y*=f;z*=f;f=1/(1-z*.075);return{x:x*f,y:y*f,z}})}
  function blob(x,y,r,c,a){const g=ctx.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,rgba(c,a));g.addColorStop(1,rgba(c,0));ctx.fillStyle=g;ctx.fillRect(0,0,W,H)}
  function draw(t){
    const M=(W<880?NARROW:MODES)[mode],k=reduced.matches?1:.05;
    now.x+=(M.x-now.x)*k;now.y+=(M.y-now.y)*k;now.s+=(M.s-now.s)*k;now.a+=(M.a-now.a)*k;px+=(tx-px)*.05;py+=(ty-py)*.05;
    ctx.globalAlpha=1;ctx.fillStyle=C.void;ctx.fillRect(0,0,W,H);
    const R=Math.max(W,H),L=C.light;
    blob(W*(.16+.07*Math.sin(t*.31)),H*(.18+.06*Math.cos(t*.27)),R*.62,C.signal,L?.2:.24);
    blob(W*(.9+.05*Math.cos(t*.23)),H*(.86+.06*Math.sin(t*.29)),R*.55,C.ember,L?.15:.17);
    blob(W*(.52+.12*Math.sin(t*.17)),H*(.55+.1*Math.cos(t*.21)),R*.42,C.mint,L?.1:.09);
    const P=project(t),ox=W*now.x,oy=H*now.y,sc=Math.min(W,H)*now.s;
    ctx.lineWidth=1.1;ctx.lineCap='round';
    for(let i=0;i<E.length;i++){const a=P[E[i][0]],b=P[E[i][1]],d=Math.max(0,Math.min(1,((a.z+b.z)/2+2.4)/4.8));ctx.globalAlpha=now.a*(.14+.5*d)*(kind[i]===2?.7:1);ctx.strokeStyle=kind[i]===2?C.mint:kind[i]?C.ember:C.signal;ctx.beginPath();ctx.moveTo(ox+a.x*sc,oy+a.y*sc);ctx.lineTo(ox+b.x*sc,oy+b.y*sc);ctx.stroke()}
    for(let i=0;i<32;i++){const p=P[i],d=Math.max(0,Math.min(1,(p.z+2.4)/4.8));ctx.globalAlpha=now.a*(.35+.65*d);ctx.fillStyle=(i>>4)&1?C.ember:C.signal;ctx.beginPath();ctx.arc(ox+p.x*sc,oy+p.y*sc,1.3+2.2*d,0,6.2832);ctx.fill()}
    ctx.globalAlpha=1;
    for(const q of packs){const a=P[q.dir>0?E[q.e][0]:E[q.e][1]],b=P[q.dir>0?E[q.e][1]:E[q.e][0]],x=ox+(a.x+(b.x-a.x)*q.t)*sc,y=oy+(a.y+(b.y-a.y)*q.t)*sc,g=ctx.createRadialGradient(x,y,0,x,y,9);g.addColorStop(0,rgba(C.signal,.9*now.a));g.addColorStop(1,rgba(C.signal,0));ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,9,0,6.2832);ctx.fill()}
  }
  function step(n){const dt=Math.min(.05,(n-last)/1000||0);last=n;
    for(const q of packs){q.t+=q.s*dt;if(q.t>=1){const end=q.dir>0?E[q.e][1]:E[q.e][0],opts=adj[end].filter(k=>k!==q.e);q.e=opts[(Math.random()*opts.length)|0];q.dir=E[q.e][0]===end?1:-1;q.t=0}}
    draw((n-t0)/1000*.6);raf=requestAnimationFrame(step)}
  function start(){cancelAnimationFrame(raf);if(reduced.matches){draw(9);return}last=performance.now();raf=requestAnimationFrame(step)}
  addEventListener('resize',resize);
  addEventListener('pointermove',e=>{tx=e.clientX/(W||1)-.5;ty=e.clientY/(H||1)-.5},{passive:true});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelAnimationFrame(raf);else start()});
  if(reduced.addEventListener)reduced.addEventListener('change',start);
  return{init(){resize();colors();start()},colors,mode(m){mode=m;if(reduced.matches)draw(9)}};
})();



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

/* ---------- uploads: one request at a time, the server forwards chunks to Telegram ---------- */
const ups = []; let upActive = null, inFlight = 0;
function showTray() { const t = $('#tray'); if (t.hidden) { t.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('on'))); } }
function hideTray() { const t = $('#tray'); t.classList.remove('on'); setTimeout(() => { if (!t.classList.contains('on')) t.hidden = true; }, 420); }
$('#tray-x').addEventListener('click', hideTray);
function startUpload(list) {
  const st = S.store;
  if (!st) { toast('Сначала создай хранилище', 'database', true); return; }
  const files = [...list].filter(f => f && f.name); if (!files.length) return;
  if (S.has[st.id] === false) { toast('У этого хранилища нет ботов. Подключи бота в разделе «Боты»', 'smart_toy', true); return; }
  if (files.some(f => f.size > BIG_FILE)) toast('Файлы больше 300 МБ пока могут не пройти: на сервере мало памяти', 'upload', true);
  showTray();
  for (const f of files) {
    const n = chunksOf(f.size || 1), el = document.createElement('div'); el.className = 'up';
    el.innerHTML = `<div class="up-row"><span class="ms" aria-hidden="true">${ICON[kindOf(f.name)]}</span><span class="up-name" title="${esc(f.name)}">${esc(f.name)}</span><span class="up-pct">в очереди</span><button class="icon-btn x" type="button" aria-label="Отменить загрузку"><span class="ms" aria-hidden="true">close</span></button></div><div class="cmap">${'<i></i>'.repeat(Math.min(n, 240))}</div><div class="up-info">${n} ${plural(n, W_CHUNK)} · ${fmtSize(f.size)}</div>`;
    $('#tray-list').append(el);
    const job = { file: f, store: st, path: S.path, n, el, cells: $$('.cmap i', el), xhr: null, state: 'queued' };
    el.querySelector('.x').addEventListener('click', () => cancelUpload(job));
    ups.push(job);
  }
  pumpUploads();
}
function cancelUpload(job) {
  if (job.state === 'queued') { const i = ups.indexOf(job); if (i >= 0) ups.splice(i, 1); finishJob(job, 'cancel'); }
  else if (job.state === 'sending' && job.xhr) job.xhr.abort();
  else if (job.state === 'telegram') toast('Файл уже на сервере: отправку в Telegram отменить нельзя', 'upload');
}
function pumpUploads() {
  if (upActive || !ups.length) return;
  const job = upActive = ups.shift(); job.state = 'sending';
  const xhr = job.xhr = new XMLHttpRequest(), pct = job.el.querySelector('.up-pct'), info = job.el.querySelector('.up-info'), map = job.el.querySelector('.cmap');
  xhr.open('POST', `/api/storages/${job.store.id}/files/upload`);
  if (auth.token) xhr.setRequestHeader('Authorization', 'Bearer ' + auth.token);
  pct.textContent = '0%';
  xhr.upload.onprogress = e => {
    const total = e.lengthComputable ? e.total : job.file.size, k = Math.min(1, e.loaded / Math.max(1, total)), lit = Math.floor(k * job.cells.length);
    pct.textContent = Math.min(99, Math.round(k * 100)) + '%';
    job.cells.forEach((c, i) => { if (i < lit && !c.className) c.className = 'go'; });
    info.textContent = `На сервер: ${fmtSize(k * job.file.size)} из ${fmtSize(job.file.size)}`;
  };
  xhr.upload.onload = () => {
    job.state = 'telegram'; job.cells.forEach(c => { c.className = 'go'; }); map.classList.add('wait'); pct.textContent = '99%';
    info.innerHTML = `<span class="up-phase">Отправляю ${job.n} ${plural(job.n, W_CHUNK)} в Telegram…</span>`;
  };
  xhr.onload = () => {
    if (xhr.status === 401) { finishJob(job, 'error', 'Сессия закончилась. Войди снова'); onUnauthorized(); }
    else if (xhr.status >= 200 && xhr.status < 300) finishJob(job, 'ok');
    else finishJob(job, 'error', errText(new ApiError(xhr.status, xhr.responseText), 'upload'));
  };
  xhr.onerror = () => finishJob(job, 'error', errText(new ApiError(0, '')));
  xhr.onabort = () => finishJob(job, 'cancel');
  const fd = new FormData(); fd.append('path', job.path); fd.append('file', job.file, job.file.name);
  xhr.send(fd);
}
function finishJob(job, result, msg) {
  if (job.state === 'done') return;
  job.state = 'done';
  const pct = job.el.querySelector('.up-pct'), info = job.el.querySelector('.up-info'), x = job.el.querySelector('.x');
  job.el.querySelector('.cmap').classList.remove('wait'); if (x) x.remove();
  if (result === 'ok') {
    job.el.classList.add('done'); pct.innerHTML = '<span class="ms" aria-hidden="true">check</span>';
    const every = Math.max(1, Math.ceil(job.cells.length / 8));
    job.cells.forEach((c, i) => setTimeout(() => { c.className = 'ok'; if (i % every === 0) plane(c, job.store); }, reduced.matches ? 0 : Math.min(i, 60) * 25));
    info.textContent = `${job.n} ${plural(job.n, W_CHUNK)} в канале «${job.store.name}»`;
    toast(`«${job.file.name}» загружен`, 'check');
    if (S.sec === 'files' && S.store && S.store.id === job.store.id && S.path === job.path) {
      const expected = job.path ? `${job.path}/${job.file.name}` : job.file.name;
      loadTree(true).then(() => highlight(expected));
    }
    loadStores().catch(() => { });
  } else if (result === 'cancel') { job.el.classList.add('error'); pct.textContent = 'отменено'; info.textContent = 'Загрузка отменена'; }
  else { job.el.classList.add('error'); pct.textContent = 'ошибка'; info.textContent = msg || 'Не получилось загрузить'; toast(`«${job.file.name}»: ${msg || 'не получилось загрузить'}`, 'close', true); }
  if (upActive === job) upActive = null;
  setTimeout(() => { job.el.classList.add('gone'); setTimeout(() => { job.el.remove(); if (!$('#tray-list').children.length) hideTray(); }, 420); }, result === 'ok' ? 4000 : 9000);
  pumpUploads();
}
function plane(from, store) {
  if (reduced.matches || inFlight > 7 || document.hidden || !from.isConnected) return;
  const target = $(`.store[data-id="${store.id}"] .av`) || $('.brand svg'); if (!target) return;
  const a = from.getBoundingClientRect(), b = target.getBoundingClientRect(), x0 = a.left + a.width / 2, y0 = a.top + a.height / 2, x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
  const mx = (x0 + x1) / 2 + (Math.random() * 140 - 70), my = Math.min(y0, y1) - 50 - Math.random() * 90, ang = Math.atan2(y1 - y0, x1 - x0) * 57.3;
  const p = document.createElement('span'); p.className = 'ms plane'; p.textContent = 'send'; p.setAttribute('aria-hidden', 'true'); document.body.appendChild(p); inFlight++;
  const an = p.animate([{ transform: `translate(${x0}px,${y0}px) rotate(${ang}deg) scale(.5)`, opacity: 0 }, { transform: `translate(${mx}px,${my}px) rotate(${ang}deg) scale(1)`, opacity: 1, offset: .4 }, { transform: `translate(${x1}px,${y1}px) rotate(${ang}deg) scale(.35)`, opacity: 0 }], { duration: 1000 + Math.random() * 400, easing: 'cubic-bezier(.35,.1,.25,1)' });
  an.onfinish = () => { p.remove(); inFlight--; target.classList.remove('ping'); void target.offsetWidth; target.classList.add('ping'); };
}
$('#upload').addEventListener('click', () => { if (!S.store) { toast('Сначала создай хранилище', 'database', true); return; } $('#pick').click(); });
$('#pick').addEventListener('change', e => { startUpload(e.target.files); e.target.value = ''; });
let dragDepth = 0;
let dropTimer = 0;
const dropOff = () => { dragDepth = 0; clearTimeout(dropTimer); $('#drop').classList.remove('on'); };
const hasFiles = e => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e) || S.sec !== 'files' || !S.authed || !S.store) return; e.preventDefault(); dragDepth++; $('#drop-where').textContent = `Нарежем на куски по 20 МБ и отправим в «${S.path ? segs(S.path).pop() : S.store.name}»`; $('#drop').classList.add('on'); clearTimeout(dropTimer); dropTimer = setTimeout(dropOff, 800); });
// The overlay closes itself once dragover stops arriving (drag left the window or was cancelled).
addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); if ($('#drop').classList.contains('on')) { clearTimeout(dropTimer); dropTimer = setTimeout(dropOff, 400); } });
addEventListener('blur', dropOff);
addEventListener('pointermove', () => { if ($('#drop').classList.contains('on')) dropOff(); });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').classList.remove('on'); });
addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('on'); if (S.sec === 'files' && S.authed && S.store) startUpload(e.dataTransfer.files); });
addEventListener('beforeunload', e => { if (upActive || ups.length) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- modals ---------- */
let confirmAction = null;
function openModal(id) {
  const m = $('#modal'); $$('.sheet', m).forEach(s => { s.hidden = s.id !== id; });
  $$('.sheet', m).forEach(clearErr);
  m.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => m.classList.add('on')));
  setTimeout(() => { const i = $(`#${id} input`) || $(`#${id} button[type="submit"]`); if (i) i.focus(); }, 80);
}
function closeModal() { const m = $('#modal'); if (m.hidden) return; m.classList.remove('on'); setTimeout(() => { m.hidden = true; }, 320); }
$('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal') closeModal(); });
$$('[data-close]').forEach(b => b.addEventListener('click', closeModal));
function askConfirm(title, text, action, label = 'Удалить') {
  $('#m-confirm-h').textContent = title; $('#m-confirm-text').textContent = text; $('#m-confirm-go').textContent = label;
  confirmAction = action; openModal('m-confirm');
}
$('#m-confirm').addEventListener('submit', e => {
  e.preventDefault(); const f = e.currentTarget; if (!confirmAction) return;
  busy($('#m-confirm-go'), async () => { try { await confirmAction(); closeModal(); } catch (err) { if (err.status !== 401) fieldErr(f, null, errText(err)); } });
});
$('#new-folder').addEventListener('click', () => {
  if (!S.store) { toast('Сначала создай хранилище', 'database', true); return; }
  $('#m-folder-where').textContent = `В «${S.path ? segs(S.path).pop() : S.store.name}»`; $('#folder-name').value = ''; openModal('m-folder');
});
$('#m-folder').addEventListener('submit', e => {
  e.preventDefault(); const f = e.currentTarget, inp = $('#folder-name'), v = inp.value.trim(), st = S.store, path = S.path;
  if (!v) return fieldErr(f, inp, 'Введи название папки');
  if (v.includes('/')) return fieldErr(f, inp, 'В названии не должно быть символа «/»');
  if (S.items.some(c => c.name.toLowerCase() === v.toLowerCase())) return fieldErr(f, inp, 'Здесь уже есть папка или файл с таким названием');
  busy(f.querySelector('button[type="submit"]'), async () => {
    try {
      await API.createFolder(st.id, path, v); closeModal(); toast(`Папка «${v}» создана`, 'create_new_folder');
      if (S.store && S.store.id === st.id && S.path === path) { await loadTree(true); highlight(path ? `${path}/${v}` : v); }
    } catch (err) { if (err.status !== 401) fieldErr(f, inp, errText(err)); }
  });
});
function normChat(raw) {
  const v = raw.replace(/[−–—]/g, '-').replace(/\s+/g, '');
  if (!v) return { err: 'Вставь ID канала' };
  if (!/^-?\d+$/.test(v)) return { err: 'ID состоит из цифр и минуса в начале' };
  if (v[0] !== '-') return { err: 'ID канала начинается с минуса' };
  const d = v.slice(1);
  if (d.startsWith('100') && d.length >= 13) return { full: v, id: -Number(d.slice(3)) };
  if (d.length < 7) return { err: 'Слишком короткий ID. Проверь, что скопировал его целиком' };
  return { full: '-100' + d, id: -Number(d) };
}
const NORM_HINT = 'Подойдут оба вида: -1001234567890 и -1234567890';
$('#store-chat').addEventListener('input', e => {
  const r = normChat(e.target.value), n = $('#chat-norm');
  if (!e.target.value.trim()) { n.className = 'norm'; n.textContent = NORM_HINT; return; }
  if (r.err) { n.className = 'norm'; n.textContent = r.err; return; }
  n.className = 'norm good'; n.innerHTML = `<span class="ms" aria-hidden="true">check</span>Подходит: канал <span class="mono">${esc(r.full)}</span>`;
});
function openStoreModal() { $('#store-name').value = ''; $('#store-chat').value = ''; $('#chat-norm').className = 'norm'; $('#chat-norm').textContent = NORM_HINT; openModal('m-store'); }
$('#add-store').addEventListener('click', openStoreModal);
$('#m-store').addEventListener('submit', e => {
  e.preventDefault(); const f = e.currentTarget, ni = $('#store-name'), ci = $('#store-chat'), name = ni.value.trim(), r = normChat(ci.value);
  if (!name) return fieldErr(f, ni, 'Введи название хранилища');
  if (r.err) return fieldErr(f, ci, r.err);
  busy(f.querySelector('button[type="submit"]'), async () => {
    try {
      const st = await API.createStorage(name, r.id); closeModal();
      toast(`Хранилище «${name}» создано. Теперь добавь ему бота`, 'database');
      await loadStores();
      const fresh = S.stores.find(s => s.id === (st && st.id)) || S.stores.find(s => s.name === name);
      if (fresh) openStore(fresh, '');
    } catch (err) { if (err.status !== 401) fieldErr(f, null, errText(err)); }
  });
});

/* ---------- bots ---------- */
function renderSpeed() {
  const st = S.store, box = $('#speed'); if (!st) { box.innerHTML = ''; return; }
  const n = S.workers.filter(w => w.storage_id === st.id).length;
  box.innerHTML = `<small>Скорость «${esc(st.name)}»</small><b>${n ? `до ${fmtSize(n * 360 * MB)}/мин` : 'нет ботов'}</b><span>${n ? `${n} ${plural(n, W_BOT)} · скачивание до ${fmtSize(n * 180 * MB)}/мин` : 'Добавь бота, чтобы загружать файлы'}</span>`;
}
function renderBots() {
  const box = $('#bots');
  if (!S.workers.length) box.innerHTML = `<div class="empty glass" style="grid-column:1/-1"><span class="ms" aria-hidden="true">smart_toy</span><h3>Ботов пока нет</h3><p>Добавь первого бота ниже. Без бота файлы не смогут уйти в канал.</p></div>`;
  else box.innerHTML = S.workers.map((w, i) => {
    const st = S.stores.find(s => s.id === w.storage_id);
    return `<article class="bot glass" style="--i:${i}"><div class="bot-h"><span class="bot-av"><span class="ms" aria-hidden="true">smart_toy</span></span><div class="t"><div class="bot-n">${esc(w.name)}</div><div class="bot-u">id ${esc(String(w.token || '').split(':')[0])}</div></div><span class="live"><i></i>подключён</span></div><div class="bot-f"><span class="ms" aria-hidden="true">database</span>${st ? esc(st.name) : '<span class="warn">не привязан к хранилищу</span>'}</div></article>`;
  }).join('');
  renderSpeed();
}
$('#f-bot').addEventListener('submit', e => {
  e.preventDefault(); const f = e.currentTarget, ni = $('#bot-name'), ti = $('#bot-token'), name = ni.value.trim(), tok = ti.value.trim(), sid = $('#bot-store').value;
  if (!sid) return fieldErr(f, null, 'Сначала создай хранилище');
  if (!name) return fieldErr(f, ni, 'Дай боту название, чтобы отличать его от других');
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(tok)) return fieldErr(f, ti, 'Токен выглядит как 123456789:AAH… Скопируй его целиком у @BotFather');
  busy(f.querySelector('button[type="submit"]'), async () => {
    try {
      await API.createWorker(name, tok, sid); ni.value = ''; ti.value = ''; S.has[sid] = true;
      await loadWorkers(); renderBots();
      const st = S.stores.find(s => s.id === sid);
      toast(`Бот «${name}» подключён к «${st ? st.name : 'хранилищу'}»`, 'smart_toy');
    } catch (err) { if (err.status !== 401) fieldErr(f, null, errText(err)); }
  });
});

/* ---------- people ---------- */
async function renderPeople() {
  const sel = $('#p-store'), box = $('#people');
  if (!S.stores.length) { box.innerHTML = '<div class="people-empty">Сначала создай хранилище.</div>'; return; }
  const id = S.stores.some(s => s.id === S.peopleStore) ? S.peopleStore : (S.store ? S.store.id : S.stores[0].id);
  S.peopleStore = id; sel.value = id;
  box.innerHTML = '<div class="people-empty">Загружаю…</div>';
  try {
    const users = (await API.access(id)) || [];
    if (S.peopleStore !== id) return;
    const me = S.me && S.me.email;
    box.innerHTML = users.map((u, i) => `<div class="person" style="--i:${i}"><span class="av">${esc((u.email[0] || '?').toUpperCase())}</span><span class="t"><span class="n">${esc(u.email)}</span>${u.email === me ? '<span class="you">это ты</span>' : ''}</span><span class="roles"><span class="role r-${String(u.access_type).toLowerCase()}">${ROLE[u.access_type] || u.access_type}</span></span>${u.email !== me ? `<button class="icon-btn revoke" type="button" data-uid="${esc(u.id)}" data-email="${esc(u.email)}" aria-label="Забрать доступ у ${esc(u.email)}"><span class="ms" aria-hidden="true">person_remove</span></button>` : ''}</div>`).join('') || '<div class="people-empty">Пока ни у кого нет доступа.</div>';
  } catch (e) { if (e.status !== 401 && S.peopleStore === id) box.innerHTML = `<div class="people-empty">${esc(errText(e, 'access'))}</div>`; }
}
$('#p-store').addEventListener('change', e => { S.peopleStore = e.target.value; setHash(hashFor('people', S.peopleStore), false); renderPeople(); });
$('#people').addEventListener('click', e => {
  const b = e.target.closest('.revoke'); if (!b) return;
  const id = S.peopleStore, uid = b.dataset.uid, email = b.dataset.email, st = S.stores.find(s => s.id === id);
  askConfirm('Забрать доступ?', `${email} больше не увидит хранилище «${st ? st.name : ''}».`, async () => {
    await API.revoke(id, uid); toast(`Доступ ${email} закрыт`, 'person_remove'); renderPeople();
  }, 'Забрать доступ');
});
$('#f-access').addEventListener('submit', e => {
  e.preventDefault(); const f = e.currentTarget, ei = $('#a-email'), email = ei.value.trim(), role = $('#a-role').value, id = S.peopleStore;
  if (!id) return fieldErr(f, null, 'Сначала создай хранилище');
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return fieldErr(f, ei, 'Проверь почту: нужен адрес вида name@example.com');
  busy(f.querySelector('button[type="submit"]'), async () => {
    try { await API.grant(id, email, role); ei.value = ''; toast(`Доступ для ${email} выдан`, 'person_add'); renderPeople(); }
    catch (err) { if (err.status !== 401) fieldErr(f, ei, errText(err, 'grant')); }
  });
});

/* ---------- login ---------- */
$('#lt').innerHTML = [...'Pentaract'].map((c, i) => `<span style="--i:${i}" aria-hidden="true">${c}</span>`).join('');
function showLogin() {
  S.authed = false; closeDrawer(); closeModal(); document.body.classList.add('locked');
  const L = $('#login'), card = $('#f-login'); L.hidden = false; card.classList.remove('leaving'); restart(card); $$('#lt span').forEach(restart);
  sky.mode('login'); setTimeout(() => $('#l-email').value ? $('#l-pass').focus() : $('#l-email').focus(), 300);
}
async function enterApp(instant = false) {
  S.me = auth.claims() || {};
  const mail = S.me.email || '';
  $('#me-av').textContent = (mail[0] || '?').toUpperCase(); $('#me-name').textContent = mail.split('@')[0] || 'Аккаунт'; $('#me-mail').textContent = mail;
  S.authed = true;
  await Promise.all([loadStores(), loadWorkers()]);
  const card = $('#f-login'), finish = () => {
    $('#login').hidden = true; document.body.classList.remove('locked');
    const sh = $('#shell'); sh.classList.remove('entering'); void sh.offsetWidth; sh.classList.add('entering');
    movePill();
  };
  sky.mode('app');
  if (instant) finish(); else { card.classList.add('leaving'); await new Promise(r => setTimeout(r, 480)); finish(); }
  route(parseHash(), false);
}
function logout(message) {
  auth.clear(); S.stores = []; S.store = null; S.items = []; S.workers = []; S.has = {};
  ups.splice(0).forEach(j => finishJob(j, 'cancel'));
  showLogin(); if (message) toast(message, 'lock', true);
}
onUnauthorized = () => { if (S.authed) logout('Сессия закончилась. Войди снова'); };
$('#logout').addEventListener('click', () => { if ((upActive || ups.length)) { toast('Дождись окончания загрузки', 'upload', true); return; } logout(); history.replaceState(null, '', '#/'); });
$('#f-login').addEventListener('submit', e => {
  e.preventDefault(); const f = e.currentTarget, ei = $('#l-email'), pi = $('#l-pass'), go = $('#l-go');
  if (!ei.value.trim()) return fieldErr(f, ei, 'Введи почту');
  if (!pi.value) return fieldErr(f, pi, 'Введи пароль');
  busy(go, async () => {
    try { const r = await API.login(ei.value.trim(), pi.value); auth.set(r.access_token); pi.value = ''; await enterApp(); }
    catch (err) { auth.clear(); S.authed = false; fieldErr(f, null, errText(err, 'login')); }
  });
});

/* ---------- theme, palette, keyboard ---------- */
function syncThemeBtn() { const d = isDarkNow(), b = $('#theme'); b.querySelector('.ms').textContent = d ? 'light_mode' : 'dark_mode'; b.setAttribute('aria-label', d ? 'Светлая тема' : 'Тёмная тема'); }
function setPalette(p) {
  if (p === 'telegram') delete document.documentElement.dataset.palette; else document.documentElement.dataset.palette = p;
  $$('.sw').forEach(s => s.setAttribute('aria-pressed', s.dataset.pal === p)); keep.set('palette', p); requestAnimationFrame(sky.colors);
}
$$('.sw').forEach(s => s.addEventListener('click', () => setPalette(s.dataset.pal)));
$('#theme').addEventListener('click', () => { const t = isDarkNow() ? 'light' : 'dark'; document.documentElement.dataset.theme = t; keep.set('theme', t); });
new MutationObserver(() => { syncThemeBtn(); requestAnimationFrame(sky.colors); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { syncThemeBtn(); requestAnimationFrame(sky.colors); });
$$('#nav button').forEach(b => b.addEventListener('click', () => showSection(b.dataset.sec)));
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && S.sec === 'files' && S.authed) { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else if ($('#drawer').classList.contains('on')) closeDrawer(); }
});
addEventListener('resize', movePill);

/* ---------- start ---------- */
// Icons come from a web font; hide the ligature words until it has loaded (or give up after 4s).
(function iconsReady() {
  const root = document.documentElement, done = () => root.classList.add('icons-ready');
  const ok = () => { try { return [...document.fonts].some(f => f.family.includes('Material Symbols') && f.status === 'loaded'); } catch (e) { return true; } };
  if (!document.fonts || ok()) return done();
  document.fonts.addEventListener('loadingdone', () => { if (ok()) done(); });
  setTimeout(done, 4000);
})();

(async function boot() {
  const p = keep.get('palette'), t = keep.get('theme');
  if (p && p !== 'telegram') setPalette(p);
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  $('#v-grid').setAttribute('aria-pressed', S.view === 'grid'); $('#v-list').setAttribute('aria-pressed', S.view === 'list');
  syncThemeBtn(); sky.init();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(movePill);
  if (auth.valid()) {
    try { await enterApp(true); return; } catch (e) { auth.clear(); }
  } else auth.clear();
  showLogin();
})();
