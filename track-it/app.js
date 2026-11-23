'use strict';

/* ==========================================================================
   Track-it — moving boxes and deceased estate expenses
   Everything is stored on the device (IndexedDB). Nothing is uploaded.
   This file: shared helpers, storage, passcode lock, router, boxes, settings,
   backup. Expenses live in expenses.js.
   ========================================================================== */

// ---------- Defaults ------------------------------------------------------

const DEFAULT_ROOMS = [
  ['Kitchen', 'Kitch'], ['Dining room', 'Dine'], ['Living room', 'Live'],
  ['Family room', 'Fam'], ['Main bedroom', 'Mbed'], ['Bedroom 2', 'Bed2'],
  ['Bedroom 3', 'Bed3'], ['Bathroom', 'Bath'], ['Laundry', 'Laun'],
  ['Study', 'Stud'], ['Hallway', 'Hall'], ['Garage', 'Gara'],
  ['Shed', 'Shed'], ['Garden', 'Gard'], ['Attic / roof', 'Atti'],
].map(([name, code]) => ({ name, code }));

const DEFAULT_CATEGORIES = [
  ['Photos & albums', 'phot'], ['Documents & papers', 'docs'],
  ['Jewellery & valuables', 'valu'], ['Kitchenware', 'kitc'], ['Crockery & glass', 'croc'],
  ['Books', 'book'], ['Clothing', 'clot'], ['Linen & bedding', 'lin'],
  ['Ornaments & decor', 'deco'], ['Artwork & frames', 'art'], ['Electronics', 'elec'],
  ['Tools & hardware', 'tool'], ['Toys & games', 'toys'], ['Toiletries', 'toil'],
  ['Miscellaneous', 'misc'],
].map(([name, code]) => ({ name, code }));

const DESTINATIONS = ['Undecided', 'Keep', 'Family member', 'Donate', 'Sell', 'Storage', 'Throw away'];

const PHOTO_MAX = 1280;   // px, longest side, stored photo
const THUMB_MAX = 320;    // px, longest side, thumbnail
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------- Small helpers --------------------------------------------------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// Box contents: [{ name, qty }]. Older boxes stored a plain list in `contents`.
const cleanQty = (q) => { const n = parseInt(q, 10); return n > 0 ? Math.min(n, 99999) : 1; };
function itemsOf(b) {
  if (Array.isArray(b.items)) return b.items.filter((it) => it && it.name);
  return (b.contents || '').split('\n').map((s) => s.trim()).filter(Boolean).map((name) => ({ name, qty: 1 }));
}
const itemText = (it) => (it.qty > 1 ? `${it.name} × ${it.qty}` : it.name);
const qtyTotal = (items) => items.reduce((n, it) => n + (it.qty || 1), 0);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const pad3 = (n) => String(n).padStart(3, '0');
const cleanCode = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const pad2 = (n) => String(n).padStart(2, '0');
// Local calendar date as YYYY-MM-DD (toISOString would give the UTC date).
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => localDay();

// e.g. Dine-001-croc, or Dine-001-croc-sent when the box is sentimental.
const SENT_CODE = 'sent';
function makeLabel(room, number, cat, sentimental) {
  return `${room}-${pad3(number)}-${cat}${sentimental ? '-' + SENT_CODE : ''}`;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function abToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToAb(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}

// ---------- Storage (IndexedDB), optionally encrypted ------------------------
//
// Records are kept in IndexedDB on this device only. If a passcode is set, every
// record (boxes, photos, expenses, receipts, settings) is encrypted with AES-GCM
// using a key derived from the passcode (PBKDF2-SHA-256). The key lives only in
// memory while the app is unlocked; the passcode itself is never stored.

const DB_NAME = 'trackit';
const STORES = ['boxes', 'expenses', 'recurring', 'receipts'];

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const name of STORES) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

async function read(storeName, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(storeName, 'readonly').objectStore(storeName));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function write(storeNames, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeNames, 'readwrite');
    fn(Array.isArray(storeNames) ? (n) => t.objectStore(n) : t.objectStore(storeNames));
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error || new Error('Save failed'));
  });
}

// ----- Encryption

const LOCK = { key: null, meta: null }; // meta: { salt, iter, check } when a passcode is set
const PBKDF2_ITER = 310000;
const te = new TextEncoder();
const td = new TextDecoder();

async function deriveKey(passcode, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv, ct };
}
const decryptBytes = (key, box) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.ct);

// Turn any object (including ArrayBuffers such as photos) into bytes, and back.
function pack(obj) {
  const bufs = [];
  const json = JSON.stringify(obj, (k, v) => {
    if (v instanceof ArrayBuffer) { bufs.push(new Uint8Array(v)); return { __ab: bufs.length - 1 }; }
    if (ArrayBuffer.isView(v)) { bufs.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); return { __ab: bufs.length - 1 }; }
    return v;
  });
  const head = te.encode(JSON.stringify({ l: bufs.map((b) => b.length), j: json }));
  const out = new Uint8Array(4 + head.length + bufs.reduce((n, b) => n + b.length, 0));
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  let o = 4 + head.length;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  return out;
}
function unpack(buf) {
  const u = new Uint8Array(buf);
  const hl = new DataView(u.buffer, u.byteOffset).getUint32(0);
  const head = JSON.parse(td.decode(u.subarray(4, 4 + hl)));
  const bufs = [];
  let o = 4 + hl;
  for (const len of head.l) { bufs.push(u.slice(o, o + len).buffer); o += len; }
  return JSON.parse(head.j, (k, v) => (v && typeof v === 'object' && typeof v.__ab === 'number' ? bufs[v.__ab] : v));
}

async function sealWith(key, rec, id) {
  if (!key || rec == null) return rec;
  return { id, sealed: await encryptBytes(key, pack(rec)) };
}
const seal = (rec, id) => sealWith(LOCK.key, rec, id);
async function unseal(rec) {
  if (!rec || !rec.sealed) return rec;
  if (!LOCK.key) throw new Error('Track-it is locked');
  return unpack(await decryptBytes(LOCK.key, rec.sealed));
}

// ----- Store helpers (all go through seal / unseal)

async function dbAll(store) { return Promise.all((await read(store, (s) => s.getAll())).map(unseal)); }
async function dbGet(store, id) { return unseal(await read(store, (s) => s.get(id))); }
async function dbPut(store, obj) { const v = await seal(obj, obj.id); return write(store, (s) => s.put(v)); }
async function dbPutMany(store, list) {
  const vs = await Promise.all(list.map((o) => seal(o, o.id)));
  return write(store, (s) => vs.forEach((v) => s.put(v)));
}
const dbDel = (store, id) => write(store, (s) => s.delete(id));
const dbDelMany = (store, ids) => write(store, (s) => ids.forEach((id) => s.delete(id)));
const dbClear = (store) => write(store, (s) => s.clear());
async function kvGet(k) { return unseal(await read('kv', (s) => s.get(k))); }
async function kvSet(k, v) { const sv = await seal(v); return write('kv', (s) => s.put(sv, k)); }
const kvGetRaw = (k) => read('kv', (s) => s.get(k));

const dbAllBoxes = () => dbAll('boxes');
const dbPutBox = (b) => dbPut('boxes', b);
const dbPutBoxes = (list) => dbPutMany('boxes', list);
const dbDelBox = (id) => dbDel('boxes', id);
const dbClearBoxes = () => dbClear('boxes');

// ----- Passcode

async function makeLockMeta(passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passcode, salt, PBKDF2_ITER);
  const check = await encryptBytes(key, te.encode('track-it'));
  return { key, meta: { salt, iter: PBKDF2_ITER, check } };
}

// Returns the key if the passcode is right, otherwise null.
async function tryPasscode(passcode, meta) {
  try {
    const key = await deriveKey(passcode, meta.salt, meta.iter);
    const ok = td.decode(await decryptBytes(key, meta.check)) === 'track-it';
    return ok ? key : null;
  } catch (_) { return null; }
}

// Re-save everything under a new key (or unencrypted when newKey is null), in
// one transaction, so a failure part-way leaves the old data as it was.
async function resealAll(newKey, newMeta) {
  const all = {};
  for (const st of STORES) all[st] = await dbAll(st);
  const settings = await kvGet('settings');
  const sealed = {};
  for (const st of STORES) sealed[st] = await Promise.all(all[st].map((o) => sealWith(newKey, o, o.id)));
  const sealedSettings = await sealWith(newKey, settings);
  await write([...STORES, 'kv'], (store) => {
    for (const st of STORES) { const s = store(st); s.clear(); sealed[st].forEach((v) => s.put(v)); }
    const kv = store('kv');
    kv.put(sealedSettings, 'settings');
    if (newMeta) kv.put(newMeta, 'lock'); else kv.delete('lock');
  });
  LOCK.key = newKey;
  LOCK.meta = newMeta;
}

