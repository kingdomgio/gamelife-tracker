// GameLife Tracker — dashboard web (telefono, tablet, computer)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (n) => n == null ? '—' : new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n);
const DAY = 86400;
const CODE_ST = { 2: 'available', 1: 'last_units', 0: 'unavailable' };
const ST_LABEL = { available: 'Disponibile', last_units: 'Ultimi pezzi', unavailable: 'Non disponibile' };
const BELL_ON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5-6.7V3.5a2 2 0 0 0-4 0v.8A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>';
const BELL_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2h16l-2-2Z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dtf = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
const dtfShort = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'short' });
const tf = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const CHANNEL_SECRETS = { push: ['NTFY_TOPIC'], email: ['EMAIL'], telegram: ['TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID'], whatsapp: ['WHATSAPP_PHONE', 'WHATSAPP_KEY'] };
const LS_TOPIC = 'gl_ntfy_topic';

let DB = { products: {}, history: {}, state: {}, log: [], alerts: {}, settings: {}, secrets: [] };
let view = { limit: 60 };
let current = null;
let range = 0;
let lastRun = null;

// ---------- caricamento ----------
async function loadAll() {
  const [products, history, state, log, alerts, settings, request] = await Promise.all([
    GH.readJSON('data/products.json', {}), GH.readJSON('data/history.json', {}), GH.readJSON('data/state.json', {}),
    GH.readJSON('data/log.json', []), GH.readJSON('config/alerts.json', {}), GH.readJSON('config/settings.json', {}),
    GH.readJSON('config/request.json', null),
  ]);
  Object.assign(DB, { request, products: products || {}, history: history || {}, state: state || {}, log: log || [], alerts: alerts || {}, settings: Object.assign({ checkHour: 9, onlyAvailableDefault: true, pushEnabled: true }, settings) });
  if (GH.connected) { try { DB.secrets = await GH.listSecrets(); } catch { DB.secrets = []; } }
}

// ---------- calcoli ----------
function priceAt(h, idx, t) { let v = null; for (const pt of h) { if (pt[0] <= t) v = pt[idx]; else break; } return v; }
function derive(p) {
  const h = DB.history[p.id] || [];
  const now = p.lastSeen || Math.floor(Date.now() / 1000);
  const t7 = now - 7 * DAY;
  const n7 = priceAt(h, 1, t7), u7 = priceAt(h, 3, t7);
  const dn = (p.new && p.new.price != null && n7 != null) ? p.new.price - n7 : null;
  const du = (p.used && p.used.price != null && u7 != null) ? p.used.price - u7 : null;
  const delta = [dn, du].filter(x => x != null && x !== 0).sort((a, b) => a - b)[0] ?? (dn ?? du);
  const atMin = (p.new && p.new.price != null && p.minNew != null && p.new.price <= p.minNew && p.maxNew > p.minNew) ||
                (p.used && p.used.price != null && p.minUsed != null && p.used.price <= p.minUsed && p.maxUsed > p.minUsed);
  const sale = !!(p.new && p.new.list && p.new.price < p.new.list);
  const first = DB.state.firstRunTs || 0;
  const fresh = !!first && p.firstSeen > first && (Date.now() / 1000 - p.firstSeen) < 7 * DAY;
  return { delta, atMin, sale, fresh };
}
const isAvail = (c) => c && c.price != null && c.status !== 'unavailable';
function alertHit(p, a) {
  if (!a || p.gone) return false;
  const ok = (c, t) => t != null && t !== '' && c && c.price != null && c.price <= +t && (!a.onlyAvailable || c.status !== 'unavailable');
  return ok(p.new, a.newTarget) || ok(p.used, a.usedTarget);
}

// ---------- intestazione e stato del controllo ----------
function renderHeader() {
  const st = DB.state || {};
  const hour = String(+(DB.settings.checkHour ?? 9)).padStart(2, '0');
  let txt = st.lastRun
    ? `Ultimo controllo ${tf.format(new Date(st.lastRun.finishedAt))} · ${st.lastRun.count.toLocaleString('it-IT')} titoli` + (st.lastRun.device ? ` · da ${st.lastRun.device}` : '') + (st.lastRun.errors ? ` · ${st.lastRun.errors} pagine non lette` : '') + ` · ogni giorno dalle ${hour}:00`
    : `Nessun controllo ancora · ogni giorno dalle ${hour}:00 dal computer con l'estensione`;
  const err = st.lastError && (!st.lastRun || st.lastError.ts > st.lastRun.finishedAt);
  const staleH = st.lastRun ? (Date.now() - st.lastRun.finishedAt) / 3600e3 : 0;
  const stale = staleH > 30 ? `Il computer non invia dati da ${Math.floor(staleH / 24)} giorni: accendilo e apri Chrome` : '';
  $('#runInfo').innerHTML = esc(txt) + (err ? ` · <span class="err">Errore: ${esc(st.lastError.message)}</span>` : stale ? ` · <span class="err">${esc(stale)}</span>` : '');
  $('#connectBtn').hidden = GH.connected;
  $('#runNow').hidden = !GH.connected;
  $('#roBanner').hidden = GH.connected || !GH.repo.owner;
  if (IS_PRIVATE && !GH.connected) $('#roBanner').innerHTML = 'Repository privato. <button class="link-btn" data-open-connect>Collega questo dispositivo</button> con il tuo token per vedere prezzi e avvisi.';
  $$('.needs-token').forEach(b => b.disabled = !GH.connected);
  const chip = $('#runChip');
  const r = lastRun;
  const recent = r && (Date.now() - new Date(r.updated_at || r.created_at).getTime() < 20 * 60000);
  const busy = r && r.status !== 'completed';
  const pending = requestPending();
  $('#runNow').disabled = !!pending;
  if (pending) { chip.hidden = false; chip.className = 'run-chip busy'; chip.textContent = 'Richiesta inviata al computer: parte entro 15 minuti, se è acceso con Chrome aperto'; }
  else if (busy) { chip.hidden = false; chip.className = 'run-chip busy'; chip.innerHTML = `<a href="${esc(r.html_url)}" target="_blank" rel="noopener">${r.status === 'queued' ? 'Avvisi in coda su GitHub…' : 'Verifica degli avvisi su GitHub…'}</a>`; }
  else if (recent && r.conclusion === 'failure' && r.event !== 'schedule') { chip.hidden = false; chip.className = 'run-chip bad'; chip.innerHTML = `<a href="${esc(r.html_url)}" target="_blank" rel="noopener">Ultimo avvio non riuscito: dettagli</a>`; }
  else chip.hidden = true;
}

