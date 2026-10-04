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
  
  if (delaiMs < 4500) delaiMs = 4500; // Minimum 4.5 secondes pour que ça fasse naturel
  if (delaiMs > 20000) delaiMs = 20000; // Plafond à 20 secondes pour les très longs textes

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
      { groupe: '📸 Médias', noms: ['.image', '.img'], args: '[mot-clé]', desc: "Recherche d'image" },
      { groupe: '🌐 Utilitaires', noms: ['.translate', '.trad'], args: '[lang] [texte]', desc: 'Traduire un texte' },
      { groupe: '🌐 Utilitaires', noms: ['ret'], args: '[phrase] (nombre)', desc: 'Répéter une phrase', test: t => t.startsWith('ret ') },
      { groupe: '🎭 Fun & Social', noms: ['.8ball'], args: '[question]', desc: 'Boule de cristal' },
      { groupe: '🎭 Fun & Social', noms: ['.love'], args: '[@mention] [@mention]', desc: "Test d'amour" },
      { groupe: '🎭 Fun & Social', noms: ['.mariage'], args: '[@mention]', desc: 'Épouser quelqu\'un' },
      { groupe: '🎭 Fun & Social', noms: ['.divorce'], exact: true, desc: 'Divorcer' },
      { groupe: '🎭 Fun & Social', noms: ['.confession'], args: '[texte]', desc: 'Confession anonyme' },
      { groupe: '🎭 Fun & Social', noms: ['.cerveau', 'cerveau'], aff: '.cerveau', args: '[@mention]', desc: "Scanner l'activité mentale", test: t => t.startsWith('cerveau') || t.includes('cerveau') || t.includes('mox') },
      { groupe: '🎭 Fun & Social', noms: ['.hack'], args: '[@mention]', desc: "Simulation de hack" },
      { groupe: '🎭 Fun & Social', noms: ['.balance'], args: '[@mention]', desc: 'Jauge Ange ou Démon' },
      { groupe: '🎭 Fun & Social', noms: ['.dec', '.mensonge'], args: '[texte]', desc: 'Détecteur de mensonges' },
      { groupe: '🎭 Fun & Social', noms: ['drague'], args: '[@mention]', desc: 'Phrases de drague' }
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

function construireMenu(texte, nom) {
  const m = (texte || '').trim().toLowerCase().match(MENU_REGEX);
  if (!m) return null;
  const arg = normaliserTexte(m[2] || m[3] || '');

  if (!arg) return menuHub(nom);
  if (['all', 'tout', 'tous', 'full'].includes(arg)) return menuTout(nom);

  if (/^\d+$/.test(arg)) {
    const i = parseInt(arg, 10) - 1;
    if (i >= 0 && i < CATEGORIES_MENU.length) return menuCategorie(i);
    return `❓ La catégorie *${arg}* n'existe pas.\n\n${menuHub(nom)}`;
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

  // 👁️ Vue unique : listener dédié[span_4](start_span)[span_4](end_span)
  installerVueUnique(sock);

  // 🛑 BOUCLE DE RECONNEXION AUTOMATIQUE SUPPRIMÉE ICI
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || "";
      console.log(`❌ Connexion fermée. Code : ${statusCode} | Erreur : ${errorMessage}`);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log("❌ Appareil déconnecté depuis WhatsApp. Nettoyage de la session...");
        await clearSession();
      }
      // Aucune tentative de reconnexion automatique programmée.
    } else if (connection === 'open') {
      console.log('⚡ TITAN BOT PRÊT ET CONNECTÉ !');
    }
  });

  if (!sock.authState.creds.registered) {
    const rawNumber = process.env.PHONE_NUMBER || "2250141606159";
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
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!mention) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Tu dois mentionner quelqu'un !" }, { quoted: msg }, 'texte');
          return;
        }
        if (mention === senderJid) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Tu ne peux pas t'épouser toi-même !" }, { quoted: msg }, 'texte');
          return;
        }

        const scoreMariage = Math.floor(Math.random() * 51) + 50; 
        const nomUser = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
        const nomCible = profilsJoueurs[mention] || `@${mention.split('@')[0]}`;

        let texteMariage = `💍 *CERTIFICAT DE MARIAGE* 💍\n\n🤵‍♂️ ${nomUser} & 👰‍♀️ ${nomCible}\n💖 Compatibilité : ${scoreMariage}%`;
        await envoyerAvecDelai(sock, remoteJid, { text: texteMariage, mentions: [senderJid, mention] }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText === '.divorce') {
        const nomUser = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
        await envoyerAvecDelai(sock, remoteJid, { text: `📜 *DIVORCE* 📜\n\n👤 ${nomUser} est de nouveau célibataire !` }, { quoted: msg }, 'texte');
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

      if (lowerText.startsWith('.image') || lowerText.startsWith('.img')) {
        const queryImg = cleanText.replace(/^\.(image|img)\s*/i, '').trim();
        const searchImageUrl = `https://picsum.photos/seed/${encodeURIComponent(queryImg)}/800/600`;
        await envoyerAvecDelai(sock, remoteJid, { image: { url: searchImageUrl }, caption: `🔍 *Résultat :* ${queryImg}` }, { quoted: msg }, 'media');
        return;
      }

      if (lowerText.startsWith('.hack')) {
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!mention) return;
        const pseudo = `@${mention.split('@')[0]}`;
        await envoyerAvecDelai(sock, remoteJid, { text: `👨‍💻 *PIRATAGE RÉUSSI DE ${pseudo} !* 😈`, mentions: [mention] }, { quoted: msg }, 'texte');
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

      const texteMenu = construireMenu(cleanText, profilsJoueurs[senderJid] || 'Membre VIP');
      if (texteMenu) {
        await envoyerAvecDelai(sock, remoteJid, { text: texteMenu }, { quoted: msg }, 'menu');
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
