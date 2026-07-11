/* =====================================================================
   Carino Asobi — platform shell
   Builds the slice-menu chooser and mounts self-contained game modules.
   Each game registers itself as window.GAMES[id] = { title, jp, blurb, tag,
   hue, init(container) -> destroyFn }. init() builds the game's DOM into the
   container and returns an optional cleanup function.
   ===================================================================== */

(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const gameList = () => Object.entries(window.GAMES || {});
  let active = null;
  let destroyActive = null;

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
      slice.innerHTML = `
        <div class="slice-bg"></div>
        <div class="slice-inner">
          <span class="slice-kanji">${g.jp || ""}</span>
          <h2 class="slice-title">${g.title}</h2>
          <p class="slice-blurb">${g.blurb || ""}</p>
          <span class="slice-tag">${g.tag || ""}</span>
        </div>`;
      slice.addEventListener("click", () => { location.hash = "#" + id; });
      menu.appendChild(slice);
    });
  }

  function mount(id) {
    if (!window.GAMES[id]) return showOverview();
    if (id === active) return;
    if (destroyActive) { try { destroyActive(); } catch (e) {} destroyActive = null; }
    active = id;
    const host = $("#gameHost");
    host.innerHTML = "";
    document.body.classList.add("state-playing");
    document.body.classList.remove("state-overview");
    $$(".slice").forEach((s) => s.classList.toggle("active", s.dataset.id === id));
    const g = window.GAMES[id];
    document.documentElement.style.setProperty("--hue", g.hue || "var(--accent)");
    const greet = $("#greeting"); if (greet) greet.textContent = `${g.jp || ""} ${g.title}`;
    try { destroyActive = g.init(host) || null; }
    catch (e) { host.innerHTML = `<p style="padding:40px;color:#ef4444">Failed to start ${g.title}: ${e.message}</p>`; console.error(e); }
    window.scrollTo(0, 0);
  }

  function showOverview() {
    if (destroyActive) { try { destroyActive(); } catch (e) {} destroyActive = null; }
    active = null;
    document.body.classList.add("state-overview");
    document.body.classList.remove("state-playing");
    $$(".slice").forEach((s) => s.classList.remove("active"));
    $("#gameHost").innerHTML = "";
    const greet = $("#greeting"); if (greet) greet.textContent = "Choose a game.";
    window.scrollTo(0, 0);
  }

  function route() {
    const id = location.hash.replace(/^#/, "");
    if (!id || !window.GAMES[id]) return showOverview();
    mount(id);
  }

  /* ---------- clock ---------- */
  // The header clock (Local/UTC/Epoch/TAI/.beats + click-to-cycle) is owned by
  // the shared module carino-clock.js — nothing to do here.

  document.addEventListener("DOMContentLoaded", () => {
    if (!window.GAMES || !gameList().length) {
      $("#sliceMenu").innerHTML = '<p style="margin:auto;color:#888">No games loaded.</p>';
      return;
    }
    buildSlices();
    $("#brandHome").addEventListener("click", (e) => { e.preventDefault(); location.hash = ""; });
    window.addEventListener("hashchange", route);
    $("#year").textContent = new Date().getFullYear();
    route();
  });
})();
