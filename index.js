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

// 🛡️ Fonction d'envoi sécurisée : lecture du message (coches bleues), "en train d'écrire…", puis envoi
async function envoyerAvecDelai(sock, remoteJid, content, options = {}, typeAction = 'texte') {
  return enFile(remoteJid, async () => {
    try {
      const texte = typeof content === 'string' ? content : (content.text || content.caption || "");
      const delaiMs = calculerDelaiEnvoi(texte, typeAction);

      await passerEnLigne(sock);

      // Un humain lit d'abord le message avant de répondre
      if (options.quoted && options.quoted.key) {
        await sleep(entierAlea(600, 1800));
        try { await sock.readMessages([options.quoted.key]); } catch (e) {}
      }

      let intervalComposing = null;
      try {
        await sock.sendPresenceUpdate('composing', remoteJid);

        intervalComposing = setInterval(async () => {
          try {
            await sock.sendPresenceUpdate('composing', remoteJid);
          } catch (e) {}
        }, 4000);

        await sleep(delaiMs);
      } catch (e) {} finally {
        if (intervalComposing) clearInterval(intervalComposing);
        try {
          await sock.sendPresenceUpdate('paused', remoteJid);
        } catch (e) {}
      }

      const sentMsg = await sock.sendMessage(remoteJid, content, options);
      if (sentMsg && sentMsg.key && sentMsg.key.id) {
        processedMessages.add(sentMsg.key.id);
      }
      return sentMsg;
    } catch (err) {
      console.error("⚠ Erreur d'envoi :", err);
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
// VUE UNIQUE — PHOTOS UNIQUEMENT (module dédié)[span_2](start_span)[span_2](end_span)
// ═══════════════════════════════════════════════════════════
const baileysLib = require('@whiskeysockets/baileys');
const VU_AUTO = (process.env.VUE_UNIQUE_AUTO || 'on').trim().toLowerCase() !== 'off';
const VU_DEST = (process.env.VUE_UNIQUE_DEST || 'chat').trim().toLowerCase();
const VU_DEBUG = ['1', 'true', 'on'].includes((process.env.VU_DEBUG || '').trim().toLowerCase());
const VU_MAX_CACHE = 20; 
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

async function telechargerPhoto(sock, media, cleMsg) {
  let derniere;
  for (let i = 1; i <= 2; i++) {
    try {
      const stream = await downloadContentFromMessage(media, 'image');
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
        { key: cleMsg, message: { imageMessage: media } },
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

async function envoyerPhoto(sock, cible, cache, texte, options = {}) {
  const res = await sock.sendMessage(cible, { image: cache.buffer, caption: texte, mentions: cache.expediteur ? [cache.expediteur] : [] }, options);
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
  if (a.type !== 'image') {
    return;
  }

  const idMsg = msg.key.id;
  if (vuDejaVus.has(idMsg)) return;
  vuDejaVus.add(idMsg);
  if (vuDejaVus.size > 500) vuDejaVus.clear();

  const chatJid = msg.key.remoteJid;
  const expediteur = msg.key.participant || chatJid;
  if (utilisateursMutes.has(expediteur)) return;

  let buffer;
  try {
    buffer = await telechargerPhoto(sock, a.media, { remoteJid: chatJid, id: idMsg, participant: msg.key.participant, fromMe: false });
  } catch (e) {
    return;
  }

  const fdate = new Date(lireTimestamp(msg.messageTimestamp)).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
  const cache = { buffer, type: 'image', caption: a.media.caption || '', fdate, expediteur };
  memoriserVueUnique(idMsg, chatJid, cache);
  if (!VU_AUTO) return;

  const nom = profilsJoueurs[expediteur] || `@${expediteur.split('@')[0]}`;
  const texte = `🚨👀 *VUE UNIQUE INTERCEPTÉE PAR TITAN !* 📸\n👤 *Envoyée par :* ${nom}\n📅 *Date :* ${fdate}${cache.caption ? `\n📝 *Légende :* ${cache.caption}` : ''}\n✨ _Aucune cachette possible ici 😈_`;
  const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  const cible = VU_DEST === 'moi' ? botNumber : chatJid;

  try {
    await envoyerPhoto(sock, cible, cache, texte, cible === chatJid ? { quoted: msg } : {});
  } catch (e) {
    try {
      await envoyerPhoto(sock, cible, cache, texte, {});
    } catch (e2) {}
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
    if (a.type === 'image' && a.aCle) {
      try {
        const buffer = await telechargerPhoto(sock, a.media, { remoteJid, id: idCite, participant: ctx.participant, fromMe: false });
        cache = { buffer, type: 'image', caption: a.media.caption || '', fdate: null, expediteur: ctx.participant || null };
        memoriserVueUnique(idCite, remoteJid, cache);
      } catch (e) {}
    }
  }

  if (!cache && !citee) cache = vueUniqueCache[vueUniqueCache['dernier:' + remoteJid]];

  if (!cache) {
    await repondre("⚠️ Je n'ai aucune photo en vue unique à te renvoyer.");
    return;
  }

  const nom = cache.expediteur ? (profilsJoueurs[cache.expediteur] || `@${cache.expediteur.split('@')[0]}`) : null;
  const texte = `🔓 *VUE UNIQUE RÉCUPÉRÉE* 🥷${nom ? `\n👤 *Envoyée par :* ${nom}` : ''}`;
  await envoyerAvecDelai(sock, remoteJid, { image: cache.buffer, caption: texte, mentions: cache.expediteur ? [cache.expediteur] : [] }, { quoted: msg }, 'media');
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

// 📚 REGISTRE DES COMMANDES[span_3](start_span)[span_3](end_span)
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
      { groupe: '📸 Médias', noms: ['.v'], desc: 'Revoir une photo en vue unique' },
      { groupe: '📸 Médias', noms: ['.pp', '.p'], aff: '.pp', args: '[@mention]', desc: "Photo de profil" },
      { groupe: '📸 Médias', noms: ['pipi'], args: '[@mention]', desc: "Photo de profil (pipi)" },
      { groupe: '📸 Médias', noms: ['.qr'], args: '[texte]', desc: 'Générer un QR code' },
      { groupe: '📸 Médias', noms: ['.image', '.img'], args: '[mot-clé]', desc: "Image sur n'importe quel sujet (Google / web)" },
      { groupe: '📸 Médias', noms: ['.imagine', '.gen'], aff: '.imagine', args: '[description]', desc: "Image créée par l'IA" },
      { groupe: '🌐 Utilitaires', noms: ['.translate', '.trad'], args: '[lang] [texte]', desc: 'Traduire un texte' },
      { groupe: '🌐 Utilitaires', noms: ['.dico', '.def', '.dictionnaire'], aff: '.dico', args: '[mot]', desc: 'Dictionnaire en ligne' },
      { groupe: '🌐 Utilitaires', noms: ['ret'], args: '[phrase] (nombre)', desc: 'Répéter une phrase', test: t => t.startsWith('ret ') },
      { groupe: '🎭 Fun & Social', noms: ['.8ball'], args: '[question]', desc: 'Boule de cristal' },
      { groupe: '🎭 Fun & Social', noms: ['.love'], args: '[@mention] [@mention]', desc: "Test d'amour" },
      { groupe: '🎭 Fun & Social', noms: ['.mariage'], args: '[@mention]', desc: 'Épouser quelqu\'un' },
      { groupe: '🎭 Fun & Social', noms: ['.divorce'], exact: true, desc: 'Divorcer' },
      { groupe: '🎭 Fun & Social', noms: ['.confession'], args: '[texte]', desc: 'Confession anonyme' },
      { groupe: '🎭 Fun & Social', noms: ['.cerveau', 'cerveau'], aff: '.cerveau', args: '[@mention]', desc: "Scanner l'activité mentale", test: t => t.startsWith('cerveau') || t.includes('cerveau') || t.includes('mox') },
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
const EMOJIS_REACTION = ['👍', '💅', '👌', '👄'];

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
      try { await sock.sendPresenceUpdate('paused', remoteJid); } catch (e) {}
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

      if (estCommandeReconnue(lowerText) && !(data.botPrivateMode && !isFromBot)) {
        await reagirCommande(sock, msg);
      }

      if (lowerText === '.private on' || lowerText === '.private off') {
        if (!isFromBot) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Seul le propriétaire du bot peut modifier le mode privé !" }, { quoted: msg }, 'texte');
          return;
        }

        if (lowerText === '.private on') {
          data.botPrivateMode = true;
          await envoyerAvecDelai(sock, remoteJid, { text: "🔒 *Mode privé activé.*" }, { quoted: msg }, 'texte');
        } else {
          data.botPrivateMode = false;
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
          await envoyerAvecDelai(sock, remoteJid, { text: "🔓 *Code secret correct !*" }, { quoted: msg }, 'texte');
        } else {
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

        try {
          const urlApi = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=autodetect|${targetLang}`;
          const response = await axios.get(urlApi);
          const traduction = response.data?.responseData?.translatedText;

          if (traduction) {
            await envoyerAvecDelai(sock, remoteJid, { text: `🌐 *TRADUCTION* : ${traduction}` }, { quoted: msg }, 'texte');
          }
        } catch (e) {}
        return;
      }

      if (lowerText.startsWith('ret ')) {
        const regex = /^ret\s+(.*?)\s*\((\d+)\)$/i;
        const match = cleanText.match(regex);
        if (!match) return;

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

      if (lowerText.startsWith('.dec') || lowerText.startsWith('.mensonge')) {
        const scoreMensonge = Math.floor(Math.random() * 101);
        await envoyerAvecDelai(sock, remoteJid, { text: `🤥 Taux de mytho : ${scoreMensonge}%` }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.fiche') || lowerText.startsWith('.rang')) {
        await envoyerAvecDelai(sock, remoteJid, { text: `🪪 *FICHE D'IDENTITÉ*` }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.balance')) {
        await envoyerAvecDelai(sock, remoteJid, { text: `⚖️ *BALANCE DES ACTIONS*` }, { quoted: msg }, 'texte');
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
        profilsJoueurs[senderJid] = nomEntre;
        await envoyerAvecDelai(sock, remoteJid, { text: `🎉 Profil enregistré !` }, { quoted: msg }, 'texte');
        return;
      }

      if (/^\.v(\s|$)/.test(lowerText)) {
        await commandeVueUnique(sock, msg, remoteJid);
        return;
      }

      if (lowerText.startsWith('.pp') || lowerText.startsWith('.p')) {
        let mention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        let cible = mention || senderJid;
        try {
          const ppUrl = await sock.profilePictureUrl(cible, 'image');
          await envoyerAvecDelai(sock, remoteJid, { image: { url: ppUrl }, caption: `📸 Photo de profil` }, { quoted: msg }, 'media');
        } catch (e) {}
        return;
      }

      if (lowerText.startsWith('.love')) {
        await envoyerAvecDelai(sock, remoteJid, { text: `💖 Test d'amour effectué !` }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.qr')) {
        const contenu = cleanText.replace(/^\.qr\s*/i, '').trim();
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(contenu)}`;
        await envoyerAvecDelai(sock, remoteJid, { image: { url: qrUrl }, caption: `📱 *QR CODE*` }, { quoted: msg }, 'qr');
        return;
      }

      if (lowerText.startsWith('.8ball')) {
        await envoyerAvecDelai(sock, remoteJid, { text: `🎱 *8-BALL*` }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText === '.bombe') return declencherJeuBombe(sock, remoteJid, msg);
      if (lowerText === '.de') return declencherJeuDe(sock, remoteJid, msg);
      if (lowerText.startsWith('.lab')) return declencherJeuLabyrinthe(sock, remoteJid, msg, cleanText);
      if (lowerText === '.feurouge') return declencherJeuFeuRouge(sock, remoteJid, msg, senderJid);
      if (lowerText === '.chiffremystere') return declencherJeuChiffre(sock, remoteJid, msg, senderJid);

      if (lowerText === '.lancer') {
        if (jeu) jeu.statut = 'EN_COURS';
        await envoyerAvecDelai(sock, remoteJid, { text: `🚀 Jeu lancé !` }, { quoted: msg }, 'texte');
        return;
      }

    } catch (err) {
      console.error("⚠️ Erreur :", err);
    }
  });
}

function declencherJeuBombe(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'BOMBE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `💣 Jeu de la bombe` }, { quoted: msg }, 'texte');
}

function declencherJeuDe(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'DE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🎲 Jeu du dé` }, { quoted: msg }, 'texte');
}

function declencherJeuLabyrinthe(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'LABYRINTHE', statut: 'EN_COURS', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🌀 Labyrinthe` }, { quoted: msg }, 'texte');
}

function declencherJeuFeuRouge(sock, remoteJid, msg, senderJid) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'FEU_ROUGE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🔴 Feu rouge` }, { quoted: msg }, 'texte');
}

function declencherJeuChiffre(sock, remoteJid, msg, senderJid) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'CHIFFRE', statut: 'EN_COURS', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🔢 Chiffre mystère` }, { quoted: msg }, 'texte');
}

startBot();
