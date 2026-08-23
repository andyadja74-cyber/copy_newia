// ⚡ FIX CRYPTO POUR RENDER & BAILEYS
const crypto = require('crypto');
if (!globalThis.crypto) globalThis.crypto = crypto;

const fs = require('fs');
const express = require("express");
const https = require("https");
const { MongoClient } = require('mongodb'); // 🍃 Client MongoDB

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  Browsers,
  BufferJSON,   // 🍃 Sérialisation des clés
  initAuthCreds, // 🍃 Initialisation des identifiants
  proto         // 🍃 Décodage des clés sync
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
  LISTE_ANIMAUX,
  MOTS_SQUID,
  DONNEES_CERVEAU,
  COMMENTAIRES_CERVEAU,
  CHEMINS_LABYRINTHE,
  SUBS_LABYRINTHE,
  partiesEnCours,
  timersInactivite,
  vueUniqueCache,
  animauxJoueurs,
  mesNotes,
  sessionsMotDePasse,
  profilsJoueurs,
  membresSalues
} = data;

const app = express();
const PORT = process.env.PORT || 3000;

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

// 🍃 GESTIONNAIRE DE SESSION MONGODB ET LOCAL
async function getAuthState() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  
  if (mongoUri) {
    console.log("🍃 Connexion à MongoDB pour la gestion de la session...");
    const client = new MongoClient(mongoUri);
    await client.connect();
    const db = client.db("titan_bot_session");
    const collection = db.collection("auth_keys");

    const writeData = async (data, id) => {
      const value = JSON.stringify(data, BufferJSON.replacer);
      await collection.updateOne({ _id: id }, { $set: { value } }, { upsert: true });
    };

    const readData = async (id) => {
      try {
        const doc = await collection.findOne({ _id: id });
        if (doc && doc.value) {
          return JSON.parse(doc.value, BufferJSON.reviver);
        }
      } catch (e) {
        return null;
      }
      return null;
    };

    const removeData = async (id) => {
      try {
        await collection.deleteOne({ _id: id });
      } catch (e) {}
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const data = {};
            await Promise.all(
              ids.map(async (id) => {
                let value = await readData(`${type}-${id}`);
                if (type === 'app-state-sync-key' && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                data[id] = value;
              })
            );
            return data;
          },
          set: async (data) => {
            const tasks = [];
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const key = `${category}-${id}`;
                if (value) {
                  tasks.push(writeData(value, key));
                } else {
                  tasks.push(removeData(key));
                }
              }
            }
            await Promise.all(tasks);
          }
        }
      },
      saveCreds: async () => {
        await writeData(creds, 'creds');
      },
      clearSession: async () => {
        await collection.deleteMany({});
      }
    };
  } else {
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
      });
    }
  }, 3 * 60 * 1000);
}

function calculerDelaiEnvoi(texte) {
  if (!texte || typeof texte !== 'string') return 1500;
  const nbMots = texte.trim().split(/\s+/).filter(Boolean).length;
  let minSec = nbMots < 50 ? 2.5 : 4.5;
  let maxSec = nbMots < 50 ? 5.5 : 8.0;
  return Math.floor((minSec + Math.random() * (maxSec - minSec)) * 1000);
}

async function envoyerAvecDelai(sock, remoteJid, content, options = {}, originalMsg = null) {
  try {
    const texte = typeof content === 'string' ? content : (content.text || content.caption || "");
    const delaiMs = calculerDelaiEnvoi(texte);

    await sock.sendPresenceUpdate('composing', remoteJid);
    await new Promise(resolve => setTimeout(resolve, delaiMs));
    await sock.sendPresenceUpdate('paused', remoteJid);

    return await sock.sendMessage(remoteJid, content, options);
  } catch (err) {
    console.error("⚠️ Erreur d'envoi :", err);
  }
}

function genererBarreHP(hp, maxHp = 100) {
  const totalBlocs = 10;
  const blocsRemplis = Math.max(0, Math.min(totalBlocs, Math.round((hp / maxHp) * totalBlocs)));
  const blocsVides = totalBlocs - blocsRemplis;
  return `[${'█'.repeat(blocsRemplis)}${'░'.repeat(blocsVides)}] ${hp}/${maxHp}`;
}

let pairingCodeDemande = false;

