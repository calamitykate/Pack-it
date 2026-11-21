'use strict';

/* ==========================================================================
   Pack-it — moving box tracker
   Everything is stored on the device (IndexedDB). Nothing is uploaded.
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
  ['Sentimental', 'sent'], ['Photos & albums', 'phot'], ['Documents & papers', 'docs'],
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
const itemsOf = (b) => (b.contents || '').split('\n').map((s) => s.trim()).filter(Boolean);
const pad3 = (n) => String(n).padStart(3, '0');
const cleanCode = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const today = () => new Date().toISOString().slice(0, 10);

function makeLabel(room, number, cat) {
  return `${room}-${pad3(number)}-${cat}`;
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

// ---------- Storage (IndexedDB) -------------------------------------------

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('packit', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('boxes')) d.createObjectStore('boxes', { keyPath: 'id' });
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

async function write(storeName, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, 'readwrite');
    fn(t.objectStore(storeName));
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error || new Error('Save failed'));
  });
}

const dbAllBoxes = () => read('boxes', (s) => s.getAll());
const dbPutBox = (b) => write('boxes', (s) => s.put(b));
const dbPutBoxes = (list) => write('boxes', (s) => list.forEach((b) => s.put(b)));
const dbDelBox = (id) => write('boxes', (s) => s.delete(id));
const dbClearBoxes = () => write('boxes', (s) => s.clear());
const kvGet = (k) => read('kv', (s) => s.get(k));
const kvSet = (k, v) => write('kv', (s) => s.put(v, k));

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
  const h = location.hash.slice(1) || '/';
  const [path, query] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query || '');
  window.scrollTo(0, 0);
  if (parts[0] === 'box' && parts[1]) return renderDetail(parts[1]);
  if (parts[0] === 'new') return renderForm(null, params);
  if (parts[0] === 'edit' && parts[1]) return renderForm(parts[1], params);
  if (parts[0] === 'settings') return renderSettings();
  return renderList();
}

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

window.addEventListener('hashchange', route);

// ---------- List view ------------------------------------------------------

function matches(b, q) {
  if (!q) return true;
  const hay = [b.label, b.roomName, b.catName, b.contents, b.dest, b.destNote, b.notes].join('\n').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function renderList() {
  S.draft = null;
  const q = S.search.trim().toLowerCase();
  let list = S.boxes.filter((b) => (!S.roomFilter || b.room === S.roomFilter) && matches(b, q));
  if (S.sort === 'label') list.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  else list.sort((a, b) => b.createdAt - a.createdAt);

  const totalItems = S.boxes.reduce((n, b) => n + itemsOf(b).length, 0);
  const roomsInUse = [...new Map(S.boxes.map((b) => [b.room, b.roomName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  const showInstall = isIOS() && !isStandalone() && !S.settings.hideInstallTip;
  const lastBackup = S.settings.lastBackupAt || 0;
  const changedSince = S.boxes.some((b) => b.updatedAt > lastBackup);
  const showBackup = S.boxes.length >= 3 && changedSince && Date.now() - lastBackup > 2 * 864e5;

  $('#app').innerHTML = `
    <header class="bar">
      <h1 class="brand">Pack-it</h1>
      <button class="icon-btn" data-a="settings" aria-label="Settings & export">⚙︎</button>
    </header>

    ${showInstall ? `
      <div class="tip">
        <strong>Tip:</strong> tap <b>Share</b> then <b>Add to Home Screen</b>.
        Pack-it will open like an app, work without internet, and your boxes are kept safe on this phone.
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
      <p>Tap <b>＋ New box</b>, pick the room and what's going in it, and Pack-it will suggest a label
         like <code>Dine-001-sent</code> to write on the box. Snap a photo, list what's inside, and you're done.</p>
      <p class="soft">Take it one box at a time.</p>
    </div>`;
}

function cardHTML(b, q) {
  const items = itemsOf(b);
  let snippet;
  if (q) {
    const hits = items.filter((it) => q.split(/\s+/).some((w) => it.toLowerCase().includes(w)));
    snippet = (hits.length ? hits : items).slice(0, 3).join(' · ');
  } else {
    snippet = items.slice(0, 4).join(' · ');
  }
  const p = b.photos && b.photos[0];
  return `
    <a class="card" href="#/box/${esc(b.id)}">
      <div class="thumb">${p ? `<img src="${photoURL(p)}" alt="" loading="lazy">` : '<span aria-hidden="true">📦</span>'}</div>
      <div class="card-body">
        <div class="label-text">${esc(b.label)}${b.fragile ? ' <span class="badge fragile">Fragile</span>' : ''}</div>
        <div class="meta">${esc(b.roomName)} · ${esc(b.catName)} · ${items.length} item${items.length === 1 ? '' : 's'}</div>
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
  if (!b) { go('#/'); return; }
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
        ${b.fragile ? '<span class="badge fragile">Fragile</span>' : ''}
        ${b.dest ? `<span class="badge dest">${esc(b.dest)}${b.destNote ? ' — ' + esc(b.destNote) : ''}</span>` : ''}
      </div>
    </section>

    ${b.photos && b.photos.length ? `
      <section class="photos view">
        ${b.photos.map((p, i) => `<button class="ph" data-a="photo" data-i="${i}"><img src="${photoURL(p)}" alt="Photo ${i + 1}"></button>`).join('')}
      </section>` : ''}

    <section class="panel">
      <h2>Contents <span class="count">${items.length}</span></h2>
      ${items.length ? `<ul class="items">${items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>` : '<p class="soft">Nothing listed yet.</p>'}
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
    back: () => go('#/'),
    edit: () => go('#/edit/' + b.id),
    photo: (el) => openViewer(b.photos[+el.dataset.i], b.label),
    next: () => go(`#/new?room=${encodeURIComponent(b.room)}&cat=${encodeURIComponent(b.cat)}`),
    delete: async () => {
      if (!confirm(`Delete box ${b.label}? This can't be undone.`)) return;
      await dbDelBox(b.id);
      (b.photos || []).forEach(forgetPhoto);
      S.boxes = S.boxes.filter((x) => x.id !== b.id);
      toast(`Deleted ${b.label}`);
      location.replace('#/');
    },
  });
}

// ---------- New / edit form ------------------------------------------------

function renderForm(id, params) {
  const key = id ? 'edit:' + id : 'new:' + (params ? params.toString() : '');
  if (!S.draft || S.draftKey !== key) {
    if (id) {
      const b = S.boxes.find((x) => x.id === id);
      if (!b) { go('#/'); return; }
      S.draft = { ...b, photos: [...(b.photos || [])] };
      S.draft.labelCustom = b.label !== makeLabel(b.room, b.number, b.cat);
    } else {
      const rooms = S.settings.rooms, cats = S.settings.categories;
      const room = (params && params.get('room')) || S.settings.lastRoom || (rooms[0] && rooms[0].code) || 'Room';
      const cat = (params && params.get('cat')) || S.settings.lastCat || (cats[0] && cats[0].code) || 'misc';
      S.draft = {
        id: null, room, cat, number: nextNumber(room), labelCustom: false,
        contents: '', dest: 'Undecided', destNote: '', fragile: false, notes: '', photos: [],
      };
      S.draft.label = makeLabel(room, S.draft.number, cat);
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

    <label class="field">
      <span>Contents <em class="soft">— one item per line</em></span>
      <textarea id="contents" rows="7" placeholder="Mum's blue teapot&#10;Wedding album&#10;Dad's war medals">${esc(d.contents)}</textarea>
    </label>

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
    const auto = makeLabel(d.room, d.number, d.cat);
    if (!d.labelCustom) { d.label = auto; labelInput.value = auto; }
    autoBtn.hidden = !d.labelCustom;
  };
  const dirty = () => { S.draftDirty = true; };

  labelInput.addEventListener('input', () => {
    d.label = labelInput.value;
    d.labelCustom = d.label !== makeLabel(d.room, d.number, d.cat);
    autoBtn.hidden = !d.labelCustom;
    dirty();
  });
  $('#room').addEventListener('change', (e) => {
    d.room = e.target.value;
    d.number = original && original.room === d.room ? original.number : nextNumber(d.room, d.id);
    syncLabel(); dirty();
  });
  $('#cat').addEventListener('change', (e) => { d.cat = e.target.value; syncLabel(); dirty(); });
  for (const f of ['contents', 'destNote', 'notes']) {
    $('#' + f).addEventListener('input', (e) => { d[f] = e.target.value; dirty(); });
  }
  $('#dest').addEventListener('change', (e) => { d.dest = e.target.value; dirty(); });
  $('#fragile').addEventListener('change', (e) => { d.fragile = e.target.checked; dirty(); });

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
      history.length > 1 ? history.back() : go('#/');
    },
    save: saveDraft,
    'auto-label': () => { d.labelCustom = false; syncLabel(); },
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
    contents: (d.contents || '').replace(/\n{3,}/g, '\n\n').trim(),
    dest: d.dest || 'Undecided',
    destNote: (d.destNote || '').trim(),
    fragile: !!d.fragile,
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
}

// ---------- Settings -------------------------------------------------------

function renderSettings() {
  S.draft = null;
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

  $('#app').innerHTML = `
    <header class="bar">
      <button class="link back" data-a="back">‹ Boxes</button>
      <h1>Settings</h1>
      <span></span>
    </header>

    <section class="panel">
      <h2>Export & backup</h2>
      <div class="stack">
        <button class="btn primary" data-a="export" ${S.boxes.length ? '' : 'disabled'}>Export Excel spreadsheet</button>
        <p class="tiny soft">A .xlsx file with every box, its contents and a photo — opens in Excel, Numbers or Google Sheets.
          Use <b>Save to Files</b>, Mail or AirDrop from the share sheet.</p>
        <button class="btn" data-a="backup" ${S.boxes.length ? '' : 'disabled'}>Save full backup</button>
        <p class="tiny soft">Everything including full-size photos, in one file you can restore later or on another phone.
          ${S.settings.lastBackupAt ? `Last backup: ${fmtDate(S.settings.lastBackupAt)}.` : 'No backup saved yet.'}</p>
        <label class="btn">
          Restore from backup
          <input type="file" id="restore" accept=".json,application/json" hidden>
        </label>
      </div>
      <p class="tiny soft" id="storageInfo"></p>
    </section>

    ${listEditor('rooms', 'Rooms', 'The code is the first part of the label, e.g. <code>Dine</code>-001-sent.')}
    ${listEditor('categories', 'Contents categories', 'The code is the last part of the label, e.g. Dine-001-<code>sent</code>.')}

    <section class="panel">
      <h2>About</h2>
      <p class="small">Pack-it keeps everything on this phone only — nothing is uploaded anywhere.
        Box numbers count up separately for each room, so the third dining-room box is always Dine-003,
        whatever is in it.</p>
      <button class="btn danger-ghost small" data-a="wipe">Delete all boxes…</button>
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

  for (const kind of ['rooms', 'categories']) {
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
    back: () => go('#/'),
    export: exportExcel,
    backup: exportBackup,
    'add-rooms': () => addEntry('rooms'),
    'add-categories': () => addEntry('categories'),
    'del-rooms': (el) => delEntry('rooms', +el.dataset.i),
    'del-categories': (el) => delEntry('categories', +el.dataset.i),
    wipe: async () => {
      if (!S.boxes.length) { toast('There are no boxes to delete'); return; }
      if (!confirm(`Delete all ${S.boxes.length} boxes and their photos from this phone?`)) return;
      if (prompt('This cannot be undone. Type DELETE to confirm.') !== 'DELETE') return;
      await dbClearBoxes();
      S.boxes.forEach((b) => (b.photos || []).forEach(forgetPhoto));
      S.boxes = [];
      toast('All boxes deleted');
      go('#/');
    },
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
  wb.creator = 'Pack-it';
  wb.created = new Date();

  const headerStyle = (ws) => {
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7A5C3E' } };
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
    { header: 'Fragile', key: 'fragile', width: 8 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Packed', key: 'packed', width: 13 },
    { header: 'Photos', key: 'photos', width: 8 },
    { header: 'Photo', key: 'img', width: 18 },
  ];
  headerStyle(ws);
  const PHOTO_COL = 11; // zero-based index of the "Photo" column (L)
  const IMG_BOX = 120;  // px

  for (const b of sorted) {
    const items = itemsOf(b);
    const row = ws.addRow({
      label: b.label,
      room: b.roomName,
      cat: b.catName,
      contents: items.join('\n'),
      count: items.length,
      dest: b.dest,
      destNote: b.destNote,
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
  ws.autoFilter = { from: 'A1', to: 'L1' };

  // Sheet 2: one row per item — handy for filtering and searching in Excel.
  const wi = wb.addWorksheet('Items', { views: [{ state: 'frozen', ySplit: 1 }] });
  wi.columns = [
    { header: 'Item', key: 'item', width: 40 },
    { header: 'Box label', key: 'label', width: 18 },
    { header: 'Room', key: 'room', width: 16 },
    { header: 'Category', key: 'cat', width: 20 },
    { header: 'Destination', key: 'dest', width: 14 },
    { header: 'For / where', key: 'destNote', width: 18 },
  ];
  headerStyle(wi);
  for (const b of sorted) {
    for (const item of itemsOf(b)) {
      wi.addRow({ item, label: b.label, room: b.roomName, cat: b.catName, dest: b.dest, destNote: b.destNote });
    }
  }
  wi.autoFilter = { from: 'A1', to: 'F1' };

  // Sheet 3: summary by room.
  const wr = wb.addWorksheet('By room');
  wr.columns = [
    { header: 'Room', key: 'room', width: 20 },
    { header: 'Boxes', key: 'boxes', width: 8 },
    { header: 'Items', key: 'items', width: 8 },
    { header: 'Fragile boxes', key: 'fragile', width: 13 },
    { header: 'Labels', key: 'labels', width: 60 },
  ];
  headerStyle(wr);
  const byRoom = new Map();
  for (const b of sorted) {
    const r = byRoom.get(b.roomName) || { room: b.roomName, boxes: 0, items: 0, fragile: 0, labels: [] };
    r.boxes++; r.items += itemsOf(b).length; if (b.fragile) r.fragile++; r.labels.push(b.label);
    byRoom.set(b.roomName, r);
  }
  for (const r of [...byRoom.values()].sort((a, b) => a.room.localeCompare(b.room))) {
    const row = wr.addRow({ ...r, labels: r.labels.join(', ') });
    row.alignment = { vertical: 'top', wrapText: true };
  }
  const total = wr.addRow({
    room: 'Total', boxes: sorted.length,
    items: sorted.reduce((n, b) => n + itemsOf(b).length, 0),
    fragile: sorted.filter((b) => b.fragile).length,
  });
  total.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], `Pack-it boxes ${today()}.xlsx`, { type: XLSX_MIME });
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

async function exportBackup() {
  if (!S.boxes.length) { toast('Nothing to back up yet'); return; }
  const done = busy('Preparing backup…');
  try {
    const data = {
      app: 'pack-it',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { rooms: S.settings.rooms, categories: S.settings.categories },
      boxes: S.boxes.map((b) => ({
        ...b,
        photos: (b.photos || []).map((p) => ({
          id: p.id, type: p.type, tw: p.tw, th: p.th,
          data: abToB64(p.data), thumb: p.thumb ? abToB64(p.thumb) : null,
        })),
      })),
    };
    const file = new File([JSON.stringify(data)], `Pack-it backup ${today()}.json`, { type: 'application/json' });
    done();
    offerFile(file, 'Backup ready',
      'Save it somewhere safe off this phone — iCloud Drive, email to yourself, or a family member.',
      async () => { S.settings.lastBackupAt = Date.now(); await saveSettings(); });
  } catch (err) {
    done();
    alert('Sorry — the backup could not be created.\n' + (err.message || err));
  }
}

async function restoreBackup(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (_) {
    alert('That file doesn\'t look like a Pack-it backup.');
    return;
  }
  if (!data || data.app !== 'pack-it' || !Array.isArray(data.boxes)) {
    alert('That file doesn\'t look like a Pack-it backup.');
    return;
  }
  const existing = new Set(S.boxes.map((b) => b.id));
  const updates = data.boxes.filter((b) => existing.has(b.id)).length;
  const adds = data.boxes.length - updates;
  if (!confirm(`Restore ${data.boxes.length} boxes from this backup?\n${adds} new, ${updates} will replace the version on this phone.\nOther boxes on this phone are kept.`)) return;

  const done = busy('Restoring…');
  try {
    const boxes = data.boxes.map((b) => ({
      ...b,
      photos: (b.photos || []).map((p) => ({
        id: p.id || uid(), type: p.type || 'image/jpeg', tw: p.tw, th: p.th,
        data: b64ToAb(p.data), thumb: p.thumb ? b64ToAb(p.thumb) : null,
      })),
    }));
    await dbPutBoxes(boxes);
    // Merge rooms/categories from the backup that aren't here yet.
    for (const kind of ['rooms', 'categories']) {
      for (const entry of (data.settings && data.settings[kind]) || []) {
        if (entry && entry.code && !S.settings[kind].some((x) => x.code === entry.code)) S.settings[kind].push(entry);
      }
    }
    await saveSettings();
    S.boxes = await dbAllBoxes();
    done();
    toast(`Restored ${boxes.length} boxes`);
    go('#/');
  } catch (err) {
    done();
    alert('Sorry — the restore failed.\n' + (err.message || err));
  }
}

// ---------- Start ------------------------------------------------------------

async function init() {
  try {
    S.settings = (await kvGet('settings')) || {};
    if (!Array.isArray(S.settings.rooms)) S.settings.rooms = DEFAULT_ROOMS.map((r) => ({ ...r }));
    if (!Array.isArray(S.settings.categories)) S.settings.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    S.boxes = await dbAllBoxes();
  } catch (err) {
    $('#app').innerHTML = `<div class="empty"><p><strong>Pack-it couldn't open its storage.</strong></p>
      <p>If you're in a Private Browsing tab, open it in a normal Safari tab instead.</p>
      <p class="tiny soft">${esc(err && err.message)}</p></div>`;
    return;
  }
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (S.boxes.length) requestPersist();
}

init();
