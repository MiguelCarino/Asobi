/* =====================================================================
   Carino Asobi — platform shell
   Builds the slice-menu chooser (Branding .slice-menu, routed by
   CarinoUI.slices in carino-ui.js) and mounts self-contained game modules.
   Each game registers itself as window.GAMES[id] = { title, jp, blurb, tag,
   hue, init(container) -> destroyFn, help() -> HTML, keys }. init() builds
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
  let pausedByHelp = false;
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
    $("#helpBtn").hidden = !inGame;
    const pb = $("#pauseBtn");
    pb.hidden = !inGame || !canPause();
    const p = isPaused();
    pb.textContent = p ? T("Resume") : T("Pause");
    pb.setAttribute("aria-pressed", String(p));
  }

  /* ---------- help overlay ---------- */
  const COMMON_KEYS = [
    ["<span class=\"kbd\">?</span> <span class=\"kbd\">H</span>", "Help"],
    ["<span class=\"kbd\">Esc</span>", "Close"],
    ["<span class=\"kbd\">F</span>", "Fullscreen"],
  ];
  function fillHelp() {
    const g = active && window.GAMES[active];
    if (!g) return;
    $("#helpSub").textContent = `${g.jp || ""} ${g.title}`;
    $("#helpGame").innerHTML = typeof g.help === "function" ? g.help() : "";
    const keys = [];
    if (canPause()) keys.push(["<span class=\"kbd accent\">P</span> <span class=\"kbd accent\">Space</span>", "Pause"]);
    if (ctl && typeof ctl.toggleSound === "function") keys.push(["<span class=\"kbd\">M</span>", "Sound"]);
    (g.keys || []).forEach((k) => keys.push(k));
    $("#helpKeys").innerHTML = keys.concat(COMMON_KEYS)
      .map(([k, label]) => `<dt>${k}</dt><dd>${esc(T(label))}</dd>`).join("");
    $("#helpX").setAttribute("aria-label", T("Close"));
  }
  const helpOpen = () => !$("#helpScrim").hidden;
  function openHelp() {
    if (!active || helpOpen()) return;
    fillHelp();
    lastFocus = document.activeElement;
    $("#helpScrim").hidden = false;
    if (canPause() && !isPaused()) { pausedByHelp = true; setPaused(true); }
    $("#helpResume").focus();
  }
  function closeHelp(resume) {
    if (!helpOpen()) return;
    $("#helpScrim").hidden = true;
    if (pausedByHelp || (resume && isPaused())) setPaused(false);
    pausedByHelp = false;
    if (lastFocus && lastFocus.focus && lastFocus !== document.body) lastFocus.focus();
  }
  function toggleFullscreen() {
    const d = document, e = d.documentElement;
    if (d.fullscreenElement) { if (d.exitFullscreen) d.exitFullscreen(); return; }
    if (e.requestFullscreen) e.requestFullscreen().catch(() => {});
  }

  /* The fleet's play keys, only while a game is open and never while typing:
     ? or H help, P or Space pause, Esc close, F fullscreen, M sound. */
  function onKey(e) {
    if (!active || e.metaKey || e.ctrlKey || e.altKey) return;
    const tg = e.target;
    if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName || ""))) return;
    const k = e.key;
    if (helpOpen()) {
      if (k === "Escape" || k === "?" || k === "h" || k === "H") { e.preventDefault(); closeHelp(); }
      return;
    }
    if (k === "?" || k === "h" || k === "H") { e.preventDefault(); openHelp(); }
    else if ((k === "p" || k === "P" || (k === " " && !(tg && /^(BUTTON|A)$/.test(tg.tagName || "")))) && canPause()) {
      e.preventDefault(); setPaused(!isPaused());
    }
    else if ((k === "m" || k === "M") && ctl && typeof ctl.toggleSound === "function") ctl.toggleSound();
    else if (k === "f" || k === "F") toggleFullscreen();
  }

  /* ---------- mounting ---------- */
  function unmount() {
    closeHelp();
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
    if (helpOpen()) fillHelp();
  }
  window.asobiRelocalize = relocalize;

  document.addEventListener("DOMContentLoaded", () => {
    $("#year").textContent = new Date().getFullYear();
    if (!window.GAMES || !gameList().length) {
      $("#sliceMenu").innerHTML = `<div class="alert warn as-empty">${esc(T("No games loaded."))}</div>`;
      return;
    }
    buildSlices();

    $("#helpBtn").addEventListener("click", openHelp);
    $("#helpX").addEventListener("click", () => closeHelp());
    $("#helpResume").addEventListener("click", () => closeHelp(true));
    $("#helpFull").addEventListener("click", () => { closeHelp(); toggleFullscreen(); });
    $("#helpScrim").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeHelp(); });
    $("#pauseBtn").addEventListener("click", () => setPaused(!isPaused()));
    // A game's own Rules button, and a game that paused or resumed itself.
    window.addEventListener("asobi:help", openHelp);
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