async function startBot() {
  const { state, saveCreds, clearSession } = await getAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 15000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      pairingCodeDemande = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log("❌ Déconnecté par WhatsApp. Nettoyage de la session...");
        await clearSession();
      }
      setTimeout(() => startBot(), 3000);
    } else if (connection === 'open') {
      console.log('⚡ TITAN BOT PRÊT ET CONNECTÉ !');
      pairingCodeDemande = false;
    }

    if (!sock.authState.creds.registered && !pairingCodeDemande) {
      pairingCodeDemande = true;
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
          console.error("❌ Erreur Pairing Code :", err);
          pairingCodeDemande = false;
        }
      }, 3000);
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      const senderJid = msg.key.participant || remoteJid;
      const estGroupe = remoteJid.endsWith('@g.us');

      // 👁️ VUE UNIQUE AUTOMATIQUE INSTANTANÉE
      const viewOnceMsg = msg.message.viewOnceMessageV2?.message || msg.message.viewOnceMessage?.message;
      if (viewOnceMsg) {
        const type = Object.keys(viewOnceMsg)[0];
        const media = viewOnceMsg[type];
        try {
          const stream = await downloadContentFromMessage(media, type === 'imageMessage' ? 'image' : 'video');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
          
          const textReveal = `🔓 *IL N'Y A PAS DE SECRET ICI !*\n${media.caption ? `\n📝 *Légende :* ${media.caption}` : ''}`;

          if (type === 'imageMessage') {
            await envoyerAvecDelai(sock, remoteJid, { image: buffer, caption: textReveal }, { quoted: msg }, msg);
          } else if (type === 'videoMessage') {
            await envoyerAvecDelai(sock, remoteJid, { video: buffer, caption: textReveal }, { quoted: msg }, msg);
          }

          vueUniqueCache[remoteJid] = { buffer, type: type === 'imageMessage' ? 'image' : 'video', caption: media.caption || "" };
          vueUniqueCache[msg.key.id] = vueUniqueCache[remoteJid];
        } catch (e) {
          console.error("⚠️ Erreur vue unique :", e);
        }
      }

      const cleanText = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "").trim();
      const lowerText = cleanText.toLowerCase();

      if (!estGroupe && MOTS_AMOUR_PRIVE.includes(lowerText)) {
        await envoyerAvecDelai(sock, remoteJid, { text: REPONSE_AMOUR_MAMAN }, { quoted: msg }, msg);
        return;
      }

      const jeu = partiesEnCours[remoteJid];
      demarrerTimerInactivite(sock, remoteJid);

      // 📜 MENU GENERAL
      if (lowerText === '.menu' || lowerText === 'menu') {
        const nomAffiche = profilsJoueurs[senderJid] || "Joueur";
        const menuText = `⚡ *TITAN BOT ULTIMATE* ⚡
👋 Salut *${nomAffiche}* !

👤 *PROFIL & COMPTE*
📝 *.inscrire [Nom]* ➔ S'enregistrer au bot
✏️ *.pseudo [Nom]* ➔ Modifier ton nom

📌 *NOTES SECRÈTES*
💾 *.note [texte]* ➔ Sauvegarder une note
🔒 *.notes* ➔ Consulter tes notes
🗑️ *.clearnotes* ➔ Effacer tes notes

🐾 *MON COMPAGNON*
🐶 *.toutou* ➔ Adopter / Statut de l'animal
🍖 *.nourrir* | 😴 *.dodo* | 🌳 *.parc* | 🩺 *.soigner*

🛠️ *OUTILS & FUN*
🤖 *.iagmini [question]* ➔ Poser une question à l'IA
🎱 *.8ball [question]* ➔ La Boule Magique
👁️ *.v* ➔ Revoir la dernière vue unique
📸 *.pp* [@mention] ➔ Photo de profil
💖 *.love* [@mention(s)] ➔ Diagnostic solo ou Test de compatibilité
📱 *.qr* [texte] ➔ Générateur de QR Code
🧠 *.cerveau* [@mention] ➔ Analyse mentale

🎮 *MINI-JEUX DE GROUPE*
💣 *.bombe* ➔ Défi désamorçage d'équipe
🎲 *.de* ➔ Jeu de dé
🚪 *.lab* ➔ Labyrinthe (1v1 ou Équipe)
🔴 *.feurouge* ➔ Squid Game (Élimination)
💀 *.roulette* ➔ Roulette russe
🔢 *.chiffremystere* ➔ Devine le nombre

⚙️ *GESTION*
✋ *.joindre* [A/B] ➔ Rejoindre une équipe
🚀 *.lancer* ➔ Démarrer la partie
🔄 *.restart* ➔ Rejouer au dernier jeu
🛑 *.stop* ➔ Réinitialiser le jeu actif`;

        await envoyerAvecDelai(sock, remoteJid, { text: menuText }, { quoted: msg }, msg);
        return;
      }

      // 🤖 COMMANDE IA GMINI
      if (lowerText.startsWith('.iagmini')) {
        const question = cleanText.replace(/^\.iagmini\s*/i, '').trim();
        if (!question) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Pose une question à l'IA ! Exemple : `.iagmini Donne-moi une recette facile`" }, { quoted: msg }, msg);
          return;
        }

        const API_KEY = process.env.GEMINI_API_KEY;

        if (!API_KEY) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Clé API non configurée ! Veuillez définir la variable d'environnement `GEMINI_API_KEY`." }, { quoted: msg }, msg);
          return;
        }

        try {
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: question }] }]
            })
          });

          const resData = await response.json();
          const replyText = resData?.candidates?.[0]?.content?.parts?.[0]?.text || "Désolé, l'IA n'a pas pu générer de réponse.";
          await envoyerAvecDelai(sock, remoteJid, { text: `🤖 *IAGmini :*\n\n${replyText}` }, { quoted: msg }, msg);
        } catch (err) {
          console.error("Erreur IAGmini :", err);
          await envoyerAvecDelai(sock, remoteJid, { text: "❌ Une erreur s'est produite lors de la connexion à l'IA." }, { quoted: msg }, msg);
        }
        return;
      }

      // ✏️ MODIFIER SON PSEUDO
      if (lowerText.startsWith('.pseudo')) {
        const nouveauNom = cleanText.replace(/^\.pseudo\s*/i, '').trim();
        if (!nouveauNom) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Précisez votre nouveau nom ! Exemple : `.pseudo Titan`" }, { quoted: msg }, msg);
          return;
        }
        profilsJoueurs[senderJid] = nouveauNom;
        await envoyerAvecDelai(sock, remoteJid, { text: `✅ Votre pseudo a été mis à jour : *${nouveauNom}*` }, { quoted: msg }, msg);
        return;
      }

      // 📝 INSCRIPTION AU BOT / JEU
      if (lowerText.startsWith('.inscrire')) {
        const nomEntre = cleanText.replace(/^\.inscrire\s*/i, '').trim();
        if (!nomEntre) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Entrez votre nom ! Exemple : `.inscrire Andy`" }, { quoted: msg }, msg);
          return;
        }

        profilsJoueurs[senderJid] = nomEntre;

        if (jeu && jeu.statut === 'INSCRIPTION') {
          if (!jeu.joueurs.some(j => j.jid === senderJid)) {
            jeu.joueurs.push({ jid: senderJid, nom: nomEntre, elimine: false, score: 0 });
            await envoyerAvecDelai(sock, remoteJid, { text: `✅ *${nomEntre}* a rejoint la partie ! (${jeu.joueurs.length} inscrit(s))` }, { quoted: msg }, msg);
            return;
          }
        }

        await envoyerAvecDelai(sock, remoteJid, { text: `🎉 *PROFIL ENREGISTRÉ !*\nBienvenue *${nomEntre}* !` }, { quoted: msg }, msg);
        return;
      }

      // 📌 GESTION DES NOTES
      if (lowerText.startsWith('.note ') || lowerText === '.note') {
        const contenuNote = cleanText.replace(/^\.note\s*/i, '').trim();
        if (!contenuNote) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Écrivez le texte de votre note ! Exemple : `.note Penser à faire l'exercice`" }, { quoted: msg }, msg);
          return;
        }
        if (!mesNotes[senderJid]) mesNotes[senderJid] = [];
        mesNotes[senderJid].push(contenuNote);
        await envoyerAvecDelai(sock, remoteJid, { text: `💾 Note enregistrée (#${mesNotes[senderJid].length}) !` }, { quoted: msg }, msg);
        return;
      }

      if (lowerText === '.notes') {
        const notesUser = mesNotes[senderJid] || [];
        if (notesUser.length === 0) {
          await envoyerAvecDelai(sock, remoteJid, { text: "📭 Vous n'avez aucune note enregistrée." }, { quoted: msg }, msg);
          return;
        }
        let listeNotes = `📌 *VOS NOTES PERSONNELLES :*\n\n` + notesUser.map((n, idx) => `${idx + 1}. ${n}`).join('\n');
        await envoyerAvecDelai(sock, remoteJid, { text: listeNotes }, { quoted: msg }, msg);
        return;
      }

      if (lowerText === '.clearnotes') {
        delete mesNotes[senderJid];
        await envoyerAvecDelai(sock, remoteJid, { text: "🗑️ Toutes vos notes ont été effacées !" }, { quoted: msg }, msg);
        return;
      }

      // 🐾 COMPAGNON VIRTUEL
      if (lowerText === '.toutou') {
        if (!animauxJoueurs[senderJid]) {
          const typeChoisi = LISTE_ANIMAUX[Math.floor(Math.random() * LISTE_ANIMAUX.length)];
          animauxJoueurs[senderJid] = { nom: typeChoisi.nom, faim: 50, energie: 50, sante: 100 };
        }
        const pet = animauxJoueurs[senderJid];
        const nomJ = profilsJoueurs[senderJid] || 'Joueur';
        const statusPet = `🐶 *COMPAGNON DE ${nomJ.toUpperCase()}*\n\n` +
          `📛 Nom : *${pet.nom}*\n` +
          `🍖 Faim : ${genererBarreHP(pet.faim, 100)}\n` +
          `😴 Énergie : ${genererBarreHP(pet.energie, 100)}\n` +
          `🩺 Santé : ${genererBarreHP(pet.sante, 100)}\n\n` +
          `👉 Actions : \`.nourrir\`, \`.dodo\`, \`.parc\`, \`.soigner\``;
        await envoyerAvecDelai(sock, remoteJid, { text: statusPet }, { quoted: msg }, msg);
        return;
      }

      if (['.nourrir', '.dodo', '.parc', '.soigner'].includes(lowerText)) {
        if (!animauxJoueurs[senderJid]) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Tapez `.toutou` d'abord pour adopter votre animal !" }, { quoted: msg }, msg);
          return;
        }
        const pet = animauxJoueurs[senderJid];
        if (lowerText === '.nourrir') pet.faim = Math.min(100, pet.faim + 35);
        if (lowerText === '.dodo') pet.energie = Math.min(100, pet.energie + 40);
        if (lowerText === '.parc') { pet.energie = Math.max(0, pet.energie - 20); pet.faim = Math.max(0, pet.faim - 15); }
        if (lowerText === '.soigner') pet.sante = 100;

        await envoyerAvecDelai(sock, remoteJid, { text: `🐾 Action effectuée sur *${pet.nom}* ! Tapez \`.toutou\` pour voir ses stats.` }, { quoted: msg }, msg);
        return;
      }

      // 👁️ REVOIR LA DERNIÈRE VUE UNIQUE (.v)
      if (lowerText === '.v') {
        const cache = vueUniqueCache[remoteJid];
        if (!cache) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Aucune vue unique récente enregistrée dans ce tchat." }, { quoted: msg }, msg);
          return;
        }
        const textV = `🔓 *IL N'Y A PAS DE SECRET ICI !*\n${cache.caption ? `\n📝 *Légende :* ${cache.caption}` : ''}`;
        if (cache.type === 'image') {
          await envoyerAvecDelai(sock, remoteJid, { image: cache.buffer, caption: textV }, { quoted: msg }, msg);
        } else {
          await envoyerAvecDelai(sock, remoteJid, { video: cache.buffer, caption: textV }, { quoted: msg }, msg);
        }
        return;
      }

      // 📸 PHOTO DE PROFIL (.pp)
      if (lowerText.startsWith('.pp')) {
        let cible = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || senderJid;
        try {
          const ppUrl = await sock.profilePictureUrl(cible, 'image');
          await envoyerAvecDelai(sock, remoteJid, { image: { url: ppUrl }, caption: `🙌👉Voilà ça 😈😎 *@${cible.split('@')[0]}*`, mentions: [cible] }, { quoted: msg }, msg);
        } catch (e) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Photo de profil introuvable ou masquée par la confidentialité." }, { quoted: msg }, msg);
        }
        return;
      }

      // 💖 FONCTION LOVE
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

          await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: [user1, user2] }, { quoted: msg }, msg);
          return;
        }

        if (mentions.length === 1) {
          const mention = mentions[0];
          txt += `👤 Entre *@${senderJid.split('@')[0]}* et *@${mention.split('@')[0]}*\n`;
          txt += `📊 Jauge : ${genererBarreHP(score, 100)} (${score}%)\n`;
          txt += `💬 *Avis :* ${comm}\n\n`;
          txt += `💡 *Petit conseil :* ${conseil}`;

          await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: [senderJid, mention] }, { quoted: msg }, msg);
          return;
        }

        let diagnosticSolo = "Ton cœur est un havre de paix. Tu es en parfaite harmonie avec toi-même ! ✨";
        if (score < 30) diagnosticSolo = "Cœur en mode ermite. Focus total sur le développement personnel ! 🧘‍♂️";
        else if (score < 70) diagnosticSolo = "Aura séduisante ! Un bon équilibre entre indépendance et ouverture aux rencontres ! 😉";
        else diagnosticSolo = "Aura de séduction au maximum ! Ton magnétisme fait des ravages aujourd'hui ! 🔥";

        txt += `👤 *DIAGNOSTIC AMOUR SOLO DE *@${senderJid.split('@')[0]}*\n`;
        txt += `📊 Jauge d'Aura Amoureuse : ${genererBarreHP(score, 100)} (${score}%)\n\n`;
        txt += `⚖️ *Jugement & Diagnostic :* ${diagnosticSolo}`;

        await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: [senderJid] }, { quoted: msg }, msg);
        return;
      }

      // 📱 GÉNÉRATEUR QR CODE (.qr)
      if (lowerText.startsWith('.qr')) {
        const contenu = cleanText.replace(/^\.qr\s*/i, '').trim();
        if (!contenu) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Entrez le texte ou l'URL à convertir ! Exemple : `.qr https://google.com`" }, { quoted: msg }, msg);
          return;
        }
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(contenu)}`;
        await envoyerAvecDelai(sock, remoteJid, { image: { url: qrUrl }, caption: `📱 *QR CODE GÉNÉRÉ*` }, { quoted: msg }, msg);
        return;
      }

      // 🎱 BOULE MAGIQUE (8-BALL)
      if (lowerText.startsWith('.8ball')) {
        const question = cleanText.replace(/^\.8ball\s*/i, '').trim();
        if (!question) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Pose une question ! Exemple : `.8ball Est-ce que je vais réussir ?`" }, { quoted: msg }, msg);
          return;
        }

        const reponse = REPONSES_8BALL[Math.floor(Math.random() * REPONSES_8BALL.length)];
        const nomJ = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;

        const text8Ball = `🎱 *BOULE MAGIQUE 8-BALL* 🎱\n\n❓ *Question de ${nomJ} :* ${question}\n🔮 *Réponse :* ${reponse}`;
        await envoyerAvecDelai(sock, remoteJid, { text: text8Ball, mentions: [senderJid] }, { quoted: msg }, msg);
        return;
      }

      // ✋ REJOINDRE UNE ÉQUIPE (.joindre)
      if (lowerText.startsWith('.joindre')) {
        if (!jeu || jeu.statut !== 'INSCRIPTION') {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Aucune inscription ouverte en mode Équipe !" }, { quoted: msg }, msg);
          return;
        }

        const eq = cleanText.replace(/^\.joindre\s*/i, '').trim().toUpperCase();
        if (eq !== 'A' && eq !== 'B') {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Précisez une équipe : `.joindre A` ou `.joindre B`" }, { quoted: msg }, msg);
          return;
        }

        const nomJ = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
        jeu.equipes.A = jeu.equipes.A.filter(j => j.jid !== senderJid);
        jeu.equipes.B = jeu.equipes.B.filter(j => j.jid !== senderJid);

        jeu.equipes[eq].push({ jid: senderJid, nom: nomJ, elimine: false });
        if (!jeu.joueurs.some(j => j.jid === senderJid)) {
          jeu.joueurs.push({ jid: senderJid, nom: nomJ, elimine: false });
        }

        await envoyerAvecDelai(sock, remoteJid, { text: `✅ *${nomJ}* a rejoint l'*ÉQUIPE ${eq}* !\n\n🔴 Équipe A : ${jeu.equipes.A.length} | 🔵 Équipe B : ${jeu.equipes.B.length}` }, { quoted: msg }, msg);
        return;
      }

      // 🧠 CERVEAU (.cerveau)
      if (lowerText.startsWith('.cerveau') || lowerText.includes('cerveau') || lowerText.includes('mox')) {
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

        await envoyerAvecDelai(sock, remoteJid, { text: analyse, mentions: [cibleJid] }, { quoted: msg }, msg);
        return;
      }

      // 🔄 RESTART & STOP
      if (lowerText === '.restart') {
        const dernierType = partiesEnCours[remoteJid]?.dernierType || 'DE';
        reinitialiserJeu(remoteJid);
        if (dernierType === 'BOMBE') return declencherJeuBombe(sock, remoteJid, msg);
        if (dernierType === 'DE') return declencherJeuDe(sock, remoteJid, msg);
        if (dernierType === 'LABYRINTHE') return declencherJeuLabyrinthe(sock, remoteJid, msg);
        if (dernierType === 'FEU_ROUGE') return declencherJeuFeuRouge(sock, remoteJid, msg);
        if (dernierType === 'ROULETTE') return declencherJeuRoulette(sock, remoteJid, msg);
        if (dernierType === 'CHIFFRE') return declencherJeuChiffre(sock, remoteJid, msg);
      }

      if (lowerText === '.stop') {
        reinitialiserJeu(remoteJid);
        await envoyerAvecDelai(sock, remoteJid, { text: "🛑 *Partie annulée.* Tapez `.menu` pour relancer un jeu." }, { quoted: msg }, msg);
        return;
      }

      // 🎮 COMMANDES DE DÉCLENCHEMENT MINI-JEUX
      if (lowerText === '.bombe') return declencherJeuBombe(sock, remoteJid, msg);
      if (lowerText === '.de') return declencherJeuDe(sock, remoteJid, msg);
      if (lowerText === '.lab' || lowerText === '.labyrinthe') return declencherJeuLabyrinthe(sock, remoteJid, msg);
      if (lowerText === '.feurouge') return declencherJeuFeuRouge(sock, remoteJid, msg);
      if (lowerText === '.roulette') return declencherJeuRoulette(sock, remoteJid, msg);
      if (lowerText === '.chiffremystere') return declencherJeuChiffre(sock, remoteJid, msg);

      // 🚀 LANCEMENT DES JEUX
      if (lowerText === '.lancer') {
        if (!jeu || jeu.statut !== 'INSCRIPTION') {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Aucun jeu en attente d'inscription à lancer !" }, { quoted: msg }, msg);
          return;
        }

        if (jeu.joueurs.length < 1) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Au moins 1 joueur doit s'inscrire avec `.inscrire` !" }, { quoted: msg }, msg);
          return;
        }

        jeu.statut = 'EN_COURS';

        if (jeu.type === 'LABYRINTHE') {
          if (jeu.mode === 'EQUIPE' && (jeu.equipes.A.length === 0 || jeu.equipes.B.length === 0)) {
            await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Chaque équipe (A et B) doit contenir au moins 1 joueur ! Tapez `.joindre A` ou `.joindre B`." }, { quoted: msg }, msg);
            jeu.statut = 'INSCRIPTION';
            return;
          }

          jeu.ordreJoueurs = [];
          if (jeu.mode === 'EQUIPE') {
            const max = Math.max(jeu.equipes.A.length, jeu.equipes.B.length);
            for (let i = 0; i < max; i++) {
              if (jeu.equipes.A[i]) jeu.ordreJoueurs.push({ ...jeu.equipes.A[i], eq: 'A' });
              if (jeu.equipes.B[i]) jeu.ordreJoueurs.push({ ...jeu.equipes.B[i], eq: 'B' });
            }
          } else {
            jeu.ordreJoueurs = jeu.joueurs.map(j => ({ ...j, eq: 'SOLO' }));
          }

          jeu.indexTour = 0;
          const premier = jeu.ordreJoueurs[0];
          await envoyerAvecDelai(sock, remoteJid, { 
            text: `🚪 *LABYRINTHE STARTED !*\n\n👥 Mode : *${jeu.mode}* (${jeu.ordreJoueurs.length} joueurs)\n👉 C'est au tour de *${premier.nom}* ${premier.eq !== 'SOLO' ? `(Équipe ${premier.eq})` : ''} !\n\n📍 Choisis : \`@gauche\`, \`@droite\` ou \`@tout droit\`` 
          }, { quoted: msg }, msg);
          return;
        }

        if (jeu.type === 'FEU_ROUGE') {
          await envoyerAvecDelai(sock, remoteJid, { text: `🔴 *SQUID GAME DÉMARRE !*\n👥 *${jeu.joueurs.length} joueurs* sur la ligne de départ !\nPréparez-vous...` }, { quoted: msg }, msg);
          setTimeout(() => lancerMancheFeuRouge(sock, remoteJid), 3000);
          return;
        }

        if (jeu.type === 'ROULETTE') {
          jeu.indexTour = 0;
          jeu.chambresRestantes = 6;
          const premier = jeu.joueurs[0];
          await envoyerAvecDelai(sock, remoteJid, { 
            text: `💀 *ROULETTE RUSSE STARTED !*\n\n👥 *${jeu.joueurs.length} candidats* inscrits !\n🔫 1 Balle engagée dans le barillet.\n\n👉 C'est le tour de *${premier.nom}* ! Tapez *@tirer* !` 
          }, { quoted: msg }, msg);
          return;
        }

        if (jeu.type === 'CHIFFRE') {
          let listStr = jeu.joueurs.map(j => `• ${j.nom}`).join('\n');
          await envoyerAvecDelai(sock, remoteJid, { 
            text: `🔢 *CHIFFRE MYSTÈRE (1-100) STARTED !*\n\n🎯 Joueurs en compétition :\n${listStr}\n\n👉 Le premier qui trouve gagne ! Écrivez un chiffre dans le tchat !` 
          }, { quoted: msg }, msg);
          return;
        }

        if (jeu.type === 'BOMBE') {
          jeu.indexTour = 0;
          const premier = jeu.joueurs[0];
          await envoyerAvecDelai(sock, remoteJid, { 
            text: `💣 *BOMBE DÉSAMORÇAGE D'ÉQUIPE STARTED !*\n\n👥 Joueurs : *${jeu.joueurs.length}*\n👉 C'est au tour de *${premier.nom}* de désamorcer !\n✂️ Tapez \`@rouge\`, \`@bleu\` ou \`@jaune\` ! (15s)` 
          }, { quoted: msg }, msg);
          demarrerChronoBombeGroupe(sock, remoteJid);
          return;
        }
      }

      // 🎯 DÉROULEMENT DES ACTIONS DE JEU EN COURS
      if (jeu && jeu.statut === 'EN_COURS') {

        if (jeu.type === 'BOMBE') {
          const joueurActuel = jeu.joueurs[jeu.indexTour];
          if (senderJid === joueurActuel.jid && (lowerText === '@rouge' || lowerText === '@bleu' || lowerText === '@jaune')) {
            clearTimeout(jeu.timerBombe);
            const filChoisi = lowerText.replace('@', '');

            if (filChoisi === jeu.bonFil) {
              partiesEnCours[remoteJid] = { dernierType: 'BOMBE' };
              await envoyerAvecDelai(sock, remoteJid, { text: `🟢 *BOMBE DÉSAMORCÉE PAR ${joueurActuel.nom.toUpperCase()} !* 🟢\n\n✂️ Le fil *${filChoisi.toUpperCase()}* était le bon !\n🏆 Toute l'équipe l'emporte ! 🎉\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, msg);
            } else {
              joueurActuel.elimine = true;
              const restants = jeu.joueurs.filter(j => !j.elimine);

              if (restants.length === 0) {
                partiesEnCours[remoteJid] = { dernierType: 'BOMBE' };
                await envoyerAvecDelai(sock, remoteJid, { text: `💥 *BOOOOOOOM GENERAL !* 💥\n\n*${joueurActuel.nom}* a coupé le mauvais fil (*${filChoisi.toUpperCase()}*). Le bon fil était *${jeu.bonFil.toUpperCase()}*.\n💀 Tout le groupe est éliminé !\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, msg);
              } else {
                jeu.indexTour = (jeu.indexTour + 1) % restants.length;
                const prochain = restants[jeu.indexTour];
                await envoyerAvecDelai(sock, remoteJid, { text: `💥 *${joueurActuel.nom}* a sauté en coupant le fil *${filChoisi.toUpperCase()}* !\n\n👉 La bombe tourne ! C'est à *${prochain.nom}* de choisir un fil !` }, { quoted: msg }, msg);
                demarrerChronoBombeGroupe(sock, remoteJid);
              }
            }
            return;
          }
        }

        if (jeu.type === 'LABYRINTHE') {
          const dirMap = { '@gauche': 'gauche', '@droite': 'droite', '@tout droit': 'tout droit' };
          if (dirMap[lowerText]) {
            const joueurActuel = jeu.ordreJoueurs[jeu.indexTour];

            if (senderJid !== joueurActuel.jid) {
              await envoyerAvecDelai(sock, remoteJid, { text: `⏳ *Ce n'est pas ton tour !* C'est à *${joueurActuel.nom}* ${joueurActuel.eq !== 'SOLO' ? `(Équipe ${joueurActuel.eq})` : ''} de répondre.` }, { quoted: msg }, msg);
              return;
            }

            const dirChoisie = dirMap[lowerText];
            const cheminActuel = CHEMINS_LABYRINTHE[jeu.indexChemin];
            const bonneDirection = cheminActuel[jeu.étape];

            if (dirChoisie === bonneDirection) {
              jeu.étape += 1;
              if (jeu.étape >= 10) {
                partiesEnCours[remoteJid] = { dernierType: 'LABYRINTHE' };
                const victoireMsg = jeu.mode === 'EQUIPE' ? `🏆 *VICTOIRE DE L'ÉQUIPE ${joueurActuel.eq} !* 🏆\n\n🎉 *${joueurActuel.nom}* a guidé son équipe hors du labyrinthe !` : `🏆 *VICTOIRE DE ${joueurActuel.nom.toUpperCase()} !* 🏆\n\n🎉 Il est sorti premier du labyrinthe !`;
                await envoyerAvecDelai(sock, remoteJid, { text: `${victoireMsg}\n\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, msg);
                return;
              } else {
                jeu.indexTour = (jeu.indexTour + 1) % jeu.ordreJoueurs.length;
                const prochain = jeu.ordreJoueurs[jeu.indexTour];
                await envoyerAvecDelai(sock, remoteJid, { text: `✨ *${joueurActuel.nom}* a pris la bonne voie ! (Étape ${jeu.étape}/10)\n\n👉 C'est au tour de *${prochain.nom}* ${prochain.eq !== 'SOLO' ? `(Équipe ${prochain.eq})` : ''} !` }, { quoted: msg }, msg);
              }
            } else {
              jeu.vie = Math.max(0, jeu.vie - 15);
              if (jeu.vie <= 0) {
                partiesEnCours[remoteJid] = { dernierType: 'LABYRINTHE' };
                await envoyerAvecDelai(sock, remoteJid, { text: `💀 *${joueurActuel.nom}* s'est trompé de voie ! La santé du groupe est tombée à 0%...\n\n💥 *FIN DE LA PARTIE (PERDU)*\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, msg);
                return;
              } else {
                jeu.indexTour = (jeu.indexTour + 1) % jeu.ordreJoueurs.length;
                const prochain = jeu.ordreJoueurs[jeu.indexTour];
                await envoyerAvecDelai(sock, remoteJid, { text: `❌ Mauvaise voie par *${joueurActuel.nom}* ! Santé : ${genererBarreHP(jeu.vie)}\n\n👉 Le relais passe à *${prochain.nom}* ${prochain.eq !== 'SOLO' ? `(Équipe ${prochain.eq})` : ''} !` }, { quoted: msg }, msg);
              }
            }
            return;
          }
        }

        if (jeu.type === 'ROULETTE' && lowerText === '@tirer') {
          const restants = jeu.joueurs.filter(j => !j.elimine);
          const joueurActuel = restants[jeu.indexTour % restants.length];

          if (senderJid !== joueurActuel.jid) {
            await envoyerAvecDelai(sock, remoteJid, { text: `⏳ C'est au tour de *${joueurActuel.nom}* de presser la détente avec *@tirer* !` }, { quoted: msg }, msg);
            return;
          }

          if (Math.random() < (1 / jeu.chambresRestantes)) {
            joueurActuel.elimine = true;
            const nouveauxRestants = jeu.joueurs.filter(j => !j.elimine);

            if (nouveauxRestants.length <= 1) {
              const gagnant = nouveauxRestants[0] ? nouveauxRestants[0].nom : "Personne";
              partiesEnCours[remoteJid] = { dernierType: 'ROULETTE' };
              await envoyerAvecDelai(sock, remoteJid, { text: `💥 *PAN !* *${joueurActuel.nom}* est éliminé !\n\n🏆 *SURVIVANT ULTIME :* *${gagnant.toUpperCase()}* remporte la Roulette Russe ! 🎉\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, msg);
            } else {
              jeu.chambresRestantes = 6;
              jeu.indexTour = jeu.indexTour % nouveauxRestants.length;
              const prochain = nouveauxRestants[jeu.indexTour];
              await envoyerAvecDelai(sock, remoteJid, { text: `💥 *PAN !* Élimination de *${joueurActuel.nom}* !\n\n🔄 Barillet rechargé (6 chambres).\n👉 Au tour de *${prochain.nom}*. Tapez *@tirer* !` }, { quoted: msg }, msg);
            }
          } else {
            jeu.chambresRestantes = Math.max(1, jeu.chambresRestantes - 1);
            jeu.indexTour = (jeu.indexTour + 1) % restants.length;
            const prochain = restants[jeu.indexTour];
            await envoyerAvecDelai(sock, remoteJid, { text: `⚙️ *CLIC !* Chambre vide pour *${joueurActuel.nom}*.\n\n👉 Au tour de *${prochain.nom}* (${jeu.chambresRestantes} chambres restantes). Tapez *@tirer* !` }, { quoted: msg }, msg);
          }
          return;
        }

        if (jeu.type === 'CHIFFRE' && !isNaN(cleanText)) {
          const prop = parseInt(cleanText, 10);
          const nomJ = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
          jeu.essais = (jeu.essais || 0) + 1;

          if (prop === jeu.secret) {
            partiesEnCours[remoteJid] = { dernierType: 'CHIFFRE' };
            await envoyerAvecDelai(sock, remoteJid, { text: `🏆 *VICTOIRE DE ${nomJ.toUpperCase()} !* 🏆\n\n🎯 Il a trouvé le chiffre mystère *${jeu.secret}* en *${jeu.essais} essai(s)* !\n\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg }, msg);
          } else {
            const ind = prop < jeu.secret ? "📈 *C'est PLUS GRAND !*" : "📉 *C'est PLUS PETIT !*";
            await envoyerAvecDelai(sock, remoteJid, { text: `${ind} (Proposé par *${nomJ}*)` }, { quoted: msg }, msg);
          }
          return;
        }

        if (jeu.type === 'FEU_ROUGE' && jeu.attenteReponse && cleanText.startsWith('@')) {
          const saisi = cleanText.substring(1).trim().toLowerCase();
          if (saisi === jeu.motAValider.toLowerCase()) {
            const j = jeu.joueurs.find(j => j.jid === senderJid);
            if (j && !j.aRepondu && !j.elimine) {
              j.aRepondu = true;
              await envoyerAvecDelai(sock, remoteJid, { text: `⚡ *${j.nom}* a traversé avec succès !` }, { quoted: msg }, msg);
            }
          }
          return;
        }

      }

    } catch (err) {
      console.error("⚠️ Erreur globale :", err);
    }
  });
}

// 🛠️ DÉCLENCHEURS DE JEUX
function declencherJeuBombe(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  const fils = ['rouge', 'bleu', 'jaune'];
  partiesEnCours[remoteJid] = {
    type: 'BOMBE',
    statut: 'INSCRIPTION',
    bonFil: fils[Math.floor(Math.random() * fils.length)],
    joueurs: []
  };

  return envoyerAvecDelai(sock, remoteJid, { text: `💣 *DÉSACTIVATION DE LA BOMBE EN GROUPE* 💣\n\nTous les démineurs doivent s'inscrire !\n👉 Tapez *.inscrire [Nom]* puis *.lancer* !` }, { quoted: msg }, msg);
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
        await envoyerAvecDelai(sock, remoteJid, { text: `💥 *BOOOOOOOM !* perdu 🤣🤣🤣🤣 *${joueurActuel.nom}*...\n💀 Toute l'équipe a été exterminée !` });
      } else {
        jeu.indexTour = (jeu.indexTour + 1) % restants.length;
        const prochain = restants[jeu.indexTour];
        await envoyerAvecDelai(sock, remoteJid, { text: `💥 Temps écoulé ! *${joueurActuel.nom}* est éliminé !\n👉 Le relais passe à *${prochain.nom}* (15s) !` });
        demarrerChronoBombeGroupe(sock, remoteJid);
      }
    }
  }, 15000);
}

