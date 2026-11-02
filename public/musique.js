/* 🎵 Musique de LEYBOTDY (fichier /musique.mp3, en boucle).
   Démarre au premier toucher (les navigateurs bloquent le son avant), bouton rond en haut à droite pour couper / relancer.
   Le choix « coupée » est mémorisé. Elle se met en pause quand l'appli passe en arrière-plan. */
(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const CLE = 'musiqueCoupee';
  const lire = () => { try { return localStorage.getItem(CLE) === '1'; } catch (_) { return false; } };
  const ecrire = (v) => { try { localStorage.setItem(CLE, v ? '1' : '0'); } catch (_) {} };
  const audio = new Audio('/musique.mp3');
  audio.loop = true; audio.preload = 'auto';
  let ctx = null, maitre = null, actif = false, coupee = lire();

  function construire() {   // passe par Web Audio : le fondu doux marche aussi sur iPhone
    ctx = new AC(); const src = ctx.createMediaElementSource(audio);
    maitre = ctx.createGain(); maitre.gain.value = 0; src.connect(maitre); maitre.connect(ctx.destination);
  }
  function jouer() {
    if (!ctx) construire();
    ctx.resume(); maitre.gain.cancelScheduledValues(ctx.currentTime); maitre.gain.setTargetAtTime(.8, ctx.currentTime, 1);
    const p = audio.play(); if (p && p.catch) p.catch(() => { actif = false; maj(); });
    actif = true; maj();
  }
  function pause() {
    if (!ctx || !actif) return;
    actif = false; maitre.gain.setTargetAtTime(0, ctx.currentTime, .25);
    setTimeout(() => { if (!actif) audio.pause(); }, 900); maj();   // la musique reprend là où elle s'est arrêtée
  }

  // 🔘 bouton rond (verre)
  const st = document.createElement('style');
  st.textContent = `#musique{position:fixed;top:max(14px,env(safe-area-inset-top));right:14px;z-index:25;width:46px;height:46px;margin:0;padding:0;border-radius:50%;display:grid;place-items:center;font-size:20px;line-height:1;color:#eaf6ff;cursor:pointer;background:linear-gradient(150deg,#ffffff22,#ffffff08);border:1px solid #ffffff2e;backdrop-filter:blur(20px) saturate(170%);-webkit-backdrop-filter:blur(20px) saturate(170%);box-shadow:inset 0 1px 0 #ffffff55,0 10px 30px #000a;transition:transform .25s}
#musique:before{display:none}#musique:active{transform:scale(.9)}
#musique.on{animation:musique 2.6s ease-out infinite}#musique.hint{animation:musique 1.8s ease-out infinite}
@keyframes musique{0%{box-shadow:inset 0 1px 0 #ffffff55,0 10px 30px #000a,0 0 0 0 #9fe3ff77}100%{box-shadow:inset 0 1px 0 #ffffff55,0 10px 30px #000a,0 0 0 16px #9fe3ff00}}`;
  document.head.appendChild(st);
  const b = document.createElement('button');
  b.id = 'musique'; b.type = 'button';
  function maj() {
    b.textContent = coupee ? '🔇' : (actif ? '🔊' : '🎵');
    b.title = b.ariaLabel = coupee ? 'Activer la musique' : 'Couper la musique';
    b.classList.toggle('on', actif && !coupee); b.classList.toggle('hint', !actif && !coupee);
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    coupee = actif ? true : false;   // en train de jouer → on coupe ; sinon (coupée ou pas encore lancée) → on joue
    ecrire(coupee);
    if (coupee) pause(); else jouer();
    maj();
  });
  document.body.appendChild(b); maj();

  // 👆 premier toucher n'importe où : la musique démarre (sauf si elle a été coupée avant)
  const premier = (e) => {
    if (e.target.closest && e.target.closest('#musique')) return;
    ['click', 'touchend', 'keydown'].forEach((ev) => removeEventListener(ev, premier, true));
    if (!coupee && !actif) jouer();
  };
  ['click', 'touchend', 'keydown'].forEach((ev) => addEventListener(ev, premier, true));

  // 🌙 appli en arrière-plan : silence ; retour : la musique reprend
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) pause(); else if (!coupee) jouer();
  });
})();
