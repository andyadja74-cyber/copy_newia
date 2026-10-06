// ⚡ FIX CRYPTO POUR RENDER & BAILEYS
const crypto = require('crypto');
if (!globalThis.crypto) globalThis.crypto = crypto;

const fs = require('fs');
const path = require('path');
const express = require("express");
const https = require("https");
const axios = require("axios"); 

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// Importation des données depuis data.js[span_1](start_span)[span_1](end_span)
const data = require('./data');

const {
  REPONSES_8BALL,
  COMMENTAIRES_LOVE,
  CONSEILS_LOVE,
  MOTS_AMOUR_PRIVE,
  REPONSE_AMOUR_MAMAN,
  VERDICTS_MENSONGE,
  MOTS_SQUID,
  DONNEES_CERVEAU,
  COMMENTAIRES_CERVEAU,
  CHEMINS_LABYRINTHE,
  LISTE_DRAGUES,
  SUBS_LABYRINTHE,
  partiesEnCours,
  timersInactivite,
  vueUniqueCache,
  sessionsMotDePasse,
  profilsJoueurs,
  membresSalues,
  sessionsMaman
} = data;

const app = express();
const PORT = process.env.PORT || 3000;

// Anti-doublons & Cache Anti-Delete & Mutes
const processedMessages = new Set();
const messageCache = {}; 
const utilisateursMutes = new Set();
// 🔒 Mode privé : personnes déjà prévenues (le bot ne le dit qu'une fois) + compteur de commandes pour .fiche
const refusPriveDeja = new Set();
const statsCommandes = {};

// ═══════════════════════════════════════════════════════════
// 🧰 OUTILS GÉNÉRAUX
// ═══════════════════════════════════════════════════════════
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alea = (tab) => tab[Math.floor(Math.random() * tab.length)];
const entierAlea = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const melanger = (tab) => {
  const t = [...tab];
  for (let i = t.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
};
const nomAffiche = (jid) => profilsJoueurs[jid] || `@${jid.split('@')[0]}`;
const UA = 'TitanBot/1.0 (bot WhatsApp personnel)';

// ⏱️ Délai entre deux phrases de drague (modifiable avec la variable Render DRAGUE_DELAI_MS)
const DELAI_DRAGUE_MS = parseInt(process.env.DRAGUE_DELAI_MS, 10) || 8000;
// 🚦 Anti-spam : une commande par utilisateur toutes les 2,5 secondes
const COOLDOWN_COMMANDE_MS = 2500;
const dernieresCommandes = new Map();

// 🖼️ Images des menus (fichier menu-images.js : 4 images en base64)
const MENU_IMAGES = (() => {
  try {
    return require('./menu-images').map(b => Buffer.from(b, 'base64'));
  } catch (e) {
    console.error('⚠️ menu-images.js introuvable : les menus seront envoyés sans image.');
    return [];
  }
})();

let dernierIndexImageMenu = -1;
function choisirImageMenu(cat) {
  if (!MENU_IMAGES.length) return null;
  // Menu d'une catégorie : menu 1 → image 1, menu 2 → image 2, etc.
  if (typeof cat === 'number') return MENU_IMAGES[cat % MENU_IMAGES.length];
  // Accueil du menu : image au hasard (jamais deux fois la même d'affilée)
  let i;
  do { i = Math.floor(Math.random() * MENU_IMAGES.length); }
  while (MENU_IMAGES.length > 1 && i === dernierIndexImageMenu);
  dernierIndexImageMenu = i;
  return MENU_IMAGES[i];
}

process.on('uncaughtException', (err) => console.error('⚠️️ Erreur évitée :', err));
process.on('unhandledRejection', (reason) => console.error('⚠️ Promesse rejetée :', reason));

app.get("/", (req, res) => res.send("⚡ TITAN BOT GROUPE EN LIGNE"));
app.get("/health", (req, res) => res.status(200).send("OK"));

app.listen(PORT, () => console.log(`🌐 Serveur actif sur le port ${PORT}`));

setInterval(() => {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (renderUrl) {
    https.get(renderUrl, (res) => console.log(`⏰ Keep-Alive Status: ${res.statusCode}`))
        .on('error', (err) => console.error('⚠️ Erreur Keep-Alive :', err.message));
  }
}, 5 * 60 * 1000);

// 📁 GESTIONNAIRE DE SESSION LOCAL
// Plan gratuit Render : pas de disque persistant, on utilise toujours le dossier local (la variable AUTH_DIR est ignorée)
const AUTH_DIR = path.join(__dirname, 'auth_info');
async function getAuthState() {
  console.log(`📁 Utilisation du stockage local (${AUTH_DIR})...`);
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  return {
    state,
    saveCreds,
    clearSession: async () => {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
    }
  };
}

function reinitialiserJeu(groupId) {
  if (partiesEnCours[groupId]) {
    if (partiesEnCours[groupId].timerFeu) clearTimeout(partiesEnCours[groupId].timerFeu);
    if (partiesEnCours[groupId].timerBombe) clearTimeout(partiesEnCours[groupId].timerBombe);
    if (timersInactivite[groupId]) clearTimeout(timersInactivite[groupId]);
    delete partiesEnCours[groupId];
    delete timersInactivite[groupId];
  }
}

function demarrerTimerInactivite(sock, groupId) {
  if (timersInactivite[groupId]) clearTimeout(timersInactivite[groupId]);
  timersInactivite[groupId] = setTimeout(async () => {
    if (partiesEnCours[groupId]) {
      reinitialiserJeu(groupId);
      await envoyerAvecDelai(sock, groupId, { 
        text: "🧹 *SESSION EXPIRÉE :* bon😮‍💨 je m'en vais parceque tu veux plus m'utiliser💔 bye 😭" 
      }, {}, 'texte');
    }
  }, 3 * 60 * 1000);
}

// ⏱️ SIMULATION DE FRAPPE HUMAINE RÉALISTE (FAÇON "NUMI" / HUMAIN NORMAL SUR LES RÉSEAUX)
function calculerDelaiEnvoi(texte, typeAction = 'texte') {
  if (typeAction === 'media' || typeAction === 'qr') {
    return 3000; 
  }

  const longueur = texte ? texte.length : 20;
  // Vitesse de frappe proportionnelle au nombre de caractères (~55ms par caractère)
  let delaiMs = longueur * 55; 
  
  if (delaiMs < 4500) delaiMs = 4500; // Minimum 4.5 secondes pour que ça fasse naturel
  if (delaiMs > 20000) delaiMs = 20000; // Plafond à 20 secondes pour les très longs textes

  // Ajout d'une variation aléatoire pour imiter parfaitement un humain qui tape et hésite
  return Math.floor(delaiMs + (Math.random() * 2500));
}

// 🧵 FILE D'ATTENTE PAR CONVERSATION : un seul message à la fois par chat (comme un humain)
const filesEnvoi = new Map();
function enFile(remoteJid, tache) {
  const precedent = filesEnvoi.get(remoteJid) || Promise.resolve();
  const suivante = precedent.catch(() => {}).then(tache);
  const marqueur = suivante.catch(() => {});
  filesEnvoi.set(remoteJid, marqueur);
  marqueur.then(() => { if (filesEnvoi.get(remoteJid) === marqueur) filesEnvoi.delete(remoteJid); });
  return suivante;
}

// 👤 PRÉSENCE HUMAINE : "en ligne" quand il répond, puis "hors ligne" après un moment d'inactivité
let timerHorsLigne = null;
async function passerEnLigne(sock) {
  try { await sock.sendPresenceUpdate('available'); } catch (e) {}
  if (timerHorsLigne) clearTimeout(timerHorsLigne);
  timerHorsLigne = setTimeout(async () => {
    try { await sock.sendPresenceUpdate('unavailable'); } catch (e) {}
  }, entierAlea(40000, 90000));
}

// ✍️ COMPOSING CONTINU : "en train d'écrire…" affiché tant que la réponse n'est pas partie
// (relancé toutes les 4 s car WhatsApp l'éteint tout seul ; coupe-circuit de sécurité à 45 s)
const composingActifs = new Map();
function demarrerComposing(sock, jid) {
  const existant = composingActifs.get(jid);
  if (existant) {
    clearTimeout(existant.securite);
    existant.securite = setTimeout(() => arreterComposing(sock, jid), 45000);
    return;
  }
  const envoyer = async () => { try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {} };
  envoyer();
  const intervalle = setInterval(envoyer, 4000);
  const securite = setTimeout(() => arreterComposing(sock, jid), 45000);
  composingActifs.set(jid, { intervalle, securite });
}
function arreterComposing(sock, jid) {
  const c = composingActifs.get(jid);
  if (!c) return;
  clearInterval(c.intervalle);
  clearTimeout(c.securite);
  composingActifs.delete(jid);
  sock.sendPresenceUpdate('paused', jid).catch(() => {});
}

// 🛡️ Fonction d'envoi sécurisée : lecture du message (coches bleues), "en train d'écrire…", puis envoi
async function envoyerAvecDelai(sock, remoteJid, content, options = {}, typeAction = 'texte') {
  return enFile(remoteJid, async () => {
    try {
      const texte = typeof content === 'string' ? content : (content.text || content.caption || "");
      const delaiMs = calculerDelaiEnvoi(texte, typeAction);

      await passerEnLigne(sock);

      // ✍️ "En train d'écrire…" dès le début, sans coupure, jusqu'à l'arrivée du message
      demarrerComposing(sock, remoteJid);

      // Un humain lit d'abord le message avant de répondre
      if (options.quoted && options.quoted.key) {
        await sleep(entierAlea(600, 1800));
        try { await sock.readMessages([options.quoted.key]); } catch (e) {}
      }

      await sleep(delaiMs);

      const sentMsg = await sock.sendMessage(remoteJid, content, options);
      if (sentMsg && sentMsg.key && sentMsg.key.id) {
        processedMessages.add(sentMsg.key.id);
      }
      return sentMsg;
    } catch (err) {
      console.error("⚠ Erreur d'envoi :", err);
    } finally {
      arreterComposing(sock, remoteJid);
    }
  });
}

function genererBarreHP(hp, maxHp = 100) {
  const totalBlocs = 10;
  const blocsRemplis = Math.max(0, Math.min(totalBlocs, Math.round((hp / maxHp) * totalBlocs)));
  const blocsVides = totalBlocs - blocsRemplis;
  return `[${'█'.repeat(blocsRemplis)}${'░'.repeat(blocsVides)}] ${hp}/${maxHp}`;
}

// 👁️ ═══════════════════════════════════════════════════════════
// VUE UNIQUE — PHOTOS, VIDÉOS ET VOCAUX (module dédié)
// ═══════════════════════════════════════════════════════════
const baileysLib = require('@whiskeysockets/baileys');
const VU_AUTO = (process.env.VUE_UNIQUE_AUTO || 'on').trim().toLowerCase() !== 'off';
const VU_DEST = (process.env.VUE_UNIQUE_DEST || 'chat').trim().toLowerCase();
const VU_DEBUG = ['1', 'true', 'on'].includes((process.env.VU_DEBUG || '').trim().toLowerCase());
const VU_MAX_CACHE = 10; // moins d'éléments gardés car les vidéos pèsent lourd en mémoire
const VU_MAX_OCTETS = 60 * 1024 * 1024; // au-delà, on ignore le fichier (protège la RAM de Render)
const VU_LABELS = { image: { emoji: '📸', nom: 'photo' }, video: { emoji: '🎬', nom: 'vidéo' }, audio: { emoji: '🎙️', nom: 'vocal' } };
const vuDejaVus = new Set();
const vuOrdre = [];

function deballerMessage(message) {
  let content = message;
  let viewOnce = false;
  const chemin = [];
  for (let i = 0; i < 6 && content; i++) {
    const kvo = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'].find(k => content[k]);
    if (kvo) { viewOnce = true; chemin.push(kvo); content = content[kvo].message; continue; }
    const kautre = ['ephemeralMessage', 'documentWithCaptionMessage', 'editedMessage'].find(k => content[k]);
    if (kautre) { chemin.push(kautre); content = content[kautre].message; continue; }
    break;
  }
  return { content, viewOnce, chemin };
}

function analyserMedia(message) {
  const { content, viewOnce, chemin } = deballerMessage(message);
  if (!content) return { type: null, media: null, viewOnce, chemin, aCle: false };
  for (const [cle, type] of [['imageMessage', 'image'], ['videoMessage', 'video'], ['audioMessage', 'audio']]) {
    const media = content[cle];
    if (media) {
      return {
        type, media,
        viewOnce: viewOnce || media.viewOnce === true,
        chemin: [...chemin, cle],
        aCle: !!(media.mediaKey && (media.directPath || media.url))
      };
    }
  }
  return { type: null, media: null, viewOnce, chemin: [...chemin, ...Object.keys(content).slice(0, 3)], aCle: false };
}

function resumerStructure(a) {
  return `${a.chemin.join(' > ') || '(vide)'} | vue unique : ${a.viewOnce ? 'oui' : 'non'} | données de téléchargement : ${a.aCle ? 'oui' : 'non'}`;
}

async function telechargerMedia(sock, media, type, cleMsg) {
  const cleType = { image: 'imageMessage', video: 'videoMessage', audio: 'audioMessage' }[type];
  let derniere;
  for (let i = 1; i <= 2; i++) {
    try {
      const stream = await downloadContentFromMessage(media, type);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) throw new Error('fichier vide');
      return buffer;
    } catch (e) {
      derniere = e;
      if (i < 2) await new Promise(r => setTimeout(r, 1200));
    }
  }
  if (typeof baileysLib.downloadMediaMessage === 'function' && cleMsg) {
    try {
      const buffer = await baileysLib.downloadMediaMessage(
        { key: cleMsg, message: { [cleType]: media } },
        'buffer',
        {},
        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
      );
      if (buffer && buffer.length) return buffer;
    } catch (e) {
      derniere = e;
    }
  }
  throw derniere;
}

function memoriserVueUnique(idMsg, chatJid, objet) {
  if (!idMsg) return;
  vueUniqueCache[idMsg] = objet;
  vueUniqueCache['dernier:' + chatJid] = idMsg;
  vuOrdre.push(idMsg);
  while (vuOrdre.length > VU_MAX_CACHE) {
    delete vueUniqueCache[vuOrdre.shift()];
  }
}

function lireTimestamp(t) {
  const n = (t && typeof t === 'object' && typeof t.toNumber === 'function') ? t.toNumber() : Number(t);
  return n ? n * 1000 : Date.now();
}

// Contenu Baileys selon le type (un vocal n'a pas de légende : on envoie le texte à part)
function contenuMedia(cache, texte) {
  const mentions = cache.expediteur ? [cache.expediteur] : [];
  if (cache.type === 'video') return { video: cache.buffer, caption: texte, mimetype: cache.mimetype || 'video/mp4', mentions };
  if (cache.type === 'audio') return { audio: cache.buffer, mimetype: cache.mimetype || 'audio/ogg; codecs=opus', ptt: cache.ptt !== false };
  return { image: cache.buffer, caption: texte, mentions };
}

async function envoyerMediaCache(sock, cible, cache, texte, options = {}) {
  let res;
  if (cache.type === 'audio') {
    const mentions = cache.expediteur ? [cache.expediteur] : [];
    const r1 = await sock.sendMessage(cible, { text: texte, mentions }, options);
    if (r1 && r1.key && r1.key.id) processedMessages.add(r1.key.id);
  }
  res = await sock.sendMessage(cible, contenuMedia(cache, texte), cache.type === 'audio' ? {} : options);
  if (res && res.key && res.key.id) processedMessages.add(res.key.id);
  return res;
}

