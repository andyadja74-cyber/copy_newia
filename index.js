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

// ⏱️ SIMULATION DE FRAPPE HUMAINE RÉALISTE
function calculerDelaiEnvoi(texte, typeAction = 'texte') {
  if (typeAction === 'media' || typeAction === 'qr') {
    return 3000; 
  }

  const longueur = texte ? texte.length : 20;
  let delaiMs = longueur * 55; 
  
  if (delaiMs < 3500) delaiMs = 3500;
  if (delaiMs > 14000) delaiMs = 14000;

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
// VUE UNIQUE — module corrigé et renforcé
// ═══════════════════════════════════════════════════════════
const VU_DEST = (process.env.VUE_UNIQUE_DEST || 'chat').toLowerCase();
const VU_MAX_CACHE = 30;
const vuDejaVus = new Set();
const vuOrdre = [];

function extraireVueUnique(message) {
  if (!message) return null;
  
  let content = message;
  // Parcourir les différents niveaux d'encapsulation (ephemeral, viewOnce, etc.)
  for (let i = 0; i < 6 && content; i++) {
    if (content.viewOnceMessage) { content = content.viewOnceMessage.message; continue; }
    if (content.viewOnceMessageV2) { content = content.viewOnceMessageV2.message; continue; }
    if (content.viewOnceMessageV2Extension) { content = content.viewOnceMessageV2Extension.message; continue; }
    if (content.ephemeralMessage) { content = content.ephemeralMessage.message; continue; }
    if (content.documentWithCaptionMessage) { content = content.documentWithCaptionMessage.message; continue; }
    if (content.editedMessage) { content = content.editedMessage.message; continue; }
    break;
  }

  if (!content) return null;

  // Vérification directe des types média avec indicateur viewOnce
  if (content.imageMessage && (content.imageMessage.viewOnce || content.imageMessage.viewOnce === true)) {
    return { type: 'image', media: content.imageMessage };
  }
  if (content.videoMessage && (content.videoMessage.viewOnce || content.videoMessage.viewOnce === true)) {
    return { type: 'video', media: content.videoMessage };
  }
  if (content.audioMessage && (content.audioMessage.viewOnce || content.audioMessage.viewOnce === true)) {
    return { type: 'audio', media: content.audioMessage };
  }

  return null;
}

async function telechargerBuffer(media, type, essais = 3) {
  let derniereErreur;
  for (let i = 1; i <= essais; i++) {
    try {
      const stream = await downloadContentFromMessage(media, type);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) throw new Error('buffer vide');
      return buffer;
    } catch (e) {
      derniereErreur = e;
      if (i < essais) await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  throw derniereErreur;
}

function memoriserVueUnique(idMsg, chatJid, objet) {
  vueUniqueCache[idMsg] = objet;
  vueUniqueCache['dernier:' + chatJid] = idMsg;
  vuOrdre.push(idMsg);
  while (vuOrdre.length > VU_MAX_CACHE) {
    delete vueUniqueCache[vuOrdre.shift()];
  }
}

function enregistrerEnvoi(res) {
  if (res && res.key && res.key.id) processedMessages.add(res.key.id);
  return res;
}

async function renvoyerVueUnique(sock, cible, cache, texte, options = {}) {
  const mentions = cache.expediteur ? [cache.expediteur] : [];
  if (cache.type === 'image') {
    return enregistrerEnvoi(await sock.sendMessage(cible, { image: cache.buffer, caption: texte, mentions }, options));
  }
  if (cache.type === 'video') {
    return enregistrerEnvoi(await sock.sendMessage(cible, { video: cache.buffer, caption: texte, mimetype: cache.mimetype || 'video/mp4', mentions }, options));
  }
  enregistrerEnvoi(await sock.sendMessage(cible, { text: texte, mentions }, options));
  return enregistrerEnvoi(await sock.sendMessage(cible, {
    audio: cache.buffer,
    mimetype: cache.mimetype || 'audio/ogg; codecs=opus',
    ptt: cache.ptt !== false
  }));
}

function lireTimestamp(t) {
  const n = (t && typeof t === 'object' && typeof t.toNumber === 'function') ? t.toNumber() : Number(t);
  return n ? n * 1000 : Date.now();
}

async function traiterVueUnique(sock, msg) {
  if (!msg || !msg.message || (msg.key && msg.key.fromMe)) return;

  const trouve = extraireVueUnique(msg.message);
  if (!trouve) return;

  const idMsg = msg.key.id;
  if (vuDejaVus.has(idMsg)) return;
  vuDejaVus.add(idMsg);
  if (vuDejaVus.size > 500) vuDejaVus.clear();

  const chatJid = msg.key.remoteJid;
  const expediteur = msg.key.participant || chatJid;
  if (utilisateursMutes.has(expediteur)) return;

  const { type, media } = trouve;
  console.log(`[VU] Vue unique détectée : ${type} | de ${expediteur} | dans ${chatJid}`);

  if (!media.mediaKey || !(media.directPath || media.url)) {
    console.warn("[VU] ⚠️ Pas de clé/URL dans ce message.");
    return;
  }

  let buffer;
  try {
    buffer = await telechargerBuffer(media, type);
  } catch (e) {
    console.error(`[VU] ❌ Téléchargement impossible (${type}) :`, (e && e.message) || e);
    return;
  }

  const fdate = new Date(lireTimestamp(msg.messageTimestamp)).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
  const cache = { buffer, type, caption: media.caption || '', fdate, mimetype: media.mimetype, ptt: media.ptt, expediteur };
  memoriserVueUnique(idMsg, chatJid, cache);

  const nom = profilsJoueurs[expediteur] || `@${expediteur.split('@')[0]}`;
  const texte = `🚨👀 *VUE UNIQUE INTERCEPTÉE PAR TITAN !* 📸\n👤 *Envoyée par :* ${nom}\n📅 *Date :* ${fdate}${cache.caption ? `\n📝 *Légende :* ${cache.caption}` : ''}\n✨ _Aucune cachette possible ici 😈_`;

  const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  const cible = VU_DEST === 'moi' ? botNumber : chatJid;

  try {
    await renvoyerVueUnique(sock, cible, cache, texte, cible === chatJid ? { quoted: msg } : {});
  } catch (e) {
    try {
      await renvoyerVueUnique(sock, cible, cache, texte, {});
    } catch (e2) {}
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
// ═══════════════════════════════════════════════════════════ FIN MODULE VUE UNIQUE

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
    const rawNumber = process.env.PHONE_NUMBER || "2250142451738";
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
      if (m.type && m.type !== 'notify') return;

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

      // 📥 MISE EN CACHE OPTIMISÉE
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

      // 🔄 COMMANDE DE REDÉMARRAGE DU BOT (.restartbot)
      if (lowerText === '.restartbot') {
        if (!isFromBot) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Seul le propriétaire peut redémarrer le bot !" }, { quoted: msg }, 'texte');
          return;
        }
        await envoyerAvecDelai(sock, remoteJid, { text: "🔄 Redémarrage du bot en cours... Render va relancer le service proprement ⚡" }, { quoted: msg }, 'texte');
        setTimeout(() => {
          process.exit(0);
        }, 1000);
        return;
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
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠ Tu dois écrire ta confession après la commande !\nExemple : `.confession J'avoue que...`" }, { quoted: msg }, 'texte');
          return;
        }

        if (isGroup) {
          try {
            await sock.sendMessage(remoteJid, { delete: msg.key });
          } catch (e) {}
        }

        const messageConfession = `🤫 *CONFESSION ANONYME* 🤫\n\n"${confessionText}"\n\n_Quelqu'un du groupe a balancé ça 💀... Devinez qui c'est !_`;
        await envoyerAvecDelai(sock, remoteJid, { text: messageConfession }, {}, 'texte');
        return;
      }

      // 💍 FORMULAIRE DE MARIAGE VIRTUEL
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
                           `💥 *VERDICT :* Le contrat de mariage est déchiré en mille morceaux !\n\n` +
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
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Tu dois mentionner un membre !" }, { quoted: msg }, 'texte');
          return;
        }

        if (lowerText.startsWith('.kick') && isGroup) {
          try {
            await sock.groupParticipantsUpdate(remoteJid, [mentionMod], "remove");
            await envoyerAvecDelai(sock, remoteJid, { text: `👢 Membre expulsé avec succès.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          } catch (e) {}
          return;
        }

        if (lowerText.startsWith('.promote') && isGroup) {
          try {
            await sock.groupParticipantsUpdate(remoteJid, [mentionMod], "promote");
            await envoyerAvecDelai(sock, remoteJid, { text: `⬆️ Membre promu admin.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          } catch (e) {}
          return;
        }

        if (lowerText.startsWith('.demote') && isGroup) {
          try {
            await sock.groupParticipantsUpdate(remoteJid, [mentionMod], "demote");
            await envoyerAvecDelai(sock, remoteJid, { text: `⬇️ Rôle d'admin retiré.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          } catch (e) {}
          return;
        }

        if (lowerText.startsWith('.warn')) {
          const raisonWarn = cleanText.replace(/^\.warn\s*@[0-9]+\s*/i, '').trim() || "Comportement non conforme";
          await envoyerAvecDelai(sock, remoteJid, { text: `⚠️ *AVERTISSEMENT* ⚠️\nDestinataire : @${mentionMod.split('@')[0]}\nMotif : ${raisonWarn}`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          return;
        }

        if (lowerText.startsWith('.mute')) {
          utilisateursMutes.add(mentionMod);
          await envoyerAvecDelai(sock, remoteJid, { text: `🔇 @${mentionMod.split('@')[0]} a été muté.`, mentions: [mentionMod] }, { quoted: msg }, 'texte');
          return;
        }

        if (lowerText.startsWith('.unmute')) {
          const mentionUnmute = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (mentionUnmute && utilisateursMutes.has(mentionUnmute)) {
            utilisateursMutes.delete(mentionUnmute);
            await envoyerAvecDelai(sock, remoteJid, { text: `🔊 @${mentionUnmute.split('@')[0]} a été démuté.`, mentions: [mentionUnmute] }, { quoted: msg }, 'texte');
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
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Utilisation incorrecte !" }, { quoted: msg }, 'texte');
          return;
        }

        try {
          const urlApi = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=autodetect|${targetLang}`;
          const response = await axios.get(urlApi);
          const traduction = response.data?.responseData?.translatedText;

          if (traduction) {
            await envoyerAvecDelai(sock, remoteJid, { text: `🌐 *TRADUCTION (${targetLang.toUpperCase()})* 🌐\n\n💬 *Original :* ${textToTranslate}\n✨ *Traduit :* ${traduction}` }, { quoted: msg }, 'texte');
          }
        } catch (e) {}
        return;
      }

      // 🔄 COMMANDE RET
      if (lowerText.startsWith('ret ')) {
        const regex = /^ret\s+(.*?)\s*\((\d+)\)$/i;
        const match = cleanText.match(regex);

        if (!match) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Format incorrect ! Utilise : `ret [phrase] (nombre)`" }, { quoted: msg }, 'texte');
          return;
        }

        const phraseARepeter = match[1].trim();
        let nombreFois = parseInt(match[2], 10);
        if (nombreFois > 10) nombreFois = 10; 

        await envoyerAvecDelai(sock, remoteJid, { text: `🔁 C'est parti !` }, { quoted: msg }, 'texte');

        for (let i = 0; i < nombreFois; i++) {
          if (i > 0) await new Promise(resolve => setTimeout(resolve, 3000));
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
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Précise ce que tu recherches !" }, { quoted: msg }, 'texte');
          return;
        }
        const searchImageUrl = `https://picsum.photos/seed/${encodeURIComponent(queryImg)}/800/600`;
        await envoyerAvecDelai(sock, remoteJid, { image: { url: searchImageUrl }, caption: `🔍 *Résultat pour :* ${queryImg}` }, { quoted: msg }, 'media');
        return;
      }

      if (lowerText.startsWith('.hack')) {
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!mention) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Mentionne la personne à pirater !" }, { quoted: msg }, 'texte');
          return;
        }

        const pseudo = `@${mention.split('@')[0]}`;
        const targetIp = `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;

        const { key } = await sock.sendMessage(remoteJid, { text: `👨‍💻 *PIRATAGE EN COURS DE ${pseudo}...*\n[░░░░░░░░░░] 0%` }, { quoted: msg });

        const etapes = [
          { txt: `👨‍💻 *PIRATAGE DE ${pseudo}...*\n📡 Recherche IP... [${targetIp}]\n[██░░░░░░░░] 20%`, delay: 1000 },
          { txt: `👨‍💻 *PIRATAGE DE ${pseudo}...*\n🔓 Contournement pare-feu...\n[████░░░░░░] 40%`, delay: 1000 },
          { txt: `👨‍‍💻 *PIRATAGE DE ${pseudo}...*\n📥 Extraction des données...\n[███████░░░] 70%`, delay: 1000 },
          { txt: `⚠ *PIRATAGE RÉUSSI DE ${pseudo} !*\n📌 *IP :* ${targetIp}`, delay: 500 }
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

        let txt = `🤥 *DÉTECTEUR DE MENSONGES* 🤥\n\n`;
        if (texteArg) txt += `💬 *Déclaration :* "${texteArg}"\n`;
        txt += `👤 *Auteur :* ${cible}\n📊 *Taux de mytho :* ${scoreMensonge}%\n🎯 *Verdict :* ${verdictAleatoire}`;

        await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: mention ? [mention] : [senderJid] }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.fiche') || lowerText.startsWith('.rang')) {
        const cible = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || senderJid;
        const nom = profilsJoueurs[cible] || `@${cible.split('@')[0]}`;
        const rangs = ["Légende", "Fantôme", "Roi du Spam", "Boss Final", "Membre Modèle"];
        const rangAttribue = rangs[Math.floor(Math.random() * rangs.length)];

        const card = `🪪 *FICHE D'IDENTITÉ*\n👤 *Nom :* ${nom}\n🎖️ *Rang :* ${rangAttribue}`;
        await envoyerAvecDelai(sock, remoteJid, { text: card, mentions: [cible] }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.balance')) {
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const cible = mention || senderJid;
        const prenom = `@${cible.split('@')[0]}`;
        const bonneAction = Math.floor(Math.random() * 101);
        const mauvaiseAction = 100 - bonneAction;

        const texteBalance = `⚖️ *BALANCE DES ACTIONS* ⚖\n👤 Membre : ${prenom}\n😌 Ange : ${bonneAction}%\n😈 Démon : ${mauvaiseAction}%`;
        await envoyerAvecDelai(sock, remoteJid, { text: texteBalance, mentions: [cible] }, { quoted: msg }, 'texte');
        return;
      }

      // 🌟 MENUS
      if (lowerText === '.menu' || lowerText === 'menu') {
        const menuPrincipal = 
`⚡ TITAN BOT - MENU PRINCIPAL ⚡

• .menu1 🏷️️ ➔ Identité & Compte
• .menu2 🛡️ ➔ Modération & Système (.restartbot)
• .menu3 🛠️ ➔ Outils & Tech
• .menu4 🎮 ➔ Zone de Combat (Jeux)
• .menu5 ⚙️ ➔ Gestion d'Équipe`;

        await envoyerAvecDelai(sock, remoteJid, { text: menuPrincipal }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText === '.menu1') {
        await envoyerAvecDelai(sock, remoteJid, { text: `🏷️ *CHAPITRE I*\n• .inscrire [Nom]\n• .pseudo [Nom]\n• .fiche` }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText === '.menu2') {
        const menu2 = `🛡️ *CHAPITRE II (MODÉRATION & SYSTÈME)*\n\n• .kick [@mention]\n• .promote / .demote\n• .warn / .mute / .unmute\n• .private on / off\n• .restartbot 🔄 ➔ Redémarrer le bot à distance`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu2 }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText === '.menu3') {
        await envoyerAvecDelai(sock, remoteJid, { text: `🛠 *CHAPITRE III*\n• .v\n• .love\n• .mariage\n• .confession\n• .qr` }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText === '.menu4') {
        await envoyerAvecDelai(sock, remoteJid, { text: `🎮 *CHAPITRE IV*\n• .bombe\n• .de\n• .lab\n• .feurouge\n• .chiffremystere` }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText === '.menu5') {
        await envoyerAvecDelai(sock, remoteJid, { text: `⚙️ *CHAPITRE V*\n• .joindre\n• .lancer\n• .restart (jeu)\n• .stop` }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText.startsWith('.pseudo')) {
        const nouveauNom = cleanText.replace(/^\.pseudo\s*/i, '').trim();
        if (!nouveauNom) return;
        profilsJoueurs[senderJid] = nouveauNom;
        await envoyerAvecDelai(sock, remoteJid, { text: `✅ Pseudo mis à jour : *${nouveauNom}*` }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.inscrire')) {
        const nomEntre = cleanText.replace(/^\.inscrire\s*/i, '').trim();
        if (!nomEntre) return;
        profilsJoueurs[senderJid] = nomEntre;

        if (jeu && jeu.statut === 'INSCRIPTION') {
          if (!jeu.joueurs.some(j => j.jid === senderJid)) {
            jeu.joueurs.push({ jid: senderJid, nom: nomEntre, elimine: false, score: 0 });
            await envoyerAvecDelai(sock, remoteJid, { text: `✅ *${nomEntre}* inscrit !` }, { quoted: msg }, 'texte');
            return;
          }
        }
        await envoyerAvecDelai(sock, remoteJid, { text: `🎉 Bienvenue *${nomEntre}* !` }, { quoted: msg }, 'texte');
        return;
      }

      // 🔓 COMMANDE .V
      if (lowerText === '.v') {
        const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        let cache = quotedId ? vueUniqueCache[quotedId] : null;
        if (!cache) cache = vueUniqueCache[vueUniqueCache['dernier:' + remoteJid]];

        if (!cache) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Aucune vue unique récente." }, { quoted: msg }, 'texte');
          return;
        }

        try {
          await renvoyerVueUnique(sock, remoteJid, cache, "🔓 *VUE UNIQUE EXTRAITE*", { quoted: msg });
        } catch (e) {}
        return;
      }

      if (lowerText.startsWith('.pp') || lowerText.startsWith('.p')) {
        let mention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        let cible = mention || (isGroup ? null : remoteJid) || senderJid;

        try {
          const ppUrl = await sock.profilePictureUrl(cible, 'image');
          await envoyerAvecDelai(sock, remoteJid, { image: { url: ppUrl }, caption: `📸 Photo de profil`, mentions: [cible] }, { quoted: msg }, 'media');
        } catch (e) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠ Photo introuvable." }, { quoted: msg }, 'texte');
        }
        return;
      }

      if (lowerText === 'pipi') {
        let cible = isGroup ? msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] : remoteJid;
        if (!cible) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Mentionne quelqu'un !" }, { quoted: msg }, 'texte');
          return;
        }
        try {
          const ppUrl = await sock.profilePictureUrl(cible, 'image');
          await envoyerAvecDelai(sock, remoteJid, { image: { url: ppUrl }, caption: `📸 Photo demandée !`, mentions: [cible] }, { quoted: msg }, 'media');
        } catch (e) {}
        return;
      }

      if (lowerText.startsWith('.love')) {
        const mentions = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const score = Math.floor(Math.random() * 101);
        let txt = `💖 *TEST D'AMOUR* 💖\n📊 Jauge : ${score}%\n`;
        await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText.startsWith('.qr')) {
        const contenu = cleanText.replace(/^\.qr\s*/i, '').trim();
        if (!contenu) return;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(contenu)}`;
        await envoyerAvecDelai(sock, remoteJid, { image: { url: qrUrl }, caption: `📱 *QR CODE*` }, { quoted: msg }, 'qr');
        return;
      }

      if (lowerText.startsWith('.8ball')) {
        const question = cleanText.replace(/^\.8ball\s*/i, '').trim();
        const reponse = REPONSES_8BALL[Math.floor(Math.random() * REPONSES_8BALL.length)];
        await envoyerAvecDelai(sock, remoteJid, { text: `🎱 *8-BALL*\n❓ ${question}\n🔮 ${reponse}` }, { quoted: msg }, 'texte');
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
        await envoyerAvecDelai(sock, remoteJid, { text: "🛑 Partie annulée." }, { quoted: msg }, 'texte');
        return;
      }

      if (lowerText === '.bombe') return declencherJeuBombe(sock, remoteJid, msg);
      if (lowerText === '.de') return declencherJeuDe(sock, remoteJid, msg);
      if (lowerText.startsWith('.lab')) return declencherJeuLabyrinthe(sock, remoteJid, msg, cleanText);
      if (lowerText === '.feurouge') return declencherJeuFeuRouge(sock, remoteJid, msg, senderJid);
      if (lowerText === '.chiffremystere') return declencherJeuChiffre(sock, remoteJid, msg, senderJid);

      if (lowerText === '.lancer') {
        if (!jeu || (jeu.statut !== 'INSCRIPTION' && jeu.type !== 'FEU_ROUGE')) return;
        if (jeu.joueurs.length === 0) {
          jeu.joueurs.push({ jid: senderJid, nom: profilsJoueurs[senderJid] || "Joueur Solo", elimine: false, score: 0 });
        }
        jeu.statut = 'EN_COURS';

        if (jeu.type === 'DE') {
          let resultatText = `🎲 *DÉ* 🎲\n`;
          jeu.joueurs.forEach(j => {
            const tirage = Math.floor(Math.random() * 6) + 1;
            resultatText += `👤 ${j.nom} : ${tirage}\n`;
          });
          partiesEnCours[remoteJid] = { dernierType: 'DE' };
          await envoyerAvecDelai(sock, remoteJid, { text: resultatText }, { quoted: msg }, 'texte');
          return;
        }
      }

      if (jeu && jeu.statut === 'EN_COURS') {
        if (jeu.type === 'CHIFFRE' && !isNaN(cleanText)) {
          const prop = parseInt(cleanText, 10);
          if (prop === jeu.secret) {
            partiesEnCours[remoteJid] = { dernierType: 'CHIFFRE' };
            await envoyerAvecDelai(sock, remoteJid, { text: `🏆 VICTOIRE ! Chiffre : ${jeu.secret}` }, { quoted: msg }, 'texte');
          }
        }
      }

    } catch (err) {
      console.error("⚠️ Erreur :", err);
    }
  });
}

function declencherJeuBombe(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'BOMBE', statut: 'INSCRIPTION', bonFil: 'rouge', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `💣 *BOMBE* 💣` }, { quoted: msg }, 'texte');
}

function declencherJeuDe(sock, remoteJid, msg) {
  reinitialiserJuid(remoteJid);
  partiesEnCours[remoteJid] = { type: 'DE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🎲 *DÉ*` }, { quoted: msg }, 'texte');
}

function declencherJeuLabyrinthe(sock, remoteJid, msg, texteCommande = ".lab solo") {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'LABYRINTHE', niveau: 'solo', statut: 'EN_COURS', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🌀 *LABYRINTHE*` }, { quoted: msg }, 'texte');
}

function declencherJeuFeuRouge(sock, remoteJid, msg, senderJid) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'FEU_ROUGE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🔴 *FEU ROUGE*` }, { quoted: msg }, 'texte');
}

function declencherJeuChiffre(sock, remoteJid, msg, senderJid) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'CHIFFRE', statut: 'EN_COURS', secret: Math.floor(Math.random() * 100) + 1, joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🔢 *CHIFFRE MYSTÈRE*` }, { quoted: msg }, 'texte');
}

startBot();
