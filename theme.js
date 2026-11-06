// GameLife Tracker — tema chiaro / scuro / automatico (segue il dispositivo)
(function () {
  const KEY = 'gl_theme';
  const ORDER = ['auto', 'light', 'dark'];
  const LABEL = { auto: 'Tema: automatico', light: 'Tema: chiaro', dark: 'Tema: scuro' };
  const ICON = {
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
  };
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const get = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };
  const resolved = (p) => (p === 'auto' ? (mq.matches ? 'dark' : 'light') : p);

  function apply(p) {
    const root = document.documentElement;
    if (p === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', p);
    const dark = resolved(p) === 'dark';
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = dark ? '#1a1a19' : '#fcfcfb';
    // barre di sistema dell'app Android: icone chiare su fondo scuro e viceversa
    try { const sb = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SystemBars; if (sb) sb.setStyle({ style: dark ? 'DARK' : 'LIGHT' }); } catch { /* non in app */ }
    const btn = document.getElementById('themeBtn');
    if (btn) { btn.innerHTML = ICON[p]; btn.title = LABEL[p] + ' (tocca per cambiare)'; btn.setAttribute('aria-label', LABEL[p]); }
    document.querySelectorAll('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeSet === p)));
    document.dispatchEvent(new CustomEvent('gl-theme', { detail: { pref: p, dark } }));
  }
  function set(p) {
    try { if (p === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); } catch { /* storage non disponibile */ }
    apply(p);
  }
  mq.addEventListener('change', () => { if (get() === 'auto') apply('auto'); });

  function bind() {
    apply(get());
    const btn = document.getElementById('themeBtn');
    if (btn) btn.addEventListener('click', () => set(ORDER[(ORDER.indexOf(get()) + 1) % ORDER.length]));
    document.querySelectorAll('[data-theme-set]').forEach(b => b.addEventListener('click', () => set(b.dataset.themeSet)));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
  window.GLTheme = { get, set, resolved };
})();