function requestPending() {
  const rq = DB.request && +DB.request.requestedAt;
  if (!rq || Date.now() - rq > 3 * 3600e3) return false;
  const started = DB.state.lastRun ? DB.state.lastRun.startedAt || 0 : 0;
  return rq > started;
}

let pollTimer = null, wasBusy = false;
async function pollRuns(fast) {
  clearTimeout(pollTimer);
  try {
    const rs = await GH.runs(3);
    lastRun = rs[0] || null;
    const busy = lastRun && lastRun.status !== 'completed';
    const pending = requestPending();
    if ((wasBusy && !busy) || pending) { await loadAll(); renderAll(); }
    wasBusy = !!busy || requestPending();
    pollTimer = setTimeout(() => pollRuns(), busy || fast ? 12000 : requestPending() ? 45000 : 300000);
  } catch { pollTimer = setTimeout(() => pollRuns(), 300000); }
}

// ---------- catalogo ----------
function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const fa = $('#fAvail').value, ft = $('#fType').value, fs = $('#fSpecial').value, so = $('#fSort').value;
  const words = q.split(/\s+/).filter(Boolean);
  let rows = Object.values(DB.products).map(p => ({ p, d: derive(p) }));
  rows = rows.filter(({ p, d }) => {
    if (fs === 'gone') { if (!p.gone) return false; } else if (p.gone) return false;
    if (words.length) { const n = (p.name + ' ' + (p.sku || '')).toLowerCase(); if (!words.every(w => n.includes(w))) return false; }
    if (fa === 'any' && !(isAvail(p.new) || isAvail(p.used))) return false;
    if (fa === 'new' && !isAvail(p.new)) return false;
    if (fa === 'used' && !isAvail(p.used)) return false;
    if (ft === 'preorder' && !p.preorder) return false;
    if (ft === 'instock' && p.preorder) return false;
    if (fs === 'drop' && !(d.delta < 0)) return false;
    if (fs === 'atmin' && !d.atMin) return false;
    if (fs === 'sale' && !d.sale) return false;
    if (fs === 'alerts' && !DB.alerts[p.id]) return false;
    if (fs === 'fresh' && !d.fresh) return false;
    return true;
  });
  const pn = (r, k) => (r.p[k] && r.p[k].price != null) ? r.p[k].price : null;
  const cmpNum = (a, b, dir) => (a == null) - (b == null) || dir * (a - b);
  const sorters = {
    name: (a, b) => a.p.name.localeCompare(b.p.name, 'it'),
    newAsc: (a, b) => cmpNum(pn(a, 'new'), pn(b, 'new'), 1),
    newDesc: (a, b) => cmpNum(pn(a, 'new'), pn(b, 'new'), -1),
    usedAsc: (a, b) => cmpNum(pn(a, 'used'), pn(b, 'used'), 1),
    drop: (a, b) => cmpNum(a.d.delta, b.d.delta, 1),
    recent: (a, b) => b.p.firstSeen - a.p.firstSeen || a.p.name.localeCompare(b.p.name, 'it'),
  };
  rows.sort(sorters[so] || sorters.name);
  return rows;
}

function priceCell(c, min, cls, preorder, label) {
  if (!c || c.price == null) return `<div class="price ${cls}" data-label="${label}"><span class="na">—</span></div>`;
  const st = preorder && c.status !== 'unavailable' && cls === 'pn' ? 'Prenotabile' : ST_LABEL[c.status];
  return `<div class="price ${cls}" data-label="${label}">${c.list && c.list > c.price ? `<span class="list-p">${fmt(c.list)}</span>` : ''}<b>${fmt(c.price)}</b>
    <span class="min"><span class="st ${c.status}">${st}</span></span>${min != null ? `<span class="min">min ${fmt(min)}</span>` : ''}</div>`;
}
function targetText(a) { return [a.newTarget != null ? 'N ' + fmt(+a.newTarget) : '', a.usedTarget != null ? 'U ' + fmt(+a.usedTarget) : ''].filter(Boolean).join(' · '); }