function declencherJeuDe(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'DE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🎲 *JEU DU DÉ EN GROUPE*\n\n👉 Inscrivez-vous avec *.inscrire [Nom]* puis tapez *.lancer* !` }, { quoted: msg }, msg);
}

function declencherJeuLabyrinthe(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = {
    type: 'LABYRINTHE',
    statut: 'INSCRIPTION',
    mode: 'EQUIPE',
    indexChemin: Math.floor(Math.random() * CHEMINS_LABYRINTHE.length),
    étape: 0,
    vie: 100,
    joueurs: [],
    equipes: { A: [], B: [] }
  };

  const textIntro = `🚪 *LABYRINTHE MULTI-JOUEURS (1V1 & ÉQUIPES)* 🚪\n\n` +
    `Traversez le labyrinthe en équipe ou à 2 contre 2 / 4 contre 4 !\n` +
    `À chaque étape, le bot passe le relais au joueur suivant !\n\n` +
    `👉 Rejoignez avec \`.joindre A\` ou \`.joindre B\` puis tapez *.lancer* !`;

  return envoyerAvecDelai(sock, remoteJid, { text: textIntro }, { quoted: msg }, msg);
}

function declencherJeuFeuRouge(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'FEU_ROUGE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🔴 *SQUID GAME GROUPE*\n\n👉 Inscriptions : *.inscrire [Nom]* puis *.lancer* !` }, { quoted: msg }, msg);
}