async function traiterVueUnique(sock, msg) {
  if (!msg) return;
  if (!msg.message) {
    if (VU_DEBUG) console.log(`[VU-DEBUG] message sans contenu lisible de ${(msg.key && (msg.key.participant || msg.key.remoteJid)) || '?'}`);
    return;
  }
  if (msg.key && msg.key.fromMe) return;

  const a = analyserMedia(msg.message);
  if (VU_DEBUG && a.type) console.log(`[VU-DEBUG] ${resumerStructure(a)}`);
  if (!a.type || !a.viewOnce) return;
  const idMsg = msg.key.id;
  if (vuDejaVus.has(idMsg)) return;
  vuDejaVus.add(idMsg);
  if (vuDejaVus.size > 500) vuDejaVus.clear();

  const chatJid = msg.key.remoteJid;
  const expediteur = msg.key.participant || chatJid;
  if (utilisateursMutes.has(expediteur)) return;

  const lab = VU_LABELS[a.type];
  const taille = Number(a.media.fileLength) || 0;
  if (taille > VU_MAX_OCTETS) {
    console.log(`[VU] ⚠️ ${lab.nom} ignorée : trop lourde (${Math.round(taille / 1048576)} Mo)`);
    return;
  }

  console.log(`[VU] ${lab.emoji} Vue unique (${lab.nom}) détectée de ${expediteur} dans ${chatJid} — téléchargement…`);
  let buffer;
  try {
    buffer = await telechargerMedia(sock, a.media, a.type, { remoteJid: chatJid, id: idMsg, participant: msg.key.participant, fromMe: false });
  } catch (e) {
    console.error(`[VU] ❌ Téléchargement impossible : ${e && e.message ? e.message : e} (clé de téléchargement présente : ${a.aCle ? 'oui' : 'non'})`);
    return;
  }
  console.log(`[VU] ✅ ${lab.nom} récupérée (${buffer.length} octets)`);

  const fdate = new Date(lireTimestamp(msg.messageTimestamp)).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
  const cache = { buffer, type: a.type, mimetype: a.media.mimetype, ptt: a.media.ptt, caption: a.media.caption || '', fdate, expediteur };
  memoriserVueUnique(idMsg, chatJid, cache);
  if (!VU_AUTO) return;

  const nom = profilsJoueurs[expediteur] || `@${expediteur.split('@')[0]}`;
  const texte = `🚨👀 *VUE UNIQUE INTERCEPTÉE PAR TITAN !* ${lab.emoji}\n👤 *Envoyée par :* ${nom}\n📅 *Date :* ${fdate}${cache.caption ? `\n📝 *Légende :* ${cache.caption}` : ''}\n✨ _Aucune cachette possible ici 😈_`;
  const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  const cible = VU_DEST === 'moi' ? botNumber : chatJid;

  try {
    await envoyerMediaCache(sock, cible, cache, texte, cible === chatJid ? { quoted: msg } : {});
    console.log(`[VU] 📤 ${lab.nom} renvoyée automatiquement`);
  } catch (e) {
    console.error(`[VU] ⚠️ Envoi avec citation échoué : ${e && e.message ? e.message : e}`);
    try {
      await envoyerMediaCache(sock, cible, cache, texte, {});
    } catch (e2) {
      console.error(`[VU] ❌ Envoi impossible : ${e2 && e2.message ? e2.message : e2}`);
    }
  }
}

async function commandeVueUnique(sock, msg, remoteJid) {
  const { content } = deballerMessage(msg.message);
  const ctx = content && content.extendedTextMessage && content.extendedTextMessage.contextInfo;
  const idCite = ctx && ctx.stanzaId;
  const citee = ctx && ctx.quotedMessage;
  const repondre = (texte) => envoyerAvecDelai(sock, remoteJid, { text: texte }, { quoted: msg }, 'texte');

  let cache = idCite ? vueUniqueCache[idCite] : null;

  if (!cache && citee) {
    const a = analyserMedia(citee);
    if (a.type && a.aCle) {
      try {
        const buffer = await telechargerMedia(sock, a.media, a.type, { remoteJid, id: idCite, participant: ctx.participant, fromMe: false });
        cache = { buffer, type: a.type, mimetype: a.media.mimetype, ptt: a.media.ptt, caption: a.media.caption || '', fdate: null, expediteur: ctx.participant || null };
        memoriserVueUnique(idCite, remoteJid, cache);
      } catch (e) {
        console.error(`[VU] ❌ .v : téléchargement du média cité impossible : ${e && e.message ? e.message : e}`);
      }
    }
  }

  if (!cache && !citee) cache = vueUniqueCache[vueUniqueCache['dernier:' + remoteJid]];

  if (!cache) {
    console.log(`[VU] .v demandé mais rien en mémoire (cité : ${citee ? 'oui' : 'non'}, photos gardées : ${vuOrdre.length})`);
    await repondre(citee
      ? "⚠️ Je n'ai pas intercepté ce média (il est arrivé avant que je le voie, ou le bot a redémarré)."
      : "⚠️ Je n'ai aucune vue unique (photo, vidéo ou vocal) en mémoire pour ce chat.");
    return;
  }

  const nom = cache.expediteur ? (profilsJoueurs[cache.expediteur] || `@${cache.expediteur.split('@')[0]}`) : null;
  const texte = `🔓 *VUE UNIQUE RÉCUPÉRÉE* 🥷${nom ? `\n👤 *Envoyée par :* ${nom}` : ''}`;
  if (cache.type === 'audio') {
    await envoyerAvecDelai(sock, remoteJid, { text: texte, mentions: cache.expediteur ? [cache.expediteur] : [] }, { quoted: msg }, 'texte');
    await envoyerAvecDelai(sock, remoteJid, contenuMedia(cache, texte), {}, 'media');
  } else {
    await envoyerAvecDelai(sock, remoteJid, contenuMedia(cache, texte), { quoted: msg }, 'media');
  }
}

function installerVueUnique(sock) {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await traiterVueUnique(sock, msg);
      } catch (e) {}
    }
  });
}

// 📥 ═══════════════════════════════════════════════════════════
// YOUTUBE → VIDÉO (MP4) OU AUDIO (MP3) via yt-dlp
// ═══════════════════════════════════════════════════════════
const { spawn, spawnSync } = require('child_process');
const os = require('os');

const YT_DIR = path.join(os.tmpdir(), 'titan-yt');
const YT_MAX_OCTETS = (parseInt(process.env.YT_MAX_MO, 10) || 60) * 1024 * 1024;   // taille max envoyée
const YT_MAX_DUREE_S = parseInt(process.env.YT_MAX_DUREE_S, 10) || 1200;            // durée max : 20 min
const YT_MAX_HAUTEUR = parseInt(process.env.YT_MAX_HAUTEUR, 10) || 720;             // qualité vidéo max
const YT_COOKIES = (process.env.YT_COOKIES_FILE || '').trim();                      // optionnel (anti-blocage YouTube)
const YT_ATTENTE_MS = 2 * 60 * 1000;
const ytAttente = new Map();   // "chat|expéditeur" -> { url, expire }
let ytOccupe = false;          // un seul téléchargement à la fois (CPU / RAM limités)

// 🔧 ───────────────────────────────────────────────────────────
// BINAIRES : yt-dlp et ffmpeg sont trouvés ou INSTALLÉS AUTOMATIQUEMENT
// (le bot ne dépend plus du Dockerfile : ça marche aussi sur Render "Node")
// ───────────────────────────────────────────────────────────────
const BIN_DIR = path.join(__dirname, 'bin');
const YTDLP_LOCAL = path.join(BIN_DIR, 'yt-dlp');
const YTDLP_FRAICHEUR_MS = 12 * 60 * 60 * 1000;   // on re-télécharge la dernière version toutes les 12 h
const bin = { ytdlp: null, ffmpeg: null };
let preparationBinaires = null;

function commandeOk(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 30000 });
    return r.status === 0;
  } catch (e) { return false; }
}

function trouverFfmpeg() {
  const env = (process.env.FFMPEG_PATH || '').trim();
  if (env && commandeOk(env, ['-version'])) return env;
  if (commandeOk('ffmpeg', ['-version'])) return 'ffmpeg';
  try {
    const p = require('ffmpeg-static');   // ffmpeg embarqué via npm (voir package.json)
    if (p && commandeOk(p, ['-version'])) return p;
  } catch (e) {}
  return null;
}

function nomBinaireYtDlp() {
  const arm = process.arch === 'arm64';
  const musl = fs.existsSync('/lib/ld-musl-x86_64.so.1') || fs.existsSync('/lib/ld-musl-aarch64.so.1');
  if (musl) return arm ? 'yt-dlp_musllinux_aarch64' : 'yt-dlp_musllinux';
  return arm ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

async function telechargerYtDlp() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = YTDLP_LOCAL + '.part';
  // 1) binaire autonome (aucune dépendance) ; 2) à défaut, script Python (nécessite python3)
  for (const nom of [nomBinaireYtDlp(), 'yt-dlp']) {
    try {
      console.log(`[YT] ⬇️ Installation de yt-dlp (${nom})…`);
      const rep = await axios.get(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${nom}`, {
        responseType: 'stream', timeout: 90000, maxRedirects: 8, headers: { 'User-Agent': UA }
      });
      await new Promise((ok, ko) => {
        const w = fs.createWriteStream(tmp);
        rep.data.on('error', ko);
        w.on('error', ko);
        w.on('finish', ok);
        rep.data.pipe(w);
      });
      fs.chmodSync(tmp, 0o755);
      if (!commandeOk(tmp, ['--version'])) throw new Error('le fichier téléchargé ne démarre pas');
      fs.renameSync(tmp, YTDLP_LOCAL);
      console.log('[YT] ✅ yt-dlp installé');
      return YTDLP_LOCAL;
    } catch (e) {
      console.error(`[YT] ⚠️ Installation de ${nom} impossible : ${e && e.message ? e.message : e}`);
      try { fs.unlinkSync(tmp); } catch (e2) {}
    }
  }
  return null;
}

function preparerBinaires() {
  if (preparationBinaires) return preparationBinaires;
  preparationBinaires = (async () => {
    bin.ffmpeg = trouverFfmpeg();

    const imposé = (process.env.YTDLP_PATH || '').trim();
    if (imposé && commandeOk(imposé, ['--version'])) {
      bin.ytdlp = imposé;
    } else {
      const present = fs.existsSync(YTDLP_LOCAL);
      const frais = present && (Date.now() - fs.statSync(YTDLP_LOCAL).mtimeMs) < YTDLP_FRAICHEUR_MS;
      if (frais && commandeOk(YTDLP_LOCAL, ['--version'])) bin.ytdlp = YTDLP_LOCAL;
      else bin.ytdlp = await telechargerYtDlp()
        || (present && commandeOk(YTDLP_LOCAL, ['--version']) ? YTDLP_LOCAL : null)
        || (commandeOk('yt-dlp', ['--version']) ? 'yt-dlp' : null);
    }
    console.log(`[YT] yt-dlp : ${bin.ytdlp || 'INTROUVABLE'} | ffmpeg : ${bin.ffmpeg || 'INTROUVABLE'}`);
    if (!bin.ytdlp) preparationBinaires = null;   // on réessaiera à la prochaine commande
  })();
  return preparationBinaires;
}
preparerBinaires().catch(e => console.error('[YT] ⚠️ Préparation des binaires :', e && e.message ? e.message : e));

function extraireLienYoutube(texte) {
  const m = (texte || '').match(/https?:\/\/[^\s]+/i);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    const hote = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    if (hote === 'youtube.com' || hote === 'youtu.be') return u.href;
  } catch (e) {}
  return null;
}

function lancerYtDlp(args, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    try { await preparerBinaires(); } catch (e) {}
    if (!bin.ytdlp) return reject(new Error('YTDLP_ABSENT'));
    const base = ['--no-warnings', '--no-playlist', '--js-runtimes', `node:${process.execPath}`,
      '--cache-dir', path.join(os.tmpdir(), 'yt-dlp-cache')];
    if (bin.ffmpeg && bin.ffmpeg !== 'ffmpeg') base.push('--ffmpeg-location', bin.ffmpeg);
    if (YT_COOKIES && fs.existsSync(YT_COOKIES)) base.push('--cookies', YT_COOKIES);
    const proc = spawn(bin.ytdlp, [...base, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const minuteur = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('TIMEOUT')); }, timeoutMs);
    proc.stdout.on('data', d => { out += d; if (out.length > 5e6) out = out.slice(-5e6); });
    proc.stderr.on('data', d => { err += d; if (err.length > 2e4) err = err.slice(-2e4); });
    proc.on('error', e => { clearTimeout(minuteur); reject(e.code === 'ENOENT' ? new Error('YTDLP_ABSENT') : e); });
    proc.on('close', code => {
      clearTimeout(minuteur);
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `yt-dlp code ${code}`));
    });
  });
}

function messageErreurYoutube(e) {
  const m = (e && e.message) || '';
  if (m === 'YTDLP_ABSENT') return "⚠️ yt-dlp n'a pas pu être installé sur le serveur (GitHub injoignable ?). Réessaie dans une minute.";
  if (m === 'FFMPEG_ABSENT') return "⚠️ ffmpeg est introuvable sur le serveur (lance `npm install` pour installer ffmpeg-static).";
  if (m === 'TIMEOUT') return '⏱️ Le téléchargement a pris trop de temps, réessaie avec une vidéo plus courte.';
  if (m === 'TROP_LONG') return `⚠️ Vidéo trop longue (maximum ${Math.round(YT_MAX_DUREE_S / 60)} min).`;
  if (m === 'TROP_LOURD') return `⚠️ Fichier trop lourd pour WhatsApp (maximum ${Math.round(YT_MAX_OCTETS / 1048576)} Mo). Essaie plutôt en MP3.`;
  if (/confirm you.?re not a bot|Sign in/i.test(m)) return "⚠️ YouTube bloque le serveur (détection anti-robot). Il faut ajouter un fichier de cookies (variable YT_COOKIES_FILE).";
  if (/Private video|unavailable|removed|not available|\bage\b|inappropriate/i.test(m)) return "⚠️ Cette vidéo est privée, indisponible ou réservée aux adultes.";
  return '⚠️ Impossible de télécharger cette vidéo pour le moment.';
}

async function telechargerYoutube(url, format) {
  fs.mkdirSync(YT_DIR, { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');

  // 1) infos (titre, durée) avant de télécharger quoi que ce soit
  const infos = JSON.parse(await lancerYtDlp(['--skip-download', '--dump-single-json', '--', url], 60000));
  if (infos.duration && infos.duration > YT_MAX_DUREE_S) throw new Error('TROP_LONG');

  // 2) téléchargement (ffmpeg obligatoire : conversion MP3 et fusion vidéo+audio)
  if (!bin.ffmpeg) throw new Error('FFMPEG_ABSENT');
  const modele = path.join(YT_DIR, `${id}.%(ext)s`);
  const args = ['-o', modele, '--max-filesize', `${Math.round(YT_MAX_OCTETS / 1048576)}M`];
  if (format === 'mp3') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5');
  } else {
    const h = YT_MAX_HAUTEUR;
    args.push('-f', `bv*[vcodec^=avc1][height<=${h}]+ba[ext=m4a]/b[ext=mp4][height<=${h}]/b[height<=${h}]`, '--merge-output-format', 'mp4');
  }
  await lancerYtDlp([...args, '--', url], 5 * 60 * 1000);

  const fichier = fs.readdirSync(YT_DIR).find(f => f.startsWith(id + '.') && (f.endsWith('.mp3') || f.endsWith('.mp4')));
  if (!fichier) throw new Error('fichier introuvable après téléchargement');
  const chemin = path.join(YT_DIR, fichier);
  if (fs.statSync(chemin).size > YT_MAX_OCTETS) { fs.unlink(chemin, () => {}); throw new Error('TROP_LOURD'); }
  return { chemin, titre: infos.title || 'YouTube', auteur: infos.uploader || '', duree: infos.duration || 0 };
}

function lienDepuisMessage(msg, argTexte) {
  let url = extraireLienYoutube(argTexte);
  if (url) return url;
  const { content } = deballerMessage(msg.message);
  const cite = content && content.extendedTextMessage && content.extendedTextMessage.contextInfo && content.extendedTextMessage.contextInfo.quotedMessage;
  if (cite) return extraireLienYoutube(cite.conversation || (cite.extendedTextMessage && cite.extendedTextMessage.text) || '');
  return null;
}

async function commandeYoutube(sock, msg, remoteJid, senderJid, cleanText) {
  const repondre = (texte) => envoyerAvecDelai(sock, remoteJid, { text: texte }, { quoted: msg }, 'texte');
  const [cmd, ...reste] = cleanText.trim().split(/\s+/);
  const commande = cmd.toLowerCase();
  const cle = `${remoteJid}|${senderJid}`;
  let url = lienDepuisMessage(msg, reste.join(' '));

  // .yt [lien] → on garde le lien en attente et on demande le format
  if (commande === '.yt') {
    if (!url) return repondre("📥 Envoie un lien YouTube :\n`.yt https://youtu.be/xxxx`\n(ou réponds à un message contenant le lien avec `.yt`)");
    ytAttente.set(cle, { url, expire: Date.now() + YT_ATTENTE_MS });
    return repondre("📥 *Que veux-tu ?*\n🎬 `.mp4` → la vidéo\n🎵 `.mp3` → le son seulement\n_(choix valable 2 minutes)_");
  }

  const format = commande === '.mp3' ? 'mp3' : 'mp4';
  if (!url) {
    const attente = ytAttente.get(cle);
    if (attente && attente.expire > Date.now()) url = attente.url;
  }
  if (!url) return repondre(`📥 Donne-moi un lien YouTube :\n\`${commande} https://youtu.be/xxxx\`\nou utilise d'abord \`.yt [lien]\``);
  ytAttente.delete(cle);

  if (ytOccupe) return repondre('⏳ Un téléchargement est déjà en cours, réessaie dans un instant.');
  ytOccupe = true;
  let fichier = null;
  try {
    await repondre(format === 'mp3' ? '🎵 Téléchargement du MP3 en cours…' : '🎬 Téléchargement de la vidéo en cours…');
    const r = await telechargerYoutube(url, format);
    fichier = r.chemin;
    const legende = `${format === 'mp3' ? '🎵' : '🎬'} *${r.titre}*${r.auteur ? `\n👤 ${r.auteur}` : ''}`;
    if (format === 'mp3') {
      await envoyerAvecDelai(sock, remoteJid, { text: legende }, { quoted: msg }, 'texte');
      await envoyerAvecDelai(sock, remoteJid, { audio: { url: fichier }, mimetype: 'audio/mpeg', ptt: false, fileName: `${r.titre}.mp3` }, {}, 'media');
    } else {
      await envoyerAvecDelai(sock, remoteJid, { video: { url: fichier }, caption: legende, mimetype: 'video/mp4' }, { quoted: msg }, 'media');
    }
  } catch (e) {
    console.error(`[YT] ❌ ${e && e.message ? e.message : e}`);
    await repondre(messageErreurYoutube(e));
  } finally {
    ytOccupe = false;
    if (fichier) fs.unlink(fichier, () => {});
  }
}

// 🎙️ ═══════════════════════════════════════════════════════════
// .voc [texte] → le bot répond en VOCAL avec une voix d'homme grave et posée
// (voix française de synthèse, puis ffmpeg : on baisse la hauteur et on ralentit)
// ═══════════════════════════════════════════════════════════
const VOC_MAX_CARACTERES = parseInt(process.env.VOC_MAX_CAR, 10) || 600;
// 1 = voix normale ; plus petit = plus grave (0.66 ≈ homme bien grave)
const VOC_GRAVE = Math.min(1, Math.max(0.55, parseFloat(process.env.VOC_GRAVE) || 0.66));
// 1 = vitesse normale ; plus petit = plus lent (0.85 = posé, bien compréhensible)
const VOC_VITESSE = Math.min(1.1, Math.max(0.6, parseFloat(process.env.VOC_VITESSE) || 0.85));
let vocOccupe = false;

// Coupe le texte en morceaux de ≤ 180 caractères (limite du service vocal), de préférence aux phrases
function decouperTexte(texte, max = 180) {
  const phrases = (texte.replace(/\s+/g, ' ').trim().match(/[^.!?;:]+[.!?;:]*/g) || [texte]).map(s => s.trim()).filter(Boolean);
  const morceaux = [];
  let courant = '';
  for (const p of phrases) {
    if ((courant + ' ' + p).trim().length <= max) { courant = (courant + ' ' + p).trim(); continue; }
    if (courant) morceaux.push(courant);
    courant = '';
    if (p.length <= max) { courant = p; continue; }
    let ligne = '';
    for (const mot of p.split(' ')) {
      if ((ligne + ' ' + mot).trim().length > max) { if (ligne) morceaux.push(ligne); ligne = mot.slice(0, max); }
      else ligne = (ligne + ' ' + mot).trim();
    }
    courant = ligne;
  }
  if (courant) morceaux.push(courant);
  return morceaux;
}

async function ttsGoogle(morceau) {
  const rep = await axios.get('https://translate.google.com/translate_tts', {
    params: { ie: 'UTF-8', client: 'tw-ob', tl: 'fr', q: morceau, total: 1, idx: 0, textlen: morceau.length },
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36', Referer: 'https://translate.google.com/' }
  });
  const buf = Buffer.from(rep.data);
  if (buf.length < 500) throw new Error('audio vide reçu du service vocal');
  return buf;
}

// Secours si le service en ligne est injoignable : espeak-ng (installé par le Dockerfile)
function ttsEspeak(texte) {
  return new Promise((resolve, reject) => {
    const p = spawn('espeak-ng', ['-v', 'fr+m3', '-s', '120', '--stdout', texte], { stdio: ['ignore', 'pipe', 'ignore'] });
    const morceaux = [];
    p.stdout.on('data', d => morceaux.push(d));
    p.on('error', reject);
    p.on('close', code => {
      const buf = Buffer.concat(morceaux);
      code === 0 && buf.length > 500 ? resolve(buf) : reject(new Error('espeak-ng indisponible'));
    });
  });
}

function lancerFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; if (err.length > 1e4) err = err.slice(-1e4); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(err) : reject(new Error(`ffmpeg code ${code} : ${err.trim().split('\n').pop()}`)));
  });
}

