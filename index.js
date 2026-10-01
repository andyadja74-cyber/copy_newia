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
async function getAuthState() {
  console.log("📁 Utilisation du stockage local (auth_info)...");
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  return {
    state,
    saveCreds,
    clearSession: async () => {
      if (fs.existsSync('./auth_info')) {
        fs.rmSync('./auth_info', { recursive: true, force: true });
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

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || "";
      console.log(`❌ Connexion fermée. Code : ${statusCode} \vert{} Erreur :${errorMessage}`);

      if (statusCode === DisconnectReason.loggedOut || errorMessage.includes('Bad MAC') || statusCode === 440 || statusCode === 515) {
        console.log("❌ Session corrompue ou expirée. Nettoyage et réinitialisation...");
        await clearSession();
      }
      
      console.log("🔄 Tentative de reconnexion dans 5 secondes...");
      setTimeout(() => startBot(), 5000);
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
      console.log(`📩 [MSG] (${formattedDate}) De :${senderJid} | Groupe : ${isGroup} \vert{} Texte :${cleanTextLog}`);

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

      // 👁️ DÉTECTION ET INTERCEPTION RÉCURSIVE ULTRA-BOOSTÉE DES VUES UNIQUES
      function trouverMediaVueUnique(obj) {
        if (!obj || typeof obj !== 'object') return null;

        if (obj.imageMessage && (obj.imageMessage.viewOnce || obj.viewOnce)) {
          return { type: 'image', mediaMsg: obj.imageMessage };
        }
        if (obj.videoMessage && (obj.videoMessage.viewOnce || obj.viewOnce)) {
          return { type: 'video', mediaMsg: obj.videoMessage };
        }
        if (obj.audioMessage && (obj.audioMessage.viewOnce || obj.viewOnce || obj.audioMessage.ptt)) {
          return { type: 'audio', mediaMsg: obj.audioMessage };
        }

        for (const key of Object.keys(obj)) {
          if (obj[key] && typeof obj[key] === 'object') {
            const resultat = trouverMediaVueUnique(obj[key]);
            if (resultat) return resultat;
          }
        }

        return null;
      }

      const resultatVueUnique = trouverMediaVueUnique(msg.message);

      if (resultatVueUnique) {
        const { type: mediaTypeStr, mediaMsg: targetMediaMsg } = resultatVueUnique;

        try {
          const stream = await downloadContentFromMessage(targetMediaMsg, mediaTypeStr === 'audio' ? 'audio' : mediaTypeStr);
          let buffer = Buffer.from([]);
          for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
          }

          const cacheObj = { 
            buffer, 
            type: mediaTypeStr, 
            caption: targetMediaMsg.caption || "",
            fdate: formattedDate 
          };

          vueUniqueCache[remoteJid] = cacheObj;
          if (msg.key.id) vueUniqueCache[msg.key.id] = cacheObj;

          const senderName = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
          const captionTexte = `🚨👀 *VUE UNIQUE INTERCEPTÉE ET SAUVÉE PAR TITAN (ULTRA-BOOST) !* 📸\n👤 *Envoyée par :* ${senderName}\n📅 *Date :* ${formattedDate}${targetMediaMsg.caption ? `\n📝 *Légende :* ${targetMediaMsg.caption}` : ''}\n✨ _Aucune cachette possible ici 😈_`;

          if (mediaTypeStr === 'image') {
            await envoyerAvecDelai(sock, remoteJid, { image: buffer, caption: captionTexte, mentions: [senderJid] }, { quoted: msg }, 'media');
          } else if (mediaTypeStr === 'video') {
            await envoyerAvecDelai(sock, remoteJid, { video: buffer, caption: captionTexte, mentions: [senderJid] }, { quoted: msg }, 'media');
          } else if (mediaTypeStr === 'audio') {
            await envoyerAvecDelai(sock, remoteJid, { audio: buffer, mimetype: 'audio/mp4', ptt: true }, { quoted: msg }, 'media');
          }
        } catch (e) {
          console.error("⚠️ Erreur lors du téléchargement de la vue unique boostée :", e);
        }
      }

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
          const urlApi = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(textToTranslate)}&langpair=autodetect\vert{}${targetLang}`;
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

      // 🌟 MENUS (MIS À JOUR AVEC .confession)
      if (lowerText === '.menu' || lowerText === 'menu') {
        const nomAffiche = profilsJoueurs[senderJid] || "Membre VIP";
        const menuPrincipal = 
`⚡ TITAN BOT - MENU PRINCIPAL ⚡
Collab' officielle avec ${nomAffiche}

Choisis ton chapitre en tapant la commande associée :

• .menu1 🏷️ ➔ Chapitre I : Identité & Compte
• .menu2 🛡️ ➔ Chapitre II : Modération (Admins)
• .menu3 🛠️ ➔ Chapitre III : Outils & Tech
• .menu4 🎮 ➔ Chapitre IV : Zone de Combat (Jeux)
• .menu5 ⚙️ ➔ Chapitre V : Gestion d'Équipe

Tape .menu suivi du chiffre pour ouvrir une section.`;

        await envoyerAvecDelai(sock, remoteJid, { text: menuPrincipal }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText === '.menu1') {
        const menu1 = 
`🏷️ CHAPITRE I : IDENTITÉ & COMPTE

• .inscrire [Nom] 📝 ➔ Enregistrer ton pass VIP
• .pseudo [Nom] ✏️ ➔ Customiser ton blaze
• .fiche ou .rang 🪪 ➔ Consulter ta carte & ton grade

Tape .menu pour revenir au hub.`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu1 }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText === '.menu2') {
        const menu2 = 
`🛡️ CHAPITRE II : MODÉRATION (Réservé aux Admins & Bot)

• .kick [@mention] ❌ ➔ Expulser un membre
• .promote [@mention] ⬆️ ➔ Promouvoir admin
• .demote [@mention] ⬇️ ➔ Rétrograder un admin
• .warn [@mention] ⚠️ ➔ Avertir un membre
• .mute [@mention] 🔇 ➔ Bloquer l'accès au bot
• .unmute [@mention] 🔊 ➔ Débloquer l'accès au bot
• .private on / off 🔒 ➔ Verrouiller/Déverrouiller l'accès global du bot

Tape .menu pour revenir au hub.`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu2 }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText === '.menu3') {
        const menu3 = 
`🛠️ CHAPITRE III : OUTILS & TECH

• .8ball [question] 🎱 ➔ Boule de cristal magique
• .v 🔓 ➔ Mode Ninja (Revoir la vue unique)
• .pp [@mention] 📸 ➔ Inspecter la photo de profil cible
• .love [@mention] 💖 ➔ Test d'amour & aura du crew
• .mariage [@mention] 💍 ➔ Épouser virtuellement quelqu'un (Boosté)
• .divorce 📜 ➔ Rompre son mariage virtuel (Boosté)
• .confession [texte] 🤫 ➔ Envoyer une confession anonyme
• .qr [texte] 📱 ➔ Générer un Code Matrix personnalisé
• .cerveau [@mention] 🧠 ➔ Scanner l'activité mentale
• .hack [@mention] 👨‍💻 ➔ Simulation d'infiltration Dark Web
• .balance [@mention] ⚖️ ➔ Jauge Ange ou Démon
• .dec [texte] 🤥 ➔ Analyseur de mensonges
• .image [mot-clé] 🔍 ➔ Recherche d'image
• .translate [lang] [texte] 🌐 ➔ Traduire un texte

Tape .menu pour revenir au hub.`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu3 }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText === '.menu4') {
        const menu4 = 
`🎮 CHAPITRE IV : ZONE DE COMBAT

• .bombe 💣 ➔ Désamorçage tactique
• .de 🎲 ➔ Le jet de dés du destin
• .lab [solo|duo|equipe] 🌀 ➔ Labyrinthe (10 étapes)
• .feurouge 🔴 ➔ Squid Game (Jeu du feu rouge)
• .roulette 💀 ➔ Roulette Russe mortelle
• .chiffremystere 🔢 ➔ Le code secret (1 à 100)
• .pf 🪙 ➔ Pile ou Face rapide

Tape .menu pour revenir au hub.`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu4 }, { quoted: msg }, 'menu');
        return;
      }

      if (lowerText === '.menu5') {
        const menu5 = 
`⚙️ CHAPITRE V : CONTRÔLE DE L'ÉQUIPE

• .joindre [A/B] 👥 ➔ Rejoindre le crew
• .lancer 🚀 ➔ Activer le protocole de départ
• .restart 🔄 ➔ Relancer le dernier round
• .stop 🛑 ➔ Couper net la session active

Tape .menu pour revenir au hub.`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu5 }, { quoted: msg }, 'menu');
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

      // 🔓 COMMANDE .V (VUE UNIQUE SURBOOSTÉE)
      if (lowerText === '.v') {
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedIdContext = contextInfo?.stanzaId;

        let cache = quotedIdContext ? vueUniqueCache[quotedIdContext] : null;
        if (!cache) cache = vueUniqueCache[remoteJid];

        if (!cache) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Aucune vue unique récente enregistrée dans ce tchat. Fais un 'Répondre' (swipe) sur la vue unique avec `.v` ou attends qu'une vue unique passe !" }, { quoted: msg }, 'texte');
          return;
        }

        const textV = `🔓 *VUE UNIQUE EXTRAITE DU CACHE (MODE NINJA)* 🥷\n📅 *Capturée le :* ${cache.fdate \vert{}\vert{} 'Récemment'}${cache.caption ? `\n📝 *Légende :* ${cache.caption}` : ''}`;
        if (cache.type === 'image') {
          await envoyerAvecDelai(sock, remoteJid, { image: cache.buffer, caption: textV }, { quoted: msg }, 'media');
        } else if (cache.type === 'video') {
          await envoyerAvecDelai(sock, remoteJid, { video: cache.buffer, caption: cache.caption ? textV : undefined }, { quoted: msg }, 'media');
        } else if (cache.type === 'audio') {
          await envoyerAvecDelai(sock, remoteJid, { audio: cache.buffer, mimetype: 'audio/mp4', ptt: true }, { quoted: msg }, 'media');
        }
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

      if (lowerText === 'pipi') {
        let cible = null;

        if (isGroup) {
          const mention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!mention) {
            await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Dans un groupe, tu dois mentionner la personne dont tu veux voir la photo avec `pipi` ! Exemple : `pipi @mention`" }, { quoted: msg }, 'texte');
            return;
          }
          cible = mention;
        } else {
          cible = remoteJid;
        }

        try {
          const ppUrl = await sock.profilePictureUrl(cible, 'image');
          const nomCible = `@${cible.split('@')[0]}`;
          await envoyerAvecDelai(sock, remoteJid, { 
            image: { url: ppUrl }, 
            caption: `📸 Voilà la photo de profil de ${nomCible} demandée avec pipi ! 🚽✨`, 
            mentions: [cible] 
          }, { quoted: msg }, 'media');
        } catch (e) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Impossible de récupérer la photo de profil." }, { quoted: msg }, 'texte');
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
