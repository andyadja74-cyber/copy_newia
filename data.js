// 📦 BANQUES DE DONNÉES ET ÉTATS MULTI-JOUEURS DU BOT TITAN

module.exports = {
  // 🎱 BOULE MAGIQUE 8-BALL
  REPONSES_8BALL: [
    "Oui, absolument ! ✨",
    "C'est certain ! 🎯",
    "Sans aucun doute. 👍",
    "Très probable. 😉",
    "Oui, définitivement. 🌟",
    "C'est bien parti ! 🚀",
    "Les signes indiquent que oui. 🔮",
    "Ne compte pas là-dessus. 🙅‍♂️",
    "Ma réponse est non. ❌"
  ],

  // 💘 COMPATIBILITÉ & AMOUR
  COMMENTAIRES_LOVE: {
    parfait: ["Une alchimie parfaite ! 💖", "C'est l'amour fou ! 😍", "Faits l'un pour l'autre ! ✨"],
    moyen: ["Il y a un potentiel ! 🙂", "Alors 😌c'est bien ça 😏", "À travailler avec le temps ! ⏳"],
    faible: ["L'amitié c'est bien aussi hyn... 🤣", "Aïe, purée mal fait dehhh🤣💔", "je la ferme ohh 💔🤣🫢😌"]
  },
  CONSEILS_LOVE: [
    "La communication est la clé de tout sentiment sincère ! 💬",
    "Un petit compliment imprévu peut faire des merveilles ! ✨",
    "Ne précipitez rien, laissez la magie opérer naturellement ! ☕",
    "Un bol de pop-corn et un bon film, le combo parfait ! 🍿",
    "Offre-lui sa nourriture préférée, ça marche à tous les coups ! 🍕"
  ],
  MOTS_AMOUR_PRIVE: ["je t'aime", "je t'aime tellement"],
  REPONSE_AMOUR_MAMAN: "Moi aussi je t'aime maman 🤖☺️",

  // 🐾 ANIMAUX DE COMPAGNIE
  LISTE_ANIMAUX: [
    { nom: "Chien", type: "canin", nourriture: "croquettes" },
    { nom: "Chat", type: "félin", nourriture: "poisson" },
    { nom: "Dragon", type: "mythique", nourriture: "viande grillée" },
    { nom: "Panda", type: "mammifère", nourriture: "bambou" }
  ],

  // 🔴 SQUID GAME
  MOTS_SQUID: ["NEWYORKKK", "BBBBBB", "YELHSA", "ANDLEY", "BOTTI", "AMONGUSS", "FRANCE", "EXTRAANDY", "SOLEIL", "FEU"],

  // 🧠 CERVEAU / MOX
  DONNEES_CERVEAU: [
    "🤪 Niveau de folie",
    "⚡ Vitesse de réflexion",
    "💡 INTELLIGENCE ",
    "🎭 Taux de bêtises",
    "🍕 Envies de nourriture",
    "😴 Paresse mentale",
    "🧠 Logique approximative"
  ],
  COMMENTAIRES_CERVEAU: [
    "Attention, ce cerveau tourne un peu bien ou pas 🤷",
    "Niveau de folie critique... Éloignez immédiatement cette personne du groupe ! 🤪",
    "Un génie incompris... surtout par lui-même ! 🤯",
    "Surchauffe neuronale imminente ! Laissez refroidir 15 minutes. 🔥",
    "Analyse terminée : 99% de pensées pour manger, 1% de réflexion. 🍕",
    "Ce cerveau est tellement rapide qu'il dépasse sa propre logique ! ⚡",
    "Erreur 404 : Réflexion non trouvée... Relance de la mémoire vive en cours ! 🔄",
    "Capacité d'attention : égale à celle d'un poisson rouge sous caféine ! 🐟☕",
    "Ce cerveau possède le QI d'un grille-pain débranché, mais avec du style ! 🍞✨",
    "Trop de génie tue le génie... ou alors c'est juste un gros coup de chance ! 🎲",
    "99.9% de bêtises, 0.1% de pur chef-d'œuvre. Un vrai artiste ! 🎨",
    "Analyse clinique : Ce cerveau fonctionne à l'énergie solaire... et il fait nuit. 🌙"
  ],

  // 🚪 LABYRINTHE
  CHEMINS_LABYRINTHE: [
    ["gauche", "tout droit", "droite", "gauche", "tout droit", "droite", "gauche", "tout droit", "droite", "tout droit"],
    ["droite", "gauche", "tout droit", "droite", "gauche", "tout droit", "droite", "gauche", "tout droit", "gauche"]
  ],
  SUBS_LABYRINTHE: [
    "Vous marchez à tCover dans l'obscurité...",
    "Un bruit étrange résonne dans le couloir...",
    "La température baisse soudainement...",
    "Tu vas où mm 🤣"
  ],

  // 💾 MÉMOIRES ET ÉTATS TEMPORELS DU BOT
  partiesEnCours: {},
  timersInactivite: {},
  vueUniqueCache: {},
  animauxJoueurs: {},
  mesNotes: {},
  sessionsMotDePasse: {},
  profilsJoueurs: {},
  membresSalues: new Set()
};
