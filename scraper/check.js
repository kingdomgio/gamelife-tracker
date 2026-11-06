#!/usr/bin/env node
// GameLife Tracker (cloud) — controllo prezzi giochi PS5 su gamelife.it
// Uso: node scraper/check.js [auto|full|alerts|test] [--browser]
//   auto   → esegue il controllo completo solo se oggi non è ancora stato fatto e l'orario scelto è passato
//   full   → controllo completo immediato
//   alerts → solo verifica degli avvisi sui dati già salvati (dopo aver salvato un nuovo prezzo obiettivo)
//   test   → invia una notifica di prova su tutti i canali configurati
// Codice di uscita 42 = GameLife ha bloccato la richiesta semplice: il workflow riprova con un browser vero.
const fs = require('fs');
const path = require('path');
const GLParser = require('../parser.js');
const GLNotify = require('./notify.js');

const ROOT = process.env.GL_ROOT || path.join(__dirname, '..');
const BASE = process.env.GL_BASE || 'https://www.gamelife.it';
const CATEGORY = BASE + '/29-playstation-5';
const PAGE_DELAY_MS = +(process.env.GL_DELAY_MS ?? 1200);
const STATUS_CODE = { available: 2, last_units: 1, unavailable: 0 };
const BLOCKED_EXIT = 42;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// ---------- download pagine ----------
class Blocked extends Error {}
const looksBlocked = (status, html) => status === 403 || status === 503 || status === 429 ||
  /Just a moment|cf-chl|challenge-platform|Attention Required/i.test(html.slice(0, 20000)) && !/products_grid/.test(html);

function makeFetcher() {
  return {
    async get(url) {
      let lastErr;
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.6' } });
          const html = await r.text();
          if (looksBlocked(r.status, html)) throw new Blocked('GameLife ha bloccato la richiesta (HTTP ' + r.status + ')');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          if (!/oe_product|products_grid/.test(html)) throw new Error('Pagina inattesa');
          return html;
        } catch (e) { lastErr = e; if (e instanceof Blocked && i >= 1) break; await sleep(2500 * (i + 1)); }
      }
      throw lastErr;
    },
    async close() {},
  };
}

async function makeBrowserFetcher() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ locale: 'it-IT', timezoneId: 'Europe/Rome', userAgent: UA, viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  return {
    async get(url) {
      let lastErr;
      for (let i = 0; i < 3; i++) {
        try {
          const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForSelector('#products_grid, .oe_product', { timeout: 30000 });
          const html = await page.content();
          if (!/oe_product|products_grid/.test(html)) throw new Error('Pagina inattesa (HTTP ' + (resp && resp.status()) + ')');
          return html;
        } catch (e) { lastErr = e; await sleep(4000 * (i + 1)); }
      }
      throw new Blocked('GameLife non risponde nemmeno con il browser: ' + (lastErr && lastErr.message || lastErr).split('\n')[0]);
    },
    async close() { await browser.close(); },
  };
}

// ---------- aggiornamento dati ----------
function pointOf(p, ts) {
  return [ts, p.new ? p.new.price : null, p.new ? STATUS_CODE[p.new.status] : null, p.used ? p.used.price : null, p.used ? STATUS_CODE[p.used.status] : null];
}
const samePoint = (a, b) => a && b && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];
const minOf = (a, b) => a == null ? b : b == null ? a : Math.min(a, b);
const maxOf = (a, b) => a == null ? b : b == null ? a : Math.max(a, b);

function upsert(products, history, p, ts) {
  const prev = products[p.id];
  const pt = pointOf(p, ts);
  const h = history[p.id] || (history[p.id] = []);
  if (!samePoint(h[h.length - 1], pt)) h.push(pt);
  products[p.id] = {
    id: p.id, name: p.name, url: p.url, img: p.img, sku: p.sku, preorder: p.preorder,
    new: p.new, used: p.used,
    firstSeen: prev ? prev.firstSeen : ts, lastSeen: ts, gone: false,
    minNew: minOf(prev && prev.minNew, p.new && p.new.price), maxNew: maxOf(prev && prev.maxNew, p.new && p.new.price),
    minUsed: minOf(prev && prev.minUsed, p.used && p.used.price), maxUsed: maxOf(prev && prev.maxUsed, p.used && p.used.price),
  };
}