function renderList() {
  const rows = filtered();
  $('#list').innerHTML = rows.slice(0, view.limit).map(({ p, d }) => {
    const a = DB.alerts[p.id];
    const badges = [
      p.preorder ? '<span class="badge pre">Preordine</span>' : '',
      d.sale ? '<span class="badge sale">In sconto</span>' : '',
      d.fresh ? '<span class="badge fresh">Nuovo in catalogo</span>' : '',
      p.gone ? '<span class="badge gone">Fuori catalogo</span>' : '',
      alertHit(p, a) ? '<span class="badge hit">Obiettivo raggiunto</span>' : '',
      a ? `<span class="badge">Obiettivo ${targetText(a)}</span>` : '',
    ].join('');
    const delta = d.delta == null || d.delta === 0 ? '<span class="muted">—</span>' : (d.delta < 0 ? '▼ ' : '▲ ') + fmt(Math.abs(d.delta));
    return `<div class="row-item" data-id="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(p.name)}">
      <img loading="lazy" src="${esc(p.img || '')}" alt="">
      <div class="info"><div class="t">${esc(p.name)}</div><div class="sub">${badges}</div></div>
      ${priceCell(p.new, p.minNew, 'pn', p.preorder, 'Nuovo')}
      ${priceCell(p.used, p.minUsed, 'pu', false, 'Usato')}
      <div class="delta ${d.delta < 0 ? 'down' : d.delta > 0 ? 'up' : ''}">${delta}</div>
      <button class="bell ${a ? 'on' : ''}" data-bell="${esc(p.id)}" title="${a ? 'Modifica avviso' : 'Imposta prezzo obiettivo'}" aria-label="Avviso prezzo">${a ? BELL_ON : BELL_OFF}</button>
    </div>`;
  }).join('') || '<p class="hint">Nessun titolo corrisponde ai filtri.</p>';
  $('#listCount').textContent = `${Math.min(view.limit, rows.length).toLocaleString('it-IT')} di ${rows.length.toLocaleString('it-IT')} titoli`;
  $('#moreBtn').hidden = rows.length <= view.limit;
}

function renderKpis() {
  const all = Object.values(DB.products).filter(p => !p.gone);
  const k = [
    ['all', all.length, 'Titoli PS5 in catalogo'],
    ['any', all.filter(p => isAvail(p.new) || isAvail(p.used)).length, 'Disponibili'],
    ['used', all.filter(p => isAvail(p.used)).length, 'Usato disponibile'],
    ['drop', all.filter(p => derive(p).delta < 0).length, 'In calo (7 giorni)'],
    ['alerts', Object.keys(DB.alerts).length, 'Avvisi attivi'],
  ];
  $('#kpis').innerHTML = k.map(([key, v, l]) => `<button class="kpi" data-k="${key}"><b>${v.toLocaleString('it-IT')}</b><span>${l}</span></button>`).join('');
}

function renderAll() {
  const has = Object.keys(DB.products).length > 0;
  $('#emptyState').hidden = has;
  $('#catalogWrap').hidden = !has;
  $('#firstRun').hidden = !GH.connected;
  if (!GH.connected && !has) $('#emptyText').textContent = IS_PRIVATE
    ? 'Il tuo repository è privato: collega questo dispositivo (Profilo → Collega questo dispositivo) per vedere prezzi e avvisi.'
    : 'Il primo controllo non è ancora stato fatto: lo esegue l\'estensione Chrome sul computer appena la colleghi al tuo GitHub.';
  $('#alertCount').textContent = Object.keys(DB.alerts).length;
  renderHeader();
  if (has) { renderKpis(); renderList(); }
  renderAlerts(); renderLog(); renderProfile();
  if (current && $('#detail').open) renderDetail(current, true);
}

// ---------- avvisi ----------
function renderAlerts() {
  const entries = Object.entries(DB.alerts).map(([id, a]) => ({ id, a, p: DB.products[id] })).filter(x => x.p)
    .sort((x, y) => alertHit(y.p, y.a) - alertHit(x.p, x.a) || x.p.name.localeCompare(y.p.name, 'it'));
  if (!entries.length) { $('#alertsList').innerHTML = '<p class="hint">Nessun avviso. Apri un titolo dal Catalogo (o tocca la campanella) e imposta il tuo prezzo obiettivo.</p>'; return; }
  const gap = (c, t) => {
    if (t == null || t === '') return '<span class="muted">—</span>';
    if (!c || c.price == null) return `obiettivo ${fmt(+t)} · <span class="muted">prezzo n.d.</span>`;
    const diff = c.price - t;
    return diff <= 0 ? `<b class="ok">${fmt(c.price)}</b> ≤ obiettivo ${fmt(+t)}` : `${fmt(c.price)} · obiettivo ${fmt(+t)} <span class="muted">(−${fmt(diff)}, ${Math.round(diff / c.price * 100)}%)</span>`;
  };
  $('#alertsList').innerHTML = entries.map(({ id, a, p }) => `<div class="row-item alert-row" data-id="${esc(id)}" tabindex="0" role="button">
      <img loading="lazy" src="${esc(p.img || '')}" alt="">
      <div class="info"><div class="t">${esc(p.name)}</div><div class="sub">${alertHit(p, a) ? '<span class="badge hit">Obiettivo raggiunto</span>' : ''}${a.onlyAvailable ? '<span class="badge">Solo se disponibile</span>' : ''}${p.gone ? '<span class="badge gone">Fuori catalogo</span>' : ''}</div></div>
      <div class="price pn" data-label="Nuovo">${gap(p.new, a.newTarget)}</div>
      <div class="price pu" data-label="Usato">${gap(p.used, a.usedTarget)}</div>
      <button class="bell on" data-bell="${esc(id)}" aria-label="Modifica avviso">${BELL_ON}</button>
    </div>`).join('');
}

