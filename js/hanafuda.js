/* =====================================================================
   Carino Asobi — Hanafuda Koi-Koi (花札・こいこい)
   ---------------------------------------------------------------------
   Self-contained module: a pure, node-testable CORE (deck construction,
   month matching, yaku scoring, a headless AI simulator) plus a DOM UI
   that mounts into a container via window.GAMES.hanafuda.init(container).

   No external libraries, no build step. Browser JS + node-testable core.

   RULESET (documented):
   ---------------------------------------------------------------------
   Deck: 48 cards, 12 months × 4 (bright 光 / animal 種 / ribbon 短冊 /
   chaff カス). Composition: 5 brights, 9 animals, 10 ribbons, 24 chaff.

   Deal: shuffle 48; 8 cards to each player's hand, 8 face-up to the
   shared field, the remaining 24 form the stock (draw pile).
   NOTE: 8 + 8 + 8 = 24 dealt, so 48 − 24 = 24 remain in the stock.
   (The brief mentioned "32" — that is an arithmetic slip; the standard
   Koi-Koi deal leaves 24 in the stock, which is what we implement.)
   If any hand or the field is dealt all four cards of a single month
   (extremely rare), we simply reshuffle and re-deal — noted here.

   A turn (the active player):
     1. Play one hand card. If its MONTH matches field card(s), capture:
        the played card + a matching field card go to your captured pile.
        - 1 match  → capture it.
        - 2 matches→ you choose which field card to take.
        - 3 matches→ all four of that month are in play; take all three
          (a common house rule; noted).
        No match → the played card is laid onto the field.
     2. Draw the top stock card and reveal it, then resolve captures the
        same way (0 → lay on field, 1 → capture, 2 → choose, 3 → take all).
     3. Recompute your yaku. If you formed at least one NEW yaku (your
        total increased), decide: STOP (あがり) to end the round & score,
        or KOI-KOI (こいこい) to keep playing for more at higher risk.

   Round ends when a player Stops (they score) OR both hands are exhausted
   with no stop → the round is a draw worth 0 (the dealer keeps the deal —
   noted). Otherwise the deal alternates each round.

   Scoring on Stop (documented multiplier variant):
     base = sum of the winner's yaku points.
     if base ≥ 7  → ×2   (the "7-point" / nanaten rule)
     if the winner called Koi-Koi at least once this round → ×2
     (the two multipliers combine, e.g. base 8 with a koi call = 8×2×2=32)
   The loser scores 0 for the round.

   YAKU implemented (standard Koi-Koi set):
     Gokō 五光 (5 brights) = 10
     Shikō 四光 (4 brights, no rain bright) = 8
     Ame-Shikō 雨四光 (4 brights incl. rain) = 7
     Sankō 三光 (3 brights, no rain bright) = 5
     Ino-Shika-Chō 猪鹿蝶 (boar+deer+butterfly) = 5
     Tane 種 (≥5 animals) = 1, +1 per extra animal
     Akatan 赤短 (3 red poetry ribbons, m1/2/3) = 5
     Aotan 青短 (3 blue ribbons, m6/9/10) = 5
     Tan 短 (≥5 ribbons) = 1, +1 per extra ribbon
     Kasu カス (≥10 chaff) = 1, +1 per extra chaff
     Tsukimi-zake 月見酒 (full moon [m8 bright] + sake cup) = 5
     Hanami-zake 花見酒 (cherry curtain [m3 bright] + sake cup) = 5
   The sake cup (m9) counts as an animal for Tane and enables the -zake
   yaku. Akatan / Aotan / Tan STACK (all 6 special ribbons = 5+5+2=12).
   ===================================================================== */

