/* =====================================================================
   Carino Asobi — platform shell
   Builds the slice-menu chooser (Branding .slice-menu, routed by
   CarinoUI.slices in carino-ui.js) and mounts self-contained game modules.
   Each game registers itself as window.GAMES[id] = { title, jp, blurb, tag,
   hue, init(container) -> destroyFn }. init() builds
   the game's DOM into the container and returns an optional cleanup
   function; that function may also carry the game's play controls:
     destroy.setPaused(bool) / destroy.isPaused()   pause (P, Space, button)
     destroy.canPause()                             optional: pause applies now
     destroy.toggleSound()                          sound (M)
   A game that pauses itself (Shogi's own Start/Stop) fires 'asobi:paused'
   so the navbar button follows.

   Two layouts share the page. The chooser (no #hash) is a suite page: the
   gold-C hero, the slices, the footer, scrolling normally. A game (#shogi,
   #hanafuda, #pentarch) is a play page: body.play-body, the slices
   collapsed into a bar, and the game filling the stage under it.
   ===================================================================== */

(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  // i18n.js is deferred, so it has run (and resolved the locale) before our
  // DOMContentLoaded handler; still guard so the shell works without it.
  const T = (s) => (window.t ? window.t(s) : s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const gameList = () => Object.entries(window.GAMES || {});
  let active = null;
  let ctl = null;            // the open game's destroy function (+ its controls)
  let pausedByAbout = false;
  let lastFocus = null;

  /* ---------- slice menu ---------- */
  function buildSlices() {
    const menu = $("#sliceMenu");
    gameList().forEach(([id, g]) => {
      const slice = document.createElement("button");
      slice.className = "slice";
      slice.type = "button";
      slice.dataset.id = id;
      if (g.hue) slice.style.setProperty("--hue", g.hue);
      if (g.hue) slice.style.setProperty("--glow", g.glow || "rgba(234,179,8,0.20)");
      slice.innerHTML =
        `<span class="s-num" lang="ja">${g.jp || ""}</span>` +
        `<span class="s-text">${esc(g.title)}</span>` +
        `<span class="s-blurb">${esc(T(g.blurb || ""))}</span>` +
        `<span class="s-tag">${esc(T(g.tag || ""))}</span>`;
      menu.appendChild(slice);
    });
  }

  /* ---------- play controls ---------- */
  // A game may pause only in some modes (Shogi: AI 対 AI); canPause() says when.
  const canPause = () => !!(ctl && typeof ctl.setPaused === "function" &&
    (typeof ctl.canPause !== "function" || ctl.canPause()));
  const isPaused = () => !!(canPause() && ctl.isPaused && ctl.isPaused());
  function setPaused(p) { if (canPause()) { ctl.setPaused(!!p); paintControls(); } }

  function paintControls() {
    const inGame = !!active;
    $("#toChooser").hidden = !inGame;
    const pb = $("#pauseBtn");
    pb.hidden = !inGame || !canPause();
    const p = isPaused();
    pb.textContent = p ? T("Resume") : T("Pause");
    pb.setAttribute("aria-pressed", String(p));
  }

  /* ---------- the About window ----------
     The game pauses while the navbar's About window is open and picks up
     again when it closes. */
  const aboutOpen = () => { const p = document.getElementById("cnAbout"); return !!p && !p.hidden; };
  // Pause on the way in, and resume on the way out only what the window paused.
  function watchAbout() {
    const pop = document.getElementById("cnAbout");
    if (!pop) return;
    let was = !pop.hidden;
    new MutationObserver(() => {
      const now = !pop.hidden;
      if (now === was) return;
      was = now;
      if (now) {
        if (canPause() && !isPaused()) { pausedByAbout = true; setPaused(true); }
      } else if (pausedByAbout) {
        pausedByAbout = false;
        if (isPaused()) setPaused(false);
      }
    }).observe(pop, { attributes: true, attributeFilter: ["hidden"] });
  }
  function toggleFullscreen() {
    const d = document, e = d.documentElement;
    if (d.fullscreenElement) { if (d.exitFullscreen) d.exitFullscreen(); return; }
    if (e.requestFullscreen) e.requestFullscreen().catch(() => {});
  }

  /* The fleet's play keys, never while typing and only in a game: P or Space
     pause, F fullscreen, M sound. */
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tg = e.target;
    if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName || ""))) return;
    const k = e.key;
    // No game key acts behind the About window (its own Esc closes it).
    if (aboutOpen() || !active) return;
    if ((k === "p" || k === "P" || (k === " " && !(tg && /^(BUTTON|A)$/.test(tg.tagName || "")))) && canPause()) {
      e.preventDefault(); setPaused(!isPaused());
    }
    else if ((k === "m" || k === "M") && ctl && typeof ctl.toggleSound === "function") ctl.toggleSound();
    else if (k === "f" || k === "F") toggleFullscreen();
  }

  /* ---------- mounting ---------- */
  function unmount() {
    const x = document.querySelector("#cnAbout .cn-x");
    if (aboutOpen() && x) x.click();
    pausedByAbout = false;
    if (ctl) { try { ctl(); } catch (e) {} ctl = null; }
    active = null;
  }

  function mount(id) {
    if (id === active) return;
    unmount();
    active = id;
    const host = $("#gameHost");
    host.innerHTML = "";
    document.body.classList.add("play-body");
    const g = window.GAMES[id];
    document.documentElement.style.setProperty("--hue", g.hue || "var(--accent)");
    try { ctl = g.init(host) || null; }
    catch (e) {
      host.innerHTML = `<div class="as-state"><div class="alert err">${esc(T("This game could not start."))} ${esc(g.title)}: ${esc(e.message)}</div></div>`;
      console.error(e);
    }
    paintControls();
    window.scrollTo(0, 0);
  }

  function showOverview() {
    unmount();
    document.body.classList.remove("play-body");
    $("#gameHost").innerHTML = "";
    paintControls();
    window.scrollTo(0, 0);
  }

  /* ---------- language switch (called by i18n.js after it re-applies) ---- */
  function relocalize() {
    $("#sliceMenu").setAttribute("aria-label", T("Game chooser"));
    document.querySelectorAll("#sliceMenu .slice").forEach((s) => {
      const g = (window.GAMES || {})[s.dataset.id];
      if (!g) return;
      const blurb = s.querySelector(".s-blurb");
      if (blurb) blurb.textContent = T(g.blurb || "");
      const tag = s.querySelector(".s-tag");
      if (tag) tag.textContent = T(g.tag || "");
    });
    const empty = $("#sliceMenu .as-empty");
    if (empty) empty.textContent = T("No games loaded.");
    paintControls();
  }
  window.asobiRelocalize = relocalize;

  document.addEventListener("DOMContentLoaded", () => {
    if (!window.GAMES || !gameList().length) {
      $("#sliceMenu").innerHTML = `<div class="alert warn as-empty">${esc(T("No games loaded."))}</div>`;
      return;
    }
    buildSlices();

    watchAbout();
    $("#pauseBtn").addEventListener("click", () => setPaused(!isPaused()));
    // A game that paused or resumed itself.
    window.addEventListener("asobi:paused", paintControls);
    document.addEventListener("keydown", onKey);

    if (window.CarinoUI && window.CarinoUI.slices) {
      window.CarinoUI.slices({
        menu: $("#sliceMenu"),
        onRoute: (id) => {
          const playing = !!(id && window.GAMES[id]);
          if (playing) mount(id); else showOverview();
          // The navbar hides while a game fills the stage, never over the scrolling chooser.
          if (window.CarinoNav && window.CarinoNav.immersive) window.CarinoNav.immersive(playing);
        },
      });
    } else {
      // carino-ui.js missing: fall back to plain hash routing.
      const route = () => {
        const id = location.hash.replace(/^#/, "");
        if (id && window.GAMES[id]) mount(id); else showOverview();
      };
      $("#sliceMenu").addEventListener("click", (e) => {
        const s = e.target.closest(".slice[data-id]");
        if (s) location.hash = "#" + s.dataset.id;
      });
      window.addEventListener("hashchange", route);
      route();
    }
  });
})();
