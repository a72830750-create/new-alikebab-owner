const SESSION_KEY = 'forno99_session';
const API = (window.API_BASE||'') + '/api/orders';

// Epson TM-m30III printer configuration (SOAP/ePOS-Print)
const PRINTER_IP = '192.168.1.8';
const PRINTER_URL = 'http://192.168.1.8/cgi-bin/epos/service.cgi';
const PRINTER_DEV_ID = 'local_printer';
let printerConnected = false;
let autoPrintEnabled = true;
let printedOrders = new Map(); // orderId → {status:'pending'|'printed'|'failed', attempts, error?}

function authFetch(url, opts={}) {
  return fetch(url, opts).then(r => {
    if (r.status === 401 && !String(url).includes('/api/login')) {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem('forno99_token');
      showLogin();
      if (els.loginError) { els.loginError.textContent = 'Sessione scaduta. Effettua di nuovo il login.'; els.loginError.classList.remove('hidden'); }
      throw new Error('unauthorized');
    }
    return r;
  });
}

const els = {
  loginScreen: document.getElementById('login-screen'),
  dashboard: document.getElementById('dashboard'),
  loginForm: document.getElementById('login-form'),
  loginError: document.getElementById('login-error'),
  orderList: document.getElementById('order-list'),
  emptyState: document.getElementById('empty-state'),
  emptyText: document.getElementById('empty-text'),
  searchInput: document.getElementById('search-input'),
  filterTabs: document.getElementById('filter-tabs'),
  statusModal: document.getElementById('status-modal'),
  statusOrderInfo: document.getElementById('status-order-info'),
  toast: document.getElementById('toast'),
  dateFilter: document.getElementById('date-filter'),
  customPanel: document.getElementById('custom-panel'),
  dateFrom: document.getElementById('date-from'),
  dateTo: document.getElementById('date-to'),
  applyRange: document.getElementById('apply-range'),
  cancelRange: document.getElementById('cancel-range'),
  selectedRange: document.getElementById('selected-range'),
  resetBtn: document.getElementById('reset-filters'),
  resultCount: document.getElementById('result-count'),
  refreshBtn: document.getElementById('refresh-btn'),
  signoutBtn: document.getElementById('signout-btn'),
  printerSettingsBtn: document.getElementById('printer-settings-btn'),
  printerSettingsModal: document.getElementById('printer-settings-modal'),
  printerStatusText: document.getElementById('printer-status-text'),
};

let orders = [];
let selectedNewOrder = null;
let modalShownIds = new Set();
let currentStatus = 'new';
let dateFilter = 'today';
let searchQuery = '';
let selectedOrder = null;
let highlightId = null;
let highlightTimer = null;

function showToast(msg) { els.toast.textContent = msg; els.toast.classList.remove('hidden'); clearTimeout(showToast._t); showToast._t = setTimeout(() => els.toast.classList.add('hidden'), 2500); }

