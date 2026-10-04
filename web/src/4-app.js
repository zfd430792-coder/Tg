
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
  const L = $('#login'), card = $('#f-login'); L.hidden = false; card.classList.remove('leaving');
  enter(card, 'translateY(26px) scale(.96)', { duration: 900 });
  $$('#lt span').forEach((sp, i) => enter(sp, 'translateY(.6em) rotate(8deg)', { duration: 900, delay: 150 + i * 45, easing: 'cubic-bezier(.34,1.56,.64,1)' }));
  sky.mode('login'); setTimeout(() => $('#l-email').value ? $('#l-pass').focus() : $('#l-email').focus(), 300);
}
async function enterApp(instant = false) {
  S.me = auth.claims() || {};
  const mail = S.me.email || '';
  $('#me-av').textContent = (mail[0] || '?').toUpperCase(); $('#me-name').textContent = mail.split('@')[0] || 'Аккаунт'; $('#me-mail').textContent = mail;
  S.authed = true;
  await Promise.all([loadStores(), loadWorkers()]);
  sky.mode('app');
  await route(parseHash(), false, instant);
  // The app is fully rendered behind the scenes; now reveal it in one step.
  if (!instant) { $('#f-login').classList.add('leaving'); await new Promise(r => setTimeout(r, 480)); }
  $('#login').hidden = true; document.body.classList.remove('locked');
  movePill();
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
  const ready = () => document.documentElement.classList.remove('booting');
  if (auth.valid()) {
    try { await enterApp(true); ready(); return; } catch (e) { auth.clear(); }
  } else auth.clear();
  showLogin(); ready();
})();
