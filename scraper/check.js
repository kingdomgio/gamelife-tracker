#!/usr/bin/env node
// GameLife Tracker (GitHub) — avvisi e notifiche sui dati letti dall'estensione Chrome
// La lettura del catalogo gamelife.it la fa l'estensione Chrome sul computer, che carica qui i dati.
// Uso: node scraper/check.js [alerts|test|watchdog] [--id=<titolo>]
//   alerts   → verifica gli avvisi sui dati appena caricati e invia le notifiche
//   test     → invia una notifica di prova su tutti i canali configurati
//   watchdog → avvisa (una volta al giorno) se il computer non invia dati da più di un giorno
const fs = require('fs');
const path = require('path');
const GLNotify = require('./notify.js');

const ROOT = process.env.GL_ROOT || path.join(__dirname, '..');

const file = (rel) => path.join(ROOT, rel);
// indirizzo della dashboard web da mettere nelle notifiche (vuoto se il repository è privato)
function dashboardUrl() {
  if (process.env.DASHBOARD_URL) return process.env.DASHBOARD_URL;
  try { const r = JSON.parse(fs.readFileSync(file('config/repo.json'), 'utf8')); if (r.private) return ''; if (r.dashboardUrl) return r.dashboardUrl; } catch { /* nessun file */ }
  const [o, n] = String(process.env.GITHUB_REPOSITORY || '').split('/');
  return o && n ? `https://${o}.github.io/${n}/` : '';
}
function readJSON(rel, def) { try { return JSON.parse(fs.readFileSync(file(rel), 'utf8')); } catch { return def; } }
const written = new Set();
function writeJSON(rel, obj, pretty) {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), JSON.stringify(obj, null, pretty ? 2 : 0) + '\n');
  written.add(rel);
}