async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (_) { /* not supported */ }
}

// ---------- App state ------------------------------------------------------

const S = {
  boxes: [],
  settings: null,
  search: '',
  roomFilter: '',
  sort: 'newest',
  draft: null,
  draftKey: null,
  draftDirty: false,
  // Expenses
  expenses: [],
  recurring: [],
  mSearch: '',
  mCat: '',
  mMonth: '',
  tab: 'boxes',
};

const saveSettings = () => kvSet('settings', S.settings);
const roomBy = (code) => S.settings.rooms.find((r) => r.code === code);
const catBy = (code) => S.settings.categories.find((c) => c.code === code);
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function nextNumber(roomCode, excludeId) {
  let max = 0;
  for (const b of S.boxes) {
    if (b.room === roomCode && b.id !== excludeId) max = Math.max(max, b.number || 0);
  }
  return max + 1;
}

// ---------- Photos ---------------------------------------------------------

const urlCache = new Map();
function photoURL(p, kind = 'thumb') {
  const key = p.id + ':' + kind;
  if (!urlCache.has(key)) {
    const data = kind === 'thumb' && p.thumb ? p.thumb : p.data;
    urlCache.set(key, URL.createObjectURL(new Blob([data], { type: p.type || 'image/jpeg' })));
  }
  return urlCache.get(key);
}
function forgetPhoto(p) {
  for (const kind of ['thumb', 'full']) {
    const key = p.id + ':' + kind;
    if (urlCache.has(key)) { URL.revokeObjectURL(urlCache.get(key)); urlCache.delete(key); }
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo')); };
    img.src = url;
  });
}

async function resizeTo(img, max, quality) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  return { data: await blob.arrayBuffer(), w: c.width, h: c.height };
}

async function processPhoto(file) {
  const img = await loadImage(file);
  const full = await resizeTo(img, PHOTO_MAX, 0.72);
  const thumb = await resizeTo(img, THUMB_MAX, 0.7);
  return { id: uid(), type: 'image/jpeg', data: full.data, thumb: thumb.data, tw: thumb.w, th: thumb.h };
}

function openViewer(photo, title) {
  const ov = document.createElement('div');
  ov.className = 'viewer';
  ov.innerHTML = `
    <img src="${photoURL(photo, 'full')}" alt="Photo of ${esc(title)}">
    <div class="viewer-bar">
      <button class="btn" data-a="share">Share photo</button>
      <button class="btn primary" data-a="close">Close</button>
    </div>`;
  ov.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'share') {
      const file = new File([photo.data], `${title}.jpg`, { type: 'image/jpeg' });
      shareFile(file);
    } else if (a === 'close' || e.target === ov || e.target.tagName === 'IMG') {
      ov.remove();
    }
  });
  document.body.appendChild(ov);
}

// ---------- Router ---------------------------------------------------------

function route() {
  if (S.locked) return renderLock();
  const h = location.hash.slice(1) || '/';
  const [path, query] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query || '');
  window.scrollTo(0, 0);
  setTabBar(null);
  if (parts[0] === 'box' && parts[1]) return renderDetail(parts[1]);
  if (parts[0] === 'new') return renderForm(null, params);
  if (parts[0] === 'edit' && parts[1]) return renderForm(parts[1], params);
  if (parts[0] === 'settings') return renderSettings();
  if (parts[0] === 'money') return routeMoney(parts.slice(1), params);
  if (parts[0] === 'boxes') return renderList();
  // Home: the last tab used, if it's switched on.
  return homeTab() === 'money' ? renderMoney() : renderList();
}

function homeTab() {
  const t = S.settings.tabs;
  if (!t.boxes) return 'money';
  if (!t.expenses) return 'boxes';
  return S.settings.lastTab === 'money' ? 'money' : 'boxes';
}
const homeHash = () => (homeTab() === 'money' ? '#/money' : '#/boxes');

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

// Bottom tab bar on the two main screens (hidden if only one tab is switched on).
function setTabBar(active) {
  $('#tabbar')?.remove();
  const both = S.settings && S.settings.tabs.boxes && S.settings.tabs.expenses;
  document.body.classList.toggle('has-tabs', !!(active && both));
  if (active) {
    S.tab = active;
    if (S.settings.lastTab !== active) { S.settings.lastTab = active; saveSettings(); }
  }
  if (!active || !both) return;
  const nav = document.createElement('nav');
  nav.id = 'tabbar';
  nav.className = 'tabbar';
  nav.innerHTML = `
    <a href="#/boxes" class="${active === 'boxes' ? 'on' : ''}"><span aria-hidden="true">📦</span>Boxes</a>
    <a href="#/money" class="${active === 'money' ? 'on' : ''}"><span aria-hidden="true">🧾</span>Expenses</a>`;
  document.body.appendChild(nav);
}

// Buttons on the right of the main screens' top bar.
function barButtonsHTML() {
  return `<div class="bar-btns">
      ${LOCK.meta ? '<button class="icon-btn" data-a="lock" aria-label="Lock now">🔒</button>' : ''}
      <button class="icon-btn" data-a="settings" aria-label="Settings & export">⚙︎</button>
    </div>`;
}

window.addEventListener('hashchange', route);

// ---------- List view ------------------------------------------------------

