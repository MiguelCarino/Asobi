# Carino Asobi （遊び）

Two traditional Japanese games in the browser — no install, no server, everything runs
client-side. Pick a game from the **slice-menu** chooser; it collapses to a tab bar once
you're in one.

## 将棋 Shogi

Full Japanese chess on a 9×9 board.

- **All rules**: every piece and its promotion (incl. 馬 horse / 竜 dragon king-steps),
  optional in-zone promotion (with a promote/keep prompt) and forced auto-promotion,
  captures-to-hand, and **drops** with every restriction — last-rank/two-rank bans, *nifu*
  (二歩), *uchifuzume* (打ち歩詰め, no pawn-drop mate), and no self-check. Checkmate = loss;
  *sennichite* (千日手, 4-fold repetition) = draw.
- **Three modes**: 人 対 人 (local two-player), 人 対 AI (choose 先手/後手), 人 対 AI …
  and 全 AI 対 AI (watch the engine play itself, with Start/Pause and a speed slider).
- **AI**: negamax + alpha-beta with move ordering and quiescence, material + positional
  evaluation, selectable strength (弱 / 中 / 強), time-capped so the board never hangs.
- Click a piece to see legal moves, two komadai for drops, move log, undo, resign, flip.

## 花札 Hanafuda — Koi-Koi （こいこい）

The classic flower-card game against the computer.

- Full **48-card deck** (12 months × 4: brights, animals, ribbons, chaff) rendered as
  color-coded tiles.
- Standard **yaku**: Gokō / Shikō / Ame-Shikō / Sankō, Ino-Shika-Chō, Aka-tan, Ao-tan,
  Tane, Tan, Kasu, Tsukimi-zake, Hanami-zake — with the press-your-luck **Koi-Koi vs Stop**
  decision and 7+/koi-koi score multipliers.
- Multi-round matches (3 / 6 / 12) with running score and alternating dealer, live yaku
  panels, and an AI that plays toward achievable yaku.

## Run it

Static site:

```bash
python3 -m http.server 8000
# open http://localhost:8000        (or #shogi / #hanafuda directly)
```

## Structure

```
index.html            # shell: Carino navbar + slice-menu chooser
css/styles.css        # gold-on-black design system + slice menu + UI helpers
js/app.js             # slice routing + mounts games into a host element
js/shogi.js           # self-contained Shogi (engine + AI + UI)
js/hanafuda.js        # self-contained Hanafuda Koi-Koi (core + AI + UI)
logo.svg
```

Each game registers itself as `window.GAMES[id] = { title, jp, blurb, tag, hue, init(el) }`.
Adding a game is one more file plus a `<script>` tag. Both engines are DOM-free at their
core and node-testable (`module.exports`), which is how they're validated:

- Shogi: exactly **30** legal opening moves, mate detection, and thousands of random plies
  without an illegal state.
- Hanafuda: deck is exactly **5 brights / 9 animals / 10 ribbons / 24 chaff**, every yaku
  scores correctly, and full self-play matches conserve all 48 cards.

## License

AGPL-3.0 — part of the [carino.systems](https://carino.systems/) workshop.
