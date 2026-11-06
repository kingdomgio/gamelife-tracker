// GameLife Tracker — accesso ai dati e alle impostazioni sul repository GitHub
(function (root) {
  const CFG = root.GL_CONFIG || {};
  const LS_TOKEN = 'gl_token';
  const API = 'https://api.github.com';

  function detectRepo() {
    if (CFG.owner && CFG.repo) return { owner: CFG.owner, repo: CFG.repo, branch: CFG.branch || 'main' };
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (m && seg) return { owner: m[1], repo: seg, branch: 'main' };
    return { owner: '', repo: '', branch: 'main' };
  }
  const R = detectRepo();

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage non disponibile */ } },
  };
  let token = store.get(LS_TOKEN) || '';

  const utf8ToB64 = (s) => { const b = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); };

  async function api(path, { method = 'GET', body, accept, tk = token } = {}) {
    const headers = { 'Accept': accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (tk) headers.Authorization = 'Bearer ' + tk;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    if (r.status === 204) return null;
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const err = new Error(friendly(r.status, data && data.message));
      err.status = r.status; throw err;
    }
    return data;
  }
  function friendly(status, msg) {
    if (status === 401) return 'Token non valido o scaduto: ricollega il dispositivo.';
    if (status === 403 && /rate limit/i.test(msg || '')) return 'Troppe richieste a GitHub: riprova tra qualche minuto.';
    if (status === 403) return 'Il token non ha i permessi necessari (' + (msg || 'accesso negato') + ').';
    if (status === 404) return 'Non trovato (controlla repository e permessi del token).';
    return 'GitHub: ' + (msg || ('errore ' + status));
  }
  const repoPath = (p) => `/repos/${R.owner}/${R.repo}${p}`;

  // Lettura di un file JSON del repository (sempre aggiornato con token, altrimenti dalla copia pubblica)
  async function readJSON(path, def) {
    try {
      if (token) {
        const txt = await api(repoPath(`/contents/${path}?ref=${R.branch}`), { accept: 'application/vnd.github.raw+json' });
        return typeof txt === 'string' ? JSON.parse(txt) : (txt ?? def);
      }
      const urls = [`https://raw.githubusercontent.com/${R.owner}/${R.repo}/${R.branch}/${path}?t=${Date.now()}`, `./${path}?t=${Date.now()}`];
      for (const u of urls) {
        try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) return await r.json(); if (r.status === 404) return def; } catch { /* prova la successiva */ }
      }
      return def;
    } catch (e) { if (e.status === 404) return def; throw e; }
  }

  // Scrittura di un file JSON (con gestione dei conflitti). mutate(valoreAttuale) → nuovo valore
  async function updateJSON(path, mutate, message) {
    for (let i = 0; i < 4; i++) {
      let sha, cur = {};
      try {
        const meta = await api(repoPath(`/contents/${path}?ref=${R.branch}`));
        sha = meta.sha;
        cur = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(meta.content.replace(/\n/g, '')), c => c.charCodeAt(0))) || '{}');
      } catch (e) { if (e.status !== 404) throw e; }
      const next = mutate(cur);
      try {
        await api(repoPath(`/contents/${path}`), { method: 'PUT', body: { message, content: utf8ToB64(JSON.stringify(next, null, 2) + '\n'), sha, branch: R.branch } });
        return next;
      } catch (e) { if (e.status !== 409 && e.status !== 422) throw e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
    }
    throw new Error('Salvataggio non riuscito: riprova.');
  }

  async function listSecrets() { const d = await api(repoPath('/actions/secrets?per_page=100')); return (d.secrets || []).map(s => s.name); }
  async function setSecret(name, value) {
    const pk = await api(repoPath('/actions/secrets/public-key'));
    await api(repoPath(`/actions/secrets/${name}`), { method: 'PUT', body: { encrypted_value: root.GLSeal.encryptSecret(value, pk.key), key_id: pk.key_id } });
  }
  async function deleteSecret(name) { try { await api(repoPath(`/actions/secrets/${name}`), { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; } }

  async function dispatch(mode, id) {
    const inputs = { mode }; if (id) inputs.id = id;
    await api(repoPath('/actions/workflows/tracker.yml/dispatches'), { method: 'POST', body: { ref: R.branch, inputs } });
  }
  async function runs(n = 5) { const d = await api(repoPath(`/actions/workflows/tracker.yml/runs?per_page=${n}`)); return d.workflow_runs || []; }

  async function connect(tk) {
    tk = tk.trim();
    const repo = await api(repoPath(''), { tk });
    if (!repo.permissions || !repo.permissions.push) throw new Error('Il token può leggere ma non modificare il repository: dagli il permesso "Contents: Read and write".');
    token = tk; store.set(LS_TOKEN, tk);
    return repo;
  }
  function disconnect() { token = ''; store.set(LS_TOKEN, null); }

  root.GH = { repo: R, readJSON, updateJSON, listSecrets, setSecret, deleteSecret, dispatch, runs, connect, disconnect, store, get connected() { return !!token; }, api, repoPath };
})(window);
