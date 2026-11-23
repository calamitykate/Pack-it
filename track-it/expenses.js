'use strict';

/* ==========================================================================
   Track-it — estate expenses
   Expenses, receipts (photos or PDFs), recurring costs and the spreadsheet.
   Uses the helpers, storage and router in app.js.
   ========================================================================== */

const DEFAULT_EXP_CATS = [
  'Funeral & memorial', 'Legal & probate', 'Valuations', 'Rates, land tax & strata',
  'Repairs & maintenance', 'Utilities (power, water, gas, phone)', 'Insurance', 'Storage',
  'Cleaning, removal & disposal', 'Real estate & sale costs', 'Accounting & tax',
  'Bank & government fees', 'Notices, postage & copies', 'Travel', 'Other',
];

const PAID_BY = {
  estate: 'Estate account',
  me: 'Me (to be reimbursed)',
  other: 'Someone else (to be reimbursed)',
};

const FREQS = {
  weekly: { label: 'Weekly', every: 'week', days: 7 },
  fortnightly: { label: 'Fortnightly', every: 'fortnight', days: 14 },
  monthly: { label: 'Monthly', every: 'month', months: 1 },
  quarterly: { label: 'Quarterly', every: 'quarter', months: 3 },
  yearly: { label: 'Yearly', every: 'year', months: 12 },
};

const RECEIPT_MAX = 2200;  // px, longest side, stored receipt photo (keeps small print readable)
const RECEIPT_THUMB = 240; // px
const PDF_MAX_MB = 25;

// ---------- Money & dates --------------------------------------------------

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const money = (cents) => AUD.format((cents || 0) / 100);
const sumCents = (list) => list.reduce((n, e) => n + (e.amount || 0), 0);

// "$1,234.50" -> 123450 cents. NaN if it isn't a sensible amount.
function parseMoney(str) {
  const s = String(str || '').replace(/[$,\s]/g, '').replace(/^AUD/i, '');
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}
const moneyInput = (cents) => (cents ? (cents / 100).toFixed(2) : '');

const ymdToDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDay = (ymd, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  (ymd ? ymdToDate(ymd).toLocaleDateString('en-AU', opts) : '');
const fmtDayShort = (ymd) => fmtDay(ymd, { day: 'numeric', month: 'short' });
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const monthLabel = (ym) => ymdToDate(ym + '-01').toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

const isOwed = (e) => e.paidBy && e.paidBy !== 'estate' && !e.reimbursed;
const paidByText = (e) => (e.paidBy === 'other' && e.paidByName ? `${e.paidByName} (to be reimbursed)` : PAID_BY[e.paidBy] || PAID_BY.estate);
const expTitle = (e) => e.payee || e.desc || 'Expense';
const ruleBy = (id) => S.recurring.find((r) => r.id === id);
const sortExpenses = (list) => list.sort((a, b) => (b.date === a.date ? b.createdAt - a.createdAt : b.date < a.date ? -1 : 1));

// ---------- Recurring costs --------------------------------------------------

// The nth payment date of a schedule. Monthly payments on the 31st fall on the
// last day of shorter months, always counted from the start date (so they don't drift).
function nthDate(start, freq, n) {
  const [y, m, d] = start.split('-').map(Number);
  const f = FREQS[freq] || FREQS.monthly;
  if (f.days) return localDay(new Date(y, m - 1, d + n * f.days));
  const mi = (m - 1) + n * f.months;
  const yy = y + Math.floor(mi / 12), mm = ((mi % 12) + 12) % 12;
  const dim = new Date(yy, mm + 1, 0).getDate();
  return localDay(new Date(yy, mm, Math.min(d, dim)));
}

// Payment dates after `after` (exclusive) up to `upto` (inclusive).
function dueDates(rule, after, upto) {
  const out = [];
  for (let n = 0; n < 5000; n++) {
    const d = nthDate(rule.start, rule.freq, n);
    if (d > upto || (rule.end && d > rule.end)) break;
    if (d > after) out.push(d);
  }
  return out;
}

function nextDue(rule) {
  const t = localDay();
  for (let n = 0; n < 5000; n++) {
    const d = nthDate(rule.start, rule.freq, n);
    if (rule.end && d > rule.end) return null;
    if (d > t) return d;
  }
  return null;
}

function occurrence(rule, date) {
  const now = Date.now();
  return {
    id: uid(), date, amount: rule.amount, payee: rule.payee, desc: rule.desc, cat: rule.cat,
    paidBy: rule.paidBy, paidByName: rule.paidByName || '', reimbursed: false, notes: '',
    receipts: [], recurringId: rule.id, createdAt: now, updatedAt: now,
  };
}

// Payments not yet recorded for a schedule, up to today.
function pendingFor(rule) {
  const have = new Set(S.expenses.filter((e) => e.recurringId === rule.id).map((e) => e.date));
  return dueDates(rule, rule.through || '', localDay()).filter((d) => !have.has(d));
}

// Record any recurring payments that have fallen due. Returns how many were added.
async function runRecurring() {
  const t = localDay();
  const added = [], changed = [];
  for (const r of S.recurring) {
    for (const d of pendingFor(r)) added.push(occurrence(r, d));
    if (!r.through || r.through < t) { r.through = t; changed.push(r); }
  }
  if (added.length) {
    await dbPutMany('expenses', added);
    S.expenses.push(...added);
  }
  if (changed.length) await dbPutMany('recurring', changed);
  if (added.length) {
    const one = added.length === 1 ? added[0] : null;
    toast(one ? `Added recurring payment: ${expTitle(one)} ${money(one.amount)}` : `Added ${added.length} recurring payments`, 3500);
  }
  return added.length;
}

function refreshIfListing() {
  const h = location.hash;
  if (!S.draft && (h === '' || h === '#/' || h === '#/money')) route();
}

// ---------- Receipts -----------------------------------------------------------

const receiptURLs = new Map();
function blobURL(key, data, type) {
  if (!receiptURLs.has(key)) receiptURLs.set(key, URL.createObjectURL(new Blob([data], { type })));
  return receiptURLs.get(key);
}
function forgetReceiptURLs() {
  receiptURLs.forEach((u) => URL.revokeObjectURL(u));
  receiptURLs.clear();
}
const isPDF = (m) => m.type === 'application/pdf';
const thumbURL = (m) => (m.thumb ? blobURL(m.id + ':t', m.thumb, 'image/jpeg') : null);

async function processReceipt(file) {
  const id = uid();
  const base = (file.name || 'receipt').replace(/\.[^.]+$/, '');
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
    if (file.size > PDF_MAX_MB * 1048576) throw new Error(`That PDF is over ${PDF_MAX_MB} MB — too big to keep here.`);
    const data = await file.arrayBuffer();
    return { meta: { id, name: base + '.pdf', type: 'application/pdf', size: data.byteLength, thumb: null }, data };
  }
  if (file.type && !file.type.startsWith('image/')) throw new Error('Only photos and PDFs can be attached.');
  const img = await loadImage(file).catch(() => { throw new Error('Could not read that picture. Try a photo or a PDF.'); });
  const full = await resizeTo(img, RECEIPT_MAX, 0.82);
  const thumb = await resizeTo(img, RECEIPT_THUMB, 0.7);
  return { meta: { id, name: base + '.jpg', type: 'image/jpeg', size: full.data.byteLength, thumb: thumb.data }, data: full.data };
}