// ---------- notifiche ----------
function renderLog() {
  const l = DB.log || [];
  $('#logList').innerHTML = l.length ? l.map(e => `<div class="log-item">
      <div class="lh"><span>${e.type === 'error' ? '⚠️ ' : e.type === 'test' ? '🧪 ' : '🔔 '}${esc(e.title)}</span><time>${tf.format(new Date(e.ts))}</time></div>
      <pre>${esc(e.body || '')}</pre>
      ${e.results ? `<div class="res">${Object.entries(e.results).map(([k, v]) => `<span class="${v === 'ok' ? 'ok' : 'ko'}">${esc(k)}: ${esc(v)}</span>`).join('')}</div>` : ''}
    </div>`).join('') : '<p class="hint">Qui trovi lo storico delle notifiche inviate e degli eventuali errori.</p>';
}

// ---------- dettaglio titolo ----------
function openDetail(id) {
  current = id; range = 0;
  $$('#ranges button').forEach(b => b.classList.toggle('on', b.dataset.r === '0'));
  if (!$('#detail').open) $('#detail').showModal();
  renderDetail(id);
  $('#detail').scrollTop = 0;
}

function renderDetail(id, keepForm) {
  const p = DB.products[id]; if (!p) return;
  const d = derive(p), a = DB.alerts[id], h = DB.history[id] || [];
  $('#dImg').src = p.img || '';
  $('#dTitle').textContent = p.name;
  $('#dLink').href = p.url;
  $('#dBadges').innerHTML = [p.sku ? `<span class="badge">${esc(p.sku)}</span>` : '', p.preorder ? '<span class="badge pre">Preordine</span>' : '', d.sale ? '<span class="badge sale">In sconto</span>' : '', p.gone ? '<span class="badge gone">Fuori catalogo</span>' : ''].join('');
  const avg = (idx) => { const v = h.map(x => x[idx]).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const card = (k, label, c, min, max, av) => `<div class="pcard"><h4><i class="sw sw-${k}"></i>${label}</h4>
    <div class="big">${c && c.price != null ? fmt(c.price) : '—'}</div>
    <div>${c ? `<span class="st ${c.status}">${k === 'new' && p.preorder && c.status !== 'unavailable' ? 'Prenotabile' : ST_LABEL[c.status]}</span>` : '<span class="muted">Non venduto</span>'}${c && c.list && c.list > c.price ? ` · <span class="muted">listino ${fmt(c.list)}</span>` : ''}</div>
    <div class="stats"><span>Min ${fmt(min)}</span><span>Max ${fmt(max)}</span><span>Media ${fmt(av)}</span></div></div>`;
  $('#dPrices').innerHTML = card('new', 'Nuovo', p.new, p.minNew, p.maxNew, avg(1)) + card('used', 'Usato', p.used, p.minUsed, p.maxUsed, avg(3));
  drawChart(p, h, a);
  $('#histTable').innerHTML = `<table><thead><tr><th>Data</th><th>Nuovo</th><th>Stato</th><th>Usato</th><th>Stato</th></tr></thead><tbody>${h.slice().reverse().map(pt => `<tr><td>${dtf.format(new Date(pt[0] * 1000))}</td><td>${fmt(pt[1])}</td><td>${pt[2] != null ? ST_LABEL[CODE_ST[pt[2]]] : '—'}</td><td>${fmt(pt[3])}</td><td>${pt[4] != null ? ST_LABEL[CODE_ST[pt[4]]] : '—'}</td></tr>`).join('')}</tbody></table>`;
  if (keepForm) return;
  const f = $('#alertForm');
  f.newTarget.value = a && a.newTarget != null ? a.newTarget : '';
  f.usedTarget.value = a && a.usedTarget != null ? a.usedTarget : '';
  f.onlyAvailable.checked = a ? !!a.onlyAvailable : (DB.settings.onlyAvailableDefault !== false);
  $('#delAlert').hidden = !a;
  $('#afMsg').textContent = GH.connected ? '' : 'Per salvare un avviso collega prima questo dispositivo.';
  const q = [], r2 = (x) => +(x).toFixed(2);
  if (p.new && p.new.price != null) {
    q.push([`Nuovo −10% (${fmt(r2(p.new.price * .9))})`, 'newTarget', r2(p.new.price * .9)]);
    q.push([`Nuovo −20% (${fmt(r2(p.new.price * .8))})`, 'newTarget', r2(p.new.price * .8)]);
    if (p.minNew != null && p.minNew < p.new.price) q.push([`Nuovo al minimo storico (${fmt(p.minNew)})`, 'newTarget', p.minNew]);
  }
  if (p.used && p.used.price != null) {
    q.push([`Usato −10% (${fmt(r2(p.used.price * .9))})`, 'usedTarget', r2(p.used.price * .9)]);
    q.push([`Usato al prezzo attuale (${fmt(p.used.price)})`, 'usedTarget', p.used.price]);
  }
  $('#quick').innerHTML = q.map(([l, f2, v]) => `<button type="button" class="btn small" data-f="${f2}" data-v="${v}">${esc(l)}</button>`).join('');
}

function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }

function drawChart(p, h, a) {
  const el = $('#chart');
  const W = el.clientWidth || 800, H = el.clientHeight || 260;
  const m = { l: 52, r: 10, t: 12, b: 26 };
  const t1 = Math.max(Math.floor(Date.now() / 1000), p.lastSeen || 0);
  let t0 = h.length ? h[0][0] : t1;
  if (range) t0 = Math.max(t0, t1 - range * DAY);
  if (t1 - t0 < 7 * DAY) t0 = t1 - 7 * DAY;
  const vals = [];
  h.forEach((pt, i) => { const next = h[i + 1] ? h[i + 1][0] : t1; if (next >= t0) { if (pt[1] != null) vals.push(pt[1]); if (pt[3] != null) vals.push(pt[3]); } });
  if (a) { if (a.newTarget != null && a.newTarget !== '') vals.push(+a.newTarget); if (a.usedTarget != null && a.usedTarget !== '') vals.push(+a.usedTarget); }
  if (!vals.length) { el.innerHTML = '<svg><text class="note" x="50%" y="50%" text-anchor="middle">Nessun prezzo registrato</text></svg>'; return; }
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.12, 2);
  lo = Math.max(0, Math.floor((lo - pad) / 5) * 5); hi = Math.ceil((hi + pad) / 5) * 5;
  const x = t => m.l + (t - t0) / (t1 - t0) * (W - m.l - m.r);
  const y = v => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const step = niceStep((hi - lo) / 4);
  let grid = '';
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toLocaleString('it-IT')} €</text>`;
  let xt = '';
  const nT = Math.max(2, Math.min(6, Math.floor((W - m.l) / 95)));
  for (let i = 0; i <= nT; i++) { const t = t0 + (t1 - t0) * i / nT; xt += `<text x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === nT ? 'end' : 'middle'}">${dtfShort.format(new Date(t * 1000))}</text>`; }
  const paths = (pi, si) => {
    let solid = '', dash = '';
    for (let i = 0; i < h.length; i++) {
      const pt = h[i], v = pt[pi];
      const ta = Math.max(pt[0], t0), tb = h[i + 1] ? h[i + 1][0] : t1;
      if (v == null || tb < t0) continue;
      const seg = `M${x(ta).toFixed(1)},${y(v).toFixed(1)}H${x(Math.min(tb, t1)).toFixed(1)}`;
      const nv = h[i + 1] && h[i + 1][pi];
      const vert = (nv != null && tb <= t1) ? `V${y(nv).toFixed(1)}` : '';
      if (pt[si] === 0) dash += seg + vert; else solid += seg + vert;
    }
    return { solid, dash };
  };
  const pn = paths(1, 2), pu = paths(3, 4);
  const target = (v, cls, label) => v == null || v === '' ? '' : `<line class="target ${cls}" x1="${m.l}" x2="${W - m.r}" y1="${y(+v)}" y2="${y(+v)}"/><text class="target-label" x="${W - m.r - 4}" y="${y(+v) - 5}" text-anchor="end">${label} ${fmt(+v)}</text>`;
  const dot = (v, cls) => v == null ? '' : `<circle cx="${x(t1)}" cy="${y(v)}" r="4" fill="var(--series-${cls})" stroke="var(--surface)" stroke-width="2"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Storico prezzi di ${esc(p.name)}">
    <g class="grid axis">${grid}</g><g class="axis">${xt}</g>
    ${target(a && a.newTarget, 'l-new', 'Obiettivo nuovo')}${target(a && a.usedTarget, 'l-used', 'Obiettivo usato')}
    <path class="l-used" d="${pu.solid}" fill="none" stroke-width="2"/><path class="l-used dashed" d="${pu.dash}" fill="none" stroke-width="2"/>
    <path class="l-new" d="${pn.solid}" fill="none" stroke-width="2"/><path class="l-new dashed" d="${pn.dash}" fill="none" stroke-width="2"/>
    ${dot(p.used && p.used.price, 'used')}${dot(p.new && p.new.price, 'new')}
    ${h.length <= 1 ? `<text class="note" x="${m.l + 8}" y="${m.t + 14}">Lo storico cresce di un punto a ogni variazione.</text>` : ''}
    <line class="cross" id="cross" y1="${m.t}" y2="${H - m.b}" x1="-10" x2="-10"/>
    <rect id="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>
  </svg>`;
  const tip = $('#tooltip'), hit = $('#hit', el), cross = $('#cross', el);
  const move = (clientX, clientY) => {
    const r = el.getBoundingClientRect();
    const px = Math.min(W - m.r, Math.max(m.l, (clientX - r.left) * (W / r.width)));
    const t = t0 + (px - m.l) / (W - m.l - m.r) * (t1 - t0);
    let pt = null; for (const q of h) { if (q[0] <= t) pt = q; else break; }
    cross.setAttribute('x1', px); cross.setAttribute('x2', px);
    const row = (k, v, s) => `<div class="tt-r"><span><i style="background:var(--series-${k})"></i>${k === 'new' ? 'Nuovo' : 'Usato'}</span><b>${fmt(v)}</b></div><div class="tt-r muted"><span></span><span>${s != null ? ST_LABEL[CODE_ST[s]] : ''}</span></div>`;
    tip.innerHTML = `<div class="tt-d">${dtf.format(new Date(t * 1000))}</div>${pt ? row('new', pt[1], pt[2]) + row('used', pt[3], pt[4]) : '<div class="muted">Nessun dato</div>'}`;
    tip.hidden = false;
    const cr = $('.chart-card').getBoundingClientRect();
    let left = clientX - cr.left + 14; if (left + 190 > cr.width) left = clientX - cr.left - 200; if (left < 4) left = 4;
    tip.style.left = left + 'px'; tip.style.top = Math.max(4, clientY - cr.top - 70) + 'px';
  };
  const leave = () => { tip.hidden = true; cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); };
  hit.addEventListener('pointermove', (ev) => move(ev.clientX, ev.clientY));
  hit.addEventListener('pointerdown', (ev) => move(ev.clientX, ev.clientY));
  hit.addEventListener('pointerleave', leave);
}

