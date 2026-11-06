// Copia la dashboard web (cartella principale del repository) dentro app/www per l'app Android
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'www');
const FILES = ['index.html', 'app.css', 'app.js', 'gh.js', 'theme.js', 'splash.js', 'config.js', 'manifest.webmanifest'];
const DIRS = ['icons', 'vendor'];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { if (f === 'config.js') { console.error('Manca config.js: esegui prima l\'installatore.'); process.exit(1); } continue; }
  fs.copyFileSync(src, path.join(OUT, f));
}
for (const d of DIRS) fs.cpSync(path.join(ROOT, d), path.join(OUT, d), { recursive: true });
console.log('Dashboard copiata in app/www:', fs.readdirSync(OUT).join(', '));
