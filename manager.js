// 🧊 GESTIONNAIRE MULTI-COMPTES : page web + un processus « bot » par ami (3 maximum par défaut)
// Chaque bot = ce même index.js lancé en mode BOT_WORKER, avec son numéro et son dossier de session.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const express = require('express');

const MAX = Math.max(1, parseInt(process.env.MAX_SESSIONS, 10) || 3);
const CODES = (process.env.CODES_PARRAINAGE || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
const DOSSIER = path.join(__dirname, 'sessions');
const REGISTRE = path.join(DOSSIER, 'registre.json');
const DELAI_JUMELAGE_MS = 4 * 60 * 1000;   // un code non saisi dans les 4 min libère la place
fs.mkdirSync(DOSSIER, { recursive: true });

const sessions = new Map();   // numéro -> { numero, parrainage, jeton, statut, codeJumelage, proc, essais, timer }
let registre = { parrainages: {}, numeros: [] };
try { registre = { ...registre, ...JSON.parse(fs.readFileSync(REGISTRE, 'utf8')) }; } catch (e) {}
const sauver = () => {
  registre.numeros = [...sessions.values()].filter(s => s.statut === 'connecte' || s.statut === 'reconnexion').map(s => s.numero);
  try { fs.writeFileSync(REGISTRE, JSON.stringify(registre)); } catch (e) {}
};

function liberer(s, effacer) {
  clearTimeout(s.timer);
  const proc = s.proc; s.proc = null;
  if (proc) { try { proc.kill('SIGTERM'); } catch (e) {} }
  sessions.delete(s.numero);
  if (effacer) try { fs.rmSync(path.join(DOSSIER, s.numero), { recursive: true, force: true }); } catch (e) {}
  sauver();
  console.log(`[GESTION] Place libérée : +${s.numero}`);
}

function analyser(s, ligne) {
  const m = ligne.match(/CODE DE JUMELAGE : ([A-Z0-9-]+)/i);
  if (m) { s.statut = 'code'; s.codeJumelage = m[1]; return; }
  if (ligne.includes('BOT PRÊT ET CONNECTÉ')) {
    s.statut = 'connecte'; s.codeJumelage = null; s.essais = 0; clearTimeout(s.timer); sauver();
    console.log(`[GESTION] +${s.numero} connecté`); return;
  }
  if (/jumelage initial a échoué|Demande de code échouée|PHONE_NUMBER absent|Session réinitialisée/.test(ligne)) liberer(s, true);
}

function lancer(s) {
  const dir = path.join(DOSSIER, s.numero);
  fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(process.execPath, ['--max-old-space-size=110', '--expose-gc', path.join(__dirname, 'index.js')], {
    env: { ...process.env, BOT_WORKER: '1', PHONE_NUMBER: s.numero, AUTH_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  s.proc = proc;
  for (const flux of [proc.stdout, proc.stderr]) readline.createInterface({ input: flux }).on('line', l => analyser(s, l));
  proc.on('exit', () => {
    if (s.proc !== proc) return;   // arrêt voulu
    s.proc = null;
    if (s.statut !== 'connecte' && s.statut !== 'reconnexion') return liberer(s, true);
    s.statut = 'reconnexion';
    if (++s.essais > 5) return liberer(s, false);
    setTimeout(() => { if (sessions.get(s.numero) === s) lancer(s); }, 5000 * s.essais);
  });
}

function creer(numero, parrainage, statut) {
  const s = { numero, parrainage, jeton: crypto.randomBytes(16).toString('hex'), statut, codeJumelage: null, proc: null, essais: 0, timer: null };
  sessions.set(numero, s);
  if (statut === 'demarrage') s.timer = setTimeout(() => { if (s.statut !== 'connecte') liberer(s, true); }, DELAI_JUMELAGE_MS);
  lancer(s);
  return s;
}

// Après un redémarrage : on relance les bots déjà jumelés
for (const numero of registre.numeros) {
  if (sessions.size < MAX && fs.existsSync(path.join(DOSSIER, numero, 'creds.json'))) creer(numero, null, 'reconnexion');
}

// 🚦 limite : 6 demandes / 10 min / adresse IP
const essaisIp = new Map();
const tropDEssais = (ip) => {
  const t = Date.now(), l = (essaisIp.get(ip) || []).filter(x => t - x < 600000);
  l.push(t); essaisIp.set(ip, l);
  return l.length > 6;
};

const etat = () => ({ total: MAX, occupees: sessions.size, disponibles: MAX - sessions.size, pleine: sessions.size >= MAX });

const app = express();
app.use(express.json({ limit: '2kb' }));
app.get('/health', (req, res) => res.send('OK'));
app.get('/api/etat', (req, res) => res.json(etat()));

app.post('/api/connecter', (req, res) => {
  if (tropDEssais(req.ip)) return res.status(429).json({ erreur: 'Trop d’essais. Réessaie dans quelques minutes.' });
  const numero = String((req.body && req.body.numero) || '').replace(/\D/g, '');
  const code = String((req.body && req.body.code) || '').trim().toUpperCase();
  if (!/^[1-9]\d{7,14}$/.test(numero)) return res.status(400).json({ erreur: 'Numéro invalide : indicatif du pays + numéro, sans + ni espaces.' });
  if (!CODES.length || !CODES.includes(code)) return res.status(403).json({ erreur: 'Code de parrainage invalide.' });

  const existant = sessions.get(numero);
  if (existant) return res.json({ jeton: existant.jeton, statut: existant.statut, codeJumelage: existant.codeJumelage });
  if (sessions.size >= MAX) return res.status(409).json({ erreur: 'pleines', ...etat() });

  const s = creer(numero, code, 'demarrage');
  sauver();
  res.json({ jeton: s.jeton, statut: s.statut, codeJumelage: null });
});

app.get('/api/statut', (req, res) => {
  const s = [...sessions.values()].find(x => x.jeton === req.query.jeton);
  if (!s) return res.status(404).json({ statut: 'perdu' });
  res.json({ statut: s.statut, codeJumelage: s.codeJumelage });
});

// 🔐 ADMIN : réservé au propriétaire, protégé par le mot de passe de la variable ADMIN_MOT_DE_PASSE
const ADMIN_MDP = (process.env.ADMIN_MOT_DE_PASSE || '').trim();
const empreinte = (x) => crypto.createHash('sha256').update(String(x)).digest();
const echecsAdmin = new Map();
function admin(req, res, next) {
  if (!ADMIN_MDP) return res.status(503).json({ erreur: 'ADMIN_MOT_DE_PASSE n’est pas défini sur Render.' });
  const t = Date.now(), l = (echecsAdmin.get(req.ip) || []).filter(x => t - x < 600000);
  if (l.length >= 8) return res.status(429).json({ erreur: 'Trop d’essais. Réessaie dans 10 minutes.' });
  const ok = crypto.timingSafeEqual(empreinte(req.headers['x-admin-key'] || ''), empreinte(ADMIN_MDP));
  if (!ok) { l.push(t); echecsAdmin.set(req.ip, l); return res.status(401).json({ erreur: 'Mot de passe incorrect.' }); }
  next();
}
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.post('/api/admin/liste', admin, (req, res) => res.json({
  ...etat(),
  sessions: [...sessions.values()].map(s => ({ numero: s.numero, statut: s.statut }))
}));
app.post('/api/admin/deconnecter', admin, (req, res) => {
  const s = sessions.get(String((req.body && req.body.numero) || ''));
  if (!s) return res.status(404).json({ erreur: 'Session introuvable.' });
  liberer(s, true);
  res.json({ ok: true, ...etat() });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const arreter = () => { for (const s of sessions.values()) { const p = s.proc; s.proc = null; try { p && p.kill('SIGTERM'); } catch (e) {} } process.exit(0); };
process.once('SIGTERM', arreter); process.once('SIGINT', arreter);

app.listen(process.env.PORT || 3000, () => console.log(`🧊 Gestionnaire actif · ${MAX} sessions max · ${CODES.length} code(s) de parrainage`));
