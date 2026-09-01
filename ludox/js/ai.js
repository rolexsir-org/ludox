/* =========================================================================
   Ludora — ai.js
   Strategic Ludo opponent. Works purely on engine state; the AI never sees
   or influences dice — it only picks among the legal moves the engine
   returns, exactly like a human would.

   Difficulty:
     0 Easy   — noisy evaluation, often misses tactics
     1 Medium — solid evaluation, moderate noise
     2 Hard   — full evaluation incl. threat modelling, near-zero noise
   ========================================================================= */
(function (global) {
  'use strict';
  var E = global.LudoraEngine;

  /* Probability an opponent can land on ring cell `abs` next roll,
     from current token layout (each opponent token within 1..6 behind). */
  function threatAt(st, seatIdx, abs) {
    if (abs === null || E.SAFE[abs]) return 0;
    var p = 0;
    for (var s = 0; s < st.seats.length; s++) {
      if (s === seatIdx) continue;
      for (var t = 0; t < 4; t++) {
        var pos = st.tokens[s][t];
        if (pos < 0 || pos > E.LAST_RING_POS) continue; // yard / lane / home can't hit
        var oppAbs = E.absCell(st.seats[s].color, pos);
        var dist = (abs - oppAbs + 52) % 52;
        if (dist >= 1 && dist <= 6) {
          // the opponent must not overshoot its own ring exit with that roll
          if (pos + dist <= E.LAST_RING_POS) p += 1 / 6;
        }
      }
    }
    return Math.min(1, p);
  }

  function tokenValue(pos) { // how much a token is worth losing at `pos`
    return 4 + pos * 0.10;
  }

  function boardCount(st, seatIdx) {
    var n = 0;
    for (var t = 0; t < 4; t++) {
      var p = st.tokens[seatIdx][t];
      if (p >= 0 && p <= E.LAST_RING_POS) n++;
    }
    return n;
  }

  function evaluate(st, seatIdx, move, level) {
    var score = 0;
    var to = move.to, from = move.from || -1;

    // Captures: the deeper the victim had traveled, the better
    for (var i = 0; i < move.captures.length; i++) {
      var cap = move.captures[i];
      var victimPos = st.tokens[cap.seat][cap.token];
      score += 30 + (victimPos + 1) * 0.55;
    }
    if (move.home) score += 32;                                    // finish a token
    if (to >= E.FIRST_LANE_POS && from < E.FIRST_LANE_POS && from >= 0) score += 13; // enter lane = safe forever
    if (move.release) {
      score += boardCount(st, seatIdx) === 0 ? 24 : (level === 2 ? 11 : 7); // get out, don't waste sixes late
    }

    // Progress: prefer advancing tokens that are already ahead (lane > ring > fresh)
    score += (to - (from < 0 ? -1 : from)) * 0.32;
    score += to * 0.10;
    if (to >= E.FIRST_LANE_POS) score += (to - E.FIRST_LANE_POS + 1) * 0.35; // push deep in lane

    // Safety of destination
    if (to <= E.LAST_RING_POS) {
      var abs = E.absCell(st.seats[seatIdx].color, to);
      if (E.SAFE[abs]) score += 5;
      var danger = threatAt(st, seatIdx, abs);
      score -= danger * (tokenValue(to) + 5);
    }
    // Escaping an existing threat
    if (from >= 0 && from <= E.LAST_RING_POS) {
      var fromAbs = E.absCell(st.seats[seatIdx].color, from);
      score += threatAt(st, seatIdx, fromAbs) * (tokenValue(from) + 4) * 0.85;
    }

    // Endgame: when most tokens are home/laned, prioritize finishing
    var done = 0;
    for (var t2 = 0; t2 < 4; t2++) if (st.tokens[seatIdx][t2] > E.LAST_RING_POS) done++;
    if (level === 2 && done >= 2 && move.home) score += 8;

    return score;
  }

  var NOISE_OVERRIDE = null; // tests set 0 for deterministic AI
  function noise(level) {
    if (NOISE_OVERRIDE !== null) return NOISE_OVERRIDE;
    if (level === 0) return (Math.random() + Math.random() + Math.random()) * 14 - 21; // skewed, wild
    if (level === 1) return (Math.random() * 2 - 1) * 6.5;
    return (Math.random() * 2 - 1) * 0.4;
  }

  function thinkDelay(level) {
    if (level === 0) return 320 + Math.random() * 380;
    if (level === 1) return 420 + Math.random() * 420;
    return 520 + Math.random() * 560;
  }

  /* Pick a move. Returns the chosen move (already validated legal). */
  function chooseMove(st, seatIdx, roll, level) {
    var moves = E.legalMoves(st, roll);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var sc = evaluate(st, seatIdx, moves[i], level) + noise(level);
      if (sc > bestScore) { bestScore = sc; best = moves[i]; }
    }
    return best;
  }

  global.LudoraAI = {
    chooseMove: chooseMove,
    evaluate: evaluate,
    threatAt: threatAt,
    thinkDelay: thinkDelay,
    setNoise: function (v) { NOISE_OVERRIDE = v; },
    levels: [
      { id: 0, name: 'Easy' },
      { id: 1, name: 'Medium' },
      { id: 2, name: 'Hard' }
    ],
    names: ['Aria', 'Rohan', 'Mila', 'Kabir', 'Zara', 'Dev', 'Nina', 'Arjun', 'Tara', 'Vikram']
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraAI;
})(typeof window !== 'undefined' ? window : globalThis);
