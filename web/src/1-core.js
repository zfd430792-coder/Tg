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
// Entrance motion is opt-in and skipped during the initial load, so the first frame never moves.
const EASE = 'cubic-bezier(.22,1,.36,1)';
function enter(el, from, opts = {}) {
  if (!el || reduced.matches || document.documentElement.classList.contains('booting') || !el.animate) return;
  el.animate([{ transform: from }, { transform: 'none' }], { duration: 600, easing: EASE, fill: 'backwards', ...opts });
}
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
