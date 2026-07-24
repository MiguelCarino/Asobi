/* =====================================================================
   Carino Asobi — Pentarch Battle (戦)
   ---------------------------------------------------------------------
   Deterministic capture-point auto-battler ported from the PENTARCH
   project (PlanetDayum). The strategy/continent-map layer is removed —
   this module is the battle room only: choose factions, duration, seed,
   roster, effects and events; the fixed-step seeded engine resolves the
   fight on a canvas. Same seed + same settings = the same battle.

   Self-contained (fleet rules: vanilla JS, no CDN, no network):
     1. Battle — the simulation + canvas renderer (ported verbatim).
     2. Sound  — WebAudio synth voices; starts MUTED and only creates an
        AudioContext on the user's 🔊 click (autoplay-policy safe).
     3. UI shell — mounts into a container, styled with Asobi tokens.
   Registers window.GAMES.pentarch = { title, jp, blurb, tag, hue, glow,
   init(container) -> destroyFn }.
   ===================================================================== */
(function () {
  "use strict";

/* ======================= 1. Battle engine (port) ====================== */
/* ===========================================================================
   PENTARCH — Battle Engine (shared module)
   Deterministic, fixed-step capture-point auto-battler for 2..5 factions.

     • INFANTRY is renewable (deployed in bulk, then respawns; no infantry -> riflemen).
     • VEHICLES are scarce tickets the human times / AI auto-times — or "infinite"
       (unlimited but rate-limited by a cooldown).
     • INFRASTRUCTURE (bunker/depot) is a fixed x1 emplacement.
     • Spawn zones are equal-size circles placed evenly around the arena.
     • One capture point per faction. Maps have varied navigable wall paths
       (flow-field navigation routes units through the gaps).
     • Units roll a random BEHAVIOUR (point / roam / aggressive / camp).
     • Configurable duration (or infinite). Timed battles: the faction with the
       most losses gets a 7s double-spawn surge in the final 20 seconds.
     • Toggle which units & boosts are allowed.

   All RNG is seeded -> reproducible. `var Battle` for browser + node-vm tests.
   =========================================================================== */
var Battle = (function () {
  // World size is dynamic: it adapts to the viewport so bigger screens get bigger battlefields.
  // Defaults keep headless runs (AI-vs-AI resolve) deterministic. W/H/CX/CY are module-level and
  // are RESTORED from the active sim at the top of every entry point, so two sims never clobber.
  let W = 920, H = 520, CX = W/2, CY = H/2;
  function setWorld(viewW, viewH) {
    if (!viewW || !viewH) { W = 920; H = 520; }      // headless / unknown viewport -> canonical size
    else {
      const aspect = Math.max(1.25, Math.min(2.1, viewW / viewH));   // clamp wild aspect ratios
      W = Math.round(Math.max(1040, Math.min(1820, viewW * 1.18)));  // bigger viewport => bigger field
      H = Math.round(Math.max(640, Math.min(1080, W / aspect)));
      W = Math.round(Math.max(1040, Math.min(1820, H * aspect)));    // re-derive so the field keeps the screen's shape
    }
    CX = W / 2; CY = H / 2;
  }
  function useWorld(sim) { W = sim.W; H = sim.H; CX = sim.CX; CY = sim.CY; }   // restore this sim's dimensions

  const CFG = {
    duration: 60, scorePerPoint: 1.0, captureSpeed: 0.5,
    spawnR: 32, maxUnitsPerSide: 80, infSquad: 6, infRespawnEvery: 0.75,
    vehTicketsPer: 3, vehAiEvery: 8, vehCooldown: 4.5,
    projSpeed: 330, wallThick: 12, resolveDt: 1/30, maxDodge: 0.6,
    surgeLead: 20, surgeDur: 12,
  };

  const UNITS = {
    // vsVeh = damage multiplier vs vehicles (infantry default 0.22; scout 0 none; heavy 1.0 full)
    rifleman:{ name:'Rifleman', art:'🪖', cost:3,  type:'inf', hp:110, dmg:13, range:135, cd:0.60, spd:60,  r:9,  dodge:0.10, capW:1.0, vsVeh:0.22, bcolor:'#ffd86b', bw:1.7 },
    scout:   { name:'Scout',    art:'🥾', cost:2,  type:'inf', hp:45,  dmg:32, range:210, cd:1.35, spd:140, r:8,  dodge:0.30, capW:0.8, vsVeh:0.0,  bcolor:'#9be8ff', bw:1.8 },   // sniper
    support: { name:'Support',  art:'🔫', cost:3,  type:'inf', hp:125, dmg:6,  range:120, cd:0.22, spd:58,  r:9,  dodge:0.10, capW:1.0, vsVeh:0.22, bcolor:'#ffe07a', bw:1.2 },   // high fire rate
    medic:   { name:'Medic',    art:'💉', cost:4,  type:'inf', hp:100, dmg:11, range:125, cd:0.65, spd:60,  r:9,  dodge:0.10, capW:1.0, vsVeh:0.22, bcolor:'#bfffce', bw:1.5, aura:{kind:'heal',   amt:34, rad:84, every:2.0} },
    heavy:   { name:'Heavy',    art:'💣', cost:5,  type:'inf', hp:150, dmg:30, range:150, cd:1.30, spd:44,  r:11, dodge:0.06, capW:1.4, vsVeh:1.0,  bcolor:'#ff9b4b', bw:2.4, projectile:true, splash:40 },   // rockets, tank-speed
    engineer:{ name:'Engineer', art:'🔧', cost:4,  type:'inf', hp:100, dmg:11, range:125, cd:0.65, spd:60,  r:9,  dodge:0.10, capW:1.0, vsVeh:0.22, bcolor:'#bfe0ff', bw:1.5, aura:{kind:'repair', amt:50, rad:84, every:2.0} },
    shield:  { name:'Shield Droid', art:'🛡️', cost:4, type:'inf', hp:115, dmg:6, range:110, cd:1.0, spd:54, r:10, dodge:0.08, capW:1.0, vsVeh:0.22, bcolor:'#7fd4ff', bw:1.4, shieldGen:{ r:24, hp:130, life:3, recharge:4 } },  // shield cycle: 4s down, 3s up (starts down)
    apc:     { name:'APC',      art:'🚙', cost:8,  type:'veh', hp:320, dmg:8,  range:150, cd:0.32, spd:72,  r:15, dodge:0.05, capW:3.0, bcolor:'#ffb86b', bw:2.1, dodgeAura:{rad:95,  amt:0.15} },
    tank:    { name:'Tank',     art:'🚜', cost:12, type:'veh', hp:600, dmg:72, range:205, cd:1.9,  spd:44,  r:21, dodge:0.04, capW:4.0, bcolor:'#ff7b4b', bw:3.4, dodgeAura:{rad:110, amt:0.18} },
    spawner: { name:'Spawner',  art:'🚐', cost:10, type:'veh', hp:300, dmg:6,  range:120, cd:2.0,  spd:48,  r:16, dodge:0.04, capW:2.0, vsVeh:0.22, bcolor:'#ffd86b', bw:2.0, spawnerVeh:true },  // mobile forward spawn (one per faction)
    bunker:  { name:'Bunker',   art:'🏰', cost:4,  type:'inf', hp:700, dmg:20, range:165, cd:1.0,  spd:0,   r:17, dodge:0.0,  capW:3.0, vsVeh:0.4, bcolor:'#ffe08a', bw:2.4, infra:true },
    depot:   { name:'Depot',    art:'🏭', cost:5,  type:'inf', hp:240, dmg:0,  range:0,   cd:1.0,  spd:0,   r:16, dodge:0.0,  capW:1.0, vsVeh:0, infra:true },
    pizza:   { name:'Pizza',    art:'🍕', cost:0,  type:'inf', hp:110, dmg:5,  range:120, cd:0.6,  spd:58,  r:11, dodge:0.06, capW:0.0, vsVeh:0.18, bcolor:'#ffcf6b', bw:1.4, neutral:true },  // Pizza Legion (event only)
    pirate:  { name:'Pirate',   art:'🏴‍☠️', cost:0, type:'inf', hp:130, dmg:8,  range:130, cd:0.7,  spd:56,  r:11, dodge:0.08, capW:0.0, vsVeh:0.2,  bcolor:'#d8b070', bw:1.5, neutral:true },  // Pirate Crew
    alien:   { name:'Alien',    art:'👾', cost:0,  type:'inf', hp:100, dmg:9,  range:160, cd:0.5,  spd:60,  r:10, dodge:0.12, capW:0.0, vsVeh:0.2,  bcolor:'#9bff7a', bw:1.6, neutral:true },  // Alien Swarm (ranged)
    clown:   { name:'Clown',    art:'🤡', cost:0,  type:'inf', hp:90,  dmg:6,  range:115, cd:0.8,  spd:66,  r:10, dodge:0.16, capW:0.0, vsVeh:0.18, bcolor:'#ff9be0', bw:1.4, neutral:true },  // Clown Posse (fast, evasive)
  };
  const PIZZA_CRIT = { art:'🍕', hp:110, dmg:4, r:11, spd:60, pizza:true };   // 100-strong pizza stampede profile
  // neutral invader factions (event-spawned, attack everyone)
  const INV_FAC = {
    '_merc':   { color:'#9aa3ab', name:'Mercenaries', icon:'☠' },
    '_pizza':  { color:'#e8b04b', name:'Pizza Legion', icon:'🍕' },
    '_pirate': { color:'#caa15e', name:'Pirate Crew', icon:'🏴‍☠️' },
    '_alien':  { color:'#7ed957', name:'Alien Swarm', icon:'👾' },
    '_clown':  { color:'#ff6ad5', name:'Clown Posse', icon:'🤡' },
  };
  const MERC_POOL = ['rifleman','support','heavy','scout'];

  // battle-point costs for spendable effects
  const ABILITIES = { heal:50, repair:100, orbital:150, orb:200, cruiser:250 };
  // special unit: a huge multi-gun ship that crosses the map in a straight line, also lobs missiles
  const CRUISER = { name:'Battlecruiser', art:'🛸', type:'veh', hp:4800, dmg:70, range:260, cd:0.5, spd:26, r:30,
                    dodge:0, capW:6, vsVeh:1, cruiser:true, weapons:5, missiles:2, missileDmg:105, bcolor:'#ffe07a', bw:2.6 };
  // neutral wildlife — roam the field and ram units for damage; tougher beasts hit harder but move slower
  const CRITTERS = [
    { art:'🦖', hp:300, dmg:36, r:16, spd:48 }, { art:'🦕', hp:380, dmg:22, r:18, spd:30 },
    { art:'🦏', hp:220, dmg:30, r:14, spd:56 }, { art:'🐗', hp:120, dmg:16, r:11, spd:74 },
    { art:'🦬', hp:240, dmg:26, r:14, spd:52 }, { art:'🐉', hp:320, dmg:32, r:16, spd:64 },
    { art:'🦣', hp:400, dmg:34, r:18, spd:34 }, { art:'🐘', hp:360, dmg:30, r:18, spd:40 },
    { art:'🦛', hp:300, dmg:28, r:16, spd:46 }, { art:'🐊', hp:200, dmg:34, r:13, spd:58 },
    { art:'🐅', hp:150, dmg:30, r:11, spd:88 }, { art:'🐂', hp:240, dmg:24, r:14, spd:54 },
    { art:'🐻', hp:220, dmg:30, r:13, spd:60 }, { art:'🦌', hp:120, dmg:18, r:11, spd:82 },
    { art:'🦒', hp:200, dmg:22, r:16, spd:50 }, { art:'🦘', hp:110, dmg:18, r:10, spd:92 },
  ];

  const TERRAINS = [
    { name:'Plains',    bg:'#1c2a22', grid:'#26402f', cover:'#3a5a44', deco:'grass',  d1:'#2c4a36', d2:'#37603f' },
    { name:'Desert',    bg:'#2b2618', grid:'#41391f', cover:'#5e5230', deco:'dune',   d1:'#41391f', d2:'#564a2c' },
    { name:'Urban',     bg:'#1e2127', grid:'#2c3038', cover:'#444b56', deco:'rubble', d1:'#363c46', d2:'#2a2f37' },
    { name:'Tundra',    bg:'#1d2630', grid:'#2b3a47', cover:'#43586a', deco:'ice',    d1:'#33485a', d2:'#48637a' },
    { name:'Wasteland', bg:'#26201b', grid:'#3a2d24', cover:'#4d3c30', deco:'crater', d1:'#3a2d24', d2:'#241b16' },
    { name:'Forest',    bg:'#16241a', grid:'#223a28', cover:'#2e5238', deco:'tree',   d1:'#1d3a24', d2:'#2a5234' },
    { name:'Volcanic',  bg:'#241715', grid:'#3a201c', cover:'#522a22', deco:'lava',   d1:'#7a2a16', d2:'#b5471c' },
    { name:'Coastal',   bg:'#152330', grid:'#22394a', cover:'#36546b', deco:'water',  d1:'#1d3a52', d2:'#274a63' },
  ];

  function mkRng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // evenly spaced spawn circles on an outer ring; `m` capture points evenly spaced on an inner ring
  // (radius from the short dimension) so the whole layout is rotationally symmetric -> fair for every faction
  function layout(n, m) {
    m = m || n;
    const Rs = Math.min(CX, CY) - CFG.spawnR - 10, Rp = Rs * 0.55;   // as far out as fits, equal spacing (fair)
    const start = n===2 ? 180 : n===4 ? 45 : 90;        // orientation that reads well per N (player left in 2-way)
    const spawns = [], pts = [];
    for (let i = 0; i < n; i++) { const a = (start + i*360/n) * Math.PI/180;
      spawns.push({ x: CX + Rs*Math.cos(a), y: CY - Rs*Math.sin(a) }); }
    // place m flags on the inner ring, rotating the ring within one sector to sit as FAR from every spawn as
    // possible (so flags land in contested middle ground, never right next to a spawn point)
    const flagAt = (rot) => { const ps = []; for (let i = 0; i < m; i++) { const a = (start + i*360/m) * Math.PI/180 + rot;
      ps.push({ x: CX + Rp*Math.cos(a), y: CY - Rp*Math.sin(a) }); } return ps; };
    const minSpawnDist = (ps) => { let mn = 1e9; for (const p of ps) for (const s of spawns) mn = Math.min(mn, Math.hypot(p.x-s.x, p.y-s.y)); return mn; };
    let bestRot = 0, bestMin = -1;
    for (let k = 0; k <= 24; k++) { const rot = (k/24) * (2*Math.PI/m); const d = minSpawnDist(flagAt(rot)); if (d > bestMin) { bestMin = d; bestRot = rot; } }
    for (const p of flagAt(bestRot)) pts.push(p);
    return { spawns, pts };
  }

  function segHitsRect(ax, ay, bx, by, r) {
    if (ax < r.x && bx < r.x) return false; if (ax > r.x+r.w && bx > r.x+r.w) return false;
    if (ay < r.y && by < r.y) return false; if (ay > r.y+r.h && by > r.y+r.h) return false;
    const inside = (px,py) => px>=r.x && px<=r.x+r.w && py>=r.y && py<=r.y+r.h;
    if (inside(ax,ay) || inside(bx,by)) return true;
    const cross = (x1,y1,x2,y2,x3,y3,x4,y4) => {
      const d = (x2-x1)*(y4-y3)-(y2-y1)*(x4-x3); if (!d) return false;
      const t = ((x3-x1)*(y4-y3)-(y3-y1)*(x4-x3))/d, u = ((x3-x1)*(y2-y1)-(y3-y1)*(x2-x1))/d;
      return t>=0 && t<=1 && u>=0 && u<=1;
    };
    return cross(ax,ay,bx,by, r.x,r.y, r.x+r.w,r.y) || cross(ax,ay,bx,by, r.x,r.y, r.x,r.y+r.h) ||
           cross(ax,ay,bx,by, r.x+r.w,r.y, r.x+r.w,r.y+r.h) || cross(ax,ay,bx,by, r.x,r.y+r.h, r.x+r.w,r.y+r.h);
  }
  function segSeg(x1,y1,x2,y2,x3,y3,x4,y4) {              // do segments (1-2) and (3-4) intersect?
    const d = (x2-x1)*(y4-y3)-(y2-y1)*(x4-x3); if (!d) return false;
    const t = ((x3-x1)*(y4-y3)-(y3-y1)*(x4-x3))/d, u = ((x3-x1)*(y2-y1)-(y3-y1)*(x2-x1))/d;
    return t>=0 && t<=1 && u>=0 && u<=1;
  }
  // ---- convex polygon obstacles (verts in world coords) ----
  function polyInside(poly, x, y) {
    const V = poly.verts, n = V.length; let pos = false, neg = false;
    for (let i = 0; i < n; i++) { const a = V[i], b = V[(i+1)%n];
      const c = (b.x-a.x)*(y-a.y) - (b.y-a.y)*(x-a.x);
      if (c > 0.0001) pos = true; else if (c < -0.0001) neg = true;
      if (pos && neg) return false; }
    return true;
  }
  function polyNearest(poly, x, y) {                       // closest boundary point + distance
    const V = poly.verts, n = V.length; let bestD = Infinity, bx = x, by = y;
    for (let i = 0; i < n; i++) { const a = V[i], b = V[(i+1)%n];
      const ex = b.x-a.x, ey = b.y-a.y, L = ex*ex+ey*ey || 1;
      const t = Math.max(0, Math.min(1, ((x-a.x)*ex + (y-a.y)*ey)/L));
      const px = a.x+ex*t, py = a.y+ey*t, d = Math.hypot(x-px, y-py);
      if (d < bestD) { bestD = d; bx = px; by = py; } }
    return { d: bestD, bx, by };
  }
  function collidePoly(poly, x, y, rad) {
    if (Math.hypot(x-poly.x, y-poly.y) > poly.r + rad) return { x, y };   // quick reject
    const inside = polyInside(poly, x, y), near = polyNearest(poly, x, y);
    if (!inside && near.d >= rad) return { x, y };
    const dx = inside ? (near.bx - x) : (x - near.bx), dy = inside ? (near.by - y) : (y - near.by), dl = Math.hypot(dx, dy) || 1;
    return { x: near.bx + dx/dl*rad, y: near.by + dy/dl*rad };
  }
  function segHitsPoly(ax, ay, bx, by, poly) {
    if (polyInside(poly, ax, ay) || polyInside(poly, bx, by)) return true;
    const V = poly.verts, n = V.length;
    for (let i = 0; i < n; i++) { const a = V[i], b = V[(i+1)%n]; if (segSeg(ax, ay, bx, by, a.x, a.y, b.x, b.y)) return true; }
    return false;
  }
  // rotate a world point into a spinner's local (axis-aligned) frame and back
  const sLocal = (s, x, y) => { const c = Math.cos(-s.angle), n = Math.sin(-s.angle), dx = x-s.cx, dy = y-s.cy; return { x: dx*c - dy*n, y: dx*n + dy*c }; };
  const sWorld = (s, x, y) => { const c = Math.cos(s.angle), n = Math.sin(s.angle); return { x: s.cx + x*c - y*n, y: s.cy + x*n + y*c }; };
  function losClear(sim, ax, ay, bx, by) {
    if (sim.walls.some(r => segHitsRect(ax,ay,bx,by,r)) || sim.movers.some(r => segHitsRect(ax,ay,bx,by,r))) return false;
    if (sim.polys && sim.polys.some(p => segHitsPoly(ax,ay,bx,by,p))) return false;
    return !sim.spinners.some(s => { const a = sLocal(s,ax,ay), b = sLocal(s,bx,by); return segHitsRect(a.x,a.y,b.x,b.y,{ x:-s.w/2, y:-s.h/2, w:s.w, h:s.h }); });
  }
  function collide(sim, x, y, r) {
    for (const w of sim.walls.concat(sim.movers)) {
      const cx = Math.max(w.x, Math.min(x, w.x+w.w)), cy = Math.max(w.y, Math.min(y, w.y+w.h));
      let dx = x-cx, dy = y-cy, d2 = dx*dx+dy*dy;
      if (d2 >= r*r) continue;
      if (d2 > 0.0001) { const d = Math.sqrt(d2); x = cx + dx/d*r; y = cy + dy/d*r; }
      else { const l=x-w.x, ri=w.x+w.w-x, t=y-w.y, b=w.y+w.h-y, m=Math.min(l,ri,t,b);
             if (m===l) x=w.x-r; else if (m===ri) x=w.x+w.w+r; else if (m===t) y=w.y-r; else y=w.y+w.h+r; }
    }
    for (const s of sim.spinners) {                    // rotated-rect pushout in local frame
      const lp = sLocal(s, x, y), hw = s.w/2, hh = s.h/2;
      const cx = Math.max(-hw, Math.min(lp.x, hw)), cy = Math.max(-hh, Math.min(lp.y, hh));
      let dx = lp.x-cx, dy = lp.y-cy, d2 = dx*dx+dy*dy;
      if (d2 >= r*r) continue;
      let nx, ny;
      if (d2 > 0.0001) { const d = Math.sqrt(d2); nx = cx + dx/d*r; ny = cy + dy/d*r; }
      else { const l=lp.x+hw, ri=hw-lp.x, t=lp.y+hh, b=hh-lp.y, m=Math.min(l,ri,t,b); nx=lp.x; ny=lp.y;
             if (m===l) nx=-hw-r; else if (m===ri) nx=hw+r; else if (m===t) ny=-hh-r; else ny=hh+r; }
      const wp = sWorld(s, nx, ny); x = wp.x; y = wp.y;
    }
    if (sim.polys) for (const poly of sim.polys) { const p = collidePoly(poly, x, y, r); x = p.x; y = p.y; }
    return { x: Math.max(6, Math.min(W-6, x)), y: Math.max(6, Math.min(H-6, y)) };
  }
  // Structured battlefields: buildings, defensive lines, rivers/bridges, trenches, forests — composed from
  // tagged rectangles. Every long barrier leaves chokepoint GAPs so paths stay narrow but never sealed.
  function genWalls(rng, cps, spawns) {
    const T = CFG.wallThick, GAP = 66, walls = [];        // GAP = passable lane (wider than the biggest unit)
    const box = (x, y, w, h, kind) => { if (w > 3 && h > 3) walls.push({ x, y, w, h, kind: kind || 'wall' }); };
    // a barrier across [x0,x1] at y leaving gaps at fractional positions g∈[0,1]; th = thickness
    const barH = (y, x0, x1, gaps, kind, th) => { th = th || T; let cx = x0;
      for (const g of gaps.slice().sort((a,b)=>a-b)) { const c = x0 + (x1-x0)*g; box(cx, y, (c-GAP/2)-cx, th, kind); cx = c + GAP/2; }
      box(cx, y, x1-cx, th, kind); };
    const barV = (x, y0, y1, gaps, kind, th) => { th = th || T; let cy = y0;
      for (const g of gaps.slice().sort((a,b)=>a-b)) { const c = y0 + (y1-y0)*g; box(x, cy, th, (c-GAP/2)-cy, kind); cy = c + GAP/2; }
      box(x, cy, th, y1-cy, kind); };
    const ring = (x, y, w, h, doors, kind) => {           // building footprint; doors = sides to gap (t/r/b/l)
      kind = kind || 'building';
      doors.includes('t') ? barH(y, x, x+w, [0.5], kind) : box(x, y, w, T, kind);
      doors.includes('b') ? barH(y+h-T, x, x+w, [0.5], kind) : box(x, y+h-T, w, T, kind);
      doors.includes('l') ? barV(x, y, y+h, [0.5], kind) : box(x, y, T, h, kind);
      doors.includes('r') ? barV(x+w-T, y, y+h, [0.5], kind) : box(x+w-T, y, T, h, kind); };
    const scatter = (n, x0, y0, x1, y1, smin, smax, kind) => { for (let i=0;i<n;i++){ const s = smin+rng()*(smax-smin);
      box(x0+rng()*(x1-x0), y0+rng()*(y1-y0), s, s*(0.55+rng()*0.7), kind); } };

    switch (Math.floor(rng() * 10)) {
      case 0:   // river crossing — a wide impassable band with two bridges, sandbags guarding each
        barH(CY - T*1.4, W*0.05, W*0.95, [0.30, 0.70], 'river', T*2.8);
        scatter(4, W*0.24, CY-H*0.10, W*0.40, CY+H*0.10, 18, 30, 'sandbag');
        scatter(4, W*0.60, CY-H*0.10, W*0.76, CY+H*0.10, 18, 30, 'sandbag'); break;
      case 1:   // twin compounds facing a contested center
        ring(W*0.15, H*0.28, W*0.21, H*0.44, ['r'], 'building');
        ring(W*0.64, H*0.28, W*0.21, H*0.44, ['l'], 'building');
        scatter(4, W*0.43, H*0.40, W*0.57, H*0.60, 22, 34, 'crate'); break;
      case 2:   // urban grid — solid blocks, streets between them are the narrow lanes
        for (const gx of [0.16, 0.50, 0.84]) for (const gy of [0.30, 0.70])
          box(W*gx - W*0.075, H*gy - H*0.10, W*0.15, H*0.20, 'building'); break;
      case 3:   // staggered defensive lines (serpentine approach)
        barH(H*0.32, W*0.10, W*0.90, [0.28], 'sandbag');
        barH(H*0.52, W*0.10, W*0.90, [0.72], 'sandbag');
        barH(H*0.72, W*0.10, W*0.90, [0.40], 'sandbag'); break;
      case 4: {  // central fortress with opposing gates
        const x = CX-W*0.14, y = CY-H*0.20, w = W*0.28, h = H*0.40;
        box(x, y, w, T, 'building'); box(x, y+h-T, w, T, 'building');     // top & bottom solid
        barV(x, y, y+h, [0.5], 'building'); barV(x+w-T, y, y+h, [0.5], 'building');   // gated sides
        scatter(3, x+w*0.3, y+h*0.35, x+w*0.7, y+h*0.65, 20, 30, 'crate'); break; }
      case 5:   // forest belt down the middle — scattered cover, lanes weave through
        scatter(16, W*0.38, H*0.05, W*0.62, H*0.95, 14, 26, 'rock'); break;
      case 6:   // trench network — parallel lines with staggered crossings
        barV(W*0.34, H*0.08, H*0.92, [0.42], 'trench');
        barV(W*0.50, H*0.08, H*0.92, [0.70], 'trench');
        barV(W*0.66, H*0.08, H*0.92, [0.30], 'trench'); break;
      case 7:   // crossroads — a plus-shaped mass splits the field into four approaches
        barH(CY - T/2, W*0.16, W*0.84, [0.5], 'wall');
        barV(CX - T/2, H*0.12, H*0.88, [0.5], 'wall');
        scatter(4, W*0.20, H*0.20, W*0.80, H*0.80, 18, 28, 'rubble'); break;
      case 8:   // ridges & rubble — broken cover, a couple of long ridges with gaps
        barH(H*0.34, W*0.14, W*0.52, [], 'rock'); barH(H*0.62, W*0.50, W*0.86, [], 'rock');
        scatter(7, W*0.18, H*0.15, W*0.82, H*0.85, 16, 30, 'rubble'); break;
      default:  // outpost line — light sandbag cover, open ground (skirmish)
        barH(H*0.36, W*0.22, W*0.50, [], 'sandbag'); barH(H*0.64, W*0.52, W*0.78, [], 'sandbag');
        scatter(5, W*0.20, H*0.20, W*0.80, H*0.80, 20, 32, 'crate');
    }

    const ptHit = (w, pad) => cps.some(p => {
      const cx = Math.max(w.x, Math.min(p.x, w.x+w.w)), cy = Math.max(w.y, Math.min(p.y, w.y+w.h));
      if (Math.hypot(p.x-cx, p.y-cy) < p.r + pad) return true;
      if (p.gx == null) return false;                      // also keep the generator circle clear
      const gcx = Math.max(w.x, Math.min(p.gx, w.x+w.w)), gcy = Math.max(w.y, Math.min(p.gy, w.y+w.h));
      return Math.hypot(p.gx-gcx, p.gy-gcy) < p.gr + pad; });
    // keep a clear lane (wider than the biggest unit) around every spawn & flag so nothing chokes them off
    const blocked = (w) => ptHit(w, 32) || spawns.some(s => { const cx = Math.max(w.x, Math.min(s.x, w.x+w.w)), cy = Math.max(w.y, Math.min(s.y, w.y+w.h));
        return Math.hypot(s.x-cx, s.y-cy) < CFG.spawnR + 50; });
    return walls.filter(w => w.w > 3 && w.h > 3 && !blocked(w));
  }
  // every spawn must be able to reach every capture point through the nav grid (no flag walled off)
  function allReachable(sim, spawns) {
    const nv = sim.nav, fields = nv.dist.concat(nv.distGen);   // every flag AND generator must be reachable
    for (const s of spawns) {
      const c = Math.max(0, Math.min(nv.cols-1, Math.floor(s.x/nv.cell))), r = Math.max(0, Math.min(nv.rows-1, Math.floor(s.y/nv.cell)));
      for (const D of fields) { let ok = false;
        for (let dr=-1; dr<=1 && !ok; dr++) for (let dc=-1; dc<=1; dc++) { const nc=c+dc, nr=r+dr;
          if (nc>=0 && nr>=0 && nc<nv.cols && nr<nv.rows && D[nr*nv.cols+nc] < 1e9) { ok = true; break; } }
        if (!ok) return false; }
    }
    return true;
  }
  // is (x,y) clear of every spawn circle and capture point by `ext`+margin? (ext = obstacle reach)
  function clearSpot(x, y, ext, cps, spawns) {
    for (const p of cps) { if (Math.hypot(p.x-x, p.y-y) < p.r + ext + 34) return false;
      if (p.gx != null && Math.hypot(p.gx-x, p.gy-y) < p.gr + ext + 30) return false; }   // keep generators clear too
    for (const s of spawns) if (Math.hypot(s.x-x, s.y-y) < CFG.spawnR + ext + 50) return false;
    return true;
  }
  // gentle patrolling cover — slow, short travel; never spawns over a flag or spawn circle
  function genMovers(rng, cps, spawns) {
    const movers = [], n = 2 + Math.floor(rng()*2);
    for (let i = 0; i < n; i++) { const horiz = rng() < 0.5;
      const w = horiz ? 60+rng()*40 : 14, h = horiz ? 14 : 60+rng()*40, range = 24+rng()*22;
      const ext = Math.hypot(w, h)/2 + range;          // cover the bar's corners + full travel
      let ox, oy, ok = false, t = 0;
      do { ox = W*(0.22+rng()*0.56); oy = H*(0.24+rng()*0.52); ok = clearSpot(ox, oy, ext, cps, spawns); }
      while (!ok && ++t < 40);
      if (ok) movers.push({ ox, oy, x:ox, y:oy, w, h, axis: horiz ? 'y' : 'x', range, speed: 0.18+rng()*0.18, phase: rng()*6.283, mover:true });
    }
    return movers;
  }
  // slow-spinning bars; the swept circle (half length) is kept off flags and spawns
  function genSpinners(rng, cps, spawns) {
    const spinners = [];
    for (let i = 0; i < 2; i++) {
      const w = 100+rng()*46, ext = w/2;
      let cx, cy, ok = false, t = 0;
      do { cx = W*(0.26+rng()*0.48); cy = H*(0.26+rng()*0.48); ok = clearSpot(cx, cy, ext, cps, spawns); }
      while (!ok && ++t < 40);
      if (ok) spinners.push({ cx, cy, w, h: 14, angle: rng()*6.283, spin: (rng()<0.5?-1:1)*(0.45+rng()*0.45) });
    }
    return spinners;
  }
  // convex polygon boulders/crystals/mesas — solid cover with varied silhouettes (3–6 sides)
  function genPolys(rng, cps, spawns) {
    const polys = [], count = 2 + Math.floor(rng()*3);
    const kinds = ['rock','crystal','mesa'];
    for (let i = 0; i < count; i++) {
      const sides = 3 + Math.floor(rng()*4), rad = 26 + rng()*26, ext = rad;
      let cx, cy, ok = false, t = 0;
      do { cx = W*(0.18+rng()*0.64); cy = H*(0.18+rng()*0.64); ok = clearSpot(cx, cy, ext, cps, spawns); }
      while (!ok && ++t < 40);
      if (!ok) continue;
      const rot = rng()*6.283, verts = [];
      for (let s = 0; s < sides; s++) { const a = rot + s*2*Math.PI/sides, rr = rad*(0.84 + rng()*0.3);   // mild jitter keeps it convex
        verts.push({ x: cx + Math.cos(a)*rr, y: cy + Math.sin(a)*rr }); }
      polys.push({ x:cx, y:cy, r:rad*1.35, verts, kind: kinds[Math.floor(rng()*kinds.length)] });
    }
    return polys;
  }

  function buildNav(sim) {
    const cell = 18, cols = Math.ceil(W/cell), rows = Math.ceil(H/cell);   // fine grid routes through narrow chokepoints
    const pass = new Uint8Array(cols*rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const x = c*cell+cell/2, y = r*cell+cell/2;
      const wallBlock = sim.walls.some(w => x > w.x-9 && x < w.x+w.w+9 && y > w.y-9 && y < w.y+w.h+9);
      const polyBlock = sim.polys && sim.polys.some(p => Math.hypot(x-p.x, y-p.y) <= p.r+9 && (polyInside(p, x, y) || polyNearest(p, x, y).d < 9));
      pass[r*cols+c] = (wallBlock || polyBlock) ? 0 : 1; }
    const N4 = [[1,0],[-1,0],[0,1],[0,-1]];
    const fieldTo = (px, py) => {                           // BFS distance grid from a target point
      const D = new Int32Array(cols*rows).fill(1e9);
      let sc = Math.max(0, Math.min(cols-1, Math.floor(px/cell))), sr = Math.max(0, Math.min(rows-1, Math.floor(py/cell)));
      if (!pass[sr*cols+sc]) { let bd = 1e9, bi = -1;
        for (let i = 0; i < cols*rows; i++) if (pass[i]) { const d = Math.hypot(i%cols-sc, Math.floor(i/cols)-sr); if (d < bd) { bd = d; bi = i; } }
        if (bi >= 0) { sc = bi%cols; sr = Math.floor(bi/cols); } }
      const s = sr*cols+sc; D[s] = 0; const q = [s];
      for (let h = 0; h < q.length; h++) { const cur = q[h], cr = Math.floor(cur/cols), cc = cur%cols;
        for (const [dc,dr] of N4) { const nc = cc+dc, nr = cr+dr; if (nc<0||nr<0||nc>=cols||nr>=rows) continue;
          const ni = nr*cols+nc; if (!pass[ni] || D[ni] < 1e9) continue; D[ni] = D[cur]+1; q.push(ni); } }
      return D;
    };
    sim.nav = { cell, cols, rows, pass, dist: sim.cps.map(p => fieldTo(p.x, p.y)), distGen: sim.cps.map(p => fieldTo(p.gx, p.gy)) };
  }
  function navDir(sim, D, x, y) {
    const nv = sim.nav;
    const cc = Math.max(0, Math.min(nv.cols-1, Math.floor(x/nv.cell))), cr = Math.max(0, Math.min(nv.rows-1, Math.floor(y/nv.cell)));
    let bd = D[cr*nv.cols+cc], bx = null, by = null;
    const N8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    for (const [dc,dr] of N8) { const nc = cc+dc, nr = cr+dr; if (nc<0||nr<0||nc>=nv.cols||nr>=nv.rows) continue;
      const ni = nr*nv.cols+nc; if (!nv.pass[ni]) continue;
      if (dc && dr && (!nv.pass[cr*nv.cols+(cc+dc)] || !nv.pass[(cr+dr)*nv.cols+cc])) continue;
      if (D[ni] < bd) { bd = D[ni]; bx = nc; by = nr; } }
    if (bx == null) return null;
    const tx = bx*nv.cell+nv.cell/2, ty = by*nv.cell+nv.cell/2, dx = tx-x, dy = ty-y, m = Math.hypot(dx,dy)||1;
    return { x: dx/m, y: dy/m };
  }
  function nearestPoint(sim, u, unownedOnly) {
    let bi = -1, bd = Infinity;
    sim.cps.forEach((p, i) => { if (unownedOnly && p.owner === u.f) return; const d = Math.hypot(u.x-p.x, u.y-p.y); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }

  function dmgFactor(att, tgt) {
    if (tgt.type === 'veh') return att.type === 'veh' ? 1 : (att.def.vsVeh != null ? att.def.vsVeh : 0.22);
    return 1;
  }
  function applyHit(sim, target, dmg, direct, sx, sy) {
    // a shield orb absorbs damage to a unit INSIDE it from any source OUTSIDE it
    if (sx != null && sim.orbs.length) for (const o of sim.orbs) {
      if (Math.hypot(target.x-o.x, target.y-o.y) <= o.r && Math.hypot(sx-o.x, sy-o.y) > o.r) { if (!o.immortal) o.hp -= dmg; sim.dodges.push({ x:target.x, y:target.y, t:0.2 }); return true; }
    }
    if (direct) { const eff = Math.min(CFG.maxDodge, (target.def.dodge || 0) + (target.dodgeBonus || 0));
      if (eff > 0 && sim.rng() < eff) { sim.dodges.push({ x:target.x, y:target.y, t:0.3 }); return false; } }
    target.hp -= dmg; return true;
  }
  function nearestEnemy(sim, u, preferVeh) {
    let best = null, bd = Infinity;
    for (const e of sim.units) { if (e.f === u.f) continue; let d = dist(u, e); if (preferVeh && e.type !== 'veh') d += 300; if (d < bd) { bd = d; best = e; } }
    return best;
  }
  function strikeThreat(sim, u) {
    for (const s of sim.strikes) if (s.warn > 0 && Math.hypot(u.x-s.x, u.y-s.y) <= s.r + 32) return s;
    return null;
  }
  function emit(sim, ev) { if (sim.emit) { sim.events.push(ev); if (sim.events.length > 120) sim.events.shift(); } }
  function spawnCruiser(sim, f, artOverride, speedMul) {
    if (sim.units.some(u => u.f === f && u.cruiser)) return;   // only one cruiser per faction at a time
    const R = sim.rng, edge = Math.floor(R()*4), off = (R()-0.5)*0.4; let x, y, dx, dy;
    if (edge===0) { x=-40; y=H*(0.25+R()*0.5); dx=1;  dy=off; }
    else if (edge===1) { x=W+40; y=H*(0.25+R()*0.5); dx=-1; dy=off; }
    else if (edge===2) { x=W*(0.25+R()*0.5); y=-40; dx=off; dy=1; }
    else { x=W*(0.25+R()*0.5); y=H+40; dx=off; dy=-1; }
    const m = Math.hypot(dx,dy)||1;
    sim.units.push({ id:sim.uid++, f, key:'cruiser', def:CRUISER, type:'veh', x, y, hp:CRUISER.hp, maxHp:CRUISER.hp,
      cd:0, healTimer:0, dodgeBonus:0, behavior:'point', homePoint:0, jx:0, jy:0, cruiser:{ dx:dx/m, dy:dy/m }, artOverride, speedMul: speedMul || 1 });
    sim.count[f] = (sim.count[f]||0) + 1;
  }

  /* ---- wildlife + battlefield events ---- */
  function spawnCritter(sim, charge, dir, profile) {
    const R = sim.rng, t = profile || CRITTERS[Math.floor(R()*CRITTERS.length)], pizza = !!t.pizza;
    let x, y, vx, vy;
    if (charge && dir) { x = dir.x; y = dir.y; vx = dir.vx; vy = dir.vy; }
    else { x = W*(0.2+R()*0.6); y = H*(0.2+R()*0.6); const a = R()*6.283; vx = Math.cos(a); vy = Math.sin(a); }
    sim.critters.push({ x, y, vx, vy, hp:t.hp, maxHp:t.hp, r:t.r, dmg: t.dmg*(charge && !pizza ?1.8:1), art:t.art, pizza,
      spd: t.spd*(charge?1.8:1), hitCd:0, turnCd:1+R()*2, charge: !!charge, entered: !charge });   // a charging stampede hits much harder
  }
  function updateCritters(sim, dt) {
    if (!sim.critters.length) return;
    for (const c of sim.critters) {
      c.hitCd = Math.max(0, c.hitCd - dt);
      if (c.charge) { c.x += c.vx*c.spd*dt; c.y += c.vy*c.spd*dt;     // stampede: plow straight through and off the map
        if (!c.entered && c.x > -10 && c.x < W+10 && c.y > -10 && c.y < H+10) c.entered = true; }
      else {
        c.turnCd -= dt;
        if (c.turnCd <= 0) { const a = Math.atan2(c.vy,c.vx) + (sim.rng()-0.5)*1.6; c.vx = Math.cos(a); c.vy = Math.sin(a); c.turnCd = 1+sim.rng()*2; }
        const stepd = c.spd*dt, p = collide(sim, c.x+c.vx*stepd, c.y+c.vy*stepd, c.r);
        if (Math.hypot(p.x-c.x, p.y-c.y) < stepd*0.5) { const a = Math.atan2(c.vy,c.vx) + Math.PI*(0.5+sim.rng()*0.5)*(sim.rng()<0.5?1:-1); c.vx = Math.cos(a); c.vy = Math.sin(a); }
        c.x = p.x; c.y = p.y;
        if (c.x <= 8 || c.x >= W-8) c.vx = -Math.abs(c.vx)*Math.sign(c.x-W/2);
        if (c.y <= 8 || c.y >= H-8) c.vy = -Math.abs(c.vy)*Math.sign(c.y-H/2);
      }
      if (c.hitCd <= 0) for (const u of sim.units) { if (u.cruiser) continue;   // beasts can't hurt carriers
        const d = Math.hypot(u.x-c.x, u.y-c.y);
        if (d <= c.r + u.def.r + 2) { applyHit(sim, u, c.dmg * (c.pizza ? 1 : 2), true, c.x, c.y);   // animals/dinos hit 2x
          const kd = d || 1; u.x += (u.x-c.x)/kd*9; u.y += (u.y-c.y)/kd*9;     // knock back
          sim.bursts.push({ x:(u.x+c.x)/2, y:(u.y+c.y)/2, t:0.18, big:false, mega:0 }); c.hitCd = 0.7; break; } }
    }
    for (const c of sim.critters) if (c.hp <= 0) { sim.bursts.push({ x:c.x, y:c.y, t:0.45, big:true, mega:20 }); emit(sim, { t:'boom', big:false }); }
    sim.critters = sim.critters.filter(c => c.hp > 0 && !(c.charge && c.entered && (c.x < -70 || c.x > W+70 || c.y < -70 || c.y > H+70)));
  }
  function ensureFac(sim, fid) {                           // register a neutral invader faction on first use
    if (sim.color[fid]) return; const f = INV_FAC[fid];
    sim.color[fid] = f.color; sim.name[fid] = f.name; sim.count[fid] = 0; sim.losses[fid] = 0; sim.score[fid] = 0;
  }
  const nearSpawn = (sim, x, y, pad) => sim.sides.some(id => { const a = sim.anchor[id]; return Math.hypot(a.x-x, a.y-y) < CFG.spawnR + (pad||40); });
  function invaderSpot(sim) {                              // a spot clear of flags, generators and faction spawns
    const R = sim.rng; let x, y, t = 0;
    do { x = W*(0.16+R()*0.68); y = H*(0.16+R()*0.68); t++; }
    while (t < 30 && (sim.cps.some(p => Math.hypot(p.x-x, p.y-y) < p.r+24 || Math.hypot(p.gx-x, p.gy-y) < p.gr+24) || nearSpawn(sim, x, y)));
    return { x, y };
  }
  // add one spawn point for faction fid that pumps out `unitKey` units ('_pool' = a random merc unit)
  function addInvader(sim, fid, unitKey, every, until, timer) {
    ensureFac(sim, fid); const s = invaderSpot(sim);
    sim.invaders.push({ fid, unitKey, x:s.x, y:s.y, every, until: sim.t+until, timer: timer || 0.4 });
  }
  function spawnInvaderUnit(sim, iv) {
    const key = iv.unitKey === '_pool' ? MERC_POOL[Math.floor(sim.rng()*MERC_POOL.length)] : iv.unitKey;
    const u = spawn(sim, iv.fid, key, iv.x+(sim.rng()-0.5)*30, iv.y+(sim.rng()-0.5)*30); if (u) u.behavior = 'aggressive';
  }
  const hasInvader = (sim, fid) => sim.invaders.some(iv => iv.fid === fid);
  function eventStampede(sim) {
    const R = sim.rng, horiz = R()<0.5, low = R()<0.5, n = 46 + Math.floor(R()*14);   // a massive herd (~46-60)
    for (let i = 0; i < n; i++) { let x, y, vx, vy;
      if (horiz) { x = low ? -40-R()*140 : W+40+R()*140; vx = low?1:-1; vy = (R()-0.5)*0.25; y = H*(0.08+R()*0.84); }
      else       { y = low ? -40-R()*140 : H+40+R()*140; vy = low?1:-1; vx = (R()-0.5)*0.25; x = W*(0.08+R()*0.84); }
      const m = Math.hypot(vx,vy)||1; spawnCritter(sim, true, { x, y, vx:vx/m, vy:vy/m }); }
  }
  function eventMeteor(sim) {
    const R = sim.rng, n = 6 + Math.floor(R()*8);
    for (let i = 0; i < n; i++) sim.strikes.push({ x: W*(0.08+R()*0.84), y: H*(0.08+R()*0.84), r: 26+R()*22,
      warn: 1.2 + R()*2.0 + i*0.18, warn0: 3.6, faction:null, dmg:520, meteor:true });
  }
  function eventMerc(sim) { addInvader(sim, '_merc', '_pool', 0.44, 22, 0.4); }   // one fast spawn point (5x rate)
  function eventCarrier(sim) { ensureFac(sim, '_merc'); spawnCruiser(sim, '_merc'); }
  function chargeWave(sim, n, profile) {                   // a stampede of `n` charge-critters from one edge
    const R = sim.rng, horiz = R()<0.5, low = R()<0.5;
    for (let i = 0; i < n; i++) { let x, y, vx, vy;
      if (horiz) { x = low ? -40-R()*220 : W+40+R()*220; vx = low?1:-1; vy = (R()-0.5)*0.25; y = H*(0.05+R()*0.9); }
      else       { y = low ? -40-R()*220 : H+40+R()*220; vy = low?1:-1; vx = (R()-0.5)*0.25; x = W*(0.05+R()*0.9); }
      const m = Math.hypot(vx,vy)||1; spawnCritter(sim, true, { x, y, vx:vx/m, vy:vy/m }, profile); }
  }
  function eventPizza(sim) {                                // pizza carrier (2x fast) + 100-strong stampede + 5 spawn points
    ensureFac(sim, '_pizza'); spawnCruiser(sim, '_pizza', '🍕', 2);
    chargeWave(sim, 100, PIZZA_CRIT);
    for (let i = 0; i < 5; i++) addInvader(sim, '_pizza', 'pizza', 1.6, 20, 0.3 + i*0.2);
  }
  function eventPirate(sim) {                               // pirate ship + 5 pirate spawn points
    ensureFac(sim, '_pirate'); spawnCruiser(sim, '_pirate', '🚢');
    for (let i = 0; i < 5; i++) addInvader(sim, '_pirate', 'pirate', 1.8, 22, 0.3 + i*0.25);
  }
  function eventAlien(sim) {                                // alien saucer + 5 alien spawn points
    ensureFac(sim, '_alien'); spawnCruiser(sim, '_alien', '🛸');
    for (let i = 0; i < 5; i++) addInvader(sim, '_alien', 'alien', 1.7, 22, 0.3 + i*0.22);
  }
  function eventClown(sim) {                                // 3 clown spawn points (no carrier)
    for (let i = 0; i < 3; i++) addInvader(sim, '_clown', 'clown', 1.5, 22, 0.3 + i*0.3);
  }
  const EVENT_LABEL = { stampede:'⚠ STAMPEDE INCOMING', meteor:'⚠ METEOR SHOWER', merc:'⚠ MERCENARY ATTACK', carrier:'⚠ MERCENARY CARRIER', pizza:'⚠ PIZZA ATTACK', pirate:'⚠ PIRATE ATTACK', alien:'⚠ ALIEN ATTACK', clown:'⚠ CLOWN ATTACK' };
  function fireRandomEvent(sim) {
    const e = sim.eventCfg, opts = [];
    if (e.stampede) opts.push(['stampede', eventStampede]); if (e.meteor) opts.push(['meteor', eventMeteor]);
    if (e.merc && !hasInvader(sim, '_merc')) opts.push(['merc', eventMerc]); if (e.carrier) opts.push(['carrier', eventCarrier]);
    if (e.pizza && !hasInvader(sim, '_pizza')) opts.push(['pizza', eventPizza]);
    if (e.pirate && !hasInvader(sim, '_pirate')) opts.push(['pirate', eventPirate]);
    if (e.alien && !hasInvader(sim, '_alien')) opts.push(['alien', eventAlien]);
    if (e.clown && !hasInvader(sim, '_clown')) opts.push(['clown', eventClown]);
    if (!opts.length) return;
    const [kind, fn] = opts[Math.floor(sim.rng()*opts.length)]; fn(sim);
    const label = EVENT_LABEL[kind];
    sim.eventLog.push({ t: sim.t, kind, label });
    sim.alert = { label, until: sim.t + 3.5 };              // red-alert banner the UI reads
    emit(sim, { t: 'alarm' });                              // klaxon when sound is on
  }

  // spend battle points on a battlefield effect (fixed costs)
  function ability(sim, f, kind, x, y) {
    useWorld(sim);
    const cost = ABILITIES[kind]; if (cost == null || (sim.score[f]||0) < cost) return false;
    if (kind === 'cruiser' && sim.units.some(u => u.f === f && u.cruiser)) return false;   // one cruiser per faction
    sim.score[f] -= cost;
    if (kind === 'heal')      for (const u of sim.units) { if (u.f===f && u.type==='inf' && u.hp<u.maxHp) { u.hp=u.maxHp; sim.heals.push({ x:u.x, y:u.y, t:0.6, kind:'heal' }); } }
    else if (kind === 'repair') for (const u of sim.units) { if (u.f===f && u.type==='veh' && !u.cruiser && u.hp<u.maxHp) { u.hp=u.maxHp; sim.heals.push({ x:u.x, y:u.y, t:0.6, kind:'repair' }); } }   // cruiser can't be repaired
    else if (kind === 'orbital') sim.strikes.push({ x, y, r: CFG.spawnR, warn: 3.0, warn0: 3.0, faction: f, dmg: 6000 });   // spawn-point sized, kills everything inside
    else if (kind === 'orb') sim.orbs.push({ x, y, r: 52, hp: 1800, maxHp: 1800, f });                                     // shield bubble (doubled hp)
    else if (kind === 'cruiser') spawnCruiser(sim, f);
    return true;
  }
  function genDecor(rng, terrain) {
    const items = [], n = Math.round(40 * (W*H) / (920*520));   // keep decor density constant on bigger fields
    for (let i = 0; i < n; i++) items.push({ x: rng()*W, y: rng()*H, s: 4+rng()*13, k: rng() });
    return { type: terrain.deco, d1: terrain.d1, d2: terrain.d2, items };
  }

  const BEHAVIORS = ['point','point','roam','aggressive','camp'];
  function spawn(sim, faction, key, x, y) {
    const d = UNITS[key];
    if (sim.count[faction] >= (sim.maxUnits || CFG.maxUnitsPerSide)) return null;
    const R = sim.rng;
    const u = { id: sim.uid++, f: faction, key, def: d, type: d.type, x, y, hp: d.hp, maxHp: d.hp, cd: 0,
                healTimer: d.aura ? d.aura.every : 0, dodgeBonus: 0, orbRef: null, shieldCd: d.shieldGen ? d.shieldGen.recharge : 0,
                behavior: BEHAVIORS[Math.floor(R()*BEHAVIORS.length)], homePoint: Math.floor(R()*sim.cps.length),
                jx: (R()-0.5)*26, jy: (R()-0.5)*26, slideSide: R() < 0.5 ? -1 : 1 };
    sim.units.push(u); sim.count[faction]++; return u;
  }
  function spawnPos(sim, f) {
    const a = sim.anchor[f], ang = sim.rng()*Math.PI*2, rad = Math.sqrt(sim.rng())*CFG.spawnR;
    return { x: Math.max(8, Math.min(W-8, a.x+Math.cos(ang)*rad)), y: Math.max(8, Math.min(H-8, a.y+Math.sin(ang)*rad)) };
  }
  function clampZone(sim, f, x, y) {
    const a = sim.anchor[f], dx = x-a.x, dy = y-a.y, d = Math.hypot(dx,dy);
    if (d > CFG.spawnR) { x = a.x+dx/d*CFG.spawnR; y = a.y+dy/d*CFG.spawnR; }
    return { x: Math.max(8, Math.min(W-8, x)), y: Math.max(8, Math.min(H-8, y)) };
  }
  function allow(sim, key) { return !sim.allowed || sim.allowed.has(key); }

  const hasSpawner = (sim, f) => sim.units.some(u => u.f === f && u.key === 'spawner');   // only one alive per faction
  function deployVehicle(sim, f, x, y, key) {
    useWorld(sim);
    const ctrl = sim.spawn[f]; if (!ctrl) return null;
    const p = clampZone(sim, f, x, y);
    if (sim.vehInfinite) {
      if (ctrl.vehCd > 0) return null;
      const k = key || ctrl.vehTypes.find(t => allow(sim, t)); if (!k || !ctrl.vehTypes.includes(k) || !allow(sim, k)) return null;
      if (k === 'spawner' && hasSpawner(sim, f)) return null;
      if (spawn(sim, f, k, p.x, p.y)) { ctrl.vehCd = CFG.vehCooldown; return k; } return null;
    }
    if (!ctrl.tickets.length) return null;
    const idx = key ? ctrl.tickets.indexOf(key) : ctrl.tickets.findIndex(t => allow(sim, t)); if (idx < 0) return null;
    const k = ctrl.tickets[idx]; if (!allow(sim, k)) return null;
    if (k === 'spawner' && hasSpawner(sim, f)) return null;
    if (spawn(sim, f, k, p.x, p.y)) { ctrl.tickets.splice(idx, 1); return k; } return null;
  }
  function vehicleTickets(sim, f) { return sim.spawn[f] ? sim.spawn[f].tickets.slice() : []; }
  function vehStatus(sim, f) {
    const ctrl = sim.spawn[f]; if (!ctrl) return [];
    if (sim.vehInfinite) return ctrl.vehTypes.filter(k => allow(sim, k)).map(k => ({ key:k, inf:true, ready: ctrl.vehCd <= 0, cd: ctrl.vehCd }));
    const c = {}; ctrl.tickets.forEach(k => { if (allow(sim, k)) c[k] = (c[k]||0)+1; });
    return Object.keys(c).map(k => ({ key:k, count:c[k], ready:true }));
  }

  function buildSide(sim, f, army) {
    const allInf = army.filter(a => UNITS[a.key].type === 'inf' && !UNITS[a.key].infra);
    let inf = allInf.filter(a => allow(sim, a.key));               // initial deploy respects enabled set
    if (!inf.length) { const def = allow(sim,'rifleman') ? 'rifleman' : Object.keys(UNITS).find(k => UNITS[k].type==='inf' && !UNITS[k].infra && allow(sim,k)); if (def) inf = [{ key:def }]; }
    const infra = army.filter(a => UNITS[a.key].infra && allow(sim, a.key));
    const veh = army.filter(a => UNITS[a.key].type === 'veh');
    for (const a of inf) for (let s = 0; s < (sim.infSquad || CFG.infSquad); s++) { const p = spawnPos(sim, f); spawn(sim, f, a.key, p.x, p.y); }
    infra.forEach(a => { const p = spawnPos(sim, f); spawn(sim, f, a.key, p.x, p.y); });
    const human = sim.controlled === f, tickets = [], vehTypes = [...new Set(veh.map(a => a.key))];
    if (!sim.vehInfinite) veh.forEach(a => {
      if (human) { for (let t = 0; t < CFG.vehTicketsPer; t++) tickets.push(a.key); }
      else { if (allow(sim, a.key)) { const p = spawnPos(sim, f); spawn(sim, f, a.key, p.x, p.y); } for (let t = 0; t < CFG.vehTicketsPer-1; t++) tickets.push(a.key); }
    });
    // roster holds ALL committed infantry; respawn filters by `allowed` live (so toggling units works without restart)
    sim.spawn[f] = { roster: (allInf.length ? allInf : [{ key:'rifleman' }]).map(a => a.key), idx: 0, infTimer: CFG.infRespawnEvery*sim.rng(), tickets, vehTypes, vehTimer: CFG.vehAiEvery*0.6, vehCd: 0 };
  }

  function spawnController(sim, f, dt) {
    const ctrl = sim.spawn[f];
    if (ctrl.roster.length) {
      const zero = sim.t < (sim.zeroEnd[f] || 0), surge = sim.surgeFaction === f && sim.t < sim.surgeEnd;
      const every = zero ? CFG.infRespawnEvery*0.2 : surge ? CFG.infRespawnEvery*0.3 : CFG.infRespawnEvery;   // last-stand 5x, comeback surge
      ctrl.infTimer -= dt;
      if (ctrl.infTimer <= 0) { ctrl.infTimer += every;
        let key = null;
        for (let k = 0; k < ctrl.roster.length; k++) { const cand = ctrl.roster[(ctrl.idx+k) % ctrl.roster.length]; if (allow(sim, cand)) { key = cand; ctrl.idx = (ctrl.idx+k+1) % ctrl.roster.length; break; } }
        if (key) {                                         // a deployed Spawner becomes the spawn point (the home spawn is interrupted)
          const sp = sim.units.find(u => u.f === f && u.key === 'spawner');
          const p = sp ? { x: sp.x + (sim.rng()-0.5)*44, y: sp.y + (sim.rng()-0.5)*44 } : spawnPos(sim, f);
          spawn(sim, f, key, p.x, p.y); } }
    }
    ctrl.vehCd = Math.max(0, ctrl.vehCd - dt);
    if (f !== sim.controlled) {
      ctrl.vehTimer -= dt;
      if (ctrl.vehTimer <= 0) { ctrl.vehTimer += CFG.vehAiEvery;
        if (sim.vehInfinite) { const ts = ctrl.vehTypes.filter(k => allow(sim, k) && !(k === 'spawner' && hasSpawner(sim, f))); if (ts.length) { const p = spawnPos(sim, f); spawn(sim, f, ts[Math.floor(sim.rng()*ts.length)], p.x, p.y); } }
        else if (ctrl.tickets.length) { const p = spawnPos(sim, f); deployVehicle(sim, f, p.x, p.y); } }
    }
  }

  function updateProjectiles(sim, dt) {
    if (!sim.projectiles.length) return;
    const spd = CFG.projSpeed;
    for (const p of sim.projectiles) {
      p.life -= dt;
      const gx = (p.target && p.target.hp > 0) ? p.target.x : p.tx, gy = (p.target && p.target.hp > 0) ? p.target.y : p.ty;
      const dx = gx - p.x, dy = gy - p.y, m = Math.hypot(dx, dy) || 1;
      const nx = p.x + dx/m*spd*dt, ny = p.y + dy/m*spd*dt;
      if (!losClear(sim, p.x, p.y, nx, ny)) { p.life = -1; continue; }
      p.x = nx; p.y = ny;
      let hit = false;
      for (const e of sim.units) if (e.f !== p.f && Math.hypot(e.x-p.x, e.y-p.y) <= e.def.r + 3) { hit = true; break; }
      if (hit || m < 8 || p.life <= 0) { if (hit || m < 8) blast(sim, p); p.life = -1; }
    }
    sim.projectiles = sim.projectiles.filter(p => p.life > 0);
  }
  function blast(sim, p) {
    for (const e of sim.units) { if (e.f === p.f) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y); if (d > p.splash + e.def.r) continue;
      const factor = e.type === 'veh' ? (p.vsVeh != null ? p.vsVeh : 0.22) : 1, direct = d <= e.def.r + 4;
      applyHit(sim, e, p.dmg * factor * (direct ? 1 : 0.5), direct, p.x, p.y); }
    for (const c of sim.critters) { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d <= p.splash + c.r) c.hp -= p.dmg * (d <= c.r+4 ? 1 : 0.5); }
    sim.bursts.push({ x:p.x, y:p.y, t:0.26, big:true }); emit(sim, { t:'boom', big:false });
  }

  function step(sim, dt) {
    useWorld(sim);
    if (sim.over) return;
    sim.t += dt;

    // comeback surge: most-losses faction gets 2x spawn for 7s, triggered in the final 20s
    if (isFinite(sim.duration) && !sim.surgeSet && sim.t >= sim.duration - CFG.surgeLead) {
      sim.surgeSet = true; let mx = -1, bf = null;
      for (const f of sim.sides) if (sim.losses[f] > mx) { mx = sim.losses[f]; bf = f; }
      sim.surgeFaction = bf; sim.surgeEnd = sim.t + CFG.surgeDur;
    }
    for (const m of sim.movers) { const off = Math.sin(sim.t*m.speed + m.phase) * m.range; if (m.axis === 'x') m.x = m.ox + off; else m.y = m.oy + off; }
    for (const s of sim.spinners) s.angle += s.spin * dt;
    for (const f of sim.sides) spawnController(sim, f, dt);

    // random battlefield events + active invader spawn points + roaming wildlife
    const ec = sim.eventCfg;
    if (ec.stampede || ec.meteor || ec.merc || ec.carrier || ec.pizza || ec.pirate || ec.alien || ec.clown) {
      sim.nextEvent -= dt; if (sim.nextEvent <= 0) { fireRandomEvent(sim); sim.nextEvent = 16 + sim.rng()*14; }
    }
    if (sim.invaders.length) {                             // every invader spawn point pumps out its faction's units
      for (const iv of sim.invaders) { iv.timer -= dt;
        if (iv.timer <= 0) { iv.timer += iv.every; spawnInvaderUnit(sim, iv); } }
      sim.invaders = sim.invaders.filter(iv => sim.t < iv.until);
    }
    updateCritters(sim, dt);

    // enemy at the gates: if a foe is within 1.5x the spawn radius of an anchor, that faction holds & defends
    const spawnThreat = {}; const THREAT_R = CFG.spawnR * 1.5;
    for (const f of sim.sides) { const a = sim.anchor[f];
      spawnThreat[f] = sim.units.some(e => e.f !== f && Math.hypot(e.x-a.x, e.y-a.y) <= THREAT_R); }

    if (sim.boosts) { const auras = sim.units.filter(u => u.def.dodgeAura);
      for (const u of sim.units) { u.dodgeBonus = 0; if (u.type !== 'inf') continue;
        for (const v of auras) if (v.f === u.f && dist(u, v) <= v.def.dodgeAura.rad) u.dodgeBonus = Math.max(u.dodgeBonus, v.def.dodgeAura.amt); } }

    for (const u of sim.units) {
      if (u.hp <= 0) continue;
      u.cd = Math.max(0, u.cd - dt);
      if (u.cruiser) {                                   // battlecruiser: fly straight, fire many guns, leave at the far edge
        const csp = CRUISER.spd*(u.speedMul||1); u.x += u.cruiser.dx*csp*dt; u.y += u.cruiser.dy*csp*dt;
        if (u.x < -70 || u.x > W+70 || u.y < -70 || u.y > H+70) { u.hp = -1; u.exited = true; continue; }
        if (u.cd <= 0) {
          const targets = sim.units.filter(e => e.f !== u.f && dist(u, e) <= CRUISER.range).sort((a,b) => dist(u,a)-dist(u,b));
          for (let w = 0; w < Math.min(CRUISER.weapons, targets.length); w++) { const t = targets[w];
            applyHit(sim, t, CRUISER.dmg * dmgFactor(u, t), true, u.x, u.y);
            sim.tracers.push({ ax:u.x, ay:u.y, bx:t.x, by:t.y, c:CRUISER.bcolor, w:2.4, t:0.13 }); emit(sim, { t:'shoot', k:'cruiser' }); }
          for (let mw = 0; mw < CRUISER.missiles && targets.length; mw++) {   // also lob splash missiles at the farthest foes
            const t = targets[Math.max(0, targets.length-1-mw)];
            sim.projectiles.push({ x:u.x, y:u.y, tx:t.x, ty:t.y, target:t, f:u.f, c:'#ff6a4a', dmg:CRUISER.missileDmg, vsVeh:1, splash:46, life:3 }); }
          u.cd = CRUISER.cd;
        }
        continue;
      }
      // inside its own immortal spawn shield: normally it must advance out (anti-camp), BUT if the spawn is
      // threatened it stays and defends — firing out while the shield keeps it safe from outside damage
      const inOwnShield = sim.orbs.length > 0 && sim.orbs.some(o => o.immortal && o.f === u.f && Math.hypot(u.x-o.x, u.y-o.y) <= o.r);
      const defend = inOwnShield && spawnThreat[u.f];
      const tgt = (inOwnShield && !defend) ? null : nearestEnemy(sim, u, (u.def.vsVeh || 0) >= 1);   // heavy hunts vehicles
      const inRange = tgt && dist(u, tgt) <= u.def.range && losClear(sim, u.x, u.y, tgt.x, tgt.y);
      if (inRange && u.def.dmg > 0) {
        if (u.cd <= 0) {
          if (u.def.projectile) sim.projectiles.push({ x:u.x, y:u.y, tx:tgt.x, ty:tgt.y, target:tgt, f:u.f, c:u.def.bcolor, dmg:u.def.dmg, vsVeh:u.def.vsVeh, splash:u.def.splash || 0, life:2.5 });
          else { const landed = applyHit(sim, tgt, u.def.dmg * dmgFactor(u, tgt), true, u.x, u.y);
            sim.tracers.push({ ax:u.x, ay:u.y, bx:tgt.x, by:tgt.y, c:u.def.bcolor || sim.color[u.f], w:u.def.bw || 1.6, t:0.12, miss:!landed }); }
          emit(sim, { t:'shoot', k:u.key }); u.cd = u.def.cd;
        }
      } else if (!inRange && u.def.spd > 0 && !defend) {
        let gx, gy;
        const threat = strikeThreat(sim, u);
        const losTgt = tgt && losClear(sim, u.x, u.y, tgt.x, tgt.y);     // only chase if we can SEE it (else go around via nav)
        if (threat) { const dx = u.x-threat.x, dy = u.y-threat.y, m = Math.hypot(dx,dy)||1; gx = u.x+dx/m*80; gy = u.y+dy/m*80; }  // flee the strike
        else if (losTgt && (u.behavior === 'aggressive' || dist(u, tgt) < u.def.range * 1.15)) { gx = tgt.x; gy = tgt.y; }
        else {                                                           // navigate per behaviour: take the GENERATOR if we
          let pi;                                                         // don't own it yet, otherwise hold the FLAG
          if (u.behavior === 'roam') pi = sim.cps[u.homePoint].owner === u.f ? nearestPoint(sim, u, true) : u.homePoint;
          else if (u.behavior === 'camp') pi = nearestPoint(sim, u, false);
          else pi = nearestPoint(sim, u, true);
          if (pi < 0) pi = nearestPoint(sim, u, false);
          const p2 = sim.cps[pi], ownsGen = p2 && p2.shieldOwner === u.f;
          const D = pi >= 0 ? (ownsGen ? sim.nav.dist[pi] : sim.nav.distGen[pi]) : null;
          const goalX = p2 ? (ownsGen ? p2.x : p2.gx) : CX, goalY = p2 ? (ownsGen ? p2.y : p2.gy) : CY;
          const d = D ? navDir(sim, D, u.x, u.y) : null;
          if (d) { gx = u.x + d.x*60 + u.jx; gy = u.y + d.y*60 + u.jy; } else { gx = goalX + u.jx; gy = goalY + u.jy; }
        }
        const dx = gx - u.x, dy = gy - u.y, m = Math.hypot(dx, dy) || 1;
        const step = u.def.spd*dt*(threat ? 0.4 : 1);        // fleeing an orbital: you can escape, but only slowly
        const nx = dx/m, ny = dy/m;
        let p = collide(sim, u.x + nx*step, u.y + ny*step, u.def.r);
        if (Math.hypot(p.x-u.x, p.y-u.y) < step*0.5) {       // blocked -> slide AROUND the obstacle, not into it
          const s = u.slideSide, tx = -ny*s, ty = nx*s;       // perpendicular (consistent per-unit side)
          const a = collide(sim, u.x + (nx*0.4+tx)*step, u.y + (ny*0.4+ty)*step, u.def.r);
          const b = collide(sim, u.x + (nx*0.4-tx)*step, u.y + (ny*0.4-ty)*step, u.def.r);
          const da = Math.hypot(a.x-u.x, a.y-u.y), db = Math.hypot(b.x-u.x, b.y-u.y);
          if (da >= db && da > Math.hypot(p.x-u.x,p.y-u.y)) p = a;
          else if (db > Math.hypot(p.x-u.x,p.y-u.y)) p = b;
        }
        u.x = p.x; u.y = p.y;
      }
      if (sim.boosts && u.def.aura) {
        u.healTimer -= dt;
        if (u.healTimer <= 0) { u.healTimer = u.def.aura.every;
          for (const a of sim.units) { if (a.f !== u.f || dist(u, a) > u.def.aura.rad) continue;
            const ok = u.def.aura.kind === 'heal' ? a.type === 'inf' : (a.type === 'veh' && !a.cruiser);   // cruiser can't be repaired
            if (ok && a.hp < a.maxHp) { a.hp = Math.min(a.maxHp, a.hp + u.def.aura.amt); sim.heals.push({ x:a.x, y:a.y, t:0.5, kind:u.def.aura.kind }); } } }
      }
      if (u.def.shieldGen) {                               // shield droid: pulse a 2s bubble, recharge 5s
        const sg = u.def.shieldGen;
        if (u.orbRef && !sim.orbs.includes(u.orbRef)) { u.orbRef = null; u.shieldCd = sg.recharge; }   // bubble gone -> recharge
        if (u.orbRef) { u.orbRef.x = u.x; u.orbRef.y = u.y; }                                          // bubble follows the droid
        else { u.shieldCd -= dt; if (u.shieldCd <= 0) { const orb = { x:u.x, y:u.y, r:sg.r, hp:sg.hp, maxHp:sg.hp, f:u.f, life:sg.life }; sim.orbs.push(orb); u.orbRef = orb; } }
      }
    }
    // (generators are unshielded now — units move freely; owning the generator is what grants the flag)
    updateProjectiles(sim, dt);

    for (const s of sim.strikes) { s.warn -= dt;
      if (s.warn <= 0) { for (const u of sim.units) { const d = Math.hypot(u.x-s.x, u.y-s.y); if (d <= s.r) applyHit(sim, u, s.dmg * (1 - 0.45*d/s.r), false, s.x, s.y); }
        for (const c of sim.critters) { const d = Math.hypot(c.x-s.x, c.y-s.y); if (d <= s.r) c.hp -= s.dmg * (1 - 0.45*d/s.r); }
        sim.bursts.push({ x:s.x, y:s.y, t:0.7, big:true, mega:s.r }); emit(sim, { t:'boom', big:true }); s.done = true; } }
    if (sim.strikes.length) sim.strikes = sim.strikes.filter(s => !s.done);

    for (const u of sim.units) if (u.hp <= 0) { const big = u.type === 'veh';
      if (u.cruiser && !u.exited) {                    // dramatic multi-blast cruiser death
        sim.bursts.push({ x:u.x, y:u.y, t:0.95, big:true, mega:90 });
        const R = sim.rng;
        for (let i = 0; i < 6; i++) sim.bursts.push({ x:u.x+(R()-0.5)*70, y:u.y+(R()-0.5)*50, t:0.5+R()*0.5, big:true, mega:28+R()*30 });
        emit(sim, { t:'boom', big:true });
      } else {
        sim.bursts.push({ x:u.x, y:u.y, t: big?0.45 : 0.16, big, mega:0 });
        if (big && !u.exited) emit(sim, { t:'boom', big:true });
      }
      sim.count[u.f]--; sim.losses[u.f]++; }
    sim.units = sim.units.filter(u => u.hp > 0);

    // last-stand: a wiped-out faction gets 5x spawn for 5s (once per 60s)
    for (const f of sim.sides) if (sim.count[f] === 0 && sim.t - (sim.lastZero[f] || -999) >= 60) { sim.lastZero[f] = sim.t; sim.zeroEnd[f] = sim.t + 5; }

    if (sim.orbs.length) {
      for (const o of sim.orbs) { if (o.life != null) o.life -= dt;
        if (o.hp <= 0 && !o.immortal) { sim.bursts.push({ x:o.x, y:o.y, t:0.5, big:true, mega:o.r }); emit(sim, { t:'boom', big:true }); } }
      sim.orbs = sim.orbs.filter(o => (o.hp > 0 || o.immortal) && (o.life == null || o.life > 0));   // hp-broken or timed-out bubbles expire
    }

    for (const p of sim.cps) {
      // 1) generator: a SEPARATE circle (gx,gy,gr) contested from any side, weighted by unit value
      const gp = {};
      for (const u of sim.units) if (Math.hypot(u.x-p.gx, u.y-p.gy) <= p.gr) gp[u.f] = (gp[u.f] || 0) + (u.def.capW || 1);
      let gdom = null, gmax = 0, gsec = 0;
      for (const f of sim.sides) { const v = gp[f] || 0; if (v > gmax) { gsec = gmax; gmax = v; gdom = f; } else if (v > gsec) gsec = v; }
      if (gmax > 0 && gmax > gsec) {
        if (gdom === p.shieldOwner) p.genHold = Math.min(1, p.genHold + dt*CFG.captureSpeed);
        else { p.genHold -= dt*CFG.captureSpeed; if (p.genHold <= 0) { p.shieldOwner = gdom; p.genHold = 1; } }
      }
      // 2) flag: belongs to the generator's owner; it scores while that owner holds the flag itself
      p.owner = p.shieldOwner;
      const held = p.owner && sim.units.some(u => u.f === p.owner && dist(u, p) <= p.r);
      if (held) { p.hold = Math.min(1, p.hold + dt*CFG.captureSpeed); sim.score[p.owner] += CFG.scorePerPoint*dt; }
      else p.hold = Math.max(0, p.hold - dt*CFG.captureSpeed*0.6);
    }

    decay(sim.tracers, dt); decay(sim.bursts, dt); decay(sim.heals, dt); decay(sim.dodges, dt);
    sim.tracers = sim.tracers.filter(x => x.t > 0); sim.bursts = sim.bursts.filter(x => x.t > 0);
    sim.heals = sim.heals.filter(x => x.t > 0); sim.dodges = sim.dodges.filter(x => x.t > 0);

    if (isFinite(sim.duration) && sim.t >= sim.duration) endNow(sim);
  }
  function decay(arr, dt) { for (const x of arr) x.t -= dt; }

  function endNow(sim) {
    sim.over = true;
    let win = null, max = -1, tie = false;
    for (const f of sim.sides) { const s = sim.score[f]; if (s > max) { max = s; win = f; tie = false; } else if (s === max) tie = true; }
    sim.winner = tie ? null : win;
  }
  function result(sim) { return { winner: sim.winner, scores: { ...sim.score } }; }

  function init(opts) {
    opts = opts || {};
    const rng = mkRng(opts.seed != null ? opts.seed : 12345);
    const sides = opts.sides || [{ id:'dominion', color:'#e74c3c', name:'Iron Dominion' },
                                 { id:'freestates', color:'#3498db', name:'Cobalt Free States' }];
    const ids = sides.map(s => s.id), n = ids.length;
    setWorld(opts.viewW, opts.viewH);                  // size the battlefield to the screen (bigger viewport => bigger field)
    const area = W * H, scale = Math.sqrt(area / (920 * 520));     // density factor vs the canonical map
    const terrain = TERRAINS[Math.floor(rng() * TERRAINS.length)];
    // capture flags: a random count from n down to n-2 (never below 1) unless caller pins it
    const spread = Math.min(2, n - 1);
    const m = opts.points != null ? Math.max(1, Math.min(n, opts.points)) : (n - Math.floor(rng() * (spread + 1)));
    const lay = layout(n, m);
    // each flag has a SEPARATE generator circle (placed ~halfway toward the centre); own the generator to own the flag
    const cps = lay.pts.map(p => ({ x:p.x, y:p.y, r:27, gx: p.x + (CX-p.x)*0.42, gy: p.y + (CY-p.y)*0.42, gr:30,
      owner:null, hold:0, shieldOwner:null, genHold:0 }));
    const walls = genWalls(rng, cps, lay.spawns);

    const sim = {
      W, H, CX, CY,                                    // frozen per-sim dimensions (restored via useWorld each entry)
      infSquad: Math.max(6, Math.min(10, Math.round(CFG.infSquad * scale))),    // keep big fields populated
      maxUnits: Math.max(80, Math.min(160, Math.round(CFG.maxUnitsPerSide * scale))),
      rng, terrain, t:0, over:false, winner:null, uid:1,
      units:[], tracers:[], projectiles:[], bursts:[], heals:[], dodges:[], strikes:[], orbs:[], spawn:{},
      critters:[], invaders:[], eventLog:[],             // wildlife + battlefield-event state
      events:[], emit: !!opts.emit, lastZero:{}, zeroEnd:{},
      decor: genDecor(rng, terrain), movers: genMovers(rng, cps, lay.spawns), spinners: genSpinners(rng, cps, lay.spawns),
      polys: genPolys(rng, cps, lay.spawns),
      cps, walls, sides: ids,
      eventCfg: Object.assign({ wildlife:false, stampede:false, meteor:false, merc:false, carrier:false, pizza:false, pirate:false, alien:false, clown:false }, opts.eventCfg || {}),
      nextEvent: 12 + rng()*8,                            // first random event window
      anchor: Object.fromEntries(ids.map((id, i) => [id, lay.spawns[i]])),
      color: Object.fromEntries(sides.map(s => [s.id, s.color])),
      name:  Object.fromEntries(sides.map(s => [s.id, s.name])),
      score: Object.fromEntries(ids.map(id => [id, 0])),
      count: Object.fromEntries(ids.map(id => [id, 0])),
      losses: Object.fromEntries(ids.map(id => [id, 0])),
      controlled: opts.controlled || null,
      duration: opts.duration != null ? opts.duration : CFG.duration,
      allowed: opts.allowed ? new Set(opts.allowed) : null,
      boosts: opts.boosts !== false,
      vehInfinite: !!opts.vehInfinite,
      dayMode: opts.dayMode || (opts.dayNight === false ? 'day' : 'shift'),   // 'day' | 'night' | 'shift'
      surgeSet:false, surgeFaction:null, surgeEnd:0,
    };
    buildNav(sim);
    if (!allReachable(sim, lay.spawns)) { sim.walls = []; sim.polys = []; buildNav(sim); }   // safety: never seal a flag off
    const armies = opts.armies || {};
    ids.forEach(id => buildSide(sim, id, armies[id] || [{ key:'rifleman' }]));
    if (opts.spawnShields) for (const id of ids) { const a = sim.anchor[id]; sim.orbs.push({ x:a.x, y:a.y, r:CFG.spawnR, hp:Infinity, maxHp:Infinity, f:id, immortal:true }); }
    if (sim.eventCfg.wildlife) for (let i = 0; i < 2 + Math.floor(rng()*3); i++) spawnCritter(sim, false);   // ambient wildlife
    return sim;
  }

  function resolve(opts) {
    const sim = init(Object.assign({ controlled:null }, opts));
    const dur = isFinite(sim.duration) ? sim.duration : 60, dt = CFG.resolveDt; let i = 0;
    while (!sim.over && i < Math.ceil(dur/dt) + 60) { step(sim, dt); i++; }
    if (!sim.over) endNow(sim);
    return result(sim);
  }

  function drawDecor(ctx, sim) {
    const D = sim.decor; if (!D) return;
    for (const it of D.items) {
      ctx.globalAlpha = 0.5; ctx.fillStyle = it.k < 0.5 ? D.d1 : D.d2;
      if (D.type === 'tree' || D.type === 'grass') { ctx.beginPath(); ctx.moveTo(it.x, it.y-it.s); ctx.lineTo(it.x-it.s*0.6, it.y); ctx.lineTo(it.x+it.s*0.6, it.y); ctx.closePath(); ctx.fill(); }
      else if (D.type === 'crater' || D.type === 'rubble') { ctx.lineWidth = 2; ctx.strokeStyle = it.k<0.5?D.d1:D.d2; ctx.beginPath(); ctx.arc(it.x, it.y, it.s, 0, Math.PI*2); ctx.stroke(); }
      else if (D.type === 'lava' || D.type === 'water') { ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.arc(it.x, it.y, it.s*0.8, 0, Math.PI*2); ctx.fill(); }
      else { ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.ellipse(it.x, it.y, it.s*1.3, it.s*0.6, 0, 0, Math.PI*2); ctx.fill(); }   // dune/ice soft blobs
    }
    ctx.globalAlpha = 1;
  }

  // distinct look per obstacle type so the battlefield reads as real terrain
  function drawWall(ctx, tr, w, night) {
    const k = w.kind || 'wall';
    if (night) {                                          // neon: dark slab + glowing edge tinted by type
      const edge = k==='river' ? '#36d6ff' : k==='sandbag' ? '#ffd24a' : k==='trench' ? '#ff5ea8'
                 : (k==='rock'||k==='rubble') ? '#9aa0ff' : k==='building' ? '#46f5b0' : '#5ad6ff';
      ctx.fillStyle = k==='river' ? '#08222e' : '#0c1018'; ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.shadowColor = edge; ctx.shadowBlur = 8; ctx.strokeStyle = edge; ctx.lineWidth = 1.6;
      ctx.strokeRect(w.x+0.5, w.y+0.5, Math.max(0,w.w-1), Math.max(0,w.h-1)); ctx.shadowBlur = 0;
      return;
    }
    if (k === 'river') {                                  // impassable water with banks + ripples
      ctx.fillStyle = '#1d4258'; ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = '#2c5f7d'; ctx.fillRect(w.x, w.y+2, w.w, Math.max(0, w.h-4));
      ctx.strokeStyle = '#6fb4cf55'; ctx.lineWidth = 1.5;
      for (let yy = w.y+5; yy < w.y+w.h-2; yy += 7) { ctx.beginPath(); ctx.moveTo(w.x+4, yy); ctx.lineTo(w.x+w.w-4, yy); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 1; ctx.strokeRect(w.x, w.y, w.w, w.h); return;
    }
    if (k === 'sandbag') {                                // tan bags, rounded segments
      ctx.fillStyle = '#6f6038'; ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = '#8c7a48'; ctx.lineWidth = 2;
      if (w.w >= w.h) for (let xx = w.x+5; xx < w.x+w.w; xx += 11) { ctx.beginPath(); ctx.moveTo(xx, w.y+1); ctx.lineTo(xx, w.y+w.h-1); ctx.stroke(); }
      else for (let yy = w.y+5; yy < w.y+w.h; yy += 11) { ctx.beginPath(); ctx.moveTo(w.x+1, yy); ctx.lineTo(w.x+w.w-1, yy); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 1; ctx.strokeRect(w.x, w.y, w.w, w.h); return;
    }
    if (k === 'trench') {                                 // dark dug line with raised lip
      ctx.fillStyle = '#241d16'; ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = '#5a4a36'; ctx.lineWidth = 2; ctx.strokeRect(w.x+1, w.y+1, w.w-2, w.h-2); return;
    }
    if (k === 'rock' || k === 'rubble') {                 // grey broken rock
      ctx.fillStyle = '#54555c'; ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = '#6e7079'; ctx.lineWidth = 1.5; ctx.strokeRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.moveTo(w.x, w.y+w.h); ctx.lineTo(w.x+w.w, w.y); ctx.stroke(); return;
    }
    if (k === 'building') {                               // structure: cover fill, dark frame, inner shading
      ctx.fillStyle = tr.cover; ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(w.x+2, w.y+2, Math.max(0,w.w-4), Math.max(0,w.h-4));
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1.5; ctx.strokeRect(w.x, w.y, w.w, w.h); return;
    }
    // crate / generic wall
    ctx.fillStyle = tr.cover; ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 1; ctx.strokeRect(w.x, w.y, w.w, w.h);
  }
  // convex polygon obstacle (boulder / crystal / mesa)
  function drawPoly(ctx, tr, poly, night) {
    const V = poly.verts; if (!V.length) return;
    const fill = poly.kind === 'crystal' ? (night ? '#10283a' : '#33566e') : poly.kind === 'mesa' ? (night ? '#231a14' : '#5b4636') : (night ? '#10131b' : '#54555c');
    const edge = night ? (poly.kind === 'crystal' ? '#5ad6ff' : poly.kind === 'mesa' ? '#ffb44a' : '#9aa0ff') : 'rgba(0,0,0,.4)';
    ctx.beginPath(); ctx.moveTo(V[0].x, V[0].y); for (let i = 1; i < V.length; i++) ctx.lineTo(V[i].x, V[i].y); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (night) { ctx.shadowColor = edge; ctx.shadowBlur = 8; }
    ctx.strokeStyle = edge; ctx.lineWidth = night ? 1.8 : 1.5; ctx.stroke(); ctx.shadowBlur = 0;
  }

  /* ------------------------------ draw ---------------------------------- */
  function isNight(sim) {                                  // 'day' | 'night' | 'shift' (shift flips every 60s, starts in day)
    const m = sim.dayMode;
    if (m === 'night') return true;
    if (m === 'day') return false;
    return Math.floor(sim.t/60) % 2 === 1;
  }
  function draw(ctx, sim) {
    useWorld(sim);
    const tr = sim.terrain;
    const night = isNight(sim);
    const glow = (c, b) => { ctx.shadowColor = night ? c : 'transparent'; ctx.shadowBlur = night ? b : 0; };
    ctx.fillStyle = night ? '#060912' : tr.bg; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = night ? 'rgba(90,225,255,0.09)' : tr.grid; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 46) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = 0; y <= H; y += 46) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
    if (!night) drawDecor(ctx, sim);                       // decor reads as clutter under neon; hide it at night

    for (const f of sim.sides) { const a = sim.anchor[f];
      glow(sim.color[f], 10);
      ctx.globalAlpha = night ? 0.16 : 0.12; ctx.fillStyle = sim.color[f]; ctx.beginPath(); ctx.arc(a.x, a.y, CFG.spawnR, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = night ? 0.85 : 0.5; ctx.lineWidth = 2; ctx.strokeStyle = sim.color[f]; ctx.stroke(); ctx.globalAlpha = 1; }
    glow(null, 0);

    for (const w of sim.walls) drawWall(ctx, tr, w, night);
    if (sim.polys) for (const poly of sim.polys) drawPoly(ctx, tr, poly, night);
    for (const m of sim.movers) { ctx.fillStyle = tr.cover; ctx.fillRect(m.x, m.y, m.w, m.h);   // patrolling cover (highlighted edge)
      ctx.strokeStyle = '#ffd54f88'; ctx.lineWidth = 2; ctx.strokeRect(m.x, m.y, m.w, m.h); }
    for (const s of sim.spinners) {                     // slow-spinning bars
      ctx.save(); ctx.translate(s.cx, s.cy); ctx.rotate(s.angle);
      ctx.fillStyle = tr.cover; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
      ctx.strokeStyle = '#7fd4ff99'; ctx.lineWidth = 2; ctx.strokeRect(-s.w/2, -s.h/2, s.w, s.h);
      ctx.fillStyle = '#7fd4ff'; ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI*2); ctx.fill(); ctx.restore(); }

    for (const o of sim.orbs) {                         // shield bubbles (immortal spawn shields draw steady)
      const hpf = o.immortal ? 1 : Math.max(0, o.hp/o.maxHp);
      ctx.globalAlpha = 0.08 + 0.12*hpf; ctx.fillStyle = sim.color[o.f]; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = o.immortal ? 0.8 : 0.65; ctx.lineWidth = o.immortal ? 2 : 3; ctx.setLineDash(o.immortal ? [5,4] : []);
      ctx.strokeStyle = o.immortal ? '#eaf2fb' : sim.color[o.f]; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
      if (!o.immortal) { ctx.globalAlpha = 1; ctx.lineWidth = 3; ctx.strokeStyle = '#eaf2fb'; ctx.beginPath(); ctx.arc(o.x, o.y, Math.max(0, o.r-3), -Math.PI/2, -Math.PI/2 + Math.PI*2*hpf); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;

    for (const p of sim.cps) {
      const oc = p.shieldOwner ? sim.color[p.shieldOwner] : null;
      // generator — its own separate circle (capture it to own the linked flag); a tether line shows the link
      ctx.globalAlpha = 0.35; ctx.strokeStyle = oc || '#5a6b7d'; ctx.lineWidth = 1; ctx.setLineDash([3,4]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.gx, p.gy); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(p.gx, p.gy, p.gr, 0, Math.PI*2);
      ctx.fillStyle = oc ? oc+'1c' : 'rgba(150,170,190,.08)'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = oc || '#7e8c9a'; ctx.stroke();
      if (p.genHold > 0 && p.genHold < 1) { ctx.beginPath(); ctx.arc(p.gx, p.gy, Math.max(0,p.gr-4), -Math.PI/2, -Math.PI/2 + Math.PI*2*p.genHold);
        ctx.strokeStyle = oc || '#9fb0c0'; ctx.lineWidth = 3.5; ctx.stroke(); }
      ctx.fillStyle = oc || '#aebccb'; ctx.font = 'bold 14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('⚙', p.gx, p.gy+5);
      // flag (no shield now) — owner ring + hold progress
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      ctx.fillStyle = oc ? oc+'22' : 'rgba(255,255,255,.04)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = oc || '#5a6b7d'; ctx.stroke();
      if (p.owner && p.hold < 1) { ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0,p.r-6), -Math.PI/2, -Math.PI/2 + Math.PI*2*p.hold);
        ctx.strokeStyle = oc; ctx.lineWidth = 5; ctx.stroke(); }
      ctx.fillStyle = '#cdd8e2'; ctx.font = 'bold 14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('⚑', p.x, p.y+5);
    }

    if (night) ctx.shadowBlur = 6;
    for (const t of sim.tracers) { ctx.globalAlpha = Math.max(0, t.t/0.12) * (t.miss ? 0.4 : 1);
      ctx.strokeStyle = t.c; ctx.lineWidth = t.w; if (night) ctx.shadowColor = t.c; ctx.setLineDash(t.miss ? [3,3] : []);
      ctx.beginPath(); ctx.moveTo(t.ax, t.ay); ctx.lineTo(t.bx, t.by); ctx.stroke(); }
    ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.shadowBlur = 0;

    for (const p of sim.projectiles) { if (night) { ctx.shadowColor = p.c || '#ff9b4b'; ctx.shadowBlur = 8; }
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.4, 0, Math.PI*2); ctx.fillStyle = p.c || '#ff9b4b'; ctx.fill();
      ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI*2); ctx.strokeStyle = p.c || '#ff9b4b'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1; ctx.shadowBlur = 0; }

    for (const h of sim.heals) { const k = h.t/0.5; ctx.globalAlpha = Math.max(0, k);
      ctx.strokeStyle = h.kind === 'heal' ? '#7bff9b' : '#7bc0ff'; ctx.lineWidth = 2; const s = 6 + (1-k)*6;
      ctx.beginPath(); ctx.moveTo(h.x-s, h.y); ctx.lineTo(h.x+s, h.y); ctx.moveTo(h.x, h.y-s); ctx.lineTo(h.x, h.y+s); ctx.stroke(); }
    ctx.globalAlpha = 1;

    for (const u of sim.units) {
      const r = u.def.r;
      if (night) { ctx.shadowColor = sim.color[u.f]; ctx.shadowBlur = 9; }
      ctx.beginPath(); ctx.arc(u.x, u.y, r, 0, Math.PI*2); ctx.fillStyle = sim.color[u.f]; ctx.fill(); ctx.shadowBlur = 0;
      if (u.type === 'veh') { ctx.lineWidth = 2; ctx.strokeStyle = night ? '#cfe8ff' : '#0d1924'; ctx.stroke(); }
      ctx.font = r + 'px system-ui'; ctx.textAlign = 'center'; ctx.fillText(u.artOverride || u.def.art, u.x, u.y + r*0.35);
      const w = r*2, hpf = u.hp/u.maxHp;
      ctx.fillStyle = '#0008'; ctx.fillRect(u.x-w/2, u.y-r-6, w, 3);
      ctx.fillStyle = hpf>0.5?'#2ecc71':hpf>0.25?'#f1c40f':'#e74c3c'; ctx.fillRect(u.x-w/2, u.y-r-6, w*hpf, 3);
    }

    // roaming wildlife (drawn above units)
    for (const c of sim.critters) {
      if (night) { ctx.shadowColor = '#ffd36b'; ctx.shadowBlur = 8; }
      ctx.font = (c.r*2) + 'px system-ui'; ctx.textAlign = 'center'; ctx.fillText(c.art, c.x, c.y + c.r*0.7); ctx.shadowBlur = 0;
      if (c.hp < c.maxHp) { const w = c.r*2, hpf = Math.max(0, c.hp/c.maxHp);
        ctx.fillStyle = '#0008'; ctx.fillRect(c.x-w/2, c.y-c.r-6, w, 3);
        ctx.fillStyle = '#e08a3c'; ctx.fillRect(c.x-w/2, c.y-c.r-6, w*hpf, 3); }
    }
    // invader spawn points (temporary, faction-colored, with the faction's icon)
    for (const iv of sim.invaders) { const fac = INV_FAC[iv.fid], pulse = 0.5+0.5*Math.sin(sim.t*6), col = fac ? fac.color : '#9aa3ab';
      ctx.globalAlpha = 0.15+0.16*pulse; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(iv.x, iv.y, CFG.spawnR*0.85, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = 0.9; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([4,4]); ctx.beginPath(); ctx.arc(iv.x, iv.y, CFG.spawnR*0.85, 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.font = 'bold 15px system-ui'; ctx.textAlign = 'center'; ctx.fillText(fac ? fac.icon : '☠', iv.x, iv.y+5); }

    for (const s of sim.strikes) {                     // incoming orbital / meteor strike warning
      const prog = Math.max(0, Math.min(1, 1 - Math.max(0, s.warn)/(s.warn0 || 3))), pulse = 0.5 + 0.5*Math.sin(sim.t*14);
      const col = s.meteor ? '#ff9b3c' : '#ff5a4a';
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([7,5]);
      ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(0, s.r), 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 0.12 + 0.22*pulse; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(0, s.r*prog), 0, Math.PI*2); ctx.fill(); ctx.globalAlpha = 1;
      if (s.meteor) { ctx.globalAlpha = Math.max(0, Math.min(1, s.warn/2)); ctx.font = '18px system-ui'; ctx.textAlign = 'center';   // falling rock
        ctx.fillText('☄️', s.x + s.warn*30, s.y - s.warn*60); ctx.globalAlpha = 1; }
      else { ctx.strokeStyle = '#ff7a6a'; ctx.lineWidth = 1.5; ctx.beginPath();
        ctx.moveTo(s.x-s.r, s.y); ctx.lineTo(s.x+s.r, s.y); ctx.moveTo(s.x, s.y-s.r); ctx.lineTo(s.x, s.y+s.r); ctx.stroke(); }
    }
    for (const d of sim.dodges) { const k = d.t/0.3; ctx.globalAlpha = Math.max(0, k); ctx.strokeStyle = '#dfe9f2'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(d.x, d.y, 6 + (1-k)*8, 0, Math.PI*2); ctx.stroke(); }
    for (const b of sim.bursts) { const max = b.mega ? 0.9 : b.big ? 0.45 : 0.16;
      const k = Math.max(0, Math.min(1, b.t/max)), rad = Math.max(0, (b.mega ? b.mega : b.big ? 46 : 26)*(1-k) + 5);
      ctx.globalAlpha = k;
      ctx.beginPath(); ctx.arc(b.x, b.y, rad, 0, Math.PI*2); ctx.fillStyle = '#ffba6b'; ctx.fill();
      ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(0, rad*0.6), 0, Math.PI*2); ctx.fillStyle = '#fff1c2'; ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  return { get W(){ return W; }, get H(){ return H; }, CFG, UNITS, TERRAINS, ABILITIES, init, step, draw, resolve, result, ability,
           spawn, deployVehicle, vehicleTickets, vehStatus };
})();


/* ======================== 2. Sound (port) ============================ */
/* ===========================================================================
   PENTARCH — Sound mainframe (customizable)

   Drop your own audio-file URLs into BANK below. Multiple URLs per key means
   ONE IS PICKED AT RANDOM each time it plays — so you get variety per unit.
   Leave an array empty to fall back to a built-in synthesized blip, so there is
   audible feedback even with no files yet.

     Sound.BANK.shoot.rifleman = ['rifle1.ogg','rifle2.ogg','rifle3.ogg'];
     Sound.BANK.boomBig        = ['kaboom1.ogg','kaboom2.ogg'];
     Sound.BANK.music          = ['track1.ogg','track2.ogg'];

   The engine emits {t:'shoot',k:unitKey} and {t:'boom',big} events (when a sim
   is created with emit:true); the page drains them and calls Sound.shoot/boom.
   Audio starts on a user gesture (the 🔊 toggle) per browser autoplay rules.
   =========================================================================== */
var Sound = (function () {
  const BANK = {
    shoot: {                 // per-unit shooting sounds (random pick); `default` covers any unit with no list
      default: [],
      rifleman: [], scout: [], support: [], medic: [], engineer: [], heavy: [], apc: [], tank: [], cruiser: [],
    },
    boom:    [],             // small / medium explosions
    boomBig: [],             // big explosions (orbital, vehicles, cruiser death)
    alarm:   [],             // red-alert klaxon when a map event triggers
    music:   [],             // background tracks — one chosen at random, looped
  };
  const CFG = { volume: 0.5, musicVolume: 0.35, maxConcurrent: 10 };

  let muted = true, actx = null, master = null, musicEl = null, live = 0;
  const rand = a => a[Math.floor(Math.random() * a.length)];

  function ensure() {
    if (actx) return;
    try { actx = new (window.AudioContext || window.webkitAudioContext)();
      master = actx.createGain(); master.gain.value = CFG.volume; master.connect(actx.destination); } catch (e) {}
  }
  function playUrl(url, vol) {
    if (live > CFG.maxConcurrent) return;
    const a = new Audio(url); a.volume = Math.min(1, vol == null ? CFG.volume : vol);
    live++; a.addEventListener('ended', () => live--); a.play().catch(() => live--);
  }
  // per-unit synthesized shot voices (used only when no file is configured for that unit)
  const VOICE = {
    rifleman: { type:'square',   f0:340, f1:150, a:0.07, d:0.05 },
    scout:    { type:'sawtooth', f0:900, f1:420, a:0.06, d:0.04 },   // sharp crack
    support:  { type:'square',   f0:300, f1:170, a:0.05, d:0.035 },  // rapid pop
    medic:    { type:'triangle', f0:420, f1:220, a:0.05, d:0.05 },
    engineer: { type:'triangle', f0:420, f1:220, a:0.05, d:0.05 },
    heavy:    { type:'sine',     f0:150, f1:46,  a:0.16, d:0.22 },   // deep rocket "whoomph" (was harsh)
    apc:      { type:'square',   f0:260, f1:120, a:0.07, d:0.06 },
    tank:     { type:'sawtooth', f0:120, f1:40,  a:0.18, d:0.18 },   // heavy cannon
    cruiser:  { type:'sawtooth', f0:200, f1:70,  a:0.10, d:0.10 },
    default:  { type:'triangle', f0:480, f1:210, a:0.06, d:0.05 },
  };
  function blip(v) {
    ensure(); if (!actx) return;
    const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    o.type = v.type; o.frequency.setValueAtTime(v.f0 * (0.92 + Math.random()*0.16), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, v.f1), t + v.d);
    g.gain.setValueAtTime(v.a, t); g.gain.exponentialRampToValueAtTime(0.001, t + v.d + 0.01);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + v.d + 0.02);
  }
  function synthBoom(big) {
    ensure(); if (!actx) return;
    const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(big?130:190, t); o.frequency.exponentialRampToValueAtTime(big?26:54, t+(big?0.42:0.17));
    g.gain.setValueAtTime(big?0.5:0.28, t); g.gain.exponentialRampToValueAtTime(0.001, t+(big?0.46:0.2));
    o.connect(g); g.connect(master); o.start(t); o.stop(t+(big?0.46:0.2));
  }

  function synthAlarm() {                                  // two-tone klaxon (red alert)
    ensure(); if (!actx) return;
    const t = actx.currentTime;
    for (let i = 0; i < 3; i++) { const o = actx.createOscillator(), g = actx.createGain(), s = t + i*0.34;
      o.type = 'sawtooth'; o.frequency.setValueAtTime(740, s); o.frequency.setValueAtTime(560, s + 0.17);
      g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.32, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.32);
      o.connect(g); g.connect(master); o.start(s); o.stop(s + 0.33); }
  }
  function shoot(key) { if (muted) return; const arr = (BANK.shoot[key] && BANK.shoot[key].length) ? BANK.shoot[key] : BANK.shoot.default; arr.length ? playUrl(rand(arr)) : blip(VOICE[key] || VOICE.default); }
  function boom(big)  { if (muted) return; const arr = big ? BANK.boomBig : BANK.boom; arr.length ? playUrl(rand(arr)) : synthBoom(big); }
  function alarm()    { if (muted) return; BANK.alarm.length ? playUrl(rand(BANK.alarm), 0.6) : synthAlarm(); }
  function startMusic() { if (muted || !BANK.music.length) return; stopMusic(); musicEl = new Audio(rand(BANK.music)); musicEl.loop = true; musicEl.volume = CFG.musicVolume; musicEl.play().catch(() => {}); }
  function stopMusic()  { if (musicEl) { musicEl.pause(); musicEl = null; } }

  function setMuted(m) { muted = !!m; if (muted) stopMusic(); else { ensure(); if (actx && actx.state === 'suspended') actx.resume(); startMusic(); } }
  function setVolume(v) { CFG.volume = v; if (master) master.gain.value = v; }

  return { BANK, CFG, shoot, boom, alarm, startMusic, stopMusic, setMuted, setVolume, isMuted: () => muted };
})();