function matches(b, q) {
  if (!q) return true;
  const hay = [b.label, b.roomName, b.catName, b.sentimental ? 'sentimental' : '', itemsOf(b).map((it) => it.name).join('\n'), b.dest, b.destNote, b.notes].join('\n').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function renderList() {
  S.draft = null;
  setTabBar('boxes');
  const q = S.search.trim().toLowerCase();
  let list = S.boxes.filter((b) => (!S.roomFilter || b.room === S.roomFilter) && matches(b, q));
  if (S.sort === 'label') list.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  else list.sort((a, b) => b.createdAt - a.createdAt);

  const totalItems = S.boxes.reduce((n, b) => n + qtyTotal(itemsOf(b)), 0);
  const roomsInUse = [...new Map(S.boxes.map((b) => [b.room, b.roomName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  const showInstall = isIOS() && !isStandalone() && !S.settings.hideInstallTip;
  const lastBackup = S.settings.lastBackupAt || 0;
  const changedSince = S.boxes.some((b) => b.updatedAt > lastBackup);
  const showBackup = S.boxes.length >= 3 && changedSince && Date.now() - lastBackup > 2 * 864e5;

  $('#app').innerHTML = `
    <header class="bar">
      <h1 class="brand">Boxes</h1>
      ${barButtonsHTML()}
    </header>

    ${showInstall ? `
      <div class="tip">
        <strong>Tip:</strong> tap <b>Share</b> then <b>Add to Home Screen</b>.
        Track-it will open like an app, work without internet, and everything you enter is kept on this phone.
        <button class="link" data-a="hide-tip">Got it</button>
      </div>` : ''}

    ${showBackup ? `
      <div class="tip warm">
        You've got ${S.boxes.length} boxes recorded. It's worth saving a backup copy now and then
        (to Files, iCloud Drive or email) so nothing is lost if something happens to this phone.
        <button class="link" data-a="backup">Back up now</button>
      </div>` : ''}

    <section class="stats">
      <div><span class="num">${S.boxes.length}</span><span>boxes</span></div>
      <div><span class="num">${totalItems}</span><span>items</span></div>
      <div><span class="num">${roomsInUse.length}</span><span>rooms</span></div>
    </section>

    <div class="search">
      <input id="q" type="search" placeholder="Search boxes & contents…" value="${esc(S.search)}"
             autocomplete="off" autocorrect="off" enterkeyhint="search">
    </div>
    <div class="filters">
      <select id="roomFilter" aria-label="Filter by room">
        <option value="">All rooms</option>
        ${roomsInUse.map(([code, name]) => `<option value="${esc(code)}" ${S.roomFilter === code ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>
      <select id="sort" aria-label="Sort">
        <option value="newest" ${S.sort === 'newest' ? 'selected' : ''}>Newest first</option>
        <option value="label" ${S.sort === 'label' ? 'selected' : ''}>By label</option>
      </select>
    </div>

    <section id="list" class="list">
      ${list.length ? list.map((b) => cardHTML(b, q)).join('') : emptyHTML(q)}
    </section>

    <div class="fab-wrap">
      ${S.boxes.length ? `<button class="btn" data-a="export">Export Excel</button>` : ''}
      <button class="btn primary fab" data-a="new">＋ New box</button>
    </div>
  `;

  const qi = $('#q');
  qi.addEventListener('input', () => {
    S.search = qi.value;
    const qq = S.search.trim().toLowerCase();
    const l = S.boxes.filter((b) => (!S.roomFilter || b.room === S.roomFilter) && matches(b, qq));
    if (S.sort === 'label') l.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    else l.sort((a, b) => b.createdAt - a.createdAt);
    $('#list').innerHTML = l.length ? l.map((b) => cardHTML(b, qq)).join('') : emptyHTML(qq);
  });
  $('#roomFilter').addEventListener('change', (e) => { S.roomFilter = e.target.value; renderList(); });
  $('#sort').addEventListener('change', (e) => { S.sort = e.target.value; renderList(); });
  bindActions($('#app'), {
    settings: () => go('#/settings'),
    lock: lockNow,
    new: () => go('#/new'),
    export: exportExcel,
    backup: exportBackup,
    'hide-tip': async () => { S.settings.hideInstallTip = true; await saveSettings(); renderList(); },
  });
}

function emptyHTML(q) {
  if (q || S.roomFilter) return `<p class="empty">No boxes match that search.</p>`;
  return `
    <div class="empty">
      <div class="empty-icon" aria-hidden="true">📦</div>
      <p><strong>No boxes yet.</strong></p>
      <p>Tap <b>＋ New box</b>, pick the room and what's going in it, and Track-it will suggest a label
         like <code>Dine-001-croc</code> to write on the box (tick 💛 Sentimental and it becomes <code>Dine-001-croc-sent</code>). Snap a photo, list what's inside, and you're done.</p>
      <p class="soft">Take it one box at a time.</p>
    </div>`;
}

function cardHTML(b, q) {
  const items = itemsOf(b);
  let snippet;
  if (q) {
    const hits = items.filter((it) => q.split(/\s+/).some((w) => it.name.toLowerCase().includes(w)));
    snippet = (hits.length ? hits : items).slice(0, 3).map(itemText).join(' · ');
  } else {
    snippet = items.slice(0, 4).map(itemText).join(' · ');
  }
  const p = b.photos && b.photos[0];
  return `
    <a class="card" href="#/box/${esc(b.id)}">
      <div class="thumb">${p ? `<img src="${photoURL(p)}" alt="" loading="lazy">` : '<span aria-hidden="true">📦</span>'}</div>
      <div class="card-body">
        <div class="label-text">${esc(b.label)}${b.sentimental ? ' <span class="badge sent">💛</span>' : ''}${b.fragile ? ' <span class="badge fragile">Fragile</span>' : ''}</div>
        <div class="meta">${esc(b.roomName)} · ${esc(b.catName)} · ${plural(qtyTotal(items), 'item')}</div>
        ${snippet ? `<div class="snippet">${esc(snippet)}</div>` : ''}
      </div>
      ${b.dest && b.dest !== 'Undecided' ? `<span class="badge dest">${esc(b.dest)}</span>` : ''}
    </a>`;
}

// One click handler per view (assigning onclick replaces the previous view's handler).
function bindActions(root, handlers) {
  root.onclick = (e) => {
    const el = e.target.closest('[data-a]');
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.a];
    if (fn) { e.preventDefault(); fn(el, e); }
  };
}

// ---------- Box detail -----------------------------------------------------

function renderDetail(id) {
  S.draft = null;
  const b = S.boxes.find((x) => x.id === id);
  if (!b) { go('#/boxes'); return; }
  const items = itemsOf(b);
  $('#app').innerHTML = `
    <header class="bar">
      <button class="link back" data-a="back">‹ Boxes</button>
      <span></span>
      <button class="link" data-a="edit">Edit</button>
    </header>

    <section class="label-card">
      <div class="big-label">${esc(b.label)}</div>
      <div class="meta">${esc(b.roomName)} · ${esc(b.catName)}</div>
      <div class="badges">
        ${b.sentimental ? '<span class="badge sent">💛 Sentimental</span>' : ''}
        ${b.fragile ? '<span class="badge fragile">Fragile</span>' : ''}
        ${b.dest ? `<span class="badge dest">${esc(b.dest)}${b.destNote ? ' — ' + esc(b.destNote) : ''}</span>` : ''}
      </div>
    </section>

    ${b.photos && b.photos.length ? `
      <section class="photos view">
        ${b.photos.map((p, i) => `<button class="ph" data-a="photo" data-i="${i}"><img src="${photoURL(p)}" alt="Photo ${i + 1}"></button>`).join('')}
      </section>` : ''}

    <section class="panel">
      <h2>Contents <span class="count">${qtyTotal(items)}</span></h2>
      ${items.length ? `<ul class="items">${items.map((it) => `<li><span>${esc(it.name)}</span><span class="qty">× ${it.qty || 1}</span></li>`).join('')}</ul>` : '<p class="soft">Nothing listed yet.</p>'}
    </section>

    ${b.notes ? `<section class="panel"><h2>Notes</h2><p class="pre">${esc(b.notes)}</p></section>` : ''}

    <section class="panel small soft">
      Packed ${fmtDate(b.createdAt)}${b.updatedAt && b.updatedAt - b.createdAt > 60000 ? ` · updated ${fmtDate(b.updatedAt)}` : ''}
    </section>

    <div class="stack">
      <button class="btn primary" data-a="next">＋ Next box in ${esc(b.roomName)}</button>
      <button class="btn danger-ghost" data-a="delete">Delete this box</button>
    </div>
  `;
  bindActions($('#app'), {
    back: () => go('#/boxes'),
    edit: () => go('#/edit/' + b.id),
    photo: (el) => openViewer(b.photos[+el.dataset.i], b.label),
    next: () => go(`#/new?room=${encodeURIComponent(b.room)}&cat=${encodeURIComponent(b.cat)}${b.sentimental ? '&sent=1' : ''}`),
    delete: async () => {
      if (!confirm(`Delete box ${b.label}? This can't be undone.`)) return;
      await dbDelBox(b.id);
      (b.photos || []).forEach(forgetPhoto);
      S.boxes = S.boxes.filter((x) => x.id !== b.id);
      toast(`Deleted ${b.label}`);
      location.replace('#/boxes');
    },
  });
}

// ---------- New / edit form ------------------------------------------------

function renderForm(id, params) {
  const key = id ? 'edit:' + id : 'new:' + (params ? params.toString() : '');
  if (!S.draft || S.draftKey !== key) {
    if (id) {
      const b = S.boxes.find((x) => x.id === id);
      if (!b) { go('#/boxes'); return; }
      S.draft = { ...b, photos: [...(b.photos || [])], items: itemsOf(b).map((it) => ({ ...it })) };
      S.draft.labelCustom = b.label !== makeLabel(b.room, b.number, b.cat, b.sentimental);
    } else {
      const rooms = S.settings.rooms, cats = S.settings.categories;
      const room = (params && params.get('room')) || S.settings.lastRoom || (rooms[0] && rooms[0].code) || 'Room';
      const cat = (params && params.get('cat')) || S.settings.lastCat || (cats[0] && cats[0].code) || 'misc';
      S.draft = {
        id: null, room, cat, number: nextNumber(room), labelCustom: false,
        sentimental: !!(params && params.get('sent') === '1'),
        items: [], dest: 'Undecided', destNote: '', fragile: false, notes: '', photos: [],
      };
      S.draft.label = makeLabel(room, S.draft.number, cat, S.draft.sentimental);
    }
    S.draftKey = key;
    S.draftDirty = false;
  }
  const d = S.draft;
  const original = id ? S.boxes.find((x) => x.id === id) : null;

  const roomOpts = [...S.settings.rooms];
  if (!roomBy(d.room)) roomOpts.push({ code: d.room, name: d.roomName || d.room });
  const catOpts = [...S.settings.categories];
  if (!catBy(d.cat)) catOpts.push({ code: d.cat, name: d.catName || d.cat });

  $('#app').innerHTML = `
    <header class="bar">
      <button class="link" data-a="cancel">Cancel</button>
      <h1>${id ? 'Edit box' : 'New box'}</h1>
      <button class="link strong" data-a="save">Save</button>
    </header>

    <section class="label-card editable">
      <label for="label" class="tiny">Box label — write this on the box</label>
      <input id="label" class="big-label-input" value="${esc(d.label)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <button class="link small" data-a="auto-label" id="autoLabel" ${d.labelCustom ? '' : 'hidden'}>↺ Use automatic label</button>
    </section>

    <div class="row2">
      <label class="field">
        <span>Room</span>
        <select id="room">
          ${roomOpts.map((r) => `<option value="${esc(r.code)}" ${r.code === d.room ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span>What's in it</span>
        <select id="cat">
          ${catOpts.map((c) => `<option value="${esc(c.code)}" ${c.code === d.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </label>
    </div>

    <label class="check sent">
      <input type="checkbox" id="sentimental" ${d.sentimental ? 'checked' : ''}>
      <span>💛 Sentimental <em class="soft">(adds -sent)</em></span>
    </label>

    <section class="field">
      <span>Photos</span>
      <div class="photos edit" id="photos"></div>
      <div class="photo-btns">
        <label class="btn primary">
          📷 Snap photo
          <input type="file" accept="image/*" capture="environment" id="camera" hidden>
        </label>
        <label class="btn">
          🖼 From library
          <input type="file" accept="image/*" multiple id="library" hidden>
        </label>
      </div>
      <p class="tiny soft" id="photoStatus">Snap the label on the box, and the contents too if it helps.</p>
    </section>

    <section class="field">
      <span>Contents <em class="soft" id="itemTotal"></em></span>
      <div class="item-head tiny soft"><span>Item</span><span>Qty</span><span></span></div>
      <div id="items" class="item-rows"></div>
      <button class="btn small" data-a="add-item">＋ Add item</button>
    </section>

    <div class="row2">
      <label class="field">
        <span>Where is it going?</span>
        <select id="dest">
          ${DESTINATIONS.map((x) => `<option ${x === d.dest ? 'selected' : ''}>${esc(x)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span>For whom / where</span>
        <input id="destNote" value="${esc(d.destNote)}" placeholder="e.g. Sarah, op shop">
      </label>
    </div>

    <label class="check">
      <input type="checkbox" id="fragile" ${d.fragile ? 'checked' : ''}>
      <span>Fragile — handle with care</span>
    </label>

    <label class="field">
      <span>Notes</span>
      <textarea id="notes" rows="3" placeholder="Anything else worth remembering">${esc(d.notes)}</textarea>
    </label>

    <div class="stack">
      <button class="btn primary" data-a="save">Save box</button>
    </div>
  `;

  const labelInput = $('#label');
  const autoBtn = $('#autoLabel');
  const syncLabel = () => {
    const auto = makeLabel(d.room, d.number, d.cat, d.sentimental);
    if (!d.labelCustom) { d.label = auto; labelInput.value = auto; }
    autoBtn.hidden = !d.labelCustom;
  };
  const dirty = () => { S.draftDirty = true; };

  labelInput.addEventListener('input', () => {
    d.label = labelInput.value;
    d.labelCustom = d.label !== makeLabel(d.room, d.number, d.cat, d.sentimental);
    autoBtn.hidden = !d.labelCustom;
    dirty();
  });
  $('#room').addEventListener('change', (e) => {
    d.room = e.target.value;
    d.number = original && original.room === d.room ? original.number : nextNumber(d.room, d.id);
    syncLabel(); dirty();
  });
  $('#cat').addEventListener('change', (e) => { d.cat = e.target.value; syncLabel(); dirty(); });
  for (const f of ['destNote', 'notes']) {
    $('#' + f).addEventListener('input', (e) => { d[f] = e.target.value; dirty(); });
  }
  $('#dest').addEventListener('change', (e) => { d.dest = e.target.value; dirty(); });
  $('#fragile').addEventListener('change', (e) => { d.fragile = e.target.checked; dirty(); });
  $('#sentimental').addEventListener('change', (e) => { d.sentimental = e.target.checked; syncLabel(); dirty(); });

  // ----- Contents rows: item name + quantity. There is always one empty row at the end.
  const itemsWrap = $('#items');
  const rowHTML = (it, i) => `
    <div class="item-row" data-i="${i}">
      <input class="it-name" value="${esc(it.name)}" placeholder="${i === 0 ? 'e.g. Astra crystal lowballs' : 'Item'}"
             enterkeyhint="next" autocapitalize="sentences" aria-label="Item ${i + 1}">
      <input class="it-qty" value="${it.name && it.qty ? esc(it.qty) : ''}" placeholder="1" inputmode="numeric" pattern="[0-9]*"
             enterkeyhint="next" aria-label="Quantity for item ${i + 1}">
      <button class="icon-btn small" data-a="del-item" data-i="${i}" aria-label="Remove item" ${it.name ? '' : 'hidden'}>×</button>
    </div>`;
  const updateTotal = () => {
    const filled = d.items.filter((it) => it.name.trim());
    $('#itemTotal').textContent = filled.length ? `— ${plural(qtyTotal(filled), 'item')}` : '';
  };
  const ensureBlankRow = () => {
    const last = d.items[d.items.length - 1];
    if (!last || last.name.trim()) {
      d.items.push({ name: '', qty: 1 });
      itemsWrap.insertAdjacentHTML('beforeend', rowHTML(d.items[d.items.length - 1], d.items.length - 1));
    }
  };
  const renderItems = () => {
    d.items = d.items.filter((it) => it.name.trim());
    itemsWrap.innerHTML = d.items.map(rowHTML).join('');
    ensureBlankRow();
    updateTotal();
  };
  itemsWrap.addEventListener('input', (e) => {
    const row = e.target.closest('.item-row');
    const it = d.items[+row.dataset.i];
    if (e.target.classList.contains('it-name')) {
      it.name = e.target.value;
      $('[data-a="del-item"]', row).hidden = !it.name;
      if (it.name.trim()) ensureBlankRow();
    } else {
      e.target.value = e.target.value.replace(/[^0-9]/g, '');
      it.qty = cleanQty(e.target.value);
    }
    updateTotal(); dirty();
  });
  itemsWrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const row = e.target.closest('.item-row');
    if (e.target.classList.contains('it-name')) {
      $('.it-qty', row).focus();
    } else {
      ensureBlankRow();
      const next = row.nextElementSibling;
      if (next) $('.it-name', next).focus();
    }
  });
  renderItems();

  const renderPhotos = () => {
    $('#photos').innerHTML = d.photos.map((p, i) => `
      <div class="ph">
        <img src="${photoURL(p)}" alt="Photo ${i + 1}" data-a="view" data-i="${i}">
        <button class="ph-del" data-a="del-photo" data-i="${i}" aria-label="Remove photo">×</button>
      </div>`).join('');
  };
  renderPhotos();

  const onFiles = async (input) => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    const status = $('#photoStatus');
    status.textContent = files.length > 1 ? `Saving ${files.length} photos…` : 'Saving photo…';
    for (const f of files) {
      try { d.photos.push(await processPhoto(f)); dirty(); }
      catch (err) { toast(err.message); }
    }
    status.textContent = `${d.photos.length} photo${d.photos.length === 1 ? '' : 's'} attached.`;
    renderPhotos();
  };
  $('#camera').addEventListener('change', (e) => onFiles(e.target));
  $('#library').addEventListener('change', (e) => onFiles(e.target));

  bindActions($('#app'), {
    cancel: () => {
      if (S.draftDirty && !confirm('Discard your changes to this box?')) return;
      S.draft = null;
      history.length > 1 ? history.back() : go('#/boxes');
    },
    save: saveDraft,
    'auto-label': () => { d.labelCustom = false; syncLabel(); },
    'add-item': () => {
      ensureBlankRow();
      const rows = $$('.item-row', itemsWrap);
      $('.it-name', rows[rows.length - 1]).focus();
    },
    'del-item': (el) => {
      d.items.splice(+el.dataset.i, 1);
      dirty(); renderItems();
    },
    view: (el) => openViewer(d.photos[+el.dataset.i], d.label),
    'del-photo': (el) => {
      if (!confirm('Remove this photo?')) return;
      d.photos.splice(+el.dataset.i, 1);
      dirty(); renderPhotos();
    },
  });
}

async function saveDraft() {
  const d = S.draft;
  if (!d) return;
  const label = (d.label || '').trim();
  if (!label) { toast('Please give the box a label'); $('#label')?.focus(); return; }
  const dup = S.boxes.find((b) => b.id !== d.id && b.label.toLowerCase() === label.toLowerCase());
  if (dup && !confirm(`Another box is already labelled ${label}. Save anyway?`)) return;

  // If the label was typed by hand and contains this room's prefix and a number,
  // use that number so the next suggested label carries on from it.
  let number = d.number;
  const m = label.match(/^([^-]+)-(\d{1,5})(?:-|$)/);
  if (d.labelCustom && m && m[1].toLowerCase() === d.room.toLowerCase()) number = parseInt(m[2], 10);

  const room = roomBy(d.room), cat = catBy(d.cat);
  const now = Date.now();
  const box = {
    id: d.id || uid(),
    label,
    room: d.room,
    roomName: room ? room.name : (d.roomName || d.room),
    number,
    cat: d.cat,
    catName: cat ? cat.name : (d.catName || d.cat),
    items: (d.items || []).map((it) => ({ name: it.name.trim(), qty: cleanQty(it.qty) })).filter((it) => it.name),
    dest: d.dest || 'Undecided',
    destNote: (d.destNote || '').trim(),
    fragile: !!d.fragile,
    sentimental: !!d.sentimental,
    notes: (d.notes || '').trim(),
    photos: d.photos,
    createdAt: d.createdAt || now,
    updatedAt: now,
  };
  try {
    await dbPutBox(box);
  } catch (err) {
    alert('Sorry — the box could not be saved. ' + (err && err.message ? err.message : '') +
      '\nIf your phone is low on storage, try freeing some space.');
    return;
  }
  const i = S.boxes.findIndex((b) => b.id === box.id);
  if (i >= 0) {
    (S.boxes[i].photos || []).filter((p) => !box.photos.includes(p)).forEach(forgetPhoto);
    S.boxes[i] = box;
  } else {
    S.boxes.push(box);
  }
  S.settings.lastRoom = box.room;
  S.settings.lastCat = box.cat;
  saveSettings();
  requestPersist();
  S.draft = null;
  toast(`Saved ${box.label}`);
  location.replace('#/box/' + box.id);
  if (S.reloadAfterSave) setTimeout(() => location.reload(), 300);
}

// ---------- Settings -------------------------------------------------------

function renderSettings() {
  S.draft = null;
  const tabs = S.settings.tabs;
  const est = S.settings.estate;
  const listEditor = (kind, title, hint) => `
    <section class="panel">
      <h2>${title}</h2>
      <p class="tiny soft">${hint}</p>
      <div class="code-list" data-kind="${kind}">
        ${S.settings[kind].map((r, i) => `
          <div class="code-row">
            <input class="name" data-i="${i}" value="${esc(r.name)}" aria-label="Name">
            <input class="code" data-i="${i}" value="${esc(r.code)}" aria-label="Code" autocapitalize="off" autocorrect="off" spellcheck="false">
            <button class="icon-btn small" data-a="del-${kind}" data-i="${i}" aria-label="Remove">×</button>
          </div>`).join('')}
      </div>
      <button class="btn small" data-a="add-${kind}">＋ Add</button>
    </section>`;
  const estField = (k, label, attrs = '') => `
    <label class="field"><span>${label}</span>
      <input class="est" data-k="${k}" value="${esc(est[k] || '')}" ${attrs}></label>`;
  const hasData = S.boxes.length || S.expenses.length || S.recurring.length;

  $('#app').innerHTML = `
    <header class="bar">
      <button class="link back" data-a="back">‹ Back</button>
      <h1>Settings</h1>
      <span></span>
    </header>

    <section class="panel">
      <h2>Privacy</h2>
      <p class="small">Everything you enter stays on this phone. The app's web address only serves the app itself — your
        boxes, expenses and receipts are never uploaded, so nobody else can see them.</p>
      ${LOCK.meta ? `
        <p class="small"><b>🔒 Passcode is on.</b> Your data is encrypted on this phone and needs the passcode to open.</p>
        <label class="field"><span>Lock automatically after</span>
          <select id="autoLock">
            ${[1, 5, 15, 60].map((m) => `<option value="${m}" ${S.settings.autoLockMin === m ? 'selected' : ''}>${m === 60 ? '1 hour' : m + ' minute' + (m === 1 ? '' : 's')} away</option>`).join('')}
          </select></label>
        <div class="stack">
          <button class="btn" data-a="change-pass">Change passcode</button>
          <button class="btn danger-ghost small" data-a="remove-pass">Turn off passcode</button>
        </div>` : `
        <p class="small">Add a passcode so the app asks for it when opened, and your data is encrypted on this phone.</p>
        <div class="stack"><button class="btn primary" data-a="set-pass">Set a passcode</button></div>`}
    </section>

    <section class="panel">
      <h2>Show in the app</h2>
      <label class="check"><input type="checkbox" class="tabchk" data-k="boxes" ${tabs.boxes ? 'checked' : ''}><span>📦 Boxes</span></label>
      <label class="check"><input type="checkbox" class="tabchk" data-k="expenses" ${tabs.expenses ? 'checked' : ''}><span>🧾 Estate expenses</span></label>
      <p class="tiny soft">Untick one to use Track-it just for the other. Nothing is deleted.</p>
    </section>

    ${tabs.expenses ? `
    <section class="panel">
      <h2>Estate details</h2>
      <p class="tiny soft">Shown on the expenses screen and at the top of the spreadsheet.</p>
      ${estField('deceased', 'Name of the deceased', 'autocapitalize="words"')}
      <div class="row2">
        ${estField('dod', 'Date of death', 'type="date"')}
        ${estField('ref', 'Reference <em class="soft">(e.g. probate no.)</em>')}
      </div>
      ${estField('admin', 'Administrator / executor', 'autocapitalize="words"')}
    </section>

    <section class="panel">
      <h2>Expense categories</h2>
      <div class="code-list" id="expCats">
        ${S.settings.expCats.map((c, i) => `
          <div class="cat-row">
            <input class="name" data-i="${i}" value="${esc(c)}" aria-label="Category name">
            <button class="icon-btn small" data-a="del-expcat" data-i="${i}" aria-label="Remove">×</button>
          </div>`).join('')}
      </div>
      <button class="btn small" data-a="add-expcat">＋ Add</button>
    </section>` : ''}

    <section class="panel">
      <h2>Export & backup</h2>
      <div class="stack">
        ${tabs.expenses ? `
          <button class="btn primary" data-a="export-money" ${S.expenses.length ? '' : 'disabled'}>Export expenses spreadsheet</button>
          <button class="btn" data-a="share-receipts" ${S.expenses.some((e) => e.receipts && e.receipts.length) ? '' : 'disabled'}>Save all receipts</button>
          <p class="tiny soft">A .xlsx file for Excel, Numbers or Google Sheets with every expense, totals by category and
            recurring costs. Receipts are named by date, payee and amount so they match the spreadsheet.</p>` : ''}
        ${tabs.boxes ? `
          <button class="btn ${tabs.expenses ? '' : 'primary'}" data-a="export" ${S.boxes.length ? '' : 'disabled'}>Export boxes spreadsheet</button>` : ''}
        <button class="btn" data-a="backup" ${hasData ? '' : 'disabled'}>Save full backup</button>
        <p class="tiny soft">Everything including photos and receipts, in one file you can restore later or on another phone.
          ${LOCK.meta ? 'The backup is encrypted — you\'ll need your passcode to restore it. ' : ''}
          ${S.settings.lastBackupAt ? `Last backup: ${fmtDate(S.settings.lastBackupAt)}.` : 'No backup saved yet.'}</p>
        <label class="btn">
          Restore from backup
          <input type="file" id="restore" accept=".json,application/json" hidden>
        </label>
        <p class="tiny soft">Pack-it backups can be restored here too.</p>
      </div>
      <p class="tiny soft" id="storageInfo"></p>
    </section>

    ${tabs.boxes ? `
    ${listEditor('rooms', 'Rooms', 'The code is the first part of the label, e.g. <code>Dine</code>-001-croc.')}
    ${listEditor('categories', 'Contents categories', 'The code comes after the number, e.g. Dine-001-<code>croc</code>. Sentimental is a separate tick-box that adds -sent on the end.')}` : ''}

    <section class="panel">
      <h2>About</h2>
      <p class="small">Track-it keeps everything on this phone only — nothing is uploaded anywhere.
        Back up now and then so nothing is lost if something happens to the phone.</p>
      ${S.boxes.length ? '<button class="btn danger-ghost small" data-a="wipe">Delete all boxes…</button>' : ''}
      ${S.expenses.length || S.recurring.length ? '<button class="btn danger-ghost small" data-a="wipe-money">Delete all expenses…</button>' : ''}
    </section>
  `;

  if (navigator.storage && navigator.storage.estimate) {
    Promise.all([navigator.storage.estimate(), navigator.storage.persisted ? navigator.storage.persisted() : false])
      .then(([est, persisted]) => {
        const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
        $('#storageInfo') && ($('#storageInfo').textContent =
          `Using ${mb(est.usage || 0)} of storage${persisted ? ' · protected from automatic clearing' : ''}.`);
      }).catch(() => {});
  }

  for (const kind of tabs.boxes ? ['rooms', 'categories'] : []) {
    const wrap = $(`.code-list[data-kind="${kind}"]`);
    wrap.addEventListener('change', async (e) => {
      const el = e.target;
      const i = +el.dataset.i;
      const entry = S.settings[kind][i];
      if (!entry) return;
      if (el.classList.contains('name')) {
        entry.name = el.value.trim() || entry.name;
        el.value = entry.name;
      } else {
        const code = cleanCode(el.value);
        if (!code) { el.value = entry.code; return; }
        if (S.settings[kind].some((x, j) => j !== i && x.code.toLowerCase() === code.toLowerCase())) {
          toast(`The code "${code}" is already used`);
          el.value = entry.code;
          return;
        }
        const inUse = S.boxes.filter((b) => (kind === 'rooms' ? b.room : b.cat) === entry.code).length;
        if (inUse) toast(`Existing boxes keep their labels; new boxes will use ${code}`, 3500);
        entry.code = code;
        el.value = code;
      }
      await saveSettings();
    });
  }

  $$('.tabchk').forEach((el) => el.addEventListener('change', async () => {
    const other = el.dataset.k === 'boxes' ? 'expenses' : 'boxes';
    if (!el.checked && !tabs[other]) { el.checked = true; toast('Keep at least one switched on'); return; }
    tabs[el.dataset.k] = el.checked;
    await saveSettings();
    renderSettings();
  }));
  $$('.est').forEach((el) => el.addEventListener('change', async () => {
    est[el.dataset.k] = el.value.trim();
    await saveSettings();
  }));
  $('#expCats')?.addEventListener('change', async (e) => {
    const i = +e.target.dataset.i;
    const old = S.settings.expCats[i];
    const name = e.target.value.trim();
    if (!name) { e.target.value = old; return; }
    S.settings.expCats[i] = name;
    // Rename it on existing expenses too, so totals stay together.
    const changed = S.expenses.filter((x) => x.cat === old);
    changed.forEach((x) => { x.cat = name; });
    const rules = S.recurring.filter((r) => r.cat === old);
    rules.forEach((r) => { r.cat = name; });
    if (changed.length) await dbPutMany('expenses', changed);
    if (rules.length) await dbPutMany('recurring', rules);
    await saveSettings();
  });
  $('#autoLock')?.addEventListener('change', async (e) => {
    S.settings.autoLockMin = +e.target.value;
    await saveSettings();
  });

  const addEntry = async (kind) => {
    const name = prompt(kind === 'rooms' ? 'Room name (e.g. Sunroom)' : 'Category name (e.g. Records)');
    if (!name || !name.trim()) return;
    let code = cleanCode(prompt('Short code for the label (letters/numbers, up to 6)',
      kind === 'rooms' ? cleanCode(name).slice(0, 4) : cleanCode(name).slice(0, 4).toLowerCase()));
    if (!code) return;
    if (S.settings[kind].some((x) => x.code.toLowerCase() === code.toLowerCase())) {
      toast(`The code "${code}" is already used`); return;
    }
    S.settings[kind].push({ name: name.trim(), code });
    await saveSettings();
    renderSettings();
  };
  const delEntry = async (kind, i) => {
    const entry = S.settings[kind][i];
    const inUse = S.boxes.filter((b) => (kind === 'rooms' ? b.room : b.cat) === entry.code).length;
    const msg = inUse
      ? `Remove "${entry.name}" from the list? The ${inUse} box${inUse === 1 ? '' : 'es'} already using it won't change.`
      : `Remove "${entry.name}"?`;
    if (!confirm(msg)) return;
    S.settings[kind].splice(i, 1);
    await saveSettings();
    renderSettings();
  };

  $('#restore').addEventListener('change', (e) => restoreBackup(e.target));

  bindActions($('#app'), {
    back: () => go(homeHash()),
    export: exportExcel,
    'export-money': exportExpensesExcel,
    'share-receipts': shareAllReceipts,
    backup: exportBackup,
    'add-rooms': () => addEntry('rooms'),
    'add-categories': () => addEntry('categories'),
    'del-rooms': (el) => delEntry('rooms', +el.dataset.i),
    'del-categories': (el) => delEntry('categories', +el.dataset.i),
    'add-expcat': async () => {
      const name = (prompt('New expense category') || '').trim();
      if (!name) return;
      if (S.settings.expCats.some((c) => c.toLowerCase() === name.toLowerCase())) { toast('That category is already there'); return; }
      S.settings.expCats.push(name);
      await saveSettings();
      renderSettings();
    },
    'del-expcat': async (el) => {
      const name = S.settings.expCats[+el.dataset.i];
      const n = S.expenses.filter((x) => x.cat === name).length;
      if (!confirm(n ? `Remove "${name}" from the list? The ${n} expense${n === 1 ? '' : 's'} already in it keep it.` : `Remove "${name}"?`)) return;
      S.settings.expCats.splice(+el.dataset.i, 1);
      await saveSettings();
      renderSettings();
    },
    'set-pass': () => setPasscode(false),
    'change-pass': () => setPasscode(true),
    'remove-pass': async () => {
      if (!confirm('Turn off the passcode? Your data will stay on this phone but will no longer be encrypted.')) return;
      const done = busy('Removing passcode…');
      try { await resealAll(null, null); done(); toast('Passcode turned off'); renderSettings(); }
      catch (err) { done(); alert('Sorry — that didn\'t work.\n' + (err.message || err)); }
    },
    wipe: async () => {
      if (!S.boxes.length) { toast('There are no boxes to delete'); return; }
      if (!confirm(`Delete all ${S.boxes.length} boxes and their photos from this phone?`)) return;
      if (prompt('This cannot be undone. Type DELETE to confirm.') !== 'DELETE') return;
      await dbClearBoxes();
      S.boxes.forEach((b) => (b.photos || []).forEach(forgetPhoto));
      S.boxes = [];
      toast('All boxes deleted');
      renderSettings();
    },
    'wipe-money': async () => {
      if (!confirm(`Delete all ${S.expenses.length} expenses, their receipts and ${S.recurring.length} recurring cost${S.recurring.length === 1 ? '' : 's'} from this phone?`)) return;
      if (prompt('This cannot be undone. Type DELETE to confirm.') !== 'DELETE') return;
      for (const st of ['expenses', 'recurring', 'receipts']) await dbClear(st);
      S.expenses = [];
      S.recurring = [];
      forgetReceiptURLs();
      toast('All expenses deleted');
      renderSettings();
    },
  });
}

// ---------- Passcode screens -------------------------------------------------

// Bottom sheet asking for a new passcode twice. Resolves to the passcode or null.
function askNewPasscode(heading) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML = `
      <form class="sheet" role="dialog" aria-modal="true">
        <h2>${esc(heading)}</h2>
        <p class="small">At least 6 characters. Numbers only is fine. <b>Write it down somewhere safe</b> — if it's
          forgotten, the data can't be recovered, not even from a backup.</p>
        <label class="field"><span>New passcode</span>
          <input type="password" id="p1" autocomplete="new-password" minlength="6" required></label>
        <label class="field"><span>Type it again</span>
          <input type="password" id="p2" autocomplete="new-password" minlength="6" required></label>
        <p class="tiny" id="pErr" style="color:var(--danger)"></p>
        <div class="stack">
          <button class="btn primary" type="submit">Save passcode</button>
          <button class="btn ghost" type="button" data-a="close">Cancel</button>
        </div>
      </form>`;
    const finish = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const a = $('#p1', ov).value, b = $('#p2', ov).value;
      if (a.length < 6) { $('#pErr', ov).textContent = 'Please use at least 6 characters.'; return; }
      if (a !== b) { $('#pErr', ov).textContent = 'Those don\'t match — try again.'; $('#p2', ov).value = ''; return; }
      finish(a);
    });
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.dataset.a === 'close') finish(null); });
    document.body.appendChild(ov);
    $('#p1', ov).focus();
  });
}