function statusClass(s) { return 'status-' + s; }
function esc(v){ return String(v||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function rome(d) { const x = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Rome' })); if (x.getHours() < 11) x.setDate(x.getDate() - 1); return x; }
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

async function loadOrders() { const t = sessionStorage.getItem('forno99_token'); const r = await fetch(API, { headers: { 'Authorization': 'Bearer ' + t } }); if (!r.ok) throw new Error('API error'); return r.json(); }
function saveStatus(id, status) { const t=sessionStorage.getItem('forno99_token'); return authFetch(API + '/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization':'Bearer '+t }, body: JSON.stringify({ status }) }); }

function matchesDate(o) {
  const now = rome(new Date());
  const od = rome(new Date(o.created_at));
  if (dateFilter === 'today' && startOfDay(od).getTime() !== startOfDay(now).getTime()) return false;
  if (dateFilter === 'yesterday') { const y = new Date(now); y.setDate(y.getDate() - 1); if (startOfDay(od).getTime() !== startOfDay(y).getTime()) return false; }
  if (dateFilter === '7d') { const t = new Date(now); t.setDate(t.getDate() - 7); if (od < t) return false; }
  if (dateFilter === '30d') { const t = new Date(now); t.setDate(t.getDate() - 30); if (od < t) return false; }
  if (dateFilter === 'month') { if (od.getMonth() !== now.getMonth() || od.getFullYear() !== now.getFullYear()) return false; }
  if (dateFilter === 'lastmonth') { const lm = new Date(now); lm.setMonth(lm.getMonth() - 1); if (od.getMonth() !== lm.getMonth() || od.getFullYear() !== lm.getFullYear()) return false; }
  if (dateFilter === 'custom') {
    if (els.dateFrom.value) { const from = new Date(els.dateFrom.value + 'T00:00:00'); if (od < from) return false; }
    if (els.dateTo.value) { const to = new Date(els.dateTo.value + 'T23:59:59'); if (od > to) return false; }
  }
  return true;
}
function renderStats() {
  const c = { new: 0, accepted: 0, preparing: 0, ready: 0, out_for_delivery: 0, rejected: 0, completed: 0 };
  let revenue = 0, completedCount = 0;
  orders.forEach(o => {
    if (c[o.status] !== undefined) c[o.status]++;
    if (o.status === 'completed' && matchesDate(o)) { revenue += Number(o.total) || 0; completedCount++; }
  });
  document.getElementById('stat-new').textContent = c.new;
  document.getElementById('stat-accepted').textContent = c.accepted;
  document.getElementById('stat-rejected').textContent = c.rejected;
  document.getElementById('stat-completed').textContent = c.completed;
  const revEl = document.getElementById('stat-revenue');
  if (revEl) revEl.textContent = '€' + revenue.toFixed(2);
}

let earningsRange = 'today';
function revenueForRange(range) {
  const now = rome(new Date());
  let revenue = 0, count = 0;
  orders.forEach(o => {
    if (o.status !== 'completed') return;
    const od = rome(new Date(o.created_at));
    let ok = false;
    if (range === 'today') ok = startOfDay(od).getTime() === startOfDay(now).getTime();
    else if (range === 'yesterday') { const y = new Date(now); y.setDate(y.getDate() - 1); ok = startOfDay(od).getTime() === startOfDay(y).getTime(); }
    else if (range === '7d') { const t = new Date(now); t.setDate(t.getDate() - 7); ok = od >= t; }
    else if (range === '30d') { const t = new Date(now); t.setDate(t.getDate() - 30); ok = od >= t; }
    else if (range === 'month') ok = od.getMonth() === now.getMonth() && od.getFullYear() === now.getFullYear();
    else if (range === 'custom') { const from= document.getElementById('earn-from'); const to=document.getElementById('earn-to'); let f=from&&from.value?new Date(from.value):null; let t=to&&to.value?new Date(to.value):null; ok = (!f||od>=f)&&(!t||od<=t); }
    else if (range === 'total') ok = true;
    if (!ok) return;
    revenue += Number(o.total) || 0; count++;
  });
  return { revenue, count };
}
function renderEarnings() {
  const { revenue, count } = revenueForRange(earningsRange);
  const revEl = document.getElementById('earn-revenue');
  const cntEl = document.getElementById('earn-count');
  const avgEl = document.getElementById('earn-avg');
  if (revEl) revEl.textContent = '€' + revenue.toFixed(2);
  if (cntEl) cntEl.textContent = count;
  if (avgEl) avgEl.textContent = '€' + (count ? (revenue / count).toFixed(2) : '0.00');
}
function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'ora';
  if (diff < 3600) return Math.floor(diff / 60) + 'm fa';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h fa';
  return Math.floor(diff / 86400) + 'g fa';
}

function getFiltered() {
  const now = rome(new Date());
  return orders.filter(o => {
    if (currentStatus === 'all' && (o.status === 'completed' || o.status === 'rejected')) return false;
    if (currentStatus !== 'all' && o.status !== currentStatus) return false;
    const od = rome(new Date(o.created_at));
    if (dateFilter === 'today' && startOfDay(od).getTime() !== startOfDay(now).getTime()) return false;
    if (dateFilter === 'yesterday') { const y = new Date(now); y.setDate(y.getDate() - 1); if (startOfDay(od).getTime() !== startOfDay(y).getTime()) return false; }
    if (dateFilter === '7d') { const t = new Date(now); t.setDate(t.getDate() - 7); if (od < t) return false; }
    if (dateFilter === '30d') { const t = new Date(now); t.setDate(t.getDate() - 30); if (od < t) return false; }
    if (dateFilter === 'month') { if (od.getMonth() !== now.getMonth() || od.getFullYear() !== now.getFullYear()) return false; }
    if (dateFilter === 'lastmonth') { const lm = new Date(now); lm.setMonth(lm.getMonth() - 1); if (od.getMonth() !== lm.getMonth() || od.getFullYear() !== lm.getFullYear()) return false; }
    if (dateFilter === 'custom') {
      if (els.dateFrom.value) { const from = new Date(els.dateFrom.value); if (od < from) return false; }
      if (els.dateTo.value) { const to = new Date(els.dateTo.value); if (od > to) return false; }
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      const normPhone = (o.customer_phone || '').replace(/\D/g, '');
      const qPhone = q.replace(/\D/g, '');
      const matchNum = (o.order_number || '').toString().toLowerCase().includes(q) || String(o.id || '').includes(q);
      const matchName = (o.customer_name || '').toLowerCase().includes(q);
      const matchPhone = qPhone ? normPhone.includes(qPhone) : (o.customer_phone || '').toLowerCase().includes(q);
      if (!(matchNum || matchName || matchPhone)) return false;
    }
    return true;
  });
}