async function dureeAudioSecondes(chemin) {
  try {
    const infos = await lancerFfmpeg(['-i', chemin, '-f', 'null', '-']);
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(infos);
    if (m) return Math.max(1, Math.round(+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])));
  } catch (e) {}
  return 0;
}

// Texte → fichier .ogg (opus) à voix d'homme grave et lente
async function fabriquerVocalGrave(texte) {
  fs.mkdirSync(YT_DIR, { recursive: true });
  const id = 'voc-' + crypto.randomBytes(6).toString('hex');
  const entree = path.join(YT_DIR, id + '.in');
  const sortie = path.join(YT_DIR, id + '.ogg');
  try {
    let audio;
    try {
      const morceaux = [];
      for (const m of decouperTexte(texte)) morceaux.push(await ttsGoogle(m));
      audio = Buffer.concat(morceaux);
    } catch (e) {
      console.error(`[VOC] ⚠️ Service vocal en ligne indisponible (${e && e.message ? e.message : e}) → essai espeak-ng`);
      audio = await ttsEspeak(texte);
    }
    fs.writeFileSync(entree, audio);

    // baisser la hauteur (×VOC_GRAVE) tout en gardant la vitesse voulue, renforcer les basses, lisser le volume
    const tempo = Math.min(2, Math.max(0.5, VOC_VITESSE / VOC_GRAVE));
    const filtre = [
      'aresample=48000',
      `asetrate=${Math.round(48000 * VOC_GRAVE)}`,
      'aresample=48000',
      `atempo=${tempo.toFixed(3)}`,
      'bass=g=7:f=110:w=0.8',
      'lowpass=f=6500',
      'dynaudnorm=f=200:g=5',
      'alimiter=limit=0.92'
    ].join(',');
    await lancerFfmpeg(['-i', entree, '-vn', '-af', filtre, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '40k', '-f', 'ogg', sortie]);
    const buffer = fs.readFileSync(sortie);
    const secondes = await dureeAudioSecondes(sortie);
    return { buffer, secondes };
  } finally {
    fs.unlink(entree, () => {});
    fs.unlink(sortie, () => {});
  }
}

async function commandeVoc(sock, msg, remoteJid, cleanText) {
  const repondre = (texte) => envoyerAvecDelai(sock, remoteJid, { text: texte }, { quoted: msg }, 'texte');
  let texte = cleanText.replace(/^\.voc\s*/i, '').trim();

  // sans texte : on lit le message auquel on répond
  if (!texte) {
    const { content } = deballerMessage(msg.message);
    const cite = content && content.extendedTextMessage && content.extendedTextMessage.contextInfo && content.extendedTextMessage.contextInfo.quotedMessage;
    if (cite) texte = (cite.conversation || (cite.extendedTextMessage && cite.extendedTextMessage.text) || (cite.imageMessage && cite.imageMessage.caption) || '').trim();
  }

  if (!texte) return repondre("🎙️ Écris le mot ou la phrase à dire :\n`.voc bonjour tout le monde`\n(ou réponds à un message avec `.voc`)");
  if (texte.length > VOC_MAX_CARACTERES) return repondre(`⚠️ Texte trop long pour un vocal (maximum ${VOC_MAX_CARACTERES} caractères, tu en as ${texte.length}).`);
  if (vocOccupe) return repondre('⏳ Je prépare déjà un vocal, réessaie dans un instant.');

  vocOccupe = true;
  try {
    await preparerBinaires();
    if (!bin.ffmpeg) throw new Error('FFMPEG_ABSENT');
    const { buffer, secondes } = await fabriquerVocalGrave(texte);
    await envoyerAvecDelai(sock, remoteJid, {
      audio: buffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
      ...(secondes ? { seconds: secondes } : {})
    }, { quoted: msg }, 'media');
  } catch (e) {
    console.error(`[VOC] ❌ ${e && e.message ? e.message : e}`);
    arreterComposing(sock, remoteJid);
    await repondre(e && e.message === 'FFMPEG_ABSENT'
      ? messageErreurYoutube(e)
      : "⚠️ Je n'ai pas réussi à fabriquer le vocal pour le moment, réessaie dans un instant.");
  } finally {
    vocOccupe = false;
  }
}

// 📚 REGISTRE DES COMMANDES
const CATEGORIES_MENU = [
  {
    id: 'identite', emoji: '🏷️', titre: 'Identité & Compte',
    cmds: [
      { noms: ['.inscrire'], args: '[Nom]', desc: 'Enregistrer ton pass VIP' },
      { noms: ['.pseudo'], args: '[Nom]', desc: 'Customiser ton blaze' },
      { noms: ['.fiche', '.rang'], desc: 'Consulter ta carte & ton grade' }
    ]
  },
  {
    id: 'moderation', emoji: '🛡️', titre: 'Modération', note: 'Réservé aux admins & au bot',
    cmds: [
      { noms: ['.kick'], args: '[@mention]', desc: 'Expulser un membre', admin: true },
      { noms: ['.promote'], args: '[@mention]', desc: 'Promouvoir admin', admin: true },
      { noms: ['.demote'], args: '[@mention]', desc: 'Rétrograder un admin', admin: true },
      { noms: ['.warn'], args: '[@mention] [raison]', desc: 'Avertir un membre', admin: true },
      { noms: ['.mute'], args: '[@mention]', desc: "Bloquer l'accès au bot à un membre", admin: true },
      { noms: ['.unmute'], args: '[@mention]', desc: "Débloquer l'accès au bot", admin: true },
      { noms: ['.private on', '.private off'], exact: true, aff: '.private', args: 'on | off', desc: "Verrouiller / déverrouiller le bot", owner: true }
    ]
  },
  {
    id: 'outils', emoji: '🛠️', titre: 'Outils & Tech',
    cmds: [
      { groupe: '📸 Médias', noms: ['.v'], desc: 'Revoir une photo / vidéo / vocal en vue unique' },
      { groupe: '📥 Téléchargement', noms: ['.yt'], args: '[lien YouTube]', desc: 'Choisir : vidéo (.mp4) ou audio (.mp3)' },
      { groupe: '📥 Téléchargement', noms: ['.mp3'], args: '[lien YouTube]', desc: 'Télécharger le son en MP3' },
      { groupe: '📥 Téléchargement', noms: ['.mp4'], args: '[lien YouTube]', desc: 'Télécharger la vidéo en MP4' },
      { groupe: '📸 Médias', noms: ['.pp', '.p'], aff: '.pp', args: '[@mention]', desc: "Photo de profil" },
      { groupe: '📸 Médias', noms: ['pipi'], args: '[@mention]', desc: "Photo de profil (pipi)" },
      { groupe: '📸 Médias', noms: ['.qr'], args: '[texte]', desc: 'Générer un QR code' },
      { groupe: '📸 Médias', noms: ['.image', '.img'], args: '[mot-clé]', desc: "Image sur n'importe quel sujet (Google / web)" },
      { groupe: '📸 Médias', noms: ['.imagine', '.gen'], aff: '.imagine', args: '[description]', desc: "Image créée par l'IA" },
      { groupe: '📸 Médias', noms: ['.voc'], args: '[texte]', desc: "Je dis ton texte en vocal (voix d'homme grave)" },
      { groupe: '🌐 Utilitaires', noms: ['.translate', '.trad'], args: '[lang] [texte]', desc: 'Traduire un texte' },
      { groupe: '🌐 Utilitaires', noms: ['.dico', '.def', '.dictionnaire'], aff: '.dico', args: '[mot]', desc: 'Dictionnaire en ligne' },
      { groupe: '🌐 Utilitaires', noms: ['ret'], args: '[phrase] (nombre)', desc: 'Répéter une phrase', test: t => t.startsWith('ret ') },
      { groupe: '🎭 Fun & Social', noms: ['.8ball'], args: '[question]', desc: 'Boule de cristal' },
      { groupe: '🎭 Fun & Social', noms: ['.love'], args: '[@mention] [@mention]', desc: "Test d'amour" },
      { groupe: '🎭 Fun & Social', noms: ['.mariage'], args: '[@mention]', desc: 'Épouser quelqu\'un' },
      { groupe: '🎭 Fun & Social', noms: ['.divorce'], exact: true, desc: 'Divorcer' },
      { groupe: '🎭 Fun & Social', noms: ['.confession'], args: '[texte]', desc: 'Confession anonyme' },
      { groupe: '🎭 Fun & Social', noms: ['.cerveau', 'cerveau'], aff: '.cerveau', args: '[@mention]', desc: "Scanner l'activité mentale", test: t => /^\.?(cerveau|mox)(\s|$)/.test(t) },
      { groupe: '🎭 Fun & Social', noms: ['.hack'], args: '[@mention]', desc: "Simulation de hack (groupe & privé)" },
      { groupe: '🎭 Fun & Social', noms: ['.balance'], args: '[@mention]', desc: 'Jauge Ange ou Démon' },
      { groupe: '🎭 Fun & Social', noms: ['.dec', '.mensonge'], args: '[texte]', desc: 'Détecteur de mensonges' },
      { groupe: '🎭 Fun & Social', noms: ['drague', '.drague'], aff: 'drague', args: '[@mention] (nombre)', desc: 'Phrases de drague (1 toutes les 8 s)' }
    ]
  },
  {
    id: 'jeux', emoji: '🎮', titre: 'Zone de Combat (Jeux)',
    cmds: [
      { noms: ['.bombe'], exact: true, desc: 'Désamorçage tactique' },
      { noms: ['.de'], exact: true, desc: 'Le jet de dés' },
      { noms: ['.lab'], args: '[solo|duo|equipe]', desc: 'Labyrinthe' },
      { noms: ['.feurouge'], exact: true, desc: 'Squid Game' },
      { noms: ['.chiffremystere'], exact: true, desc: 'Chiffre mystère' },
      { noms: ['.pf', '.pileouface'], exact: true, aff: '.pf', desc: 'Pile ou face' }
    ]
  },
  {
    id: 'equipe', emoji: '⚙️', titre: "Gestion d'Équipe",
    cmds: [
      { noms: ['.joindre'], args: '[A/B]', desc: 'Rejoindre une équipe' },
      { noms: ['.lancer'], exact: true, desc: 'Activer le protocole' },
      { noms: ['.restart'], exact: true, desc: 'Relancer le round' },
      { noms: ['.stop'], exact: true, desc: 'Couper la session' }
    ]
  }
];

const MENU_REGEX = /^(\.menu|menu|\.help|\.aide)(?:\s+(.+)|(\d+))?$/;
const NUM_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const EMOJIS_REACTION = ['🤬', '☠️', '👿', '🖕', '🤦', '🙅'];

function normaliserTexte(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function nbCommandes() {
  return CATEGORIES_MENU.reduce((n, c) => n + c.cmds.length, 0);
}

function estCommandeReconnue(texte) {
  const t = (texte || '').trim().toLowerCase();
  if (!t) return false;
  if (MENU_REGEX.test(t)) return true;
  for (const cat of CATEGORIES_MENU) {
    for (const c of cat.cmds) {
      if (c.test) { if (c.test(t)) return true; continue; }
      for (const nom of c.noms) {
        if (t === nom) return true;
        if (!c.exact && t.startsWith(nom + ' ')) return true;
      }
    }
  }
  return false;
}

async function reagirCommande(sock, msg) {
  try {
    const emoji = EMOJIS_REACTION[Math.floor(Math.random() * EMOJIS_REACTION.length)];
    const res = await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });
    if (res && res.key && res.key.id) processedMessages.add(res.key.id);
  } catch (e) {}
}