/* ========================= 3. Asobi UI shell ========================== */

  var FAC = [
    { id:'dominion',   color:'#e74c3c', name:'Resilience Syndicate' },
    { id:'freestates', color:'#3498db', name:'Civic Liberty' },
    { id:'helix',      color:'#9b59b6', name:'Equity Pathfinders' },
    { id:'verdant',    color:'#2ecc71', name:'Verdant Guardians' },
    { id:'solari',     color:'#e67e22', name:'Carbon Freedom' },
    { id:'tidal',      color:'#1abc9c', name:'Hearth Council' },
  ];
  var ROSTER = ['rifleman','scout','support','medic','heavy','engineer','shield','apc','tank','spawner'];
  var EFFECTS = [['heal','💚 Heal all'],['repair','🔧 Repair all'],['orbital','☄️ Orbital'],['orb','🛡️ Shield orb'],['cruiser','🛸 Battlecruiser']];
  var TARGETED = { orbital:1, orb:1 };            // placed by clicking the map
  var DAY_MODES = ['shift','day','night'], DAY_LABEL = { shift:'🌗 Shift', day:'☀️ Day', night:'🌙 Night' };
  var EVENT_DEFS = [['wildlife','🦖 Wildlife'],['stampede','🦏 Stampede'],['meteor','☄️ Meteors'],['merc','☠ Mercs'],['carrier','🛸 Merc carrier'],['pizza','🍕 Pizza'],['pirate','🚢 Pirate'],['alien','👾 Alien'],['clown','🤡 Clown']];
  var LS_KEY = 'asobi.pentarch';

  var CSS = [
    '.pt-wrap { display:flex; flex-direction:column; height:calc(100vh - var(--nav-h) - 50px); min-height:480px; font-size:14px; }',
    '.pt-top { display:flex; align-items:center; gap:12px; padding:8px 16px; border-bottom:1px solid var(--border); background:var(--bg-header); flex:0 0 auto; flex-wrap:wrap; }',
    '.pt-scores { flex:1; display:flex; align-items:center; justify-content:center; gap:14px; flex-wrap:wrap; min-width:200px; }',
    '.pt-scores .s { font-weight:800; font-size:14px; font-variant-numeric:tabular-nums; cursor:pointer; white-space:nowrap; }',
    '.pt-clockchip { background:var(--card); border:1px solid var(--border); border-radius:6px; padding:3px 10px; font-weight:700; font-family:var(--mono); font-size:.8rem; white-space:nowrap; }',
    '.pt-terrain { color:var(--text-sec); font-size:12px; min-width:64px; text-align:right; font-family:var(--mono); }',
    '.pt-layout { display:flex; gap:12px; padding:12px; align-items:stretch; flex:1 1 auto; min-height:0; }',
    '.pt-arena { position:relative; flex:1 1 auto; min-width:300px; display:flex; align-items:center; justify-content:center; min-height:0; }',
    '.pt-arena canvas { max-width:100%; max-height:100%; display:block; border:1px solid var(--border); border-radius:10px; background:#16212e; cursor:crosshair; }',
    '.pt-alert { position:absolute; top:10px; left:10px; display:none; z-index:5; padding:7px 14px; border-radius:8px; background:rgba(180,20,28,.92); border:1px solid #ff6a5a; color:#fff; font-weight:800; letter-spacing:1px; font-size:13px; box-shadow:0 0 16px rgba(255,60,50,.6); animation:ptAlertFlash .7s steps(1) infinite; pointer-events:none; }',
    '.pt-alert.show { display:block; }',
    '@keyframes ptAlertFlash { 0%{opacity:1} 50%{opacity:.45} 100%{opacity:1} }',
    '.pt-overlay { position:absolute; inset:0; display:none; align-items:center; justify-content:center; background:rgba(5,5,5,.8); border-radius:10px; z-index:6; }',
    '.pt-overlay h1 { font-family:var(--display); font-size:26px; margin:0 0 14px; }',
    '.pt-overlay button { padding:9px 18px; border:1px solid var(--accent); border-radius:9px; background:var(--accent); color:#1a1205; font-weight:700; cursor:pointer; font-size:14px; font-family:inherit; }',
    '.pt-side { flex:0 0 240px; display:flex; flex-direction:column; gap:8px; min-height:0; overflow-y:auto; overflow-x:hidden; padding-right:3px; }',
    '.pt-side::-webkit-scrollbar { width:7px; } .pt-side::-webkit-scrollbar-thumb { background:var(--border); border-radius:4px; } .pt-side::-webkit-scrollbar-track { background:transparent; }',
    '.pt-card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:8px 10px; flex:0 0 auto; }',
    '.pt-lbl { font-family:var(--mono); font-size:.62rem; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); margin-bottom:6px; }',
    '.pt-chips { display:flex; gap:5px; flex-wrap:wrap; }',
    '.pt-chip { padding:5px 9px; border:1px solid var(--border); border-radius:8px; background:var(--card); color:var(--text); font-weight:700; cursor:pointer; font-size:12px; user-select:none; font-family:inherit; }',
    '.pt-chip:hover { border-color:var(--accent); }',
    '.pt-chip.on { border-color:var(--accent); color:var(--accent); }',
    '.pt-tog.off { opacity:.4; text-decoration:line-through; color:var(--text-muted); }',
    '.pt-sound.off { opacity:.5; }',
    '.pt-eff { display:flex; align-items:center; gap:8px; width:100%; margin-bottom:4px; padding:5px 9px; border:1px solid var(--border); border-radius:8px; background:var(--card); cursor:pointer; font-size:12px; font-weight:700; }',
    '.pt-eff:last-child { margin-bottom:0; } .pt-eff:hover:not(.dis) { border-color:var(--accent); }',
    '.pt-eff.on { border-color:#ff5a4a; box-shadow:0 0 0 1px #ff5a4a inset; }',
    '.pt-eff.dis { opacity:.4; cursor:not-allowed; } .pt-eff .c { margin-left:auto; color:var(--accent); font-family:var(--mono); }',
    '.pt-vcard { display:flex; align-items:center; gap:9px; width:100%; margin-bottom:6px; padding:7px 9px; border:1px solid var(--border); border-radius:10px; background:linear-gradient(180deg,var(--elev),var(--card)); cursor:pointer; transition:.12s; }',
    '.pt-vcard:last-child { margin-bottom:0; } .pt-vcard:hover:not(.dis) { border-color:var(--accent); }',
    '.pt-vcard.dis { opacity:.4; cursor:not-allowed; }',
    '.pt-vcard .em { font-size:22px; } .pt-vcard .meta { flex:1; } .pt-vcard .nm { font-weight:700; font-size:12.5px; }',
    '.pt-vcard .st { color:var(--text-sec); font-size:10px; } .pt-vcard .cnt { font-weight:800; font-size:14px; color:var(--accent); font-family:var(--mono); }',
    '.pt-btn { width:100%; margin-top:7px; padding:9px; border:1px solid var(--border); border-radius:9px; background:var(--card); color:var(--text); font-weight:700; cursor:pointer; font-size:13px; font-family:inherit; }',
    '.pt-btn:hover { border-color:var(--accent); color:var(--accent); background:var(--accent-faint); }',
    '.pt-seedrow { display:flex; gap:6px; }',
    '.pt-seed { flex:1; min-width:0; background:var(--card); border:1px solid var(--border); border-radius:8px; color:var(--text); font-family:var(--mono); font-size:12px; padding:5px 8px; }',
    '.pt-seed:focus { outline:none; border-color:var(--accent); }',
    '.pt-vmode { cursor:pointer; float:right; color:var(--accent); letter-spacing:0; text-transform:none; }',
    '.pt-help { font-size:10.5px; line-height:1.45; color:var(--text-muted); }',
    '.pt-help b { color:var(--text); }',
    '@media (max-width: 900px) { .pt-wrap { height:auto; min-height:calc(100vh - var(--nav-h) - 50px); } .pt-layout { flex-direction:column; } .pt-arena { min-height:300px; } .pt-side { flex:0 0 auto; width:100%; } }',
  ].join('\n');

  var TEMPLATE = [
    '<div class="pt-wrap">',
    '  <header class="pt-top">',
    '    <div class="pt-scores"></div>',
    '    <span class="pt-clockchip pt-tod" title="time of day">☀️ Day</span>',
    '    <span class="pt-clockchip pt-clock">1:00</span>',
    '    <span class="pt-terrain">—</span>',
    '  </header>',
    '  <div class="pt-layout">',
    '    <div class="pt-arena"><canvas width="920" height="520"></canvas><div class="pt-alert"></div><div class="pt-overlay"></div></div>',
    '    <div class="pt-side">',
    '      <div class="pt-card"><div class="pt-lbl">Factions</div><div class="pt-chips pt-facChips"></div></div>',
    '      <div class="pt-card"><div class="pt-lbl">Battle length</div><div class="pt-chips pt-durChips"></div></div>',
    '      <div class="pt-card"><div class="pt-lbl">Seed (deterministic)</div><div class="pt-seedrow"><input class="pt-seed" inputmode="numeric" spellcheck="false" title="same seed + same settings = same battle"><button class="pt-chip" data-act="reseed" title="new random seed">🎲</button></div></div>',
    '      <div class="pt-card"><div class="pt-lbl">Battle effects · <span class="pt-pts">0</span> pts</div><div class="pt-effbar"></div></div>',
    '      <div class="pt-card"><div class="pt-lbl">Vehicles <span class="pt-vmode" data-act="vmode">limited ⇄</span></div><div class="pt-vehbar"></div></div>',
    '      <div class="pt-card"><div class="pt-lbl">Roster (tap to disable)</div><div class="pt-chips pt-rosterChips"></div></div>',
    '      <div class="pt-card"><div class="pt-lbl">Map events</div><div class="pt-chips pt-eventChips"></div></div>',
    '      <div class="pt-card">',
    '        <div class="pt-chips">',
    '          <span class="pt-chip pt-tog pt-boost" data-act="boosts">⚡ Boosts</span>',
    '          <span class="pt-chip pt-tog pt-shield" data-act="shields">🛡️ Shields</span>',
    '          <span class="pt-chip pt-day" data-act="daymode">🌗 Shift</span>',
    '          <span class="pt-chip pt-sound off" data-act="sound">🔊 Sound</span>',
    '        </div>',
    '        <button class="pt-btn" data-act="restart">Restart ⟳</button>',
    '      </div>',
    '      <div class="pt-card pt-help">Capture a flag&#39;s <b>generator</b> (the separate circle) to own the flag, then hold the flag to score. Infantry reinforce automatically; time vehicles from the reserve. Spend battle points on effects. Pick a faction to command or 👁 watch all-AI. Same seed + same settings = the same battle.</div>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('\n');

  function injectCss() {
    if (document.getElementById('pentarch-css')) return;
    var st = document.createElement('style');
    st.id = 'pentarch-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  function init(container) {
    injectCss();
    container.innerHTML = TEMPLATE;
    var root = container.firstElementChild;
    var $ = function (s) { return root.querySelector(s); };
    var cv = $('canvas'), ctx = cv.getContext('2d');
    var arena = $('.pt-arena'), seedInput = $('.pt-seed');

    var cfg = { nFac: 2, duration: 60, vehInfinite: false, boosts: true, spawnShields: true, dayMode: 'shift', controlled: 'dominion',
      disabled: new Set(),
      events: { wildlife:false, stampede:false, meteor:false, merc:false, carrier:false, pizza:false, pirate:false, alien:false, clown:false } };
    var sim = null, me = null, armedAb = null, vehSig = '', effSig = '', wasOver = false, lastArenaW = 0;
    var running = true, raf = 0, last = 0, acc = 0, lastShoot = 0;

    function save() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign({}, cfg,
        { duration: isFinite(cfg.duration) ? cfg.duration : 'inf', disabled: Array.from(cfg.disabled) }))); } catch (e) {}
    }
    function load() {
      try {
        var o = JSON.parse(localStorage.getItem(LS_KEY)); if (!o) return;
        cfg.nFac = o.nFac || 2;
        cfg.duration = o.duration === 'inf' ? Infinity : (o.duration != null ? o.duration : 60);
        cfg.vehInfinite = !!o.vehInfinite; cfg.boosts = o.boosts !== false; cfg.spawnShields = o.spawnShields !== false;
        cfg.dayMode = DAY_MODES.indexOf(o.dayMode) >= 0 ? o.dayMode : 'shift';
        cfg.controlled = o.controlled === undefined ? 'dominion' : o.controlled;
        cfg.disabled = new Set(o.disabled || []);
        if (o.events) EVENT_DEFS.forEach(function (d) { cfg.events[d[0]] = !!o.events[d[0]]; });
      } catch (e) {}
    }

    function fit() {   // fit the canvas to BOTH available width and height, keeping the world's aspect
      var availW = arena.clientWidth || 600; lastArenaW = availW;
      var availH = Math.max(240, arena.clientHeight || 300);
      var dispW = availW, dispH = dispW * Battle.H / Battle.W;
      if (dispH > availH) { dispH = availH; dispW = dispH * Battle.W / Battle.H; }
      cv.style.width = dispW + 'px'; cv.style.height = dispH + 'px';
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.max(2, Math.round(dispW * dpr)); cv.height = Math.max(2, Math.round(dispH * dpr));
    }

    function restart() {
      armedAb = null;
      var sides = FAC.slice(0, cfg.nFac), ids = sides.map(function (s) { return s.id; });
      if (cfg.controlled !== null && ids.indexOf(cfg.controlled) < 0) cfg.controlled = ids[0];
      me = cfg.controlled;
      var seed = parseInt(seedInput.value, 10);
      if (!Number.isFinite(seed)) { seed = Math.floor(Math.random() * 1e9); seedInput.value = seed; }
      var army = ROSTER.map(function (k) { return { key: k }; });   // full roster; `allowed` gates who spawns (live)
      var allowed = ROSTER.filter(function (k) { return !cfg.disabled.has(k); });
      var armies = {}; ids.forEach(function (id) { armies[id] = army; });
      var viewW = arena.clientWidth || 900, viewH = Math.max(240, arena.clientHeight || 520);
      sim = Battle.init({ sides: sides, controlled: cfg.controlled, seed: seed, emit: true, viewW: viewW, viewH: viewH,
        duration: cfg.duration, vehInfinite: cfg.vehInfinite, boosts: cfg.boosts, spawnShields: cfg.spawnShields,
        dayMode: cfg.dayMode, eventCfg: cfg.events, allowed: allowed.length ? allowed : ['rifleman'], armies: armies });
      wasOver = false; effSig = ''; vehSig = '';
      var ov = $('.pt-overlay'); ov.style.display = 'none'; ov.innerHTML = '';
      buildScores(); save(); buildControls(); buildBar(); buildEffects(true); fit();
    }

    /* live config — applied to the running sim, no restart (except faction count) */
    function setControl(id) { cfg.controlled = id; me = id; if (sim) sim.controlled = id; save(); buildScores(); buildBar(); buildEffects(true); }
    function setDur(v) { cfg.duration = v; if (sim) sim.duration = v; save(); buildControls(); }
    function toggleBoosts() { cfg.boosts = !cfg.boosts; if (sim) sim.boosts = cfg.boosts; save(); buildControls(); }
    function toggleShields() {   // add/remove the immortal spawn shields on the live sim
      cfg.spawnShields = !cfg.spawnShields; save();
      if (sim) {
        if (cfg.spawnShields) sim.sides.forEach(function (f) {
          if (!sim.orbs.some(function (o) { return o.immortal && o.f === f; })) {
            var a = sim.anchor[f];
            sim.orbs.push({ x: a.x, y: a.y, r: Battle.CFG.spawnR, hp: Infinity, maxHp: Infinity, f: f, immortal: true });
          }
        });
        else sim.orbs = sim.orbs.filter(function (o) { return !o.immortal; });
      }
      buildControls();
    }
    function cycleDayMode() { cfg.dayMode = DAY_MODES[(DAY_MODES.indexOf(cfg.dayMode) + 1) % DAY_MODES.length]; if (sim) sim.dayMode = cfg.dayMode; save(); buildControls(); }
    function toggleEvent(k) { cfg.events[k] = !cfg.events[k]; if (sim) sim.eventCfg[k] = cfg.events[k]; save(); buildControls(); }
    function toggleUnit(k) {
      cfg.disabled.has(k) ? cfg.disabled.delete(k) : cfg.disabled.add(k);
      if (sim) sim.allowed = new Set(ROSTER.filter(function (x) { return !cfg.disabled.has(x); }));
      save(); buildControls(); buildBar();
    }
    function setVMode() { cfg.vehInfinite = !cfg.vehInfinite; if (sim) sim.vehInfinite = cfg.vehInfinite; save(); buildControls(); buildBar(); }
    function toggleSound() { Sound.setMuted(!Sound.isMuted()); $('.pt-sound').classList.toggle('off', Sound.isMuted()); }

    function buildControls() {
      $('.pt-facChips').innerHTML = [2, 3, 4, 5, 6].map(function (n) {
        return '<span class="pt-chip ' + (cfg.nFac === n ? 'on' : '') + '" data-act="fac" data-val="' + n + '">' + n + '</span>'; }).join('');
      $('.pt-durChips').innerHTML = [['30s', 30], ['60s', 60], ['90s', 90], ['∞', 'inf']].map(function (d) {
        var val = d[1] === 'inf' ? Infinity : d[1];
        return '<span class="pt-chip ' + (cfg.duration === val ? 'on' : '') + '" data-act="dur" data-val="' + d[1] + '">' + d[0] + '</span>'; }).join('');
      $('.pt-rosterChips').innerHTML = ROSTER.map(function (k) {
        return '<span class="pt-chip pt-tog ' + (cfg.disabled.has(k) ? 'off' : '') + '" data-act="unit" data-val="' + k + '">' +
          Battle.UNITS[k].art + ' ' + Battle.UNITS[k].name + '</span>'; }).join('');
      $('.pt-vmode').textContent = (cfg.vehInfinite ? 'infinite' : 'limited') + ' ⇄';
      $('.pt-boost').classList.toggle('off', !cfg.boosts);
      $('.pt-shield').classList.toggle('off', !cfg.spawnShields);
      $('.pt-day').textContent = DAY_LABEL[cfg.dayMode];
      $('.pt-eventChips').innerHTML = EVENT_DEFS.map(function (d) {
        return '<span class="pt-chip pt-tog ' + (cfg.events[d[0]] ? '' : 'off') + '" data-act="event" data-val="' + d[0] + '">' + d[1] + '</span>'; }).join('');
    }

    // build the clickable score bar once; hud() only updates the numbers so clicks aren't eaten
    function buildScores() {
      $('.pt-scores').innerHTML = sim.sides.map(function (f) {
        var on = cfg.controlled === f;
        return '<span class="s" data-act="ctl" data-val="' + f + '" style="color:' + sim.color[f] + ';' +
          (on ? 'text-decoration:underline;text-underline-offset:3px' : 'opacity:.8') + '" title="command this faction">' +
          (on ? '▸ ' : '') + sim.name[f] + ' <span data-sc="' + f + '">0</span></span>';
      }).join('') + '<span class="s" data-act="ctl" data-val="null" style="color:var(--text-sec);' +
        (cfg.controlled === null ? 'text-decoration:underline;text-underline-offset:3px' : 'opacity:.7') + '" title="spectate">👁 Watch</span>';
    }

    function buildEffects(force) {   // rebuild ONLY when affordability/arm/control changes (so clicks aren't eaten)
      var pts = (me && sim) ? Math.floor(sim.score[me]) : 0;
      $('.pt-pts').textContent = pts;
      var sig = EFFECTS.map(function (d) { return pts >= Battle.ABILITIES[d[0]] ? '1' : '0'; }).join('') + '|' + armedAb + '|' + me;
      if (!force && sig === effSig) return;
      effSig = sig;
      $('.pt-effbar').innerHTML = !me ? '<div class="pt-eff dis">👁 Watching — no effects</div>' : EFFECTS.map(function (d) {
        var kind = d[0], cost = Battle.ABILITIES[kind], usable = pts >= cost;
        return '<div class="pt-eff ' + (usable ? '' : 'dis') + ' ' + (armedAb === kind ? 'on' : '') + '" data-act="eff" data-val="' + kind + '">' +
          d[1] + '<span class="c">' + cost + '</span></div>';
      }).join('');
    }
    function effClick(kind) {
      if (!me) return;
      if (TARGETED[kind]) armedAb = (armedAb === kind ? null : kind);   // arm, then click a target on the map
      else { Battle.ability(sim, me, kind); armedAb = null; }           // heal / repair / cruiser fire immediately
      buildEffects(true);
    }

    // clicking a vehicle card deploys it immediately into a random spot in your spawn circle
    function armVeh(k) {
      if (!sim || !me) return;
      var a = sim.anchor[me], ang = Math.random() * Math.PI * 2, rad = Math.sqrt(Math.random()) * Battle.CFG.spawnR * 0.7;
      Battle.deployVehicle(sim, me, a.x + Math.cos(ang) * rad, a.y + Math.sin(ang) * rad, k); buildBar();
    }
    function buildBar() {
      var st = (sim && me) ? Battle.vehStatus(sim, me) : [];
      $('.pt-vehbar').innerHTML = !me ? '<div class="pt-vcard dis"><span class="st" style="padding:4px">👁 Watching</span></div>'
        : st.length ? st.map(function (v) {
            var d = Battle.UNITS[v.key], right = v.inf ? (v.ready ? '∞' : '⏳') : '×' + v.count, usable = v.inf ? v.ready : v.count > 0;
            return '<div class="pt-vcard ' + (usable ? '' : 'dis') + '" data-act="veh" data-val="' + v.key + '">' +
              '<span class="em">' + d.art + '</span><span class="meta"><div class="nm">' + d.name + '</div>' +
              '<div class="st">HP ' + d.hp + ' · DMG ' + d.dmg + '</div></span><span class="cnt">' + right + '</span></div>';
          }).join('') : '<div class="pt-vcard dis"><span class="st" style="padding:4px">No vehicles enabled</span></div>';
    }

    function hud() {
      sim.sides.forEach(function (f) { var el = root.querySelector('[data-sc="' + f + '"]'); if (el) el.textContent = Math.floor(sim.score[f]); });
      $('.pt-clock').textContent = isFinite(sim.duration)
        ? '0:' + String(Math.floor(Math.max(0, sim.duration - sim.t))).padStart(2, '0')
        : '∞ ' + Math.floor(sim.t / 60) + ':' + String(Math.floor(sim.t % 60)).padStart(2, '0');
      $('.pt-terrain').textContent = sim.terrain.name;
      var night = sim.dayMode === 'night' || (sim.dayMode === 'shift' && Math.floor(sim.t / 60) % 2 === 1);
      $('.pt-tod').textContent = night ? '🌙 Night' : '☀️ Day';
      if (sim.over && !wasOver) {   // set the overlay ONCE so the button isn't rebuilt under the cursor
        wasOver = true; var ov = $('.pt-overlay'); ov.style.display = 'flex'; var w = sim.winner;
        ov.innerHTML = '<div style="text-align:center"><h1 style="color:' + (w ? sim.color[w] : '#fff') + '">' +
          (w ? sim.name[w] + ' wins!' : 'Stalemate') + '</h1><button data-act="restart">Fight again</button></div>';
      }
    }
    function showAlert() {   // red-alert banner while a map event is active
      var el = $('.pt-alert'), on = sim.alert && sim.t < sim.alert.until;
      el.classList.toggle('show', !!on); if (on) el.textContent = sim.alert.label;
    }

    function onClick(e) {
      var el = e.target.closest('[data-act]');
      if (!el || el.classList.contains('dis')) return;
      var v = el.dataset.val;
      switch (el.dataset.act) {
        case 'fac':     cfg.nFac = +v; restart(); break;
        case 'dur':     setDur(v === 'inf' ? Infinity : +v); break;
        case 'ctl':     setControl(v === 'null' ? null : v); break;
        case 'eff':     effClick(v); break;
        case 'veh':     armVeh(v); break;
        case 'unit':    toggleUnit(v); break;
        case 'event':   toggleEvent(v); break;
        case 'boosts':  toggleBoosts(); break;
        case 'shields': toggleShields(); break;
        case 'daymode': cycleDayMode(); break;
        case 'sound':   toggleSound(); break;
        case 'vmode':   setVMode(); break;
        case 'restart': restart(); break;
        case 'reseed':  seedInput.value = ''; restart(); break;
      }
    }
    root.addEventListener('click', onClick);
    seedInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') restart(); });
    cv.addEventListener('click', function (e) {   // map clicks place armed orbital / shield-orb targets
      if (!sim || sim.over || !me || !armedAb) return;
      var r = cv.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width * Battle.W, y = (e.clientY - r.top) / r.height * Battle.H;
      if (Battle.ability(sim, me, armedAb, x, y)) { armedAb = null; buildEffects(true); }
    });
    window.addEventListener('resize', fit);

    function loop(ts) {
      if (!running) return;
      if (!last) last = ts;
      var dt = (ts - last) / 1000; last = ts; if (dt > 0.1) dt = 0.1;
      acc += dt; while (acc >= 1 / 60) { Battle.step(sim, 1 / 60); acc -= 1 / 60; }
      if (Math.abs(arena.clientWidth - lastArenaW) > 2) fit();   // re-fit if layout reflowed
      var sc = cv.width / Battle.W; ctx.setTransform(sc, 0, 0, sc, 0, 0); Battle.draw(ctx, sim); ctx.setTransform(1, 0, 0, 1, 0, 0);
      hud();
      if (!Sound.isMuted() && sim.events.length) {
        var booms = 0;
        sim.events.forEach(function (ev) { if (ev.t === 'boom' && booms < 3) { Sound.boom(ev.big); booms++; } });
        if (sim.events.some(function (e) { return e.t === 'alarm'; })) Sound.alarm();
        if (ts - lastShoot > 70) {
          var sh = sim.events.filter(function (e) { return e.t === 'shoot'; });
          if (sh.length) { Sound.shoot(sh[Math.floor(Math.random() * sh.length)].k); lastShoot = ts; }
        }
      }
      sim.events.length = 0;
      showAlert();
      var sig = JSON.stringify(me ? Battle.vehStatus(sim, me) : []);
      if (sig !== vehSig) { vehSig = sig; buildBar(); }
      buildEffects();   // cheap: early-returns unless affordability changed
      raf = requestAnimationFrame(loop);
    }

    load();
    $('.pt-sound').classList.toggle('off', Sound.isMuted());
    restart();
    raf = requestAnimationFrame(loop);

    return function destroy() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
      Sound.stopMusic();
      Sound.setMuted(true);   // next mount starts silent again (autoplay-safe)
    };
  }

  /* ------------------------- registration ------------------------- */
  if (typeof window !== "undefined") {
    window.GAMES = window.GAMES || {};
    window.GAMES.pentarch = {
    title: "Pentarch Battle", jp: "戦",
    blurb: "PENTARCH's deterministic auto-battler. Command a faction — or watch the AIs fight for the flags.",
    tag: "auto-battler · seeded · 2–6 factions",
      hue: "#d1442f", glow: "rgba(209,68,47,0.20)",
      init: init,
      engine: Battle   // exposed for headless tests: Battle.resolve({seed}) is deterministic
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { Battle: Battle, Sound: Sound };
})();