// ===== Epson Printer Functions (SOAP/ePOS-Print) =====

function buildReceiptXML(order) {
  const maxName = 22;
  const shorten = (n) => {
    const s = String(n || '');
    return s.length > maxName ? s.slice(0, maxName - 1) + '.' : s;
  };
  const items = (order.items || []).map(i => {
    const left = `${i.qty}x ${shorten(i.name)}`;
    const price = Number(i.qty * i.price).toFixed(2);
    const pad = ' '.repeat(Math.max(1, 30 - left.length));
    return `<text>${esc(left)}${pad}${price}</text>`;
  }).join('');
  const note = order.notes ? `<text>${esc(order.notes)}</text><feed />` : '';
  const pickupTime = order.order_type === 'pickup' ? (order.pickup_time || 'ASAP') : (order.delivery_timing === 'later' ? (order.delivery_time || 'ASAP') : 'ASAP');
  return `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">
    <text align="center">ALI KEBAB</text>
    <text align="center">Via Leopoldo Galeotti</text>
    <text align="center">51017 Pescia PT</text>
    <feed />
    ${note}
    ${items}
    <feed />
    <text align="center" dw="true" dh="true" em="true">RITIRO: ${esc(pickupTime)}</text>
    <feed line="6" />
    <cut type="feed" />
  </epos-print>`;
}