function receiptTilesHTML(list, editable) {
  return list.map((m, i) => `
    <div class="ph rc">
      <button class="rc-open" data-a="view-receipt" data-i="${i}" aria-label="Open receipt ${i + 1}">
        ${m.thumb ? `<img src="${thumbURL(m)}" alt="">` : `<span class="rc-pdf"><b>PDF</b><span>${esc(m.name)}</span></span>`}
      </button>
      ${editable ? `<button class="ph-del" data-a="del-receipt" data-i="${i}" aria-label="Remove receipt">×</button>` : ''}
    </div>`).join('');
}

const receiptPickersHTML = (idPrefix) => `
  <div class="photo-btns">
    <label class="btn primary">
      📷 Snap receipt
      <input type="file" accept="image/*" capture="environment" id="${idPrefix}Cam" hidden>
    </label>
    <label class="btn">
      📄 Photo or PDF
      <input type="file" accept="image/*,application/pdf,.pdf" multiple id="${idPrefix}File" hidden>
    </label>
  </div>`;

// Nice file names for sharing: "2026-03-01 Kennards Storage $323.00.pdf"
function receiptFileName(e, m, i, n) {
  const clean = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
  const ext = isPDF(m) ? 'pdf' : 'jpg';
  return `${e.date} ${clean(expTitle(e))} ${money(e.amount)}${n > 1 ? ` (${i + 1})` : ''}.${ext}`;
}

async function loadReceiptData(m) {
  const pending = S.draft && S.draft.newData && S.draft.newData[m.id];
  if (pending) return pending;
  const rec = await dbGet('receipts', m.id);
  if (!rec) throw new Error('That receipt could not be found.');
  return rec.data;
}

async function openReceipt(m, e) {
  let data;
  try { data = await loadReceiptData(m); } catch (err) { toast(err.message); return; }
  const file = new File([data], e ? receiptFileName(e, m, 0, 1) : m.name, { type: m.type });
  const url = blobURL(m.id + ':f', data, m.type);
  const ov = document.createElement('div');
  ov.className = 'viewer';
  ov.innerHTML = `
    ${isPDF(m) ? `<iframe src="${url}" title="${esc(m.name)}"></iframe>` : `<img src="${url}" alt="Receipt">`}
    <div class="viewer-bar ${isPDF(m) ? 'three' : ''}">
      ${isPDF(m) ? `<a class="btn" href="${url}" target="_blank" rel="noopener">Open</a>` : ''}
      <button class="btn" data-a="share">Share / Save</button>
      <button class="btn primary" data-a="close">Close</button>
    </div>`;
  ov.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (a === 'share') shareFile(file);
    else if (a === 'close' || ev.target === ov || ev.target.tagName === 'IMG') ov.remove();
  });
  document.body.appendChild(ov);
}

