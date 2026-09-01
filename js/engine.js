/* =========================================================================
   Ludora — engine.js
   Pure Ludo rules engine. No DOM, no timers, no randomness policy:
   dice values are supplied by the caller so the UI can use crypto-grade
   randomness and tests can be deterministic.

   Coordinate model
   ----------------
   15×15 grid. A 52-cell ring, each player enters at its start cell,
   walks 51 ring cells (pos 0..50), then its 5-cell home lane
   (pos 51..55), then HOME (pos 56). YARD is pos -1.

   Ring index 0 = red start (bottom-left, cell 6,13). Each next player
   starts 13 cells later. Safe cells = the four starts + the four cells
   eight steps after each start.
   ========================================================================= */
(function (global) {
  'use strict';

  var COLORS = ['red', 'green', 'yellow', 'blue'];
  /* [col,row] pairs, clockwise. Verified: 52 unique cells. */
  var RING = [
    [6,13],[6,12],[6,11],[6,10],[6,9],            // 0-4   red arm, left column (0 = red start)
    [5,8],[4,8],[3,8],[2,8],[1,8],[0,8],          // 5-10  bottom row of left arm
    [0,7],                                        // 11    left tip   (green pre-lane)
    [0,6],[1,6],[2,6],[3,6],[4,6],[5,6],          // 12-17 top row of left arm (13 = green start)
    [6,5],[6,4],[6,3],[6,2],[6,1],[6,0],          // 18-23 left column of top arm
    [7,0],                                        // 24    top tip    (yellow pre-lane)
    [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],          // 25-30 right column of top arm (26 = yellow start)
    [9,6],[10,6],[11,6],[12,6],[13,6],[14,6],     // 31-36 top row of right arm
    [14,7],                                       // 37    right tip  (blue pre-lane)
    [14,8],                                       // 38
    [13,8],[12,8],[11,8],[10,8],[9,8],            // 39-43 bottom row of right arm (39 = blue start)
    [8,9],[8,10],[8,11],[8,12],[8,13],[8,14],     // 44-49 right column of bottom arm
    [7,14],                                       // 50    bottom tip (red pre-lane)
    [6,14]                                        // 51    → wraps to 0
  ];
  var START  = [0, 13, 26, 39];
  var SAFE   = { 0:true, 8:true, 13:true, 21:true, 26:true, 34:true, 39:true, 47:true };
  var LANE = [
    [[7,13],[7,12],[7,11],[7,10],[7,9]],   // red    (bottom)
    [[1,7],[2,7],[3,7],[4,7],[5,7]],       // green  (left)
    [[7,1],[7,2],[7,3],[7,4],[7,5]],       // yellow (top)
    [[13,7],[12,7],[11,7],[10,7],[9,7]]    // blue   (right)
  ];
  var YARD = -1, HOME = 56, LAST_RING_POS = 50, FIRST_LANE_POS = 51;
  var MODES = ['quick', 'pass', 'daily', 'online'];

  function absCell(colorIdx, pos) {
    if (pos < 0 || pos > LAST_RING_POS) return null;
    return (START[colorIdx] + pos) % 52;
  }

  /* Grid cell [col,row] for a token position (pos 56 → null, use homePoint). */
  function posToCell(colorIdx, pos) {
    if (pos === YARD) return null;
    if (pos === HOME) return null;
    if (pos <= LAST_RING_POS) return RING[absCell(colorIdx, pos)];
    return LANE[colorIdx][pos - FIRST_LANE_POS];
  }

  /* Interpolated path positions a token travels from → to (inclusive). */
  function pathPositions(from, to) {
    if (from === YARD) return [0];
    var out = [];
    for (var p = from + 1; p <= to; p++) out.push(p);
    return out.length ? out : [to];
  }

  function newStats() {
    return { rolls:0, sixes:0, captures:0, timesCaptured:0, turns:0, homes:0 };
  }

  /* seats: [{color:0..3, kind:'human'|'ai', name, ai:0|1|2|null}] (2..4, unique colors) */
  function createGame(cfg) {
    if (!cfg || !Array.isArray(cfg.seats) || cfg.seats.length < 2 || cfg.seats.length > 4) {
      throw new Error('engine: need 2-4 seats');
    }
    var seats = cfg.seats
      .map(function (s, i) {
        return {
          i: i, color: s.color | 0, kind: s.kind === 'ai' ? 'ai' : 'human',
          name: String(s.name || ('Player ' + (i + 1))).slice(0, 18),
          ai: s.kind === 'ai' ? (s.ai | 0) : null
        };
      })
      .sort(function (a, b) { return a.color - b.color; })
      .map(function (s, i) { s.i = i; return s; });
    var colors = seats.map(function (s) { return s.color; });
    for (var c = 0; c < colors.length; c++) {
      if (colors[c] < 0 || colors[c] > 3 || colors.indexOf(colors[c]) !== c) {
        throw new Error('engine: seat colors must be unique 0..3');
      }
    }
    /* normalize teams → { seatIndex: teamIdx }. `cfg.teams` is an array of
       seat-index lists, e.g. [[0,2],[1,3]] = P1+P3 vs P2+P4. Also accepts
       {seatIdx: teamIdx}. */
    var TEAM = null;
    if (cfg.teams) {
      TEAM = {};
      if (Array.isArray(cfg.teams)) {
        cfg.teams.forEach(function (list, ti) {
          (list || []).forEach(function (idx) { TEAM[idx | 0] = ti; });
        });
      } else {
        Object.keys(cfg.teams).forEach(function (idx) { TEAM[idx | 0] = cfg.teams[idx]; });
      }
    }
    var st = {
      v: 1,
      mode: MODES.indexOf(cfg.mode) >= 0 ? cfg.mode : 'quick',
      rules: {
        firstToCaptures: (cfg.rules && cfg.rules.firstToCaptures) || 0,
        daily: !!(cfg.rules && cfg.rules.daily),
        headStart: (cfg.rules && cfg.rules.headStart) || null,
        /* team-up variant */
        teamHomeTarget: (cfg.rules && cfg.rules.teamHomeTarget) || 8,
        teamCaptureTarget: (cfg.rules && cfg.rules.teamCaptureTarget) || 0
      },
      seats: seats,
      tokens: seats.map(function (s) { return [YARD, YARD, YARD, YARD]; }),
      turn: 0,
      phase: 'roll',            // 'roll' | 'move' | 'over'
      lastRoll: null,
      sixChain: 0,              // consecutive sixes within the current turn
      winner: null,
      teamWin: null,            // 0 | 1 | null  (winner team in team mode)
      team: (TEAM ? seats.map(function (s) { return TEAM[s.color] != null ? TEAM[s.color] : null; }) : null),
      teamName: (cfg.teamNames ? cfg.teamNames.slice(0, 2) : ['Team A', 'Team B']),
      rankings: null,
      stats: seats.map(function () { return newStats(); }),
      moveNo: 0,
      startedAt: Date.now()
    };
    if (st.rules.headStart) {
      var hs = st.rules.headStart; // { seatColor: [4 positions] }
      seats.forEach(function (s) {
        if (hs[s.color]) {
          for (var t = 0; t < 4; t++) {
            var p = hs[s.color][t];
            if (typeof p === 'number' && p >= YARD && p <= LAST_RING_POS) st.tokens[s.i][t] = p;
          }
        }
      });
    }
    return st;
  }

  function tokenAbs(st, seatIdx, tokenIdx) {
    return absCell(st.seats[seatIdx].color, st.tokens[seatIdx][tokenIdx]);
  }

  /* All legal moves for the current player + a dice value.
     Returns [{ token, from, to, captures:[{seat,token}], home, release }] */
  function legalMoves(st, roll) {
    if (st.phase === 'over' || st.winner !== null) return [];
    var seatIdx = st.turn, color = st.seats[seatIdx].color;
    var out = [];
    for (var t = 0; t < 4; t++) {
      var from = st.tokens[seatIdx][t];
      if (from === HOME) continue;
      if (from === YARD) {
        if (roll === 6) out.push(makeMove(st, seatIdx, t, 0));
        continue;
      }
      var to = from + roll;
      if (to <= HOME) out.push(makeMove(st, seatIdx, t, to));
    }
    return out;
  }

  function makeMove(st, seatIdx, tokenIdx, to) {
    var from = st.tokens[seatIdx][tokenIdx];
    var captures = [];
    if (to <= LAST_RING_POS) {
      var c = absCell(st.seats[seatIdx].color, to);
      if (!SAFE[c]) {
        for (var s = 0; s < st.seats.length; s++) {
          if (s === seatIdx) continue;
          for (var t = 0; t < 4; t++) {
            if (st.tokens[s][t] >= 0 && st.tokens[s][t] <= LAST_RING_POS &&
                tokenAbs(st, s, t) === c) {
              captures.push({ seat: s, token: t });
            }
          }
        }
      }
    }
    return {
      token: tokenIdx, from: from, to: to, captures: captures,
      home: to === HOME, release: from === YARD
    };
  }

  /* A move is legal only by the engine's own rules — callers are never
     trusted. Throws on anything else. */
  function assertMoveLegal(st, seatIdx, move) {
    if (!move || typeof move !== 'object') throw new Error('engine: move must be an object');
    if (!isInt2(move.token, 0, 3)) throw new Error('engine: bad token index');
    if (!isInt2(move.to, 0, HOME)) throw new Error('engine: bad destination');
    var from = st.tokens[seatIdx][move.token];
    if (from !== move.from) throw new Error('engine: move does not match token position');
    if (from === HOME) throw new Error('engine: token already home');
    if (from === YARD) {
      if (move.to !== 0) throw new Error('engine: release must land on start');
      return true;
    }
    var d = move.to - from;
    if (d < 1 || d > 6) throw new Error('engine: impossible roll distance ' + d);
    return true;
  }

  /* ---- team helpers (team mode only) ---- */
  function teamSeats(st, team) {
    var out = [];
    st.seats.forEach(function (s, i) { if (st.team[i] === team) out.push(i); });
    return out;
  }
  function teamProgress(st, team) {
    var sum = 0;
    teamSeats(st, team).forEach(function (i) { sum += progress(st, i); });
    return sum;
  }
  function teamHomes(st, team) {
    var sum = 0;
    teamSeats(st, team).forEach(function (i) {
      st.tokens[i].forEach(function (p) { if (p === HOME) sum++; });
    });
    return sum;
  }
  function teamCaptures(st, team) {
    var c = 0;
    teamSeats(st, team).forEach(function (i) { c += st.stats[i].captures; });
    return c;
  }
  function teamIsWin(st, team) {
    if (st.rules.teamHomeTarget && teamHomes(st, team) >= st.rules.teamHomeTarget) return true;
    if (st.rules.teamCaptureTarget && teamCaptures(st, team) >= st.rules.teamCaptureTarget) return true;
    return false;
  }
  function teamMembersOf(st, seatIdx) {
    if (!st.team || st.team[seatIdx] == null) return [seatIdx];
    return teamSeats(st, st.team[seatIdx]);
  }

  /* Applies a move from legalMoves(). Independently re-verified before the
     state changes — illegal input throws and mutates nothing. */
  function applyMove(st, move) {
    var seatIdx = st.turn;
    assertMoveLegal(st, seatIdx, move);
    st.moveNo++;
    st.tokens[seatIdx][move.token] = move.to;
    var verified = makeMove(st, seatIdx, move.token, move.to);   // effects recomputed here
    verified.captures.forEach(function (cap) {
      st.tokens[cap.seat][cap.token] = YARD;
      st.stats[seatIdx].captures++;
      st.stats[cap.seat].timesCaptured++;
    });
    if (verified.home) st.stats[seatIdx].homes++;
    var events = {
      seat: seatIdx,
      move: { token: move.token, from: move.from, to: move.to,
              captures: verified.captures, release: verified.release },
      path: pathPositions(move.from, move.to),
      captures: verified.captures, home: verified.home,
      win: false, teamWin: null, rankings: null
    };
    var teamIdx = (st.team && st.team[seatIdx] != null) ? st.team[seatIdx] : null;
    if (teamIdx != null) {
      /* team mode: only the team objective ends the match; an individual
         finishing all four only contributes to the team's condition. */
      if (teamIsWin(st, teamIdx)) {
        st.winner = seatIdx;
        st.teamWin = teamIdx;
        st.phase = 'over';
        st.rankings = rankPlayers(st, seatIdx, teamIdx);
        events.win = true;
        events.teamWin = teamIdx;
        events.rankings = st.rankings;
      }
    } else if (isWin(st, seatIdx)) {
      st.winner = seatIdx;
      st.teamWin = null;
      st.phase = 'over';
      st.rankings = rankPlayers(st, seatIdx);
      events.win = true;
      events.rankings = st.rankings;
    }
    return events;
  }

  function isWin(st, seatIdx) {
    var target = st.rules.firstToCaptures;
    if (target && st.stats[seatIdx].captures >= target) return true;
    var toks = st.tokens[seatIdx];
    return toks[0] === HOME && toks[1] === HOME && toks[2] === HOME && toks[3] === HOME;
  }

  function progress(st, seatIdx) {
    var sum = 0;
    st.tokens[seatIdx].forEach(function (p) {
      sum += (p === YARD ? 0 : (p === HOME ? 57 : p + 1));
    });
    return sum;
  }

  /* Winner first, everyone else by progress (max 228).
     In team mode (teamWin given) the winning team's members all rank first. */
  function rankPlayers(st, winnerIdx, teamWin) {
    var rows = st.seats.map(function (s, i) {
      return { seat: i, progress: progress(st, i), captures: st.stats[i].captures, team: st.team ? st.team[i] : null };
    });
    rows.sort(function (a, b) {
      if (teamWin != null) {
        var at = a.team, bt = b.team;
        if (at === teamWin && bt !== teamWin) return -1;
        if (bt === teamWin && at !== teamWin) return 1;
        if (at !== null && bt !== null && at !== bt) return (b.progress - a.progress) || (a.seat - b.seat);
      } else {
        if (a.seat === winnerIdx) return -1;
        if (b.seat === winnerIdx) return 1;
      }
      return (b.progress - a.progress) || (b.captures - a.captures) || (a.seat - b.seat);
    });
    return rows.map(function (r) { return r.seat; });
  }

  /* Register a roll value. Returns {forfeit} when a third consecutive six
     burns the turn (classic rule — the third six is void, no move happens). */
  function registerRoll(st, value) {
    st.stats[st.turn].rolls++;
    st.lastRoll = value;
    if (value === 6) {
      st.stats[st.turn].sixes++;
      st.sixChain++;
    } else {
      st.sixChain = 0;
    }
    if (st.sixChain >= 3) {
      st.sixChain = 0;
      return { value: value, forfeit: true };
    }
    return { value: value, forfeit: false };
  }

  /* Move the turn along. extra=true keeps the seat (six / capture / home). */
  function endTurn(st, extra) {
    if (st.phase === 'over') return;
    if (extra) {
      st.phase = 'roll';
    } else {
      st.sixChain = 0;
      st.turn = (st.turn + 1) % st.seats.length;
      st.phase = 'roll';
    }
    if (STRICT) assertInvariants(st);
  }

  function beginsTurn(st) { st.stats[st.turn].turns++; }

  /* ---------- persistence / remote-state validation ----------
     Paranoid by design: guards local saves AND every multiplayer packet.
     Rejects NaN/Infinity, non-integers, out-of-range values and impossible
     phase/turn/winner combinations. 'anim' is a legal *wire* phase (hosts
     broadcast mid-animation); it is never persisted (save() skips it). */
  function isInt2(v, lo, hi) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v &&
           v >= lo && (hi === undefined || v <= hi);
  }
  function validateState(obj) {
    try {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.v !== 1) return null;
      if (MODES.indexOf(obj.mode) < 0) return null;
      if (!Array.isArray(obj.seats) || obj.seats.length < 2 || obj.seats.length > 4) return null;
      var prevColor = -1;
      for (var s = 0; s < obj.seats.length; s++) {
        var seat = obj.seats[s];
        if (!seat || typeof seat.name !== 'string' || seat.name.length < 1 || seat.name.length > 32) return null;
        if (seat.kind !== 'human' && seat.kind !== 'ai') return null;
        if (!isInt2(seat.color, 0, 3)) return null;
        if (seat.color <= prevColor) return null;          // seats stored color-sorted, unique
        prevColor = seat.color;
        if (!isInt2(seat.i, s, s)) return null;
        if (seat.kind === 'ai' && !isInt2(seat.ai, 0, 2)) return null;
      }
      if (!Array.isArray(obj.tokens) || obj.tokens.length !== obj.seats.length) return null;
      for (var p = 0; p < obj.tokens.length; p++) {
        if (!Array.isArray(obj.tokens[p]) || obj.tokens[p].length !== 4) return null;
        for (var t = 0; t < 4; t++) {
          if (!isInt2(obj.tokens[p][t], -1, 56)) return null;
        }
      }
      if (!isInt2(obj.turn, 0, obj.seats.length - 1)) return null;
      if (['roll', 'move', 'anim', 'over'].indexOf(obj.phase) < 0) return null;
      if (obj.lastRoll !== null && !isInt2(obj.lastRoll, 1, 6)) return null;
      if (obj.phase === 'move' && !isInt2(obj.lastRoll, 1, 6)) return null;  // move requires a live roll
      if (!isInt2(obj.sixChain, 0, 2)) return null;
      if (obj.winner !== null && !isInt2(obj.winner, 0, obj.seats.length - 1)) return null;
      if (obj.winner !== null && obj.phase !== 'over') return null;          // winner only exists at 'over'
      if (obj.teamWin !== null && obj.teamWin !== undefined && !isInt2(obj.teamWin, 0, 1)) return null;
      if (obj.teamWin !== null && obj.teamWin !== undefined && obj.phase !== 'over') return null;
      if (obj.team != null) {
        if (!Array.isArray(obj.team) || obj.team.length !== obj.seats.length) return null;
        for (var tm = 0; tm < obj.team.length; tm++) {
          if (obj.team[tm] !== null && !isInt2(obj.team[tm], 0, 1)) return null;
        }
      }
      if (obj.teamName != null) {
        if (!Array.isArray(obj.teamName) || obj.teamName.length < 2 || obj.teamName.length > 2) return null;
        for (var tn = 0; tn < obj.teamName.length; tn++) {
          if (typeof obj.teamName[tn] !== 'string' || obj.teamName[tn].length < 1 || obj.teamName[tn].length > 24) return null;
        }
      }
      if (!isInt2(obj.moveNo, 0, 1e9)) return null;
      if (!isInt2(obj.startedAt, 0)) return null;
      if (!Array.isArray(obj.stats) || obj.stats.length !== obj.seats.length) return null;
      for (var k = 0; k < obj.stats.length; k++) {
        var st = obj.stats[k];
        if (!st || typeof st !== 'object') return null;
        ['rolls','sixes','captures','timesCaptured','turns','homes'].forEach(function (f) {
          if (!isInt2(st[f], 0)) throw 'bad';
        });
        if (st.sixes > st.rolls) throw 'bad';               // impossible: more sixes than rolls
      }
      if (obj.phase === 'over') {
        if (obj.winner === null) return null;
        var wtoks = obj.tokens[obj.winner], allHome = true;
        for (var w = 0; w < 4; w++) if (wtoks[w] !== HOME) allHome = false;
        if (!allHome && !(obj.rules && (obj.rules.firstToCaptures > 0 || obj.rules.endedByHost === true))) return null;
      }
      if (obj.rankings != null) {
        if (!Array.isArray(obj.rankings) || obj.rankings.length !== obj.seats.length) return null;
        var seenR = {};
        for (var r = 0; r < obj.rankings.length; r++) {
          if (!isInt2(obj.rankings[r], 0, obj.seats.length - 1)) return null;
          if (seenR[obj.rankings[r]]) return null;          // rankings are a permutation
          seenR[obj.rankings[r]] = true;
        }
      }
      if (obj.rules != null) {
        if (typeof obj.rules !== 'object') return null;
        if (obj.rules.firstToCaptures != null && !isInt2(obj.rules.firstToCaptures, 0, 12)) return null;  // 0 = variant off
        if (obj.rules.endedByHost != null && typeof obj.rules.endedByHost !== 'boolean') return null;
        if (obj.rules.headStart != null) {
          if (typeof obj.rules.headStart !== 'object') return null;
          for (var hs in obj.rules.headStart) {
            var arr = obj.rules.headStart[hs];
            if (!Array.isArray(arr) || arr.length !== 4) return null;
            for (var h2 = 0; h2 < 4; h2++) if (!isInt2(arr[h2], -1, LAST_RING_POS)) return null;
          }
        }
      }
      return obj;
    } catch (e) { return null; }
  }

  /* ---------- transition invariants (dev/test builds) ----------
     Enabled with setStrict(true): localhost, #debug and all test runs. */
  var STRICT = false;
  function assertInvariants(st) {
    if (!st || typeof st !== 'object') throw new Error('inv: no state');
    if (validateState(st) !== st) throw new Error('inv: validation failed (phase=' + st.phase + ')');
    for (var i = 0; i < st.seats.length; i++) {
      var pr = progress(st, i);
      if (!(pr >= 0 && pr <= 228)) throw new Error('inv: progress out of range (' + pr + ')');
    }
    if (st.phase === 'over' && st.rankings && st.rankings[0] !== st.winner) {
      throw new Error('inv: winner is not first in rankings');
    }
    return true;
  }

  global.LudoraEngine = {
    COLORS: COLORS, RING: RING, START: START, SAFE: SAFE, LANE: LANE,
    YARD: YARD, HOME: HOME, LAST_RING_POS: LAST_RING_POS, FIRST_LANE_POS: FIRST_LANE_POS,
    createGame: createGame,
    absCell: absCell, posToCell: posToCell, pathPositions: pathPositions,
    legalMoves: legalMoves, applyMove: applyMove, registerRoll: registerRoll,
    endTurn: endTurn, beginsTurn: beginsTurn,
    progress: progress, rankPlayers: rankPlayers, isWin: isWin,
    teamSeats: teamSeats, teamProgress: teamProgress, teamHomes: teamHomes,
    teamCaptures: teamCaptures, teamIsWin: teamIsWin, teamMembersOf: teamMembersOf,
    validateState: validateState, assertMoveLegal: assertMoveLegal,
    assertInvariants: assertInvariants, setStrict: function (v) { STRICT = v; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraEngine;
})(typeof window !== 'undefined' ? window : globalThis);