async function setPasscode(changing) {
  const pass = await askNewPasscode(changing ? 'Change passcode' : 'Set a passcode');
  if (!pass) return;
  const done = busy('Encrypting your data…');
  try {
    const { key, meta } = await makeLockMeta(pass);
    await resealAll(key, meta);
    if (!S.settings.autoLockMin) { S.settings.autoLockMin = 5; await saveSettings(); }
    done();
    toast(changing ? 'Passcode changed' : 'Passcode set — your data is now encrypted', 3500);
    renderSettings();
  } catch (err) {
    done();
    alert('Sorry — the passcode could not be set.\n' + (err.message || err));
  }
}

function renderLock() {
  setTabBar(null);
  $('#app').innerHTML = `
    <form class="lock" id="lockForm">
      <div class="lock-icon" aria-hidden="true">🔒</div>
      <h1>Track-it</h1>
      <p class="soft">Enter your passcode</p>
      <input type="password" id="pass" autocomplete="current-password" aria-label="Passcode" required>
      <p class="small" id="lockErr" style="color:var(--danger)"></p>
      <button class="btn primary" type="submit">Unlock</button>
      <button class="link small" type="button" data-a="forgot">Forgotten passcode?</button>
    </form>`;
  const input = $('#pass');
  input.focus();
  $('#lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#lockForm button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    const key = await tryPasscode(input.value, LOCK.meta);
    if (!key) {
      btn.disabled = false;
      btn.textContent = 'Unlock';
      $('#lockErr').textContent = 'That passcode isn\'t right.';
      input.value = '';
      input.focus();
      return;
    }
    LOCK.key = key;
    S.locked = false;
    loadAll();
  });
  bindActions($('#app'), {
    forgot: async () => {
      alert('The passcode can\'t be recovered or reset — that\'s what keeps your data private.\n\n' +
        'If it\'s truly lost, you can erase everything in Track-it on this phone and start again ' +
        '(or restore a backup that was saved before a passcode was set).');
      if (!confirm('Erase ALL Track-it data on this phone?')) return;
      if (prompt('This cannot be undone. Type ERASE to confirm.') !== 'ERASE') return;
      await write([...STORES, 'kv'], (store) => { [...STORES, 'kv'].forEach((n) => store(n).clear()); });
      location.reload();
    },
  });
}

