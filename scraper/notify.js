// GameLife Tracker (cloud) — invio notifiche: push/email (ntfy), Telegram, WhatsApp (CallMeBot)
const fmtEUR = (n) => n == null ? '—' : new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n);
const LABEL = { new: 'Nuovo', used: 'Usato' };
const STATUS_TXT = { available: 'disponibile', last_units: 'ultimi pezzi', unavailable: 'non disponibile' };
const statusText = (st, preorder) => (preorder && st !== 'unavailable') ? 'prenotabile' : (STATUS_TXT[st] || '—');

// hits: [{product, cond:'new'|'used', price, target, status}]
function buildMessage(hits, { max = 12, dashboardUrl = '' } = {}) {
  const title = hits.length === 1
    ? `Prezzo obiettivo raggiunto: ${hits[0].product.name}`
    : `${hits.length} titoli PS5 sotto il tuo prezzo obiettivo`;
  const lines = hits.slice(0, max).map(h =>
    `• ${h.product.name} — ${LABEL[h.cond]} ${fmtEUR(h.price)} (obiettivo ${fmtEUR(h.target)}, ${statusText(h.status, h.product.preorder)})\n  ${h.product.url}`);
  if (hits.length > max) lines.push(`…e altri ${hits.length - max} titoli: apri la dashboard per vederli tutti.`);
  if (dashboardUrl) lines.push(`\nDashboard: ${dashboardUrl}`);
  return { title, body: lines.join('\n'), click: hits.length === 1 ? hits[0].product.url : (dashboardUrl || 'https://www.gamelife.it/29-playstation-5') };
}

async function sendNtfy(cfg, msg, { push, email }) {
  if (!cfg.ntfyTopic) throw new Error('canale ntfy mancante');
  const payload = { topic: cfg.ntfyTopic, title: msg.title, message: msg.body, click: msg.click, tags: ['video_game'], priority: 4 };
  if (email) payload.email = email;
  // senza push: invio solo email su un sotto-canale, così l'app ntfy non riceve nulla
  if (!push) payload.topic = cfg.ntfyTopic + '-mail';
  const r = await fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify(payload) });
  if (!r.ok) throw new Error('ntfy HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
}

async function sendTelegram(cfg, msg) {
  const text = `🎮 ${msg.title}\n\n${msg.body}`;
  for (let i = 0; i < text.length; i += 3900) {
    const r = await fetch(`https://api.telegram.org/bot${cfg.telegramToken.trim()}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: text.slice(i, i + 3900), disable_web_page_preview: true })
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error('Telegram: ' + (j.description || ('HTTP ' + r.status)));
  }
}

async function sendWhatsApp(cfg, msg) {
  const text = `*${msg.title}*\n\n${msg.body}`.slice(0, 1500);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(cfg.whatsappPhone.replace(/\s+/g, ''))}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(cfg.whatsappKey)}`;
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok || (/error|invalid/i.test(t.slice(0, 400)) && !/queued|sent/i.test(t))) throw new Error('WhatsApp: ' + t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160));
}

// cfg: {pushEnabled, ntfyTopic, email, telegramToken, telegramChatId, whatsappPhone, whatsappKey}
// Ritorna {canale: 'ok' | 'errore: …'} — non contiene mai i valori dei segreti
async function sendAll(cfg, msg) {
  const tasks = [];
  const email = (cfg.email || '').trim();
  const push = !!cfg.pushEnabled && !!cfg.ntfyTopic;
  if (push || (email && cfg.ntfyTopic)) tasks.push([push && email ? 'Push + Email' : push ? 'Push' : 'Email', () => sendNtfy(cfg, msg, { push, email })]);
  if (cfg.telegramToken && cfg.telegramChatId) tasks.push(['Telegram', () => sendTelegram(cfg, msg)]);
  if (cfg.whatsappPhone && cfg.whatsappKey) tasks.push(['WhatsApp', () => sendWhatsApp(cfg, msg)]);
  const res = {};
  const secrets = [cfg.telegramToken, cfg.whatsappKey, cfg.ntfyTopic, cfg.email].filter(Boolean);
  const scrub = (s) => secrets.reduce((acc, v) => acc.split(v).join('***'), String(s));
  for (const [name, fn] of tasks) {
    try { await fn(); res[name] = 'ok'; } catch (e) { res[name] = 'errore: ' + scrub(e && e.message || e); }
  }
  if (!tasks.length) res['—'] = 'nessun canale configurato';
  return res;
}

module.exports = { buildMessage, sendAll, fmtEUR, statusText };