// Like offerFile, for several files at once (e.g. all receipts).
function offerFiles(files, heading, detail) {
  const ov = document.createElement('div');
  ov.className = 'modal';
  let share = false;
  try { share = !!(navigator.canShare && navigator.canShare({ files })); } catch (_) { /* no */ }
  const mb = files.reduce((n, f) => n + f.size, 0) / 1048576;
  ov.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <h2>${esc(heading)}</h2>
      <p class="small">${esc(detail)}</p>
      <p class="tiny soft">${plural(files.length, 'file')} · ${mb.toFixed(1)} MB</p>
      <div class="stack">
        ${share ? '<button class="btn primary" data-a="share">Share / Save to Files</button>' : ''}
        <button class="btn ${share ? '' : 'primary'}" data-a="dl">Download</button>
        <button class="btn ghost" data-a="close">Close</button>
      </div>
    </div>`;
  ov.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'share') {
      try { await navigator.share({ files }); ov.remove(); }
      catch (err) { if (err.name !== 'AbortError') toast('Could not share: ' + err.message); }
    } else if (a === 'dl') {
      files.forEach((f, i) => setTimeout(() => downloadFile(f), i * 350));
    } else if (a === 'close' || e.target === ov) {
      ov.remove();
    }
  });
  document.body.appendChild(ov);
}

async function shareAllReceipts() {
  const withReceipts = sortExpenses([...S.expenses]).reverse().filter((e) => e.receipts && e.receipts.length);
  if (!withReceipts.length) { toast('No receipts saved yet'); return; }
  const done = busy('Gathering receipts…');
  try {
    const files = [];
    for (const e of withReceipts) {
      for (const [i, m] of e.receipts.entries()) {
        const rec = await dbGet('receipts', m.id);
        if (rec) files.push(new File([rec.data], receiptFileName(e, m, i, e.receipts.length), { type: m.type }));
      }
    }
    done();
    offerFiles(files, 'Receipts ready',
      'Choose “Save to Files” and pick a folder (e.g. in iCloud Drive) to keep them together, or send them to your accountant or solicitor.');
  } catch (err) {
    done();
    alert('Sorry — the receipts could not be gathered.\n' + (err.message || err));
  }
}

// ---------- Router -----------------------------------------------------------

function routeMoney(parts, params) {
  if (parts[0] === 'exp' && parts[1]) return renderExpense(parts[1]);
  if (parts[0] === 'new') return renderExpenseForm(null, params);
  if (parts[0] === 'edit' && parts[1]) return renderExpenseForm(parts[1], params);
  if (parts[0] === 'rec' && parts[1]) return renderRuleForm(parts[1]);
  return renderMoney();
}

// ---------- Expenses list --------------------------------------------------------

function moneyMatches(e, q) {
  if (S.mCat && e.cat !== S.mCat) return false;
  if (S.mMonth && !e.date.startsWith(S.mMonth)) return false;
  if (S.mShow === 'owed' && !isOwed(e)) return false;
  if (S.mShow === 'noreceipt' && e.receipts && e.receipts.length) return false;
  if (S.mShow === 'recurring' && !e.recurringId) return false;
  if (!q) return true;
  const hay = [e.payee, e.desc, e.cat, e.notes, e.paidByName, money(e.amount), fmtDay(e.date)].join('\n').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function expenseListHTML(q) {
  const list = sortExpenses(S.expenses.filter((e) => moneyMatches(e, q)));
  if (!list.length) {
    if (q || S.mCat || S.mMonth || S.mShow) return '<p class="empty">No expenses match.</p>';
    return `
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">🧾</div>
        <p><strong>No expenses yet.</strong></p>
        <p>Tap <b>＋ Expense</b> to record a payment for the estate and snap the receipt (or attach a PDF invoice).
          For regular bills like a storage unit, tick <b>🔁 Recurring</b> and Track-it will add each payment when it's due.</p>
      </div>`;
  }
  const groups = new Map();
  for (const e of list) {
    const k = e.date.slice(0, 7);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return [...groups.entries()].map(([ym, items]) => `
    <h3 class="month"><span>${esc(monthLabel(ym))}</span><span>${money(sumCents(items))}</span></h3>
    ${items.map(expenseCardHTML).join('')}`).join('');
}

function expenseCardHTML(e) {
  const r = e.receipts || [];
  const first = r[0];
  const meta = [fmtDayShort(e.date), e.cat];
  if (e.recurringId) meta.push('🔁');
  return `
    <a class="card exp" href="#/money/exp/${esc(e.id)}">
      <div class="thumb ${r.length ? '' : 'none'}">${first ? (first.thumb ? `<img src="${thumbURL(first)}" alt="" loading="lazy">` : '<span class="pdf-mini">PDF</span>') : '<span aria-hidden="true">🧾</span>'}</div>
      <div class="card-body">
        <div class="exp-title">${esc(expTitle(e))}</div>
        <div class="meta">${meta.map(esc).join(' · ')}</div>
        <div class="badges-row">
          ${isOwed(e) ? '<span class="badge owe">To reimburse</span>' : ''}
          ${r.length ? (r.length > 1 ? `<span class="badge dest">📎 ${r.length}</span>` : '') : '<span class="badge missing">No receipt</span>'}
        </div>
      </div>
      <div class="amt">${money(e.amount)}</div>
    </a>`;
}

function ruleCardHTML(r) {
  const next = nextDue(r);
  const n = S.expenses.filter((e) => e.recurringId === r.id).length;
  return `
    <a class="card rule ${next ? '' : 'ended'}" href="#/money/rec/${esc(r.id)}">
      <div class="thumb"><span aria-hidden="true">🔁</span></div>
      <div class="card-body">
        <div class="exp-title">${esc(r.payee || r.desc)}</div>
        <div class="meta">${money(r.amount)} ${esc((FREQS[r.freq] || FREQS.monthly).label.toLowerCase())} · ${plural(n, 'payment')} so far</div>
        <div class="meta">${next ? `Next: ${esc(fmtDay(next))}` : `Ended ${esc(fmtDay(r.end))}`}</div>
      </div>
    </a>`;
}

function renderMoney() {
  S.draft = null;
  setTabBar('money');
  const est = S.settings.estate;
  const q = S.mSearch.trim().toLowerCase();
  const total = sumCents(S.expenses);
  const owed = sumCents(S.expenses.filter(isOwed));
  const months = [...new Set(S.expenses.map((e) => e.date.slice(0, 7)))].sort().reverse();
  const cats = [...new Set(S.expenses.map((e) => e.cat))].sort();
  const rules = [...S.recurring].sort((a, b) => (!!nextDue(b) - !!nextDue(a)) || (a.payee || '').localeCompare(b.payee || ''));
  const showPassTip = !LOCK.meta && !S.settings.hidePassTip && S.expenses.length >= 1;
  const showInstall = isIOS() && !isStandalone() && !S.settings.hideInstallTip;
  const lastBackup = S.settings.lastBackupAt || 0;
  const showBackup = !showPassTip && S.expenses.length >= 5 && S.expenses.some((e) => e.updatedAt > lastBackup) && Date.now() - lastBackup > 7 * 864e5;

  $('#app').innerHTML = `
    <header class="bar">
      <h1 class="brand">Expenses</h1>
      ${barButtonsHTML()}
    </header>

    ${est.deceased ? `
      <p class="estate-line">Estate of <b>${esc(est.deceased)}</b>${est.dod ? ` · died ${esc(fmtDay(est.dod))}` : ''}${est.ref ? ` · ${esc(est.ref)}` : ''}</p>` : `
      <div class="tip">Add the name of the deceased and other estate details — they go at the top of the spreadsheet.
        <button class="link" data-a="settings">Add estate details</button></div>`}

    ${showInstall ? `
      <div class="tip">
        <strong>Tip:</strong> tap <b>Share</b> then <b>Add to Home Screen</b>.
        Track-it will open like an app, work without internet, and everything you enter is kept on this phone.
        <button class="link" data-a="hide-tip">Got it</button>
      </div>` : ''}

    ${showPassTip ? `
      <div class="tip warm">
        <b>Keep this private:</b> everything is already stored only on this phone. Set a passcode and it's
        encrypted too, so no one else using the phone can open it.
        <button class="link" data-a="set-pass">Set a passcode</button>
        <button class="link small" data-a="hide-pass-tip">Not now</button>
      </div>` : ''}

    ${showBackup ? `
      <div class="tip warm">
        It's worth saving a backup copy now and then (to Files, iCloud Drive or email) so nothing is lost if something happens to this phone.
        <button class="link" data-a="backup">Back up now</button>
      </div>` : ''}

    <section class="stats">
      <div><span class="num">${money(total).replace(/\.\d\d$/, '')}</span><span>spent</span></div>
      <div class="${owed ? 'owe' : ''}"><span class="num">${money(owed).replace(/\.\d\d$/, '')}</span><span>to reimburse</span></div>
      <div><span class="num">${S.expenses.length}</span><span>payments</span></div>
    </section>

    <section class="panel">
      <h2>Recurring costs ${rules.length ? `<span class="count">${rules.length}</span>` : ''}</h2>
      ${rules.length ? `<div class="list">${rules.map(ruleCardHTML).join('')}</div>` : '<p class="small soft">Storage units, insurance, rates — anything paid regularly. Each payment is added automatically when it falls due.</p>'}
      <button class="btn small add-rule" data-a="new-rule">＋ Add recurring cost</button>
    </section>

    <div class="search">
      <input id="mq" type="search" placeholder="Search payee, amount, notes…" value="${esc(S.mSearch)}"
             autocomplete="off" autocorrect="off" enterkeyhint="search">
    </div>
    <div class="filters three">
      <select id="mMonth" aria-label="Month">
        <option value="">All months</option>
        ${months.map((m) => `<option value="${m}" ${S.mMonth === m ? 'selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}
      </select>
      <select id="mCat" aria-label="Category">
        <option value="">All categories</option>
        ${cats.map((c) => `<option ${S.mCat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <select id="mShow" aria-label="Show">
        <option value="">Everything</option>
        <option value="owed" ${S.mShow === 'owed' ? 'selected' : ''}>To reimburse</option>
        <option value="noreceipt" ${S.mShow === 'noreceipt' ? 'selected' : ''}>No receipt</option>
        <option value="recurring" ${S.mShow === 'recurring' ? 'selected' : ''}>Recurring</option>
      </select>
    </div>
    ${q || S.mCat || S.mMonth || S.mShow ? `<p class="small soft filter-total" id="filterTotal"></p>` : ''}

    <section id="mlist" class="list">${expenseListHTML(q)}</section>

    <div class="fab-wrap">
      ${S.expenses.length ? '<button class="btn" data-a="export">Export</button>' : ''}
      <button class="btn primary fab" data-a="new">＋ Expense</button>
    </div>
  `;

  const updateFilterTotal = () => {
    const el = $('#filterTotal');
    if (!el) return;
    const shown = S.expenses.filter((e) => moneyMatches(e, S.mSearch.trim().toLowerCase()));
    el.textContent = `${plural(shown.length, 'payment')} shown · ${money(sumCents(shown))}`;
  };
  updateFilterTotal();
  const mq = $('#mq');
  mq.addEventListener('input', () => {
    const hadQ = !!S.mSearch.trim();
    S.mSearch = mq.value;
    if (hadQ !== !!S.mSearch.trim() && !S.mCat && !S.mMonth && !S.mShow) {
      // Show or hide the "shown" total line without losing focus.
      const exists = $('#filterTotal');
      if (S.mSearch.trim() && !exists) $('.filters').insertAdjacentHTML('afterend', '<p class="small soft filter-total" id="filterTotal"></p>');
      if (!S.mSearch.trim() && exists) exists.remove();
    }
    $('#mlist').innerHTML = expenseListHTML(S.mSearch.trim().toLowerCase());
    updateFilterTotal();
  });
  for (const [id, k] of [['mMonth', 'mMonth'], ['mCat', 'mCat'], ['mShow', 'mShow']]) {
    $('#' + id).addEventListener('change', (e) => { S[k] = e.target.value; renderMoney(); });
  }
  bindActions($('#app'), {
    settings: () => go('#/settings'),
    lock: lockNow,
    new: () => go('#/money/new'),
    'new-rule': () => go('#/money/new?rec=1'),
    export: exportExpensesExcel,
    backup: exportBackup,
    'set-pass': () => { go('#/settings'); setPasscode(false); },
    'hide-pass-tip': async () => { S.settings.hidePassTip = true; await saveSettings(); renderMoney(); },
    'hide-tip': async () => { S.settings.hideInstallTip = true; await saveSettings(); renderMoney(); },
  });
}

// ---------- Expense detail -----------------------------------------------------

function renderExpense(id) {
  S.draft = null;
  const e = S.expenses.find((x) => x.id === id);
  if (!e) { go('#/money'); return; }
  const rule = e.recurringId ? ruleBy(e.recurringId) : null;
  const r = e.receipts || [];
  $('#app').innerHTML = `
    <header class="bar">
      <button class="link back" data-a="back">‹ Expenses</button>
      <span></span>
      <button class="link" data-a="edit">Edit</button>
    </header>

    <section class="label-card exp-card">
      <div class="big-amt">${money(e.amount)}</div>
      <div class="exp-big-title">${esc(expTitle(e))}</div>
      <div class="meta">${esc(fmtDay(e.date, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }))}</div>
      <div class="badges">
        <span class="badge dest">${esc(e.cat)}</span>
        ${rule ? `<span class="badge dest">🔁 ${esc(FREQS[rule.freq].label)}</span>` : e.recurringId ? '<span class="badge dest">🔁 Recurring</span>' : ''}
        ${isOwed(e) ? '<span class="badge owe">To reimburse</span>' : ''}
      </div>
    </section>

    <section class="panel">
      <dl class="facts">
        ${e.payee && e.desc ? `<dt>For</dt><dd>${esc(e.desc)}</dd>` : ''}
        <dt>Paid by</dt><dd>${esc(paidByText(e))}</dd>
        ${e.paidBy !== 'estate' ? `<dt>Reimbursed</dt><dd>${e.reimbursed ? `Yes${e.reimbursedOn ? ', ' + esc(fmtDay(e.reimbursedOn)) : ''}` : 'Not yet'}</dd>` : ''}
        ${rule ? `<dt>Recurring</dt><dd><a href="#/money/rec/${esc(rule.id)}">${esc(money(rule.amount))} ${esc(FREQS[rule.freq].label.toLowerCase())} — view schedule</a></dd>` : ''}
      </dl>
      ${e.paidBy !== 'estate' ? `<button class="btn small" data-a="toggle-reimb">${e.reimbursed ? 'Mark as not reimbursed' : '✓ Mark as reimbursed'}</button>` : ''}
    </section>

    <section class="panel">
      <h2>Receipts ${r.length ? `<span class="count">${r.length}</span>` : ''}</h2>
      <div class="photos" id="receipts">${receiptTilesHTML(r, false)}</div>
      ${r.length ? '' : '<p class="small soft">No receipt attached yet.</p>'}
      ${receiptPickersHTML('d')}
      <p class="tiny soft" id="rStatus"></p>
    </section>

    ${e.notes ? `<section class="panel"><h2>Notes</h2><p class="pre">${esc(e.notes)}</p></section>` : ''}

    <section class="panel small soft">
      Added ${fmtDate(e.createdAt)}${e.updatedAt && e.updatedAt - e.createdAt > 60000 ? ` · updated ${fmtDate(e.updatedAt)}` : ''}
    </section>

    <div class="stack">
      <button class="btn danger-ghost" data-a="delete">Delete this expense</button>
    </div>
  `;

  // Attaching a receipt here saves straight away (handy for each month's recurring payment).
  const onFiles = async (input) => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    $('#rStatus').textContent = 'Saving…';
    const metas = [];
    for (const f of files) {
      try {
        const { meta, data } = await processReceipt(f);
        await dbPut('receipts', { id: meta.id, expenseId: e.id, type: meta.type, name: meta.name, data });
        metas.push(meta);
      } catch (err) { toast(err.message, 4000); }
    }
    if (!metas.length) { $('#rStatus').textContent = ''; return; }
    e.receipts = [...(e.receipts || []), ...metas];
    e.updatedAt = Date.now();
    await dbPut('expenses', e);
    requestPersist();
    toast(metas.length === 1 ? 'Receipt saved' : `${metas.length} receipts saved`);
    renderExpense(e.id);
  };
  $('#dCam').addEventListener('change', (ev) => onFiles(ev.target));
  $('#dFile').addEventListener('change', (ev) => onFiles(ev.target));

  bindActions($('#app'), {
    back: () => go('#/money'),
    edit: () => go('#/money/edit/' + e.id),
    'view-receipt': (el) => openReceipt(r[+el.dataset.i], e),
    'toggle-reimb': async () => {
      e.reimbursed = !e.reimbursed;
      e.reimbursedOn = e.reimbursed ? localDay() : '';
      e.updatedAt = Date.now();
      await dbPut('expenses', e);
      toast(e.reimbursed ? 'Marked as reimbursed' : 'Marked as not reimbursed');
      renderExpense(e.id);
    },
    delete: async () => {
      if (!confirm(`Delete ${expTitle(e)} (${money(e.amount)}) and its receipts? This can't be undone.`)) return;
      await deleteExpenses([e]);
      toast('Expense deleted');
      location.replace('#/money');
    },
  });
}