function nowParts(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

function notifyConfig(settings) {
  const e = process.env;
  return {
    pushEnabled: settings.pushEnabled !== false,
    ntfyTopic: (e.NTFY_TOPIC || '').trim(),
    email: (e.EMAIL || '').trim(),
    telegramToken: (e.TELEGRAM_TOKEN || '').trim(),
    telegramChatId: (e.TELEGRAM_CHAT_ID || '').trim(),
    whatsappPhone: (e.WHATSAPP_PHONE || '').trim(),
    whatsappKey: (e.WHATSAPP_KEY || '').trim(),
  };
}

function addLog(entry) {
  const log = readJSON('data/log.json', []);
  log.unshift(Object.assign({ ts: Date.now() }, entry));
  writeJSON('data/log.json', log.slice(0, 300));
}

// ---------- avvisi ----------
function conditionMet(cur, target, onlyAvailable) {
  if (target == null || target === '' || !cur || cur.price == null) return false;
  if (onlyAvailable && cur.status === 'unavailable') return false;
  return cur.price <= +target;
}

// Avvisa quando la condizione diventa vera o quando il prezzo scende ancora; si riarma se il prezzo risale.
function evaluateAlerts(onlyId) {
  const alerts = readJSON('config/alerts.json', {});
  const products = readJSON('data/products.json', {});
  const notified = readJSON('data/notified.json', {});
  const hits = [];
  let changed = false;
  for (const id of Object.keys(notified)) if (!alerts[id]) { delete notified[id]; changed = true; }
  for (const [id, a] of Object.entries(alerts)) {
    if (onlyId && id !== onlyId) continue;
    const p = products[id];
    if (!p) continue;
    const n = notified[id] || {};
    for (const cond of ['new', 'used']) {
      const target = cond === 'new' ? a.newTarget : a.usedTarget;
      const cur = p.gone ? null : p[cond];
      // se l'avviso è stato modificato dopo l'ultima notifica, riparte da zero
      if (n.at && a.updated && a.updated > n.at) { n[cond] = null; }
      if (conditionMet(cur, target, a.onlyAvailable)) {
        if (n[cond] == null || cur.price < n[cond]) { hits.push({ product: p, cond, price: cur.price, target: +target, status: cur.status }); n[cond] = cur.price; changed = true; }
      } else if (n[cond] != null) { n[cond] = null; changed = true; }
    }
    n.at = Date.now();
    notified[id] = n;
  }
  if (changed || hits.length) writeJSON('data/notified.json', notified);
  return hits;
}

async function notifyHits(hits, settings) {
  const msg = GLNotify.buildMessage(hits, { dashboardUrl: dashboardUrl() });
  const results = await GLNotify.sendAll(notifyConfig(settings), msg);
  addLog({ type: 'alert', title: msg.title, body: msg.body, results, ids: hits.map(h => h.product.id) });
  console.log('Avvisi inviati:', hits.length, JSON.stringify(results));
}

// ---------- sorveglianza: il computer sta inviando i dati? ----------
async function watchdog(settings, today) {
  const state = readJSON('data/state.json', {});
  const last = state.lastRun && state.lastRun.finishedAt;
  const hoursAgo = last ? (Date.now() - last) / 3600e3 : Infinity;
  if (hoursAgo < 30) { console.log(`Dati aggiornati ${hoursAgo.toFixed(1)} ore fa: tutto ok.`); return 0; }
  const w = readJSON('data/watchdog.json', {});
  if (w.lastNotified === today) { console.log('Avviso già inviato oggi.'); return 0; }
  const since = last ? `da ${Math.floor(hoursAgo / 24)} giorni e ${Math.round(hoursAgo % 24)} ore` : 'ancora';
  const msg = {
    title: 'GameLife Tracker: nessun aggiornamento dei prezzi',
    body: `Il computer con l'estensione non ha inviato dati ${since}. Accendi il Mac e apri Chrome: il controllo riparte da solo.` + (dashboardUrl() ? `\n\nDashboard: ${dashboardUrl()}` : ''),
    click: dashboardUrl() || 'https://www.gamelife.it/29-playstation-5',
  };
  const results = await GLNotify.sendAll(notifyConfig(settings), msg);
  addLog({ type: 'error', title: msg.title, body: msg.body, results });
  writeJSON('data/watchdog.json', { lastNotified: today });
  console.log('Avviso inviato:', JSON.stringify(results));
  return 0;
}

// ---------- main ----------
async function main(argv = process.argv.slice(2)) {
  const mode = argv.find(a => !a.startsWith('--')) || 'watchdog';
  const onlyId = (argv.find(a => a.startsWith('--id=')) || '').slice(5) || null;
  const settings = Object.assign({ checkHour: 9, timezone: 'Europe/Rome', pushEnabled: true }, readJSON('config/settings.json', {}));
  const { date: today } = nowParts(settings.timezone || 'Europe/Rome');

  if (mode === 'test') {
    const msg = { title: 'Notifica di prova GameLife Tracker', body: 'Se leggi questo messaggio, il canale funziona. Riceverai qui gli avvisi quando un titolo PS5 scende sotto il tuo prezzo obiettivo.' + (dashboardUrl() ? `\n\nDashboard: ${dashboardUrl()}` : ''), click: dashboardUrl() || 'https://www.gamelife.it/29-playstation-5' };
    const results = await GLNotify.sendAll(notifyConfig(settings), msg);
    addLog({ type: 'test', title: msg.title, body: msg.body, results });
    console.log('Prova:', JSON.stringify(results));
    return 0;
  }
  if (mode === 'alerts') {
    const hits = evaluateAlerts(onlyId);
    if (hits.length) await notifyHits(hits, settings);
    else console.log('Nessun avviso da inviare.');
    return 0;
  }
  // "watchdog" e le vecchie modalità "auto"/"full": la lettura del catalogo non avviene più da GitHub
  if (mode === 'full') console.log('La lettura del catalogo avviene dall\'estensione Chrome sul computer, non da GitHub.');
  return watchdog(settings, today);
}

module.exports = { main, evaluateAlerts, written };
if (require.main === module) {
  main().then((code) => {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${written.size > 0}\n`);
    process.exit(code);
  }, (e) => { console.error(e); process.exit(1); });
}