function lockNow() {
  location.hash = '';
  location.reload();
}

// Lock again after the app has been in the background for a while.
function setupAutoLock() {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (LOCK.meta && hiddenAt && Date.now() - hiddenAt > (S.settings.autoLockMin || 5) * 60000) lockNow();
  });
}

// ---------- Sharing files ----------------------------------------------------

function canShareFile(file) {
  try { return !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (_) { return false; }
}

async function shareFile(file) {
  if (canShareFile(file)) {
    try { await navigator.share({ files: [file], title: file.name }); return true; }
    catch (err) { if (err.name === 'AbortError') return false; }
  }
  downloadFile(file);
  return true;
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// The file is built first; the share sheet opens from a fresh tap, which iOS requires.
function offerFile(file, heading, detail, onDone) {
  const ov = document.createElement('div');
  ov.className = 'modal';
  const share = canShareFile(file);
  ov.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <h2>${esc(heading)}</h2>
      <p class="small">${esc(detail)}</p>
      <p class="tiny soft">${esc(file.name)} · ${(file.size / 1048576).toFixed(1)} MB</p>
      <div class="stack">
        ${share ? '<button class="btn primary" data-a="share">Share / Save to Files</button>' : ''}
        <button class="btn ${share ? '' : 'primary'}" data-a="dl">Download</button>
        <button class="btn ghost" data-a="close">Close</button>
      </div>
    </div>`;
  ov.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'share') {
      try {
        await navigator.share({ files: [file], title: file.name });
        onDone && onDone();
        ov.remove();
      } catch (err) {
        if (err.name !== 'AbortError') toast('Could not share: ' + err.message);
      }
    } else if (a === 'dl') {
      downloadFile(file);
      onDone && onDone();
    } else if (a === 'close' || e.target === ov) {
      ov.remove();
    }
  });
  document.body.appendChild(ov);
}

function busy(msg) {
  const ov = document.createElement('div');
  ov.className = 'modal';
  ov.innerHTML = `<div class="sheet center"><div class="spinner" aria-hidden="true"></div><p>${esc(msg)}</p></div>`;
  document.body.appendChild(ov);
  return () => ov.remove();
}

// ---------- Excel export ---------------------------------------------------

function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/exceljs.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the spreadsheet tool. Check your connection and try again.'));
    document.head.appendChild(s);
  });
}

async function buildWorkbook(boxes) {
  await loadExcelJS();
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Track-it';
  wb.created = new Date();

  const headerStyle = (ws) => {
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF35574B' } };
    r.alignment = { vertical: 'middle' };
    r.height = 22;
  };
  const sorted = [...boxes].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  // Sheet 1: one row per box, with the first photo embedded.
  const ws = wb.addWorksheet('Boxes', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Label', key: 'label', width: 18 },
    { header: 'Room', key: 'room', width: 16 },
    { header: 'Category', key: 'cat', width: 20 },
    { header: 'Contents', key: 'contents', width: 48 },
    { header: 'Items', key: 'count', width: 7 },
    { header: 'Destination', key: 'dest', width: 14 },
    { header: 'For / where', key: 'destNote', width: 18 },
    { header: 'Sentimental', key: 'sentimental', width: 12 },
    { header: 'Fragile', key: 'fragile', width: 8 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Packed', key: 'packed', width: 13 },
    { header: 'Photos', key: 'photos', width: 8 },
    { header: 'Photo', key: 'img', width: 18 },
  ];
  headerStyle(ws);
  const PHOTO_COL = 12; // zero-based index of the "Photo" column (M)
  const IMG_BOX = 120;  // px

  for (const b of sorted) {
    const items = itemsOf(b);
    const row = ws.addRow({
      label: b.label,
      room: b.roomName,
      cat: b.catName,
      contents: items.map(itemText).join('\n'),
      count: qtyTotal(items),
      dest: b.dest,
      destNote: b.destNote,
      sentimental: b.sentimental ? 'Yes' : '',
      fragile: b.fragile ? 'Yes' : '',
      notes: b.notes,
      packed: new Date(b.createdAt),
      photos: (b.photos || []).length || '',
    });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell('label').font = { bold: true };
    row.getCell('packed').numFmt = 'd mmm yyyy';
    const lineCount = Math.max(items.length, (b.notes || '').split('\n').length, 1);
    let height = Math.min(400, lineCount * 15 + 6);

    const p = b.photos && b.photos[0];
    if (p && p.thumb) {
      const s = Math.min(1, IMG_BOX / Math.max(p.tw || IMG_BOX, p.th || IMG_BOX));
      const w = Math.round((p.tw || IMG_BOX) * s), h = Math.round((p.th || IMG_BOX) * s);
      const imgId = wb.addImage({ base64: abToB64(p.thumb), extension: 'jpeg' });
      ws.addImage(imgId, { tl: { col: PHOTO_COL + 0.05, row: row.number - 1 + 0.05 }, ext: { width: w, height: h }, editAs: 'oneCell' });
      height = Math.max(height, h * 0.75 + 8);
    }
    row.height = height;
  }
  ws.autoFilter = { from: 'A1', to: 'M1' };

  // Sheet 2: one row per item — handy for filtering and searching in Excel.
  const wi = wb.addWorksheet('Items', { views: [{ state: 'frozen', ySplit: 1 }] });
  wi.columns = [
    { header: 'Item', key: 'item', width: 40 },
    { header: 'Qty', key: 'qty', width: 6 },
    { header: 'Box label', key: 'label', width: 18 },
    { header: 'Room', key: 'room', width: 16 },
    { header: 'Category', key: 'cat', width: 20 },
    { header: 'Sentimental', key: 'sentimental', width: 12 },
    { header: 'Destination', key: 'dest', width: 14 },
    { header: 'For / where', key: 'destNote', width: 18 },
  ];
  headerStyle(wi);
  for (const b of sorted) {
    for (const it of itemsOf(b)) {
      wi.addRow({ item: it.name, qty: it.qty || 1, label: b.label, room: b.roomName, cat: b.catName, sentimental: b.sentimental ? 'Yes' : '', dest: b.dest, destNote: b.destNote });
    }
  }
  wi.autoFilter = { from: 'A1', to: 'H1' };

  // Sheet 3: summary by room.
  const wr = wb.addWorksheet('By room');
  wr.columns = [
    { header: 'Room', key: 'room', width: 20 },
    { header: 'Boxes', key: 'boxes', width: 8 },
    { header: 'Items', key: 'items', width: 8 },
    { header: 'Sentimental boxes', key: 'sentimental', width: 16 },
    { header: 'Fragile boxes', key: 'fragile', width: 13 },
    { header: 'Labels', key: 'labels', width: 60 },
  ];
  headerStyle(wr);
  const byRoom = new Map();
  for (const b of sorted) {
    const r = byRoom.get(b.roomName) || { room: b.roomName, boxes: 0, items: 0, sentimental: 0, fragile: 0, labels: [] };
    r.boxes++; r.items += qtyTotal(itemsOf(b)); if (b.fragile) r.fragile++; if (b.sentimental) r.sentimental++; r.labels.push(b.label);
    byRoom.set(b.roomName, r);
  }
  for (const r of [...byRoom.values()].sort((a, b) => a.room.localeCompare(b.room))) {
    const row = wr.addRow({ ...r, labels: r.labels.join(', ') });
    row.alignment = { vertical: 'top', wrapText: true };
  }
  const total = wr.addRow({
    room: 'Total', boxes: sorted.length,
    items: sorted.reduce((n, b) => n + qtyTotal(itemsOf(b)), 0),
    sentimental: sorted.filter((b) => b.sentimental).length,
    fragile: sorted.filter((b) => b.fragile).length,
  });
  total.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], `Track-it boxes ${today()}.xlsx`, { type: XLSX_MIME });
}

async function exportExcel() {
  if (!S.boxes.length) { toast('Add a box first'); return; }
  const done = busy('Building your spreadsheet…');
  try {
    const file = await buildWorkbook(S.boxes);
    done();
    offerFile(file, 'Spreadsheet ready',
      `${S.boxes.length} boxes. Choose “Save to Files” to keep it, or send it by Mail or AirDrop.`);
  } catch (err) {
    done();
    alert('Sorry — the spreadsheet could not be created.\n' + (err.message || err));
  }
}

// ---------- Backup / restore -------------------------------------------------

// ArrayBuffers (photos, receipts) <-> base64 so the backup is a plain JSON file.
function toPortable(v) {
  if (v instanceof ArrayBuffer) return { __b64: abToB64(v) };
  if (ArrayBuffer.isView(v)) return { __b64: abToB64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
  if (Array.isArray(v)) return v.map(toPortable);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = toPortable(v[k]);
    return o;
  }
  return v;
}
function fromPortable(v) {
  if (Array.isArray(v)) return v.map(fromPortable);
  if (v && typeof v === 'object') {
    if (typeof v.__b64 === 'string') return b64ToAb(v.__b64);
    const o = {};
    for (const k of Object.keys(v)) o[k] = fromPortable(v[k]);
    return o;
  }
  return v;
}

async function exportBackup() {
  const done = busy('Preparing backup…');
  try {
    const payload = {
      settings: S.settings,
      boxes: S.boxes,
      expenses: S.expenses,
      recurring: S.recurring,
      receipts: await dbAll('receipts'),
    };
    const head = { app: 'track-it', version: 1, exportedAt: new Date().toISOString() };
    let body;
    if (LOCK.meta) {
      const enc = await encryptBytes(LOCK.key, pack(payload));
      body = {
        ...head, encrypted: true, iter: LOCK.meta.iter,
        salt: abToB64(LOCK.meta.salt), iv: abToB64(enc.iv), ct: abToB64(enc.ct),
      };
    } else {
      body = { ...head, data: toPortable(payload) };
    }
    const file = new File([JSON.stringify(body)], `Track-it backup ${today()}.json`, { type: 'application/json' });
    done();
    offerFile(file, 'Backup ready',
      (LOCK.meta ? 'It\'s encrypted with your passcode. ' : '') +
      'Save it somewhere safe off this phone — iCloud Drive, or email it to yourself.',
      async () => { S.settings.lastBackupAt = Date.now(); await saveSettings(); });
  } catch (err) {
    done();
    alert('Sorry — the backup could not be created.\n' + (err.message || err));
  }
}

// Ask for the passcode a backup was encrypted with.
function askPasscode(message) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML = `
      <form class="sheet" role="dialog" aria-modal="true">
        <h2>Passcode needed</h2>
        <p class="small">${esc(message)}</p>
        <label class="field"><span>Passcode</span><input type="password" id="bp" autocomplete="off" required></label>
        <div class="stack">
          <button class="btn primary" type="submit">Open backup</button>
          <button class="btn ghost" type="button" data-a="close">Cancel</button>
        </div>
      </form>`;
    const finish = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); finish($('#bp', ov).value); });
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.dataset.a === 'close') finish(null); });
    document.body.appendChild(ov);
    $('#bp', ov).focus();
  });
}

const NOT_BACKUP = 'That file doesn\'t look like a Track-it or Pack-it backup.';

async function readBackup(data) {
  if (data && data.app === 'pack-it' && Array.isArray(data.boxes)) {
    return {
      settings: data.settings || {},
      boxes: data.boxes.map((b) => ({
        ...b,
        photos: (b.photos || []).map((p) => ({
          id: p.id || uid(), type: p.type || 'image/jpeg', tw: p.tw, th: p.th,
          data: b64ToAb(p.data), thumb: p.thumb ? b64ToAb(p.thumb) : null,
        })),
      })),
    };
  }
  if (!data || data.app !== 'track-it') throw new Error(NOT_BACKUP);
  if (!data.encrypted) return fromPortable(data.data || {});
  const meta = { salt: new Uint8Array(b64ToAb(data.salt)), iter: data.iter };
  const box = { iv: new Uint8Array(b64ToAb(data.iv)), ct: b64ToAb(data.ct) };
  const attempt = async (key) => { try { return unpack(await decryptBytes(key, box)); } catch (_) { return null; } };
  // A backup from this phone with the current passcode opens straight away.
  if (LOCK.meta && abToB64(LOCK.meta.salt) === data.salt) {
    const r = await attempt(LOCK.key);
    if (r) return r;
  }
  let msg = 'This backup is encrypted. Enter the passcode Track-it had when the backup was saved.';
  for (;;) {
    const pass = await askPasscode(msg);
    if (pass == null) return null;
    const done = busy('Opening backup…');
    const r = await attempt(await deriveKey(pass, meta.salt, meta.iter));
    done();
    if (r) return r;
    msg = 'That passcode didn\'t open the backup. Try again.';
  }
}

async function restoreBackup(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  let payload;
  try {
    payload = await readBackup(JSON.parse(await file.text()));
  } catch (err) {
    alert(err.message === NOT_BACKUP ? NOT_BACKUP : NOT_BACKUP + '\n' + (err.message || ''));
    return;
  }
  if (!payload) return;
  const boxes = payload.boxes || [], expenses = payload.expenses || [];
  const recurring = payload.recurring || [], receipts = payload.receipts || [];
  const have = (list, mine) => { const ids = new Set(mine.map((x) => x.id)); return list.filter((x) => ids.has(x.id)).length; };
  const parts = [];
  if (boxes.length) parts.push(plural(boxes.length, 'box').replace('boxs', 'boxes'));
  if (expenses.length) parts.push(plural(expenses.length, 'expense'));
  if (recurring.length) parts.push(plural(recurring.length, 'recurring cost'));
  if (!parts.length) { alert('That backup is empty.'); return; }
  const replacing = have(boxes, S.boxes) + have(expenses, S.expenses) + have(recurring, S.recurring);
  if (!confirm(`Restore ${parts.join(', ')} from this backup?\n` +
    (replacing ? `${replacing} will replace the version on this phone. ` : '') +
    'Everything else on this phone is kept.')) return;

  const done = busy('Restoring…');
  try {
    if (boxes.length) await dbPutMany('boxes', boxes);
    if (expenses.length) await dbPutMany('expenses', expenses);
    if (recurring.length) await dbPutMany('recurring', recurring);
    if (receipts.length) await dbPutMany('receipts', receipts);
    const bs = payload.settings || {};
    for (const kind of ['rooms', 'categories']) {
      for (const entry of bs[kind] || []) {
        if (entry && entry.code && !S.settings[kind].some((x) => x.code === entry.code)) S.settings[kind].push(entry);
      }
    }
    for (const c of bs.expCats || []) if (!S.settings.expCats.includes(c)) S.settings.expCats.push(c);
    for (const [k, v] of Object.entries(bs.estate || {})) if (v && !S.settings.estate[k]) S.settings.estate[k] = v;
    if (boxes.length) S.settings.tabs.boxes = true;
    if (expenses.length || recurring.length) S.settings.tabs.expenses = true;
    await saveSettings();
    S.boxes = await dbAllBoxes();
    S.expenses = await dbAll('expenses');
    S.recurring = await dbAll('recurring');
    done();
    toast(`Restored ${parts.join(', ')}`);
    go(boxes.length ? '#/boxes' : '#/money');
  } catch (err) {
    done();
    alert('Sorry — the restore failed.\n' + (err.message || err));
  }
}

// ---------- Start ------------------------------------------------------------

// Pick up new versions of the app: check whenever it's opened, and reload
// once the new version is ready (unless something is being edited).
function setupUpdates() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    if (S.draft) { toast('Track-it has been updated — it will refresh after you save'); S.reloadAfterSave = true; return; }
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

function storageError(err) {
  $('#app').innerHTML = `<div class="empty"><p><strong>Track-it couldn't open its storage.</strong></p>
    <p>If you're in a Private Browsing tab, open it in a normal Safari tab instead.</p>
    <p class="tiny soft">${esc(err && err.message)}</p></div>`;
}

async function init() {
  setupUpdates();
  if (!window.crypto || !crypto.subtle) {
    $('#app').innerHTML = '<div class="empty"><p><strong>Track-it needs a secure (https) web address.</strong></p></div>';
    return;
  }
  try {
    LOCK.meta = (await kvGetRaw('lock')) || null;
  } catch (err) { storageError(err); return; }
  setupAutoLock();
  if (LOCK.meta) { S.locked = true; route(); return; }
  await loadAll();
}

async function loadAll() {
  try {
    S.settings = (await kvGet('settings')) || {};
    const st = S.settings;
    if (!Array.isArray(st.rooms)) st.rooms = DEFAULT_ROOMS.map((r) => ({ ...r }));
    if (!Array.isArray(st.categories)) st.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    if (!Array.isArray(st.expCats)) st.expCats = [...DEFAULT_EXP_CATS];
    if (!st.estate) st.estate = {};
    if (!st.tabs) st.tabs = { boxes: true, expenses: true };
    S.boxes = await dbAllBoxes();
    S.expenses = await dbAll('expenses');
    S.recurring = await dbAll('recurring');
  } catch (err) { storageError(err); return; }
  route();
  if (await runRecurring()) refreshIfListing();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && !S.locked && (await runRecurring())) refreshIfListing();
  });
  if (S.boxes.length || S.expenses.length) requestPersist();
}

// Note: init() is called at the end of expenses.js, once everything is loaded.