// ---------- profilo ----------
function renderProfile() {
  const s = DB.settings;
  const sel = $('#checkHour');
  if (!sel.options.length) for (let i = 0; i < 24; i++) sel.add(new Option(String(i).padStart(2, '0') + ':00', i));
  sel.value = s.checkHour ?? 9;
  $('#settingsForm').onlyAvailableDefault.checked = s.onlyAvailableDefault !== false;
  $('[data-channel=push]').pushEnabled.checked = s.pushEnabled !== false;
  $$('.sec-state').forEach(el => {
    if (!GH.connected) { el.textContent = ''; return; }
    const on = DB.secrets.includes(el.dataset.state);
    el.className = 'sec-state ' + (on ? 'on' : 'off'); el.textContent = on ? '● attivo' : '○ non impostato';
  });
  $$('.channel input:not([type=checkbox])').forEach(inp => {
    const set = DB.secrets.includes(inp.name);
    if (!inp.dataset.ph) inp.dataset.ph = inp.placeholder;
    inp.placeholder = set ? 'Impostato · lascia vuoto per non cambiarlo' : inp.dataset.ph;
  });
  const topic = GH.store.get(LS_TOPIC);
  const tIn = $('[data-channel=push]').NTFY_TOPIC;
  if (topic && !tIn.value) tIn.value = topic;
  $('#deviceState').innerHTML = GH.connected
    ? `<p class="hint">Collegato al repository <b>${esc(GH.repo.owner)}/${esc(GH.repo.repo)}</b>: da qui puoi modificare avvisi e notifiche.</p><button type="button" class="btn" id="disconnectBtn">Scollega questo dispositivo</button>`
    : `<p class="hint">Sola lettura. Per modificare avvisi e profilo da questo dispositivo, collegalo con il tuo token GitHub (lo trovi nel file salvato durante l'installazione).</p><button type="button" class="btn primary" data-open-connect>Collega questo dispositivo</button>`;
}

function msgIn(form, text) { const m = $('[data-msg]', form); if (m) { m.textContent = text; if (text) setTimeout(() => { if (m.textContent === text) m.textContent = ''; }, 6000); } }
function randomTopic() { const a = 'abcdefghijkmnpqrstuvwxyz23456789'; return 'gamelife-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => a[b % 32]).join(''); }

async function waitForLog(since, type, onDone) {
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const log = await GH.readJSON('data/log.json', []);
    const e = (log || []).find(x => x.type === type && x.ts > since);
    if (e) { DB.log = log; renderLog(); onDone(e); return; }
  }
  onDone(null);
}

// ---------- app Android ----------
const IS_PRIVATE = !!(window.GL_CONFIG && window.GL_CONFIG.private);
const IS_NATIVE = !!(window.Capacitor && (typeof Capacitor.isNativePlatform === 'function' ? Capacitor.isNativePlatform() : Capacitor.platform && Capacitor.platform !== 'web'));
async function setupApkCard() {
  if (IS_NATIVE) { ['#apkCard', '#pwaCard'].forEach(s => { const e = $(s); if (e) e.hidden = true; }); const ex = $('#exportBtn'); if (ex) ex.closest('.card').hidden = true; return; }
  const { owner, repo } = GH.repo;
  if (location.protocol === 'file:' || IS_PRIVATE) { const pc = $('#pwaCard'); if (pc) pc.hidden = true; }
  $('#apkLink').href = `https://github.com/${owner}/${repo}/releases/download/app/GameLife-Tracker.apk`;
  try {
    if (IS_PRIVATE && !GH.connected) { $('#apkStatus').textContent = 'Repository privato: dal telefono accedi prima a github.com nel browser, poi tocca Scarica l\'app.'; return; }
    const r = IS_PRIVATE
      ? await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/app`, { headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + (GH.store.get('gl_token') || '') } })
      : await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/app`, { headers: { Accept: 'application/vnd.github+json' } });
    if (IS_PRIVATE) $('#apkStatus').dataset.private = '1';
    if (r.status === 404) { $('#apkStatus').innerHTML = `L'app non è ancora pronta: GitHub la prepara da sola dopo l'installazione (circa 10 minuti). Puoi seguirla su <a href="https://github.com/${owner}/${repo}/actions" target="_blank" rel="noopener">GitHub Actions</a>.`; return; }
    const rel = await r.json();
    const asset = (rel.assets || []).find(a => /\.apk$/i.test(a.name));
    if (asset) $('#apkStatus').textContent = `Versione aggiornata il ${tf.format(new Date(asset.updated_at))} · ${(asset.size / 1048576).toFixed(1)} MB` + (IS_PRIVATE ? ' · repository privato: dal telefono devi aver fatto l\'accesso a github.com nel browser.' : '');
  } catch { /* stato non disponibile */ }
}

// ---------- eventi ----------
function requireToken() { if (GH.connected) return true; $('#connectDlg').showModal(); return false; }