(function () {
  "use strict";

  /* =================================================================
     CORE — deck
     ================================================================= */

  // Per-month flower metadata: kanji, emoji, english name.
  var MONTHS = [
    null,
    { f: "松",   fe: "🌲", fn: "Pine" },
    { f: "梅",   fe: "🌸", fn: "Plum" },
    { f: "桜",   fe: "🌸", fn: "Cherry" },
    { f: "藤",   fe: "🌸", fn: "Wisteria" },
    { f: "菖蒲", fe: "🪻", fn: "Iris" },
    { f: "牡丹", fe: "🌺", fn: "Peony" },
    { f: "萩",   fe: "🌿", fn: "Bush Clover" },
    { f: "芒",   fe: "🌾", fn: "Pampas" },
    { f: "菊",   fe: "🌼", fn: "Chrysanthemum" },
    { f: "紅葉", fe: "🍁", fn: "Maple" },
    { f: "柳",   fe: "🍃", fn: "Willow" },
    { f: "桐",   fe: "🌳", fn: "Paulownia" }
  ];

  function mkCard(month, type, name, jp, emblem, flags) {
    var m = MONTHS[month];
    var c = {
      id: "",
      month: month,
      type: type,          // 'bright' | 'animal' | 'ribbon' | 'chaff'
      name: name,
      jp: jp,
      emblem: emblem,
      flower: m.f,
      flowerEmoji: m.fe,
      flowerName: m.fn,
      poetry: false,       // red poetry ribbon (months 1/2/3)
      blueRibbon: false,   // blue ribbon (months 6/9/10)
      rain: false,         // month-11 "rain" bright (Michikaze)
      sake: false          // month-9 sake cup
    };
    if (flags) for (var k in flags) c[k] = flags[k];
    return c;
  }

  // Build the canonical 48-card deck. Order is deterministic; ids assigned.
  function buildDeck() {
    var d = [];
    var chaff = function (month) {
      return mkCard(month, "chaff", MONTHS[month].fn + " Chaff",
        MONTHS[month].f + "のカス", "🎴");
    };

    // Month 1 — Pine 松
    d.push(mkCard(1, "bright", "Crane & Sun", "松に鶴", "🕊️"));
    d.push(mkCard(1, "ribbon", "Poetry Ribbon", "赤短", "🎋", { poetry: true }));
    d.push(chaff(1)); d.push(chaff(1));

    // Month 2 — Plum 梅
    d.push(mkCard(2, "animal", "Bush Warbler", "梅に鶯", "🐦"));
    d.push(mkCard(2, "ribbon", "Poetry Ribbon", "赤短", "🎋", { poetry: true }));
    d.push(chaff(2)); d.push(chaff(2));

    // Month 3 — Cherry 桜
    d.push(mkCard(3, "bright", "Camp Curtain", "桜に幕", "🎏"));
    d.push(mkCard(3, "ribbon", "Poetry Ribbon", "赤短", "🎋", { poetry: true }));
    d.push(chaff(3)); d.push(chaff(3));

    // Month 4 — Wisteria 藤
    d.push(mkCard(4, "animal", "Cuckoo", "藤に杜鵑", "🐦"));
    d.push(mkCard(4, "ribbon", "Red Ribbon", "短冊", "🎋"));
    d.push(chaff(4)); d.push(chaff(4));

    // Month 5 — Iris 菖蒲
    d.push(mkCard(5, "animal", "Eight-plank Bridge", "菖蒲に八橋", "🌉"));
    d.push(mkCard(5, "ribbon", "Red Ribbon", "短冊", "🎋"));
    d.push(chaff(5)); d.push(chaff(5));

    // Month 6 — Peony 牡丹
    d.push(mkCard(6, "animal", "Butterflies", "牡丹に蝶", "🦋"));
    d.push(mkCard(6, "ribbon", "Blue Ribbon", "青短", "🎋", { blueRibbon: true }));
    d.push(chaff(6)); d.push(chaff(6));

    // Month 7 — Bush Clover 萩
    d.push(mkCard(7, "animal", "Boar", "萩に猪", "🐗"));
    d.push(mkCard(7, "ribbon", "Red Ribbon", "短冊", "🎋"));
    d.push(chaff(7)); d.push(chaff(7));

    // Month 8 — Pampas 芒
    d.push(mkCard(8, "bright", "Full Moon", "芒に月", "🌕"));
    d.push(mkCard(8, "animal", "Geese", "芒に雁", "🦢"));
    d.push(chaff(8)); d.push(chaff(8));

    // Month 9 — Chrysanthemum 菊
    d.push(mkCard(9, "animal", "Sake Cup", "菊に盃", "🍶", { sake: true }));
    d.push(mkCard(9, "ribbon", "Blue Ribbon", "青短", "🎋", { blueRibbon: true }));
    d.push(chaff(9)); d.push(chaff(9));

    // Month 10 — Maple 紅葉
    d.push(mkCard(10, "animal", "Deer", "紅葉に鹿", "🦌"));
    d.push(mkCard(10, "ribbon", "Blue Ribbon", "青短", "🎋", { blueRibbon: true }));
    d.push(chaff(10)); d.push(chaff(10));

    // Month 11 — Willow 柳
    d.push(mkCard(11, "bright", "Rainman", "柳に小野道風", "☔", { rain: true }));
    d.push(mkCard(11, "animal", "Swallow", "柳に燕", "🐤"));
    d.push(mkCard(11, "ribbon", "Red Ribbon", "短冊", "🎋"));
    d.push(mkCard(11, "chaff", "Lightning", "柳のカス", "⚡"));

    // Month 12 — Paulownia 桐
    d.push(mkCard(12, "bright", "Phoenix", "桐に鳳凰", "🦅"));
    d.push(chaff(12)); d.push(chaff(12)); d.push(chaff(12));

    for (var i = 0; i < d.length; i++) d[i].id = "c" + i;
    return d;
  }

  // Seedable RNG (mulberry32) for deterministic node simulation.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fisher-Yates shuffle (returns a new array), rng() -> [0,1).
  function shuffle(deck, rng) {
    var a = deck.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* =================================================================
     CORE — yaku scoring
     ================================================================= */

  function Y(key, name, jp, pts) { return { key: key, name: name, jp: jp, pts: pts }; }

  // Score a captured pile. Returns { list:[{key,name,jp,pts}], total }.
  function scoreYaku(captured) {
    var brights = [], animals = [], ribbons = [], chaff = [];
    var hasRain = false, hasSake = false, hasMoon = false, hasCherry = false;
    var boar = false, deer = false, butterfly = false;
    var poetry = 0, blue = 0;

    for (var i = 0; i < captured.length; i++) {
      var c = captured[i];
      if (c.type === "bright") {
        brights.push(c);
        if (c.rain) hasRain = true;
        if (c.month === 8) hasMoon = true;
        if (c.month === 3) hasCherry = true;
      } else if (c.type === "animal") {
        animals.push(c);
        if (c.sake) hasSake = true;
        if (c.month === 7) boar = true;
        if (c.month === 10) deer = true;
        if (c.month === 6) butterfly = true;
      } else if (c.type === "ribbon") {
        ribbons.push(c);
        if (c.poetry) poetry++;
        if (c.blueRibbon) blue++;
      } else {
        chaff.push(c);
      }
    }

    var out = [];
    var nb = brights.length;

    // Brights
    if (nb === 5) out.push(Y("goko", "Gokō", "五光", 10));
    else if (nb === 4) out.push(hasRain ? Y("ameshiko", "Ame-Shikō", "雨四光", 7)
                                        : Y("shiko", "Shikō", "四光", 8));
    else if (nb === 3 && !hasRain) out.push(Y("sanko", "Sankō", "三光", 5));

    // Ino-Shika-Chō
    if (boar && deer && butterfly) out.push(Y("inoshikacho", "Ino-Shika-Chō", "猪鹿蝶", 5));

    // Tane (animals)
    if (animals.length >= 5) out.push(Y("tane", "Tane", "タネ", 1 + (animals.length - 5)));

    // Ribbons — stackable
    if (poetry >= 3) out.push(Y("akatan", "Akatan", "赤短", 5));
    if (blue >= 3) out.push(Y("aotan", "Aotan", "青短", 5));
    if (ribbons.length >= 5) out.push(Y("tan", "Tan", "短", 1 + (ribbons.length - 5)));

    // Kasu (chaff)
    if (chaff.length >= 10) out.push(Y("kasu", "Kasu", "カス", 1 + (chaff.length - 10)));

    // Sake combos
    if (hasMoon && hasSake) out.push(Y("tsukimi", "Tsukimi-zake", "月見酒", 5));
    if (hasCherry && hasSake) out.push(Y("hanami", "Hanami-zake", "花見酒", 5));

    var total = 0;
    for (var k = 0; k < out.length; k++) total += out[k].pts;
    return { list: out, total: total };
  }

  // Final round score with the documented multipliers.
  function finalScore(base, koiCalled) {
    var s = base;
    if (base >= 7) s *= 2;
    if (koiCalled) s *= 2;
    return s;
  }

  /* =================================================================
     CORE — AI heuristics & headless engine (also drives node sim)
     ================================================================= */

  // Rough desirability of holding/capturing a card.
  function cardValue(c) {
    if (c.type === "bright") return 20;
    if (c.sake) return 14;
    if (c.type === "animal" && (c.month === 7 || c.month === 10 || c.month === 6)) return 13; // ino-shika-cho trio
    if (c.type === "animal") return 8;
    if (c.poetry || c.blueRibbon) return 10;
    if (c.type === "ribbon") return 6;
    return 2; // chaff
  }

  function monthMatches(card, field) {
    var out = [];
    for (var i = 0; i < field.length; i++) if (field[i].month === card.month) out.push(field[i]);
    return out;
  }

  // Pick the best field card to take from a set of matches (highest value).
  function bestFieldTarget(matches) {
    var best = matches[0];
    for (var i = 1; i < matches.length; i++) if (cardValue(matches[i]) > cardValue(best)) best = matches[i];
    return best;
  }

  // Decide which hand card the AI plays. Returns { i, target } where target
  // is 'all' (3 matches), a specific field card (1-2 matches), or null (lay).
  function aiPlan(state, pl) {
    var hand = state.hands[pl], field = state.field;
    var best = null;
    for (var i = 0; i < hand.length; i++) {
      var card = hand[i];
      var m = monthMatches(card, field);
      var gain, target;
      if (m.length >= 3) { gain = cardValue(card) * 3; target = "all"; }
      else if (m.length >= 1) { var t = bestFieldTarget(m); gain = cardValue(card) + cardValue(t); target = t; }
      else { gain = -cardValue(card) * 0.1; target = null; } // discard: prefer the lowest-value card
      if (!best || gain > best.gain) best = { i: i, target: target, gain: gain, card: card };
    }
    return best;
  }

  // Move a played card + its captured field cards into a player's pile.
  // matches = current field cards sharing the month; target = 'all' | card | null.
  function takeCapture(state, pl, played, matches, target) {
    if (!matches || matches.length === 0) { state.field.push(played); return []; }
    var taken;
    if (target === "all" || matches.length >= 3) taken = matches.slice();
    else taken = [target];
    for (var i = 0; i < taken.length; i++) {
      var idx = state.field.indexOf(taken[i]);
      if (idx >= 0) state.field.splice(idx, 1);
    }
    state.captured[pl].push(played);
    for (var j = 0; j < taken.length; j++) state.captured[pl].push(taken[j]);
    return taken;
  }

  // AI stop/koi-koi decision. Returns true to STOP.
  function aiKoi(state, pl, total, rng, hard) {
    if (total >= 7) return true;                       // bank a big hand
    var oppTotal = state.yakuTotal[1 - pl];
    var handsLeft = state.hands[0].length + state.hands[1].length;
    if (total >= oppTotal && total >= 3) return true;  // comfortable lead
    if (hard && total >= oppTotal + 1) return true;    // hard AI banks leads sooner
    if (handsLeft > 6 && rng() < (hard ? 0.35 : 0.5)) return false; // young round: gamble
    return true;
  }

  function fourSameMonth(cards) {
    var count = {};
    for (var i = 0; i < cards.length; i++) {
      var mth = cards[i].month;
      count[mth] = (count[mth] || 0) + 1;
      if (count[mth] === 4) return true;
    }
    return false;
  }

  // Fresh round state. dealer = 0|1.
  function newRound(rng, dealer) {
    for (var tries = 0; ; tries++) {
      var deck = shuffle(buildDeck(), rng);
      var h0 = deck.slice(0, 8), h1 = deck.slice(8, 16), field = deck.slice(16, 24);
      if (tries < 20 && (fourSameMonth(h0) || fourSameMonth(h1) || fourSameMonth(field))) continue;
      return {
        hands: [h0, h1],
        field: field,
        stock: deck.slice(24),          // 24 cards remain in the stock
        captured: [[], []],
        dealer: dealer,
        koi: [false, false],
        yakuTotal: [0, 0]
      };
    }
  }

  function totalCards(state) {
    return state.hands[0].length + state.hands[1].length + state.field.length +
      state.stock.length + state.captured[0].length + state.captured[1].length;
  }

  // Execute one complete auto-played turn for `pl`. Returns { stopped }.
  function resolveTurnAuto(state, pl, rng, hard) {
    // 1. play a hand card
    var plan = aiPlan(state, pl);
    var card = state.hands[pl].splice(plan.i, 1)[0];
    var matches = monthMatches(card, state.field);
    takeCapture(state, pl, card, matches, plan.target);

    // 2. draw + resolve
    if (state.stock.length) {
      var d = state.stock.pop();
      var dm = monthMatches(d, state.field);
      var dtarget = dm.length >= 3 ? "all" : (dm.length ? bestFieldTarget(dm) : null);
      takeCapture(state, pl, d, dm, dtarget);
    }

    // 3. yaku / stop decision
    var total = scoreYaku(state.captured[pl]).total;
    if (total > state.yakuTotal[pl]) {
      var stop = aiKoi(state, pl, total, rng, hard);
      state.yakuTotal[pl] = total;
      if (stop) return { stopped: true };
      state.koi[pl] = true;
    }
    return { stopped: false };
  }

  // Play a whole match headlessly with both sides auto-playing. Checks
  // card conservation after every turn (throws on violation). For tests.
  function simulateMatch(seed, rounds, hard) {
    rounds = rounds || 6;
    var rng = mulberry32(seed || 1);
    var scores = [0, 0];
    var dealer = 0;
    for (var r = 0; r < rounds; r++) {
      var state = newRound(rng, dealer);
      if (totalCards(state) !== 48) throw new Error("conservation broken at deal: " + totalCards(state));
      var pl = dealer, stopped = null, guard = 0;
      while (state.hands[0].length || state.hands[1].length) {
        if (state.hands[pl].length === 0) { pl = 1 - pl; continue; }
        var res = resolveTurnAuto(state, pl, rng, hard);
        if (totalCards(state) !== 48) throw new Error("conservation broken mid-round: " + totalCards(state));
        if (res.stopped) { stopped = pl; break; }
        pl = 1 - pl;
        if (++guard > 1000) throw new Error("round did not terminate");
      }
      if (stopped !== null) {
        scores[stopped] += finalScore(state.yakuTotal[stopped], state.koi[stopped]);
        dealer = 1 - dealer;          // deal alternates after a decided round
      } // draw → dealer keeps the deal
    }
    return { scores: scores };
  }

  /* =================================================================
     DOM UI
     ================================================================= */

  var CSS = [
    ".hana-root{--hue:var(--vermilion);font-family:var(--sans);color:var(--text);max-width:1180px;margin:0 auto;padding:14px 16px 40px;}",
    ".hana-root *{box-sizing:border-box;}",
    ".hana-top{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:14px;}",
    ".hana-top .grow{flex:1 1 auto;}",
    ".hana-status{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}",
    ".hana-status .badge{border-color:var(--border);}",
    ".hana-status .badge b{color:var(--accent);}",
    ".hana-status .lead{color:var(--hue);}",
    ".hana-msg{font-family:var(--jp);font-size:.95rem;color:var(--text-sec);min-height:1.4em;margin:6px 2px 14px;border-left:3px solid var(--hue);padding-left:10px;}",
    ".hana-board{display:flex;flex-direction:column;gap:14px;}",
    ".hana-zone{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px 14px;}",
    ".hana-zone.field{background:linear-gradient(180deg,#0c0c0c,#0e0e0e);border-color:var(--border-soft);}",
    ".zone-label{font-family:var(--mono);font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;}",
    ".zone-label .who{color:var(--accent);}",
    ".hana-row{display:flex;flex-wrap:wrap;gap:7px;align-items:flex-start;min-height:70px;}",
    ".hana-flexcols{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;}",
    ".hana-flexcols .col{flex:1 1 260px;min-width:220px;}",
    /* card tile */
    ".hana-card{position:relative;width:64px;height:88px;border-radius:9px;border:1.5px solid var(--border);background:var(--card);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:5px 3px 4px;cursor:default;transition:.13s;overflow:hidden;font-family:var(--sans);}",
    ".hana-card .hc-flower{font-family:var(--jp);font-size:.7rem;color:var(--text-sec);line-height:1;}",
    ".hana-card .hc-emblem{font-size:1.65rem;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));}",
    ".hana-card .hc-name{font-size:.5rem;line-height:1.05;text-align:center;color:var(--text-sec);max-width:100%;}",
    ".hana-card .hc-type{font-family:var(--jp);font-size:.55rem;padding:1px 5px;border-radius:999px;border:1px solid var(--border);color:var(--text-muted);}",
    ".hana-card.t-bright{border-color:var(--accent);box-shadow:0 0 0 1px rgba(234,179,8,.25),0 4px 14px var(--accent-glow);}",
    ".hana-card.t-bright .hc-type{color:#1a1205;background:var(--accent);border-color:var(--accent);}",
    ".hana-card.t-animal{border-color:var(--vermilion);}",
    ".hana-card.t-animal .hc-type{color:#fff;background:rgba(209,68,47,.85);border-color:var(--vermilion);}",
    ".hana-card.r-poetry{border-color:#e0554a;} .hana-card.r-poetry .hc-type{color:#fff;background:#c23b2f;border-color:#e0554a;}",
    ".hana-card.r-plain{border-color:#b4726a;} .hana-card.r-plain .hc-type{color:#fff;background:#8a4b44;border-color:#b4726a;}",
    ".hana-card.r-blue{border-color:#4f7bd1;} .hana-card.r-blue .hc-type{color:#fff;background:#37599c;border-color:#4f7bd1;}",
    ".hana-card.t-chaff{border-color:var(--border);opacity:.9;}",
    ".hana-card.clickable{cursor:pointer;}",
    ".hana-card.clickable:hover{transform:translateY(-4px);border-color:var(--accent);box-shadow:0 8px 20px rgba(0,0,0,.5);}",
    ".hana-card.match{outline:2px solid var(--jade);outline-offset:1px;box-shadow:0 0 14px rgba(63,157,109,.5);cursor:pointer;}",
    ".hana-card.sel{transform:translateY(-6px);outline:2px solid var(--accent);outline-offset:1px;}",
    ".hana-card.just{animation:hanaPop .5s ease;}",
    "@keyframes hanaPop{0%{transform:scale(.7);}60%{transform:scale(1.12);}100%{transform:scale(1);}}",
    ".hana-card.back{background:repeating-linear-gradient(45deg,#2a0f0b,#2a0f0b 6px,#331410 6px,#331410 12px);border-color:#4a1c15;cursor:default;}",
    ".hana-card.back .hc-emblem{font-size:1.4rem;opacity:.5;}",
    ".hana-card.mini{width:38px;height:52px;padding:3px 2px;} .hana-card.mini .hc-emblem{font-size:1rem;} .hana-card.mini .hc-name,.hana-card.mini .hc-type{display:none;} .hana-card.mini .hc-flower{font-size:.55rem;}",
    /* captured groups */
    ".cap-groups{display:flex;flex-wrap:wrap;gap:10px;}",
    ".cap-g{border:1px dashed var(--border);border-radius:8px;padding:5px 6px;min-width:56px;}",
    ".cap-g .cap-h{font-family:var(--jp);font-size:.55rem;color:var(--text-muted);margin-bottom:3px;text-align:center;}",
    ".cap-g .cap-cards{display:flex;flex-wrap:wrap;gap:3px;min-height:52px;}",
    ".cap-empty{color:var(--text-muted);font-size:.7rem;font-style:italic;}",
    /* yaku panel */
    ".yaku-panel{font-size:.78rem;}",
    ".yaku-panel .yp-total{font-family:var(--mono);font-size:1.15rem;color:var(--accent);font-weight:700;}",
    ".yaku-list{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:3px;}",
    ".yaku-list li{display:flex;justify-content:space-between;gap:8px;padding:2px 6px;border-radius:5px;background:var(--elev);border:1px solid var(--border-soft);}",
    ".yaku-list li .yl-name{font-family:var(--jp);}",
    ".yaku-list li .yl-pts{font-family:var(--mono);color:var(--accent);}",
    ".yaku-list li.new{border-color:var(--jade);background:rgba(63,157,109,.14);animation:hanaPop .5s ease;}",
    ".yaku-none{color:var(--text-muted);font-style:italic;font-size:.72rem;}",
    /* decision */
    ".hana-decide{border:1px solid var(--accent);background:var(--accent-faint);border-radius:12px;padding:14px 16px;margin:4px 0 14px;}",
    ".hana-decide .hd-q{font-family:var(--jp);font-size:1rem;margin-bottom:4px;color:var(--text);}",
    ".hana-decide .hd-risk{font-size:.8rem;color:var(--text-sec);margin-bottom:12px;}",
    ".hana-decide .hd-btns{display:flex;gap:10px;flex-wrap:wrap;}",
    /* rules */
    ".hana-rules{font-size:.82rem;color:var(--text-sec);line-height:1.6;}",
    ".hana-rules h4{font-family:var(--jp);color:var(--accent);margin:10px 0 4px;font-size:.9rem;}",
    ".hana-rules code{font-family:var(--mono);color:var(--accent);}",
    ".hana-rules ul{margin:4px 0 4px 18px;}",
    ".hidden{display:none !important;}",
    ".thinking{display:inline-flex;gap:3px;align-items:center;color:var(--hue);font-family:var(--jp);}",
    ".thinking i{width:5px;height:5px;border-radius:50%;background:var(--hue);display:inline-block;animation:hanaBlink 1s infinite;}",
    ".thinking i:nth-child(2){animation-delay:.2s;} .thinking i:nth-child(3){animation-delay:.4s;}",
    "@keyframes hanaBlink{0%,100%{opacity:.3;}50%{opacity:1;}}"
  ].join("\n");

  function injectCSS() {
    if (typeof document === "undefined") return;
    if (document.getElementById("hana-css")) return;
    var s = document.createElement("style");
    s.id = "hana-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function typeClass(c) {
    if (c.type === "bright") return "t-bright";
    if (c.type === "animal") return "t-animal";
    if (c.type === "ribbon") return c.poetry ? "r-poetry" : (c.blueRibbon ? "r-blue" : "r-plain") + " t-ribbon";
    return "t-chaff";
  }
  function typeLabel(c) {
    if (c.type === "bright") return "光";
    if (c.type === "animal") return c.sake ? "盃" : "種";
    if (c.type === "ribbon") return c.poetry ? "赤短" : (c.blueRibbon ? "青短" : "短冊");
    return "カス";
  }

  function cardTile(c, opts) {
    opts = opts || {};
    var cls = "hana-card " + typeClass(c);
    if (opts.mini) cls += " mini";
    if (opts.extra) cls += " " + opts.extra;
    var t = el("div", cls);
    t.innerHTML =
      '<span class="hc-flower">' + c.flower + '</span>' +
      '<span class="hc-emblem">' + c.emblem + '</span>' +
      (opts.mini ? '' :
        '<span class="hc-name">' + c.name + '</span>' +
        '<span class="hc-type">' + typeLabel(c) + '</span>');
    if (opts.onClick) {
      t.classList.add("clickable");
      t.addEventListener("click", opts.onClick);
    }
    return t;
  }

  function cardBack() {
    var t = el("div", "hana-card back");
    t.innerHTML = '<span class="hc-flower">花</span><span class="hc-emblem">🎴</span><span class="hc-type">札</span>';
    return t;
  }

  // ---- main mount ----------------------------------------------------
  function init(container) {
    injectCSS();
    var rng = Math.random; // UI uses the platform RNG (non-seeded)
    var timers = [];
    var timer = function (fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id; };

    var root = el("div", "hana-root");
    container.appendChild(root);

    // persistent chrome
    var top = el("div", "hana-top");
    var newBtn = el("button", "btn btn-accent", "New Match");
    var roundsSeg = el("div", "seg");
    [3, 6, 12].forEach(function (n) {
      var b = el("button", n === 6 ? "active" : "", n + " rounds");
      b.dataset.n = n;
      roundsSeg.appendChild(b);
    });
    var diffSeg = el("div", "seg");
    ["Normal", "Hard"].forEach(function (d, i) {
      var b = el("button", i === 0 ? "active" : "", d);
      b.dataset.d = d.toLowerCase();
      diffSeg.appendChild(b);
    });
    var rulesBtn = el("button", "btn", "Rules");
    var status = el("div", "hana-status");
    top.appendChild(newBtn);
    top.appendChild(roundsSeg);
    top.appendChild(diffSeg);
    top.appendChild(rulesBtn);
    top.appendChild(el("span", "grow"));
    top.appendChild(status);
    root.appendChild(top);

    var msgEl = el("div", "hana-msg", "Press New Match to begin.");
    root.appendChild(msgEl);

    var decideEl = el("div", "hana-decide hidden");
    root.appendChild(decideEl);

    var rulesEl = el("div", "hana-zone hana-rules hidden");
    rulesEl.innerHTML = rulesHTML();
    root.appendChild(rulesEl);

    var board = el("div", "hana-board");
    root.appendChild(board);

    // match/round state
    var match = { rounds: 6, round: 1, dealer: 0, scores: [0, 0], difficulty: "normal" };
    var state = null;
    var turn = 0;            // whose turn (0 human, 1 AI)
    var phase = "idle";      // idle|play|chooseFieldPlay|chooseFieldDraw|decision|roundOver|matchOver
    var pending = null;      // { i, card, matches } during chooseFieldPlay
    var pendingDraw = null;  // { card, matches, done } during chooseFieldDraw
    var lastYakuKeys = [{}, {}]; // for 'new' highlight
    var justIds = {};        // cards to pop-animate this render

    function setMsg(html) { msgEl.innerHTML = html; }

    /* ---------- flow ---------- */
    function newMatch() {
      match.round = 1; match.dealer = 0; match.scores = [0, 0];
      phase = "idle";
      decideEl.classList.add("hidden");
      startRound();
    }

    function startRound() {
      state = newRound(rng, match.dealer);
      turn = match.dealer;
      phase = "play";
      pending = null; pendingDraw = null;
      lastYakuKeys = [{}, {}];
      decideEl.classList.add("hidden");
      var who = turn === 0 ? "You" : "AI";
      setMsg("Round " + match.round + " — " + (match.dealer === 0 ? "you deal" : "AI deals") +
        ". " + who + " to move.");
      render();
      if (turn === 1) timer(aiTurn, 850);
    }

    function proceedToDraw(pl) {
      drawStep(pl, function () { afterCaptures(pl); });
    }

    // Draw + resolve. `done` fires after resolution (may await human choice).
    function drawStep(pl, done) {
      if (!state.stock.length) { done(); return; }
      var d = state.stock.pop();
      var matches = monthMatches(d, state.field);
      var who = pl === 0 ? "You drew" : "AI drew";
      if (matches.length === 0) {
        state.field.push(d);
        justIds[d.id] = 1;
        setMsg(who + " " + d.name + " " + d.flower + " — no match, laid on field.");
        render();
        timer(done, 650);
        return;
      }
      if (matches.length === 1 || matches.length >= 3 || pl === 1) {
        var target = matches.length >= 3 ? "all" : (pl === 1 ? bestFieldTarget(matches) : matches[0]);
        var taken = takeCapture(state, pl, d, matches, target);
        justIds[d.id] = 1; for (var i = 0; i < taken.length; i++) justIds[taken[i].id] = 1;
        setMsg(who + " " + d.name + " " + d.flower + " — captured!");
        render();
        timer(done, 700);
        return;
      }
      // human, exactly 2 matches → choose
      pendingDraw = { card: d, matches: matches, done: done };
      phase = "chooseFieldDraw";
      setMsg("You drew " + d.name + " " + d.flower + " — pick which field card to capture.");
      render();
    }

    function afterCaptures(pl) {
      var sc = scoreYaku(state.captured[pl]);
      if (sc.total > state.yakuTotal[pl]) {
        if (pl === 0) {
          phase = "decision";
          state.pendingDecisionTotal = sc.total;
          render();
          showDecision(sc.total);
          return;
        } else {
          var stop = aiKoi(state, pl, sc.total, rng, match.difficulty === "hard");
          state.yakuTotal[pl] = sc.total;
          if (stop) {
            setMsg('AI declares <b style="color:var(--accent)">Stop</b> with ' + sc.total + " pts!");
            render();
            timer(function () { endRound(pl); }, 900);
            return;
          } else {
            state.koi[pl] = true;
            setMsg('AI calls <b style="color:var(--hue)">Koi-Koi!</b> — pressing on.');
            render();
            timer(function () { endTurn(pl); }, 950);
            return;
          }
        }
      }
      state.yakuTotal[pl] = sc.total;
      endTurn(pl);
    }

    function endTurn(pl) {
      phase = "play";
      pending = null; pendingDraw = null;
      if (state.hands[0].length === 0 && state.hands[1].length === 0) { endRound(null); return; }
      var next = 1 - pl;
      if (state.hands[next].length === 0) next = pl; // opponent out of cards; keep going
      turn = next;
      render();
      if (turn === 1) timer(aiTurn, 800);
    }

    function endRound(winner) {
      phase = "roundOver";
      var line;
      if (winner === null) {
        line = "Round drawn — no score. Dealer keeps the deal.";
      } else {
        var base = state.yakuTotal[winner];
        var pts = finalScore(base, state.koi[winner]);
        match.scores[winner] += pts;
        var who = winner === 0 ? "You" : "AI";
        var mult = [];
        if (base >= 7) mult.push("×2 (7+)");
        if (state.koi[winner]) mult.push("×2 koi");
        line = '<b style="color:var(--accent)">' + who + " win the round</b>: base " + base +
          (mult.length ? " " + mult.join(" ") : "") + " = <b>" + pts + " pts</b>.";
      }
      setMsg(line);
      render();
      timer(function () {
        if (match.round >= match.rounds) { declareMatch(); return; }
        match.round++;
        if (winner !== null) match.dealer = 1 - match.dealer; // alternate on a decided round
        startRound();
      }, 1900);
    }

    function declareMatch() {
      phase = "matchOver";
      var s = match.scores, res;
      if (s[0] > s[1]) res = 'You win the match! 🎉';
      else if (s[1] > s[0]) res = "The AI wins the match.";
      else res = "The match is a tie.";
      setMsg('<b style="color:var(--accent)">Match over</b> — You ' + s[0] + " · AI " + s[1] +
        ". " + res + " Press New Match to play again.");
      render();
    }

    /* ---------- AI turn (animated) ---------- */
    function aiTurn() {
      if (phase !== "play" || turn !== 1) return;
      setMsg('<span class="thinking">AI thinking<i></i><i></i><i></i></span>');
      render();
      timer(function () {
        var pl = 1;
        var plan = aiPlan(state, pl);
        var card = state.hands[pl].splice(plan.i, 1)[0];
        var matches = monthMatches(card, state.field);
        var taken = takeCapture(state, pl, card, matches, plan.target);
        justIds[card.id] = 1; for (var i = 0; i < taken.length; i++) justIds[taken[i].id] = 1;
        setMsg("AI plays " + card.name + " " + card.flower +
          (matches.length ? " — captured!" : " — laid on field."));
        render();
        timer(function () { proceedToDraw(pl); }, 750);
      }, 800);
    }

    /* ---------- human interactions ---------- */
    function onHandClick(i) {
      if (phase !== "play" || turn !== 0) return;
      var card = state.hands[0][i];
      var matches = monthMatches(card, state.field);
      if (matches.length === 2) {
        pending = { i: i, card: card, matches: matches };
        phase = "chooseFieldPlay";
        setMsg("You play " + card.name + " " + card.flower + " — pick which field card to capture.");
        render();
        return;
      }
      state.hands[0].splice(i, 1);
      var target = matches.length >= 3 ? "all" : (matches.length === 1 ? matches[0] : null);
      var taken = takeCapture(state, 0, card, matches, target);
      justIds[card.id] = 1; for (var k = 0; k < taken.length; k++) justIds[taken[k].id] = 1;
      setMsg("You play " + card.name + " " + card.flower + (matches.length ? " — captured!" : " — laid on field."));
      render();
      timer(function () { proceedToDraw(0); }, 500);
    }

    function onFieldClick(f) {
      if (phase === "chooseFieldPlay") {
        if (pending.matches.indexOf(f) < 0) return;
        var card = pending.card, i = pending.i;
        state.hands[0].splice(i, 1);
        var taken = takeCapture(state, 0, card, pending.matches, f);
        justIds[card.id] = 1; for (var k = 0; k < taken.length; k++) justIds[taken[k].id] = 1;
        pending = null; phase = "play";
        setMsg("You capture " + f.name + " with " + card.name + ".");
        render();
        timer(function () { proceedToDraw(0); }, 500);
      } else if (phase === "chooseFieldDraw") {
        if (pendingDraw.matches.indexOf(f) < 0) return;
        var d = pendingDraw.card, done = pendingDraw.done;
        var tk = takeCapture(state, 0, d, pendingDraw.matches, f);
        justIds[d.id] = 1; for (var j = 0; j < tk.length; j++) justIds[tk[j].id] = 1;
        pendingDraw = null; phase = "play";
        setMsg("You capture " + f.name + " with the drawn " + d.name + ".");
        render();
        timer(done, 500);
      }
    }

    function showDecision(total) {
      decideEl.classList.remove("hidden");
      decideEl.innerHTML = "";
      var q = el("div", "hd-q", "You formed a yaku worth <b>" + total + "</b> points. Stop and score, or Koi-Koi?");
      var risk = el("div", "hd-risk",
        "<b>Stop (あがり)</b> banks " + total + " pts now. <b>Koi-Koi (こいこい)</b> keeps playing for a bigger hand" +
        " (and doubles your final score) — but if the AI stops first, you score 0 this round.");
      var btns = el("div", "hd-btns");
      var stopB = el("button", "btn btn-accent", "Stop — score " + total);
      var koiB = el("button", "btn", "Koi-Koi — play on");
      stopB.addEventListener("click", function () {
        decideEl.classList.add("hidden");
        state.yakuTotal[0] = total;
        endRound(0);
      });
      koiB.addEventListener("click", function () {
        decideEl.classList.add("hidden");
        state.yakuTotal[0] = total;
        state.koi[0] = true;
        setMsg('You call <b style="color:var(--hue)">Koi-Koi!</b> — pressing on for more.');
        endTurn(0);
      });
      btns.appendChild(stopB); btns.appendChild(koiB);
      decideEl.appendChild(q); decideEl.appendChild(risk); decideEl.appendChild(btns);
    }

    /* ---------- render ---------- */
    function updateStatus() {
      var lead0 = match.scores[0] >= match.scores[1] ? " lead" : "";
      var lead1 = match.scores[1] > match.scores[0] ? " lead" : "";
      status.innerHTML =
        '<span class="badge">Round <b>' + match.round + "/" + match.rounds + "</b></span>" +
        '<span class="badge">Dealer <b>' + (match.dealer === 0 ? "You" : "AI") + "</b></span>" +
        '<span class="badge">Stock <b>' + (state ? state.stock.length : 0) + "</b></span>" +
        '<span class="badge' + lead0 + '">You <b>' + match.scores[0] + "</b></span>" +
        '<span class="badge' + lead1 + '">AI <b>' + match.scores[1] + "</b></span>";
    }

    function capturedGroups(pl) {
      var wrap = el("div", "cap-groups");
      var groups = [
        ["bright", "光 Brights"],
        ["animal", "種 Animals"],
        ["ribbon", "短 Ribbons"],
        ["chaff", "カス Chaff"]
      ];
      var cap = state.captured[pl];
      groups.forEach(function (g) {
        var box = el("div", "cap-g");
        box.appendChild(el("div", "cap-h", g[1]));
        var cc = el("div", "cap-cards");
        var any = false;
        for (var i = 0; i < cap.length; i++) {
          if (cap[i].type === g[0]) {
            any = true;
            cc.appendChild(cardTile(cap[i], { mini: true, extra: justIds[cap[i].id] ? "just" : "" }));
          }
        }
        if (!any) cc.appendChild(el("span", "cap-empty", "—"));
        box.appendChild(cc);
        wrap.appendChild(box);
      });
      return wrap;
    }

    function yakuPanel(pl) {
      var p = el("div", "yaku-panel");
      var sc = scoreYaku(state.captured[pl]);
      p.appendChild(el("div", null,
        '<span class="panel-h" style="display:inline;margin:0">' + (pl === 0 ? "Your" : "AI") +
        ' Yaku</span> &nbsp; <span class="yp-total">' + sc.total + "</span> pts" +
        (state.koi[pl] ? ' <span class="badge" style="color:var(--hue)">こいこい</span>' : "")));
      if (sc.list.length === 0) {
        p.appendChild(el("div", "yaku-none", "No yaku yet."));
      } else {
        var ul = el("ul", "yaku-list");
        var seen = {};
        sc.list.forEach(function (y) {
          seen[y.key] = 1;
          var isNew = !lastYakuKeys[pl][y.key];
          var li = el("li", isNew ? "new" : "");
          li.innerHTML = '<span class="yl-name">' + y.name + " " + y.jp + '</span><span class="yl-pts">+' + y.pts + "</span>";
          ul.appendChild(li);
        });
        p.appendChild(ul);
        lastYakuKeys[pl] = seen;
      }
      return p;
    }

    function fieldMatchSet() {
      // which field cards are highlightable for the current human choice
      if (phase === "chooseFieldPlay") return pending.matches;
      if (phase === "chooseFieldDraw") return pendingDraw.matches;
      return [];
    }

    function render() {
      updateStatus();
      if (!state) { board.innerHTML = ""; return; }
      board.innerHTML = "";

      // opponent zone
      var opp = el("div", "hana-zone");
      var oppLabel = el("div", "zone-label",
        '<span class="who">AI 相手</span><span>Hand: ' + state.hands[1].length +
        (turn === 1 && phase !== "roundOver" && phase !== "matchOver" ? ' · to move' : '') + "</span>");
      opp.appendChild(oppLabel);
      var oppCols = el("div", "hana-flexcols");
      var oppHandCol = el("div", "col");
      oppHandCol.appendChild(el("div", "zone-label", "Hand"));
      var oppHandRow = el("div", "hana-row");
      for (var h = 0; h < state.hands[1].length; h++) oppHandRow.appendChild(cardBack());
      oppHandCol.appendChild(oppHandRow);
      var oppCapCol = el("div", "col");
      oppCapCol.appendChild(el("div", "zone-label", "Captured"));
      oppCapCol.appendChild(capturedGroups(1));
      var oppYakuCol = el("div", "col");
      oppYakuCol.appendChild(yakuPanel(1));
      oppCols.appendChild(oppHandCol);
      oppCols.appendChild(oppCapCol);
      oppCols.appendChild(oppYakuCol);
      opp.appendChild(oppCols);
      board.appendChild(opp);

      // field zone
      var fieldZone = el("div", "hana-zone field");
      fieldZone.appendChild(el("div", "zone-label",
        '<span class="who">場 Field</span><span>Stock: ' + state.stock.length + " 🎴</span>"));
      var frow = el("div", "hana-row");
      var highlights = fieldMatchSet();
      state.field.forEach(function (c) {
        var isMatch = highlights.indexOf(c) >= 0;
        var opts = { extra: (isMatch ? "match " : "") + (justIds[c.id] ? "just" : "") };
        if (isMatch) opts.onClick = function () { onFieldClick(c); };
        frow.appendChild(cardTile(c, opts));
      });
      if (state.field.length === 0) frow.appendChild(el("span", "cap-empty", "field empty"));
      fieldZone.appendChild(frow);
      board.appendChild(fieldZone);

      // your zone
      var you = el("div", "hana-zone");
      you.appendChild(el("div", "zone-label",
        '<span class="who">あなた You</span><span>' +
        (turn === 0 && phase === "play" ? "Your move — play a card" :
          turn === 0 && phase === "chooseFieldPlay" ? "Choose a field card to capture" :
            turn === 0 && phase === "chooseFieldDraw" ? "Choose a field card for your draw" : "&nbsp;") +
        "</span>"));
      var youCols = el("div", "hana-flexcols");
      var youYakuCol = el("div", "col");
      youYakuCol.appendChild(yakuPanel(0));
      var youCapCol = el("div", "col");
      youCapCol.appendChild(el("div", "zone-label", "Captured"));
      youCapCol.appendChild(capturedGroups(0));
      youCols.appendChild(youYakuCol);
      youCols.appendChild(youCapCol);
      you.appendChild(youCols);

      you.appendChild(el("div", "zone-label", "Your Hand"));
      var yhand = el("div", "hana-row");
      var canPlay = turn === 0 && phase === "play";
      state.hands[0].forEach(function (c, i) {
        var opts = {};
        if (canPlay) {
          opts.onClick = function () { onHandClick(i); };
          if (monthMatches(c, state.field).length > 0) opts.extra = "match";
        }
        if (pending && pending.card === c) opts.extra = "sel";
        yhand.appendChild(cardTile(c, opts));
      });
      if (state.hands[0].length === 0) yhand.appendChild(el("span", "cap-empty", "hand empty"));
      you.appendChild(yhand);
      board.appendChild(you);

      justIds = {}; // consumed
    }

    /* ---------- control wiring ---------- */
    newBtn.addEventListener("click", newMatch);
    roundsSeg.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      match.rounds = parseInt(b.dataset.n, 10);
      Array.prototype.forEach.call(roundsSeg.children, function (x) { x.classList.toggle("active", x === b); });
    });
    diffSeg.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      match.difficulty = b.dataset.d;
      Array.prototype.forEach.call(diffSeg.children, function (x) { x.classList.toggle("active", x === b); });
    });
    rulesBtn.addEventListener("click", function () { rulesEl.classList.toggle("hidden"); });

    // auto-start a first match
    newMatch();

    // cleanup
    return function destroy() {
      for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
      timers = [];
      if (root.parentNode) root.parentNode.removeChild(root);
    };
  }

  function rulesHTML() {
    return [
      '<h4>花札 Koi-Koi — quick rules</h4>',
      'Match flower cards by <b>month</b> to capture them, build <b>yaku</b> (scoring combos), then decide to <b>Stop</b> and bank your points or call <b>Koi-Koi</b> to press your luck for more.',
      '<h4>A turn</h4>',
      '<ul><li>Play a hand card — if it shares a month with field card(s), capture; otherwise it joins the field.</li>',
      '<li>Draw the top stock card and resolve it the same way.</li>',
      '<li>If you formed a new yaku, choose <code>Stop</code> or <code>Koi-Koi</code>.</li></ul>',
      '<h4>Scoring</h4>',
      'On Stop: base = your yaku total. <code>×2</code> if base ≥ 7, and another <code>×2</code> if you called Koi-Koi this round (they combine). The loser scores 0.',
      '<h4>Yaku</h4>',
      '<ul><li>五光 Gokō (5 brights) 10 · 四光 Shikō (4, no rain) 8 · 雨四光 Ame-Shikō (4 w/ rain) 7 · 三光 Sankō (3, no rain) 5</li>',
      '<li>猪鹿蝶 Ino-Shika-Chō (boar+deer+butterfly) 5 · 種 Tane (5+ animals) 1 +1 each extra</li>',
      '<li>赤短 Akatan (3 red poetry ribbons) 5 · 青短 Aotan (3 blue ribbons) 5 · 短 Tan (5+ ribbons) 1 +1 each extra — these stack</li>',
      '<li>カス Kasu (10+ chaff) 1 +1 each extra · 月見酒 Tsukimi-zake (moon+sake) 5 · 花見酒 Hanami-zake (cherry+sake) 5</li></ul>',
      'The deck is 48 cards (12 months × 4). Deal is 8 hand / 8 hand / 8 field, leaving 24 in the stock. If 3 field cards share your card’s month you take all three.'
    ].join("");
  }

  /* =================================================================
     Registration + exports
     ================================================================= */

  if (typeof window !== "undefined") {
    window.GAMES = window.GAMES || {};
    window.GAMES.hanafuda = {
      title: "Hanafuda", jp: "花札",
      blurb: "Koi-Koi: match flower cards by month, build yaku, press your luck.",
      tag: "48 cards · Koi-Koi · vs AI", hue: "#d1442f", glow: "rgba(209,68,47,0.20)",
      init: init
    };
  }

  if (typeof module !== "undefined") {
    module.exports = {
      MONTHS: MONTHS,
      buildDeck: buildDeck,
      shuffle: shuffle,
      mulberry32: mulberry32,
      scoreYaku: scoreYaku,
      finalScore: finalScore,
      cardValue: cardValue,
      monthMatches: monthMatches,
      takeCapture: takeCapture,
      newRound: newRound,
      totalCards: totalCards,
      resolveTurnAuto: resolveTurnAuto,
      simulateMatch: simulateMatch,
      aiPlan: aiPlan,
      aiKoi: aiKoi
    };
  }
})();
