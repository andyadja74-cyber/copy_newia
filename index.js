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

// Importation des données depuis data.js
const data = require('./data');

const {
  REPONSES_8BALL,
  COMMENTAIRES_LOVE,
  CONSEILS_LOVE,
  MOTS_AMOUR_PRIVE,
  REPONSE_AMOUR_MAMAN,
  VERDICTS_MENSONGE,
  DONNEES_CERVEAU,
  COMMENTAIRES_CERVEAU,
  LISTE_DRAGUES,
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

// 📝 ═══════════════════════════════════════════════════════════
// JOURNAL DES MESSAGES : qui écrit, où (contact ou groupe), quel type, quel contenu
// Désactivable avec la variable d'environnement LOG_MESSAGES=off
// ═══════════════════════════════════════════════════════════
const LOG_MESSAGES_ACTIF = !['off', '0', 'non', 'false'].includes((process.env.LOG_MESSAGES || 'on').trim().toLowerCase());
const contactsConnus = new Map();   // jid -> { nom (nom enregistré dans ton téléphone), pseudo (nom de profil) }
const groupesConnus = new Map();    // jid -> { nom, expire }
const DUREE_CACHE_GROUPE_MS = 60 * 60 * 1000;
const TYPES_MESSAGE = {
  conversation: 'texte', extendedTextMessage: 'texte', imageMessage: 'image', videoMessage: 'vidéo',
  audioMessage: 'audio / vocal', documentMessage: 'document', stickerMessage: 'sticker',
  contactMessage: 'contact partagé', contactsArrayMessage: 'contacts partagés',
  locationMessage: 'localisation', liveLocationMessage: 'localisation en direct',
  reactionMessage: 'réaction', pollCreationMessage: 'sondage', pollUpdateMessage: 'vote sondage',
  protocolMessage: 'protocole (suppression / édition)'
};

function memoriserContact(c) {
  if (!c || !c.id) return;
  const actuel = contactsConnus.get(c.id) || {};
  contactsConnus.set(c.id, {
    nom: c.name || c.verifiedName || actuel.nom || null,   // nom enregistré dans ton téléphone
    pseudo: c.notify || actuel.pseudo || null               // nom de profil choisi par la personne
  });
}

function numeroDuJid(jid) {
  const base = (jid || '').split('@')[0].split(':')[0];
  return jid && jid.endsWith('@lid') ? `ID ${base}` : `+${base}`;
}

// Ex : "Ami Paul (~Paulo) · +2250700000000"   ou   "~Paulo · +2250700000000" si pas dans tes contacts
function libelleContact(jid, pseudoMsg, telephone) {
  if (!jid) return '?';
  const c = contactsConnus.get(jid) || {};
  const pseudo = c.pseudo || pseudoMsg;
  let nom = null;
  if (c.nom) nom = pseudo && pseudo !== c.nom ? `${c.nom} (~${pseudo})` : c.nom;
  else if (pseudo) nom = `~${pseudo}`;
  const num = telephone ? numeroDuJid(telephone) : (jid.endsWith('@lid') ? `${numeroDuJid(jid)} (numéro non reçu)` : numeroDuJid(jid));
  return nom ? `${nom} · ${num}` : num;
}

// 📞 Correspondance LID -> vrai numéro (WhatsApp envoie le numéro à côté de l'identifiant LID)
const lidVersNumero = new Map();
function memoriserNumero(jid, alt) {
  if (jid && jid.endsWith('@lid') && alt && alt.endsWith('@s.whatsapp.net')) lidVersNumero.set(jid, alt);
}
async function numeroReel(sock, jid, alt) {
  if (!jid || !jid.endsWith('@lid')) return jid;
  memoriserNumero(jid, alt);
  if (lidVersNumero.has(jid)) return lidVersNumero.get(jid);
  try {
    const repo = sock.signalRepository?.lidMapping;
    const pn = repo ? (await repo.getPNForLID(jid)) || (await repo.getPNForLID(jid.split('@')[0])) : null;
    if (pn) {
      const complet = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
      lidVersNumero.set(jid, complet);
      return complet;
    }
  } catch (e) { /* pas encore connu : on garde l'identifiant */ }
  return null;
}

async function nomGroupe(sock, jid) {
  const connu = groupesConnus.get(jid);
  if (connu && connu.expire > Date.now()) return connu.nom;
  try {
    const meta = await sock.groupMetadata(jid);
    const nom = meta.subject || 'Groupe sans nom';
    groupesConnus.set(jid, { nom, expire: Date.now() + DUREE_CACHE_GROUPE_MS });
    return nom;
  } catch (e) {
    return connu ? connu.nom : 'Groupe (nom inconnu)';
  }
}

async function journaliserMessage(sock, msg, { muet = false } = {}) {
  if (!LOG_MESSAGES_ACTIF || !msg || !msg.key) return;
  try {
    const jid = msg.key.remoteJid || '?';
    const estGroupe = jid.endsWith('@g.us');
    const estBot = !!msg.key.fromMe;
    const date = new Date(lireTimestamp(msg.messageTimestamp)).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });

    const { content, viewOnce } = deballerMessage(msg.message || {});
    const cleType = content ? Object.keys(content).find(k => k !== 'messageContextInfo') : null;
    const type = (cleType && TYPES_MESSAGE[cleType]) || cleType || 'inconnu';
    const corps = content ? (content.conversation || content.extendedTextMessage?.text || (cleType && content[cleType]?.caption) || '') : '';
    const extrait = corps.replace(/\s+/g, ' ').trim();
    const contenu = extrait ? (extrait.length > 300 ? extrait.slice(0, 300) + '…' : extrait) : '(pas de texte)';

    // Qui a écrit (et le numéro réel de cette personne, même si WhatsApp l'a masqué derrière un LID)
    const jidAuteur = estBot ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : (estGroupe ? msg.key.participant : jid);
    const altAuteur = estGroupe ? msg.key.participantAlt : msg.key.remoteJidAlt;
    const telAuteur = estBot ? jidAuteur : await numeroReel(sock, jidAuteur, altAuteur);

    let source, auteur;
    if (estGroupe) {
      const nomG = await nomGroupe(sock, jid);
      source = `👥 GROUPE « ${nomG} » (${jid.split('@')[0]})`;
    } else {
      const telChat = await numeroReel(sock, jid, msg.key.remoteJidAlt);
      source = `👤 CONTACT privé · ${libelleContact(jid, estBot ? null : msg.pushName, telChat)}`;
    }
    auteur = estBot ? `🤖 Bot (compte Titan) · ${numeroDuJid(telAuteur)}` : libelleContact(jidAuteur, msg.pushName, telAuteur);
    const numero = estBot ? numeroDuJid(telAuteur) : (telAuteur && !telAuteur.endsWith('@lid') ? numeroDuJid(telAuteur) : '❓ non reçu (compte LID)');

    const tags = [muet && '🔇 expéditeur muet', viewOnce && '👁️ vue unique'].filter(Boolean);
    console.log([
      `┏━━ 📩 MESSAGE · ${date} ━━`,
      `┃ 📍 Source   : ${source}`,
      `┃ 👤 Auteur   : ${auteur}`,
      `┃ 📞 Numéro   : ${numero}`,
      `┃ 🏷️ Type     : ${type}${tags.length ? `   [${tags.join(' · ')}]` : ''}`,
      `┃ 💬 Contenu  : ${contenu}`,
      `┃ 🆔 ID       : ${msg.key.id}`,
      `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    ].join('\n'));
  } catch (e) {
    console.error('[LOG] ⚠️ Journal du message impossible :', e && e.message ? e.message : e);
  }
}

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

// 🎬 Vidéo du menu (optionnelle) : fichier media/menu.mp4 dans le projet
const MENU_VIDEO = (() => {
  try {
    const chemin = path.join(__dirname, 'media', 'menu.mp4');
    return fs.existsSync(chemin) ? fs.readFileSync(chemin) : null;
  } catch (e) {
    return null;
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
// (relancé toutes les 4 s car WhatsApp l'éteint tout seul ; coupe-circuit de sécurité à 180 s)
const composingActifs = new Map();
function demarrerComposing(sock, jid) {
  const existant = composingActifs.get(jid);
  if (existant) {
    clearTimeout(existant.securite);
    existant.securite = setTimeout(() => arreterComposing(sock, jid), 180000);
    return;
  }
  const envoyer = async () => { try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {} };
  envoyer();
  const intervalle = setInterval(envoyer, 4000);
  const securite = setTimeout(() => arreterComposing(sock, jid), 180000);
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

// 🛡️ Un envoi : lecture (coches bleues), "en train d'écrire…" continu, délai humain, puis envoi
async function envoyerUnPas(sock, remoteJid, content, options = {}, typeAction = 'texte') {
  const texte = typeof content === 'string' ? content : (content.text || content.caption || "");
  const delaiMs = calculerDelaiEnvoi(texte, typeAction);

  await passerEnLigne(sock);
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
    memoriserMonEnvoi(remoteJid, sentMsg.key);
  }
  return sentMsg;
}

// ✍️ Suivi des envois : "en train d'écrire…" reste affiché tant qu'il reste un message à envoyer
const envoisEnAttente = new Map();   // jid -> nombre d'envois en cours ou en file
function commencerEnvoi(sock, jid) {
  envoisEnAttente.set(jid, (envoisEnAttente.get(jid) || 0) + 1);
  demarrerComposing(sock, jid);
}
function finirEnvoi(sock, jid) {
  const restant = (envoisEnAttente.get(jid) || 1) - 1;
  if (restant <= 0) {
    envoisEnAttente.delete(jid);
    arreterComposing(sock, jid);
  } else {
    envoisEnAttente.set(jid, restant);
  }
}

async function envoyerAvecDelai(sock, remoteJid, content, options = {}, typeAction = 'texte') {
  options = sansCitationSupprimee(options);
  commencerEnvoi(sock, remoteJid);
  return enFile(remoteJid, async () => {
    try {
      return await envoyerUnPas(sock, remoteJid, content, options, typeAction);
    } catch (err) {
      console.error("⚠ Erreur d'envoi :", err);
    } finally {
      finirEnvoi(sock, remoteJid);
    }
  });
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
  // Image et vidéo : la légende fait partie du média. Vocal : pas de légende possible, il part seul.
  const res = await sock.sendMessage(cible, contenuMedia(cache, texte), cache.type === 'audio' ? {} : options);
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
  // Un vocal ne peut pas avoir de légende : il part seul, sans message texte séparé
  if (cache.type === 'audio') {
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

// 🔧 ═══════════════════════════════════════════════════════════
// FFMPEG : trouvé sur le serveur ou via ffmpeg-static (utilisé par les vocaux .voc et .voc-f)
// ═══════════════════════════════════════════════════════════
const { spawn, spawnSync } = require('child_process');
const os = require('os');

const TMP_DIR = path.join(os.tmpdir(), 'titan-tmp');   // fichiers temporaires des vocaux
const bin = { ffmpeg: null };
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

function preparerBinaires() {
  if (preparationBinaires) return preparationBinaires;
  preparationBinaires = (async () => {
    bin.ffmpeg = trouverFfmpeg();
    console.log(`[AUDIO] ffmpeg : ${bin.ffmpeg || 'INTROUVABLE'}`);
    if (!bin.ffmpeg) preparationBinaires = null;   // on réessaiera à la prochaine commande
  })();
  return preparationBinaires;
}
preparerBinaires().catch(e => console.error('[AUDIO] ⚠️ Préparation de ffmpeg :', e && e.message ? e.message : e));

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
function ttsEspeak(texte, voix = 'fr+m3', vitesse = 120) {
  return new Promise((resolve, reject) => {
    const p = spawn('espeak-ng', ['-v', voix, '-s', String(vitesse), '--stdout', texte], { stdio: ['ignore', 'pipe', 'ignore'] });
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
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const id = 'voc-' + crypto.randomBytes(6).toString('hex');
  const entree = path.join(TMP_DIR, id + '.in');
  const sortie = path.join(TMP_DIR, id + '.ogg');
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
  commencerEnvoi(sock, remoteJid);
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
      ? "⚠️ ffmpeg est introuvable sur le serveur (lance `npm install` pour installer ffmpeg-static)."
      : "⚠️ Je n'ai pas réussi à fabriquer le vocal pour le moment, réessaie dans un instant.");
  } finally {
    vocOccupe = false;
    finirEnvoi(sock, remoteJid);
  }
}

// 🎙️ ═══════════════════════════════════════════════════════════
// .voc-f [texte] → comme .voc, mais avec une voix de FEMME (plus aiguë, claire, bien audible)
// La commande tapée est supprimée et le vocal part comme si c'était toi : aucune réponse du bot
// ═══════════════════════════════════════════════════════════
const VOCF_MAX_CARACTERES = parseInt(process.env.VOCF_MAX_CAR, 10) || VOC_MAX_CARACTERES;
// 1 = voix normale ; plus grand = plus aiguë (1.22 ≈ voix de femme bien aiguë et audible)
const VOCF_AIGU = Math.min(1.3, Math.max(1, parseFloat(process.env.VOCF_AIGU) || 1.22));
// 1 = vitesse normale ; 0.95 = posée et bien articulée
const VOCF_VITESSE = Math.min(1.1, Math.max(0.6, parseFloat(process.env.VOCF_VITESSE) || 0.95));

// Texte → fichier .ogg (opus) à voix de femme, cadence maîtrisée
async function fabriquerVocalFemme(texte) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const id = 'vocf-' + crypto.randomBytes(6).toString('hex');
  const entree = path.join(TMP_DIR, id + '.in');
  const sortie = path.join(TMP_DIR, id + '.ogg');
  try {
    let audio;
    try {
      const morceaux = [];
      for (const m of decouperTexte(texte)) morceaux.push(await ttsGoogle(m));
      audio = Buffer.concat(morceaux);
    } catch (e) {
      console.error(`[VOC-F] ⚠️ Service vocal en ligne indisponible (${e && e.message ? e.message : e}) → essai espeak-ng`);
      audio = await ttsEspeak(texte, 'fr+f3', 130);   // voix féminine d'espeak-ng
    }
    fs.writeFileSync(entree, audio);

    // monter la hauteur (×VOCF_AIGU) puis corriger la vitesse pour garder le rythme voulu
    const tempo = Math.min(2, Math.max(0.5, VOCF_VITESSE / VOCF_AIGU));
    const filtre = [
      'aresample=48000',
      `asetrate=${Math.round(48000 * VOCF_AIGU)}`,
      'aresample=48000',
      `atempo=${tempo.toFixed(3)}`,
      'highpass=f=150',                                // retire le grondement
      'equalizer=f=3000:width_type=o:width=1.2:g=3',   // présence : la voix ressort mieux
      'dynaudnorm=f=150:g=6',                          // volume régulier et bien audible
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

async function commandeVocF(sock, msg, remoteJid, cleanText) {
  let texte = cleanText.replace(/^\.voc-f\s*/i, '').trim();

  // sans texte : on lit le message auquel on répond
  if (!texte) {
    const { content } = deballerMessage(msg.message);
    const cite = content && content.extendedTextMessage && content.extendedTextMessage.contextInfo && content.extendedTextMessage.contextInfo.quotedMessage;
    if (cite) texte = (cite.conversation || (cite.extendedTextMessage && cite.extendedTextMessage.text) || (cite.imageMessage && cite.imageMessage.caption) || '').trim();
  }

  // Rien à dire ou texte trop long : aucune réponse du bot (la commande est déjà effacée)
  if (!texte) return;
  if (texte.length > VOCF_MAX_CARACTERES) {
    console.log(`[VOC-F] ⚠️ Texte trop long (${texte.length} caractères, maximum ${VOCF_MAX_CARACTERES})`);
    return;
  }

  commencerEnvoi(sock, remoteJid);
  try {
    await preparerBinaires();
    if (!bin.ffmpeg) throw new Error('FFMPEG_ABSENT');
    const { buffer, secondes } = await fabriquerVocalFemme(texte);
    // envoyé sans citation : le vocal part comme si c'était toi
    await envoyerAvecDelai(sock, remoteJid, {
      audio: buffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
      ...(secondes ? { seconds: secondes } : {})
    }, {}, 'media');
  } catch (e) {
    console.error(`[VOC-F] ❌ ${e && e.message ? e.message : e}`);
    arreterComposing(sock, remoteJid);
  } finally {
    finirEnvoi(sock, remoteJid);
  }
}

// 🧹 ═══════════════════════════════════════════════════════════
// AUTO-SUPPRESSION : la commande tapée par le propriétaire est effacée dès qu'elle est lancée
// ═══════════════════════════════════════════════════════════
const messagesSupprimes = new Set();
function effacerMessage(sock, jid, key) {
  if (!key || !key.id) return Promise.resolve();
  messagesSupprimes.add(key.id);
  if (messagesSupprimes.size > 500) messagesSupprimes.clear();
  return sock.sendMessage(jid, { delete: key }).catch(e => console.error(`[DEL] ⚠️ Suppression impossible : ${e && e.message ? e.message : e}`));
}
// Pas de citation vers un message déjà effacé (sinon WhatsApp l'affiche quand même)
function sansCitationSupprimee(options) {
  if (options && options.quoted && options.quoted.key && messagesSupprimes.has(options.quoted.key.id)) {
    const { quoted, ...reste } = options;
    return reste;
  }
  return options;
}

// 📒 Mes messages envoyés, par discussion (pour la commande .del)
const mesEnvois = new Map();
function memoriserMonEnvoi(jid, key) {
  if (!jid || !key || !key.id) return;
  const liste = mesEnvois.get(jid) || [];
  if (liste.some(k => k.id === key.id)) return;
  liste.push({ remoteJid: jid, fromMe: true, id: key.id });
  if (liste.length > 300) liste.shift();
  mesEnvois.set(jid, liste);
}

// 🗑️ .del → supprime pour tout le monde tous les messages envoyés par le propriétaire dans ce chat
async function commandeDel(sock, remoteJid) {
  const liste = (mesEnvois.get(remoteJid) || []).filter(k => !messagesSupprimes.has(k.id));
  mesEnvois.set(remoteJid, []);
  let reussis = 0;
  for (const key of liste) {
    try { await sock.sendMessage(remoteJid, { delete: key }); reussis++; } catch (e) {}
    await sleep(400);
  }
  console.log(`[DEL] 🗑️ ${reussis}/${liste.length} message(s) supprimé(s) dans ${remoteJid}`);
}

// 💘 .cute [nombre] → compliments extra (3 à 20, 10 par défaut)
const COMPLIMENTS_EXTRA = [
  "Tu as une énergie qui rend les gens meilleurs autour de toi ✨",
  "Ton sourire est une vraie bouffée d'air frais 😊",
  "Tu es de ceux qu'on a envie de garder près de soi 💫",
  "Ton esprit est aussi vif que ta présence est agréable 🧠",
  "Tu rends les moments ordinaires exceptionnels 🌟",
  "Tu as un cœur en or, ça se voit de loin 💛",
  "Ta bonne humeur est contagieuse, continue comme ça 😄",
  "Tu es le genre de personne qu'on remercie d'exister 🙏",
  "Tu as un style unique, personne ne te copie 👑",
  "Tu écoutes vraiment, et ça, c'est rare 👂",
  "Tu as la force tranquille de ceux qui vont loin 🚀",
  "Tu rends chaque conversation plus intéressante 💬",
  "Tu as une élégance naturelle, sans effort 🥂",
  "Ta gentillesse ne passe jamais inaperçue 🌸",
  "Tu as le don de faire rire même les jours sombres 😂",
  "Tu inspires confiance, et c'est une grande qualité 🛡️",
  "Tu es un vrai trésor, à chérir absolument 💎",
  "Ton courage force le respect, bravo à toi 🔥",
  "Tu as une douceur qui fait du bien à tout le monde 🕊️",
  "Tu es talentueux(se) et ça se remarque à chaque fois 🎯",
  "Ton regard pétille quand tu parles de ce que tu aimes ✨",
  "Tu es une lumière dans les groupes, merci d'être là 💡",
  "Tu mérites tout le bonheur que tu donnes aux autres 💖",
  "Tu es exceptionnel(le), et tu le sais peut-être pas assez 🏆"
];
async function commandeCute(sock, msg, remoteJid, cleanText) {
  const mNombre = cleanText.match(/\(?\s*(\d+)\s*\)?\s*$/);
  const nb = Math.max(1, Math.min(20, mNombre ? parseInt(mNombre[1], 10) : 10));
  const compliments = melanger(COMPLIMENTS_EXTRA).slice(0, nb);
  return enFile(remoteJid, async () => {
    try {
      await passerEnLigne(sock);
      try { await sock.readMessages([msg.key]); } catch (e) {}
      for (let i = 0; i < compliments.length; i++) {
        await sock.sendPresenceUpdate('composing', remoteJid);
        await sleep(1500);
        await sock.sendMessage(remoteJid, { text: compliments[i] });
        try { await sock.sendPresenceUpdate('paused', remoteJid); } catch (e) {}
        if (i < compliments.length - 1) await sleep(1500);
      }
    } catch (err) {
      console.error('⚠️ Erreur cute :', err);
    } finally {
      arreterComposing(sock, remoteJid);
    }
  });
}

// 💍 .askwedding @personne → demande en mariage (réponse oui / non pendant 5 minutes)
const DEMANDES_MARIAGE = new Map();   // "chat|cible" -> { demandeur, expire }
async function commandeAskWedding(sock, msg, remoteJid, senderJid) {
  const repondre = (texte, mentions) => envoyerAvecDelai(sock, remoteJid, { text: texte, mentions: mentions || [] }, { quoted: msg }, 'texte');
  const cible = trouverCible(msg, remoteJid, true, autreDe(msg, sock, remoteJid));
  if (!cible) return repondre("💍 Mentionne la personne : *.askwedding @personne*");
  if (cible === senderJid) return repondre("😅 Tu ne peux pas te demander en mariage toi-même !");
  DEMANDES_MARIAGE.set(`${remoteJid}|${cible}`, { demandeur: senderJid, expire: Date.now() + 5 * 60 * 1000 });
  return repondre(
    `💍 *DEMANDE EN MARIAGE* ❤️\n\n@${cible.split('@')[0]}, @${senderJid.split('@')[0]} te demande ta main… 🌹\n\n👉 Réponds *oui* ou *non* (5 minutes) 💕`,
    [cible, senderJid]
  );
}
// Renvoie true si le message était la réponse à une demande en mariage
async function gererReponseMariage(sock, remoteJid, senderJid, lowerText) {
  const cle = `${remoteJid}|${senderJid}`;
  const demande = DEMANDES_MARIAGE.get(cle);
  if (!demande) return false;
  if (demande.expire < Date.now()) { DEMANDES_MARIAGE.delete(cle); return false; }
  const reponse = lowerText.trim();
  if (reponse !== 'oui' && reponse !== 'non') return false;
  DEMANDES_MARIAGE.delete(cle);
  const demandeur = `@${demande.demandeur.split('@')[0]}`;
  const cible = `@${senderJid.split('@')[0]}`;
  const texte = reponse === 'oui'
    ? `💒 *C'EST OUI !* 💖\n${cible} et ${demandeur} sont désormais fiancés ! 🥂✨`
    : `💔 *C'EST NON…*\n${cible} a refusé la demande de ${demandeur}. Courage à toi 🫂`;
  await envoyerAvecDelai(sock, remoteJid, { text: texte, mentions: [senderJid, demande.demandeur] }, {}, 'texte');
  return true;
}

// 🖼️ .routine → l'image de la routine (media/routine.jpg)
const ROUTINE_IMAGE = (() => {
  try {
    const chemin = path.join(__dirname, 'media', 'routine.jpg');
    return fs.existsSync(chemin) ? fs.readFileSync(chemin) : null;
  } catch (e) { return null; }
})();
async function commandeRoutine(sock, msg, remoteJid) {
  const texte = "Voilà la routine de mon créateur 🤣😂😂";
  if (ROUTINE_IMAGE) return envoyerAvecDelai(sock, remoteJid, { image: ROUTINE_IMAGE, caption: texte }, { quoted: msg }, 'media');
  return envoyerAvecDelai(sock, remoteJid, { text: texte }, { quoted: msg }, 'texte');
}

// 💡 Astuces affichées dans l'accueil du menu
const ASTUCES_MENU = [
  "Tape *.menu all* pour voir toutes les commandes d'un coup",
  "Tes commandes disparaissent dès qu'elles sont lancées : c'est voulu 😌",
  "Règle le nombre de phrases : *drague @personne 7* (jusqu'à 10)",
  "Essaie *.cute 15* pour recevoir 15 compliments",
  "*.routine* → tu verras la routine de mon créateur 🤣"
];

// 📚 REGISTRE DES COMMANDES
const CATEGORIES_MENU = [
  {
    id: 'identite', emoji: '🏷️', titre: 'Identité & Compte',
    cmds: [
      { noms: ['.inscrire'], args: '[Nom]', desc: 'Enregistrer ton pass VIP' },
      { noms: ['.blaze'], args: '[Nom]', desc: 'Customiser ton blaze' },
      { noms: ['.fiche', '.rang'], desc: 'Consulter ta carte & ton grade' }
    ]
  },
  {
    id: 'moderation', emoji: '🛡️', titre: 'Modération', note: 'Réservé au propriétaire du bot',
    cmds: [
      { noms: ['.kick'], args: '[@mention]', desc: 'Expulser un membre', owner: true },
      { noms: ['.promote'], args: '[@mention]', desc: 'Promouvoir admin', owner: true },
      { noms: ['.demote'], args: '[@mention]', desc: 'Rétrograder un admin', owner: true },
      { noms: ['.warn'], args: '[@mention] [raison]', desc: 'Avertir un membre', owner: true },
      { noms: ['.mute'], args: '[@mention]', desc: "Bloquer l'accès au bot à un membre", owner: true },
      { noms: ['.unmute'], args: '[@mention]', desc: "Débloquer l'accès au bot", owner: true },
      { noms: ['.private on', '.private off'], exact: true, aff: '.private', args: 'on | off', desc: "Verrouiller / déverrouiller le bot", owner: true }
    ]
  },
  {
    id: 'outils', emoji: '🛠️', titre: 'Outils & Tech',
    cmds: [
      { groupe: '📸 Médias', noms: ['.v'], desc: 'Revoir une photo / vidéo / vocal en vue unique' },
      { groupe: '📸 Médias', noms: ['.pp', '.p'], aff: '.pp', args: '[@mention]', desc: "Photo de profil (groupe & privé)" },
      { groupe: '📸 Médias', noms: ['pipi'], args: '[@mention]', desc: "Photo de profil (pipi, groupe & privé)" },
      { groupe: '📸 Médias', noms: ['.qr'], args: '[texte]', desc: 'Générer un QR code' },
      { groupe: '📸 Médias', noms: ['.image', '.img'], args: '[mot-clé]', desc: "Image sur n'importe quel sujet (Google / web)" },
      { groupe: '📸 Médias', noms: ['.imagine', '.gen'], aff: '.imagine', args: '[description]', desc: "Image créée par l'IA" },
      { groupe: '📸 Médias', noms: ['.voc'], args: '[texte]', desc: "Je dis ton texte en vocal (voix d'homme grave)" },
      { groupe: '📸 Médias', noms: ['.voc-f'], args: '[texte]', desc: "Je dis ton texte en vocal (voix de femme)" },
      { groupe: '🌐 Utilitaires', noms: ['.translate', '.trad'], args: '[lang] [texte]', desc: 'Traduire un texte' },
      { groupe: '🌐 Utilitaires', noms: ['.dico', '.def', '.dictionnaire'], aff: '.dico', args: '[mot]', desc: 'Dictionnaire en ligne' },
      { groupe: '🌐 Utilitaires', noms: ['ret'], args: '[phrase] (nombre)', desc: 'Répéter une phrase', test: t => t.startsWith('ret ') },
      { groupe: '🎭 Fun & Social', noms: ['.8ball'], args: '[question]', desc: 'Boule de cristal' },
      { groupe: '🎭 Fun & Social', noms: ['.love'], args: '[@mention] [@mention]', desc: "Test d'amour (groupe & privé)" },
      { groupe: '🎭 Fun & Social', noms: ['.mariage'], args: '[@mention]', desc: 'Épouser quelqu\'un' },
      { groupe: '🎭 Fun & Social', noms: ['.divorce'], exact: true, desc: 'Divorcer' },
      { groupe: '🎭 Fun & Social', noms: ['.cerveau', 'cerveau'], aff: '.cerveau', args: '[@mention]', desc: "Scanner l'activité mentale (groupe & privé)", test: t => /^\.?(cerveau|mox)(\s|$)/.test(t) },
      { groupe: '🎭 Fun & Social', noms: ['.hack'], args: '[@mention]', desc: "Simulation de hack (groupe & privé)" },
      { groupe: '🎭 Fun & Social', noms: ['.balance'], args: '[@mention]', desc: 'Jauge Ange ou Démon (groupe & privé)' },
      { groupe: '🎭 Fun & Social', noms: ['.dec', '.mensonge'], args: '[texte]', desc: 'Détecteur de mensonges' },
      { groupe: '🎭 Fun & Social', noms: ['drague', '.drague'], aff: 'drague', args: '[@mention] (nombre)', desc: 'Phrases de drague (3 par défaut, jusqu\'à 10)' },
      { groupe: '🎭 Fun & Social', noms: ['.cute'], args: '[nombre]', desc: 'Compliments extra (10 par défaut, jusqu\'à 20)' },
      { groupe: '🎭 Fun & Social', noms: ['.askwedding'], args: '[@mention]', desc: 'Demande en mariage ❤️' },
      { groupe: '🎭 Fun & Social', noms: ['.routine'], exact: true, desc: 'La routine de mon créateur 🤣' },
      { groupe: '🎭 Fun & Social', noms: ['.gamble', '.gumball'], aff: '.gamble', exact: true, desc: "Quel Gumball es-tu aujourd'hui ? 🎈" },
      { groupe: '🧹 Gestion', noms: ['.del'], exact: true, desc: 'Supprimer pour tout le monde tous tes messages ici' }
    ]
  }
];

const MENU_REGEX = /^(\.menu|menu|\.help|\.aide)(?:\s+(.+)|(\d+))?$/;
const NUM_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const EMOJIS_REACTION = ['😌', '💅', '🗿', '🧼', '🤦', '🫶', '🤳', '🎗️'];

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

// 🎨 ═══════════════════════════════════════════════════════════
// MENUS DYNAMIQUES : accueil, catégories 1 / 2 / 3 et « .menu all »
// La légende est recalculée à chaque appel (grade, progression, heure, humeur du bot…).
// Elle reste sous la limite de légende WhatsApp : si un détail ne tient pas, il est simplifié.
// ═══════════════════════════════════════════════════════════
const LIMITE_LEGENDE = 1000;

const HUMEURS_BOT = [
  "je suis en forme aujourd'hui, profitez-en 😎",
  "mode multitâche activé, je gère tout en même temps 🧠",
  "un peu fatigué(e) mais toujours là pour vous 😴",
  "prêt à balancer des commandes à la chaîne 🚀",
  "je tourne sur mon petit serveur avec amour ❤️",
  "de bonne humeur, faut pas abuser quand même 😌",
  "en mode sérieux… enfin presque 🤖",
  "je compte les commandes que vous tapez, juste pour voir 👀"
];

const DESC_CATEGORIES = {
  identite: 'Profil, blaze et grade VIP',
  moderation: 'Gestion du groupe et sécurité',
  outils: 'Vocaux, IA, Jeux, Drague & Utilitaires'
};

function tenirDansLimite(texte) {
  return texte.length <= LIMITE_LEGENDE ? texte : texte.slice(0, LIMITE_LEGENDE - 1) + '…';
}

function boiteMenu(titre, lignes) {
  return [`╭━━〔 ${titre} 〕━━╮`, ...lignes.map(l => `┃ ${l}`), '╰━━━━━━━━━━━━━━━━━━━━━━━╯'].join('\n');
}

function salutationMenu(heure) {
  if (heure >= 5 && heure < 12) return 'Bonjour';
  if (heure >= 12 && heure < 18) return 'Bon après-midi';
  if (heure >= 18 && heure < 22) return 'Bonsoir';
  return 'Bonne nuit';
}

// Lignes de profil : salutation, grade, progression vers le grade suivant, heure, humeur du bot
function lignesProfil(nom, jid) {
  const { heure, date } = heureLocale();
  const nb = statsCommandes[jid] || 0;
  let grade = GRADES[0];
  let suivant = null;
  GRADES.forEach((g, i) => { if (nb >= g[0]) { grade = g; suivant = GRADES[i + 1] || null; } });
  const progression = suivant
    ? `${barre(Math.round(((nb - grade[0]) / (suivant[0] - grade[0])) * 100), 8)} → ${suivant[1]} dans ${suivant[0] - nb} cmd`
    : `${barre(100, 8)} 🏆 grade maximum atteint`;
  return [
    `🌟 ${salutationMenu(heure)} *${nom}* !`,
    `🎖️ Grade : ${grade[1]} · ${nb} commande(s) tapée(s)`,
    `📈 ${progression}`,
    `🕒 ${date} · ${data.botPrivateMode ? '🔒 Privé' : '🔓 Public'}`,
    `⏱️ En ligne depuis ${dureeLisible(process.uptime())}`,
    `🎭 _${alea(HUMEURS_BOT)}_`
  ];
}

// Corps d'une catégorie, dans le niveau de détail demandé
function rendreCategorie(cat, niveau) {
  const lignes = [];
  let groupe = null;
  for (const c of cat.cmds) {
    if (c.groupe && c.groupe !== groupe) { lignes.push(`\n*${c.groupe}*`); groupe = c.groupe; }
    const nomCmd = `*${afficherNomCommande(c)}*${c.args ? ` ${c.args}` : ''}`;
    if (niveau === 'complet') lignes.push(`▫️ ${nomCmd}${c.owner ? ' 👑' : ''}\n   ↳ ${c.desc}`);
    else if (niveau === 'court') lignes.push(`▫️ ${nomCmd} — ${c.desc}`);
    else lignes.push(`▫️ *${afficherNomCommande(c)}*`);
  }
  return lignes.join('\n');
}

function legendeAccueil(nom, jid) {
  const blocs = CATEGORIES_MENU.map((cat, i) =>
    `${NUM_EMOJIS[i]} ${cat.emoji} *${cat.titre}* · ${cat.cmds.length} cmd\n   ↳ ${DESC_CATEGORIES[cat.id]}`
  ).join('\n\n');
  return tenirDansLimite([
    boiteMenu('⚡ *TITAN BOT SYSTEM* ⚡', lignesProfil(nom, jid)),
    '',
    '📂 *MENU PRINCIPAL*',
    blocs,
    '',
    '💡 Tape *.menu 1*, *.menu 2* ou *.menu 3* pour ouvrir une catégorie',
    `✨ Astuce : ${alea(ASTUCES_MENU)}`
  ].join('\n'));
}

function legendeCategorie(i, nom) {
  const cat = CATEGORIES_MENU[i];
  const prev = ((i - 1 + CATEGORIES_MENU.length) % CATEGORIES_MENU.length) + 1;
  const next = ((i + 1) % CATEGORIES_MENU.length) + 1;
  const entete = boiteMenu(`${cat.emoji} *${cat.titre.toUpperCase()}*`, [
    `👋 ${nom} · ${cat.cmds.length} commande(s)`,
    cat.note ? `⚠️ ${cat.note}` : `🕒 ${heureLocale().date}`
  ]);
  const pied = `↩️ *.menu* accueil · ◀️ *.menu ${prev}* · ▶️ *.menu ${next}*`;
  // Le plus de détails possible : on descend d'un niveau seulement si le texte ne tient pas
  for (const niveau of ['complet', 'court', 'noms']) {
    const texte = [entete, '', rendreCategorie(cat, niveau), legendeBadges(cat.cmds), '', pied].join('\n');
    if (texte.length <= LIMITE_LEGENDE) return texte;
  }
  return tenirDansLimite([entete, '', rendreCategorie(cat, 'noms'), '', pied].join('\n'));
}

function legendeTout(nom) {
  const entete = boiteMenu('📚 *TOUTES LES COMMANDES*', [
    `👋 ${nom} · ${nbCommandes()} commande(s)`,
    `🕒 ${heureLocale().date}`
  ]);
  const blocs = CATEGORIES_MENU.map((cat, i) =>
    `${NUM_EMOJIS[i]} ${cat.emoji} *${cat.titre.toUpperCase()}*\n${rendreCategorie(cat, 'noms')}`
  ).join('\n\n');
  return tenirDansLimite([entete, '', blocs, '', '↩️ *.menu* : accueil'].join('\n'));
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
function construireMenu(texte, nom, jid) {
  const m = (texte || '').trim().toLowerCase().match(MENU_REGEX);
  if (!m) return null;
  const arg = normaliserTexte(m[2] || m[3] || '');

  if (!arg) return { texte: legendeAccueil(nom, jid), cat: null };
  if (['all', 'tout', 'tous', 'full'].includes(arg)) return { texte: legendeTout(nom), cat: null };

  if (/^\d+$/.test(arg)) {
    const i = parseInt(arg, 10) - 1;
    if (i >= 0 && i < CATEGORIES_MENU.length) return { texte: legendeCategorie(i, nom), cat: i };
    return { texte: `❓ La catégorie *${arg}* n'existe pas.\n\n${legendeAccueil(nom, jid)}`, cat: null };
  }

  const iCat = CATEGORIES_MENU.findIndex(c => normaliserTexte(c.id) === arg || (arg.length >= 3 && normaliserTexte(c.titre).includes(arg)));
  if (iCat >= 0) return { texte: legendeCategorie(iCat, nom), cat: iCat };

  const sansPoint = arg.replace(/^\./, '');
  for (let ci = 0; ci < CATEGORIES_MENU.length; ci++) {
    const cat = CATEGORIES_MENU[ci];
    for (const c of cat.cmds) {
      if (c.noms.some(n => { const k = normaliserTexte(n).replace(/^\./, ''); return k === sansPoint || k.split(' ')[0] === sansPoint; })) {
        return { texte: menuCommande(cat, c), cat: ci };
      }
    }
  }
  return { texte: `❓ Je ne trouve ni catégorie ni commande « ${arg} ».\n\n${legendeAccueil(nom, jid)}`, cat: null };
}

// 🖼️ Envoi du menu en UN SEUL message : image ou vidéo, avec le texte dynamique en légende
async function envoyerMenu(sock, remoteJid, msg, resultat) {
  let media = null;
  if (typeof resultat.cat === 'number') {
    const img = choisirImageMenu(resultat.cat);
    if (img) media = { type: 'image', buffer: img };
  } else if (MENU_VIDEO) {
    media = { type: 'video', buffer: MENU_VIDEO };
  } else if (MENU_IMAGES.length) {
    media = { type: 'image', buffer: alea(MENU_IMAGES) };
  }
  if (!media) return envoyerAvecDelai(sock, remoteJid, { text: resultat.texte }, { quoted: msg }, 'menu');

  const legende = tenirDansLimite(resultat.texte);
  const contenu = media.type === 'video'
    ? { video: media.buffer, caption: legende }
    : { image: media.buffer, caption: legende };
  return envoyerAvecDelai(sock, remoteJid, contenu, { quoted: msg }, 'media');
}

// ═══════════════════════════════════════════════════════════
// 🎯 CIBLE D'UNE COMMANDE (mention, message cité, ou la personne du chat privé)
// ═══════════════════════════════════════════════════════════
function trouverCible(msg, remoteJid, repliPrive = false, autreJid = null) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (ctx?.mentionedJid?.length) return ctx.mentionedJid[0];
  // En groupe seulement : en privé, le « participant » d'une réponse peut être le compte du bot
  if (ctx?.quotedMessage && ctx.participant && remoteJid.endsWith('@g.us')) return ctx.participant;
  if (repliPrive && !remoteJid.endsWith('@g.us')) return autreJid || remoteJid;
  return null;
}

// 🎯 Cible des commandes « fiche sur quelqu'un » (cerveau, balance, pp, hack, love) :
// - mention ou message cité si présent ;
// - en groupe : la personne qui a tapé la commande ;
// - en privé : TOUJOURS la personne avec qui le bot discute (jamais le compte du bot),
//   que la commande soit tapée par le bot ou par l'interlocuteur.
function cibleCommande(msg, sock, remoteJid, senderJid) {
  const mention = trouverCible(msg, remoteJid, false);
  if (mention) return mention;
  return remoteJid.endsWith('@g.us') ? senderJid : remoteJid;
}

// 🙋 Qui a lancé la commande : en groupe = l'expéditeur ; en privé = moi (si je l'ai envoyée) ou la personne du chat
function acteurDe(msg, sock, remoteJid, senderJid) {
  if (remoteJid.endsWith('@g.us')) return senderJid;
  return msg.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : remoteJid;
}
// 👥 En privé : l'autre personne du chat (celle qui n'a pas lancé la commande)
function autreDe(msg, sock, remoteJid) {
  return msg.key.fromMe ? remoteJid : sock.user.id.split(':')[0] + '@s.whatsapp.net';
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
  "au lycée", "dans le groupe WhatsApp, devant tous les témoins 📱",
  "chez maman, avec sa bénédiction 🏠", "sur le toit d'un immeuble, vue sur la ville 🌇", "à la mairie du cœur 🏛️"
];
const CELEBRANTS = [
  "Mr Alloh", "Azo", "le DJ de la cérémonie 🎧",
  "L'ex très jaloux", "Saïtama⚡🔥💯"
];
const TEMOINS = [
  "le chat du voisin 🐈", "un vendeur d'alloco 🍌", "le gardien de l'immeuble 💂",
  "gardien du lycée", "la tantie du coin, qui sait tout 👵", "personne😌💅"
];
const CADEAUX_MARIAGE = [
  "un ventilateur qui fait un peu de bruit 🌀", "un casier de jus de bissap 🧃", "une grande marmite 🍲",
  "Un itel A16 1Go ram", "un chocoto noir😸", "un sachet de piment 🌶️",
  "ballon d'or"
];
const LUNES_DE_MIEL = [
  "Grand-Bassam 🏖️", "Assinie 🌴", "Yamoussoukro 🏛️", "Dans la chambre", "Nul part y'a pas djai🥲😭",
  "Au guétho", "chez les voisins qui est l'ex jaloux🤣", "Paris (sur Google Maps) 🗼"
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

  // Deux personnes mentionnées : on les marie entre elles (l'auteur n'est pas ajouté)
  // Une seule mention (ou message cité) : l'auteur et la personne visée
  const mentionnes = [...new Set(msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [])]
    .filter(j => j !== botNumber);
  let a;
  let b;
  if (mentionnes.length >= 2) {
    a = mentionnes[0];
    b = mentionnes[1];
  } else {
    a = senderJid;
    b = trouverCible(msg, remoteJid, true, autreDe(msg, sock, remoteJid));
  }

  if (!b) return rep("⚠️ Mentionne une ou deux personnes !\nExemple : *.mariage @A @B* (ou *.mariage @personne* pour te marier avec elle)");
  if (b === a) return rep("⚠️ Tu ne peux pas marier quelqu'un avec lui-même ! L'amour de soi c'est bien, mais là c'est trop 🤣");
  if (b === botNumber || a === botNumber) return rep("🤖💔 Désolé, je suis déjà marié à mon code source. Dur dur la vie de bot…");

  const mien = mariages.get(a);
  if (mien) {
    return rep(`🚫 *BIGAMIE DÉTECTÉE !* 🚨\n\n${nomAffiche(a)} est déjà marié(e) avec ${nomAffiche(mien.conjoint)} depuis ${dureeLisible((Date.now() - mien.ts) / 1000)} !\nFaites d'abord *.divorce* si vous voulez changer 😏`, [a, mien.conjoint]);
  }
  const sien = mariages.get(b);
  if (sien) {
    return rep(`🚫 ${nomAffiche(b)} est déjà marié(e) avec ${nomAffiche(sien.conjoint)} !\nOn ne touche pas au mari/à la femme des autres 😤`, [b, sien.conjoint]);
  }

  const score = entierAlea(50, 100);
  const tier = score >= 90 ? 'parfait' : (score >= 70 ? 'moyen' : 'faible');
  const verdict = alea(COMMENTAIRES_LOVE[tier]);
  const lieu = alea(LIEUX_MARIAGE);
  const { date } = heureLocale();

  mariages.set(a, { conjoint: b, ts: Date.now(), lieu });
  mariages.set(b, { conjoint: a, ts: Date.now(), lieu });

  const nomA = nomAffiche(a);
  const nomB = nomAffiche(b);
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
  return rep(texte, [a, b]);
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
  // En groupe : mention ou message cité. En privé : la personne avec qui le bot discute (jamais le bot).
  const cibleJid = isGroup ? trouverCible(msg, remoteJid, false) : remoteJid;

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
😂 *Amusement à part c'est réel hyn* 🥲`;
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
  const cibleJid = trouverCible(msg, remoteJid, true, autreDe(msg, sock, remoteJid));
  if (!cibleJid) {
    return rep("⚠️ Mentionne la personne à draguer !\nExemple : *drague @personne* (ou *drague @personne 3* pour 3 phrases)");
  }
  if (draguesEnCours.has(remoteJid)) {
    return rep("⏳ Une séance de drague est déjà en cours ici, patience !");
  }

  // On retire d'abord les mentions (@2250...) pour ne lire que le nombre de phrases demandé
  const mNombre = cleanText.replace(/@\d+/g, '').trim().match(/\(?\s*(\d+)\s*\)?\s*$/);
  const nb = Math.max(1, Math.min(10, mNombre ? parseInt(mNombre[1], 10) : 3));
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
        const options = i === 0 ? sansCitationSupprimee({ quoted: msg }) : {};
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

// 🎈 ═══════════════════════════════════════════════════════════
// 🎈 GUMBALL DU JOUR (commande .gumball, groupe & privé)
// ═══════════════════════════════════════════════════════════
const GUMBALL_IMAGE = (() => {
  try {
    const chemin = path.join(__dirname, 'media', 'gumball.jpg');
    return fs.existsSync(chemin) ? fs.readFileSync(chemin) : null;
  } catch (e) { return null; }
})();
// 🎬 Vidéo spéciale « Yasmine » (fichier media/yasmine.mp4)
const YASMINE_VIDEO = (() => {
  try {
    const chemin = path.join(__dirname, 'media', 'yasmine.mp4');
    return fs.existsSync(chemin) ? fs.readFileSync(chemin) : null;
  } catch (e) { return null; }
})();

// 🎈 Commentaire selon le Gumball choisi (1 à 16) : d'après l'expression du tableau
const COMMENTAIRES_GUMBALL = {
  1: "😳 Les yeux ronds et la bouche ouverte… t'as vu un fantôme, ou tu viens de réaliser le prix du pain ? 🍞",
  2: "😳 Joues rouges et regard gêné… t'as fait quelque chose dont tu n'es pas trop fier(e) 🫣",
  3: "😮‍💨 Bouche grande ouverte, yeux plissés… tu bâilles ou tu cries ? Dans les deux cas, va dormir 😴",
  4: "😁 Grand sourire un peu forcé… t'as un plan dans la tête, toi. Je le sens 😏",
  5: "😢 Les larmes aux yeux… même Gumball te comprend. Courage, ça va passer 🥲",
  6: "😤 Tu cries sur tout le monde aujourd'hui ? Respire, le monde n'est pas contre toi 😠",
  7: "😱 Yeux ronds et dents qui sortent… mode panique activé 😨",
  8: "😱 Bouche grande ouverte, yeux écarquillés… t'as vu la facture d'électricité ? 💡",
  9: "😭 Tu pleures à chaudes larmes… viens, on en parle. Je suis là 🫂",
  10: "😬 Dents serrées, regard noir… tu tiens le coup ou tu fais semblant ? 😤",
  11: "😵‍💫 Yeux qui louchent et langue dehors… t'es encore en mode « pas réveillé(e) » ? ☕",
  12: "😖 Yeux fermés très fort… t'as mangé quelque chose de périmé ? 🤢",
  13: "😠 Front froncé, mâchoire serrée… ne me dis pas qu'on t'a marché sur les pieds 😤",
  14: "🤪 Cheveux en bataille et langue qui pend… c'est toi le plus fou du groupe 🤪",
  15: "😒 Regard blasé… on a bien compris que t'es pas impressionné(e) 🙄",
  16: "😪 Paupières lourdes… t'as besoin d'une sieste, et c'est pas une question ! 😴",
};

const gumballEnAttente = new Map();   // "chat|personne" -> date limite (10 min) pour répondre avec un numéro
const cleGumball = (remoteJid, acteur) => `${remoteJid}|${acteur}`;

async function commandeGumball(sock, msg, remoteJid, acteur) {
  const texte = "Sélectionne ton Gumball d'aujourd'hui 👇\nRéponds avec son numéro (1 à 16) 😜";
  const contenu = GUMBALL_IMAGE ? { image: GUMBALL_IMAGE, caption: texte } : { text: texte };
  await envoyerAvecDelai(sock, remoteJid, contenu, { quoted: msg }, 'media');
  gumballEnAttente.set(cleGumball(remoteJid, acteur), Date.now() + 10 * 60 * 1000);
}

// Renvoie true si le message était un numéro de Gumball (1 à 16) attendu de cette personne
async function gererNumeroGumball(sock, msg, remoteJid, acteur, cleanText) {
  const cle = cleGumball(remoteJid, acteur);
  const expire = gumballEnAttente.get(cle);
  if (!expire) return false;
  if (expire < Date.now()) { gumballEnAttente.delete(cle); return false; }
  const saisie = cleanText.trim();
  if (!/^\d{1,2}$/.test(saisie)) return false;
  const numero = parseInt(saisie, 10);
  if (numero < 1 || numero > 16) return false;
  gumballEnAttente.delete(cle);
  await envoyerAvecDelai(sock, remoteJid, { text: `🎈 *Gumball n°${numero}*\n${COMMENTAIRES_GUMBALL[numero]}` }, { quoted: msg }, 'texte');
  return true;
}

// 👋 ACCUEIL AUTOMATIQUE : premier message d'une personne en privé (une fois par jour)
// → « Salut » puis la photo Gumball avec la question ; les deux envois se suivent sans interruption
const DERNIER_ACCUEIL = new Map();   // jid -> date du dernier accueil
const DELAI_ACCUEIL_MS = 24 * 60 * 60 * 1000;

function accueilAutomatique(sock, msg, jid) {
  if (Date.now() - (DERNIER_ACCUEIL.get(jid) || 0) < DELAI_ACCUEIL_MS) return;
  DERNIER_ACCUEIL.set(jid, Date.now());

  const nom = profilsJoueurs[jid] || msg.pushName || '';
  const salut = `Salut${nom ? ` *${nom}*` : ''} 👋 Moi c'est *TITAN*, ton bot 😎\nTape *.menu* pour découvrir tout ce que je sais faire !`;
  const questionGumball = "🎈 *Quel Gumball es-tu aujourd'hui ?*\nRéponds avec son numéro (1 à 16) 😜";
  const gumball = GUMBALL_IMAGE ? { image: GUMBALL_IMAGE, caption: questionGumball } : { text: questionGumball };

  commencerEnvoi(sock, jid);
  enFile(jid, async () => {
    try {
      await envoyerUnPas(sock, jid, { text: salut }, {}, 'texte');
      await envoyerUnPas(sock, jid, gumball, {}, 'media');
      gumballEnAttente.set(cleGumball(jid, jid), Date.now() + 10 * 60 * 1000);
    } catch (err) {
      console.error('⚠️ Accueil automatique :', err);
    } finally {
      finirEnvoi(sock, jid);
    }
  });
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

  commencerEnvoi(sock, remoteJid);
  let buffer = null;
  let source = '';
  const etapes = genererSeulement
    ? [['🎨 Image volée sur internet🤣🤣🤣', imageGeneree]]
    : [["Chat GPT c'est mon petit c'est lui qui fait tous mes wé et puis il est au chômage pour compléter 🤣😌", imageGoogle], ["De la mm maniere tu as ces photos 😌 moi aussi j'ai des photos de toi 👁️👁️👄💅", imageOpenverse], ['Genéree par mon petit Chat GPT 😌💅', imageGeneree]];

  for (const [nomSource, fonction] of etapes) {
    try {
      buffer = await fonction(q);
    } catch (e) {
      console.error(`⚠️ Image (${nomSource}) :`, e.message);
      buffer = null;
    }
    if (buffer) { source = nomSource; break; }
  }

  finirEnvoi(sock, remoteJid);
  if (!buffer) return rep(`Bon toi mm là c'est quelle recherche ça là genre tu me vois en quoi mm 🤦🏼‍♀️ « ${q} ». Faut réessayer plus tard vilain là 💅`);
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

// 💘 .love : en groupe, avec une ou deux mentions (ou un message cité) ; en privé, sur la personne du chat.
// Le compte du bot n'est jamais évalué.
async function commandeLove(sock, msg, remoteJid, senderJid) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const mentions = ctx?.mentionedJid || [];
  const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  const estGroupe = remoteJid.endsWith('@g.us');

  let a = null;
  let b = null;
  if (mentions.length >= 2) { a = mentions[0]; b = mentions[1]; }
  else if (mentions.length === 1) { a = estGroupe ? senderJid : remoteJid; b = mentions[0]; }
  else if (ctx?.quotedMessage && ctx.participant) { a = estGroupe ? senderJid : remoteJid; b = ctx.participant; }
  else if (!estGroupe) { a = remoteJid; }
  if (b === botNumber) b = null;

  if (!a) {
    return envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Mentionne une ou deux personnes !\nExemple : *.love @personne* ou *.love @A @B*" }, { quoted: msg }, 'texte');
  }

  const score = entierAlea(0, 100);
  const tier = score >= 80 ? 'parfait' : (score >= 45 ? 'moyen' : 'faible');

  // Une seule personne (chat privé ou une seule cible) : on évalue la personne seule
  if (!b || b === a) {
    const texte =
`💘 *TEST D'AMOUR* 💘
━━━━━━━━━━━━━━━
👤 ${nomAffiche(a)}

💖 ${barre(score)}
💬 ${alea(COMMENTAIRES_LOVE[tier])}

💡 *Conseil :* ${alea(CONSEILS_LOVE)}`;
    return envoyerAvecDelai(sock, remoteJid, { text: texte, mentions: [a] }, { quoted: msg }, 'texte');
  }

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

// La cible (cible) est fournie par l'appelant : cibleCommande() (groupe = auteur/mention, privé = interlocuteur)
async function commandeCerveau(sock, msg, remoteJid, cible) {
  const lignes = DONNEES_CERVEAU.map(l => `${l.trim()}\n   ${barre(entierAlea(0, 100))}`);
  const texte = `🧠 *SCANNER CÉRÉBRAL* 🧠\n👤 ${nomAffiche(cible)}\n━━━━━━━━━━━━━━━\n${lignes.join('\n')}\n━━━━━━━━━━━━━━━\n🩺 *Diagnostic :* ${alea(COMMENTAIRES_CERVEAU)}`;
  return envoyerAvecDelai(sock, remoteJid, { text: texte, mentions: [cible] }, { quoted: msg }, 'texte');
}

async function commandeBalance(sock, msg, remoteJid, cible) {
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

  // 🏷️ Noms pour les logs : contacts enregistrés dans le téléphone et sujets des groupes
  sock.ev.on('contacts.upsert', (liste) => liste.forEach(memoriserContact));
  sock.ev.on('contacts.update', (liste) => liste.forEach(memoriserContact));
  sock.ev.on('messaging-history.set', ({ contacts }) => (contacts || []).forEach(memoriserContact));
  sock.ev.on('groups.upsert', (liste) => liste.forEach(g => {
    if (g.id) groupesConnus.set(g.id, { nom: g.subject || 'Groupe sans nom', expire: Date.now() + DUREE_CACHE_GROUPE_MS });
  }));
  sock.ev.on('groups.update', (liste) => liste.forEach(g => {
    if (g.id && g.subject) groupesConnus.set(g.id, { nom: g.subject, expire: Date.now() + DUREE_CACHE_GROUPE_MS });
  }));

  // 👁️ Vue unique : listener dédié
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
      } else {
        // Fermeture inattendue (ex : jumelage refusé ou coupé) : on relance pour ne pas rester bloqué
        console.log("🔄 Fermeture inattendue, nouvelle tentative dans 10 secondes...");
        setTimeout(() => startBot().catch(e => console.error('❌ Erreur redémarrage :', e)), 10000);
      }
    } else if (connection === 'open') {
      console.log('⚡ TITAN BOT PRÊT ET CONNECTÉ !');
    }
  });

  if (!sock.authState.creds.registered) {
    const rawNumber = process.env.PHONE_NUMBER || "225XXXXXXXXXX";
    const phoneNumber = rawNumber.replace(/[^0-9]/g, "");
    if (!process.env.PHONE_NUMBER || phoneNumber.length < 10 || rawNumber.includes('X')) {
      console.error(`⚠️ PHONE_NUMBER invalide ou absent (valeur utilisée : « ${phoneNumber} »). Mets ton numéro complet avec l'indicatif, ex : 2250700000000, dans les variables Render.`);
    }
    console.log(`📞 Jumelage demandé pour le numéro : +${phoneNumber}`);

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

  // 🛡 DÉTECTION DES MESSAGES SUPPRIMÉS (ANTI-DELETE)
  // Les messages que TOI (le compte du bot) supprimes ne sont jamais renvoyés : seulement ceux des autres.
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      const estSupprime = (update.update && update.update.message === null) || update.update?.protocolMessage?.type === 0;
      if (!estSupprime) continue;

      // 🚫 Suppression faite par toi
      if (update.key.fromMe) continue;

      const deletedId = update.key.id;
      const cachedMsg = messageCache[deletedId];
      if (!cachedMsg) continue;

      // 🚫 Message qui t'appartient (sécurité supplémentaire)
      const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      if (cachedMsg.fromMe || cachedMsg.sender === botNumber) continue;

      const remoteJid = update.key.remoteJid;
      const sender = cachedMsg.sender;
      const senderName = profilsJoueurs[sender] || `@${sender.split('@')[0]}`;

      const alertText = `🚨 *ANTI-DELETE😌 : MESSAGE SUPPRIMÉ DÉTECTÉ ! T'ES SURPRIS 🤣* 🚨\n👤 *Auteur :* ${senderName}\n📅 *Date :* ${cachedMsg.fdate || 'Récemment'}\n`;

      try {
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
      } catch (e) {
        console.error('⚠️ Anti-delete : envoi impossible :', e && e.message ? e.message : e);
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message) return;
      if (msg.key && msg.key.fromMe && !msg.message.protocolMessage) memoriserMonEnvoi(msg.key.remoteJid, msg.key);

      if (msg.key.fromMe && processedMessages.has(msg.key.id)) return;

      const messageId = msg.key.id;
      if (processedMessages.has(messageId)) return;
      processedMessages.add(messageId);
      if (processedMessages.size > 2000) processedMessages.clear();

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');
      const senderJid = isGroup ? (msg.key.participant || remoteJid) : remoteJid;

      if (utilisateursMutes.has(senderJid)) {
        await journaliserMessage(sock, msg, { muet: true });
        return;
      }

      const timestamp = msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now();
      const formattedDate = new Date(timestamp).toLocaleString('fr-FR', {
        dateStyle: 'short',
        timeStyle: 'medium'
      });

      const cleanTextLog = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
      await journaliserMessage(sock, msg);

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

      // 🧹 Commande lancée par le propriétaire : le message tapé est effacé tout de suite
      if (isFromBot && msg.key.fromMe && (/^\.[a-z0-9]/i.test(cleanText) || estCommandeReconnue(lowerText))) {
        await effacerMessage(sock, remoteJid, msg.key);
      }

      let storedContent = msg.message;
      if (storedContent?.ephemeralMessage) storedContent = storedContent.ephemeralMessage.message;
      if (storedContent?.viewOnceMessageV2) storedContent = storedContent.viewOnceMessageV2.message;
      if (storedContent?.viewOnceMessage) storedContent = storedContent.viewOnceMessage.message;

      // Anti-delete : uniquement les messages texte (pas les photos, vidéos ni vocaux, pour économiser la RAM)
      const textToCache = storedContent.conversation || storedContent.extendedTextMessage?.text || "";

      if (textToCache) {
        messageCache[messageId] = {
          sender: senderJid,
          fromMe: !!msg.key.fromMe,
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
          await envoyerAvecDelai(sock, remoteJid, { text: "🔒 *Je suis passé en mode privé\nFaut pas me deranger*👄" }, { quoted: msg }, 'texte');
        } else {
          data.botPrivateMode = false;
          refusPriveDeja.clear();
          await envoyerAvecDelai(sock, remoteJid, { text: "🔓 *Mode privé désactivé\nIls vont encore une fois abuser de moi 😭🤦🏼‍♀️*" }, { quoted: msg }, 'texte');
        }
        return;
      }

      if (data.botPrivateMode === undefined) {
        data.botPrivateMode = true;
      }

      // 📖 Le dictionnaire reste accessible même en mode privé
      const acteurCourant = acteurDe(msg, sock, remoteJid, senderJid);
      const commandeAutorisee = /^\.(dico|def|dictionnaire|gamble|gumball)(\s|$)/.test(lowerText)
        || lowerText.trim() === 'yasmine'
        || (gumballEnAttente.has(cleGumball(remoteJid, acteurCourant)) && /^\d{1,2}$/.test(cleanText.trim()));
      if (data.botPrivateMode && !isFromBot && !commandeAutorisee) {
        if (cleanText === '2010') {
          data.botPrivateMode = false;
          refusPriveDeja.clear();
          await envoyerAvecDelai(sock, remoteJid, { text: "🔓 *Code secret correct !*" }, { quoted: msg }, 'texte');
        } else if (!refusPriveDeja.has(senderJid)) {
          // Une seule fois par personne : ensuite silence total, même si elle insiste
          refusPriveDeja.add(senderJid);
          await envoyerAvecDelai(sock, remoteJid, { text: "🤖 en mode privé🔒\nattendez un instant il vous reviendra ☺️" }, { quoted: msg }, 'texte');
        }
        return;
      }

      // 👋 Accueil automatique : salut puis photo Gumball, pour toute personne qui écrit en privé
      if (!isGroup && !isFromBot) accueilAutomatique(sock, msg, remoteJid);

      if (await gererReponseMariage(sock, remoteJid, senderJid, lowerText)) return;

      if (/^\.cute(\s|$)/.test(lowerText)) { await commandeCute(sock, msg, remoteJid, cleanText); return; }
      if (/^\.askwedding(\s|$)/.test(lowerText)) { await commandeAskWedding(sock, msg, remoteJid, acteurDe(msg, sock, remoteJid, senderJid)); return; }
      if (/^\.routine$/.test(lowerText)) { await commandeRoutine(sock, msg, remoteJid); return; }
      if (/^\.del$/.test(lowerText)) {
        if (!isFromBot) return;
        await commandeDel(sock, remoteJid);
        return;
      }

      if (lowerText.startsWith('.wedding') || lowerText.startsWith('.mariage')) {
        await commandeMariage(sock, msg, remoteJid, acteurDe(msg, sock, remoteJid, senderJid));
        return;
      }

      if (lowerText === '.divorce') {
        await commandeDivorce(sock, msg, remoteJid, senderJid);
        return;
      }

      if (['.kick', '.promote', '.demote', '.warn', '.mute', '.unmute'].some(cmd => lowerText.startsWith(cmd))) {
        if (!isFromBot) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠ Réservé au propriétaire du bot !" }, { quoted: msg }, 'texte');
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

      if (/^\.(imagine|gen)(\s|$)/.test(lowerText)) {
        await commandeImage(sock, msg, remoteJid, cleanText, true);
        return;
      }

      if (/^\.(image|img)(\s|$)/.test(lowerText)) {
        await commandeImage(sock, msg, remoteJid, cleanText, false);
        return;
      }

      if (/^\.hack(\s|$)/.test(lowerText)) {
        await commandeHack(sock, msg, remoteJid, acteurDe(msg, sock, remoteJid, senderJid), isGroup, cleanText);
        return;
      }

      if (/^\.?drague(\s|$)/.test(lowerText)) {
        await commandeDrague(sock, msg, remoteJid, acteurDe(msg, sock, remoteJid, senderJid), cleanText);
        return;
      }

      if (lowerText.trim() === 'yasmine' && YASMINE_VIDEO) {
        await envoyerAvecDelai(sock, remoteJid, { video: YASMINE_VIDEO, mimetype: 'video/mp4', caption: '🎬 *Yasmine* 💅' }, { quoted: msg }, 'media');
        return;
      }

      if (/^\.(gamble|gumball)$/.test(lowerText)) {
        await commandeGumball(sock, msg, remoteJid, acteurCourant);
        return;
      }

      if (await gererNumeroGumball(sock, msg, remoteJid, acteurCourant, cleanText)) return;

      if (/^\.(dico|def|dictionnaire)(\s|$)/.test(lowerText)) {
        await commandeDico(sock, msg, remoteJid, cleanText);
        return;
      }

      if (/^\.(dec|mensonge)(\s|$)/.test(lowerText)) {
        await commandeMensonge(sock, msg, remoteJid, cleanText);
        return;
      }

      if (/^\.(fiche|rang)(\s|$)/.test(lowerText)) {
        await commandeFiche(sock, msg, remoteJid, acteurDe(msg, sock, remoteJid, senderJid));
        return;
      }

      if (/^\.balance(\s|$)/.test(lowerText)) {
        await commandeBalance(sock, msg, remoteJid, cibleCommande(msg, sock, remoteJid, senderJid));
        return;
      }

      if (/^\.?(cerveau|mox)(\s|$)/.test(lowerText)) {
        await commandeCerveau(sock, msg, remoteJid, cibleCommande(msg, sock, remoteJid, senderJid));
        return;
      }

      const nomMembre = profilsJoueurs[senderJid] || msg.pushName || 'Membre VIP';
      const resultatMenu = construireMenu(cleanText, nomMembre, senderJid);
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

        profilsJoueurs[senderJid] = nomEntre;

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

      if (/^\.voc-f(\s|$)/.test(lowerText)) {
        await commandeVocF(sock, msg, remoteJid, cleanText);
        return;
      }

      if (/^(\.pp|\.p|pipi)(\s|$)/.test(lowerText)) {
        const cible = cibleCommande(msg, sock, remoteJid, senderJid);
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

    } catch (err) {
      console.error("⚠️ Erreur :", err);
      try { if (sock) arreterComposing(sock, m.messages[0]?.key?.remoteJid); } catch (e) {}
    }
  });
}

startBot();
