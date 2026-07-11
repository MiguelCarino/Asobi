/* =====================================================================
   Carino Asobi — Shogi (将棋)
   Self-contained module: pure engine (node-testable) + browser UI.
   Registers window.GAMES.shogi and exports engine internals for node.

   Board model
   -----------
   81-square flat array, index = row*9 + col.
   row 0 = top (Gote's back rank), row 8 = bottom (Sente's back rank).
   col 0 = left = file 9, col 8 = right = file 1  (file = 9 - col).
   side 0 = Sente (先手, black) moves UP   (dr = -1, toward row 0).
   side 1 = Gote  (後手, white) moves DOWN (dr = +1, toward row 8).
   Pieces: { t: base letter, s: side, p: promoted bool }.
   t ∈ P L N S G B R K (G,K never promote).
   ===================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  ENGINE (no DOM)                                                    */
  /* ------------------------------------------------------------------ */

  const MATE = 1000000;
  const INF = 1000000000;

  // Material values (on board).
  const VAL   = { P: 100, L: 430, N: 450, S: 640, G: 690, B: 890, R: 1040, K: 20000 };
  // Promoted board values.
  const PVAL  = { P: 600, L: 600, N: 600, S: 720, B: 1150, R: 1300 };
  // In-hand values (slightly less than on board, but pawns a touch more useful).
  const HVAL  = { P: 115, L: 400, N: 420, S: 610, G: 660, B: 840, R: 980 };

  const PROMOTABLE = { P: 1, L: 1, N: 1, S: 1, B: 1, R: 1 };

  function emptyHand() { return { P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0, K: 0 }; }

  function createGame() {
    const board = new Array(81).fill(null);
    const back = ["L", "N", "S", "G", "K", "G", "S", "N", "L"];
    for (let c = 0; c < 9; c++) {
      board[0 * 9 + c] = { t: back[c], s: 1, p: false }; // Gote back rank
      board[8 * 9 + c] = { t: back[c], s: 0, p: false }; // Sente back rank
      board[2 * 9 + c] = { t: "P", s: 1, p: false };     // Gote pawns
      board[6 * 9 + c] = { t: "P", s: 0, p: false };     // Sente pawns
    }
    board[1 * 9 + 1] = { t: "R", s: 1, p: false }; // Gote rook (8b)
    board[1 * 9 + 7] = { t: "B", s: 1, p: false }; // Gote bishop (2b)
    board[7 * 9 + 1] = { t: "B", s: 0, p: false }; // Sente bishop (8h)
    board[7 * 9 + 7] = { t: "R", s: 0, p: false }; // Sente rook (2h)
    return { board: board, hands: [emptyHand(), emptyHand()], turn: 0, ply: 0 };
  }

  // Pieces are never mutated in place (moves create fresh objects), so the
  // board array can be shallow-copied and piece objects safely shared.
  function cloneState(s) {
    return {
      board: s.board.slice(),
      hands: [Object.assign({}, s.hands[0]), Object.assign({}, s.hands[1])],
      turn: s.turn,
      ply: s.ply
    };
  }

  const GOLD = (f) => [[f, 0], [-f, 0], [0, -1], [0, 1], [f, -1], [f, 1]];

  function rawVectors(t, promoted, f) {
    if (promoted) {
      if (t === "P" || t === "L" || t === "N" || t === "S") return { steps: GOLD(f), slides: [] };
      if (t === "B") return { steps: [[1, 0], [-1, 0], [0, 1], [0, -1]], slides: [[1, 1], [1, -1], [-1, 1], [-1, -1]] };
      if (t === "R") return { steps: [[1, 1], [1, -1], [-1, 1], [-1, -1]], slides: [[1, 0], [-1, 0], [0, 1], [0, -1]] };
    }
    switch (t) {
      case "P": return { steps: [[f, 0]], slides: [] };
      case "L": return { steps: [], slides: [[f, 0]] };
      case "N": return { steps: [[2 * f, -1], [2 * f, 1]], slides: [] };
      case "S": return { steps: [[f, -1], [f, 0], [f, 1], [-f, -1], [-f, 1]], slides: [] };
      case "G": return { steps: GOLD(f), slides: [] };
      case "K": return { steps: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]], slides: [] };
      case "B": return { steps: [], slides: [[1, 1], [1, -1], [-1, 1], [-1, -1]] };
      case "R": return { steps: [], slides: [[1, 0], [-1, 0], [0, 1], [0, -1]] };
    }
    return { steps: [], slides: [] };
  }

  const _vecCache = {};
  function vectorsFor(p) {
    const key = p.t + (p.p ? "+" : "") + p.s;
    let v = _vecCache[key];
    if (!v) { v = rawVectors(p.t, p.p, p.s === 0 ? -1 : 1); _vecCache[key] = v; }
    return v;
  }

  const inZone = (s, row) => (s === 0 ? row <= 2 : row >= 6);

  function mustPromote(t, s, toRow) {
    if (t === "P" || t === "L") return s === 0 ? toRow === 0 : toRow === 8;
    if (t === "N") return s === 0 ? toRow <= 1 : toRow >= 7;
    return false;
  }
  function dropRowOK(t, s, row) {
    if (t === "P" || t === "L") return s === 0 ? row !== 0 : row !== 8;
    if (t === "N") return s === 0 ? row > 1 : row < 7;
    return true;
  }
  function nifu(board, side, col) {
    for (let r = 0; r < 9; r++) {
      const p = board[r * 9 + col];
      if (p && p.s === side && p.t === "P" && !p.p) return true;
    }
    return false;
  }

  function addBoardMove(moves, i, j, p, fr, tr) {
    const promotable = !p.p && PROMOTABLE[p.t];
    if (promotable && (inZone(p.s, fr) || inZone(p.s, tr))) {
      moves.push({ from: i, to: j, promote: true, drop: false });
      if (!mustPromote(p.t, p.s, tr)) moves.push({ from: i, to: j, promote: false, drop: false });
    } else {
      moves.push({ from: i, to: j, promote: false, drop: false });
    }
  }

  function genPseudoMoves(s) {
    const board = s.board, turn = s.turn, moves = [];
    for (let i = 0; i < 81; i++) {
      const p = board[i];
      if (!p || p.s !== turn) continue;
      const fr = (i / 9) | 0, fc = i % 9;
      const v = vectorsFor(p);
      const steps = v.steps, slides = v.slides;
      for (let k = 0; k < steps.length; k++) {
        const tr = fr + steps[k][0], tc = fc + steps[k][1];
        if (tr < 0 || tr > 8 || tc < 0 || tc > 8) continue;
        const j = tr * 9 + tc, tp = board[j];
        if (tp && tp.s === turn) continue;
        addBoardMove(moves, i, j, p, fr, tr);
      }
      for (let k = 0; k < slides.length; k++) {
        const dr = slides[k][0], dc = slides[k][1];
        let tr = fr + dr, tc = fc + dc;
        while (tr >= 0 && tr <= 8 && tc >= 0 && tc <= 8) {
          const j = tr * 9 + tc, tp = board[j];
          if (tp && tp.s === turn) break;
          addBoardMove(moves, i, j, p, fr, tr);
          if (tp) break;
          tr += dr; tc += dc;
        }
      }
    }
    const hand = s.hands[turn];
    const types = ["P", "L", "N", "S", "G", "B", "R"];
    for (let ti = 0; ti < types.length; ti++) {
      const t = types[ti];
      if (!hand[t]) continue;
      for (let j = 0; j < 81; j++) {
        if (board[j]) continue;
        const tr = (j / 9) | 0;
        if (!dropRowOK(t, turn, tr)) continue;
        if (t === "P" && nifu(board, turn, j % 9)) continue;
        moves.push({ from: -1, to: j, drop: true, dropType: t, promote: false });
      }
    }
    return moves;
  }

  function makeMove(s, m) {
    const turn = s.turn;
    if (m.drop) {
      s.board[m.to] = { t: m.dropType, s: turn, p: false };
      s.hands[turn][m.dropType]--;
      s.turn = 1 - turn; s.ply++;
      return { drop: true, to: m.to, dropType: m.dropType, turn: turn };
    }
    const moved = s.board[m.from];
    const captured = s.board[m.to];
    s.board[m.to] = { t: moved.t, s: moved.s, p: moved.p || m.promote };
    s.board[m.from] = null;
    if (captured) s.hands[turn][captured.t] = (s.hands[turn][captured.t] || 0) + 1;
    s.turn = 1 - turn; s.ply++;
    return { drop: false, from: m.from, to: m.to, moved: moved, captured: captured, turn: turn };
  }

  function unmakeMove(s, u) {
    s.turn = u.turn; s.ply--;
    if (u.drop) { s.board[u.to] = null; s.hands[u.turn][u.dropType]++; return; }
    s.board[u.from] = u.moved;
    s.board[u.to] = u.captured || null;
    if (u.captured) s.hands[u.turn][u.captured.t]--;
  }

  function applyMove(s, m) {
    const c = cloneState(s);
    makeMove(c, m);
    return c;
  }

  function findKing(board, side) {
    for (let i = 0; i < 81; i++) {
      const p = board[i];
      if (p && p.t === "K" && p.s === side) return i;
    }
    return -1;
  }

  function attacksSquare(board, from, to, p) {
    const v = vectorsFor(p);
    const fr = (from / 9) | 0, fc = from % 9, tr = (to / 9) | 0, tc = to % 9;
    const steps = v.steps, slides = v.slides;
    for (let k = 0; k < steps.length; k++) {
      if (fr + steps[k][0] === tr && fc + steps[k][1] === tc) return true;
    }
    for (let k = 0; k < slides.length; k++) {
      const dr = slides[k][0], dc = slides[k][1];
      let r = fr + dr, c = fc + dc;
      while (r >= 0 && r <= 8 && c >= 0 && c <= 8) {
        if (r === tr && c === tc) return true;
        if (board[r * 9 + c]) break;
        r += dr; c += dc;
      }
    }
    return false;
  }

  function isSquareAttacked(board, sq, by) {
    for (let i = 0; i < 81; i++) {
      const p = board[i];
      if (p && p.s === by && attacksSquare(board, i, sq, p)) return true;
    }
    return false;
  }

  function isKingAttacked(s, side) {
    const ksq = findKing(s.board, side);
    if (ksq < 0) return false;
    return isSquareAttacked(s.board, ksq, 1 - side);
  }

  function hasAnyLegal(s) {
    const pseudo = genPseudoMoves(s), turn = s.turn;
    for (let k = 0; k < pseudo.length; k++) {
      const u = makeMove(s, pseudo[k]);
      const bad = isKingAttacked(s, turn);
      unmakeMove(s, u);
      if (!bad) return true;
    }
    return false;
  }

  function genLegalMoves(s) {
    const pseudo = genPseudoMoves(s), turn = s.turn, legal = [];
    for (let k = 0; k < pseudo.length; k++) {
      const m = pseudo[k];
      const u = makeMove(s, m);
      let ok = !isKingAttacked(s, turn);
      if (ok && m.drop && m.dropType === "P") {
        // Uchifuzume: a pawn drop that is immediate checkmate is illegal.
        if (isKingAttacked(s, 1 - turn) && !hasAnyLegal(s)) ok = false;
      }
      unmakeMove(s, u);
      if (ok) legal.push(m);
    }
    return legal;
  }

  // Status of the side to move.
  function getStatus(s) {
    const legal = genLegalMoves(s);
    const check = isKingAttacked(s, s.turn);
    if (legal.length === 0) {
      return { over: true, checkmate: check, winner: 1 - s.turn, reason: check ? "checkmate" : "stalemate", check: check, legal: legal };
    }
    return { over: false, check: check, winner: -1, reason: "", legal: legal };
  }

  function posKey(s) {
    let str = "";
    for (let i = 0; i < 81; i++) {
      const p = s.board[i];
      str += p ? (p.s === 0 ? "" : "g") + (p.p ? "+" : "") + p.t : ".";
    }
    const h = s.hands, ord = ["P", "L", "N", "S", "G", "B", "R"];
    str += "|";
    for (let k = 0; k < ord.length; k++) str += h[0][ord[k]] + ",";
    str += "|";
    for (let k = 0; k < ord.length; k++) str += h[1][ord[k]] + ",";
    str += "|" + s.turn;
    return str;
  }

  /* --------------------------- evaluation --------------------------- */
  function evaluate(s) {
    const board = s.board;
    let score = 0; // sente - gote
    for (let i = 0; i < 81; i++) {
      const p = board[i];
      if (!p) continue;
      let v = p.p ? PVAL[p.t] : VAL[p.t];
      const r = (i / 9) | 0, c = i % 9;
      let pos = 0;
      if (p.t === "P" && !p.p) {
        const adv = p.s === 0 ? 6 - r : r - 2;
        pos += adv * 7;
      } else if ((p.t === "S" || p.t === "G") && !p.p) {
        pos += (4 - Math.abs(c - 4)) * 3; // mild central preference
      }
      score += p.s === 0 ? v + pos : -(v + pos);
    }
    // Hands.
    const ord = ["P", "L", "N", "S", "G", "B", "R"];
    for (let k = 0; k < ord.length; k++) {
      const t = ord[k];
      score += s.hands[0][t] * HVAL[t];
      score -= s.hands[1][t] * HVAL[t];
    }
    // King shelter: friendly pieces adjacent to own king.
    score += kingShelter(board, 0) - kingShelter(board, 1);
    return score;
  }

  function kingShelter(board, side) {
    const ksq = findKing(board, side);
    if (ksq < 0) return 0;
    const kr = (ksq / 9) | 0, kc = ksq % 9;
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = kr + dr, c = kc + dc;
      if (r < 0 || r > 8 || c < 0 || c > 8) continue;
      const p = board[r * 9 + c];
      if (p && p.s === side) n += 12;
    }
    return n;
  }

  const evalPersp = (s) => (s.turn === 0 ? evaluate(s) : -evaluate(s));

  function orderMoves(moves, s) {
    const board = s.board;
    for (let k = 0; k < moves.length; k++) {
      const m = moves[k];
      let o = 0;
      if (!m.drop) {
        const cap = board[m.to];
        if (cap) o += (cap.p ? PVAL[cap.t] : VAL[cap.t]) * 8 - (board[m.from].p ? PVAL[board[m.from].t] : VAL[board[m.from].t]);
        if (m.promote) o += 350;
      }
      m._o = o;
    }
    moves.sort((a, b) => b._o - a._o);
  }

  function quiesce(s, alpha, beta, ctx) {
    ctx.nodes++;
    let stand = evalPersp(s);
    if (ctx.nodes > ctx.cap || Date.now() > ctx.deadline) return stand;
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    const moves = genLegalMoves(s), caps = [];
    for (let k = 0; k < moves.length; k++) {
      const m = moves[k];
      if (!m.drop && s.board[m.to]) caps.push(m);
    }
    orderMoves(caps, s);
    for (let k = 0; k < caps.length; k++) {
      const u = makeMove(s, caps[k]);
      const sc = -quiesce(s, -beta, -alpha, ctx);
      unmakeMove(s, u);
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
      if (ctx.nodes > ctx.cap || Date.now() > ctx.deadline) break;
    }
    return alpha;
  }

  function negamax(s, depth, alpha, beta, ctx, ply) {
    ctx.nodes++;
    if (ctx.nodes > ctx.cap || Date.now() > ctx.deadline) return evalPersp(s);
    const moves = genLegalMoves(s);
    if (moves.length === 0) return -MATE + ply; // no legal move → loss
    if (depth <= 0) return quiesce(s, alpha, beta, ctx);
    orderMoves(moves, s);
    let val = -INF;
    for (let k = 0; k < moves.length; k++) {
      const u = makeMove(s, moves[k]);
      const sc = -negamax(s, depth - 1, -beta, -alpha, ctx, ply + 1);
      unmakeMove(s, u);
      if (sc > val) val = sc;
      if (val > alpha) alpha = val;
      if (alpha >= beta) break;
      if (ctx.nodes > ctx.cap || Date.now() > ctx.deadline) break;
    }
    return val;
  }

  // Returns the chosen move (mutates s via make/unmake but restores it).
  function chooseAIMove(s, depth, timeMs) {
    const legal = genLegalMoves(s);
    if (legal.length === 0) return null;
    orderMoves(legal, s);
    const ctx = { nodes: 0, deadline: Date.now() + (timeMs || 1200), cap: 400000 };
    let best = legal[0], bestScore = -INF, alpha = -INF;
    const scored = [];
    for (let k = 0; k < legal.length; k++) {
      const u = makeMove(s, legal[k]);
      const sc = -negamax(s, depth - 1, -INF, -alpha, ctx, 1);
      unmakeMove(s, u);
      scored.push({ m: legal[k], sc: sc });
      if (sc > bestScore) { bestScore = sc; best = legal[k]; }
      if (sc > alpha) alpha = sc;
      if (ctx.nodes > ctx.cap || Date.now() > ctx.deadline) break;
    }
    // Slight randomization among near-best for variety.
    const near = scored.filter((x) => x.sc >= bestScore - 12);
    if (near.length > 1) best = near[(Math.random() * near.length) | 0].m;
    return best;
  }

  /* ------------------------------------------------------------------ */
  /*  DISPLAY HELPERS (shared)                                           */
  /* ------------------------------------------------------------------ */
  const KANJI = { P: "歩", L: "香", N: "桂", S: "銀", G: "金", B: "角", R: "飛", K: "玉" };
  const KANJI_P = { P: "と", L: "杏", N: "圭", S: "全", B: "馬", R: "竜" };
  const RANK_JP = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

  function kanjiOf(p) {
    if (p.p && KANJI_P[p.t]) return KANJI_P[p.t];
    if (p.t === "K") return p.s === 0 ? "玉" : "王";
    return KANJI[p.t];
  }
  function sqName(sq) {
    const r = (sq / 9) | 0, c = sq % 9;
    return (9 - c) + "abcdefghi"[r];
  }
  function moveNotation(state, m) {
    if (m.drop) return m.dropType + "*" + sqName(m.to);
    const p = state.board[m.from];
    const letter = (p.p ? "+" : "") + p.t;
    const cap = state.board[m.to] ? "x" : "-";
    return letter + cap + sqName(m.to) + (m.promote ? "+" : "");
  }

  /* ------------------------------------------------------------------ */
  /*  UI                                                                 */
  /* ------------------------------------------------------------------ */
  const CSS = `
  .shogi-root{--wood:#1c1712;--wood2:#241d15;--line:var(--border);color:var(--text);font-family:var(--sans);
    display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:18px;max-width:1080px;margin:0 auto;padding:14px 16px 40px;}
  @media(max-width:860px){.shogi-root{grid-template-columns:1fr;}}
  .shogi-controls{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:4px;}
  .shogi-controls .grp{display:flex;align-items:center;gap:6px;}
  .shogi-controls label.lbl{font-family:var(--mono);font-size:.6rem;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted);}
  .shogi-play{display:flex;flex-direction:column;gap:12px;min-width:0;}
  .shogi-boardwrap{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto 1fr;gap:4px;}
  .shogi-files{grid-column:2;grid-row:1;display:grid;grid-template-columns:repeat(9,1fr);}
  .shogi-files span{text-align:center;font-family:var(--mono);font-size:.62rem;color:var(--text-muted);}
  .shogi-ranks{grid-column:1;grid-row:2;display:grid;grid-template-rows:repeat(9,1fr);}
  .shogi-ranks span{display:flex;align-items:center;justify-content:center;font-family:var(--jp);font-size:.7rem;color:var(--text-muted);padding-right:4px;}
  .shogi-board{grid-column:2;grid-row:2;display:grid;grid-template-columns:repeat(9,1fr);grid-template-rows:repeat(9,1fr);
    aspect-ratio:1/1;background:linear-gradient(160deg,var(--wood2),var(--wood));border:2px solid var(--accent-2);
    border-radius:6px;box-shadow:0 10px 40px rgba(0,0,0,.5),inset 0 0 60px rgba(0,0,0,.4);overflow:hidden;}
  .shogi-cell{position:relative;border-right:1px solid rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.06);
    display:flex;align-items:center;justify-content:center;cursor:default;padding:0;background:transparent;font-family:var(--jp);
    -webkit-tap-highlight-color:transparent;}
  .shogi-cell:nth-child(9n){border-right:none;}
  .shogi-cell:nth-child(n+73){border-bottom:none;}
  .shogi-piece{font-family:var(--jp);font-weight:700;line-height:1;font-size:clamp(14px,3.4vw,30px);color:#f4e4c1;
    text-shadow:0 1px 1px rgba(0,0,0,.6);user-select:none;transition:transform .06s;}
  .shogi-piece.gote{color:#e7d7c9;}
  .shogi-piece.rot{transform:rotate(180deg);}
  .shogi-cell.sel{background:var(--accent-glow);box-shadow:inset 0 0 0 2px var(--accent);}
  .shogi-cell.dest::after{content:"";position:absolute;width:34%;height:34%;border-radius:50%;background:var(--accent);opacity:.55;}
  .shogi-cell.dest.cap::after{width:76%;height:76%;border-radius:6px;background:transparent;border:3px solid var(--accent);opacity:.7;}
  .shogi-cell.last{background:rgba(234,179,8,.10);}
  .shogi-cell.check{background:rgba(239,68,68,.22);box-shadow:inset 0 0 0 2px var(--warn);}
  .shogi-cell.clickable{cursor:pointer;}
  .shogi-cell.clickable:hover{background:rgba(255,255,255,.05);}
  .shogi-hand{border:1px solid var(--border);background:var(--card);border-radius:10px;padding:8px 10px;display:flex;
    align-items:center;gap:8px;flex-wrap:wrap;min-height:44px;}
  .shogi-hand .hlbl{font-family:var(--mono);font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin-right:2px;}
  .shogi-hand.turn{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent-faint);}
  .hand-piece{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--border);border-radius:6px;padding:3px 7px;
    background:var(--elev);cursor:default;font-family:var(--jp);}
  .hand-piece.clickable{cursor:pointer;}
  .hand-piece.clickable:hover{border-color:var(--accent);}
  .hand-piece.sel{border-color:var(--accent);background:var(--accent-glow);}
  .hand-piece .k{font-size:1.05rem;color:#f4e4c1;}
  .hand-piece .n{font-family:var(--mono);font-size:.72rem;color:var(--text-sec);}
  .shogi-side{display:flex;flex-direction:column;gap:12px;min-width:0;}
  .shogi-status{font-family:var(--mono);font-size:.78rem;line-height:1.5;}
  .shogi-status .turn-s{color:var(--accent);} .shogi-status .turn-g{color:var(--vermilion);}
  .shogi-banner{border-radius:8px;padding:9px 12px;font-family:var(--display);font-weight:700;text-align:center;display:none;}
  .shogi-banner.show{display:block;}
  .shogi-banner.win{background:var(--accent);color:#1a1205;}
  .shogi-banner.draw{background:var(--elev);color:var(--text);border:1px solid var(--border);}
  .shogi-check{color:var(--warn);font-weight:700;}
  .shogi-think{color:var(--accent);}
  .shogi-log{list-style:none;margin:0;padding:0;max-height:320px;overflow:auto;font-family:var(--mono);font-size:.72rem;}
  .shogi-log li{display:flex;gap:8px;padding:2px 4px;border-bottom:1px solid var(--border-soft);}
  .shogi-log li:nth-child(odd){background:rgba(255,255,255,.015);}
  .shogi-log .mn{color:var(--text-muted);min-width:26px;}
  .shogi-log .mv{color:var(--text-sec);}
  .shogi-btnrow{display:flex;flex-wrap:wrap;gap:8px;}
  .shogi-range{accent-color:var(--accent);}
  .shogi-promo-back{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:50;}
  .shogi-promo{background:var(--panel);border:1px solid var(--accent);border-radius:12px;padding:18px 20px;text-align:center;max-width:260px;}
  .shogi-promo h4{margin:0 0 10px;font-family:var(--jp);color:var(--accent);}
  .shogi-promo .row{display:flex;gap:10px;justify-content:center;}
  `;

  function injectCSS() {
    if (typeof document === "undefined") return;
    if (document.getElementById("shogi-css")) return;
    const st = document.createElement("style");
    st.id = "shogi-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function init(container) {
    injectCSS();

    const S = {
      snapshots: [createGame()],
      log: [],
      mode: "hvai",       // hvh | hvai | aiai
      aiSide: 1,          // side the AI plays in hvai
      strength: 2,        // 1 easy, 2 medium, 3 hard
      flipped: false,
      selected: null,     // {kind:'board',sq} | {kind:'drop',t}
      selMoves: [],
      legalAll: [],
      lastMove: null,
      gameOver: false,
      result: null,       // {text, cls}
      thinking: false,
      aiRunning: false,   // aiai loop
      aiDelay: 600,
      aiTimer: null,
      aiSeq: 0,
      els: {}
    };

    const cur = () => S.snapshots[S.snapshots.length - 1];

    /* ---------- DOM skeleton ---------- */
    const root = el("div", "shogi-root");

    // controls
    const controls = el("div", "shogi-controls");
    const modeSeg = seg([["hvh", "人 対 人"], ["hvai", "人 対 AI"], ["aiai", "AI 対 AI"]], S.mode, (v) => { S.mode = v; onModeChange(); });
    const sideGrp = el("div", "grp");
    sideGrp.appendChild(labelEl("AI"));
    const sideSeg = seg([["0", "先手"], ["1", "後手"]], String(S.aiSide), (v) => { S.aiSide = +v; newGame(); });
    sideGrp.appendChild(sideSeg);
    const strGrp = el("div", "grp");
    strGrp.appendChild(labelEl("強さ"));
    const strSeg = seg([["1", "弱"], ["2", "中"], ["3", "強"]], String(S.strength), (v) => { S.strength = +v; });
    strGrp.appendChild(strSeg);

    const aiaiGrp = el("div", "grp");
    const startBtn = btn("開始", "btn-accent", toggleAiai);
    const delayGrp = el("div", "grp");
    delayGrp.appendChild(labelEl("間隔"));
    const delayRange = el("input", "shogi-range");
    delayRange.type = "range"; delayRange.min = "300"; delayRange.max = "1200"; delayRange.step = "100"; delayRange.value = String(S.aiDelay);
    delayRange.addEventListener("input", () => { S.aiDelay = +delayRange.value; });
    delayGrp.appendChild(delayRange);
    aiaiGrp.appendChild(startBtn); aiaiGrp.appendChild(delayGrp);

    controls.appendChild(modeSeg);
    controls.appendChild(sideGrp);
    controls.appendChild(strGrp);
    controls.appendChild(aiaiGrp);
    root.appendChild(controls);

    // play column
    const play = el("div", "shogi-play");
    const handTop = el("div", "shogi-hand");
    const boardwrap = el("div", "shogi-boardwrap");
    const files = el("div", "shogi-files");
    const ranks = el("div", "shogi-ranks");
    const board = el("div", "shogi-board");
    boardwrap.appendChild(files); boardwrap.appendChild(ranks); boardwrap.appendChild(board);
    const handBot = el("div", "shogi-hand");
    play.appendChild(handTop); play.appendChild(boardwrap); play.appendChild(handBot);
    root.appendChild(play);

    // side column
    const side = el("div", "shogi-side");
    const banner = el("div", "shogi-banner");
    const statusP = el("div", "panel");
    statusP.appendChild(el("div", "panel-h", "対局 · Status"));
    const status = el("div", "shogi-status");
    statusP.appendChild(status);
    const btnrow = el("div", "shogi-btnrow");
    btnrow.appendChild(btn("新局", "btn", newGame));
    btnrow.appendChild(btn("待った", "btn", undo));
    btnrow.appendChild(btn("投了", "btn", resign));
    btnrow.appendChild(btn("反転", "btn", () => { S.flipped = !S.flipped; render(); }));
    const logP = el("div", "panel");
    logP.appendChild(el("div", "panel-h", "棋譜 · Moves"));
    const logList = el("ol", "shogi-log");
    logP.appendChild(logList);
    side.appendChild(banner);
    side.appendChild(statusP);
    side.appendChild(btnrow);
    side.appendChild(logP);
    root.appendChild(side);

    container.appendChild(root);

    S.els = { board: board, files: files, ranks: ranks, handTop: handTop, handBot: handBot,
      status: status, banner: banner, log: logList, sideSeg: sideSeg, aiaiGrp: aiaiGrp,
      sideGrp: sideGrp, startBtn: startBtn };

    // build 81 cells once, wire delegated clicks
    const cells = [];
    for (let i = 0; i < 81; i++) {
      const c = el("button", "shogi-cell");
      c.type = "button";
      c.dataset.i = i;
      cells.push(c);
    }
    S.cells = cells;
    board.addEventListener("click", (e) => {
      const c = e.target.closest(".shogi-cell");
      if (!c) return;
      onCellClick(+c.dataset.i);
    });
    handTop.addEventListener("click", onHandClick);
    handBot.addEventListener("click", onHandClick);

    /* ---------- control helpers ---------- */
    function seg(opts, val, cb) {
      const box = el("div", "seg");
      opts.forEach(([v, label]) => {
        const b = el("button", v === val ? "active" : "", label);
        b.type = "button";
        b.dataset.v = v;
        b.addEventListener("click", () => {
          [...box.children].forEach((x) => x.classList.toggle("active", x === b));
          cb(v);
        });
        box.appendChild(b);
      });
      return box;
    }
    function labelEl(t) { const l = el("label", "lbl", t); return l; }
    function btn(t, cls, cb) { const b = el("button", "btn " + (cls === "btn-accent" ? "btn-accent" : ""), t); b.type = "button"; b.addEventListener("click", cb); return b; }

    /* ---------- interaction ---------- */
    function isHumanControlled(sd) {
      if (S.mode === "hvh") return true;
      if (S.mode === "aiai") return false;
      return sd !== S.aiSide;
    }
    function humanTurn() {
      return !S.gameOver && !S.thinking && isHumanControlled(cur().turn);
    }

    function clearSel() { S.selected = null; S.selMoves = []; }

    function onCellClick(sq) {
      if (!humanTurn()) return;
      const st = cur();
      if (S.selected) {
        const opts = S.selMoves.filter((m) => m.to === sq);
        if (opts.length) { resolveAndMove(opts); return; }
      }
      const p = st.board[sq];
      if (p && p.s === st.turn) {
        S.selected = { kind: "board", sq: sq };
        S.selMoves = S.legalAll.filter((m) => !m.drop && m.from === sq);
        render();
        return;
      }
      clearSel(); render();
    }

    function onHandClick(e) {
      if (!humanTurn()) return;
      const hp = e.target.closest(".hand-piece");
      if (!hp || !hp.dataset.t) return;
      const sd = +hp.dataset.s;
      const st = cur();
      if (sd !== st.turn) return;
      const t = hp.dataset.t;
      S.selected = { kind: "drop", t: t };
      S.selMoves = S.legalAll.filter((m) => m.drop && m.dropType === t);
      render();
    }

    function resolveAndMove(opts) {
      if (opts.length === 1) { doMove(opts[0]); return; }
      // two options: promote / non-promote
      showPromoDialog((promote) => {
        const m = opts.find((x) => !!x.promote === promote) || opts[0];
        doMove(m);
      });
    }

    function showPromoDialog(cb) {
      const back = el("div", "shogi-promo-back");
      const box = el("div", "shogi-promo");
      box.appendChild(el("h4", null, "成りますか？"));
      const row = el("div", "row");
      const yes = el("button", "btn btn-accent", "成 (promote)");
      const no = el("button", "btn", "不成 (keep)");
      yes.type = no.type = "button";
      yes.addEventListener("click", () => { document.body.removeChild(back); cb(true); });
      no.addEventListener("click", () => { document.body.removeChild(back); cb(false); });
      row.appendChild(yes); row.appendChild(no);
      box.appendChild(row);
      back.appendChild(box);
      document.body.appendChild(back);
    }

    /* ---------- move application ---------- */
    function doMove(m) {
      const st = cur();
      const notation = moveNotation(st, m);
      const mover = st.turn;
      const next = applyMove(st, m);
      S.snapshots.push(next);
      S.log.push({ side: mover, text: notation });
      S.lastMove = { from: m.drop ? -1 : m.from, to: m.to };
      clearSel();
      afterMove();
    }

    function afterMove() {
      const st = cur();
      S.legalAll = genLegalMoves(st);
      // repetition
      if (checkRepetition()) {
        endGame({ text: "千日手 — Draw (repetition)", cls: "draw" });
        render(); return;
      }
      if (S.legalAll.length === 0) {
        const check = isKingAttacked(st, st.turn);
        const winner = 1 - st.turn;
        const wname = winner === 0 ? "先手 Sente" : "後手 Gote";
        endGame({ text: (check ? "詰み Checkmate — " : "行き詰まり — ") + wname + " wins", cls: "win" });
        render(); return;
      }
      render();
      maybeAI();
    }

    function checkRepetition() {
      const key = posKey(cur());
      let n = 0;
      for (let i = 0; i < S.snapshots.length; i++) {
        if (posKey(S.snapshots[i]) === key) n++;
      }
      return n >= 4;
    }

    function endGame(result) {
      S.gameOver = true;
      S.result = result;
      S.aiRunning = false;
      S.aiSeq++;
      clearTimeout(S.aiTimer); S.aiTimer = null;
      S.thinking = false;
    }

    /* ---------- AI scheduling ---------- */
    function maybeAI() {
      clearTimeout(S.aiTimer); S.aiTimer = null;
      if (S.gameOver) return;
      const st = cur();
      let isAI = false, delay = 280;
      if (S.mode === "aiai") { if (!S.aiRunning) return; isAI = true; delay = S.aiDelay; }
      else if (S.mode === "hvai") { if (st.turn === S.aiSide) { isAI = true; delay = 260; } }
      if (!isAI) return;
      S.thinking = true;
      renderStatus();
      const seq = S.aiSeq;
      S.aiTimer = setTimeout(() => {
        if (seq !== S.aiSeq || S.gameOver) return;
        const depth = S.strength;
        const tms = depth >= 3 ? 1500 : depth === 2 ? 900 : 350;
        const work = cloneState(cur());
        let m = null;
        try { m = chooseAIMove(work, depth, tms); } catch (err) { console.error(err); }
        S.thinking = false;
        if (!m) { afterMove(); return; }
        doMove(m);
      }, delay);
    }

    function toggleAiai() {
      if (S.mode !== "aiai") return;
      S.aiRunning = !S.aiRunning;
      S.els.startBtn.textContent = S.aiRunning ? "停止" : "開始";
      if (S.aiRunning) maybeAI(); else { clearTimeout(S.aiTimer); S.aiTimer = null; S.thinking = false; renderStatus(); }
    }

    /* ---------- buttons ---------- */
    function newGame() {
      clearTimeout(S.aiTimer); S.aiTimer = null;
      S.aiSeq++;
      S.snapshots = [createGame()];
      S.log = [];
      S.lastMove = null;
      S.gameOver = false;
      S.result = null;
      S.thinking = false;
      S.aiRunning = false;
      S.els.startBtn.textContent = "開始";
      clearSel();
      S.legalAll = genLegalMoves(cur());
      render();
      maybeAI();
    }

    function undo() {
      if (S.thinking) return;
      const back = (S.mode === "hvai") ? 2 : 1;
      for (let k = 0; k < back && S.snapshots.length > 1; k++) {
        S.snapshots.pop();
        S.log.pop();
      }
      S.gameOver = false; S.result = null;
      S.aiRunning = false; S.els.startBtn.textContent = "開始";
      S.aiSeq++;
      clearTimeout(S.aiTimer); S.aiTimer = null;
      S.lastMove = null;
      clearSel();
      S.legalAll = genLegalMoves(cur());
      render();
    }

    function resign() {
      if (S.gameOver) return;
      const loser = cur().turn;
      const winner = 1 - loser;
      const wname = winner === 0 ? "先手 Sente" : "後手 Gote";
      endGame({ text: "投了 Resignation — " + wname + " wins", cls: "win" });
      render();
    }

    function onModeChange() {
      S.els.sideGrp.style.display = S.mode === "hvai" ? "flex" : "none";
      S.els.aiaiGrp.style.display = S.mode === "aiai" ? "flex" : "none";
      newGame();
    }

    /* ---------- rendering ---------- */
    function displayOrder() {
      // returns arrays of rows and cols in display order
      const rows = [], cols = [];
      if (!S.flipped) { for (let r = 0; r < 9; r++) rows.push(r); for (let c = 0; c < 9; c++) cols.push(c); }
      else { for (let r = 8; r >= 0; r--) rows.push(r); for (let c = 8; c >= 0; c--) cols.push(c); }
      return { rows: rows, cols: cols };
    }

    function render() {
      const st = cur();
      const ord = displayOrder();

      // files header (file numbers over columns)
      S.els.files.innerHTML = "";
      for (let ci = 0; ci < 9; ci++) {
        S.els.files.appendChild(el("span", null, String(9 - ord.cols[ci])));
      }
      // rank labels
      S.els.ranks.innerHTML = "";
      for (let ri = 0; ri < 9; ri++) {
        S.els.ranks.appendChild(el("span", null, RANK_JP[ord.rows[ri]]));
      }

      // dest set with capture flag
      const destMap = {};
      if (S.selected) S.selMoves.forEach((m) => { destMap[m.to] = destMap[m.to] || (!m.drop && !!st.board[m.to]); });

      const checkSq = (S.legalAll && isKingAttacked(st, st.turn)) ? findKing(st.board, st.turn) : -1;
      const human = humanTurn();

      // place cells in display order
      S.els.board.innerHTML = "";
      for (let ri = 0; ri < 9; ri++) {
        for (let ci = 0; ci < 9; ci++) {
          const sq = ord.rows[ri] * 9 + ord.cols[ci];
          const c = S.cells[sq];
          c.className = "shogi-cell";
          c.innerHTML = "";
          const p = st.board[sq];
          if (p) {
            const rot = S.flipped ? p.s === 0 : p.s === 1;
            const span = el("span", "shogi-piece" + (p.s === 1 ? " gote" : "") + (rot ? " rot" : ""), kanjiOf(p));
            c.appendChild(span);
          }
          if (S.selected && S.selected.kind === "board" && S.selected.sq === sq) c.classList.add("sel");
          if (sq in destMap) { c.classList.add("dest"); if (destMap[sq]) c.classList.add("cap"); }
          if (S.lastMove && (S.lastMove.to === sq || S.lastMove.from === sq)) c.classList.add("last");
          if (sq === checkSq) c.classList.add("check");
          // clickable?
          let clickable = false;
          if (human) {
            if (sq in destMap) clickable = true;
            else if (p && p.s === st.turn) clickable = true;
          }
          if (clickable) c.classList.add("clickable");
          S.els.board.appendChild(c);
        }
      }

      renderHands();
      renderStatus();
      renderLog();
    }

    function renderHands() {
      const st = cur();
      // top hand shows the side at top of board; bottom hand shows bottom side.
      const topSide = S.flipped ? 0 : 1;
      const botSide = S.flipped ? 1 : 0;
      fillHand(S.els.handTop, topSide, st);
      fillHand(S.els.handBot, botSide, st);
    }

    function fillHand(box, sd, st) {
      box.innerHTML = "";
      box.classList.toggle("turn", !S.gameOver && st.turn === sd);
      const name = sd === 0 ? "先手 持駒" : "後手 持駒";
      box.appendChild(el("span", "hlbl", name));
      const ord = ["R", "B", "G", "S", "N", "L", "P"];
      const hand = st.hands[sd];
      const human = humanTurn();
      let any = false;
      for (let k = 0; k < ord.length; k++) {
        const t = ord[k];
        if (!hand[t]) continue;
        any = true;
        const clickable = human && st.turn === sd;
        const hp = el("div", "hand-piece" + (clickable ? " clickable" : "") +
          (S.selected && S.selected.kind === "drop" && S.selected.t === t && st.turn === sd ? " sel" : ""));
        hp.dataset.t = t; hp.dataset.s = sd;
        hp.appendChild(el("span", "k", KANJI[t]));
        hp.appendChild(el("span", "n", "×" + hand[t]));
        box.appendChild(hp);
      }
      if (!any) box.appendChild(el("span", "n", "—"));
    }

    function renderStatus() {
      const st = cur();
      const turnName = st.turn === 0
        ? '<span class="turn-s">先手 Sente</span>'
        : '<span class="turn-g">後手 Gote</span>';
      let html = "手番 Turn: " + turnName + "<br>";
      html += "手数 Ply: " + (S.snapshots.length - 1) + "<br>";
      const inCheck = isKingAttacked(st, st.turn);
      if (!S.gameOver && inCheck) html += '<span class="shogi-check">王手！ Check</span><br>';
      if (S.thinking) html += '<span class="shogi-think">思考中… thinking</span>';
      S.els.status.innerHTML = html;

      const b = S.els.banner;
      if (S.gameOver && S.result) {
        b.className = "shogi-banner show " + (S.result.cls || "win");
        b.textContent = S.result.text;
      } else {
        b.className = "shogi-banner";
        b.textContent = "";
      }
    }

    function renderLog() {
      const list = S.els.log;
      list.innerHTML = "";
      for (let i = 0; i < S.log.length; i++) {
        const li = el("li");
        li.appendChild(el("span", "mn", String(i + 1)));
        const mark = S.log[i].side === 0 ? "▲" : "△";
        li.appendChild(el("span", "mv", mark + " " + S.log[i].text));
        list.appendChild(li);
      }
      list.scrollTop = list.scrollHeight;
    }

    /* ---------- boot ---------- */
    S.els.sideGrp.style.display = S.mode === "hvai" ? "flex" : "none";
    S.els.aiaiGrp.style.display = S.mode === "aiai" ? "flex" : "none";
    S.legalAll = genLegalMoves(cur());
    render();
    maybeAI();

    // cleanup
    return function destroy() {
      S.aiSeq++;
      S.aiRunning = false;
      clearTimeout(S.aiTimer);
      S.aiTimer = null;
      const back = document.querySelector(".shogi-promo-back");
      if (back && back.parentNode) back.parentNode.removeChild(back);
    };
  }

  /* ------------------------------------------------------------------ */
  /*  registration / exports                                             */
  /* ------------------------------------------------------------------ */
  if (typeof window !== "undefined") {
    window.GAMES = window.GAMES || {};
    window.GAMES.shogi = {
      title: "Shogi", jp: "将棋",
      blurb: "Japanese chess. Captured pieces return to play as drops.",
      tag: "9×9 · drops · promotion", hue: "#eab308", glow: "rgba(234,179,8,0.20)",
      init: init
    };
  }

  if (typeof module !== "undefined") {
    module.exports = {
      createGame: createGame,
      cloneState: cloneState,
      genPseudoMoves: genPseudoMoves,
      genLegalMoves: genLegalMoves,
      makeMove: makeMove,
      unmakeMove: unmakeMove,
      applyMove: applyMove,
      isKingAttacked: isKingAttacked,
      isSquareAttacked: isSquareAttacked,
      getStatus: getStatus,
      chooseAIMove: chooseAIMove,
      evaluate: evaluate,
      posKey: posKey,
      sqName: sqName,
      moveNotation: moveNotation,
      findKing: findKing,
      VAL: VAL
    };
  }
})();
