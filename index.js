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

process.on('uncaughtException', (err) => console.error('⚠️ Erreur évitée :', err));
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
}, 8 * 60 * 1000);

// 📁 GESTIONNAIRE DE SESSION LOCAL
// Sur Render, mets AUTH_DIR=/data/auth_info (disque persistant) sinon la session est perdue à chaque redémarrage
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
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
  
  if (delaiMs < 3500) delaiMs = 3500; // Minimum 3.5 secondes pour que ça fasse naturel
  if (delaiMs > 14000) delaiMs = 14000; // Plafond à 14 secondes pour les très longs textes

  // Ajout d'une variation aléatoire pour imiter parfaitement un humain qui tape et hésite
  return Math.floor(delaiMs + (Math.random() * 2500));
}

// 🛡️ Fonction d'envoi sécurisée avec maintien continu du "composing"
async function envoyerAvecDelai(sock, remoteJid, content, options = {}, typeAction = 'texte') {
  try {
    const texte = typeof content === 'string' ? content : (content.text || content.caption || "");
    const delaiMs = calculerDelaiEnvoi(texte, typeAction);

    let intervalComposing = null;
    try {
      await sock.sendPresenceUpdate('composing', remoteJid);
      
      intervalComposing = setInterval(async () => {
        try {
          await sock.sendPresenceUpdate('composing', remoteJid);
        } catch (e) {}
      }, 4000);

      await new Promise(resolve => setTimeout(resolve, delaiMs));
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
}

function genererBarreHP(hp, maxHp = 100) {
  const totalBlocs = 10;
  const blocsRemplis = Math.max(0, Math.min(totalBlocs, Math.round((hp / maxHp) * totalBlocs)));
  const blocsVides = totalBlocs - blocsRemplis;
  return `[${'█'.repeat(blocsRemplis)}${'░'.repeat(blocsVides)}] ${hp}/${maxHp}`;
}

// 👁️ ═══════════════════════════════════════════════════════════
// VUE UNIQUE — PHOTOS UNIQUEMENT (module dédié)
// ═══════════════════════════════════════════════════════════
// Variables Render (toutes optionnelles) :
//   VUE_UNIQUE_AUTO = "on" (défaut) : chaque photo en vue unique reçue est renvoyée automatiquement en photo normale
//                   = "off"         : le bot la garde en mémoire et ne la renvoie que si tu réponds ".v" dessus
//   VUE_UNIQUE_DEST = "chat" (défaut) : renvoi dans la conversation d'origine / "moi" : dans ton propre chat
//   VU_DEBUG        = "1" : écrit dans les logs la structure (jamais le contenu) des médias reçus, pour comprendre un blocage
const baileysLib = require('@whiskeysockets/baileys');
const VU_AUTO = (process.env.VUE_UNIQUE_AUTO || 'on').trim().toLowerCase() !== 'off';
const VU_DEST = (process.env.VUE_UNIQUE_DEST || 'chat').trim().toLowerCase();
const VU_DEBUG = ['1', 'true', 'on'].includes((process.env.VU_DEBUG || '').trim().toLowerCase());
const VU_MAX_CACHE = 20; // nombre max de photos gardées en RAM (important sur Render)
const vuDejaVus = new Set();
const vuOrdre = [];

// Déballe les enveloppes WhatsApp (éphémère, vue unique V1 / V2 / V2Extension...) et garde le chemin parcouru.
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

// Décrit ce que contient un message (sans jamais lire son contenu privé) : type de média, vue unique ou non,
// et si WhatsApp a bien transmis les données nécessaires pour le télécharger (clé + adresse).
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

// Télécharge la photo. Si le lien a expiré, on demande au téléphone de la renvoyer (reuploadRequest).
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

// Interception automatique à la réception d'une photo en vue unique.
async function traiterVueUnique(sock, msg) {
  if (!msg) return;
  if (!msg.message) {
    if (VU_DEBUG) console.log(`[VU-DEBUG] message sans contenu lisible (stub=${msg.messageStubType} ${JSON.stringify(msg.messageStubParameters || [])}) de ${(msg.key && (msg.key.participant || msg.key.remoteJid)) || '?'}`);
    return;
  }
  if (msg.key && msg.key.fromMe) return;

  const a = analyserMedia(msg.message);
  if (VU_DEBUG && a.type) console.log(`[VU-DEBUG] ${resumerStructure(a)}`);
  if (!a.type || !a.viewOnce) return;
  if (a.type !== 'image') {
    console.log(`[VU] ${a.type === 'video' ? 'Vidéo' : 'Audio'} en vue unique ignoré (seules les photos sont traitées).`);
    return;
  }

  const idMsg = msg.key.id;
  if (vuDejaVus.has(idMsg)) return;
  vuDejaVus.add(idMsg);
  if (vuDejaVus.size > 500) vuDejaVus.clear();

  const chatJid = msg.key.remoteJid;
  const expediteur = msg.key.participant || chatJid;
  if (utilisateursMutes.has(expediteur)) return;

  console.log(`[VU] Photo en vue unique détectée | de ${expediteur} | dans ${chatJid}`);
  if (!a.aCle) {
    console.warn("[VU] ⚠️ WhatsApp n'a pas transmis les données de cette photo à l'appareil du bot : impossible de la télécharger.");
    return;
  }

  let buffer;
  try {
    buffer = await telechargerPhoto(sock, a.media, { remoteJid: chatJid, id: idMsg, participant: msg.key.participant, fromMe: false });
  } catch (e) {
    console.error('[VU] ❌ Téléchargement de la photo impossible :', (e && e.message) || e);
    return;
  }

  const fdate = new Date(lireTimestamp(msg.messageTimestamp)).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
  const cache = { buffer, type: 'image', caption: a.media.caption || '', fdate, expediteur };
  memoriserVueUnique(idMsg, chatJid, cache);
  if (!VU_AUTO) { console.log('[VU] Photo gardée en mémoire (envoi automatique désactivé).'); return; }

  const nom = profilsJoueurs[expediteur] || `@${expediteur.split('@')[0]}`;
  const texte = `🚨👀 *VUE UNIQUE INTERCEPTÉE PAR TITAN !* 📸\n👤 *Envoyée par :* ${nom}\n📅 *Date :* ${fdate}${cache.caption ? `\n📝 *Légende :* ${cache.caption}` : ''}\n✨ _Aucune cachette possible ici 😈_`;
  const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  const cible = VU_DEST === 'moi' ? botNumber : chatJid;

  try {
    await envoyerPhoto(sock, cible, cache, texte, cible === chatJid ? { quoted: msg } : {});
    console.log('[VU] ✅ Photo renvoyée en vue normale.');
  } catch (e) {
    console.error('[VU] Envoi avec citation échoué, nouvel essai sans citation :', (e && e.message) || e);
    try {
      await envoyerPhoto(sock, cible, cache, texte, {});
      console.log('[VU] ✅ Photo renvoyée en vue normale (sans citation).');
    } catch (e2) {
      console.error('[VU] ❌ Envoi impossible :', (e2 && e2.message) || e2);
    }
  }
}

// Commande .v : réponds à une photo en vue unique avec ".v" pour la recevoir en photo normale.
async function commandeVueUnique(sock, msg, remoteJid) {
  const { content } = deballerMessage(msg.message);
  const ctx = content && content.extendedTextMessage && content.extendedTextMessage.contextInfo;
  const idCite = ctx && ctx.stanzaId;
  const citee = ctx && ctx.quotedMessage;
  const repondre = (texte) => envoyerAvecDelai(sock, remoteJid, { text: texte }, { quoted: msg }, 'texte');

  let cache = idCite ? vueUniqueCache[idCite] : null;
  let diag = '';

  if (!cache && citee) {
    const a = analyserMedia(citee);
    if (a.type === 'video' || a.type === 'audio') {
      await repondre(`📸 Je ne traite que les *photos* en vue unique. Ce message est ${a.type === 'video' ? 'une vidéo' : 'un audio'}.`);
      return;
    }
    if (a.type === 'image' && a.aCle) {
      try {
        const buffer = await telechargerPhoto(sock, a.media, { remoteJid, id: idCite, participant: ctx.participant, fromMe: false });
        cache = { buffer, type: 'image', caption: a.media.caption || '', fdate: null, expediteur: ctx.participant || null };
        memoriserVueUnique(idCite, remoteJid, cache);
      } catch (e) {
        diag = `Téléchargement impossible : ${(e && e.message) || e}`;
      }
    } else if (a.type === 'image') {
      diag = "WhatsApp n'a pas transmis les données de cette photo au bot. Elle n'a pas pu être captée quand elle a été envoyée (bot hors ligne à ce moment-là ?).";
    } else {
      diag = "Le message auquel tu réponds n'est pas une photo.";
    }
    diag += `\n🧾 ${resumerStructure(a)}`;
  }

  if (!cache && !citee) cache = vueUniqueCache[vueUniqueCache['dernier:' + remoteJid]];

  if (!cache) {
    await repondre(
      "⚠️ Je n'ai aucune photo en vue unique à te renvoyer.\n" +
      "👉 Réponds directement à la photo en vue unique avec `.v`.\n" +
      "ℹ️ Le bot ne garde en mémoire que les photos reçues pendant qu'il est en ligne." +
      (diag ? `\n\n${diag}` : '')
    );
    return;
  }

  const nom = cache.expediteur ? (profilsJoueurs[cache.expediteur] || `@${cache.expediteur.split('@')[0]}`) : null;
  const texte = `🔓 *VUE UNIQUE RÉCUPÉRÉE* 🥷${nom ? `\n👤 *Envoyée par :* ${nom}` : ''}${cache.fdate ? `\n📅 *Capturée le :* ${cache.fdate}` : ''}${cache.caption ? `\n📝 *Légende :* ${cache.caption}` : ''}`;
  const envoye = await envoyerAvecDelai(sock, remoteJid, { image: cache.buffer, caption: texte, mentions: cache.expediteur ? [cache.expediteur] : [] }, { quoted: msg }, 'media');
  if (!envoye) {
    await repondre("⚠️ J'ai la photo mais l'envoi a échoué. Réessaie dans un instant (détails dans les logs).");
  }
}

// À appeler une seule fois par socket, juste après sa création.
function installerVueUnique(sock) {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // ignore l'historique synchronisé
    for (const msg of messages) {
      try {
        await traiterVueUnique(sock, msg);
      } catch (e) {
        console.error('[VU] Erreur inattendue :', e);
      }
    }
  });
}
// ═══════════════════════════════════════════════════════════ FIN MODULE VUE UNIQUE