function declencherJeuRoulette(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'ROULETTE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `💀 *ROULETTE RUSSE GROUPE*\n\n👉 Inscriptions : *.inscrire [Nom]* puis *.lancer* !` }, { quoted: msg }, msg);
}

function declencherJeuChiffre(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'CHIFFRE', statut: 'INSCRIPTION', joueurs: [], secret: Math.floor(Math.random() * 100) + 1, essais: 0 };
  return envoyerAvecDelai(sock, remoteJid, { text: `🔢 *CHIFFRE MYSTÈRE EN GROUPE (1-100)*\n\n👉 Inscriptions : *.inscrire [Nom]* puis *.lancer* !` }, { quoted: msg }, msg);
}

async function lancerMancheFeuRouge(sock, remoteJid) {
  const jeu = partiesEnCours[remoteJid];
  if (!jeu || jeu.type !== 'FEU_ROUGE') return;

  const mot = MOTS_SQUID[Math.floor(Math.random() * MOTS_SQUID.length)];
  jeu.motAValider = mot;
  jeu.attenteReponse = true;
  jeu.joueurs.forEach(j => j.aRepondu = false);

  let tempsSec = 8 + Math.floor(Math.random() * 3);

  await envoyerAvecDelai(sock, remoteJid, { text: `🔴 *FEU ROUGE !*\n\n👉 Tapez vite *@${mot}* dans le tchat !\n⏰ Temps disponible : *${tempsSec} secondes* !` });

  jeu.timerFeu = setTimeout(async () => {
    jeu.attenteReponse = false;

    jeu.joueurs.forEach(j => {
      if (!j.aRepondu) j.elimine = true;
    });

    const survivants = jeu.joueurs.filter(j => !j.elimine);
    await envoyerAvecDelai(sock, remoteJid, { text: `🟢 *FEU VERT !* Fin du chrono !` });

    if (survivants.length === 0) {
      partiesEnCours[remoteJid] = { dernierType: 'FEU_ROUGE' };
      await envoyerAvecDelai(sock, remoteJid, { text: `💥 *ÉLIMINATION TOTALE !* Tout le monde a bougé !` });
    } else if (survivants.length === 1) {
      partiesEnCours[remoteJid] = { dernierType: 'FEU_ROUGE' };
      await envoyerAvecDelai(sock, remoteJid, { text: `🏆 *CHAMPION SQUID GAME !* *${survivants[0].nom.toUpperCase()}* gagne la partie ! 🎉` });
    } else {
      await envoyerAvecDelai(sock, remoteJid, { text: `📊 *Survivants :* ${survivants.length} joueurs encore en lice.\n⚡ Prochaine manche imminente...` });
      setTimeout(() => lancerMancheFeuRouge(sock, remoteJid), 3000);
    }
  }, tempsSec * 1000);
}

startBot();