function soapPrint(xmlBody) {
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header>
    <parameter xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">
      <devid>${PRINTER_DEV_ID}</devid>
      <timeout>10000</timeout>
      <printjobid>order-${Date.now()}</printjobid>
      </s:Header>
  <s:Body>
    ${xmlBody}
  </s:Body>
</s:Envelope>`;

  return fetch(`${PRINTER_URL}?devid=${PRINTER_DEV_ID}&timeout=10000`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': '""',
      'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT'
    },
    body: soap
  });
}

function initPrinter() {
  try {
    printerConnected = true;
    updatePrinterStatusUI(true);
    return true;
  } catch(e) {
    printerConnected = false;
    updatePrinterStatusUI(false);
    showToast('Errore inizializzazione stampante: ' + e.message);
    return false;
  }
}

function updatePrinterStatusUI(connected) {
  const indicator = document.getElementById('printer-status-indicator');
  if (!indicator) return;
  indicator.className = connected ? 'printer-status connected' : 'printer-status disconnected';
  indicator.title = connected ? 'Stampante connessa: ' + PRINTER_IP : 'Stampante non connessa: ' + PRINTER_IP;
  if (els.printerStatusText) {
    els.printerStatusText.textContent = connected ? 'Connessa' : 'Non connessa';
    els.printerStatusText.style.color = connected ? '#2e7d32' : '#c0392b';
  }
}

function testPrinterConnection() {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print"><text>Test stampante Forno99&#10;' + new Date().toLocaleString('it-IT') + '&#10;OK&#10;</text><feed line="2"/><cut type="feed"/></epos-print></s:Body></s:Envelope>';
  const url = 'tmprintassistant://tmprintassistant.epson.com/print?ver=1&data-type=eposprintxml&data=' + encodeURIComponent(xml);
  window.location.href = url;
  showToast('Apertura TM Print Assistant...');
}

function printOrder(order) {
  const id = String(order.id);
  const existing = printedOrders.get(id);
  if (existing && existing.status === 'printed') {
    showToast('Ordine gi\u00e0 stampato');
    return;
  }

  printedOrders.set(id, { status: 'pending', attempts: (existing ? existing.attempts : 0) + 1 });
  renderOrders();

  try {
    const xmlBody = buildReceiptXML(order);
    const xml = xmlBody;
    const url = 'tmprintassistant://tmprintassistant.epson.com/print?ver=1&data-type=eposprintxml&data=' + encodeURIComponent(xml);
    window.location.href = url;
    showToast('Apertura stampa ordine #' + (order.order_number || order.id));
    printedOrders.set(id, { status: 'pending', attempts: (existing ? existing.attempts : 0) + 1 });
    renderOrders();
  } catch(e) {
    console.error('Print setup error:', e);
    printedOrders.set(id, { status: 'failed', attempts: (existing ? existing.attempts : 0) + 1, error: e.message });
    showToast('Errore preparazione stampa');
    renderOrders();
  }
}

function printReceiptEpson(order) {
  printOrder(order);
}

function setStatus(id, status, btn) {
  const o = orders.find(x => String(x.id) === String(id));
  if (!o || o._saving) return;
  o._saving = true;
  const prev = o.status;
  o.status = status;
  renderStats();
  renderOrders();
  renderEarnings();
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  saveStatus(id, status).then(() => {
    o._saving = false;
    showToast('Ordine ' + o.order_number + ' \u2192 ' + status);
    if (status === 'preparing' && autoPrintEnabled) {
      printOrder(o);
    }
    if (currentStatus !== 'all') {
      currentStatus = status;
      els.filterTabs.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      const nt = els.filterTabs.querySelector('.filter-tab[data-status="' + status + '"]');
      if (nt) nt.classList.add('active');
      renderOrders();
    }
  }).catch(() => {
    o._saving = false;
    o.status = prev;
    renderStats();
    renderOrders();
    renderEarnings();
    if (btn) { btn.disabled = false; }
    showToast('Errore aggiornamento');
  });
}

function showLogin() { els.loginScreen.classList.remove('hidden'); els.dashboard.classList.add('hidden'); }
function showDashboard() { els.loginScreen.classList.add('hidden'); els.dashboard.classList.remove('hidden'); }

function loadAndRender() {
  const banner = document.getElementById('conn-banner');
  loadOrders().then(o => {
    if (banner) banner.classList.remove('show');
    const seen = new Map();
    o.forEach(x => { if (!seen.has(x.id)) seen.set(x.id, x); });
    o = Array.from(seen.values());
    const newOnes = o.filter(x => x.status === 'new' && !modalShownIds.has(x.id));
    const modal = document.getElementById('neworder-modal');
    if (newOnes.length && (!modal || modal.classList.contains('hidden'))) {
      const firstNew = newOnes[0];
      modalShownIds.add(firstNew.id);
      showNewOrderModal(firstNew);
    }
    o.forEach(x => knownIds.add(x.id));
    orders = o;
    renderStats();
    renderOrders();
    renderEarnings();
  }).catch(() => { if (banner) banner.classList.add('show'); showToast('Errore caricamento ordini'); });
}

function showNewOrderModal(o) {
  selectedNewOrder = o;
  const idEl = document.getElementById('no-id');
  if (idEl) idEl.textContent = 'Ordine #' + (o.order_number || o.id);
  const body = document.getElementById('no-body');
  if (body) {
    const items = (o.items || []).map(i => '<li>' + i.qty + '\u00d7 ' + esc(i.name) + ' \u20ac' + (i.qty * i.price).toFixed(2) + '</li>').join('');
    body.innerHTML = '<p><b>' + esc(o.customer_name) + '</b> \u2014 ' + esc(o.customer_phone) + '</p>' +
      '<p>' + (o.order_type === 'delivery' ? 'Consegna' : 'Ritiro') + (o.order_type === 'delivery' && o.delivery_timing === 'later' ? ' alle ' + esc(o.delivery_time) : (o.order_type === 'pickup' && o.pickup_time ? ' alle ' + esc(o.pickup_time) : '')) + '</p>' +
      '<p>Ordine effettuato: ' + new Date(o.created_at).toLocaleString('it-IT') + '</p>' +
      (o.delivery_address ? '<p>Indirizzo: ' + esc(o.delivery_address) + '</p>' : '') +
      (o.notes ? '<p><b>Note:</b> ' + esc(o.notes) + '</p>' : '') +
      '<ul>' + items + '</ul>' +
      '<p><b>Totale: \u20ac' + Number(o.total).toFixed(2) + '</b></p>';
  }
  const m = document.getElementById('neworder-modal');
  if (m) m.classList.remove('hidden');
}

let knownIds = new Set();
let unacceptedNew = new Set();
let alarmTimer = null;
let alarmAudio = null;
function playAlarm() { try { if (!alarmAudio) { alarmAudio = new Audio('ali_kebab_real_siren_alert.wav'); alarmAudio.loop = true; } alarmAudio.play(); } catch(e){ console.error('alarm', e); } }
function stopAlarm() { if (alarmAudio) { alarmAudio.pause(); alarmAudio.currentTime = 0; } }
let audioCtx = null;
function ensureAudio() {
  if (audioCtx) return audioCtx;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { audioCtx = null; }
  return audioCtx;
}
document.addEventListener('click', ensureAudio, { once: false });
document.addEventListener('keydown', ensureAudio, { once: false });

function renderOrders() {
  const filtered = getFiltered().sort((a, b) => {
    const pa = a.status === 'new' ? 0 : 1;
    const pb = b.status === 'new' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  els.orderList.innerHTML = '';
  els.resultCount.textContent = filtered.length + ' ordini';
  if (filtered.length === 0) {
    els.emptyState.classList.remove('hidden');
    els.emptyText.textContent = orders.length === 0 ? 'Nessun ordine ancora.' : 'Nessun ordine corrisponde al filtro.';
    els.orderList.appendChild(els.emptyState);
    return;
  }
  els.emptyState.classList.add('hidden');
  filtered.forEach(o => {
    const card = document.createElement('div');
    const waiting = o.status === 'new' && (Date.now() - new Date(o.created_at).getTime()) > 300000;
    const pinfo = printedOrders.get(String(o.id));
    const pstatus = pinfo ? pinfo.status : null;
    let pbadge = '';
    if (pstatus === 'printed') pbadge = '<span class="print-badge printed" title="Stampato">\u2705</span>';
    else if (pstatus === 'failed') pbadge = '<span class="print-badge failed" title="Stampa fallita - clicca per riprovare" onclick="event.stopPropagation(); printOrder(' + JSON.stringify(o) + ')">\u274c</span>';
    else if (pstatus === 'pending') pbadge = '<span class="print-badge pending" title="Stampa in corso">\ud83d\uddf0</span>';
    else if (o.status === 'new') pbadge = '<span class="print-badge pending" title="Nuovo - stampa all\'accettazione">\ud83d\udce9</span>';
    card.className = 'order-card' + (highlightId && o.id == highlightId ? ' highlight' : '') + (waiting ? ' waiting' : '');
    if (o._saving) card.classList.add('saving');
    card.innerHTML = `
      <div class="order-head">
        <div class="order-number">${esc(o.order_number)} <span class="order-id">ID: ${o.id}</span></div>
        <span class="order-status ${statusClass(o.status)}">${o.status}</span>
        ${pbadge}
      </div>
      <div class="order-meta">
        <span>\ud83d\udc46 ${esc(o.customer_name)}</span>
        <span>\ud83d\udc4f ${esc(o.customer_phone)}</span>
        <span>\ud83d\ude9a ${o.order_type}</span>
        ${o.delivery_address ? '<span>\ud83d\udccd ' + esc(o.delivery_address) + '</span>' : ''}
        ${o.order_type === 'delivery' && o.delivery_timing ? '<span>\u23f1 Delivery: ' + esc(o.delivery_timing === 'later' ? (o.delivery_time || '') : 'Now') + '</span>' : ''}
        ${o.order_type === 'pickup' && o.pickup_time ? '<span>\u23f1 Ritiro: ' + esc(o.pickup_time) + '</span>' : ''}
        <span>\u23f1 ${timeAgo(o.created_at)}</span>
      </div>
      ${o.notes ? '<div class="order-meta"><span>\ud83d\udcdd ' + esc(o.notes) + '</span></div>' : ''}
      <ul class="order-items">${(o.items || []).map(i => '<li>' + i.qty + '\u00d7 ' + esc(i.name) + ' <span style="float:right">\u20ac' + (i.qty * i.price).toFixed(2) + '</span></li>').join('')}</ul>
      <div class="order-foot">
        <div class="order-total">\u20ac${Number(o.total).toFixed(2)}</div>
        <div class="order-actions">
          <button class="btn btn-ghost btn-sm" data-action="status" data-id="${o.id}">Aggiorna</button>
          <button class="btn btn-ghost btn-sm" data-action="print" data-id="${o.id}">Stampa</button>
          ${o.status === 'new' ? '<button class="btn btn-success btn-sm" data-action="accept" data-id="${o.id}">Accetta</button><button class="btn btn-danger btn-sm" data-action="reject" data-id="${o.id}">Rifiuta</button>' : ''}
          ${o.status === 'accepted' ? '<button class="btn btn-primary btn-sm" data-action="preparing" data-id="${o.id}">In preparazione</button>' : ''}
          ${o.status === 'preparing' ? '<button class="btn btn-primary btn-sm" data-action="ready" data-id="${o.id}">Segna pronto</button>' : ''}
          ${o.status === 'ready' || o.status === 'out_for_delivery' ? '<button class="btn btn-success btn-sm" data-action="complete" data-id="${o.id}">Completa</button>' : ''}
        </div>
      </div>`;
    els.orderList.appendChild(card);
  });
}

els.loginForm.addEventListener('submit', e => {
  e.preventDefault();
  const user = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-password').value;
  fetch((window.API_BASE || '') + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) }).then(r => {
    if (!r.ok) throw new Error('bad');
    return r.json();
  }).then(d => {
    sessionStorage.setItem(SESSION_KEY, '1');
    sessionStorage.setItem('forno99_token', d.token);
    els.loginError.classList.add('hidden');
    showDashboard();
    loadAndRender();
    initPrinter();
  }).catch(() => {
    els.loginError.textContent = 'Nome utente o password non validi.';
    els.loginError.classList.remove('hidden');
  });
});

els.signoutBtn.addEventListener('click', () => {
  const t = sessionStorage.getItem('forno99_token');
  fetch((window.API_BASE || '') + '/api/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + t } }).finally(() => {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem('forno99_token');
    showLogin();
  });
});

els.filterTabs.addEventListener('click', e => {
  const tab = e.target.closest('.filter-tab');
  if (!tab) return;
  els.filterTabs.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  currentStatus = tab.dataset.status;
  renderOrders();
});

els.searchInput.addEventListener('input', e => { searchQuery = e.target.value; renderOrders(); });

function setDateFilter(v) {
  dateFilter = v;
  if (els.dateFilter) els.dateFilter.value = v;
  if (els.customPanel) els.customPanel.classList.toggle('hidden', v !== 'custom');
  if (v !== 'custom') renderOrders();
}
if (els.dateFilter) els.dateFilter.addEventListener('change', e => { setDateFilter(e.target.value); });

if (els.applyRange) els.applyRange.addEventListener('click', () => {
  if (els.dateFrom.value && els.dateTo.value && els.dateFrom.value > els.dateTo.value) { showToast('Data fine precedente alla data inizio'); return; }
  if (els.selectedRange) els.selectedRange.textContent = (els.dateFrom.value || '') + ' \u2192 ' + (els.dateTo.value || '');
  renderOrders();
});
if (els.cancelRange) els.cancelRange.addEventListener('click', () => {
  if (els.customPanel) els.customPanel.classList.add('hidden');
  dateFilter = 'today';
  if (els.dateFrom) els.dateFrom.value = '';
  if (els.dateTo) els.dateTo.value = '';
  if (els.selectedRange) els.selectedRange.textContent = '';
  renderOrders();
});
setDateFilter('today');

if (els.resetBtn) els.resetBtn.addEventListener('click', () => {
  currentStatus = 'all';
  els.filterTabs.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  const allTab = els.filterTabs.querySelector('.filter-tab[data-status="all"]');
  if (allTab) allTab.classList.add('active');
  setDateFilter('today');
  if (els.dateFrom) els.dateFrom.value = '';
  if (els.dateTo) els.dateTo.value = '';
  if (els.selectedRange) els.selectedRange.textContent = '';
  els.searchInput.value = '';
  searchQuery = '';
  renderOrders();
});

els.orderList.addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  if (action === 'status') {
    selectedOrder = orders.find(x => String(x.id) === String(id));
    if (selectedOrder) els.statusOrderInfo.textContent = selectedOrder.order_number + ' \u2014 ' + selectedOrder.customer_name;
    els.statusModal.classList.remove('hidden');
  } else if (action === 'accept') setStatus(id, 'preparing', btn);
  else if (action === 'reject') setStatus(id, 'rejected', btn);
  else if (action === 'preparing') setStatus(id, 'preparing', btn);
  else if (action === 'ready') { const oo = orders.find(x => String(x.id) === String(id)); setStatus(id, oo && oo.order_type === 'pickup' ? 'ready' : 'out_for_delivery', btn); }
  else if (action === 'complete') setStatus(id, 'completed', btn);
  else if (action === 'print') { const o = orders.find(x => String(x.id) === String(id)); if (o) printOrder(o); }
});

if (els.statusModal) {
  els.statusModal.querySelectorAll('button[data-status]').forEach(b => {
    b.addEventListener('click', () => {
      if (selectedOrder) setStatus(selectedOrder.id, b.dataset.status);
      els.statusModal.classList.add('hidden');
    });
  });
}
const statusClose = document.getElementById('status-close');
const statusCancel = document.getElementById('status-cancel');
if (statusClose) statusClose.addEventListener('click', () => els.statusModal.classList.add('hidden'));
if (statusCancel) statusCancel.addEventListener('click', () => els.statusModal.classList.add('hidden'));

if (els.refreshBtn) els.refreshBtn.addEventListener('click', () => {
  loadAndRender();
  showToast('Aggiornato');
});

setInterval(() => {
  if (!els.dashboard.classList.contains('hidden')) {
    loadAndRender();
  }
}, 5000);

// Expose printer functions globally for inline HTML onclick
window.initPrinter = initPrinter;
window.testPrinterConnection = testPrinterConnection;
window.printReceiptEpson = printReceiptEpson;
window.printOrder = printOrder;

// Toggle accepting orders
const toggleBtn = document.createElement("button"); toggleBtn.textContent = "Toggle Orders"; toggleBtn.className = "btn btn-ghost btn-sm"; toggleBtn.style.position = "fixed"; toggleBtn.style.bottom = "20px"; toggleBtn.style.right = "20px"; toggleBtn.style.zIndex = "9999"; document.body.appendChild(toggleBtn);
toggleBtn.addEventListener("click", async () => { if (!confirm("Sei sicuro?")) return; const t = sessionStorage.getItem("forno99_token"); const r = await fetch((window.API_BASE || "") + "/api/settings", { headers: { Authorization: "Bearer " + t } }); const d = await r.json(); const next = d.accepting_orders === "false" ? "true" : "false"; await fetch((window.API_BASE || "") + "/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + t }, body: JSON.stringify({ key: "accepting_orders", value: next }) }); });

const earningsTabs = document.getElementById('earnings-tabs');
if (earningsTabs) earningsTabs.addEventListener('click', e => {
  const tab = e.target.closest('.earnings-tab');
  if (!tab) return;
  earningsTabs.querySelectorAll('.earnings-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  earningsRange = tab.dataset.range;
  const ec = document.getElementById('earn-custom'); if (ec) ec.classList.toggle('hidden', earningsRange !== 'custom');
  renderEarnings();
});
const ef = document.getElementById('earn-from'); const et = document.getElementById('earn-to');
if (ef) ef.addEventListener('change', renderEarnings);
if (et) et.addEventListener('change', renderEarnings);
function initAuth() {
  if (sessionStorage.getItem(SESSION_KEY) === '1') { showDashboard(); loadAndRender(); initPrinter(); }
  else showLogin();
}
const noAccept = document.getElementById('no-accept');
const noReject = document.getElementById('no-reject');
if (noAccept) noAccept.addEventListener('click', () => { if (selectedNewOrder) { setStatus(selectedNewOrder.id, 'preparing'); document.getElementById('neworder-modal').classList.add('hidden'); } });
if (noReject) noReject.addEventListener('click', () => { if (selectedNewOrder) { setStatus(selectedNewOrder.id, 'rejected'); document.getElementById('neworder-modal').classList.add('hidden'); } });
initAuth();

// Printer settings modal handlers
if (els.printerSettingsBtn) els.printerSettingsBtn.addEventListener('click', () => {
  if (els.printerSettingsModal) els.printerSettingsModal.classList.remove('hidden');
});
const printerSettingsClose = document.getElementById('printer-settings-close');
if (printerSettingsClose) printerSettingsClose.addEventListener('click', () => {
  if (els.printerSettingsModal) els.printerSettingsModal.classList.add('hidden');
});
const printerSettingsModal = document.getElementById('printer-settings-modal');
if (printerSettingsModal) printerSettingsModal.addEventListener('click', (e) => {
  if (e.target === printerSettingsModal) printerSettingsModal.classList.add('hidden');
});