function bind() {
  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button').forEach(x => x.setAttribute('aria-selected', x === b));
    $$('.tab').forEach(t => t.hidden = t.id !== 'tab-' + b.dataset.tab);
    window.scrollTo(0, 0);
  }));
  const rerender = () => { view.limit = 60; renderList(); };
  let qt; $('#q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(rerender, 150); });
  ['#fAvail', '#fType', '#fSpecial', '#fSort'].forEach(s => $(s).addEventListener('change', rerender));
  $('#moreBtn').addEventListener('click', () => { view.limit += 60; renderList(); });
  $('#kpis').addEventListener('click', (e) => {
    const k = e.target.closest('.kpi'); if (!k) return;
    const key = k.dataset.k;
    $('#fAvail').value = ['any', 'used'].includes(key) ? key : 'all';
    $('#fSpecial').value = ['drop', 'alerts'].includes(key) ? key : 'all';
    if (key === 'drop') $('#fSort').value = 'drop';
    rerender();
  });
  const openFrom = (e) => {
    const b = e.target.closest('[data-bell]'), r = e.target.closest('.row-item');
    if (b) { e.stopPropagation(); openDetail(b.dataset.bell); if (matchMedia('(hover: hover)').matches) setTimeout(() => $('#alertForm').newTarget.focus(), 50); return; }
    if (r) openDetail(r.dataset.id);
  };
  ['#list', '#alertsList'].forEach(s => {
    $(s).addEventListener('click', openFrom);
    $(s).addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('row-item')) openDetail(e.target.dataset.id); });
  });

  $('#dClose').addEventListener('click', () => $('#detail').close());
  $('#detail').addEventListener('click', (e) => { if (e.target === $('#detail')) $('#detail').close(); });
  $('#ranges').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    range = +b.dataset.r; $$('#ranges button').forEach(x => x.classList.toggle('on', x === b));
    drawChart(DB.products[current], DB.history[current] || [], DB.alerts[current]);
  });
  $('#quick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) $('#alertForm')[b.dataset.f].value = b.dataset.v; });

  $('#alertForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireToken()) return;
    const f = e.target, id = current, p = DB.products[id];
    const nt = f.newTarget.value === '' ? null : +(+f.newTarget.value).toFixed(2);
    const ut = f.usedTarget.value === '' ? null : +(+f.usedTarget.value).toFixed(2);
    if (nt == null && ut == null) { $('#afMsg').textContent = 'Inserisci almeno un prezzo obiettivo.'; return; }
    $('#afMsg').textContent = 'Salvataggio…';
    try {
      const entry = { newTarget: nt, usedTarget: ut, onlyAvailable: f.onlyAvailable.checked, updated: Date.now() };
      DB.alerts = await GH.updateJSON('config/alerts.json', (cur) => { entry.created = (cur[id] && cur[id].created) || Date.now(); cur[id] = entry; return cur; }, `Avviso: ${p.name}`);
      $('#delAlert').hidden = false;
      const hit = alertHit(p, entry);
      if (hit) { await GH.dispatch('alerts', id).catch(() => {}); pollRuns(true); }
      $('#afMsg').textContent = hit ? 'Salvato. Il prezzo è già sotto la soglia: la notifica arriva entro un paio di minuti.' : 'Salvato. Ti avviso appena il prezzo scende alla soglia.';
      renderAll();
    } catch (err) { $('#afMsg').textContent = err.message; }
  });
  $('#delAlert').addEventListener('click', async () => {
    if (!requireToken()) return;
    const id = current;
    $('#afMsg').textContent = 'Rimozione…';
    try {
      DB.alerts = await GH.updateJSON('config/alerts.json', (cur) => { delete cur[id]; return cur; }, `Avviso rimosso: ${DB.products[id].name}`);
      $('#alertForm').newTarget.value = ''; $('#alertForm').usedTarget.value = '';
      $('#delAlert').hidden = true; $('#afMsg').textContent = 'Avviso rimosso.';
      renderAll();
    } catch (err) { $('#afMsg').textContent = err.message; }
  });

  const runNow = async () => {
    if (!requireToken()) return;
    $('#runNow').disabled = true; $('#firstRun').disabled = true;
    try {
      DB.request = await GH.updateJSON('config/request.json', () => ({ requestedAt: Date.now(), from: IS_NATIVE ? 'app Android' : (navigator.userAgentData && navigator.userAgentData.mobile) || /Mobi/i.test(navigator.userAgent) ? 'telefono' : 'browser' }), 'Richiesta di controllo');
      renderHeader(); setTimeout(() => pollRuns(true), 45000);
    } catch (err) { alert(err.message); }
    finally { $('#firstRun').disabled = false; }
  };
  $('#runNow').addEventListener('click', runNow);
  $('#firstRun').addEventListener('click', runNow);

  // collegamento dispositivo
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-connect]')) $('#connectDlg').showModal();
    if (e.target.closest('#disconnectBtn')) { GH.disconnect(); DB.secrets = []; renderAll(); }
  });
  $('#connectBtn').addEventListener('click', () => $('#connectDlg').showModal());
  $('#connectDlg [data-close]').addEventListener('click', () => $('#connectDlg').close());
  $('#connectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; msgIn(f, 'Verifica…');
    try { await GH.connect(f.token.value); f.token.value = ''; msgIn(f, ''); $('#connectDlg').close(); await loadAll(); renderAll(); setupApkCard(); pollRuns(); }
    catch (err) { msgIn(f, err.message); }
  });

  // impostazioni generali
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; msgIn(f, 'Salvataggio…');
    try {
      DB.settings = await GH.updateJSON('config/settings.json', (cur) => Object.assign(cur, { checkHour: +f.checkHour.value, onlyAvailableDefault: f.onlyAvailableDefault.checked }), 'Impostazioni aggiornate');
      msgIn(f, 'Salvato.'); renderHeader();
    } catch (err) { msgIn(f, err.message); }
  });

  // canali di notifica (segreti cifrati su GitHub)
  $$('.channel').forEach(form => {
    const ch = form.dataset.channel;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msgIn(form, 'Salvataggio…');
      try {
        if (ch === 'email' && form.EMAIL.value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.EMAIL.value.trim())) throw new Error('Controlla l\'indirizzo email.');
        for (const name of CHANNEL_SECRETS[ch]) {
          const v = form[name].value.trim();
          if (v) { await GH.setSecret(name, v); if (name === 'NTFY_TOPIC') GH.store.set(LS_TOPIC, v); }
        }
        if (ch === 'push') DB.settings = await GH.updateJSON('config/settings.json', (cur) => Object.assign(cur, { pushEnabled: form.pushEnabled.checked }), 'Impostazioni push aggiornate');
        if (ch === 'email' && form.EMAIL.value && !DB.secrets.includes('NTFY_TOPIC') && !GH.store.get(LS_TOPIC)) {
          const t = randomTopic(); await GH.setSecret('NTFY_TOPIC', t); GH.store.set(LS_TOPIC, t);
        }
        DB.secrets = await GH.listSecrets();
        $$('input:not([type=checkbox])', form).forEach(i => { if (i.name !== 'NTFY_TOPIC') i.value = ''; });
        renderProfile(); msgIn(form, 'Salvato.');
      } catch (err) { msgIn(form, err.message); }
    });
    $('[data-clear]', form).addEventListener('click', async () => {
      msgIn(form, 'Rimozione…');
      try {
        for (const name of CHANNEL_SECRETS[ch]) await GH.deleteSecret(name);
        if (ch === 'push') { GH.store.set(LS_TOPIC, null); form.NTFY_TOPIC.value = ''; }
        DB.secrets = await GH.listSecrets(); renderProfile(); msgIn(form, 'Canale rimosso.');
      } catch (err) { msgIn(form, err.message); }
    });
  });
  $('#genTopic').addEventListener('click', () => { $('[data-channel=push]').NTFY_TOPIC.value = randomTopic(); });
  $('#copyTopic').addEventListener('click', async () => {
    const v = $('[data-channel=push]').NTFY_TOPIC.value; if (!v) return;
    try { await navigator.clipboard.writeText(v); $('#copyTopic').textContent = 'Copiato'; } catch { $('#copyTopic').textContent = 'Selezionalo e copia'; }
    setTimeout(() => $('#copyTopic').textContent = 'Copia', 1500);
  });
  $('#findChat').addEventListener('click', async () => {
    const form = $('[data-channel=telegram]'), out = $('[data-chat]', form);
    const tk = form.TELEGRAM_TOKEN.value.trim();
    if (!tk) { out.textContent = 'Incolla prima il token del bot.'; return; }
    out.textContent = 'Cerco…';
    try {
      const j = await (await fetch(`https://api.telegram.org/bot${tk}/getUpdates`)).json();
      if (!j.ok) throw new Error(j.description || 'token non valido');
      const chats = [];
      for (const u of j.result || []) { const c = (u.message || u.channel_post || u.my_chat_member || {}).chat; if (c && !chats.find(x => x.id === c.id)) chats.push({ id: c.id, name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id) }); }
      if (!chats.length) { out.textContent = 'Nessun messaggio trovato: invia "ciao" al tuo bot su Telegram e riprova.'; return; }
      form.TELEGRAM_CHAT_ID.value = chats[0].id;
      out.textContent = `Trovato: ${chats.map(c => `${c.name} (${c.id})`).join(', ')}. Ora premi Salva.`;
    } catch (err) { out.textContent = 'Non riesco a leggerlo da qui (' + err.message + '). In alternativa scrivi a @userinfobot su Telegram: ti risponde con il tuo chat ID.'; }
  });

  $('#testBtn').addEventListener('click', async () => {
    if (!requireToken()) return;
    const since = Date.now() - 5000;
    $('#testMsg').textContent = 'Avviato su GitHub, attendo il risultato (circa 1 minuto)…'; $('#testResult').innerHTML = '';
    $('#testBtn').disabled = true;
    try {
      await GH.dispatch('test'); pollRuns(true);
      waitForLog(since, 'test', (e) => {
        $('#testBtn').disabled = false;
        if (!e) { $('#testMsg').textContent = 'Nessun risultato ancora: controlla più tardi la scheda Notifiche.'; return; }
        $('#testMsg').textContent = '';
        $('#testResult').innerHTML = Object.entries(e.results || {}).map(([k, v]) => `<div class="${v === 'ok' ? 'ok' : 'ko'}">${esc(k)}: ${v === 'ok' ? 'inviata ✓' : esc(v)}</div>`).join('');
      });
    } catch (err) { $('#testMsg').textContent = err.message; $('#testBtn').disabled = false; }
  });

  $('#exportBtn').addEventListener('click', () => {
    const data = { products: DB.products, history: DB.history, alerts: DB.alerts, settings: DB.settings, state: DB.state, log: DB.log };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `gamelife-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  });

  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (current && $('#detail').open) drawChart(DB.products[current], DB.history[current] || [], DB.alerts[current]); }, 120); });
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible') { await loadAll().catch(() => {}); renderAll(); pollRuns(); } });
}

(async () => {
  bind();
  if (!GH.repo.owner) { if (window.GLIntro) window.GLIntro.ready(); }
  if (!GH.repo.owner) { $('#runInfo').textContent = 'Configurazione mancante: reinstalla con installer.html.'; return; }
  try { await loadAll(); } catch (err) { $('#runInfo').textContent = 'Impossibile leggere i dati: ' + err.message; }
  renderAll();
  if (window.GLIntro) window.GLIntro.ready();
  setupApkCard();
  pollRuns();
})();
