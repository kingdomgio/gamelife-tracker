// GameLife Tracker — animazione di apertura (app Android, app installata, prima visita della sessione)
(function () {
  const C = window.Capacitor;
  const native = !!(C && (typeof C.isNativePlatform === 'function' ? C.isNativePlatform() : C.platform && C.platform !== 'web'));
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let seen = false;
  try { seen = sessionStorage.getItem('gl_intro') === '1'; } catch { /* storage non disponibile */ }
  const noop = { ready() {} };
  if (!native && !standalone && seen) { window.GLIntro = noop; return; }
  try { sessionStorage.setItem('gl_intro', '1'); } catch { /* ok */ }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vb = (document.querySelector('.brand-logo') || {}).getAttribute ? document.querySelector('.brand-logo').getAttribute('viewBox') : '0 0 603 504';
  const logo = (cls) => `<svg class="${cls}" viewBox="${vb}" aria-hidden="true"><use class="p-g" href="#lg-g"/><use class="p-bar" href="#lg-bar"/><use class="p-t" href="#lg-t"/></svg>`;
  const parts = Array.from({ length: 16 }, (_, i) => {
    const ang = (-160 + (140 / 15) * i + (Math.random() * 10 - 5)) * Math.PI / 180;
    const dist = 90 + Math.random() * 120;
    return `<i style="--dx:${(Math.cos(ang) * dist).toFixed(0)}px;--dy:${(Math.sin(ang) * dist).toFixed(0)}px;--r:${(Math.random() * 360).toFixed(0)}deg;animation-delay:${(1.05 + Math.random() * .12).toFixed(2)}s;${Math.random() > .6 ? 'width:5px;height:5px;' : ''}"></i>`;
  }).join('');
  const segs = Array.from({ length: 10 }, (_, i) => `<b style="animation-delay:${(0.75 + i * 0.13).toFixed(2)}s"></b>`).join('');

  const el = document.createElement('div');
  el.className = 'intro';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="grid"></div>
    <div class="beam"></div>
    <div class="stage">
      <div class="logo-wrap">
        ${logo('logo')}
        <div class="glitch">${logo('ga')}${logo('gb')}</div>
        <div class="particles">${parts}</div>
      </div>
      <div class="loader">${segs}</div>
      <div class="label">PS5 · Price Tracker</div>
    </div>
    <div class="flash"></div>
    <div class="scan"></div>
    <div class="skip">Tocca per continuare</div>
    <div class="wipe"></div>`;
  document.body.appendChild(el);
  document.documentElement.style.overflow = 'hidden';

  let ready = false, minDone = false, leaving = false;
  const MIN = reduce ? 700 : 2400;
  function leave() {
    if (leaving) return; leaving = true;
    el.classList.add('exit');
    document.documentElement.style.overflow = '';
    if (reduce) { setTimeout(() => el.remove(), 320); return; }
    setTimeout(() => el.classList.add('reveal'), 300);   // a metà passaggio dell'arancione si scopre l'app
    setTimeout(() => el.remove(), 680);
  }
  const maybe = () => { if (ready && minDone) leave(); };
  setTimeout(() => { minDone = true; maybe(); }, MIN);
  setTimeout(() => { ready = true; maybe(); }, 7000);        // non aspettare mai più di 7 secondi
  el.addEventListener('pointerdown', () => { ready = minDone = true; maybe(); });
  window.GLIntro = { ready() { ready = true; maybe(); } };
})();
