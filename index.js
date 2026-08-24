// ⚡ FIX CRYPTO POUR RENDER & BAILEYS
const crypto = require('crypto');
if (!globalThis.crypto) globalThis.crypto = crypto;

const fs = require('fs');
const express = require("express");
const https = require("https");
const { GoogleGenerativeAI } = require('@google/generative-ai');
const youtubedl = require('youtube-dl-exec');
const gTTS = require('gtts');

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
  sessionsMotDePasse,
  profilsJoueurs,
  membresSalues
} = data;

const app = express();
const PORT = process.env.PORT || 3000;

// Anti-doublons
const processedMessages = new Set();

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
      });
    }
  }, 3 * 60 * 1000);
}

function calculerDelaiEnvoi(texte) {
  if (!texte || typeof texte !== 'string') return 1000;
  const nbMots = texte.trim().split(/\s+/).filter(Boolean).length;
  let minSec = nbMots < 50 ? 1.0 : 2.5;
  let maxSec = nbMots < 50 ? 2.0 : 4.0;
  return Math.floor((minSec + Math.random() * (maxSec - minSec)) * 1000);
}

async function envoyerAvecDelai(sock, remoteJid, content, options = {}) {
  try {
    const texte = typeof content === 'string' ? content : (content.text || content.caption || "");
    const delaiMs = calculerDelaiEnvoi(texte);

    await sock.sendPresenceUpdate('composing', remoteJid);
    await new Promise(resolve => setTimeout(resolve, delaiMs));
    await sock.sendPresenceUpdate('paused', remoteJid);

    const sentMsg = await sock.sendMessage(remoteJid, content, options);
    if (sentMsg && sentMsg.key && sentMsg.key.id) {
      processedMessages.add(sentMsg.key.id);
    }
    return sentMsg;
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
      console.log(`❌ Connexion fermée. Code de statut : ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log("❌ Déconnecté de WhatsApp. Nettoyage de la session...");
        await clearSession();
      } else {
        console.log("🔄 Tentative de reconnexion dans 5 secondes...");
        setTimeout(() => startBot(), 5000);
      }
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

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || !msg.message) return;

      const messageId = msg.key.id;
      if (processedMessages.has(messageId)) return;
      processedMessages.add(messageId);
      if (processedMessages.size > 2000) processedMessages.clear();

      const remoteJid = msg.key.remoteJid;
      const senderJid = msg.key.participant || (msg.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : remoteJid);
      const estGroupe = remoteJid.endsWith('@g.us');

      await sock.readMessages([msg.key]);

      const viewOnceMsg = 
        msg.message.viewOnceMessageV2?.message || 
        msg.message.viewOnceMessage?.message ||
        msg.message.viewOnceMessageV2Extension?.message;

      if (viewOnceMsg) {
        const type = Object.keys(viewOnceMsg)[0];
        const media = viewOnceMsg[type];

        if (type === 'imageMessage' || type === 'videoMessage') {
          try {
            const stream = await downloadContentFromMessage(
              media, 
              type === 'imageMessage' ? 'image' : 'video'
            );
            
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
              buffer = Buffer.concat([buffer, chunk]);
            }

            const captionText = media.caption ? `\n📝 *Légende :* ${media.caption}` : '';
            const textReveal = `🔓 *IL N'Y A PAS DE SECRET ICI !*${captionText}`;

            if (type === 'imageMessage') {
              await envoyerAvecDelai(sock, remoteJid, { image: buffer, caption: textReveal }, { quoted: msg });
            } else {
              await envoyerAvecDelai(sock, remoteJid, { video: buffer, caption: textReveal }, { quoted: msg });
            }

            vueUniqueCache[remoteJid] = { 
              buffer, 
              type: type === 'imageMessage' ? 'image' : 'video', 
              caption: media.caption || "" 
            };
            vueUniqueCache[msg.key.id] = vueUniqueCache[remoteJid];
            return;
          } catch (e) {
            console.error("⚠️ Erreur lors du téléchargement Vue Unique :", e);
          }
        }
      }

      const cleanText = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "").trim();
      const lowerText = cleanText.toLowerCase();

      if (!cleanText) return;

      // 💖 REPONSE AUTO AMOUR
      if (MOTS_AMOUR_PRIVE.includes(lowerText)) {
        await envoyerAvecDelai(sock, remoteJid, { text: REPONSE_AMOUR_MAMAN }, { quoted: msg });
        return;
      }

      const jeu = partiesEnCours[remoteJid];
      demarrerTimerInactivite(sock, remoteJid);

      // 🪙 PILE OU FACE (.pf)
      if (lowerText === '.pf' || lowerText === '.pileouface') {
        const resultat = Math.random() < 0.5 ? "🪙 *PILE !*" : "🪙 *FACE !*";
        await envoyerAvecDelai(sock, remoteJid, { text: resultat }, { quoted: msg });
        return;
      }

      // ✂️ CHIFOUMI INVERSÉ (.chifoumi)
      if (lowerText.startsWith('.chifoumi')) {
        const choixUser = cleanText.replace(/^\.chifoumi\s*/i, '').toLowerCase().trim();
        const options = ['pierre', 'papier', 'ciseaux'];
        if (!options.includes(choixUser)) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Choisis entre : `.chifoumi pierre` , `.chifoumi papier` ou `.chifoumi ciseaux` (Règle inversée : il faut perdre pour gagner !)" }, { quoted: msg });
          return;
        }
        const choixBot = options[Math.floor(Math.random() * options.length)];
        
        let status = "Perdu ! Tu as gagné la partie inversée ! 🎉";
        if (choixUser === choixBot) status = "Égalité ! Recommence 🤝";
        else if (
          (choixUser === 'pierre' && choixBot === 'papier') ||
          (choixUser === 'papier' && choixBot === 'ciseaux') ||
          (choixUser === 'ciseaux' && choixBot === 'pierre')
        ) {
          status = "C'est gagné classiquement... donc tu *PERDS* au Chifoumi inversé ! 💀";
        }

        await envoyerAvecDelai(sock, remoteJid, { text: `🤖 Le bot a choisi : *${choixBot}*\n👤 Ton choix : *${choixUser}*\n\n🎯 *Résultat :* ${status}` }, { quoted: msg });
        return;
      }

      // ❌ TIC-TAC-TOE (Morpion)
      if (lowerText.startsWith('.morpion') || lowerText.startsWith('.tictactoe')) {
        await envoyerAvecDelai(sock, remoteJid, { text: `❌⭕ *MORPION 1VS1*\n\nLe module de morpion interactif est prêt à être configuré entre deux joueurs en PV !` }, { quoted: msg });
        return;
      }

      // 🎵 TÉLÉCHARGEUR YOUTUBE AUDIO (.ytmp3)
      if (lowerText.startsWith('.ytmp3') || lowerText.startsWith('.yta')) {
        const urlYt = cleanText.replace(/^\.(ytmp3|yta)\s*/i, '').trim();
        if (!urlYt) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Envoie un lien YouTube ! Exemple : `.ytmp3 https://youtu.be/...`" }, { quoted: msg });
          return;
        }

        await envoyerAvecDelai(sock, remoteJid, { text: "⏳ Téléchargement et conversion audio en cours..." }, { quoted: msg });
        try {
          const outputAudioPath = `./audio_${Date.now()}.mp3`;
          await youtubedl(urlYt, {
            extractAudio: true,
            audioFormat: 'mp3',
            output: outputAudioPath
          });

          if (fs.existsSync(outputAudioPath)) {
            await sock.sendMessage(remoteJid, { 
              audio: { url: outputAudioPath }, 
              mimetype: 'audio/mp4', 
              ptt: false 
            }, { quoted: msg });
            fs.unlinkSync(outputAudioPath);
          }
        } catch (e) {
          console.error(e);
          await envoyerAvecDelai(sock, remoteJid, { text: "❌ Erreur lors du téléchargement de la vidéo YouTube." }, { quoted: msg });
        }
        return;
      }

      // 🔍 RECHERCHE D'IMAGE GOOGLE / UNSPLASH (.image)
      if (lowerText.startsWith('.image') || lowerText.startsWith('.img')) {
        const queryImg = cleanText.replace(/^\.(image|img)\s*/i, '').trim();
        if (!queryImg) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Précise ce que tu recherches ! Exemple : `.image chaton drôle`" }, { quoted: msg });
          return;
        }
        const searchImageUrl = `https://picsum.photos/seed/${encodeURIComponent(queryImg)}/800/600`;
        await envoyerAvecDelai(sock, remoteJid, { image: { url: searchImageUrl }, caption: `🔍 *Résultat pour :* ${queryImg}` }, { quoted: msg });
        return;
      }

      // 🗣️ SYNTHÈSE VOCALE TTS (.tts)
      if (lowerText.startsWith('.tts')) {
        const texteTts = cleanText.replace(/^\.tts\s*/i, '').trim();
        if (!texteTts) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Écris un texte à vocaliser ! Exemple : `.tts Bonjour tout le monde`" }, { quoted: msg });
          return;
        }

        try {
          const ttsPath = `./tts_${Date.now()}.mp3`;
          const gtts = new gTTS(texteTts, 'fr');

          gtts.save(ttsPath, async function (err) {
            if (err) {
              await envoyerAvecDelai(sock, remoteJid, { text: "❌ Erreur lors de la génération de la voix." }, { quoted: msg });
              return;
            }
            await sock.sendMessage(remoteJid, { 
              audio: { url: ttsPath }, 
              mimetype: 'audio/ogg; codecs=opus', 
              ptt: true 
            }, { quoted: msg });
            
            if (fs.existsSync(ttsPath)) fs.unlinkSync(ttsPath);
          });
        } catch (e) {
          console.error(e);
          await envoyerAvecDelai(sock, remoteJid, { text: "❌ Erreur interne du module TTS." }, { quoted: msg });
        }
        return;
      }

      // 👨‍💻 SIMULATION HACK ANIMÉE (.hack)
      if (lowerText.startsWith('.hack')) {
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!mention) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Mentionne la personne à pirater ! Exemple : `.hack @mention`" }, { quoted: msg });
          return;
        }

        const pseudo = `@${mention.split('@')[0]}`;
        const targetIp = `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;

        const { key } = await sock.sendMessage(remoteJid, { text: `👨‍💻 *PIRATAGE EN COURS DE ${pseudo}...*\n[░░░░░░░░░░] 0%` }, { quoted: msg });

        const etapes = [
          { txt: `👨‍💻 *PIRATAGE DE ${pseudo}...*\n📡 Recherche de l'adresse IP... [${targetIp}]\n[██░░░░░░░░] 20%`, delay: 1500 },
          { txt: `👨‍💻 *PIRATAGE DE ${pseudo}...*\n🔓 Contournement du pare-feu WhatsApp...\n[████░░░░░░] 40%`, delay: 2000 },
          { txt: `👨‍💻 *PIRATAGE DE ${pseudo}...*\n📥 Extraction des messages et photos cachées...\n[███████░░░] 70%`, delay: 2000 },
          { txt: `👨‍💻 *PIRATAGE DE ${pseudo}...*\n🌐 Téléversement sur le Dark Web...\n[██████████] 100%`, delay: 1500 },
          { txt: `⚠️ *PIRATAGE RÉUSSI DE ${pseudo} !*\n\n📌 *Adresse IP :* ${targetIp}\n🔐 *Mots de passe extraits :* 14\n📸 *Photos récupérées :* 342\n💬 *Conversations envoyées au Dark Web !* 😈`, delay: 1000 }
        ];

        for (const step of etapes) {
          await new Promise(res => setTimeout(res, step.delay));
          await sock.sendMessage(remoteJid, { text: step.txt, edit: key, mentions: [mention] });
        }
        return;
      }

      // 🪪 FICHE DU MEMBRE (.fiche / .rang)
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

        await envoyerAvecDelai(sock, remoteJid, { text: card, mentions: [cible] }, { quoted: msg });
        return;
      }

      // ✨ TEXTE STYLÉ (.fancy)
      if (lowerText.startsWith('.fancy')) {
        const texte = cleanText.replace(/^\.fancy\s*/i, '').trim();
        if (!texte) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Entre du texte ! Exemple : `.fancy Salut Titan`" }, { quoted: msg });
          return;
        }

        const fancy = texte.toUpperCase().split('').join(' ⚡ ');
        await envoyerAvecDelai(sock, remoteJid, { text: `✨ ${fancy} ✨` }, { quoted: msg });
        return;
      }

      // ⚖️ BALANCE (Ange, Démon)
      if (lowerText.startsWith('.balance')) {
        const mention = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const cible = mention || senderJid;
        const prenom = `@${cible.split('@')[0]}`;

        const bonneAction = Math.floor(Math.random() * 101);
        const mauvaiseAction = 100 - bonneAction;

        let verdict = "";
        if (bonneAction > mauvaiseAction) {
          verdict = `est un ange. 😇`;
        } else if (mauvaiseAction > bonneAction) {
          verdict = `est un démon. 😈`;
        } else {
          const frasesHasard = [
            "ne sait plus où donner de la tête 😂",
            "a un comportement totalement imprévisible 🤡",
            "plante un bug dans la matrice 🌀",
            "balance une grosse dinguerie au hasard 🤪"
          ];
          verdict = frasesHasard[Math.floor(Math.random() * frasesHasard.length)];
        }

        const texteBalance = `⚖️ *BALANCE DES ACTIONS* ⚖️\n\n` +
          `👤 Membre : ${prenom}\n\n` +
          `😌 Bonne action : ${genererBarreHP(bonneAction, 100)} (${bonneAction}%)\n` +
          `😈 Mauvaise action : ${genererBarreHP(mauvaiseAction, 100)} (${mauvaiseAction}%)\n\n` +
          `🔮 *Verdict :* ${prenom} ${verdict}`;

        await envoyerAvecDelai(sock, remoteJid, { text: texteBalance, mentions: [cible] }, { quoted: msg });
        return;
      }

      // 📜 HUB PRINCIPAL & SOUS-MENUS
      if (lowerText === '.menu' || lowerText === 'menu') {
        const nomAffiche = profilsJoueurs[senderJid] || "Membre VIP";
        const menuPrincipal = `⚡🔥 *TITAN ARCHIVE® — HUB PRINCIPAL* 🔥⚡
_COLLAB' OFFICIELLE X ${nomAffiche.toUpperCase()}_
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
« L'art du détail, la puissance du game. » 💎🕶️

Choisis ton catalogue en tapant la commande associée :

🏷️ \`.menu1\` ➔ Chapitre I : Identité & Compte
🐕 \`.menu2\` ➔ Chapitre II : Compagnon & Familier
🛠️ \`.menu3\` ➔ Chapitre III : Outils & Tech
🎮 \`.menu4\` ➔ Chapitre IV : Zone de Combat (Jeux)
⚙️ \`.menu5\` ➔ Chapitre V : Contrôle de l'Équipe (Guide)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_ÉDITION LIMITÉE — TOUS DROITS RÉSERVÉS_ ⚡`;

        await envoyerAvecDelai(sock, remoteJid, { text: menuPrincipal }, { quoted: msg });
        return;
      }

      if (lowerText === '.menu1') {
        const menu1 = `🏷️ **[ CHAPITRE I : IDENTITÉ & COMPTE ]**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• 🪪 \`.inscrire [Nom]\` ➔ Enregistrer ton pass VIP
• ✏️ \`.pseudo [Nom]\` ➔ Customiser ton blaze
• 🎖️ \`.fiche\` ou \`.rang\` ➔ Consulter ta carte & ton grade
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Tape \`.menu\` pour revenir au hub._`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu1 }, { quoted: msg });
        return;
      }

      if (lowerText === '.menu2') {
        const menu2 = `🐕 **[ CHAPITRE II : COMPAGNON & FAMILIER ]**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• 🐾 \`.toutou\` ➔ Vérifier l'état de ton animal signature
• 🍖 \`.nourrir\` ➔ Ravitailler la bête
• 💤 \`.dodo\` ➔ Mode repos / Récupération
• 🛹 \`.parc\` ➔ Sortir le bestiau en session
• 🩺 \`.soigner\` ➔ Kit de secours médical d'urgence
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Tape \`.menu\` pour revenir au hub._`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu2 }, { quoted: msg });
        return;
      }

      if (lowerText === '.menu3') {
        const menu3 = `🛠️ **[ CHAPITRE III : OUTILS & TECH ]**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• 🤖 \`.iagmini [question]\` ➔ Assistant IA Neural
• 🔮 \`.8ball [question]\` ➔ Boule de cristal magique
• 👁️ \`.v\` ➔ Mode Ninja (Revoir la vue unique)
• 📸 \`.pp [@mention]\` ➔ Inspecter la photo de profil cible
• 💘 \`.love [@mention(s)]\` ➔ Test d'amour & aura du crew
• 📱 \`.qr [texte]\` ➔ Générer un Code Matrix personnalisé
• 🧠 \`.cerveau [@mention]\` ➔ Scanner l'activité mentale
• 💻 \`.hack [@mention]\` ➔ Simulation d'infiltration Dark Web
• ✨ \`.fancy [texte]\` ➔ Typographie custom et stylée
• ⚖️ \`.balance [@mention]\` ➔ Jauge Ange 😇 ou Démon 😈
• 🎵 \`.ytmp3 [lien]\` ➔ Télécharger une vidéo en audio
• 🔍 \`.image [mot-clé]\` ➔ Recherche d'image Google
• 🗣️ \`.tts [texte]\` ➔ Synthèse vocale homme grave
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Tape \`.menu\` pour revenir au hub._`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu3 }, { quoted: msg });
        return;
      }

      if (lowerText === '.menu4') {
        const menu4 = `🎮 **[ CHAPITRE IV : ZONE DE COMBAT (JEUX) ]**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• 💣 \`.bombe\` ➔ Désamorçage tactique en escouade
• 🎲 \`.de\` ➔ Le jet de dés du destin
• 🌀 \`.lab\` ➔ Labyrinthe des catacombes
• 🚨 \`.feurouge\` ➔ Squid Game (Jeu du feu rouge)
• 🔫 \`.roulette\` ➔ Roulette Russe (Chambre mortelle)
• 🎯 \`.chiffremystere\` ➔ Le code secret (1 à 100)
• 🪙 \`.pf\` ➔ Pile ou Face rapide
• ✌️ \`.chifoumi [choix]\` ➔ Chifoumi inversé (duel)
• ❌ \`.morpion\` ➔ Jeu du Morpion 1 vs 1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Tape \`.menu\` pour revenir au hub._`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu4 }, { quoted: msg });
        return;
      }

      if (lowerText === '.menu5') {
        const menu5 = `⚙️ **[ CHAPITRE V : CONTRÔLE DE L'ÉQUIPE (GUIDE) ]**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• 🤝 \`.joindre [A/B]\` ➔ Rejoindre le crew (Équipe A ou B)
• 🚀 \`.lancer\` ➔ Activer le protocole de départ
• 🔄 \`.restart\` ➔ Relancer le dernier round
• 🛑 \`.stop\` ➔ Couper net la session active
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Tape \`.menu\` pour revenir au hub._`;
        await envoyerAvecDelai(sock, remoteJid, { text: menu5 }, { quoted: msg });
        return;
      }

      // 🤖 IA GEMINI (.iagmini)
      if (lowerText.startsWith('.iagmini')) {
        const question = cleanText.replace(/^\.iagmini\s*/i, '').trim();
        if (!question) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Pose une question à l'IA ! Exemple : `.iagmini Donne-moi une recette facile`" }, { quoted: msg });
          return;
        }

        const API_KEY = process.env.GEMINI_API_KEY;

        if (!API_KEY) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Clé API non configurée ! Veuillez définir `GEMINI_API_KEY` dans vos variables d'environnement." }, { quoted: msg });
          return;
        }

        try {
          const genAI = new GoogleGenerativeAI(API_KEY);
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

          const result = await model.generateContent(question);
          const replyText = result.response.text() || "Désolé, l'IA n'a pas pu générer de réponse.";
          
          await envoyerAvecDelai(sock, remoteJid, { text: `🤖 *IAGmini :*\n\n${replyText}` }, { quoted: msg });
        } catch (err) {
          console.error("Erreur IAGmini :", err);
          await envoyerAvecDelai(sock, remoteJid, { text: "❌ Une erreur s'est produite lors de la connexion à l'IA. Vérifiez votre clé API." }, { quoted: msg });
        }
        return;
      }

      // ✏️ MODIFIER SON PSEUDO
      if (lowerText.startsWith('.pseudo')) {
        const nouveauNom = cleanText.replace(/^\.pseudo\s*/i, '').trim();
        if (!nouveauNom) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Précisez votre nouveau nom ! Exemple : `.pseudo Titan`" }, { quoted: msg });
          return;
        }
        profilsJoueurs[senderJid] = nouveauNom;
        await envoyerAvecDelai(sock, remoteJid, { text: `✅ Votre pseudo a été mis à jour : *${nouveauNom}*` }, { quoted: msg });
        return;
      }

      // 📝 INSCRIPTION AU BOT / JEU
      if (lowerText.startsWith('.inscrire')) {
        const nomEntre = cleanText.replace(/^\.inscrire\s*/i, '').trim();
        if (!nomEntre) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Entrez votre nom ! Exemple : `.inscrire Andy`" }, { quoted: msg });
          return;
        }

        profilsJoueurs[senderJid] = nomEntre;

        if (jeu && jeu.statut === 'INSCRIPTION') {
          if (!jeu.joueurs.some(j => j.jid === senderJid)) {
            jeu.joueurs.push({ jid: senderJid, nom: nomEntre, elimine: false, score: 0 });
            await envoyerAvecDelai(sock, remoteJid, { text: `✅ *${nomEntre}* a rejoint la partie ! (${jeu.joueurs.length} inscrit(s))` }, { quoted: msg });
            return;
          }
        }

        await envoyerAvecDelai(sock, remoteJid, { text: `🎉 *PROFIL ENREGISTRÉ !*\nBienvenue *${nomEntre}* !` }, { quoted: msg });
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
        await envoyerAvecDelai(sock, remoteJid, { text: statusPet }, { quoted: msg });
        return;
      }

      if (['.nourrir', '.dodo', '.parc', '.soigner'].includes(lowerText)) {
        if (!animauxJoueurs[senderJid]) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Tapez `.toutou` d'abord pour adopter votre animal !" }, { quoted: msg });
          return;
        }
        const pet = animauxJoueurs[senderJid];
        if (lowerText === '.nourrir') pet.faim = Math.min(100, pet.faim + 35);
        if (lowerText === '.dodo') pet.energie = Math.min(100, pet.energie + 40);
        if (lowerText === '.parc') { pet.energie = Math.max(0, pet.energie - 20); pet.faim = Math.max(0, pet.faim - 15); }
        if (lowerText === '.soigner') pet.sante = 100;

        await envoyerAvecDelai(sock, remoteJid, { text: `🐾 Action effectuée sur *${pet.nom}* ! Tapez \`.toutou\` pour voir ses stats.` }, { quoted: msg });
        return;
      }

      // 👁️ REVOIR LA DERNIÈRE VUE UNIQUE (.v)
      if (lowerText === '.v') {
        const cache = vueUniqueCache[remoteJid];
        if (!cache) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Aucune vue unique récente enregistrée dans ce tchat." }, { quoted: msg });
          return;
        }
        const textV = `🔓 *IL N'Y A PAS DE SECRET ICI !*\n${cache.caption ? `\n📝 *Légende :* ${cache.caption}` : ''}`;
        if (cache.type === 'image') {
          await envoyerAvecDelai(sock, remoteJid, { image: cache.buffer, caption: textV }, { quoted: msg });
        } else {
          await envoyerAvecDelai(sock, remoteJid, { video: cache.buffer, caption: textV }, { quoted: msg });
        }
        return;
      }

      // 📸 PHOTO DE PROFIL (.pp)
      if (lowerText.startsWith('.pp')) {
        let cible = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || senderJid;
        try {
          const ppUrl = await sock.profilePictureUrl(cible, 'image');
          await envoyerAvecDelai(sock, remoteJid, { image: { url: ppUrl }, caption: `🙌👉Voilà ça 😈😎 *@${cible.split('@')[0]}*`, mentions: [cible] }, { quoted: msg });
        } catch (e) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Photo de profil introuvable ou masquée par la confidentialité." }, { quoted: msg });
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

          await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: [user1, user2] }, { quoted: msg });
          return;
        }

        if (mentions.length === 1) {
          const mention = mentions[0];
          txt += `👤 Entre *@${senderJid.split('@')[0]}* et *@${mention.split('@')[0]}*\n`;
          txt += `📊 Jauge : ${genererBarreHP(score, 100)} (${score}%)\n`;
          txt += `💬 *Avis :* ${comm}\n\n`;
          txt += `💡 *Petit conseil :* ${conseil}`;

          await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: [senderJid, mention] }, { quoted: msg });
          return;
        }

        let diagnosticSolo = "Ton cœur est un havre de paix. Tu es en parfaite harmonie avec toi-même ! ✨";
        if (score < 30) diagnosticSolo = "Cœur en mode ermite. Focus total sur le développement personnel ! 🧘‍♂️";
        else if (score < 70) diagnosticSolo = "Aura séduisante ! Un bon équilibre entre indépendance et ouverture aux rencontres ! 😉";
        else diagnosticSolo = "Aura de séduction au maximum ! Ton magnétisme fait des ravages aujourd'hui ! 🔥";

        txt += `👤 *DIAGNOSTIC AMOUR SOLO DE *@${senderJid.split('@')[0]}*\n`;
        txt += `📊 Jauge d'Aura Amoureuse : ${genererBarreHP(score, 100)} (${score}%)\n\n`;
        txt += `⚖️ *Jugement & Diagnostic :* ${diagnosticSolo}`;

        await envoyerAvecDelai(sock, remoteJid, { text: txt, mentions: [senderJid] }, { quoted: msg });
        return;
      }

      // 📱 GÉNÉRATEUR QR CODE (.qr)
      if (lowerText.startsWith('.qr')) {
        const contenu = cleanText.replace(/^\.qr\s*/i, '').trim();
        if (!contenu) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Entrez le texte ou l'URL à convertir ! Exemple : `.qr https://google.com`" }, { quoted: msg });
          return;
        }
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(contenu)}`;
        await envoyerAvecDelai(sock, remoteJid, { image: { url: qrUrl }, caption: `📱 *QR CODE GÉNÉRÉ*` }, { quoted: msg });
        return;
      }

      // 🎱 BOULE MAGIQUE (8-BALL)
      if (lowerText.startsWith('.8ball')) {
        const question = cleanText.replace(/^\.8ball\s*/i, '').trim();
        if (!question) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Pose une question ! Exemple : `.8ball Est-ce que je vais réussir ?`" }, { quoted: msg });
          return;
        }

        const reponse = REPONSES_8BALL[Math.floor(Math.random() * REPONSES_8BALL.length)];
        const nomJ = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;

        const text8Ball = `🎱 *BOULE MAGIQUE 8-BALL* 🎱\n\n❓ *Question de ${nomJ} :* ${question}\n🔮 *Réponse :* ${reponse}`;
        await envoyerAvecDelai(sock, remoteJid, { text: text8Ball, mentions: [senderJid] }, { quoted: msg });
        return;
      }

      // ✋ REJOINDRE UNE ÉQUIPE (.joindre)
      if (lowerText.startsWith('.joindre')) {
        if (!jeu || jeu.statut !== 'INSCRIPTION') {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Aucune inscription ouverte en mode Équipe !" }, { quoted: msg });
          return;
        }

        const eq = cleanText.replace(/^\.joindre\s*/i, '').trim().toUpperCase();
        if (eq !== 'A' && eq !== 'B') {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Précisez une équipe : `.joindre A` ou `.joindre B`" }, { quoted: msg });
          return;
        }

        const nomJ = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
        jeu.equipes.A = jeu.equipes.A.filter(j => j.jid !== senderJid);
        jeu.equipes.B = jeu.equipes.B.filter(j => j.jid !== senderJid);

        jeu.equipes[eq].push({ jid: senderJid, nom: nomJ, elimine: false });
        if (!jeu.joueurs.some(j => j.jid === senderJid)) {
          jeu.joueurs.push({ jid: senderJid, nom: nomJ, elimine: false });
        }

        await envoyerAvecDelai(sock, remoteJid, { text: `✅ *${nomJ}* a rejoint l'*ÉQUIPE ${eq}* !\n\n🔴 Équipe A : ${jeu.equipes.A.length} | 🔵 Équipe B : ${jeu.equipes.B.length}` }, { quoted: msg });
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

        await envoyerAvecDelai(sock, remoteJid, { text: analyse, mentions: [cibleJid] }, { quoted: msg });
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
        await envoyerAvecDelai(sock, remoteJid, { text: "🛑 *Partie annulée.* Tapez `.menu` pour relancer un jeu." }, { quoted: msg });
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
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Aucun jeu en attente d'inscription à lancer !" }, { quoted: msg });
          return;
        }

        if (jeu.joueurs.length < 1) {
          await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Au moins 1 joueur doit s'inscrire avec `.inscrire` !" }, { quoted: msg });
          return;
        }

        jeu.statut = 'EN_COURS';

        if (jeu.type === 'DE') {
          let resultatText = `🎲 *RÉSULTATS DU JEU DE DÉ* 🎲\n\n`;
          let meilleurScore = -1;
          let gagnants = [];

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

          resultatText += `\n🏆 *Gagnant(s) (Score: ${meilleurScore}) :* ${gagnants.join(', ')} 🎉`;
          partiesEnCours[remoteJid] = { dernierType: 'DE' };
          await envoyerAvecDelai(sock, remoteJid, { text: resultatText }, { quoted: msg });
          return;
        }

        if (jeu.type === 'LABYRINTHE') {
          if (jeu.mode === 'EQUIPE' && (jeu.equipes.A.length === 0 || jeu.equipes.B.length === 0)) {
            await envoyerAvecDelai(sock, remoteJid, { text: "⚠️ Chaque équipe (A et B) doit contenir au moins 1 joueur ! Tapez `.joindre A` ou `.joindre B`." }, { quoted: msg });
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
          }, { quoted: msg });
          return;
        }

        if (jeu.type === 'FEU_ROUGE') {
          await envoyerAvecDelai(sock, remoteJid, { text: `🔴 *SQUID GAME DÉMARRE !*\n👥 *${jeu.joueurs.length} joueurs* sur la ligne de départ !\nPréparez-vous...` }, { quoted: msg });
          setTimeout(() => lancerMancheFeuRouge(sock, remoteJid), 3000);
          return;
        }

        if (jeu.type === 'ROULETTE') {
          jeu.indexTour = 0;
          jeu.chambresRestantes = 6;
          const premier = jeu.joueurs[0];
          await envoyerAvecDelai(sock, remoteJid, { 
            text: `💀 *ROULETTE RUSSE STARTED !*\n\n👥 *${jeu.joueurs.length} candidats* inscrits !\n🔫 1 Balle engagée dans le barillet.\n\n👉 C'est le tour de *${premier.nom}* ! Tapez *@tirer* !` 
          }, { quoted: msg });
          return;
        }

        if (jeu.type === 'CHIFFRE') {
          let listStr = jeu.joueurs.map(j => `• ${j.nom}`).join('\n');
          await envoyerAvecDelai(sock, remoteJid, { 
            text: `🔢 *CHIFFRE MYSTÈRE (1-100) STARTED !*\n\n🎯 Joueurs en compétition :\n${listStr}\n\n👉 Le premier qui trouve gagne ! Écrivez un chiffre dans le tchat !` 
          }, { quoted: msg });
          return;
        }

        if (jeu.type === 'BOMBE') {
          jeu.indexTour = 0;
          const premier = jeu.joueurs[0];
          await envoyerAvecDelai(sock, remoteJid, { 
            text: `💣 *BOMBE DÉSAMORÇAGE D'ÉQUIPE STARTED !*\n\n👥 Joueurs : *${jeu.joueurs.length}*\n👉 C'est au tour de *${premier.nom}* de désamorcer !\n✂️ Tapez \`@rouge\`, \`@bleu\` ou \`@jaune\` ! (15s)` 
          }, { quoted: msg });
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
              await envoyerAvecDelai(sock, remoteJid, { text: `🟢 *BOMBE DÉSAMORCÉE PAR ${joueurActuel.nom.toUpperCase()} !* 🟢\n\n✂️ Le fil *${filChoisi.toUpperCase()}* était le bon !\n🏆 Toute l'équipe l'emporte ! 🎉\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg });
            } else {
              joueurActuel.elimine = true;
              const restants = jeu.joueurs.filter(j => !j.elimine);

              if (restants.length === 0) {
                partiesEnCours[remoteJid] = { dernierType: 'BOMBE' };
                await envoyerAvecDelai(sock, remoteJid, { text: `💥 *BOOOOOOOM GENERAL !* 💥\n\n*${joueurActuel.nom}* a coupé le mauvais fil (*${filChoisi.toUpperCase()}*). Le bon fil était *${jeu.bonFil.toUpperCase()}*.\n💀 Tout le groupe est éliminé !\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg });
              } else {
                jeu.indexTour = (jeu.indexTour + 1) % restants.length;
                const prochain = restants[jeu.indexTour];
                await envoyerAvecDelai(sock, remoteJid, { text: `💥 *${joueurActuel.nom}* a sauté en coupant le fil *${filChoisi.toUpperCase()}* !\n\n👉 La bombe tourne ! C'est à *${prochain.nom}* de choisir un fil !` }, { quoted: msg });
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
              await envoyerAvecDelai(sock, remoteJid, { text: `⏳ *Ce n'est pas ton tour !* C'est à *${joueurActuel.nom}* ${joueurActuel.eq !== 'SOLO' ? `(Équipe ${joueurActuel.eq})` : ''} de répondre.` }, { quoted: msg });
              return;
            }

            const dirChoisie = dirMap[lowerText];
            const cheminActuel = CHEMINS_LABYRINTHE[jeu.indexChemin];
            const bonneDirection = cheminActuel[jeu.étape];
            const subAmbiance = SUBS_LABYRINTHE[Math.floor(Math.random() * SUBS_LABYRINTHE.length)];

            if (dirChoisie === bonneDirection) {
              jeu.étape += 1;
              if (jeu.étape >= 10) {
                partiesEnCours[remoteJid] = { dernierType: 'LABYRINTHE' };
                const victoireMsg = jeu.mode === 'EQUIPE' ? `🏆 *VICTOIRE DE L'ÉQUIPE ${joueurActuel.eq} !* 🏆\n\n🎉 *${joueurActuel.nom}* a guidé son équipe hors du labyrinthe !` : `🏆 *VICTOIRE DE ${joueurActuel.nom.toUpperCase()} !* 🏆\n\n🎉 Il est sorti premier du labyrinthe !`;
                await envoyerAvecDelai(sock, remoteJid, { text: `${victoireMsg}\n\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg });
                return;
              } else {
                jeu.indexTour = (jeu.indexTour + 1) % jeu.ordreJoueurs.length;
                const prochain = jeu.ordreJoueurs[jeu.indexTour];
                await envoyerAvecDelai(sock, remoteJid, { text: `✨ *${joueurActuel.nom}* a pris la bonne voie ! (Étape ${jeu.étape}/10)\n👻 _${subAmbiance}_\n\n👉 C'est au tour de *${prochain.nom}* ${prochain.eq !== 'SOLO' ? `(Équipe ${prochain.eq})` : ''} !` }, { quoted: msg });
              }
            } else {
              jeu.vie = Math.max(0, jeu.vie - 15);
              if (jeu.vie <= 0) {
                partiesEnCours[remoteJid] = { dernierType: 'LABYRINTHE' };
                await envoyerAvecDelai(sock, remoteJid, { text: `💀 *${joueurActuel.nom}* s'est trompé de voie ! La santé du groupe est tombée à 0%...\n\n💥 *FIN DE LA PARTIE (PERDU)*\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg });
                return;
              } else {
                jeu.indexTour = (jeu.indexTour + 1) % jeu.ordreJoueurs.length;
                const prochain = jeu.ordreJoueurs[jeu.indexTour];
                await envoyerAvecDelai(sock, remoteJid, { text: `❌ Mauvaise voie par *${joueurActuel.nom}* ! Santé : ${genererBarreHP(jeu.vie)}\n👻 _${subAmbiance}_\n\n👉 Le relais passe à *${prochain.nom}* ${prochain.eq !== 'SOLO' ? `(Équipe ${prochain.eq})` : ''} !` }, { quoted: msg });
              }
            }
            return;
          }
        }

        if (jeu.type === 'ROULETTE' && lowerText === '@tirer') {
          const restants = jeu.joueurs.filter(j => !j.elimine);
          const joueurActuel = restants[jeu.indexTour % restants.length];

          if (senderJid !== joueurActuel.jid) {
            await envoyerAvecDelai(sock, remoteJid, { text: `⏳ C'est au tour de *${joueurActuel.nom}* de presser la détente avec *@tirer* !` }, { quoted: msg });
            return;
          }

          if (Math.random() < (1 / jeu.chambresRestantes)) {
            joueurActuel.elimine = true;
            const nouveauxRestants = jeu.joueurs.filter(j => !j.elimine);

            if (nouveauxRestants.length <= 1) {
              const gagnant = nouveauxRestants[0] ? nouveauxRestants[0].nom : "Personne";
              partiesEnCours[remoteJid] = { dernierType: 'ROULETTE' };
              await envoyerAvecDelai(sock, remoteJid, { text: `💥 *PAN !* *${joueurActuel.nom}* est éliminé !\n\n🏆 *SURVIVANT ULTIME :* *${gagnant.toUpperCase()}* remporte la Roulette Russe ! 🎉\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg });
            } else {
              jeu.chambresRestantes = 6;
              jeu.indexTour = jeu.indexTour % nouveauxRestants.length;
              const prochain = nouveauxRestants[jeu.indexTour];
              await envoyerAvecDelai(sock, remoteJid, { text: `💥 *PAN !* Élimination de *${joueurActuel.nom}* !\n\n🔄 Barillet rechargé (6 chambres).\n👉 Au tour de *${prochain.nom}*. Tapez *@tirer* !` }, { quoted: msg });
            }
          } else {
            jeu.chambresRestantes = Math.max(1, jeu.chambresRestantes - 1);
            jeu.indexTour = (jeu.indexTour + 1) % restants.length;
            const prochain = restants[jeu.indexTour];
            await envoyerAvecDelai(sock, remoteJid, { text: `⚙️ *CLIC !* Chambre vide pour *${joueurActuel.nom}*.\n\n👉 Au tour de *${prochain.nom}* (${jeu.chambresRestantes} chambres restantes). Tapez *@tirer* !` }, { quoted: msg });
          }
          return;
        }

        if (jeu.type === 'CHIFFRE' && !isNaN(cleanText)) {
          const prop = parseInt(cleanText, 10);
          const nomJ = profilsJoueurs[senderJid] || `@${senderJid.split('@')[0]}`;
          jeu.essais = (jeu.essais || 0) + 1;

          if (prop === jeu.secret) {
            partiesEnCours[remoteJid] = { dernierType: 'CHIFFRE' };
            await envoyerAvecDelai(sock, remoteJid, { text: `🏆 *VICTOIRE DE ${nomJ.toUpperCase()} !* 🏆\n\n🎯 Il a trouvé le chiffre mystère *${jeu.secret}* en *${jeu.essais} essai(s)* !\n\n🔄 Tapez *.restart* pour rejouer !` }, { quoted: msg });
          } else {
            const ind = prop < jeu.secret ? "📈 *C'est PLUS GRAND !*" : "📉 *C'est PLUS PETIT !*";
            await envoyerAvecDelai(sock, remoteJid, { text: `${ind} (Proposé par *${nomJ}*)` }, { quoted: msg });
          }
          return;
        }

        if (jeu.type === 'FEU_ROUGE' && jeu.attenteReponse && cleanText.startsWith('@')) {
          const saisi = cleanText.substring(1).trim().toLowerCase();
          if (saisi === jeu.motAValider.toLowerCase()) {
            const j = jeu.joueurs.find(j => j.jid === senderJid);
            if (j && !j.aRepondu && !j.elimine) {
              j.aRepondu = true;
              await envoyerAvecDelai(sock, remoteJid, { text: `⚡ *${j.nom}* a traversé avec succès !` }, { quoted: msg });
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

  return envoyerAvecDelai(sock, remoteJid, { text: `💣 *DÉSACTIVATION DE LA BOMBE EN GROUPE* 💣\n\nTous les démineurs doivent s'inscrire !\n👉 Tapez *.inscrire [Nom]* puis *.lancer* !` }, { quoted: msg });
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
  return envoyerAvecDelai(sock, remoteJid, { text: `🎲 *JEU DU DÉ EN GROUPE*\n\n👉 Inscrivez-vous avec *.inscrire [Nom]* puis tapez *.lancer* !` }, { quoted: msg });
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

  return envoyerAvecDelai(sock, remoteJid, { text: textIntro }, { quoted: msg });
}

function declencherJeuFeuRouge(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'FEU_ROUGE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `🔴 *SQUID GAME GROUPE*\n\n👉 Inscriptions : *.inscrire [Nom]* puis *.lancer* !` }, { quoted: msg });
}

function declencherJeuRoulette(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'ROULETTE', statut: 'INSCRIPTION', joueurs: [] };
  return envoyerAvecDelai(sock, remoteJid, { text: `💀 *ROULETTE RUSSE GROUPE*\n\n👉 Inscriptions : *.inscrire [Nom]* puis *.lancer* !` }, { quoted: msg });
}

function declencherJeuChiffre(sock, remoteJid, msg) {
  reinitialiserJeu(remoteJid);
  partiesEnCours[remoteJid] = { type: 'CHIFFRE', statut: 'INSCRIPTION', joueurs: [], secret: Math.floor(Math.random() * 100) + 1, essais: 0 };
  return envoyerAvecDelai(sock, remoteJid, { text: `🔢 *CHIFFRE MYSTÈRE EN GROUPE (1-100)*\n\n👉 Inscriptions : *.inscrire [Nom]* puis *.lancer* !` }, { quoted: msg });
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