// 📚 ═══════════════════════════════════════════════════════════
// REGISTRE DES COMMANDES + MENUS DYNAMIQUES + RÉACTIONS
// ═══════════════════════════════════════════════════════════
// Pour ajouter une commande au menu ET lui donner la réaction emoji : ajoute simplement une ligne dans la bonne catégorie.
//   noms   : noms reconnus (le premier est celui affiché ; les autres sont des alias)
//   args   : arguments affichés dans le menu          desc : description
//   exact  : true si la commande ne doit être reconnue que seule (sans texte après)
//   test   : fonction(texte) optionnelle pour une détection spéciale
//   admin  : true = réservé aux admins/bot (🔒)         owner : true = propriétaire du bot (👑)
//   aff    : texte affiché à la place des noms           groupe : sous-titre de section dans la catégorie
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
      { noms: ['.private on', '.private off'], exact: true, aff: '.private', args: 'on | off', desc: "Verrouiller / déverrouiller le bot pour tout le monde", owner: true }
    ]
  },
  {
    id: 'outils', emoji: '🛠️', titre: 'Outils & Tech',
    cmds: [
      { groupe: '📸 Médias', noms: ['.v'], desc: 'Revoir une photo en vue unique (réponds à la photo avec .v)' },
      { groupe: '📸 Médias', noms: ['.pp', '.p'], aff: '.pp', args: '[@mention]', desc: "Photo de profil d'un membre" },
      { groupe: '📸 Médias', noms: ['pipi'], args: '[@mention]', desc: "Photo de profil de la personne mentionnée (ou la tienne)" },
      { groupe: '📸 Médias', noms: ['.qr'], args: '[texte]', desc: 'Générer un QR code personnalisé' },
      { groupe: '📸 Médias', noms: ['.image', '.img'], args: '[mot-clé]', desc: "Recherche d'image" },
      { groupe: '🌐 Utilitaires', noms: ['.translate', '.trad'], args: '[lang] [texte]', desc: 'Traduire un texte (ou un message cité)' },
      { groupe: '🌐 Utilitaires', noms: ['ret'], args: '[phrase] (nombre)', desc: 'Répéter une phrase (10 fois max)', test: t => t.startsWith('ret ') },
      { groupe: '🎭 Fun & Social', noms: ['.8ball'], args: '[question]', desc: 'Boule de cristal magique' },
      { groupe: '🎭 Fun & Social', noms: ['.love'], args: '[@mention] [@mention]', desc: "Test d'amour & aura du crew" },
      { groupe: '🎭 Fun & Social', noms: ['.mariage'], args: '[@mention]', desc: 'Épouser virtuellement quelqu\'un' },
      { groupe: '🎭 Fun & Social', noms: ['.divorce'], exact: true, desc: 'Rompre son mariage virtuel' },
      { groupe: '🎭 Fun & Social', noms: ['.confession'], args: '[texte]', desc: 'Envoyer une confession anonyme' },
      { groupe: '🎭 Fun & Social', noms: ['.cerveau', 'cerveau'], aff: '.cerveau', args: '[@mention]', desc: "Scanner l'activité mentale", test: t => t.startsWith('cerveau') || t.includes('cerveau') || t.includes('mox') },
      { groupe: '🎭 Fun & Social', noms: ['.hack'], args: '[@mention]', desc: "Simulation d'infiltration Dark Web" },
      { groupe: '🎭 Fun & Social', noms: ['.balance'], args: '[@mention]', desc: 'Jauge Ange ou Démon' },
      { groupe: '🎭 Fun & Social', noms: ['.dec', '.mensonge'], args: '[texte]', desc: 'Analyseur de mensonges' },
      { groupe: '🎭 Fun & Social', noms: ['drague'], args: '[@mention]', desc: 'Une rafale de phrases de drague' }
    ]
  },
  {
    id: 'jeux', emoji: '🎮', titre: 'Zone de Combat (Jeux)',
    cmds: [
      { noms: ['.bombe'], exact: true, desc: 'Désamorçage tactique' },
      { noms: ['.de'], exact: true, desc: 'Le jet de dés du destin' },
      { noms: ['.lab'], args: '[solo|duo|equipe]', desc: 'Labyrinthe (10 étapes)' },
      { noms: ['.feurouge'], exact: true, desc: 'Squid Game (jeu du feu rouge)' },
      { noms: ['.chiffremystere'], exact: true, desc: 'Le code secret (1 à 100)' },
      { noms: ['.pf', '.pileouface'], exact: true, aff: '.pf', desc: 'Pile ou face rapide' }
    ]
  },
  {
    id: 'equipe', emoji: '⚙️', titre: "Gestion d'Équipe",
    cmds: [
      { noms: ['.joindre'], args: '[A/B]', desc: 'Rejoindre une équipe' },
      { noms: ['.lancer'], exact: true, desc: 'Activer le protocole de départ' },
      { noms: ['.restart'], exact: true, desc: 'Relancer le dernier round' },
      { noms: ['.stop'], exact: true, desc: 'Couper net la session active' }
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

// ✅ Une commande est "reconnue" si elle figure dans le registre (donc dans le menu) ou si c'est une demande de menu.
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

// 😎 Réaction aléatoire sur le message de la commande, avant la réponse habituelle.
async function reagirCommande(sock, msg) {
  try {
    const emoji = EMOJIS_REACTION[Math.floor(Math.random() * EMOJIS_REACTION.length)];
    const res = await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });
    if (res && res.key && res.key.id) processedMessages.add(res.key.id);
  } catch (e) {
    console.error('[REACT] Réaction impossible :', (e && e.message) || e);
  }
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
  return `${ent}\n\n📂 *CATÉGORIES*\n${liste}\n\n💡 Tape *.menu 1* (ou *.menu1*) pour ouvrir une catégorie\n📜 *.menu all* : tout afficher\n🔎 *.menu kick* : le détail d'une commande`;
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

// Retourne le texte du menu demandé, ou null si le message n'est pas une demande de menu.
function construireMenu(texte, nom) {
  const m = (texte || '').trim().toLowerCase().match(MENU_REGEX);
  if (!m) return null;
  const arg = normaliserTexte(m[2] || m[3] || '');

  if (!arg) return menuHub(nom);
  if (['all', 'tout', 'tous', 'full'].includes(arg)) return menuTout(nom);

  if (/^\d+$/.test(arg)) {
    const i = parseInt(arg, 10) - 1;
    if (i >= 0 && i < CATEGORIES_MENU.length) return menuCategorie(i);
    return `❓ La catégorie *${arg}* n'existe pas (1 à ${CATEGORIES_MENU.length}).\n\n${menuHub(nom)}`;
  }

  const iCat = CATEGORIES_MENU.findIndex(c => normaliserTexte(c.id) === arg || (arg.length >= 3 && normaliserTexte(c.titre).includes(arg)));
  if (iCat >= 0) return menuCategorie(iCat);

  const sansPoint = arg.replace(/^\./, '');
  for (const cat of CATEGORIES_MENU) {
    for (const c of cat.cmds) {
      if (c.noms.some(n => { const k = normaliserTexte(n).replace(/^\./, ''); return k === sansPoint || k.split(' ')[0] === sansPoint; })) return menuCommande(cat, c);
    }
  }
  return `❓ Je ne trouve ni catégorie ni commande « ${arg} ».\n\n${menuHub(nom)}`;
}
// ═══════════════════════════════════════════════════════════ FIN REGISTRE & MENUS

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
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  sock.ev.on('creds.update', saveCreds);

  // 👁️ Vue unique : listener dédié
  installerVueUnique(sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || "";
      console.log(`❌ Connexion fermée. Code : ${statusCode} | Erreur :${errorMessage}`);

      // On n'efface la session que si WhatsApp a vraiment déconnecté l'appareil (loggedOut).
      // 515 = redémarrage normal juste après le jumelage ; 440 = session ouverte ailleurs (ex: 2 instances Render en même temps).
      if (statusCode === DisconnectReason.loggedOut) {
        console.log("❌ Appareil déconnecté depuis WhatsApp. Nettoyage de la session...");
        await clearSession();
      }

      const delaiReconnexion = statusCode === 440 ? 30000 : 5000;
      console.log(`🔄 Tentative de reconnexion dans ${delaiReconnexion / 1000} secondes...`);
      setTimeout(() => startBot(), delaiReconnexion);
    } else if (connection === 'open') {
      console.log('⚡ TITAN BOT PRÊT ET CONNECTÉ !');
    }
  });

  if (!sock.authState.creds.registered) {
    const rawNumber = process.env.PHONE_NUMBER || "2250594208423";
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

  // 🛡 DÉTECTION DES MESSAGES SUPPRIMÉS (ANTI-DELETE)
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

      // Date formatée (fdate)
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

      // 👁️ L'interception des vues uniques est gérée par installerVueUnique(sock) (listener dédié, plus haut).

      // 📥 MISE EN CACHE OPTIMISÉE (ANTI-DELETE TEXTE & PHOTOS)
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
        } catch (e) {
          console.error("⚠ Erreur mise en cache image anti-delete :", e);
        }
      } else if (textToCache) {
        messageCache[messageId] = {
          sender: senderJid,
          text: textToCache,
          fdate: formattedDate
        };
      }

      // 🛡️ SÉCURITÉ ANTI-SATURATION RAM : 50 derniers éléments max
      const cacheKeys = Object.keys(messageCache);
      if (cacheKeys.length > 50) {
        delete messageCache[cacheKeys[0]];
      }

      if (!cleanText) return;

      // 😎 RÉACTION EMOJI : si la commande est reconnue, le bot réagit (👍 💅 👌 👄) puis répond comme d'habitude
      if (estCommandeReconnue(lowerText) && !(data.botPrivateMode && !isFromBot)) {
        await reagirCommande(sock, msg);
      }

      // 🛡️ GESTION DU MODE PRIVÉ (.private on / .private off)
      if (lowerText === '.private on' || lowerText === '.private off') {
        if (!isFromBot) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Seul le propriétaire du bot peut modifier le mode privé !" }, { quoted: msg }, 'texte');
          return;
        }

        if (lowerText === '.private on') {
          data.botPrivateMode = true;
          await envoyerAvecDelai(sock, remoteJid, { text: "🔒 *Mode privé activé :* Le bot est maintenant verrouillé. Seul vous pouvez l'utiliser !" }, { quoted: msg }, 'texte');
        } else {
          data.botPrivateMode = false;
          await envoyerAvecDelai(sock, remoteJid, { text: "🔓 *Mode privé désactivé :* Le bot est de nouveau accessible à tout le monde !" }, { quoted: msg }, 'texte');
        }
        return;
      }

      if (data.botPrivateMode === undefined) {
        data.botPrivateMode = true;
      }

      if (data.botPrivateMode && !isFromBot) {
        if (cleanText === '2010') {
          data.botPrivateMode = false;
          await envoyerAvecDelai(sock, remoteJid, { text: "🔓 *Code secret correct !* Le bot est maintenant déverrouillé, tu peux discuter 😌✨" }, { quoted: msg }, 'texte');
        } else {
          await envoyerAvecDelai(sock, remoteJid, { text: "Je ne te répondrai pas, Andy est absent ❌.\nTrouve le code secret pour pouvoir discuter avec moi 😌" }, { quoted: msg }, 'texte');
        }
        return; 
      }

      // 🤫 COMMANDE CONFESSION ANONYME (.confession)
      if (lowerText.startsWith('.confession')) {
        const confessionText = cleanText.replace(/^\.confession\s*/i, '').trim();
        if (!confessionText) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️️ Tu dois écrire ta confession après la commande !\nExemple : `.confession J'avoue que...`" }, { quoted: msg }, 'texte');
          return;
        }

        // Tente de supprimer le message de l'utilisateur dans le groupe pour garder l'anonymat
        if (isGroup) {
          try {
            await sock.sendMessage(remoteJid, { delete: msg.key });
          } catch (e) {}
        }

        const messageConfession = `🤫 *CONFESSION ANONYME* 🤫\n\n"${confessionText}"\n\n_Quelqu'un du groupe a balancé ça 💀... Devinez qui c'est !_`;
        await envoyerAvecDelai(sock, remoteJid, { text: messageConfession }, {}, 'texte');
        return;
      }

      // 💍 FORMULAIRE DE MARIAGE VIRTUEL (SURBOOSTÉ)
      if (lowerText.startsWith('.mariage')) {
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!mention) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Tu dois mentionner la personne que tu veux épouser !\nExemple : `.mariage @mention`" }, { quoted: msg }, 'texte');
          return;
        }
        if (mention === senderJid) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Tu ne peux pas t'épouser toi-même, gros narcissique ! Va trouver un partenaire 🤣" }, { quoted: msg }, 'texte');
          return;
        }

        const scoreMariage = Math.floor(Math.random() * 51) + 50; 
        const nomUser = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
        const nomCible = profilsJoueurs[mention] || `@${mention.split('@')[0]}`;

        let typeUnion = "Mariage de rêve ✨🥂";
        let verdictUnion = "Un amour indestructible qui va faire des envieux dans tout le groupe !";
        if (scoreMariage < 65) {
          typeUnion = "Mariage sous haute tension ⚡💥";
          verdictUnion = "Ça sent le divorce avant la fin de la semaine, préparez le pop-corn !";
        } else if (scoreMariage >= 85) {
          typeUnion = "Union légendaire absolue 👑💖";
          verdictUnion = "Le couple parfait de l'année, aucun nuage à l'horizon !";
        }

        let texteMariage = `💍 *GRAND CERTIFICAT DE MARIAGE VIRTUEL* 💍\n\n` +
                           `🤵‍♂️ *Époux :* ${nomUser}\n` +
                           `👰‍♀️ *Épouse/Partenaire :* ${nomCible}\n` +
                           `📋 *Type de contrat :* ${typeUnion}\n` +
                           `💖 *Jauge de compatibilité :* ${genererBarreHP(scoreMariage, 100)} (${scoreMariage}%)\n\n` +
                           `🔮 *Diagnostic du grand prêtre Titan :* ${verdictUnion}\n\n` +
                           `🎉 *Félicitations aux tourtereaux !* Tapez \`.divorce\` en cas de catastrophe imminente 📜`;

        await envoyerAvecDelai(sock, remoteJid, { text: texteMariage, mentions: [senderJid, mention] }, { quoted: msg }, 'texte');
        return;
      }

      // 📜 FORMULAIRE DE DIVORCE
      if (lowerText === '.divorce') {
        const nomUser = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
        const motifsDivorce = [
          "Incompatibilité d'humeur flagrante dans le tchat 🛑",
          "Vol de frites virtuelles et trahison suprême 🍟",
          "Vu sans réponse pendant plus de 3 minutes 📱💥",
          "Refuge persistant dans les jeux du bot au lieu de s'occuper de son conjoint 🎮",
          "Partage secret de secrets du groupe avec la concurrence 🕵️‍♂️"
        ];
        const motifChoisi = motifsDivorce[Math.floor(Math.random() * motifsDivorce.length)];

        let texteDivorce = `📜 *TRIBUNAL DES DIVORCES VIRTUELS* 📜\n\n` +
                           `👤 *Demandeur :* ${nomUser}\n` +
                           `⚖️ *Motif officiel :* ${motifChoisi}\n\n` +
                           `💥 *VERDICT :* Le contrat de mariage est déchiré en mille morceaux ! Partage des biens équitable : chacun récupère ses émojis et son célibat.\n\n` +
                           `🏃‍♂️💨 *Statut :* Libre comme l'air !`;

        await envoyerAvecDelai(sock, remoteJid, { text: texteDivorce, mentions: [senderJid] }, { quoted: msg }, 'texte');
        return;
      }

      if (['.kick', '.promote', '.demote', '.warn', '.mute', '.unmute'].some(cmd => lowerText.startsWith(cmd))) {
        if (!isFromBot && !isAdmin) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠ Désolé, ces commandes de modération sont strictement réservées aux administrateurs et au bot !" }, { quoted: msg }, 'texte');
          return;
        }

        const mentionMod = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!mentionMod && !lowerText.startsWith('.unmute')) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Tu dois mentionner un membre ! Exemple : `.kick @mention`" }, { quoted: msg }, 'texte');
          return;
        }

        if (lowerText.startsWith('.kick') && isGroup) {
          try {
            await sock.groupParticipantsUpdate(remoteJid, [mentionMod], "remove");
            await envoyerAvecDelai(sock, remoteJid, { text: `👢 Membre expulsé avec succès par un administrateur.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          } catch (e) {
            await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Erreur : Je n'ai pas les permissions admin pour expulser ce membre." }, {}, 'texte');
          }
          return;
        }

        if (lowerText.startsWith('.promote') && isGroup) {
          try {
            await sock.groupParticipantsUpdate(remoteJid, [mentionMod], "promote");
            await envoyerAvecDelai(sock, remoteJid, { text: `⬆️ Membre promu administrateur avec succès.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          } catch (e) {
            await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Erreur : Impossible de promouvoir ce membre." }, {}, 'texte');
          }
          return;
        }

        if (lowerText.startsWith('.demote') && isGroup) {
          try {
            await sock.groupParticipantsUpdate(remoteJid, [mentionMod], "demote");
            await envoyerAvecDelai(sock, remoteJid, { text: `⬇️ Rôle d'administrateur retiré avec succès.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          } catch (e) {
            await envoyerAvecDelai(sock, remoteJid, { text: "⚠ Erreur : Impossible de rétrograder ce membre." }, {}, 'texte');
          }
          return;
        }

        if (lowerText.startsWith('.warn')) {
          const raisonWarn = cleanText.replace(/^\.warn\s*@[0-9]+\s*/i, '').trim() || "Comportement non conforme";
          await envoyerAvecDelai(sock, remoteJid, { text: `⚠️ *AVERTISSEMENT (WARN)* ⚠️\n\nDestinataire : @${mentionMod.split('@')[0]}\nMotif :${raisonWarn}\n\n_Attention à ta conduite._`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          return;
        }

        if (lowerText.startsWith('.mute')) {
          utilisateursMutes.add(mentionMod);
          await envoyerAvecDelai(sock, remoteJid, { text: `🔇 @${mentionMod.split('@')[0]} a été muté par un administrateur. Le bot va ignorer ses messages.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          return;
        }

        if (lowerText.startsWith('.unmute')) {
          const mentionUnmute = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (mentionUnmute && utilisateursMutes.has(mentionUnmute)) {
            utilisateursMutes.delete(mentionUnmute);
            await envoyerAvecDelai(sock, remoteJid, { text: `🔊 @${mentionUnmute.split('@')[0]} a été démuté. Il peut à nouveau utiliser le bot.`, mentions: [mentionUnmute] }, { quoted: msg }, 'texte');
          } else {
            await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Cette personne n'était pas mutée ou aucune mention valide." }, {}, 'texte');
          }
          return;
        }
      }

      // 🌐 COMMANDE DE TRADUCTION
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
          textToTranslate = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || quotedMsg.imageMessage?.caption || "";
        }

        if (!textToTranslate) {
          await envoyerAvecDelai(sock, remoteJid, { 
            text: "⚠️ Utilisation incorrecte !\nExemple : `.translate en Bonjour tout le monde` ou réponds à un message avec `.trad fr`" 
          }, { quoted: msg }, 'texte');
          return;
        }

        try {
          const urlApi = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=autodetect|${targetLang}`;
          const response = await axios.get(urlApi);
          const traduction = response.data?.responseData?.translatedText;

          if (traduction) {
            const reponseTrad = `🌐 *TRADUCTION (${targetLang.toUpperCase()})* 🌐\n\n💬 *Original :* ${textToTranslate}\n✨ *Traduit :*${traduction}`;
            await envoyerAvecDelai(sock, remoteJid, { text: reponseTrad }, { quoted: msg }, 'texte');
          } else {
            await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Erreur lors de la traduction. Réessaie plus tard." }, { quoted: msg }, 'texte');
          }
        } catch (e) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Impossible de contacter le service de traduction." }, { quoted: msg }, 'texte');
        }
        return;
      }

      // 🔄 COMMANDE RET
      if (lowerText.startsWith('ret ')) {
        const regex = /^ret\s+(.*?)\s*\((\d+)\)$/i;
        const match = cleanText.match(regex);

        if (!match) {
          await envoyerAvecDelai(sock, remoteJid, { 
            text: "⚠️ Format incorrect ! Utilise la syntaxe : `ret [ta phrase] (nombre)`\nExemple : `ret je t'aime (5)`" 
          }, { quoted: msg }, 'texte');
          return;
        }

        const phraseARepeter = match[1].trim();
        let nombreFois = parseInt(match[2], 10);

        if (nombreFois > 10) nombreFois = 10; 
        if (nombreFois <= 0) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Le nombre de répétitions doit être supérieur à 0." }, { quoted: msg }, 'texte');
          return;
        }

        await envoyerAvecDelai(sock, remoteJid, { 
          text: `🔁 C'est parti ! Je vais répéter "${phraseARepeter}" ${nombreFois} fois.` 
        }, { quoted: msg }, 'texte');

        for (let i = 0; i < nombreFois; i++) {
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
          await sock.sendMessage(remoteJid, { text: phraseARepeter });
        }
        return;
      }

      // 👩‍👦 DIALOGUE INTERACTIF "BOTTI & MAMAN"
      if (!sessionsMaman[senderJid]) {
        sessionsMaman[senderJid] = { etape: 0 };
      }
      let sessionM = sessionsMaman[senderJid];

      if (sessionM.etape === 0 && (lowerText.includes("où est mon botti") || lowerText.includes("botti t'es là") || lowerText.includes("botti t'es la"))) {
        const reponsePremiere = Math.random() < 0.5 ? "Oui maman je suis là 🤖😌" : "Maman c'est bien toi 🥹🥰🤖?";
        await envoyerAvecDelai(sock, remoteJid, { text: reponsePremiere }, { quoted: msg }, 'texte');
        
        setTimeout(async () => {
          await envoyerAvecDelai(sock, remoteJid, { text: "Euh maman 🥹 comment tu vas bien j'espère ?" }, {}, 'texte');
        }, 1500);

        sessionM.etape = 1;
        return;
      }
      else if (sessionM.etape === 1 && (lowerText === "oui" || lowerText === "oui mon bb" || lowerText === "oui mon bébé")) {
        await envoyerAvecDelai(sock, remoteJid, { 
          text: "génial je suis content que tu ailles bien 😌❤️‍🩹 moi aussi ça va ma maman chérie 🥹🤖\nen même temps c'est normal papa est drôle 😌\nEuh maman devine quoi 😌" 
        }, { quoted: msg }, 'texte');

        sessionM.etape = 2;
        return;
      }
      else if (sessionM.etape === 2 && (lowerText.includes("quoi mon bb") || lowerText.includes("quoi botti") || lowerText === "quoi")) {
        await envoyerAvecDelai(sock, remoteJid, { 
          text: "Maman je sais pas pourquoi mais je t'aime 💓 plus que papa pour toi seule maman c'est 70% le reste c'est pour papa 😂" 
        }, { quoted: msg }, 'texte');

        setTimeout(async () => {
          await envoyerAvecDelai(sock, remoteJid, { 
            text: "bon maman je suis un peu occupé je vais te laisser 😖 bisous robotique à toi maman 🥹😘❤️ je t'aime bon bye" 
          }, {}, 'texte');
          delete sessionsMaman[senderJid];
        }, 3000);

        sessionM.etape = 0;
        return;
      }

      if (MOTS_AMOUR_PRIVE.includes(lowerText)) {
        await envoyerAvecDelai(sock, remoteJid, { text: REPONSE_AMOUR_MAMAN }, { quoted: msg }, 'texte');
        return;
      }

      const jeu = partiesEnCours[remoteJid];
      demarrerTimerInactivite(sock, remoteJid);

      if (lowerText === '.pf' || lowerText === '.pileouface') {
        const resultat = Math.random() < 0.5 ? "🪙 *PILE !*" : "🪙 *FACE !*";
        await envoyerAvecDelai(sock, remoteJid, { text: resultat }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.image') || lowerText.startsWith('.img')) {
        const queryImg = cleanText.replace(/^\.(image|img)\s*/i, '').trim();
        if (!queryImg) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Précise ce que tu recherches ! Exemple : `.image banane`" }, { quoted: msg }, 'texte');
          return;
        }

        const searchImageUrl = `https://picsum.photos/seed/${encodeURIComponent(queryImg)}/800/600`;
        await envoyerAvecDelai(sock, remoteJid, { image: { url: searchImageUrl }, caption: `🔍 *Résultat pour :* ${queryImg}` }, { quoted: msg }, 'media');
        return;
      }

      if (lowerText.startsWith('.hack')) {
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!mention) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Mentionne la personne à pirater ! Exemple : `.hack @mention`" }, { quoted: msg }, 'texte');
          return;
        }

        const pseudo = `@${mention.split('@')[0]}`;
        const targetIp = `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;

        const { key } = await sock.sendMessage(remoteJid, { text: `👨‍💻 *PIRATAGE EN COURS DE ${pseudo}...*\n[░░░░░░░░░░] 0%` }, { quoted: msg });

        const etapes = [
          { txt: `👨‍💻 *PIRATAGE DE ${pseudo}...*\n📡 Recherche de l'adresse IP... [${targetIp}]\n[██░░░░░░░░] 20%`, delay: 1000 },
          { txt: `👨‍💻 *PIRATAGE DE ${pseudo}...*\n🔓 Contournement du pare-feu WhatsApp...\n[████░░░░░░] 40%`, delay: 1000 },
          { txt: `👨‍💻 *PIRATAGE DE ${pseudo}...*\n📥 Extraction des messages et photos cachées...\n[███████░░░] 70%`, delay: 1000 },
          { txt: `👨‍💻 *PIRATAGE DE ${pseudo}...*\n🌐 Téléversement sur le Dark Web...\n[██████████] 100%`, delay: 1000 },
          { txt: `⚠ *PIRATAGE RÉUSSI DE ${pseudo} !*\n\n📌 *Adresse IP :* ${targetIp}\n🔐 *Mots de passe extraits :* 14\n📸 *Photos récupérées :* 342\n💬 *Conversations envoyées au Dark Web !* 😈`, delay: 500 }
        ];

        for (const step of etapes) {
          await new Promise(res => setTimeout(res, step.delay));
          await sock.sendMessage(remoteJid, { text: step.txt, edit: key, mentions: [mention] });
        }
        return;
      }

      if (lowerText.startsWith('.dec') || lowerText.startsWith('.mensonge')) {
        const texteArg = cleanText.replace(/^\.(dec|mensonge)\s*/i, '').trim();
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        
        let cible = mention ? `@${mention.split('@')[0]}` : (profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`);
        const scoreMensonge = Math.floor(Math.random() * 101);
        const verdictAleatoire = VERDICTS_MENSONGE[Math.floor(Math.random() * VERDICTS_MENSONGE.length)];

        let txt = `🤥 *SCANNER DÉTECTEUR DE MENSONGES* 🤥\n\n`;
        if (texteArg) {
          txt += `💬 *Déclaration :* "${texteArg}"\n`;
        }
        txt += `👤 *Auteur :* ${cible}\n`;
        txt += `📊 *Taux de mytho :* ${genererBarreHP(scoreMensonge, 100)} (${scoreMensonge}%)\n\n`;
        txt += `🎯 *Verdict :* ${verdictAleatoire}`;

        const mentionsTab = mention ? [mention] : [senderJid];
        await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: mentionsTab }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.fiche') || lowerText.startsWith('.rang')) {
        const cible = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || senderJid;
        const nom = profilsJoueurs[cible] || `@${cible.split('@')[0]}`;
        
        const rangs = ["Légende du Groupe", "Fantôme Silencieux", "Roi du Spam", "Boss Final", "Membre Modèle", "Comédien de Service"];
        const rangAttribue = rangs[Math.floor(Math.random() * rangs.length)];
        const qi = Math.floor(Math.random() * 80) + 70;

        const card = `🪪 *FICHE D'IDENTITÉ DU MEMBRE*\n\n` +
          `👤 *Nom :* ${nom}\n` +
          `🎖️ *Rang :* ${rangAttribue}\n` +
          `🧠 *QI Estimé :* ${qi}\n` +
          `⚡ *Statut :* Membre Certifié`;

        await envoyerAvecDelai(sock, remoteJid, { text: card, mentions: [cible] }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.balance')) {
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const cible = mention || senderJid;
        const prenom = `@${cible.split('@')[0]}`;

        const bonneAction = Math.floor(Math.random() * 101);
        const mauvaiseAction = 100 - bonneAction;

        let verdict = "";
        if (bonneAction > mauvaiseAction) {
          verdict = `est un ange 😇 et puis t'es content hein 🤣🤣`;
        } else if (mauvaiseAction > bonneAction) {
          verdict = `est un démon 😈 purée j'y crois même pas !`;
        } else {
          const frasesHasard = [
            "ne sait plus où donner de la tête 😂",
            "a un comportement totalement imprévisible 🤡",
            "plante un bug dans la matrice 🌀",
            "balance une grosse dinguerie au hasard 🤪"
          ];
          verdict = frasesHasard[Math.floor(Math.random() * frasesHasard.length)];
        }

        const texteBalance = `⚖️ *BALANCE DES ACTIONS* ⚖\n\n` +
          `👤 Membre : ${prenom}\n\n` +
          `😌 Bonne action : ${genererBarreHP(bonneAction, 100)} (${bonneAction}%)\n` +
          `😈 Mauvaise action : ${genererBarreHP(mauvaiseAction, 100)} (${mauvaiseAction}%)\n\n` +
          `🔮 *Verdict :* ${prenom}${verdict}`;

        await envoyerAvecDelai(sock, remoteJid, { text: texteBalance, mentions: [cible] }, { quoted: msg }, 'texte');
        return;
      }

      // 🌟 MENUS DYNAMIQUES (générés depuis le registre CATEGORIES_MENU)
      const texteMenu = construireMenu(cleanText, profilsJoueurs[senderJid] || 'Membre VIP');
      if (texteMenu) {
        await envoyerAvecDelai(sock, remoteJid, { text: texteMenu }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText.startsWith('.pseudo')) {
        const nouveauNom = cleanText.replace(/^\.pseudo\s*/i, '').trim();
        if (!nouveauNom) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Précisez votre nouveau nom ! Exemple : `.pseudo Titan`" }, { quoted: msg }, 'texte');
          return;
        }
        profilsJoueurs[senderJid] = nouveauNom;
        await envoyerAvecDelai(sock, remoteJid, { text: `✅ Votre pseudo a été mis à jour : *${nouveauNom}*` }, { quoted: msg }, 'texte');
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

      // 🔓 COMMANDE .V — réponds à une photo en vue unique avec ".v" pour la recevoir en photo normale
      if (/^\.v(\s|$)/.test(lowerText)) {
        await commandeVueUnique(sock, msg, remoteJid);
        return;
      }

      if (lowerText.startsWith('.pp') || lowerText.startsWith('.p')) {
        let mention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        let cible = mention;

        if (!cible && !isGroup) cible = remoteJid;
        if (!cible) cible = senderJid;

        try {
          const ppUrl = await sock.profilePictureUrl(cible, 'image');
          const nomCible = `@${cible.split('@')[0]}`;
          await envoyerAvecDelai(sock, remoteJid, { 
            image: { url: ppUrl }, 
            caption: `🙌👉 Voilà la photo de profil de ${nomCible} 😈😎`, 
            mentions: [cible] 
          }, { quoted: msg }, 'media');
        } catch (e) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Photo de profil introuvable ou masquée par la confidentialité de cette personne." }, { quoted: msg }, 'texte');
        }
        return;
      }

      // 🚽 PIPI — "pipi @mention" = photo de profil de la personne mentionnée ; "pipi" seul = ta propre photo de profil
      if (/^pipi(\s|$)/.test(lowerText)) {
        const ctxPipi = deballerMessage(msg.message).content?.extendedTextMessage?.contextInfo;
        const mentionPipi = ctxPipi?.mentionedJid?.[0];
        const moiJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

        let cible;
        if (mentionPipi) cible = mentionPipi;
        else if (isGroup) cible = msg.key.fromMe ? moiJid : senderJid;
        else cible = remoteJid;

        const nomCible = `@${cible.split('@')[0]}`;
        try {
          const ppUrl = await sock.profilePictureUrl(cible, 'image');
          const legende = mentionPipi
            ? `📸 Voilà la photo de profil de ${nomCible} demandée avec pipi ! 🚽✨`
            : `📸 Voilà ta photo de profil ${nomCible} ! 🚽✨`;
          await envoyerAvecDelai(sock, remoteJid, { image: { url: ppUrl }, caption: legende, mentions: [cible] }, { quoted: msg }, 'media');
        } catch (e) {
          console.error(`[PIPI] Photo de profil de ${cible} introuvable :`, (e && (e.message || e.data)) || e);
          await envoyerAvecDelai(sock, remoteJid, { text: `⚠️ Impossible de récupérer la photo de profil de ${nomCible} : elle n'en a pas, ou elle est masquée par ses paramètres de confidentialité.`, mentions: [cible] }, { quoted: msg }, 'texte');
        }
        return;
      }

      if (lowerText.startsWith('.love')) {
        const mentions = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const score = Math.floor(Math.random() * 101);

        let pool = COMMENTAIRES_LOVE.moyen;
        if (score >= 70) pool = COMMENTAIRES_LOVE.parfait;
        else if (score < 40) pool = COMMENTAIRES_LOVE.faible;
        
        const comm = pool[Math.floor(Math.random() * pool.length)];
        const conseil = CONSEILS_LOVE[Math.floor(Math.random() * CONSEILS_LOVE.length)];

        let txt = `💖 *TEST D'AMOUR & COMPATIBILITÉ* 💖\n\n`;

        if (mentions.length >= 2) {
          const user1 = mentions[0];
          const user2 = mentions[1];
          txt += `👥 Entre *@${user1.split('@')[0]}* et *@${user2.split('@')[0]}*\n`;
          txt += `📊 Jauge : ${genererBarreHP(score, 100)} (${score}%)\n`;
          txt += `💬 *Avis :* ${comm}\n\n`;
          txt += `💡 *Petit conseil :* ${conseil}`;

          await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: [user1, user2] }, { quoted: msg }, 'texte');
          return;
        }

        if (mentions.length === 1) {
          const mention = mentions[0];
          txt += `👤 Entre *@${senderJid.split('@')[0]}* et *@${mention.split('@')[0]}*\n`;
          txt += `📊 Jauge : ${genererBarreHP(score, 100)} (${score}%)\n`;
          txt += `💬 *Avis :* ${comm}\n\n`;
          txt += `💡 *Petit conseil :* ${conseil}`;

          await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: [senderJid, mention] }, { quoted: msg }, 'texte');
          return;
        }

        let diagnosticSolo = "Ton cœur est un havre de paix. Tu es en parfaite harmonie avec toi-même ! ✨";
        if (score < 30) diagnosticSolo = "Cœur en mode ermite. Focus total sur le développement personnel ! 🧘‍♂";
        else if (score < 70) diagnosticSolo = "Aura séduisante ! Un bon équilibre entre indépendance et ouverture aux rencontres ! 😉";
        else diagnosticSolo = "Aura de séduction au maximum ! Ton magnétisme fait des ravages aujourd'hui ! 🔥";

        txt += `👤 *DIAGNOSTIC AMOUR SOLO DE *@${senderJid.split('@')[0]}*\n`;
        txt += `📊 Jauge d'Aura Amoureuse : ${genererBarreHP(score, 100)} (${score}%)\n\n`;
        txt += `⚖️ *Jugement & Diagnostic :* ${diagnosticSolo}`;

        await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: [senderJid] }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.qr')) {
        const contenu = cleanText.replace(/^\.qr\s*/i, '').trim();
        if (!contenu) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Entrez le texte ou l'URL à convertir ! Exemple : `.qr https://google.com`" }, { quoted: msg }, 'texte');
          return;
        }
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(contenu)}`;
        await envoyerAvecDelai(sock, remoteJid, { image: { url: qrUrl }, caption: `📱 *QR CODE GÉNÉRÉ*` }, { quoted: msg }, 'qr');
        return;
      }

      if (lowerText.startsWith('.8ball')) {
        const question = cleanText.replace(/^\.8ball\s*/i, '').trim();
        if (!question) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Pose une question ! Exemple : `.8ball Est-ce que je vais réussir ?`" }, { quoted: msg }, 'texte');
          return;
        }

        const reponse = REPONSES_8BALL[Math.floor(Math.random() * REPONSES_8BALL.length)];
        const nomJ = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;

        const text8Ball = `🎱 *BOULE MAGIQUE 8-BALL* 🎱\n\n❓ *Question de ${nomJ} :* ${question}\n🔮 *Réponse :* ${reponse}`;
        await envoyerAvecDelai(sock, remoteJid, { text: text8Ball, mentions: [senderJid] }, { quoted: msg }, 'texte');
        return;
      }

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
        jeu.equipes.A = jeu.equipes.A.filter(j => j.jid !== senderJid);
        jeu.equipes.B = jeu.equipes.B.filter(j => j.jid !== senderJid);

        jeu.equipes[eq].push({ jid: senderJid, nom: nomJ, elimine: false });
        if (!jeu.joueurs.some(j => j.jid === senderJid)) {
          jeu.joueurs.push({ jid: senderJid, nom: nomJ, elimine: false });
        }

        await envoyerAvecDelai(sock, remoteJid, { text: `✅ *${nomJ}* a rejoint l'*ÉQUIPE ${eq}* !\n\n🔴 Équipe A : ${jeu.equipes.A.length} | 🔵 Équipe B : ${jeu.equipes.B.length}` }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('drague')) {
        let cibleName = cleanText.slice(7).trim();
        if (!cibleName) cibleName = "toi";

        let mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || null;
        let tag = mention ? `@${mention.split('@')[0]}` : cibleName;

        const draguesFormatees = LISTE_DRAGUES.map(phrase => phrase.replace(/@tag/g, tag));

        for (let i = 0; i < draguesFormatees.length; i++) {
          await new Promise(r => setTimeout(r, 400));
          if (mention) {
            await sock.sendMessage(remoteJid, { text: draguesFormatees[i], mentions: [mention] });
          } else {
            await sock.sendMessage(remoteJid, { text: draguesFormatees[i] });
          }
        }

        await new Promise(r => setTimeout(r, 400));
        await sock.sendMessage(remoteJid, { 
          text: `Mission accomplie avec succès 😌🙌 bye ${tag}`, 
          mentions: mention ? [mention] : [] 
        }, { quoted: msg });
        return;
      }

      if (lowerText.startsWith('cerveau') || lowerText.includes('cerveau') || lowerText.includes('mox')) {
        let cibleJid = senderJid;
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (mention) cibleJid = mention;

        const nomCible = profilsJoueurs[cibleJid] || `@${cibleJid.split('@')[0]}`;
        let analyse = `🧠 *ANALYSE MENTALE COMPLÈTE DE ${nomCible.toUpperCase()}* 🧠\n\n`;
        
        DONNEES_CERVEAU.forEach((stat) => {
          const pourcentage = Math.floor(Math.random() * 101);
          analyse += `${stat} :\n${genererBarreHP(pourcentage, 100)} (${pourcentage}%)\n\n`;
        });

        const comm = COMMENTAIRES_CERVEAU[Math.floor(Math.random() * COMMENTAIRES_CERVEAU.length)];
        analyse += `📝 *Diagnostic :* ${comm}`;

        await envoyerAvecDelai(sock, remoteJid, { text: analyse, mentions: [cibleJid] }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText === '.restart') {
        const dernierType = partiesEnCours[remoteJid]?.dernierType || 'DE';
        reinitialiserJeu(remoteJid);
        if (dernierType === 'BOMBE') return declencherJeuBombe(sock, remoteJid, msg);
        if (dernierType === 'DE') return declencherJeuDe(sock, remoteJid, msg);
        if (dernierType === 'LABYRINTHE') return declencherJeuLabyrinthe(sock, remoteJid, msg, { body: '.lab solo' });
        if (dernierType === 'FEU_ROUGE') return declencherJeuFeuRouge(sock, remoteJid, msg, senderJid);
        if (dernierType === 'CHIFFRE') return declencherJeuChiffre(sock, remoteJid, msg, senderJid);
      }

      if (lowerText === '.stop') {
        reinitialiserJeu(remoteJid);
        await envoyerAvecDelai(sock, remoteJid, { text: "🛑 *Partie annulée.* Tapez `.menu` pour relancer un jeu." }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText === '.bombe') return declencherJeuBombe(sock, remoteJid, msg);
      if (lowerText === '.de') return declencherJeuDe(sock, remoteJid, msg);
      if (lowerText.startsWith('.lab')) return declencherJeuLabyrinthe(sock, remoteJid, msg, cleanText);
      if (lowerText === '.feurouge') return declencherJeuFeuRouge(sock, remoteJid, msg, senderJid);
      if (lowerText === '.chiffremystere') return declencherJeuChiffre(sock, remoteJid, msg, senderJid);

      if (lowerText === '.lancer') {
        if (!jeu || (jeu.statut !== 'INSCRIPTION' && jeu.type !== 'FEU_ROUGE')) {
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
                jeu.indexTour = (jeu.indexTour + 1) % restants.length;
                const prochain = restants[jeu.indexTour];
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

      if (['salut', 'bonjour', 'cc', 'hey', 'hello', 'slt', 'bot'].includes(lowerText)) {
        await envoyerAvecDelai(sock, remoteJid, { text: `👋 Salut @${senderJid.split('@')[0]} ! Je suis le bot *Titan*. Tape \`.menu\` pour voir toutes mes commandes et jeux !`, mentions: [senderJid] }, { quoted: msg }, 'texte');
      }

    } catch (err) {
      console.error("⚠️ Erreur globale critique :", err);
    }
  });
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
    if (partiesEnCours[remoteJid] && partiesEnCours[remoteJid].type === 'BOMBE') {
      joueurActuel.elimine = true;
      const restants = jeu.joueurs.filter(j => !j.elimine);

      if (restants.length === 0) {
        partiesEnCours[remoteJid] = { dernierType: 'BOMBE' };
        await envoyerAvecDelai(sock, remoteJid, { text: `💥 *BOOOOOOOM !* perdu 🤣🤣🤣🤣 *${joueurActuel.nom}*...\n💀 Tout a sauté !` }, {}, 'texte');
      } else {
        jeu.indexTour = (jeu.indexTour + 1) % restants.length;
        const prochain = restants[jeu.indexTour];
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