async function deleteExpenses(list) {
  const ids = new Set(list.map((e) => e.id));
  const receiptIds = list.flatMap((e) => (e.receipts || []).map((m) => m.id));
  if (receiptIds.length) await dbDelMany('receipts', receiptIds);
  await dbDelMany('expenses', [...ids]);
  S.expenses = S.expenses.filter((e) => !ids.has(e.id));
}

// ---------- New / edit expense ---------------------------------------------------

function catOptionsHTML(current) {
  const cats = [...S.settings.expCats];
  if (current && !cats.includes(current)) cats.push(current);
  return cats.map((c) => `<option ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

function paidByFieldsHTML(d) {
  return `
    <label class="field">
      <span>Paid by</span>
      <select id="paidBy">
        ${Object.entries(PAID_BY).map(([k, v]) => `<option value="${k}" ${d.paidBy === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select>
    </label>
    <label class="field" id="paidByNameWrap" ${d.paidBy === 'other' ? '' : 'hidden'}>
      <span>Who paid?</span>
      <input id="paidByName" value="${esc(d.paidByName)}" placeholder="e.g. Sarah" autocapitalize="words">
    </label>`;
}

function renderExpenseForm(id, params) {
  const key = 'exp:' + (id || 'new:' + (params ? params.toString() : ''));
  if (!S.draft || S.draftKey !== key) {
    if (id) {
      const e = S.expenses.find((x) => x.id === id);
      if (!e) { go('#/money'); return; }
      S.draft = { ...e, receipts: [...(e.receipts || [])], amountText: moneyInput(e.amount), newData: {} };
    } else {
      S.draft = {
        id: null, date: localDay(), amountText: '', payee: '', desc: '',
        cat: S.settings.lastExpCat || S.settings.expCats[0] || 'Other',
        paidBy: S.settings.lastPaidBy || 'estate', paidByName: S.settings.lastPaidByName || '',
        reimbursed: false, notes: '', receipts: [], newData: {},
        recurring: !!(params && params.get('rec') === '1'), freq: 'monthly', end: '',
      };
    }
    S.draftKey = key;
    S.draftDirty = false;
  }
  const d = S.draft;
  const rule = d.recurringId ? ruleBy(d.recurringId) : null;

  $('#app').innerHTML = `
    <header class="bar">
      <button class="link" data-a="cancel">Cancel</button>
      <h1>${id ? 'Edit expense' : d.recurring ? 'Recurring cost' : 'New expense'}</h1>
      <button class="link strong" data-a="save">Save</button>
    </header>

    <div class="row2 keep">
      <label class="field">
        <span>Amount</span>
        <div class="amt-input"><span>$</span><input id="amount" inputmode="decimal" placeholder="0.00" value="${esc(d.amountText)}" autocomplete="off"></div>
      </label>
      <label class="field">
        <span>${d.recurring && !id ? 'First payment' : 'Date paid'}</span>
        <input id="date" type="date" value="${esc(d.date)}" required>
      </label>
    </div>

    <label class="field">
      <span>Paid to</span>
      <input id="payee" value="${esc(d.payee)}" placeholder="e.g. Kennards Self Storage" autocapitalize="words" list="payees">
      <datalist id="payees">${[...new Set(S.expenses.map((e) => e.payee).filter(Boolean))].sort().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    </label>

    <label class="field">
      <span>What for <em class="soft">(optional)</em></span>
      <input id="desc" value="${esc(d.desc)}" placeholder="e.g. Storage unit 14B for furniture">
    </label>

    <label class="field">
      <span>Category</span>
      <select id="cat">${catOptionsHTML(d.cat)}</select>
    </label>

    ${paidByFieldsHTML(d)}

    <label class="check" id="reimbWrap" ${d.paidBy === 'estate' ? 'hidden' : ''}>
      <input type="checkbox" id="reimbursed" ${d.reimbursed ? 'checked' : ''}>
      <span>Already reimbursed from the estate</span>
    </label>

    ${id ? (d.recurringId ? `
      <p class="tip small">🔁 This is one payment of a recurring cost.
        ${rule ? `<a class="link" href="#/money/rec/${esc(rule.id)}">Change the schedule or amount for future payments</a>` : ''}</p>` : '') : `
      <label class="check rec">
        <input type="checkbox" id="recurring" ${d.recurring ? 'checked' : ''}>
        <span>🔁 Recurring — paid regularly, e.g. a storage unit</span>
      </label>
      <div id="recFields" class="rec-fields" ${d.recurring ? '' : 'hidden'}>
        <div class="row2 keep">
          <label class="field">
            <span>How often</span>
            <select id="freq">${Object.entries(FREQS).map(([k, f]) => `<option value="${k}" ${d.freq === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
          </label>
          <label class="field">
            <span>Last payment <em class="soft">(optional)</em></span>
            <input id="end" type="date" value="${esc(d.end)}">
          </label>
        </div>
        <p class="tiny soft" id="recHint"></p>
      </div>`}

    <section class="field">
      <span>Receipt or invoice</span>
      <div class="photos edit" id="receipts"></div>
      ${receiptPickersHTML('f')}
      <p class="tiny soft" id="rStatus">Snap a photo of the receipt, or attach a PDF invoice or statement.</p>
    </section>

    <label class="field">
      <span>Notes</span>
      <textarea id="notes" rows="3" placeholder="Invoice number, how it was paid, anything worth remembering">${esc(d.notes)}</textarea>
    </label>

    <div class="stack">
      <button class="btn primary" data-a="save">Save expense</button>
    </div>
  `;

  const dirty = () => { S.draftDirty = true; };
  const recHint = () => {
    const el = $('#recHint');
    if (!el) return;
    const cents = parseMoney(d.amountText);
    const f = FREQS[d.freq];
    if (!d.date) { el.textContent = ''; return; }
    const day = ymdToDate(d.date);
    const when = f.days ? `every ${f.every === 'week' ? '' : 'second '}${day.toLocaleDateString('en-AU', { weekday: 'long' })}`
      : f.months === 12 ? `every year on ${fmtDay(d.date, { day: 'numeric', month: 'long' })}`
        : `on the ${ordinal(day.getDate())} ${f.months === 3 ? 'every 3 months' : 'of each month'}${day.getDate() > 28 ? ' (or the last day of shorter months)' : ''}`;
    const later = dueDates({ start: d.date, freq: d.freq, end: d.end }, d.date, localDay()).length;
    el.textContent = `${cents > 0 ? money(cents) + ' ' : ''}${when}${d.end ? `, until ${fmtDay(d.end)}` : ''}. ` +
      'Each payment is added automatically when it falls due, so you can attach that month’s receipt.' +
      (later ? ` ${plural(later, 'earlier payment')} since ${fmtDay(d.date)} will be added too.` : '');
  };
  recHint();

  for (const f of ['payee', 'desc', 'notes', 'paidByName']) {
    $('#' + f).addEventListener('input', (e) => { d[f] = e.target.value; dirty(); });
  }
  $('#amount').addEventListener('input', (e) => { d.amountText = e.target.value; dirty(); recHint(); });
  $('#amount').addEventListener('blur', (e) => {
    const c = parseMoney(e.target.value);
    if (c > 0) { d.amountText = moneyInput(c); e.target.value = d.amountText; }
  });
  $('#date').addEventListener('change', (e) => { d.date = e.target.value; dirty(); recHint(); });
  $('#cat').addEventListener('change', (e) => { d.cat = e.target.value; dirty(); });
  $('#paidBy').addEventListener('change', (e) => {
    d.paidBy = e.target.value;
    $('#paidByNameWrap').hidden = d.paidBy !== 'other';
    $('#reimbWrap').hidden = d.paidBy === 'estate';
    dirty();
  });
  $('#reimbursed').addEventListener('change', (e) => { d.reimbursed = e.target.checked; dirty(); });
  $('#recurring')?.addEventListener('change', (e) => {
    d.recurring = e.target.checked;
    $('#recFields').hidden = !d.recurring;
    $('.bar h1').textContent = d.recurring ? 'Recurring cost' : 'New expense';
    $('#date').closest('.field').querySelector('span').textContent = d.recurring ? 'First payment' : 'Date paid';
    dirty(); recHint();
  });
  $('#freq')?.addEventListener('change', (e) => { d.freq = e.target.value; dirty(); recHint(); });
  $('#end')?.addEventListener('change', (e) => { d.end = e.target.value; dirty(); recHint(); });

  const renderReceipts = () => { $('#receipts').innerHTML = receiptTilesHTML(d.receipts, true); };
  renderReceipts();
  const onFiles = async (input) => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    const status = $('#rStatus');
    status.textContent = 'Adding…';
    for (const f of files) {
      try {
        const { meta, data } = await processReceipt(f);
        d.receipts.push(meta);
        d.newData[meta.id] = data;
        dirty();
      } catch (err) { toast(err.message, 4000); }
    }
    status.textContent = `${plural(d.receipts.length, 'receipt')} attached.`;
    renderReceipts();
  };
  $('#fCam').addEventListener('change', (e) => onFiles(e.target));
  $('#fFile').addEventListener('change', (e) => onFiles(e.target));

  bindActions($('#app'), {
    cancel: () => {
      if (S.draftDirty && !confirm('Discard your changes to this expense?')) return;
      S.draft = null;
      history.length > 1 ? history.back() : go('#/money');
    },
    save: saveExpenseDraft,
    'view-receipt': (el) => openReceipt(d.receipts[+el.dataset.i], null),
    'del-receipt': (el) => {
      if (!confirm('Remove this receipt?')) return;
      const [m] = d.receipts.splice(+el.dataset.i, 1);
      delete d.newData[m.id];
      dirty(); renderReceipts();
    },
  });
}

async function saveExpenseDraft() {
  const d = S.draft;
  if (!d) return;
  const amount = parseMoney(d.amountText);
  if (!(amount > 0)) { toast('Please enter the amount'); $('#amount')?.focus(); return; }
  if (!d.date) { toast('Please enter the date'); $('#date')?.focus(); return; }
  if (!d.payee.trim() && !d.desc.trim()) { toast('Please say who it was paid to'); $('#payee')?.focus(); return; }
  if (d.recurring && d.end && d.end < d.date) { toast('The last payment can\'t be before the first'); return; }

  const now = Date.now();
  const original = d.id ? S.expenses.find((x) => x.id === d.id) : null;
  const exp = {
    id: d.id || uid(),
    date: d.date,
    amount,
    payee: d.payee.trim(),
    desc: d.desc.trim(),
    cat: d.cat,
    paidBy: d.paidBy,
    paidByName: d.paidBy === 'other' ? (d.paidByName || '').trim() : '',
    reimbursed: d.paidBy !== 'estate' && !!d.reimbursed,
    reimbursedOn: d.paidBy !== 'estate' && d.reimbursed ? (original && original.reimbursed && original.reimbursedOn) || localDay() : '',
    notes: (d.notes || '').trim(),
    receipts: d.receipts,
    recurringId: d.recurringId || null,
    createdAt: d.createdAt || now,
    updatedAt: now,
  };

  let rule = null;
  if (!d.id && d.recurring) {
    rule = {
      id: uid(), payee: exp.payee, desc: exp.desc, cat: exp.cat, amount, paidBy: exp.paidBy,
      paidByName: exp.paidByName, freq: d.freq, start: d.date, end: d.end || '',
      through: d.date, notes: '', createdAt: now, updatedAt: now,
    };
    exp.recurringId = rule.id;
    const later = dueDates(rule, d.date, localDay());
    if (later.length && !confirm(`Also record the ${plural(later.length, 'payment')} due since then (${fmtDay(later[0])}${later.length > 1 ? ' to ' + fmtDay(later[later.length - 1]) : ''})?\n\nTap Cancel to start from the next payment instead.`)) {
      rule.through = localDay();
    }
  }

  try {
    const fresh = d.receipts.filter((m) => d.newData[m.id]);
    if (fresh.length) {
      await dbPutMany('receipts', fresh.map((m) => ({ id: m.id, expenseId: exp.id, type: m.type, name: m.name, data: d.newData[m.id] })));
    }
    await dbPut('expenses', exp);
    if (original) {
      const keep = new Set(exp.receipts.map((m) => m.id));
      const gone = (original.receipts || []).filter((m) => !keep.has(m.id)).map((m) => m.id);
      if (gone.length) await dbDelMany('receipts', gone);
    }
    if (rule) await dbPut('recurring', rule);
  } catch (err) {
    alert('Sorry — the expense could not be saved. ' + (err && err.message ? err.message : '') +
      '\nIf your phone is low on storage, try freeing some space.');
    return;
  }
  const i = S.expenses.findIndex((x) => x.id === exp.id);
  if (i >= 0) S.expenses[i] = exp; else S.expenses.push(exp);
  if (rule) { S.recurring.push(rule); await runRecurring(); }
  S.settings.lastExpCat = exp.cat;
  S.settings.lastPaidBy = exp.paidBy;
  S.settings.lastPaidByName = exp.paidByName;
  saveSettings();
  requestPersist();
  S.draft = null;
  toast(rule ? `Saved — ${money(amount)} ${FREQS[rule.freq].label.toLowerCase()}` : `Saved ${money(amount)}`);
  location.replace('#/money/exp/' + exp.id);
  if (S.reloadAfterSave) setTimeout(() => location.reload(), 300);
}

// ---------- Recurring schedule -------------------------------------------------

function renderRuleForm(id) {
  const key = 'rule:' + id;
  const r = ruleBy(id);
  if (!r) { go('#/money'); return; }
  if (!S.draft || S.draftKey !== key) {
    S.draft = { ...r, amountText: moneyInput(r.amount) };
    S.draftKey = key;
    S.draftDirty = false;
  }
  const d = S.draft;
  const payments = sortExpenses(S.expenses.filter((e) => e.recurringId === r.id));
  const next = nextDue(r);

  $('#app').innerHTML = `
    <header class="bar">
      <button class="link" data-a="cancel">‹ Back</button>
      <h1>Recurring cost</h1>
      <button class="link strong" data-a="save">Save</button>
    </header>

    <section class="label-card exp-card">
      <div class="big-amt">${money(r.amount)}</div>
      <div class="exp-big-title">${esc(r.payee || r.desc)}</div>
      <div class="meta">${esc(FREQS[r.freq].label)} since ${esc(fmtDay(r.start))}</div>
      <div class="badges"><span class="badge dest">${next ? 'Next: ' + esc(fmtDay(next)) : 'Ended ' + esc(fmtDay(r.end))}</span></div>
    </section>

    <p class="tiny soft">Changes apply to payments from now on. Payments already recorded stay as they are — open one to change it.</p>

    <div class="row2 keep">
      <label class="field">
        <span>Amount</span>
        <div class="amt-input"><span>$</span><input id="amount" inputmode="decimal" value="${esc(d.amountText)}" autocomplete="off"></div>
      </label>
      <label class="field">
        <span>How often</span>
        <select id="freq">${Object.entries(FREQS).map(([k, f]) => `<option value="${k}" ${d.freq === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
      </label>
    </div>
    <div class="row2 keep">
      <label class="field"><span>First payment</span><input id="start" type="date" value="${esc(d.start)}"></label>
      <label class="field"><span>Last payment <em class="soft">(optional)</em></span><input id="end" type="date" value="${esc(d.end)}"></label>
    </div>
    <label class="field"><span>Paid to</span><input id="payee" value="${esc(d.payee)}" autocapitalize="words"></label>
    <label class="field"><span>What for <em class="soft">(optional)</em></span><input id="desc" value="${esc(d.desc)}"></label>
    <label class="field"><span>Category</span><select id="cat">${catOptionsHTML(d.cat)}</select></label>
    ${paidByFieldsHTML(d)}
    <label class="field"><span>Notes</span><textarea id="notes" rows="2" placeholder="Account number, contract end date…">${esc(d.notes)}</textarea></label>

    <div class="stack">
      <button class="btn primary" data-a="save">Save changes</button>
      ${next ? '<button class="btn" data-a="stop">Stop — no more payments after today</button>' : ''}
    </div>

    <section class="panel">
      <h2>Payments so far <span class="count">${payments.length}</span></h2>
      ${payments.length ? `<ul class="items pay-list">${payments.map((e) => `
        <li><a href="#/money/exp/${esc(e.id)}"><span>${esc(fmtDay(e.date))}${e.receipts && e.receipts.length ? ' 📎' : ' <span class="badge missing">No receipt</span>'}</span><span class="qty">${money(e.amount)}</span></a></li>`).join('')}</ul>
        <p class="small"><b>Total: ${money(sumCents(payments))}</b></p>` : '<p class="small soft">None yet — the first is added when it falls due.</p>'}
    </section>

    <div class="stack">
      <button class="btn danger-ghost" data-a="delete">Delete this recurring cost…</button>
    </div>
  `;

  const dirty = () => { S.draftDirty = true; };
  for (const f of ['payee', 'desc', 'notes', 'paidByName']) {
    $('#' + f).addEventListener('input', (e) => { d[f] = e.target.value; dirty(); });
  }
  $('#amount').addEventListener('input', (e) => { d.amountText = e.target.value; dirty(); });
  for (const f of ['freq', 'start', 'end', 'cat']) {
    $('#' + f).addEventListener('change', (e) => { d[f] = e.target.value; dirty(); });
  }
  $('#paidBy').addEventListener('change', (e) => {
    d.paidBy = e.target.value;
    $('#paidByNameWrap').hidden = d.paidBy !== 'other';
    dirty();
  });

  const save = async (stopToday) => {
    const amount = parseMoney(d.amountText);
    if (!(amount > 0)) { toast('Please enter the amount'); return; }
    if (!d.start) { toast('Please enter the first payment date'); return; }
    if (!d.payee.trim() && !d.desc.trim()) { toast('Please say who it is paid to'); return; }
    const end = stopToday ? localDay() : d.end;
    if (end && end < d.start) { toast('The last payment can\'t be before the first'); return; }
    const updated = {
      ...r, amount, freq: d.freq, start: d.start, end: end || '', payee: d.payee.trim(), desc: d.desc.trim(),
      cat: d.cat, paidBy: d.paidBy, paidByName: d.paidBy === 'other' ? (d.paidByName || '').trim() : '',
      notes: (d.notes || '').trim(), updatedAt: Date.now(),
    };
    // A new start date or frequency gives new payment dates: check from the start again
    // (dates already recorded are skipped).
    if (updated.start !== r.start || updated.freq !== r.freq) {
      updated.through = '';
      const backfill = pendingFor(updated);
      if (backfill.length && !confirm(`With these dates, ${plural(backfill.length, 'payment')} up to today ${backfill.length === 1 ? 'isn\'t' : 'aren\'t'} recorded yet. Add ${backfill.length === 1 ? 'it' : 'them'}?\n\nTap Cancel to only add payments from now on.`)) {
        updated.through = localDay();
      }
    }
    await dbPut('recurring', updated);
    S.recurring[S.recurring.findIndex((x) => x.id === r.id)] = updated;
    await runRecurring();
    S.draft = null;
    toast(stopToday ? 'Stopped — no more payments will be added' : 'Saved');
    location.replace('#/money');
    if (S.reloadAfterSave) setTimeout(() => location.reload(), 300);
  };

  bindActions($('#app'), {
    cancel: () => {
      if (S.draftDirty && !confirm('Discard your changes?')) return;
      S.draft = null;
      history.length > 1 ? history.back() : go('#/money');
    },
    save: () => save(false),
    stop: () => { if (confirm(`Stop ${r.payee || r.desc}? Payments already recorded are kept.`)) save(true); },
    delete: async () => {
      if (!confirm(`Delete the recurring cost ${r.payee || r.desc}? No more payments will be added.`)) return;
      const delPayments = payments.length && confirm(`Also delete the ${plural(payments.length, 'payment')} already recorded (${money(sumCents(payments))}) and their receipts?\n\nTap Cancel to keep them.`);
      if (delPayments) await deleteExpenses(payments);
      await dbDel('recurring', r.id);
      S.recurring = S.recurring.filter((x) => x.id !== r.id);
      S.draft = null;
      toast('Recurring cost deleted');
      location.replace('#/money');
    },
  });
}

// ---------- Spreadsheet -----------------------------------------------------------

async function buildExpensesWorkbook() {
  await loadExcelJS();
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Track-it';
  wb.created = new Date();
  const est = S.settings.estate;
  const AUD_FMT = '"$"#,##0.00';
  const DATE_FMT = 'd mmm yyyy';
  const xlDate = (ymd) => { if (!ymd) return null; const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const headerStyle = (row) => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF35574B' } };
    row.alignment = { vertical: 'middle' };
    row.height = 22;
  };
  const list = sortExpenses([...S.expenses]).reverse();
  const total = sumCents(list);
  const estatePaid = sumCents(list.filter((e) => e.paidBy === 'estate'));
  const reimbursed = sumCents(list.filter((e) => e.paidBy !== 'estate' && e.reimbursed));
  const owed = sumCents(list.filter(isOwed));

  // Sheet 1: summary
  const ws = wb.addWorksheet('Summary');
  ws.columns = [{ width: 34 }, { width: 14 }, { width: 16 }];
  const title = ws.addRow([est.deceased ? `Estate of ${est.deceased}` : 'Estate expenses']);
  title.font = { bold: true, size: 16 };
  const info = [
    ['Date of death', xlDate(est.dod)], ['Administrator / executor', est.admin], ['Reference', est.ref],
    ['Exported', xlDate(localDay())],
  ];
  for (const [k, v] of info) {
    if (!v) continue;
    const r = ws.addRow([k, v]);
    r.getCell(1).font = { bold: true };
    if (v instanceof Date) r.getCell(2).numFmt = DATE_FMT;
  }
  ws.addRow([]);
  const totals = [
    ['Total expenses', total], ['Paid from the estate account', estatePaid],
    ['Paid personally — reimbursed', reimbursed], ['Paid personally — still to reimburse', owed],
  ];
  for (const [k, v] of totals) {
    const r = ws.addRow([k, null, v / 100]);
    r.getCell(1).font = { bold: true };
    r.getCell(3).numFmt = AUD_FMT;
  }
  const owedBy = new Map();
  for (const e of list.filter(isOwed)) {
    const who = e.paidBy === 'me' ? (est.admin || 'Administrator') : (e.paidByName || 'Someone else');
    owedBy.set(who, (owedBy.get(who) || 0) + e.amount);
  }
  for (const [who, c] of owedBy) {
    const r = ws.addRow([`   owed to ${who}`, null, c / 100]);
    r.getCell(3).numFmt = AUD_FMT;
  }
  ws.addRow([]);
  const ch = ws.addRow(['Category', 'Payments', 'Total']);
  headerStyle(ch);
  const byCat = new Map();
  for (const e of list) {
    const c = byCat.get(e.cat) || { n: 0, cents: 0 };
    c.n++; c.cents += e.amount;
    byCat.set(e.cat, c);
  }
  for (const [cat, c] of [...byCat.entries()].sort((a, b) => b[1].cents - a[1].cents)) {
    const r = ws.addRow([cat, c.n, c.cents / 100]);
    r.getCell(3).numFmt = AUD_FMT;
  }
  const tr = ws.addRow(['Total', list.length, total / 100]);
  tr.font = { bold: true };
  tr.getCell(3).numFmt = AUD_FMT;

  // Sheet 2: every expense
  const wx = wb.addWorksheet('Expenses', { views: [{ state: 'frozen', ySplit: 1 }] });
  wx.columns = [
    { header: 'Date', key: 'date', width: 13 },
    { header: 'Paid to', key: 'payee', width: 26 },
    { header: 'What for', key: 'desc', width: 30 },
    { header: 'Category', key: 'cat', width: 24 },
    { header: 'Amount', key: 'amount', width: 13 },
    { header: 'Paid by', key: 'paidBy', width: 24 },
    { header: 'Reimbursed', key: 'reimb', width: 13 },
    { header: 'Recurring', key: 'rec', width: 12 },
    { header: 'Receipts', key: 'nrec', width: 9 },
    { header: 'Receipt files', key: 'files', width: 40 },
    { header: 'Notes', key: 'notes', width: 36 },
  ];
  headerStyle(wx.getRow(1));
  for (const e of list) {
    const rule = e.recurringId ? ruleBy(e.recurringId) : null;
    const n = (e.receipts || []).length;
    const row = wx.addRow({
      date: xlDate(e.date), payee: e.payee, desc: e.desc, cat: e.cat, amount: e.amount / 100,
      paidBy: paidByText(e).replace(' (to be reimbursed)', ''),
      reimb: e.paidBy === 'estate' ? '' : e.reimbursed ? (e.reimbursedOn ? `Yes, ${fmtDay(e.reimbursedOn)}` : 'Yes') : 'No',
      rec: rule ? FREQS[rule.freq].label : e.recurringId ? 'Yes' : '',
      nrec: n || 'None',
      files: (e.receipts || []).map((m, i) => receiptFileName(e, m, i, n)).join('\n'),
      notes: e.notes,
    });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell('date').numFmt = DATE_FMT;
    row.getCell('amount').numFmt = AUD_FMT;
    if (!n) row.getCell('nrec').font = { color: { argb: 'FFB4442F' } };
  }
  const last = list.length + 1;
  const sum = wx.addRow({ payee: 'Total', amount: { formula: `SUM(E2:E${last})`, result: total / 100 } });
  sum.font = { bold: true };
  sum.getCell('amount').numFmt = AUD_FMT;
  wx.autoFilter = { from: 'A1', to: 'K1' };

  // Sheet 3: recurring costs
  if (S.recurring.length) {
    const wr = wb.addWorksheet('Recurring');
    wr.columns = [
      { header: 'Paid to', key: 'payee', width: 26 },
      { header: 'What for', key: 'desc', width: 28 },
      { header: 'Category', key: 'cat', width: 22 },
      { header: 'Amount', key: 'amount', width: 12 },
      { header: 'How often', key: 'freq', width: 12 },
      { header: 'First payment', key: 'start', width: 14 },
      { header: 'Last payment', key: 'end', width: 14 },
      { header: 'Next due', key: 'next', width: 14 },
      { header: 'Payments so far', key: 'n', width: 15 },
      { header: 'Total so far', key: 'total', width: 13 },
    ];
    headerStyle(wr.getRow(1));
    for (const r of S.recurring) {
      const pays = S.expenses.filter((e) => e.recurringId === r.id);
      const row = wr.addRow({
        payee: r.payee, desc: r.desc, cat: r.cat, amount: r.amount / 100, freq: FREQS[r.freq].label,
        start: xlDate(r.start), end: xlDate(r.end), next: xlDate(nextDue(r)), n: pays.length, total: sumCents(pays) / 100,
      });
      for (const k of ['start', 'end', 'next']) row.getCell(k).numFmt = DATE_FMT;
      for (const k of ['amount', 'total']) row.getCell(k).numFmt = AUD_FMT;
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const name = est.deceased ? `Estate of ${est.deceased.replace(/[\\/:*?"<>|]+/g, ' ')} expenses ${today()}.xlsx` : `Estate expenses ${today()}.xlsx`;
  return new File([buf], name, { type: XLSX_MIME });
}

async function exportExpensesExcel() {
  if (!S.expenses.length) { toast('Add an expense first'); return; }
  const done = busy('Building your spreadsheet…');
  try {
    const file = await buildExpensesWorkbook();
    done();
    offerFile(file, 'Spreadsheet ready',
      `${plural(S.expenses.length, 'expense')}, ${money(sumCents(S.expenses))} in total. Choose “Save to Files” to keep it, or send it by Mail. ` +
      'Use “Save all receipts” in Settings to save the receipts alongside it.');
  } catch (err) {
    done();
    alert('Sorry — the spreadsheet could not be created.\n' + (err.message || err));
  }
}

// Everything is loaded: start the app.
init();