async function fullCheck({ browser, settings, today }) {
  const state = readJSON('data/state.json', {});
  const products = readJSON('data/products.json', {});
  const history = readJSON('data/history.json', {});
  const ts = Math.floor(Date.now() / 1000);
  const started = Date.now();
  const isFirstRunEver = !state.lastRun;
  const fetcher = browser ? await makeBrowserFetcher() : makeFetcher();
  const seen = new Set();
  let maxPage = 1, errors = 0;
  try {
    for (let page = 1; page <= maxPage; page++) {
      let res;
      try {
        res = GLParser.parseCategoryPage(await fetcher.get(page === 1 ? CATEGORY : `${CATEGORY}/page/${page}`));
      } catch (e) {
        if (page === 1) throw e;
        errors++; res = { products: [] };
      }
      if (page === 1) maxPage = Math.max(1, res.maxPage || 1);
      for (const p of res.products) { upsert(products, history, p, ts); seen.add(p.id); }
      if (process.stdout.isTTY || process.env.CI) console.log(`Pagina ${page}/${maxPage}: ${res.products.length} titoli`);
      if (page < maxPage) await sleep(PAGE_DELAY_MS);
    }
  } finally { await fetcher.close(); }
  if (seen.size === 0) throw new Error('Nessun titolo letto: la struttura del sito potrebbe essere cambiata');
  if (errors > Math.max(3, maxPage * 0.2)) throw new Error(`${errors} pagine su ${maxPage} non lette: controllo annullato per non salvare dati incompleti`);
  let gone = 0;
  if (errors === 0 && seen.size > 50) {
    for (const id of Object.keys(products)) {
      if (!seen.has(id) && !products[id].gone) {
        products[id].gone = true;
        (history[id] || (history[id] = [])).push([ts, null, null, null, null]);
        gone++;
      }
    }
  }
  const newTitles = isFirstRunEver ? 0 : [...seen].filter(id => products[id].firstSeen === ts).length;
  if (isFirstRunEver) state.firstRunTs = ts;
  state.lastRun = { date: today, startedAt: started, finishedAt: Date.now(), count: seen.size, pages: maxPage, errors, newTitles, gone, browser: !!browser };
  state.lastError = null; state.failCount = 0;
  // se è servito il browser, per una settimana si parte direttamente da lì (più veloce)
  state.preferBrowserUntil = browser ? ts + 7 * 86400 : null;
  writeJSON('data/products.json', products);
  writeJSON('data/history.json', history);
  writeJSON('data/state.json', state, true);
  return state.lastRun;
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

// ---------- main ----------
async function main(argv = process.argv.slice(2)) {
  const mode = argv.find(a => !a.startsWith('--')) || 'auto';
  const browser = argv.includes('--browser');
  const onlyId = (argv.find(a => a.startsWith('--id=')) || '').slice(5) || null;
  const settings = Object.assign({ checkHour: 9, timezone: 'Europe/Rome', pushEnabled: true }, readJSON('config/settings.json', {}));
  const { date: today, hour } = nowParts(settings.timezone || 'Europe/Rome');

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
  if (mode === 'auto') {
    const state = readJSON('data/state.json', {});
    const done = state.lastRun && state.lastRun.date === today;
    if (done || hour < (+settings.checkHour || 0)) { console.log(`Niente da fare (oggi ${done ? 'già controllato' : 'prima delle ' + settings.checkHour + ':00'}).`); return 0; }
  }
  // full (o auto quando è il momento)
  if (!browser) {
    const st = readJSON('data/state.json', {});
    if (st.preferBrowserUntil && st.preferBrowserUntil > Date.now() / 1000) { console.log('Uso direttamente il browser.'); return BLOCKED_EXIT; }
  }
  try {
    const run = await fullCheck({ browser, settings, today });
    console.log(`Controllo completato: ${run.count} titoli, ${run.pages} pagine, ${run.errors} errori.`);
    const hits = evaluateAlerts();
    if (hits.length) await notifyHits(hits, settings);
    return 0;
  } catch (e) {
    if (e instanceof Blocked && !browser) { console.log('Richiesta bloccata, riprovo con il browser: ' + e.message); return BLOCKED_EXIT; }
    const state = readJSON('data/state.json', {});
    state.lastError = { ts: Date.now(), message: String(e && e.message || e) };
    state.failCount = (state.failCount || 0) + 1;
    addLog({ type: 'error', title: 'Controllo non riuscito', body: state.lastError.message });
    // un solo avviso di errore al giorno, per non riempirti di messaggi
    if (state.lastErrorNotified !== today) {
      state.lastErrorNotified = today;
      await GLNotify.sendAll(notifyConfig(settings), { title: 'GameLife Tracker: controllo non riuscito', body: `Oggi non sono riuscito a leggere il catalogo: ${state.lastError.message}\nRiprovo automaticamente ogni ora.` + (dashboardUrl() ? `\n\nDashboard: ${dashboardUrl()}` : ''), click: dashboardUrl() || CATEGORY }).catch(() => {});
    }
    writeJSON('data/state.json', state, true);
    console.error('Errore:', state.lastError.message);
    return 1;
  }
}

module.exports = { main, evaluateAlerts, written };
if (require.main === module) {
  main().then((code) => {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${written.size > 0}\n`);
    process.exit(code);
  }, (e) => { console.error(e); process.exit(1); });
}