function dureeLisible(sec) {
  const m = Math.floor(sec / 60);
  if (m < 1) return "moins d'1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

function heureLocale() {
  const tz = process.env.BOT_TZ || 'Africa/Abidjan';
  const d = new Date();
  let heure = 12;
  try { heure = parseInt(new Intl.DateTimeFormat('fr-FR', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(d), 10); } catch (e) {}
  let date;
  try { date = d.toLocaleString('fr-FR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }); } catch (e) { date = d.toLocaleString('fr-FR'); }
  return { heure, date };
}

function salutation(heure) {
  if (heure >= 5 && heure < 12) return 'Bonjour';
  if (heure >= 12 && heure < 18) return 'Bon après-midi';
  return 'Bonsoir';
}

function afficherNomCommande(c) {
  return c.aff || c.noms.join(' / ');
}

function ligneCommande(c) {
  const badge = c.owner ? ' 👑' : (c.admin ? ' 🔒' : '');
  const args = c.args ? ` ${c.args}` : '';
  return `▫️ *${afficherNomCommande(c)}*${args}${badge}\n   ↳ ${c.desc}`;
}

function enTete(titre, lignes) {
  return `╭━━〔 ${titre} 〕━━╮\n${lignes.map(l => `┃ ${l}`).join('\n')}\n╰━━━━━━━━━━━━━━━━━━╯`;
}

function corpsCategorie(cat) {
  const lignes = [];
  let groupe = null;
  for (const c of cat.cmds) {
    if (c.groupe && c.groupe !== groupe) { lignes.push(`\n*${c.groupe}*`); groupe = c.groupe; }
    lignes.push(ligneCommande(c));
  }
  return lignes.join('\n');
}

function legendeBadges(cmds) {
  const l = [];
  if (cmds.some(c => c.admin)) l.push('🔒 admin');
  if (cmds.some(c => c.owner)) l.push('👑 propriétaire');
  return l.length ? `\n\n_${l.join(' • ')}_` : '';
}

function menuHub(nom) {
  const { heure, date } = heureLocale();
  const ent = enTete('⚡ *TITAN BOT* ⚡', [
    `${salutation(heure)} *${nom}* 👋`,
    `🕒 ${date}`,
    data.botPrivateMode ? '🔒 Mode : *Privé*' : '🔓 Mode : *Public*',
    `⏱️ En ligne depuis : ${dureeLisible(process.uptime())}`,
    `📚 ${nbCommandes()} commandes • ${CATEGORIES_MENU.length} catégories`
  ]);
  const liste = CATEGORIES_MENU.map((cat, i) => `${NUM_EMOJIS[i] || `${i + 1}.`} ${cat.emoji} *${cat.titre}* · ${cat.cmds.length}`).join('\n');
  return `${ent}\n\n📂 *CATÉGORIES*\n${liste}`;
}

function menuCategorie(i) {
  const cat = CATEGORIES_MENU[i];
  const prev = ((i - 1 + CATEGORIES_MENU.length) % CATEGORIES_MENU.length) + 1;
  const next = ((i + 1) % CATEGORIES_MENU.length) + 1;
  const ent = enTete(`${cat.emoji} *${cat.titre.toUpperCase()}*`, [cat.note || `${cat.cmds.length} commande(s)`]);
  return `${ent}\n${corpsCategorie(cat)}${legendeBadges(cat.cmds)}\n\n↩️ *.menu* : accueil • ◀️ *.menu ${prev}* • ▶️ *.menu ${next}*`;
}

function menuTout(nom) {
  const blocs = CATEGORIES_MENU.map((cat, i) => `${NUM_EMOJIS[i] || `${i + 1}.`} ${cat.emoji} *${cat.titre.toUpperCase()}*${cat.note ? `\n_${cat.note}_` : ''}\n${corpsCategorie(cat)}`);
  const tous = CATEGORIES_MENU.reduce((acc, c) => acc.concat(c.cmds), []);
  return `${menuHub(nom).split('\n\n📂')[0]}\n\n${blocs.join('\n\n')}${legendeBadges(tous)}\n\n↩️ *.menu* : accueil`;
}

function menuCommande(cat, c) {
  const l = [`🔎 *${afficherNomCommande(c)}*`, `📂 Catégorie : ${cat.emoji} ${cat.titre}`, `📝 ${c.desc}`];
  const noms = c.noms.map(n => `*${n}*`).join(' • ');
  l.push(`⌨️ Utilisation : *${c.aff || c.noms[0]}*${c.args ? ` ${c.args}` : ''}`);
  if (c.noms.length > 1) l.push(`🔁 Noms reconnus : ${noms}`);
  if (c.owner) l.push('👑 Réservé au propriétaire du bot');
  else if (c.admin) l.push('🔒 Réservé aux admins & au bot');
  l.push('', '↩️ *.menu* : accueil');
  return l.join('\n');
}

// Retourne { texte, cat } : cat = numéro de la catégorie (0, 1, 2…) ou null pour l'accueil
function construireMenu(texte, nom) {
  const m = (texte || '').trim().toLowerCase().match(MENU_REGEX);
  if (!m) return null;
  const arg = normaliserTexte(m[2] || m[3] || '');

  if (!arg) return { texte: menuHub(nom), cat: null };
  if (['all', 'tout', 'tous', 'full'].includes(arg)) return { texte: menuTout(nom), cat: null };

  if (/^\d+$/.test(arg)) {
    const i = parseInt(arg, 10) - 1;
    if (i >= 0 && i < CATEGORIES_MENU.length) return { texte: menuCategorie(i), cat: i };
    return { texte: `❓ La catégorie *${arg}* n'existe pas.\n\n${menuHub(nom)}`, cat: null };
  }

  const iCat = CATEGORIES_MENU.findIndex(c => normaliserTexte(c.id) === arg || (arg.length >= 3 && normaliserTexte(c.titre).includes(arg)));
  if (iCat >= 0) return { texte: menuCategorie(iCat), cat: iCat };

  const sansPoint = arg.replace(/^\./, '');
  for (let ci = 0; ci < CATEGORIES_MENU.length; ci++) {
    const cat = CATEGORIES_MENU[ci];
    for (const c of cat.cmds) {
      if (c.noms.some(n => { const k = normaliserTexte(n).replace(/^\./, ''); return k === sansPoint || k.split(' ')[0] === sansPoint; })) {
        return { texte: menuCommande(cat, c), cat: ci };
      }
    }
  }
  return { texte: `❓ Je ne trouve ni catégorie ni commande « ${arg} ».\n\n${menuHub(nom)}`, cat: null };
}

// 🖼️ Envoie le menu avec son image (la légende WhatsApp est limitée : si le menu est trop long, image puis texte)
async function envoyerMenu(sock, remoteJid, msg, resultat) {
  const image = choisirImageMenu(resultat.cat);
  if (!image) {
    return envoyerAvecDelai(sock, remoteJid, { text: resultat.texte }, { quoted: msg }, 'menu');
  }
  if (resultat.texte.length <= 1000) {
    return envoyerAvecDelai(sock, remoteJid, { image, caption: resultat.texte }, { quoted: msg }, 'media');
  }
  await envoyerAvecDelai(sock, remoteJid, { image, caption: '⚡ *TITAN BOT* ⚡' }, { quoted: msg }, 'media');
  return envoyerAvecDelai(sock, remoteJid, { text: resultat.texte }, {}, 'media');
}

// ═══════════════════════════════════════════════════════════
// 🎯 CIBLE D'UNE COMMANDE (mention, message cité, ou la personne du chat privé)
// ═══════════════════════════════════════════════════════════
function trouverCible(msg, remoteJid, repliPrive = false) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (ctx?.mentionedJid?.length) return ctx.mentionedJid[0];
  if (ctx?.quotedMessage && ctx.participant) return ctx.participant;
  if (repliPrive && !remoteJid.endsWith('@g.us')) return remoteJid;
  return null;
}

function barre(pourcent, total = 10) {
  const pleins = Math.max(0, Math.min(total, Math.round((pourcent / 100) * total)));
  return `[${'█'.repeat(pleins)}${'░'.repeat(total - pleins)}] ${pourcent}%`;
}

// ═══════════════════════════════════════════════════════════
// 💍 MARIAGE & DIVORCE
// ═══════════════════════════════════════════════════════════
const mariages = new Map(); // jid -> { conjoint, ts, lieu }

const LIEUX_MARIAGE = [
  "sous le grand manguier du quartier 🥭", "dans un maquis, ambiance garantie 🍗", "au bord de la lagune 🌊",
  "au terrain de foot du quartier ⚽", "dans le groupe WhatsApp, devant tous les témoins 📱",
  "chez maman, avec sa bénédiction 🏠", "sur le toit d'un immeuble, vue sur la ville 🌇", "à la mairie du cœur 🏛️"
];
const CELEBRANTS = [
  "Maître Titan, officier d'état civil 🤖", "le chef du quartier 🧓", "le DJ de la cérémonie 🎧",
  "ton grand frère, très ému 🥹", "Maître Botti, avocat des cœurs brisés ⚖️"
];
const TEMOINS = [
  "le chat du voisin 🐈", "un vendeur d'alloco 🍌", "le gardien de l'immeuble 💂",
  "tout le groupe, venu pour la bouffe 🍛", "la tantie du coin, qui sait tout 👵"
];
const CADEAUX_MARIAGE = [
  "un ventilateur qui fait un peu de bruit 🌀", "un casier de jus de bissap 🧃", "une grande marmite 🍲",
  "12 paires de chaussettes 🧦", "un pagne assorti 👘", "un sachet de piment 🌶️",
  "un abonnement WiFi (le mot de passe est dans la cuisine) 📶"
];
const LUNES_DE_MIEL = [
  "Grand-Bassam 🏖️", "Assinie 🌴", "Yamoussoukro 🏛️", "San-Pédro 🌊", "Bouaké 🚌",
  "la cuisine, pour manger ensemble 🍽️", "le salon, parce que la caisse est vide 🛋️", "Paris (sur Google Maps) 🗼"
];
const DOMICILES = [
  "un studio avec WiFi 📶", "chez la belle-mère 👵 (courage)", "une chambre-salon sans clim 🥵",
  "une villa… dans vos rêves ✨", "un duplex sur Minecraft ⛏️"
];
const VOEUX = [
  "promet de partager le dernier morceau de poulet 🍗", "promet de répondre aux messages en moins de 3 jours 📱",
  "promet de ne jamais faire « vu » sans répondre 👀", "promet de ne jamais laisser l'autre sans crédit 🔋",
  "promet de supporter les ronflements 😴", "promet de ne pas commencer à manger sans l'autre 🍛"
];

const MOTIFS_DIVORCE = [
  "il/elle a mangé le dernier morceau de poulet 🍗", "« tu as vu mon message mais tu n'as pas répondu » 👀",
  "incompatibilité de forfait internet 📶", "ronflements niveau tracteur 🚜",
  "désaccord sur la sauce (graine ou arachide ?) 🥘", "il/elle a laissé la lumière allumée toute la nuit 💡",
  "trop de selfies, pas assez de câlins 🤳", "la belle-mère a gagné 👵"
];
const PARTAGE_BIENS = [
  "la télé revient à l'un, la télécommande à l'autre 📺", "chacun repart avec sa moitié de marmite 🍲",
  "la maison est vendue, le ventilateur est coupé en deux 🌀", "le chat choisit lui-même son camp 🐈",
  "tout est partagé… sauf les dettes, qui sont pour toi 💸"
];
const COMMENTAIRES_DIVORCE = [
  "C'était écrit, ça ne pouvait pas durer… 🥲", "Le groupe est en deuil pendant 3 minutes de silence 🕯️",
  "Le célibat t'accueille à bras ouverts 🤗", "Pas de panique, il y a encore du monde sur le marché 🛒",
  "Courage, la vie continue, et les repas aussi 🍛", "Même Cupidon n'a pas osé regarder 🙈"
];

async function commandeMariage(sock, msg, remoteJid, senderJid) {
  const rep = (texte, mentions = []) => envoyerAvecDelai(sock, remoteJid, { text: texte, mentions }, { quoted: msg }, 'texte');
  const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  const cible = trouverCible(msg, remoteJid, false);

  if (!cible) return rep("⚠️ Mentionne (ou réponds au message de) la personne que tu veux épouser !\nExemple : *.mariage @personne*");
  if (cible === senderJid) return rep("⚠️ Tu ne peux pas t'épouser toi-même ! L'amour de soi c'est bien, mais là c'est trop 🤣");
  if (cible === botNumber) return rep("🤖💔 Désolé, je suis déjà marié à mon code source. Dur dur la vie de bot…");

  const mien = mariages.get(senderJid);
  if (mien) {
    return rep(`🚫 *BIGAMIE DÉTECTÉE !* 🚨\n\nTu es déjà marié(e) avec ${nomAffiche(mien.conjoint)} depuis ${dureeLisible((Date.now() - mien.ts) / 1000)} !\nFais d'abord *.divorce* si tu veux changer 😏`, [mien.conjoint]);
  }
  const sien = mariages.get(cible);
  if (sien) {
    return rep(`🚫 ${nomAffiche(cible)} est déjà marié(e) avec ${nomAffiche(sien.conjoint)} !\nOn ne touche pas au mari/à la femme des autres 😤`, [cible, sien.conjoint]);
  }

  const score = entierAlea(50, 100);
  const tier = score >= 90 ? 'parfait' : (score >= 70 ? 'moyen' : 'faible');
  const verdict = alea(COMMENTAIRES_LOVE[tier]);
  const lieu = alea(LIEUX_MARIAGE);
  const { date } = heureLocale();

  mariages.set(senderJid, { conjoint: cible, ts: Date.now(), lieu });
  mariages.set(cible, { conjoint: senderJid, ts: Date.now(), lieu });

  const nomA = nomAffiche(senderJid);
  const nomB = nomAffiche(cible);
  const texte =
`💍━━━━━━━━━━━━━━━━💍
📜 *CERTIFICAT DE MARIAGE* 📜
💍━━━━━━━━━━━━━━━━💍

💑 *Les mariés :* ${nomA} ❤️ ${nomB}
📅 *Date :* ${date}
📍 *Lieu :* ${lieu}
🎤 *Célébrant :* ${alea(CELEBRANTS)}
👥 *Témoin :* ${alea(TEMOINS)}

💖 *Compatibilité :* ${barre(score)}
💬 *Verdict :* ${verdict}

🎁 *Cadeau de mariage :* ${alea(CADEAUX_MARIAGE)}
✈️ *Lune de miel :* ${alea(LUNES_DE_MIEL)}
🏠 *Domicile :* ${alea(DOMICILES)}
👶 *Enfants prévus :* ${entierAlea(0, 6)}

📝 *Vœux :*
• ${nomA} ${alea(VOEUX)}
• ${nomB} ${alea(VOEUX)}

💡 *Conseil du couple :* ${alea(CONSEILS_LOVE)}

🎉 _Vous pouvez embrasser… le bot en témoin !_ 🥂
_Pour divorcer : *.divorce*_`;
  return rep(texte, [senderJid, cible]);
}

async function commandeDivorce(sock, msg, remoteJid, senderJid) {
  const rep = (texte, mentions = []) => envoyerAvecDelai(sock, remoteJid, { text: texte, mentions }, { quoted: msg }, 'texte');
  const m = mariages.get(senderJid);
  if (!m) {
    return rep("🤨 Tu n'es marié(e) avec personne !\nOn ne divorce pas d'un mariage qui n'existe pas 😂\nEssaie *.mariage @personne* d'abord.");
  }
  const duree = dureeLisible((Date.now() - m.ts) / 1000);
  mariages.delete(senderJid);
  mariages.delete(m.conjoint);

  const nomA = nomAffiche(senderJid);
  const nomB = nomAffiche(m.conjoint);
  const texte =
`💔━━━━━━━━━━━━━━━━💔
⚖️ *DIVORCE PRONONCÉ* ⚖️
💔━━━━━━━━━━━━━━━━💔

👤 ${nomA} ✂️ ${nomB}
⏳ *Durée du mariage :* ${duree}
📍 *Marié(e)s :* ${m.lieu}

📋 *Motif :* ${alea(MOTIFS_DIVORCE)}
🏠 *Partage des biens :* ${alea(PARTAGE_BIENS)}
💸 *Pension :* ${entierAlea(1, 500) * 100} FCFA par mois (en nature, en poulet braisé 🍗)
🐈 *Garde du chat :* ${alea([nomA, nomB, 'partagée, une semaine chacun', 'le chat décide seul'])}

💬 *Commentaire du tribunal :* ${alea(COMMENTAIRES_DIVORCE)}

🔓 _Vous êtes tous les deux de nouveau célibataires !_`;
  return rep(texte, [senderJid, m.conjoint]);
}

// ═══════════════════════════════════════════════════════════
// 😈 HACK (animation par modification d'un seul message + rapport final)
// ═══════════════════════════════════════════════════════════
const ETAPES_HACK = [
  [8, "🔍 Scan des ports ouverts..."],
  [20, "🧱 Contournement du pare-feu..."],
  [33, "💉 Injection du script dans le téléphone..."],
  [47, "🌐 Interception de l'adresse IP..."],
  [60, "📱 Lecture des messages « Salut ça va ? » restés sans réponse..."],
  [74, "🖼️ Téléchargement de la galerie (97% de selfies, 3% de bouffe)..."],
  [88, "🔐 Déchiffrement du mot de passe..."],
  [100, "✅ ACCÈS OBTENU !"]
];
const APPAREILS_HACK = [
  "Téléphone à l'écran fissuré depuis 2019 📱", "Un Tecno qui chauffe plus qu'un fer à repasser 🔥",
  "Un iPhone… prêté par un ami 🍏", "Un Infinix avec 3 Go de mémoire pleine 🗂️",
  "Un Samsung qui redémarre tout seul 🔄", "Une calculatrice qui se prend pour un smartphone 🧮"
];
const POSITIONS_HACK = [
  "dans son lit, alors qu'il est midi 🛏️", "devant le frigo, pour la 5e fois 🧊", "aux toilettes avec son téléphone 🚽",
  "au maquis, en train de commander 🍗", "dans le groupe, à lire sans répondre 👀", "en train de chercher son chargeur 🔌"
];
const RECHERCHES_HACK = [
  "« comment répondre sans avoir l'air d'avoir lu »", "« recette alloco sans huile »", "« pourquoi mon crush me laisse en vu »",
  "« comment gagner de l'argent sans travailler »", "« est-ce que les poissons dorment ? »", "« comment effacer l'historique rapidement »"
];
const MOTS_DE_PASSE_HACK = [
  "123456 (sérieusement ?) 🤦", "motdepasse 🙃", "le prénom de son crush ❤️", "azerty 🎹",
  "ilovemyself 😎", "0000, comme son solde 💸"
];
const DERNIERS_MESSAGES_HACK = [
  "« je suis en route » (il est encore au lit) 🛌", "« je te rappelle » (jamais) 📞", "« c'est qui ? » à sa propre maman 🤣",
  "« envoie le numéro » (il l'a déjà) 🤡", "« je suis déjà arrivé » (il n'est pas sorti) 🚪"
];

async function commandeHack(sock, msg, remoteJid, senderJid, isGroup, cleanText) {
  const rep = (texte, mentions = []) => envoyerAvecDelai(sock, remoteJid, { text: texte, mentions }, { quoted: msg }, 'texte');
  const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  const args = cleanText.replace(/^\.hack\s*/i, '').replace(/@\d+/g, '').trim();
  const cibleJid = trouverCible(msg, remoteJid, true);

  if (!cibleJid && !args) {
    return rep("⚠️ Qui veux-tu hacker ?\n• Dans un groupe : *.hack @personne* (ou réponds à son message)\n• En privé : *.hack* (je hacke la personne avec qui je discute)\n• Ou un nom : *.hack Kevin*");
  }
  if (cibleJid === botNumber) {
    return rep("😏 Me hacker, moi ? Mon pare-feu c'est ma mauvaise humeur. Essaie quelqu'un d'autre !");
  }

  // Nom affiché : mention en groupe, nom WhatsApp en privé, ou le texte tapé
  let nom;
  let mentions = [];
  if (cibleJid && isGroup) {
    nom = nomAffiche(cibleJid);
    mentions = [cibleJid];
  } else if (cibleJid) {
    nom = profilsJoueurs[cibleJid] || (!msg.key.fromMe && msg.pushName) || args || `+${cibleJid.split('@')[0]}`;
  } else {
    nom = args;
  }

  return enFile(remoteJid, async () => {
    try {
      await passerEnLigne(sock);
      try { await sock.readMessages([msg.key]); } catch (e) {}

      const journal = [];
      const frame = (p) => `💻 *TITAN HACK v2.0* 💻\n🎯 Cible : ${nom}\n━━━━━━━━━━━━━━━\n${barre(p)}\n${journal.slice(-4).join('\n')}`;

      await sock.sendPresenceUpdate('composing', remoteJid);
      await sleep(1500);
      const premier = await sock.sendMessage(remoteJid, { text: frame(0) + '\n🚀 Lancement du piratage...', mentions }, { quoted: msg });
      if (premier?.key?.id) processedMessages.add(premier.key.id);
      const cle = premier?.key;
      let editionOk = !!cle;

      for (const [p, ligne] of ETAPES_HACK) {
        await sleep(2600);
        journal.push(ligne);
        if (editionOk) {
          try {
            await sock.sendMessage(remoteJid, { text: frame(p), edit: cle, mentions });
          } catch (e) {
            editionOk = false; // la modification a échoué : on enverra juste le rapport final
          }
        }
      }

      await sleep(1800);
      const ip = `${alea(['41', '154', '196', '197'])}.${entierAlea(1, 254)}.${entierAlea(1, 254)}.${entierAlea(1, 254)}`;
      const rapport =
`🏴‍☠️ *PIRATAGE RÉUSSI : ${nom} !* 😈
━━━━━━━━━━━━━━━
🌐 *IP :* ${ip} (inventée, bien sûr)
📱 *Appareil :* ${alea(APPAREILS_HACK)}
🔋 *Batterie :* ${entierAlea(1, 9)}% (et il/elle cherche son chargeur)
📍 *Position :* ${alea(POSITIONS_HACK)}
🔍 *Dernière recherche :* ${alea(RECHERCHES_HACK)}
🔑 *Mot de passe :* ${alea(MOTS_DE_PASSE_HACK)}
💬 *Dernier message envoyé :* ${alea(DERNIERS_MESSAGES_HACK)}
🕵️ *Niveau de danger :* ${entierAlea(1, 100)}/100
━━━━━━━━━━━━━━━
😂 _Tout est inventé, c'est juste pour rire !_`;
      const final = await sock.sendMessage(remoteJid, { text: rapport, mentions }, { quoted: msg });
      if (final?.key?.id) processedMessages.add(final.key.id);
    } catch (err) {
      console.error('⚠️ Erreur hack :', err);
    } finally {
      arreterComposing(sock, remoteJid);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// 💘 DRAGUE : plusieurs phrases, avec un délai entre chaque envoi (anti-spam)
// ═══════════════════════════════════════════════════════════
const draguesEnCours = new Set();

async function commandeDrague(sock, msg, remoteJid, senderJid, cleanText) {
  const rep = (texte) => envoyerAvecDelai(sock, remoteJid, { text: texte }, { quoted: msg }, 'texte');
  const cibleJid = trouverCible(msg, remoteJid, true);
  if (!cibleJid) {
    return rep("⚠️ Mentionne la personne à draguer !\nExemple : *drague @personne* (ou *drague @personne 3* pour 3 phrases)");
  }
  if (draguesEnCours.has(remoteJid)) {
    return rep("⏳ Une séance de drague est déjà en cours ici, patience !");
  }

  // On retire d'abord les mentions (@2250...) pour ne lire que le nombre de phrases demandé
  const mNombre = cleanText.replace(/@\d+/g, '').trim().match(/(\d+)\s*$/);
  const nb = Math.max(1, Math.min(5, mNombre ? parseInt(mNombre[1], 10) : 3));
  const tag = `@${cibleJid.split('@')[0]}`;
  const phrases = melanger(LISTE_DRAGUES).slice(0, nb).map(p => p.replace(/@tag/g, tag));

  draguesEnCours.add(remoteJid);
  return enFile(remoteJid, async () => {
    try {
      await passerEnLigne(sock);
      try { await sock.readMessages([msg.key]); } catch (e) {}
      for (let i = 0; i < phrases.length; i++) {
        await sock.sendPresenceUpdate('composing', remoteJid);
        await sleep(2000);
        const options = i === 0 ? { quoted: msg } : {};
        const envoye = await sock.sendMessage(remoteJid, { text: phrases[i], mentions: [cibleJid] }, options);
        if (envoye?.key?.id) processedMessages.add(envoye.key.id);
        try { await sock.sendPresenceUpdate('paused', remoteJid); } catch (e) {}
        // ⏱️ Intervalle total entre deux envois = DELAI_DRAGUE_MS (8 secondes par défaut)
        if (i < phrases.length - 1) await sleep(Math.max(0, DELAI_DRAGUE_MS - 2000));
      }
    } catch (err) {
      console.error('⚠️ Erreur drague :', err);
    } finally {
      draguesEnCours.delete(remoteJid);
      arreterComposing(sock, remoteJid);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// 📖 DICTIONNAIRE EN LIGNE (Wiktionnaire français, puis dictionaryapi.dev)
// ═══════════════════════════════════════════════════════════
function nettoyerHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}
const couper = (s, n) => (s.length > n ? s.slice(0, n - 1).trim() + '…' : s);

async function definitionWiktionnaire(mot) {
  const url = `https://fr.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(mot)}`;
  const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  const blocs = r.data && r.data.fr;
  if (!Array.isArray(blocs) || !blocs.length) return null;
  const sens = [];
  for (const b of blocs) {
    for (const d of (b.definitions || [])) {
      const def = nettoyerHtml(d.definition);
      if (!def) continue;
      const ex = Array.isArray(d.examples) && d.examples.length ? nettoyerHtml(d.examples[0]) : '';
      sens.push({ nature: nettoyerHtml(b.partOfSpeech), def, ex });
    }
  }
  return sens.length ? { mot, source: 'Wiktionnaire', sens } : null;
}

async function definitionDictionaryApi(mot) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/fr/${encodeURIComponent(mot)}`;
  const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': UA } });
  if (!Array.isArray(r.data) || !r.data.length) return null;
  const sens = [];
  let phon = '';
  for (const e of r.data) {
    phon = phon || e.phonetic || '';
    for (const m of (e.meanings || [])) {
      for (const d of (m.definitions || [])) {
        sens.push({ nature: m.partOfSpeech || '', def: nettoyerHtml(d.definition), ex: nettoyerHtml(d.example) });
      }
    }
  }
  return sens.length ? { mot, source: 'dictionaryapi.dev', phon, sens } : null;
}

async function commandeDico(sock, msg, remoteJid, cleanText) {
  const rep = (texte) => envoyerAvecDelai(sock, remoteJid, { text: texte }, { quoted: msg }, 'texte');
  let mot = cleanText.replace(/^\.(dico|def|dictionnaire)\s*/i, '').trim();
  if (!mot) {
    const cite = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    mot = (cite?.conversation || cite?.extendedTextMessage?.text || '').trim();
  }
  mot = mot.split(/\s+/)[0] || '';
  if (!mot) return rep("📖 Donne-moi un mot !\nExemple : *.dico courage*");
  if (mot.length > 40) return rep("⚠️ Ce mot est trop long, essaie un seul mot à la fois.");

  try { await sock.sendPresenceUpdate('composing', remoteJid); } catch (e) {}
  let res = null;
  for (const chercher of [definitionWiktionnaire, definitionDictionaryApi]) {
    for (const variante of [...new Set([mot, mot.toLowerCase()])]) {
      try { res = await chercher(variante); } catch (e) { res = null; }
      if (res) break;
    }
    if (res) break;
  }
  if (!res) return rep(`😕 Je ne trouve pas la définition de « ${mot} ».\nVérifie l'orthographe, ou essaie le mot au singulier / à l'infinitif.`);

  const lignes = [`📖 *${res.mot.toUpperCase()}*${res.phon ? `  _${res.phon}_` : ''}`, '━━━━━━━━━━━━━━━'];
  res.sens.slice(0, 4).forEach((s, i) => {
    lignes.push(`*${i + 1}.* ${s.nature ? `_(${s.nature})_ ` : ''}${couper(s.def, 260)}`);
    if (s.ex) lignes.push(`   ↳ _« ${couper(s.ex, 160)} »_`);
  });
  lignes.push('━━━━━━━━━━━━━━━', `🌐 Source : ${res.source}`);
  return rep(lignes.join('\n'));
}

// ═══════════════════════════════════════════════════════════
// 🖼️ IMAGES : recherche Google (si configuré) → photo libre (Openverse) → image générée par IA
// ═══════════════════════════════════════════════════════════
async function telechargerImageUrl(url, timeout = 25000) {
  const r = await axios.get(url, {
    responseType: 'arraybuffer', timeout, maxContentLength: 8 * 1024 * 1024,
    headers: { 'User-Agent': UA, 'Accept': 'image/*' }
  });
  const type = String(r.headers['content-type'] || '');
  if (!type.startsWith('image/')) throw new Error("pas une image");
  const buf = Buffer.from(r.data);
  if (buf.length < 2000) throw new Error('image trop petite');
  return buf;
}

// Google Images : il faut GOOGLE_API_KEY et GOOGLE_CX dans les variables Render (Custom Search API, 100 requêtes gratuites/jour)
async function imageGoogle(q) {
  const key = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;
  if (!key || !cx) return null;
  const r = await axios.get('https://www.googleapis.com/customsearch/v1', {
    params: { key, cx, q, searchType: 'image', num: 8, safe: 'active' }, timeout: 15000
  });
  for (const it of melanger(r.data?.items || []).slice(0, 5)) {
    try { return await telechargerImageUrl(it.link); } catch (e) {}
  }
  return null;
}

async function traduireEnAnglais(q) {
  try {
    const r = await axios.get('https://api.mymemory.translated.net/get', {
      params: { q, langpair: 'fr|en' }, timeout: 10000
    });
    const t = r.data?.responseData?.translatedText;
    return t && t.toLowerCase() !== q.toLowerCase() ? t : null;
  } catch (e) { return null; }
}

async function imageOpenverse(q) {
  const essayer = async (terme) => {
    const r = await axios.get('https://api.openverse.org/v1/images/', {
      params: { q: terme, page_size: 12, mature: false }, timeout: 15000, headers: { 'User-Agent': UA }
    });
    for (const it of melanger(r.data?.results || []).slice(0, 6)) {
      for (const lien of [it.url, it.thumbnail]) {
        if (!lien) continue;
        try { return await telechargerImageUrl(lien); } catch (e) {}
      }
    }
    return null;
  };
  let buf = await essayer(q);
  if (!buf) {
    const en = await traduireEnAnglais(q);
    if (en) buf = await essayer(en);
  }
  return buf;
}

async function imageGeneree(q) {
  const graine = entierAlea(1, 999999);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(q)}?width=768&height=768&nologo=true&safe=true&seed=${graine}`;
  return telechargerImageUrl(url, 70000);
}

async function commandeImage(sock, msg, remoteJid, cleanText, genererSeulement) {
  const rep = (texte) => envoyerAvecDelai(sock, remoteJid, { text: texte }, { quoted: msg }, 'texte');
  let q = cleanText.replace(/^\.(imagine|gen|image|img)\s*/i, '').trim();
  if (!q) {
    const cite = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    q = (cite?.conversation || cite?.extendedTextMessage?.text || '').trim();
  }
  if (!q) {
    return rep(genererSeulement
      ? "🎨 Décris-moi ce que tu veux !\nExemple : *.imagine un lion qui mange une pizza*"
      : "🖼️ Dis-moi quoi chercher !\nExemple : *.image banane*");
  }
  q = q.slice(0, 200);

  try { await sock.sendPresenceUpdate('composing', remoteJid); } catch (e) {}
  let buffer = null;
  let source = '';
  const etapes = genererSeulement
    ? [['🎨 Image générée par IA', imageGeneree]]
    : [['🌐 Google Images', imageGoogle], ['📷 Photo libre de droits', imageOpenverse], ['🎨 Image générée par IA', imageGeneree]];

  for (const [nomSource, fonction] of etapes) {
    try {
      buffer = await fonction(q);
    } catch (e) {
      console.error(`⚠️ Image (${nomSource}) :`, e.message);
      buffer = null;
    }
    if (buffer) { source = nomSource; break; }
  }

  if (!buffer) return rep(`😕 Je n'ai rien trouvé pour « ${q} ». Réessaie dans un instant ou avec un autre mot.`);
  return envoyerAvecDelai(sock, remoteJid, { image: buffer, caption: `🔍 *${q}*\n${source}` }, { quoted: msg }, 'media');
}

// ═══════════════════════════════════════════════════════════
// 🎭 COMMANDES FUN BRANCHÉES SUR data.js (8ball, love, mensonge, cerveau, balance, fiche)
// ═══════════════════════════════════════════════════════════
const GRADES = [
  [0, '🥚 Recrue'], [5, '🪖 Soldat'], [20, '⚔️ Guerrier'], [50, '🛡️ Élite'], [100, '👑 Légende'], [200, '⚡ TITAN']
];
const VERDICTS_BALANCE = {
  ange: ["Une vraie auréole, ce n'est pas normal 😇", "Tu pourrais être canonisé(e) demain 🙏", "Maman peut être fière 🥹"],
  mixte: ["Un pied au paradis, l'autre chez le diable 😏", "Équilibre parfait… suspect 🤨", "Ni saint(e), ni coupable, juste malin(e) 😌"],
  demon: ["Les cornes dépassent déjà 👿", "Même l'enfer a demandé à te renvoyer 🔥", "Éloignez les enfants et la nourriture 🚨"]
};

async function commande8Ball(sock, msg, remoteJid, cleanText) {
  const question = cleanText.replace(/^\.8ball\s*/i, '').trim();
  if (!question) {
    return envoyerAvecDelai(sock, remoteJid, { text: "🎱 Pose-moi une question !\nExemple : *.8ball est-ce que je vais réussir ?*" }, { quoted: msg }, 'texte');
  }
  return envoyerAvecDelai(sock, remoteJid, { text: `🎱 *BOULE MAGIQUE*\n\n❓ _${question}_\n\n🔮 ${alea(REPONSES_8BALL)}` }, { quoted: msg }, 'texte');
}

async function commandeLove(sock, msg, remoteJid, senderJid) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const mentions = ctx?.mentionedJid || [];
  let a; let b;
  if (mentions.length >= 2) { a = mentions[0]; b = mentions[1]; }
  else if (mentions.length === 1) { a = senderJid; b = mentions[0]; }
  else if (ctx?.quotedMessage && ctx.participant) { a = senderJid; b = ctx.participant; }
  if (!a || !b) {
    return envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Mentionne une ou deux personnes !\nExemple : *.love @personne* ou *.love @A @B*" }, { quoted: msg }, 'texte');
  }
  const score = entierAlea(0, 100);
  const tier = score >= 80 ? 'parfait' : (score >= 45 ? 'moyen' : 'faible');
  const texte =
`💘 *TEST D'AMOUR* 💘
━━━━━━━━━━━━━━━
${nomAffiche(a)} ❤️ ${nomAffiche(b)}

💖 ${barre(score)}
💬 ${alea(COMMENTAIRES_LOVE[tier])}

💡 *Conseil :* ${alea(CONSEILS_LOVE)}`;
  return envoyerAvecDelai(sock, remoteJid, { text: texte, mentions: [a, b] }, { quoted: msg }, 'texte');
}

async function commandeMensonge(sock, msg, remoteJid, cleanText) {
  const phrase = cleanText.replace(/^\.(dec|mensonge)\s*/i, '').trim();
  const score = entierAlea(0, 100);
  const verdict = score >= 50 ? alea(VERDICTS_MENSONGE) : "Cette personne dit la vérité 😇";
  const texte = `🤥 *DÉTECTEUR DE MENSONGES*\n${phrase ? `\n🗣️ _« ${phrase} »_\n` : ''}\n📊 ${barre(score)}\n🕵️ Taux de mytho : *${score}%*\n💬 ${verdict}`;
  return envoyerAvecDelai(sock, remoteJid, { text: texte }, { quoted: msg }, 'texte');
}

async function commandeCerveau(sock, msg, remoteJid, senderJid) {
  const cible = trouverCible(msg, remoteJid, false) || senderJid;
  const lignes = DONNEES_CERVEAU.map(l => `${l.trim()}\n   ${barre(entierAlea(0, 100))}`);
  const texte = `🧠 *SCANNER CÉRÉBRAL* 🧠\n👤 ${nomAffiche(cible)}\n━━━━━━━━━━━━━━━\n${lignes.join('\n')}\n━━━━━━━━━━━━━━━\n🩺 *Diagnostic :* ${alea(COMMENTAIRES_CERVEAU)}`;
  return envoyerAvecDelai(sock, remoteJid, { text: texte, mentions: [cible] }, { quoted: msg }, 'texte');
}

async function commandeBalance(sock, msg, remoteJid, senderJid) {
  const cible = trouverCible(msg, remoteJid, false) || senderJid;
  const ange = entierAlea(0, 100);
  const verdict = ange >= 67 ? alea(VERDICTS_BALANCE.ange) : (ange >= 34 ? alea(VERDICTS_BALANCE.mixte) : alea(VERDICTS_BALANCE.demon));
  const texte = `⚖️ *BALANCE ANGE / DÉMON* ⚖️\n👤 ${nomAffiche(cible)}\n━━━━━━━━━━━━━━━\n😇 Ange : ${barre(ange)}\n😈 Démon : ${barre(100 - ange)}\n━━━━━━━━━━━━━━━\n💬 ${verdict}`;
  return envoyerAvecDelai(sock, remoteJid, { text: texte, mentions: [cible] }, { quoted: msg }, 'texte');
}

async function commandeFiche(sock, msg, remoteJid, senderJid) {
  const cible = trouverCible(msg, remoteJid, false) || senderJid;
  const nb = statsCommandes[cible] || 0;
  let grade = GRADES[0][1];
  for (const [seuil, nom] of GRADES) if (nb >= seuil) grade = nom;
  const mar = mariages.get(cible);
  const texte =
`🪪 *FICHE D'IDENTITÉ TITAN* 🪪
━━━━━━━━━━━━━━━
👤 *Nom :* ${nomAffiche(cible)}
🏅 *Grade :* ${grade}
⌨️ *Commandes utilisées :* ${nb}
💍 *Situation :* ${mar ? `marié(e) avec ${nomAffiche(mar.conjoint)}` : 'célibataire'}
📝 *Profil :* ${profilsJoueurs[cible] ? 'enregistré ✅' : "non enregistré (fais *.inscrire [Nom]*)"}
━━━━━━━━━━━━━━━`;
  return envoyerAvecDelai(sock, remoteJid, { text: texte, mentions: mar ? [cible, mar.conjoint] : [cible] }, { quoted: msg }, 'texte');
}

let sock = null;

async function startBot() {
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.ws.close();
    } catch (e) {}
  }

  const { state, saveCreds, clearSession } = await getAuthState();
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  sock.ev.on('creds.update', saveCreds);

  // 👁️ Vue unique : listener dédié[span_4](start_span)[span_4](end_span)
  installerVueUnique(sock);

  // 🔄 Reconnexion automatique (voir plus bas)
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || "";
      console.log(`❌ Connexion fermée. Code : ${statusCode} | Erreur : ${errorMessage}`);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log("❌ Appareil déconnecté depuis WhatsApp. Nettoyage de la session...");
        await clearSession();
        console.log("🔄 Nouvelle tentative dans 5 secondes (nouveau code de jumelage)...");
        setTimeout(() => startBot().catch(e => console.error('❌ Erreur redémarrage :', e)), 5000);
        return;
      }

      // Après la saisie du code, WhatsApp coupe volontairement la connexion (code 515 "restart required").
      // Il FAUT relancer le bot, sinon le jumelage n'est jamais terminé.
      const dejaJumele = !!(sock && sock.authState && sock.authState.creds && sock.authState.creds.registered);
      if (statusCode === DisconnectReason.restartRequired || dejaJumele) {
        console.log("🔄 Reconnexion dans 3 secondes...");
        setTimeout(() => startBot().catch(e => console.error('❌ Erreur redémarrage :', e)), 3000);
      }
    } else if (connection === 'open') {
      console.log('⚡ TITAN BOT PRÊT ET CONNECTÉ !');
    }
  });

  if (!sock.authState.creds.registered) {
    const rawNumber = process.env.PHONE_NUMBER || "225XXXXXXXXXX";
    const phoneNumber = rawNumber.replace(/[^0-9]/g, "");

    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log(`\n==================================`);
        console.log(`👉 CODE DE JUMELAGE : ${code}`);
        console.log(`==================================\n`);
      } catch (err) {
        console.error("❌ Erreur de génération du Pairing Code :", err);
      }
    }, 6000);
  }

  // 🛡 DÉTECTION DES MESSAGES SUPPRIMÉS (ANTI-DELETE)[span_5](start_span)[span_5](end_span)
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      if (update.update && update.update.message === null || update.update?.protocolMessage?.type === 0) {
        const deletedId = update.key.id;
        const cachedMsg = messageCache[deletedId];

        if (cachedMsg) {
          const remoteJid = update.key.remoteJid;
          const sender = cachedMsg.sender;
          const senderName = profilsJoueurs[sender] || `@${sender.split('@')[0]}`;
          
          let alertText = `🚨 *ANTI-DELETE😌 : MESSAGE SUPPRIMÉ DÉTECTÉ ! T'ES SURPRIS 🤣* 🚨\n👤 *Auteur :* ${senderName}\n📅 *Date :* ${cachedMsg.fdate || 'Récemment'}\n`;

          if (cachedMsg.text) {
            await sock.sendMessage(remoteJid, { 
              text: `${alertText}\n💬 *Message :*\n${cachedMsg.text}`,
              mentions: [sender]
            });
          } else if (cachedMsg.mediaMessage) {
            const type = cachedMsg.mediaType;
            const caption = cachedMsg.caption ? `\n📝 *Légende :* ${cachedMsg.caption}` : '';
            await sock.sendMessage(remoteJid, { 
              [type]: cachedMsg.buffer, 
              caption: `${alertText}${caption}`,
              mentions: [sender]
            });
          }
        }
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message) return;

      if (msg.key.fromMe && processedMessages.has(msg.key.id)) return;

      const messageId = msg.key.id;
      if (processedMessages.has(messageId)) return;
      processedMessages.add(messageId);
      if (processedMessages.size > 2000) processedMessages.clear();

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');
      const senderJid = isGroup ? (msg.key.participant || remoteJid) : remoteJid;

      if (utilisateursMutes.has(senderJid)) {
        return; 
      }

      const timestamp = msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now();
      const formattedDate = new Date(timestamp).toLocaleString('fr-FR', { 
        dateStyle: 'short', 
        timeStyle: 'medium' 
      });

      const cleanTextLog = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
      console.log(`📩 [MSG] (${formattedDate}) De :${senderJid} | Groupe : ${isGroup} | Texte :${cleanTextLog}`);

      const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      const isFromBot = msg.key.fromMe || senderJid === botNumber;

      let isAdmin = false;
      if (isGroup) {
        try {
          const groupMetadata = await sock.groupMetadata(remoteJid);
          const participant = groupMetadata.participants.find(p => p.id === senderJid);
          if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
            isAdmin = true;
          }
        } catch (e) {}
      }

      const cleanText = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "").trim();
      const lowerText = cleanText.toLowerCase();

      let storedContent = msg.message;
      if (storedContent?.ephemeralMessage) storedContent = storedContent.ephemeralMessage.message;
      if (storedContent?.viewOnceMessageV2) storedContent = storedContent.viewOnceMessageV2.message;
      if (storedContent?.viewOnceMessage) storedContent = storedContent.viewOnceMessage.message;

      const textToCache = storedContent.conversation || storedContent.extendedTextMessage?.text || storedContent.imageMessage?.caption || "";
      const imageMsg = storedContent.imageMessage || storedContent.viewOnceMessageV2?.message?.imageMessage || storedContent.viewOnceMessage?.message?.imageMessage;

      if (imageMsg) {
        try {
          const stream = await downloadContentFromMessage(imageMsg, 'image');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          
          messageCache[messageId] = {
            sender: senderJid,
            mediaMessage: true,
            mediaType: 'image',
            buffer: buffer,
            caption: imageMsg.caption || "",
            fdate: formattedDate
          };
        } catch (e) {}
      } else if (textToCache) {
        messageCache[messageId] = {
          sender: senderJid,
          text: textToCache,
          fdate: formattedDate
        };
      }

      const cacheKeys = Object.keys(messageCache);
      if (cacheKeys.length > 50) {
        delete messageCache[cacheKeys[0]];
      }

      if (!cleanText) return;

      // 🚦 Anti-spam : une commande par utilisateur toutes les 2,5 secondes
      if (!isFromBot && estCommandeReconnue(lowerText)) {
        const maintenant = Date.now();
        if (maintenant - (dernieresCommandes.get(senderJid) || 0) < COOLDOWN_COMMANDE_MS) return;
        dernieresCommandes.set(senderJid, maintenant);
        if (dernieresCommandes.size > 500) dernieresCommandes.clear();
      }

      // 🎭 Commande reconnue : réaction immédiate, puis "en train d'écrire…" jusqu'à l'arrivée de la réponse
      if (estCommandeReconnue(lowerText) && !(data.botPrivateMode && !isFromBot)) {
        await reagirCommande(sock, msg);
        demarrerComposing(sock, remoteJid);
        statsCommandes[senderJid] = (statsCommandes[senderJid] || 0) + 1;
      }

      if (lowerText === '.private on' || lowerText === '.private off') {
        if (!isFromBot) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Seul le propriétaire du bot peut modifier le mode privé !" }, { quoted: msg }, 'texte');
          return;
        }

        if (lowerText === '.private on') {
          data.botPrivateMode = true;
          refusPriveDeja.clear();
          await envoyerAvecDelai(sock, remoteJid, { text: "🔒 *Mode privé activé.*" }, { quoted: msg }, 'texte');
        } else {
          data.botPrivateMode = false;
          refusPriveDeja.clear();
          await envoyerAvecDelai(sock, remoteJid, { text: "🔓 *Mode privé désactivé.*" }, { quoted: msg }, 'texte');
        }
        return;
      }

      if (data.botPrivateMode === undefined) {
        data.botPrivateMode = true;
      }

      if (data.botPrivateMode && !isFromBot) {
        if (cleanText === '2010') {
          data.botPrivateMode = false;
          refusPriveDeja.clear();
          await envoyerAvecDelai(sock, remoteJid, { text: "🔓 *Code secret correct !*" }, { quoted: msg }, 'texte');
        } else if (!refusPriveDeja.has(senderJid)) {
          // Une seule fois par personne : ensuite silence total, même si elle insiste
          refusPriveDeja.add(senderJid);
          await envoyerAvecDelai(sock, remoteJid, { text: "Je ne te répondrai pas, Andy est absent ❌." }, { quoted: msg }, 'texte');
        }
        return;
      }

      if (lowerText.startsWith('.confession')) {
        const confessionText = cleanText.replace(/^\.confession\s*/i, '').trim();
        if (!confessionText) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠ Tu dois écrire ta confession !" }, { quoted: msg }, 'texte');
          return;
        }
        if (isGroup) {
          try {
            await sock.sendMessage(remoteJid, { delete: msg.key });
          } catch (e) {}
        }
        await envoyerAvecDelai(sock, remoteJid, { text: `🤫 *CONFESSION ANONYME* 🤫\n\n"${confessionText}"` }, {}, 'texte');
        return;
      }

      if (lowerText.startsWith('.mariage')) {
        await commandeMariage(sock, msg, remoteJid, senderJid);
        return;
      }

      if (lowerText === '.divorce') {
        await commandeDivorce(sock, msg, remoteJid, senderJid);
        return;
      }

      if (['.kick', '.promote', '.demote', '.warn', '.mute', '.unmute'].some(cmd => lowerText.startsWith(cmd))) {
        if (!isFromBot && !isAdmin) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠ Réservé aux administrateurs !" }, { quoted: msg }, 'texte');
          return;
        }

        const mentionMod = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!mentionMod && !lowerText.startsWith('.unmute')) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Mentionne un membre !" }, { quoted: msg }, 'texte');
          return;
        }

        if (lowerText.startsWith('.kick') && isGroup) {
          try {
            await sock.groupParticipantsUpdate(remoteJid, [mentionMod], "remove");
            await envoyerAvecDelai(sock, remoteJid, { text: `👢 Expulsé.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          } catch (e) {}
          return;
        }
        if (lowerText.startsWith('.promote') && isGroup) {
          try {
            await sock.groupParticipantsUpdate(remoteJid, [mentionMod], "promote");
            await envoyerAvecDelai(sock, remoteJid, { text: `⬆️ Promu admin.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          } catch (e) {}
          return;
        }
        if (lowerText.startsWith('.demote') && isGroup) {
          try {
            await sock.groupParticipantsUpdate(remoteJid, [mentionMod], "demote");
            await envoyerAvecDelai(sock, remoteJid, { text: `⬇️ Rétrogradé.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          } catch (e) {}
          return;
        }
        if (lowerText.startsWith('.warn')) {
          await envoyerAvecDelai(sock, remoteJid, { text: `⚠️ Avertissement pour @${mentionMod.split('@')[0]}`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          return;
        }
        if (lowerText.startsWith('.mute')) {
          utilisateursMutes.add(mentionMod);
          await envoyerAvecDelai(sock, remoteJid, { text: `🔇 @${mentionMod.split('@')[0]} muté.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          return;
        }
        if (lowerText.startsWith('.unmute')) {
          const mentionUnmute = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (mentionUnmute && utilisateursMutes.has(mentionUnmute)) {
            utilisateursMutes.delete(mentionUnmute);
            await envoyerAvecDelai(sock, remoteJid, { text: `🔊 @${mentionUnmute.split('@')[0]} démuté.`, mentions: [mentionUnmute] }, { quoted: msg }, 'texte');
          }
          return;
        }
      }

      if (lowerText.startsWith('.translate') || lowerText.startsWith('.trad')) {
        let args = cleanText.replace(/^\.(translate|trad)\s*/i, '').trim();
        let targetLang = "fr"; 
        let textToTranslate = "";

        const parts = args.split(' ');
        if (parts[0] && parts[0].length <= 3) {
          targetLang = parts[0].toLowerCase();
          textToTranslate = parts.slice(1).join(' ').trim();
        } else {
          textToTranslate = args;
        }

        if (!textToTranslate && msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
          const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
          textToTranslate = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "";
        }

        if (!textToTranslate) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Rien à traduire !\nExemple : *.translate en bonjour tout le monde*\n(ou réponds à un message avec *.translate en*)" }, { quoted: msg }, 'texte');
          return;
        }

        let traduction = null;
        try {
          const response = await axios.get('https://api.mymemory.translated.net/get', {
            params: { q: textToTranslate, langpair: `autodetect|${targetLang}` }, timeout: 12000
          });
          traduction = response.data?.responseData?.translatedText;
        } catch (e) {
          console.error(`[TRAD] ❌ ${e && e.message ? e.message : e}`);
        }

        if (traduction) {
          await envoyerAvecDelai(sock, remoteJid, { text: `🌐 *TRADUCTION* (${targetLang}) : ${traduction}` }, { quoted: msg }, 'texte');
        } else {
          await envoyerAvecDelai(sock, remoteJid, { text: "😕 Je n'ai pas réussi à traduire ça. Vérifie le code de langue (en, fr, es, ar...) ou réessaie dans un instant." }, { quoted: msg }, 'texte');
        }
        return;
      }

      if (lowerText.startsWith('ret ')) {
        const regex = /^ret\s+(.*?)\s*\((\d+)\)$/i;
        const match = cleanText.match(regex);
        if (!match) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Format : *ret [phrase] (nombre)*\nExemple : *ret salut tout le monde (3)*" }, { quoted: msg }, 'texte');
          return;
        }

        const phraseARepeter = match[1].trim();
        let nombreFois = parseInt(match[2], 10);
        if (nombreFois > 10) nombreFois = 10; 

        for (let i = 0; i < nombreFois; i++) {
          if (i > 0) await new Promise(resolve => setTimeout(resolve, 3000));
          await sock.sendMessage(remoteJid, { text: phraseARepeter });
        }
        return;
      }

      if (!sessionsMaman[senderJid]) {
        sessionsMaman[senderJid] = { etape: 0 };
      }
      let sessionM = sessionsMaman[senderJid];

      if (sessionM.etape === 0 && (lowerText.includes("où est mon botti") || lowerText.includes("botti t'es là") || lowerText.includes("botti t'es la"))) {
        await envoyerAvecDelai(sock, remoteJid, { text: "Oui maman je suis là 🤖😌" }, { quoted: msg }, 'texte');
        sessionM.etape = 1;
        return;
      }
      else if (sessionM.etape === 1 && (lowerText.includes("oui"))) {
        await envoyerAvecDelai(sock, remoteJid, { text: "génial je suis content maman chérie 🥹🤖" }, { quoted: msg }, 'texte');
        sessionM.etape = 2;
        return;
      }
      else if (sessionM.etape === 2 && !isGroup && MOTS_AMOUR_PRIVE.includes(lowerText)) {
        await envoyerAvecDelai(sock, remoteJid, { text: REPONSE_AMOUR_MAMAN }, { quoted: msg }, 'texte');
        sessionM.etape = 0;
        return;
      }

      const jeu = partiesEnCours[remoteJid];
      demarrerTimerInactivite(sock, remoteJid);

      if (lowerText === '.pf' || lowerText === '.pileouface') {
        const resultat = Math.random() < 0.5 ? "🪙 *PILE !*" : "🪙 *FACE !*";
        await envoyerAvecDelai(sock, remoteJid, { text: resultat }, { quoted: msg }, 'texte');
        return;
      }

      if (/^\.(imagine|gen)(\s|$)/.test(lowerText)) {
        await commandeImage(sock, msg, remoteJid, cleanText, true);
        return;
      }

      if (/^\.(image|img)(\s|$)/.test(lowerText)) {
        await commandeImage(sock, msg, remoteJid, cleanText, false);
        return;
      }

      if (/^\.hack(\s|$)/.test(lowerText)) {
        await commandeHack(sock, msg, remoteJid, senderJid, isGroup, cleanText);
        return;
      }

      if (/^\.?drague(\s|$)/.test(lowerText)) {
        await commandeDrague(sock, msg, remoteJid, senderJid, cleanText);
        return;
      }

      if (/^\.(dico|def|dictionnaire)(\s|$)/.test(lowerText)) {
        await commandeDico(sock, msg, remoteJid, cleanText);
        return;
      }

      if (/^\.(dec|mensonge)(\s|$)/.test(lowerText)) {
        await commandeMensonge(sock, msg, remoteJid, cleanText);
        return;
      }

      if (/^\.(fiche|rang)(\s|$)/.test(lowerText)) {
        await commandeFiche(sock, msg, remoteJid, senderJid);
        return;
      }

      if (/^\.balance(\s|$)/.test(lowerText)) {
        await commandeBalance(sock, msg, remoteJid, senderJid);
        return;
      }

      if (/^\.?(cerveau|mox)(\s|$)/.test(lowerText)) {
        await commandeCerveau(sock, msg, remoteJid, senderJid);
        return;
      }

      const resultatMenu = construireMenu(cleanText, profilsJoueurs[senderJid] || 'Membre VIP');
      if (resultatMenu) {
        await envoyerMenu(sock, remoteJid, msg, resultatMenu);
        return;
      }

      if (lowerText.startsWith('.pseudo')) {
        const nouveauNom = cleanText.replace(/^\.pseudo\s*/i, '').trim();
        profilsJoueurs[senderJid] = nouveauNom;
        await envoyerAvecDelai(sock, remoteJid, { text: `✅ Pseudo mis à jour : *${nouveauNom}*` }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.inscrire')) {
        const nomEntre = cleanText.replace(/^\.inscrire\s*/i, '').trim();
        if (!nomEntre) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Entrez votre nom ! Exemple : `.inscrire Andy`" }, { quoted: msg }, 'texte');
          return;
        }

        if (jeu && jeu.type === 'LABYRINTHE' && (jeu.niveau === 'duo' || jeu.niveau === 'equipe')) {
          if (nomEntre.length < 2 || nomEntre.length > 5) {
            await envoyerAvecDelai(sock, remoteJid, { text: `⚠️ Pour le mode ${jeu.niveau.toUpperCase()}, ton pseudo d'inscription doit contenir entre **2 et 5 lettres** maximum ! (Ex: Max, Eli)` }, { quoted: msg }, 'texte');
            return;
          }
        }

        profilsJoueurs[senderJid] = nomEntre;

        if (jeu && jeu.statut === 'INSCRIPTION') {
          if (!jeu.joueurs.some(j => j.jid === senderJid)) {
            jeu.joueurs.push({ jid: senderJid, nom: nomEntre, elimine: false, score: 0 });
            await envoyerAvecDelai(sock, remoteJid, { text: `✅ *${nomEntre}* a rejoint la partie ! (${jeu.joueurs.length} inscrit(s))\nTapez \`.lancer\` quand vous êtes prêts.` }, { quoted: msg }, 'texte');
            return;
          }
        }

        await envoyerAvecDelai(sock, remoteJid, { text: `🎉 *PROFIL ENREGISTRÉ !*\nBienvenue *${nomEntre}* !` }, { quoted: msg }, 'texte');
        return;
      }

      if (/^\.v(\s|$)/.test(lowerText)) {
        await commandeVueUnique(sock, msg, remoteJid);
        return;
      }

      if (/^\.voc(\s|$)/.test(lowerText)) {
        await commandeVoc(sock, msg, remoteJid, cleanText);
        return;
      }

      if (/^\.(yt|mp3|mp4)(\s|$)/.test(lowerText)) {
        await commandeYoutube(sock, msg, remoteJid, senderJid, cleanText);
        return;
      }

      if (/^(\.pp|\.p|pipi)(\s|$)/.test(lowerText)) {
        const cible = trouverCible(msg, remoteJid, false) || senderJid;
        try {
          const ppUrl = await sock.profilePictureUrl(cible, 'image');
          await envoyerAvecDelai(sock, remoteJid, { image: { url: ppUrl }, caption: `📸 Photo de profil de ${nomAffiche(cible)}`, mentions: [cible] }, { quoted: msg }, 'media');
        } catch (e) {
          arreterComposing(sock, remoteJid);
          await envoyerAvecDelai(sock, remoteJid, { text: "😕 Pas de photo de profil visible pour cette personne." }, { quoted: msg }, 'texte');
        }
        return;
      }

      if (/^\.love(\s|$)/.test(lowerText)) {
        await commandeLove(sock, msg, remoteJid, senderJid);
        return;
      }

      if (lowerText.startsWith('.qr')) {
        const contenu = cleanText.replace(/^\.qr\s*/i, '').trim();
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(contenu)}`;
        await envoyerAvecDelai(sock, remoteJid, { image: { url: qrUrl }, caption: `📱 *QR CODE*` }, { quoted: msg }, 'qr');
        return;
      }

      if (/^\.8ball(\s|$)/.test(lowerText)) {
        await commande8Ball(sock, msg, remoteJid, cleanText);
        return;
      }

      if (lowerText === '.bombe') return declencherJeuBombe(sock, remoteJid, msg);
      if (lowerText === '.de') return declencherJeuDe(sock, remoteJid, msg);
      if (lowerText.startsWith('.lab')) return declencherJeuLabyrinthe(sock, remoteJid, msg, cleanText);
      if (lowerText === '.feurouge') return declencherJeuFeuRouge(sock, remoteJid, msg, senderJid);
      if (lowerText === '.chiffremystere') return declencherJeuChiffre(sock, remoteJid, msg, senderJid);

      if (lowerText.startsWith('.joindre')) {
        if (!jeu || jeu.statut !== 'INSCRIPTION') {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Aucune inscription ouverte en mode Équipe !" }, { quoted: msg }, 'texte');
          return;
        }

        const eq = cleanText.replace(/^\.joindre\s*/i, '').trim().toUpperCase();
        if (eq !== 'A' && eq !== 'B') {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Précisez une équipe : `.joindre A` ou `.joindre B`" }, { quoted: msg }, 'texte');
          return;
        }

        const nomJ = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
        if (!jeu.equipes) jeu.equipes = { A: [], B: [] };
        jeu.equipes.A = jeu.equipes.A.filter(j => j.jid !== senderJid);
        jeu.equipes.B = jeu.equipes.B.filter(j => j.jid !== senderJid);

        jeu.equipes[eq].push({ jid: senderJid, nom: nomJ, elimine: false });
        if (!jeu.joueurs.some(j => j.jid === senderJid)) {
          jeu.joueurs.push({ jid: senderJid, nom: nomJ, elimine: false });
        }

        await envoyerAvecDelai(sock, remoteJid, { text: `✅ *${nomJ}* a rejoint l'*ÉQUIPE ${eq}* !\n\n🔴 Équipe A : ${jeu.equipes.A.length} | 🔵 Équipe B : ${jeu.equipes.B.length}` }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText === '.restart') {
        const dernierType = partiesEnCours[remoteJid]?.dernierType || 'DE';
        reinitialiserJeu(remoteJid);
        if (dernierType === 'BOMBE') return declencherJeuBombe(sock, remoteJid, msg);
        if (dernierType === 'DE') return declencherJeuDe(sock, remoteJid, msg);
        if (dernierType === 'LABYRINTHE') return declencherJeuLabyrinthe(sock, remoteJid, msg, '.lab solo');
        if (dernierType === 'FEU_ROUGE') return declencherJeuFeuRouge(sock, remoteJid, msg, senderJid);
        if (dernierType === 'CHIFFRE') return declencherJeuChiffre(sock, remoteJid, msg, senderJid);
      }

      if (lowerText === '.stop') {
        reinitialiserJeu(remoteJid);
        await envoyerAvecDelai(sock, remoteJid, { text: "🛑 *Partie annulée.* Tapez `.menu` pour relancer un jeu." }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText === '.lancer') {
        if (!jeu || jeu.statut !== 'INSCRIPTION') {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Aucun jeu en attente d'inscription à lancer !" }, { quoted: msg }, 'texte');
          return;
        }

        if (jeu.joueurs.length === 0) {
          const nomSolo = profilsJoueurs[senderJid] || "Joueur Solo";
          jeu.joueurs.push({ jid: senderJid, nom: nomSolo, elimine: false, score: 0 });
        }

        jeu.statut = 'EN_COURS';

        if (jeu.type === 'DE') {
          let resultatText = `🎲 *RÉSULTATS DU JEU DE DÉ* 🎲\n\n`;
          let meilleurScore = -1;
          let gagnants = [];

          const scoreBot = Math.floor(Math.random() * 6) + 1;
          resultatText += `🤖 *Titan Bot* a obtenu : 🎲 *${scoreBot}*\n`;
          meilleurScore = scoreBot;
          gagnants = ["Titan Bot"];

          jeu.joueurs.forEach(j => {
            const tirage = Math.floor(Math.random() * 6) + 1;
            resultatText += `👤 *${j.nom}* a obtenu : 🎲 *${tirage}*\n`;
            if (tirage > meilleurScore) {
              meilleurScore = tirage;
              gagnants = [j.nom];
            } else if (tirage === meilleurScore) {
              gagnants.push(j.nom);
            }
          });

          resultatText += `\n🏆 *Gagnant(s) (Score: ${meilleurScore}) :*${gagnants.join(', ')} 🎉`;
          partiesEnCours[remoteJid] = { dernierType: 'DE' };
          await envoyerAvecDelai(sock, remoteJid, { text: resultatText }, { quoted: msg }, 'texte');
          return;
        }

        if (jeu.type === 'LABYRINTHE') {
          if (jeu.niveau === 'duo' && jeu.joueurs.length < 2) {
            await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Il faut exactement 2 joueurs inscrits pour le mode Duo !" }, { quoted: msg }, 'texte');
            jeu.statut = 'INSCRIPTION';
            return;
          }
          if (jeu.niveau === 'equipe' && jeu.joueurs.length < 3) {
            await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Il faut au moins 3 joueurs inscrits pour le mode Équipe !" }, { quoted: msg }, 'texte');
            jeu.statut = 'INSCRIPTION';
            return;
          }

          jeu.ordreJoueurs = [...jeu.joueurs].sort(() => Math.random() - 0.5);
          jeu.indexTour = 0;
          jeu.étape = 0;

          const premier = jeu.ordreJoueurs[0];
          await envoyerAvecDelai(sock, remoteJid, { 
            text: `🚪 *LABYRINTHE NIVEAU ${jeu.niveau.toUpperCase()} STARTED (10 Étapes)* 🚪\n\n` +
                  `🎯 Tirage aléatoire effectué parmi les inscrits !\n` +
                  `👉 C'est au tour de *${premier.nom}* de répondre à la 1ère étape !\n\n` +
                  `📍 Commandes de direction : \`@gauche\`, \`@droite\`, \`@tout droit\`, \`@milieu\`, \`@secret\`` 
          }, { quoted: msg }, 'texte');
          return;
        }

        if (jeu.type === 'FEU_ROUGE') {
          await envoyerAvecDelai(sock, remoteJid, { text: `🔴 *SQUID GAME DÉMARRE !*\n👥 *${jeu.joueurs.length} joueur(s)* sur la ligne de départ !\nPréparez-vous...` }, { quoted: msg }, 'texte');
          setTimeout(() => lancerMancheFeuRouge(sock, remoteJid), 2000);
          return;
        }

        if (jeu.type === 'CHIFFRE') {
          let listStr = jeu.joueurs.map(j => `• ${j.nom}`).join('\n');
          await envoyerAvecDelai(sock, remoteJid, { 
            text: `🔢 *CHIFFRE MYSTÈRE (1-100) STARTED !*\n\n🎯 Participants :\n${listStr}\n\n👉 Le premier qui trouve gagne ! Écrivez un chiffre dans le tchat !` 
          }, { quoted: msg }, 'texte');
          return;
        }

        if (jeu.type === 'BOMBE') {
          jeu.indexTour = 0;
          const premier = jeu.joueurs[0];
          await envoyerAvecDelai(sock, remoteJid, { 
            text: `💣 *BOMBE DÉSAMORÇAGE STARTED !*\n\n👥 Joueurs : *${jeu.joueurs.length}*\n👉 C'est au tour de *${premier.nom}* de désamorcer !\n✂️ Tapez \`@rouge\`, \`@bleu\` ou \`@jaune\` ! (15s)` 
          }, { quoted: msg }, 'texte');
          demarrerChronoBombeGroupe(sock, remoteJid);
          return;
        }
      }

      if (jeu && jeu.statut === 'EN_COURS') {
        if (jeu.type === 'BOMBE') {
          const joueurActuel = jeu.joueurs[jeu.indexTour];
          if (senderJid === joueurActuel.jid && (lowerText === '@rouge' || lowerText === '@bleu' || lowerText === '@jaune')) {
            clearTimeout(jeu.timerBombe);
            const filChoisi = lowerText.replace('@', '');

            if (filChoisi === jeu.bonFil) {
              partiesEnCours[remoteJid] = { dernierType: 'BOMBE' };
              await envoyerAvecDelai(sock, remoteJid, { text: `🟢 *BOMBE DÉSAMORCÉE PAR ${joueurActuel.nom.toUpperCase()} !* 🟢\n\n✂️ Le fil *${filChoisi.toUpperCase()}* était le bon !\n🏆 Victoire ! 🎉\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, 'texte');
            } else {
              joueurActuel.elimine = true;
              const restants = jeu.joueurs.filter(j => !j.elimine);

              if (restants.length === 0) {
                partiesEnCours[remoteJid] = { dernierType: 'BOMBE' };
                await envoyerAvecDelai(sock, remoteJid, { text: `💥 *BOOOOOOOM !* 💥\n\n*${joueurActuel.nom}* a coupé le mauvais fil (*${filChoisi.toUpperCase()}*). Le bon fil était *${jeu.bonFil.toUpperCase()}*.\n💀 Éliminé !\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, 'texte');
              } else {
                jeu.indexTour = joueurSuivantBombe(jeu, jeu.indexTour);
                const prochain = jeu.joueurs[jeu.indexTour];
                await envoyerAvecDelai(sock, remoteJid, { text: `💥 *${joueurActuel.nom}* a sauté en coupant le fil *${filChoisi.toUpperCase()}* !\n\n👉 C'est à *${prochain.nom}* de choisir un fil !` }, { quoted: msg }, 'texte');
                demarrerChronoBombeGroupe(sock, remoteJid);
              }
            }
            return;
          }
        }

        if (jeu.type === 'LABYRINTHE') {
          const dirMap = { '@gauche': 'gauche', '@droite': 'droite', '@tout droit': 'tout droit', '@milieu': 'milieu', '@secret': 'secret' };
          
          if (dirMap[lowerText]) {
            let joueurActuel;

            if (jeu.niveau === 'solo') {
              joueurActuel = jeu.ordreJoueurs[0];
            } else {
              joueurActuel = jeu.ordreJoueurs[jeu.indexTour];
              if (senderJid !== joueurActuel.jid) {
                await envoyerAvecDelai(sock, remoteJid, { text: `⏳ *Ce n'est pas ton tour !* C'est au tour de **${joueurActuel.nom}** de répondre selon le tirage aléatoire.` }, { quoted: msg }, 'texte');
                return;
              }
            }

            const dirChoisie = dirMap[lowerText];
            const cheminActuel = CHEMINS_LABYRINTHE[jeu.indexChemin];
            const bonneDirection = cheminActuel[jeu.étape] || 'gauche';
            const subAmbiance = SUBS_LABYRINTHE[Math.floor(Math.random() * SUBS_LABYRINTHE.length)];

            if (dirChoisie === bonneDirection) {
              jeu.étape += 1;
              if (jeu.étape >= 10) {
                partiesEnCours[remoteJid] = { dernierType: 'LABYRINTHE' };
                await envoyerAvecDelai(sock, remoteJid, { text: `🏆 *VICTOIRE ABSOLUE DU LABYRINTHE (${jeu.niveau.toUpperCase()}) !* 🏆\n\n🎉 Les 10 étapes ont été surmontées avec brio !\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, 'texte');
                return;
              } else {
                if (jeu.niveau !== 'solo') {
                  jeu.indexTour = (jeu.indexTour + 1) % jeu.ordreJoueurs.length;
                  const prochain = jeu.ordreJoueurs[jeu.indexTour];
                  await envoyerAvecDelai(sock, remoteJid, { text: `✨ *${joueurActuel.nom}* a validé l'étape ${jeu.étape}/10 !\n👻 _${subAmbiance}_\n\n👉 Tirage au sort : c'est au tour de **${prochain.nom}** !` }, { quoted: msg }, 'texte');
                } else {
                  await envoyerAvecDelai(sock, remoteJid, { text: `✨ Étape ${jeu.étape}/10 validée !\n👻 _${subAmbiance}_\n\n👉 Continue à avancer !` }, { quoted: msg }, 'texte');
                }
              }
            } else {
              jeu.vie = Math.max(0, jeu.vie - 10);
              
              if (jeu.vie <= 0) {
                partiesEnCours[remoteJid] = { dernierType: 'LABYRINTHE' };
                await envoyerAvecDelai(sock, remoteJid, { text: `💀 Piège fatal déclenché par *${joueurActuel.nom}* ! Santé de l'équipe à 0%.\n\n💥 *GAME OVER (PERDU)* 💀\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, 'texte');
                return;
              } else {
                if (jeu.niveau !== 'solo') {
                  jeu.indexTour = (jeu.indexTour + 1) % jeu.ordreJoueurs.length;
                  const prochain = jeu.ordreJoueurs[jeu.indexTour];
                  await envoyerAvecDelai(sock, remoteJid, { text: `❌ Erreur de *${joueurActuel.nom}* ! ⚠️ *-10 HP* pour toute l'équipe.\n❤️ Santé restante : ${genererBarreHP(jeu.vie, 100)}\n\n👉 Tirage au sort : c'est au tour de **${prochain.nom}** !` }, { quoted: msg }, 'texte');
                } else {
                  await envoyerAvecDelai(sock, remoteJid, { text: `❌ Mauvaise direction ! ⚠️ *-10 HP*.\n❤️ Santé : ${genererBarreHP(jeu.vie, 100)}\n\n👉 Continue !` }, { quoted: msg }, 'texte');
                }
              }
            }
            return;
          }
        }

        if (jeu.type === 'CHIFFRE' && !isNaN(cleanText)) {
          const prop = parseInt(cleanText, 10);
          const nomJ = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
          jeu.essais = (jeu.essais || 0) + 1;

          if (prop === jeu.secret) {
            partiesEnCours[remoteJid] = { dernierType: 'CHIFFRE' };
            await envoyerAvecDelai(sock, remoteJid, { text: `🏆 *VICTOIRE DE ${nomJ.toUpperCase()} !* 🏆\n\n🎯 Il a trouvé le chiffre mystère *${jeu.secret}* en *${jeu.essais} essai(s)* !\n\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, 'texte');
          } else {
            const ind = prop < jeu.secret ? "📈 *C'est PLUS GRAND !*" : "📉 *C'est PLUS PETIT !*";
            await envoyerAvecDelai(sock, remoteJid, { text: `${ind} (Proposé par *${nomJ}*)` }, { quoted: msg }, 'texte');
          }
          return;
        }

        if (jeu.type === 'FEU_ROUGE' && jeu.attenteReponse && cleanText.startsWith('@')) {
          const saisi = cleanText.substring(1).trim().toLowerCase();
          if (saisi === jeu.motAValider.toLowerCase()) {
            let j = jeu.joueurs.find(j => j.jid === senderJid);
            if (!j) {
              j = { jid: senderJid, nom: profilsJoueurs[senderJid] || "Aventurier", elimine: false, aRepondu: false };
              jeu.joueurs.push(j);
            }
            if (!j.aRepondu && !j.elimine) {
              j.aRepondu = true;
              await envoyerAvecDelai(sock, remoteJid, { text: `⚡ *${j.nom}* a traversé avec succès !` }, { quoted: msg }, 'texte');
            }
          }
          return;
        }
      }

    } catch (err) {
      console.error("⚠️ Erreur :", err);
      try { if (sock) arreterComposing(sock, m.messages[0]?.key?.remoteJid); } catch (e) {}
    }
  });
}

// 💣 Passe au prochain joueur encore en vie (l'index vise toujours jeu.joueurs)
function joueurSuivantBombe(jeu, depuis) {
  const n = jeu.joueurs.length;
  for (let i = 1; i <= n; i++) {
    const idx = (depuis + i) % n;
    if (!jeu.joueurs[idx].elimine) return idx;
  }
  return depuis;
}

function declencherJeuBombe(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  const fils = ['rouge', 'bleu', 'jaune'];
  partiesEnCours[remoteJid] = {
    type: 'BOMBE',
    statut: 'INSCRIPTION',
    bonFil: fils[Math.floor(Math.random() * fils.length)],
    joueurs: []
  };

  return envoyerAvecDelai(sock, remoteJid, { text: `💣 *DÉSACTIVATION DE LA BOMBE* 💣\n\nTu peux t'inscrire avec *.inscrire [Nom]* (ou lancer direct) puis taper *.lancer* !` }, { quoted: msg }, 'texte');
}

function demarrerChronoBombeGroupe(sock, remoteJid) {
  const jeu = partiesEnCours[remoteJid];
  if (!jeu || jeu.type !== 'BOMBE') return;

  if (jeu.timerBombe) clearTimeout(jeu.timerBombe);
  const joueurActuel = jeu.joueurs[jeu.indexTour];

  jeu.timerBombe = setTimeout(async () => {
    if (partiesEnCours[remoteJid] === jeu) {
      joueurActuel.elimine = true;
      const restants = jeu.joueurs.filter(j => !j.elimine);

      if (restants.length === 0) {
        partiesEnCours[remoteJid] = { dernierType: 'BOMBE' };
        await envoyerAvecDelai(sock, remoteJid, { text: `💥 *BOOOOOOOM !* perdu 🤣🤣🤣🤣 *${joueurActuel.nom}*...\n💀 Tout a sauté !` }, {}, 'texte');
      } else {
        jeu.indexTour = joueurSuivantBombe(jeu, jeu.indexTour);
        const prochain = jeu.joueurs[jeu.indexTour];
        await envoyerAvecDelai(sock, remoteJid, { text: `💥 Temps écoulé ! *${joueurActuel.nom}* est éliminé !\n👉 Le relais passe à *${prochain.nom}* (15s) !` }, {}, 'texte');
        demarrerChronoBombeGroupe(sock, remoteJid);
      }
    }
  }, 15000);
}

function declencherJeuDe(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'DE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🎲 *JEU DU DÉ (SOLO & MULTI)*\n\n👉 Tape *.inscrire [Nom]* puis *.lancer* pour jouer contre le bot ou tes amis !` }, { quoted: msg }, 'texte');
}

function declencherJeuLabyrinthe(sock, remoteJid, msg, texteCommande = ".lab solo") {
  reinitialiserJeu(remoteJid);
  
  const texteArgs = typeof texteCommande === 'string' ? texteCommande : ".lab solo";
  const parts = texteArgs.trim().split(/\s+/);
  const niveauDemande = (parts[1] || 'solo').toLowerCase();

  if (!['solo', 'duo', 'equipe'].includes(niveauDemande)) {
    return envoyerAvecDelai(sock, remoteJid, { 
      text: `🌀 *LABYRINTHE - CHOIX DU NIVEAU* 🌀\n\nPrécise ton niveau :\n• \`.lab solo\` ➔ Joueur seul\n• \`.lab duo\` ➔ Mode à deux\n• \`.lab equipe\` ➔ Mode toute une équipe\n\n*(Pour Duo et Équipe, l'inscription demande un nom de 2 à 5 lettres)*` 
    }, { quoted: msg }, 'texte');
  }

  partiesEnCours[remoteJid] = {
    type: 'LABYRINTHE',
    niveau: niveauDemande,
    statut: niveauDemande === 'solo' ? 'EN_COURS' : 'INSCRIPTION',
    indexChemin: Math.floor(Math.random() * CHEMINS_LABYRINTHE.length),
    étape: 0,
    vie: 100,
    joueurs: [],
    ordreJoueurs: []
  };

  if (niveauDemande === 'solo') {
    partiesEnCours[remoteJid].ordreJoueurs = [{ jid: msg.key.participant || msg.key.remoteJid, nom: "Aventurier" }];
    return envoyerAvecDelai(sock, remoteJid, { 
      text: `🌀 *LABYRINTHE - NIVEAU SOLO (10 Étapes)* 🌀\n\nC'est parti ! Affronte les pièges des catacombes.\n\n📍 Utilise : \`@gauche\`, \`@droite\`, \`@tout droit\`, \`@milieu\` ou \`@secret\`` 
    }, { quoted: msg }, 'texte');
  } else {
    return envoyerAvecDelai(sock, remoteJid, { 
      text: `🌀 *LABYRINTHE - NIVEAU ${niveauDemande.toUpperCase()} (10 Étapes)* 🌀\n\nInscriptions ouvertes !\n⚠ *Règle :* Ton nom d'inscription (\`.inscrire [Nom]\`) doit faire entre **2 et 5 lettres**.\n\n👉 Tape : \`.inscrire [Nom (2-5 lettres)]\` puis \`.lancer\`` 
    }, { quoted: msg }, 'texte');
  }
}

function declencherJeuFeuRouge(sock, remoteJid, msg, senderJid) {
  reinitialiserJeu(remoteJid);
  const nomSolo = profilsJoueurs[senderJid] || "Joueur Solo";

  partiesEnCours[remoteJid] = { 
    type: 'FEU_ROUGE', 
    statut: 'INSCRIPTION', 
    joueurs: [{ jid: senderJid, nom: nomSolo, elimine: false, aRepondu: false }] 
  };
  return envoyerAvecDelai(sock, remoteJid, { text: `🔴 *SQUID GAME SOLO/GROUPE*\n\n👉 Inscriptions : *.inscrire [Nom]* puis *.lancer* (ou tape direct *.lancer* pour jouer en solo) !` }, { quoted: msg }, 'texte');
}

function declencherJeuChiffre(sock, remoteJid, msg, senderJid) {
  reinitialiserJeu(remoteJid);
  const nomSolo = profilsJoueurs[senderJid] || "Joueur Solo";
  
  partiesEnCours[remoteJid] = { 
    type: 'CHIFFRE', 
    statut: 'EN_COURS', 
    joueurs: [{ jid: senderJid, nom: nomSolo, elimine: false }], 
    secret: Math.floor(Math.random() * 100) + 1, 
    essais: 0 
  };
  return envoyerAvecDelai(sock, remoteJid, { text: `🔢 *CHIFFRE MYSTÈRE (1-100)*\n\n🎯 Mode Solo actif ! Écris directement un nombre entre 1 et 100 dans le tchat.\n*(Si tu veux jouer en groupe, utilise .inscrire [Nom] puis .lancer)*` }, { quoted: msg }, 'texte');
}

async function lancerMancheFeuRouge(sock, remoteJid) {
  const jeu = partiesEnCours[remoteJid];
  if (!jeu || jeu.type !== 'FEU_ROUGE') return;

  const mot = MOTS_SQUID[Math.floor(Math.random() * MOTS_SQUID.length)];
  jeu.motAValider = mot;
  jeu.attenteReponse = true;
  jeu.joueurs.forEach(j => j.aRepondu = false);

  let tempsSec = 8 + Math.floor(Math.random() * 3);

  await envoyerAvecDelai(sock, remoteJid, { text: `🔴 *FEU ROUGE !*\n\n👉 Tape vite *@${mot}* dans le tchat !\n⏰ Temps disponible : *${tempsSec} secondes* !` }, {}, 'texte');

  jeu.timerFeu = setTimeout(async () => {
    jeu.attenteReponse = false;

    jeu.joueurs.forEach(j => {
      if (!j.aRepondu) j.elimine = true;
    });

    const survivants = jeu.joueurs.filter(j => !j.elimine);
    await envoyerAvecDelai(sock, remoteJid, { text: `🟢 *FEU VERT !* Fin du chrono !` }, {}, 'texte');

    if (survivants.length === 0) {
      partiesEnCours[remoteJid] = { dernierType: 'FEU_ROUGE' };
      await envoyerAvecDelai(sock, remoteJid, { text: `💥 *ÉLIMINATION TOTALE !* Tu as bougé trop tard !` }, {}, 'texte');
    } else if (survivants.length === 1) {
      partiesEnCours[remoteJid] = { dernierType: 'FEU_ROUGE' };
      await envoyerAvecDelai(sock, remoteJid, { text: `🏆 *CHAMPION SQUID GAME !* *${survivants[0].nom.toUpperCase()}* gagne la partie ! 🎉` }, {}, 'texte');
    } else {
      await envoyerAvecDelai(sock, remoteJid, { text: `📊 *Survivants :* ${survivants.length} en lice.\n⚡ Prochaine manche imminente...` }, {}, 'texte');
      setTimeout(() => lancerMancheFeuRouge(sock, remoteJid), 2000);
    }
  }, tempsSec * 1000);
}

startBot();
