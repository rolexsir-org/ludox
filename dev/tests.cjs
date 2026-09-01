/* Ludora — dev/tests.cjs · run: node dev/tests.cjs
   Note: createGame sorts seats by color, so [H(0), A(2,·)] → seat1 = yellow. */
'use strict';
const assert = require('assert');
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
require('../js/persist.js');
const Store = require('../js/store.js');
const P = require('../js/profile.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e && e.message || e)); }
}
function eq(a, b, m) { assert.deepStrictEqual(a, b, m); }

console.log('\nBOARD GEOMETRY');
t('ring has 52 unique cells', () => {
  eq(E.RING.length, 52);
  eq(new Set(E.RING.map(c => c.join(','))).size, 52);
});
t('start cells are 13 apart, adjacent to their yards', () => {
  eq(E.START, [0, 13, 26, 39]);
  eq(E.RING[0], [6, 13]);   // red   bottom-left
  eq(E.RING[13], [1, 6]);   // green top-left
  eq(E.RING[26], [8, 1]);   // yellow top-right
  eq(E.RING[39], [13, 8]);  // blue  bottom-right
});
t('pre-lane cell (pos 50) is each player’s own arm tip, adjacent to lane entry', () => {
  for (let c = 0; c < 4; c++) {
    const tip = E.RING[(E.START[c] + 50) % 52];
    const laneEntry = E.LANE[c][0];
    eq(Math.abs(tip[0] - laneEntry[0]) + Math.abs(tip[1] - laneEntry[1]), 1, 'adjacent to lane entry');
  }
  eq(E.RING[50], [7, 14]); eq(E.RING[11], [0, 7]); eq(E.RING[24], [7, 0]); eq(E.RING[37], [14, 7]);
});
t('safe cells = 4 starts + 4 stars', () => {
  eq(Object.keys(E.SAFE).map(Number).sort((a, b) => a - b), [0, 8, 13, 21, 26, 34, 39, 47]);
});
t('lanes have 5 cells each ending beside the center', () => {
  for (let c = 0; c < 4; c++) {
    eq(E.LANE[c].length, 5);
    const inner = E.LANE[c][4];
    eq(Math.abs(inner[0] - 7) + Math.abs(inner[1] - 7), 2, 'innermost lane cell touches center square');
  }
});

console.log('\nGAME CREATION & SERIALIZATION');
const mkGame = (seats, rules) => E.createGame({ mode: 'quick', seats, rules });
const H = (color, name) => ({ color, kind: 'human', name: name || 'H' + color });
const A = (color, level, name) => ({ color, kind: 'ai', name: name || 'A' + color, ai: level });

t('seats are sorted by color for turn order', () => {
  eq(mkGame([H(2, 'Yel'), H(0, 'Red')]).seats.map(s => s.color), [0, 2]);
});
t('rejects duplicate colors / bad seat counts', () => {
  assert.throws(() => mkGame([H(0), H(0)]));
  assert.throws(() => mkGame([H(0)]));
  assert.throws(() => mkGame([H(0), H(1), H(2), H(3), A(0, 1)]));
});
t('serialize → parse → validate round-trips', () => {
  const st = mkGame([H(0), A(2, 2)]);
  st.tokens[0] = [0, 20, 51, 56];
  st.turn = 1; st.phase = 'move'; st.lastRoll = 6; st.sixChain = 1;
  const back = E.validateState(JSON.parse(JSON.stringify(st)));
  assert(back);
  eq(back.tokens, st.tokens);
});
t('validateState rejects corrupted states', () => {
  const st = mkGame([H(0), A(1, 1)]);
  const bad = (mut) => { const c = JSON.parse(JSON.stringify(st)); mut(c); eq(E.validateState(c), null); };
  bad(c => { c.tokens[0][0] = 99; });
  bad(c => { c.tokens[0][0] = 'x'; });
  bad(c => { c.tokens[0].length = 3; });
  bad(c => { c.turn = 9; });
  bad(c => { c.phase = 'banana'; });
  bad(c => { delete c.stats; });
  bad(c => { c.v = 2; });
  bad(c => { c.seats[1].kind = 'robot'; });
  bad(c => { c.stats[0].rolls = -3; });
  eq(E.validateState(null), null);
  eq(E.validateState('nope'), null);
});

console.log('\nLEGAL MOVES');
t('from yard: only a six releases, to pos 0', () => {
  const st = mkGame([H(0), A(2, 1)]);
  eq(E.legalMoves(st, 3).length, 0);
  eq(E.legalMoves(st, 6).length, 4);
  eq(E.legalMoves(st, 6)[0].to, 0);
  eq(E.legalMoves(st, 6)[0].release, true);
});
t('exact-roll home entry; overshoot is illegal; home tokens never move', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[0] = [54, -1, -1, -1];
  eq(E.legalMoves(st, 2).length, 1);
  eq(E.legalMoves(st, 2)[0].home, true);
  eq(E.legalMoves(st, 3).length, 0, 'overshoot from 54');
  st.tokens[0] = [51, -1, -1, -1];
  eq(E.legalMoves(st, 5).length, 1);          // 51+5 = 56 exact
  eq(E.legalMoves(st, 5)[0].home, true);
  st.tokens[0] = [56, 56, 56, 56];           // finished tokens never move
  eq(E.legalMoves(st, 1).length, 0);
  eq(E.legalMoves(st, 6).length, 0);
});
t('all four board tokens movable simultaneously', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[0] = [10, 20, 30, 40];
  eq(E.legalMoves(st, 5).length, 4);
});
t('no legal moves when everything would overshoot', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[0] = [54, 54, 55, 55];
  eq(E.legalMoves(st, 3).length, 0);
  eq(E.legalMoves(st, 6).length, 0);
});

console.log('\nBLOCKS (classic same-colour stacks)');
t('cannot land on an opponent block', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[1] = [0, 0, -1, -1];          // yellow block on abs 26
  st.tokens[0] = [20, 35, 40, 30];        // keep the other tokens off 26
  const moves = E.legalMoves(st, 6);
  eq(moves.some(mv => mv.token === 0), false, 'landing on block is illegal');
  eq(moves.length, 3, 'other tokens still move');
  eq(E.legalMoves(st, 5)[0].token, 0, 'short move before the block still works');
});
t('cannot pass through an opponent block', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[1] = [0, 0, -1, -1];          // yellow block on abs 26
  st.tokens[0] = [24, 35, 40, 30];        // red path 24→30 crosses abs 26
  const moves = E.legalMoves(st, 6);
  eq(moves.some(mv => mv.token === 0), false, 'path crosses block');
  eq(E.legalMoves(st, 1).some(mv => mv.token === 0), true);
});
t('release from yard is blocked when the start square is blocked', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[1] = [26, 26, -1, -1];        // yellow block on red start (abs 0)
  eq(E.legalMoves(st, 6).length, 0);
});
t('own stack is never a block and can be passed by the same player', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[0] = [26, 26, 24, -1];        // red block on abs 26 + a follower at 24
  const moves = E.legalMoves(st, 6);
  assert(moves.some(m => m.token === 2 && m.to === 30), 'friendly token may pass own stack');
});
t('applyMove rejects a move that crosses a block', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[1] = [0, 0, -1, -1];
  st.tokens[0] = [24, -1, -1, -1];
  assert.throws(() => E.applyMove(st, { token: 0, from: 24, to: 30 }));
});
t('team mapping follows the cfg.seats order after the color sort', () => {
  const st = mkGame([{ color: 1, kind: 'human', name: 'G' }, { color: 3, kind: 'human', name: 'B' },
                    { color: 0, kind: 'human', name: 'R' }, { color: 2, kind: 'human', name: 'Y' }]);
  st.team = null; // teams are passed in createGame; rebuild to test:
  const withTeams = E.createGame({ mode: 'quick', seats: [
    { color: 1, kind: 'human', name: 'G' }, { color: 3, kind: 'human', name: 'B' },
    { color: 0, kind: 'human', name: 'R' }, { color: 2, kind: 'human', name: 'Y' }],
    teams: [[0, 1], [2, 3]] });           // G+B vs R+Y (cfg.seats order)
  eq(withTeams.seats.map(s => s.color), [0, 1, 2, 3]);
  eq(withTeams.team, [1, 0, 1, 0]);       // R,Y on team 1; G,B on team 0
});

console.log('\nCAPTURES & SAFE CELLS');
t('landing on opponent (yellow pos 42 → abs 16) captures', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[0] = [10, -1, -1, -1];    // red 10 + 6 → abs 16
  st.tokens[1] = [42, -1, -1, -1];    // yellow abs (26+42)%52 = 16
  const m = E.legalMoves(st, 6).find(mv => mv.token === 0);
  eq(m.captures.length, 1);
  eq(m.captures[0].seat, 1);
  const ev = E.applyMove(st, m);
  eq(st.tokens[1][0], -1, 'victim back to yard');
  eq(ev.captures.length, 1);
  eq(st.stats[0].captures, 1);
  eq(st.stats[1].timesCaptured, 1);
});
t('safe star protects occupants', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[0] = [2, -1, -1, -1];     // red 2 + 6 → abs 8 (star)
  st.tokens[1] = [34, -1, -1, -1];    // yellow abs 8
  const m = E.legalMoves(st, 6)[0];
  eq(m.captures.length, 0);
  E.applyMove(st, m);
  eq(st.tokens[1][0], 34, 'opponent untouched');
});
t('release onto own start never captures (start is safe)', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[1] = [26, -1, -1, -1];    // yellow abs (26+26)%52 = 0 = red start
  const m = E.legalMoves(st, 6)[0];   // red releases to abs 0
  eq(m.captures.length, 0);
});
t('single opponent token is captured, then sent back to yard', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[0] = [10, -1, -1, -1];
  st.tokens[1] = [42, -1, -1, -1];
  const m = E.legalMoves(st, 6).find(mv => mv.token === 0);
  eq(m.captures.length, 1);
  E.applyMove(st, m);
  eq(st.tokens[1][0], -1);
});
t('a same-colour stack (block) is never capturable', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[0] = [10, -1, -1, -1];
  st.tokens[1] = [42, 42, -1, -1];          // two yellow on abs 16 = block
  const m = E.legalMoves(st, 6).find(mv => mv.token === 0);
  eq(m, undefined, 'no move may land on a block');
});
t('own tokens coexist on a cell', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[0] = [10, 10, -1, -1];
  E.legalMoves(st, 6).forEach(m => eq(m.captures.length, 0));
});
t('lane tokens can never be captured', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[1] = [51, 52, 53, 54];
  st.tokens[0] = [10, -1, -1, -1];
  eq(E.legalMoves(st, 6)[0].captures.length, 0);
});
t('passing over opponents captures nothing', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[0] = [10, -1, -1, -1];
  st.tokens[1] = [37, -1, -1, -1];    // yellow abs 11 — red passes abs 11..16? red stops at 16
  const m = E.legalMoves(st, 4)[0];   // red → abs 14
  eq(m.captures.length, 0);
});

console.log('\nTURN FLOW: SIXES, EXTRA TURNS, FORFEIT');
t('six → extra turn; non-six → pass', () => {
  const st = mkGame([H(0), A(2, 1)]);
  eq(E.registerRoll(st, 6).forfeit, false);
  eq(st.sixChain, 1);
  E.endTurn(st, true); eq(st.turn, 0);
  E.registerRoll(st, 4);
  E.endTurn(st, false); eq(st.turn, 1);
});
t('third consecutive six forfeits the turn', () => {
  const st = mkGame([H(0), A(2, 1)]);
  eq(E.registerRoll(st, 6).forfeit, false);
  eq(E.registerRoll(st, 6).forfeit, false);
  eq(E.registerRoll(st, 6).forfeit, true);
  eq(st.sixChain, 0);
  E.endTurn(st, false); eq(st.turn, 1);
});
t('six chain resets on non-six, persists across extra turns', () => {
  const st = mkGame([H(0), A(2, 1)]);
  E.registerRoll(st, 6); eq(st.sixChain, 1);
  E.registerRoll(st, 3); eq(st.sixChain, 0);
  E.registerRoll(st, 6); E.registerRoll(st, 6);
  eq(E.registerRoll(st, 6).forfeit, true);
});
t('rolls and sixes are counted', () => {
  const st = mkGame([H(0), A(2, 1)]);
  E.registerRoll(st, 6); E.registerRoll(st, 6); E.registerRoll(st, 1);
  eq(st.stats[0].sixes, 2);
  eq(st.stats[0].rolls, 3);
});

console.log('\nWINNING');
t('four tokens home wins; others ranked by progress', () => {
  const st = mkGame([H(0), A(1, 1), A(2, 2)]);
  st.tokens[0] = [56, 56, 56, 55];
  st.tokens[1] = [10, -1, -1, -1];
  st.tokens[2] = [30, 20, -1, -1];
  const ev = E.applyMove(st, E.legalMoves(st, 1)[0]);
  eq(ev.win, true);
  eq(st.winner, 0);
  eq(st.phase, 'over');
  eq(st.rankings, [0, 2, 1]);
  eq(E.legalMoves(st, 6).length, 0);
});
t('firstToCaptures variant wins on capture count', () => {
  const st = E.createGame({ mode: 'daily', rules: { firstToCaptures: 2 }, seats: [H(0), A(2, 1)] });
  st.tokens[0] = [10, -1, -1, -1];
  st.tokens[1] = [42, -1, -1, -1];
  E.applyMove(st, E.legalMoves(st, 6)[0]);           // capture 1
  eq(st.winner, null);
  st.turn = 0;
  st.tokens[0] = [10, -1, -1, -1];
  st.tokens[1] = [42, -1, -1, -1];
  E.applyMove(st, E.legalMoves(st, 6)[0]);           // capture 2
  eq(st.winner, 0);
});
t('online mode: createGame + validateState accept mode online', () => {
  const st = mkGame([{ color: 0, kind: 'human', name: 'A' }, { color: 2, kind: 'human', name: 'B' }], { rules: {} });
  st.mode = 'online';
  assert(E.validateState(st), 'online state validates');
  const back = E.validateState(JSON.parse(JSON.stringify(st)));
  assert(back, 'round-trips');
});
t('headStart places tokens as configured', () => {
  const st = E.createGame({ mode: 'daily', rules: { headStart: { 1: [12, 8, 5, 0] } }, seats: [H(0), A(1, 2)] });
  eq(st.tokens[1], [12, 8, 5, 0]);
  eq(st.tokens[0], [-1, -1, -1, -1]);
});

console.log('\nPATH HELPERS');
t('pathPositions steps through cells', () => {
  eq(E.pathPositions(-1, 0), [0]);
  eq(E.pathPositions(10, 14), [11, 12, 13, 14]);
  eq(E.pathPositions(49, 56), [50, 51, 52, 53, 54, 55, 56]);
});
t('posToCell maps ring + lane for every color', () => {
  eq(E.posToCell(0, 0), [6, 13]);
  eq(E.posToCell(0, 50), [7, 14]);
  eq(E.posToCell(0, 51), [7, 13]);
  eq(E.posToCell(0, 55), [7, 9]);
  eq(E.posToCell(1, 51), [1, 7]);
  eq(E.posToCell(2, 51), [7, 1]);
  eq(E.posToCell(3, 51), [13, 7]);
  eq(E.posToCell(0, 56), null);
  eq(E.posToCell(0, -1), null);
});

console.log('\nAI');
AI.setNoise(0);
t('always returns a legal move when one exists (all levels, random states)', () => {
  for (let lvl = 0; lvl < 3; lvl++) {
    for (let trial = 0; trial < 300; trial++) {
      const st = mkGame([H(0), A(1, lvl), A(2, lvl), A(3, lvl)]);
      for (let s = 0; s < 4; s++) for (let tk = 0; tk < 4; tk++)
        st.tokens[s][tk] = Math.floor(Math.random() * 58) - 1;
      const roll = 1 + Math.floor(Math.random() * 6);
      const legal = E.legalMoves(st, roll);
      const pick = AI.chooseMove(st, st.turn, roll, lvl);
      if (!legal.length) { eq(pick, null); continue; }
      if (!pick) throw new Error('no pick for legal roll');
      assert(legal.some(m => m.token === pick.token && m.to === pick.to), 'pick must be legal');
    }
  }
});
t('Hard takes a free capture over plain advance', () => {
  for (let i = 0; i < 25; i++) {
    const st = mkGame([H(0), A(2, 2)]);
    st.tokens[0] = [10, 20, 56, 56];
    st.tokens[1] = [42, -1, -1, -1];   // victim at red’s landing abs 16
    const pick = AI.chooseMove(st, 0, 6, 2);
    eq(pick.token, 0);
    eq(pick.captures.length, 1);
  }
});
t('Hard finishes a token into home over drifting', () => {
  const st = mkGame([H(0), A(2, 2)]);
  st.tokens[0] = [54, 20, 56, 56];
  const pick = AI.chooseMove(st, 0, 2, 2);
  eq(pick.token, 0);
  eq(pick.home, true);
});
t('Hard prefers the safe star over stepping into a threat cluster', () => {
  for (let i = 0; i < 25; i++) {
    const st = mkGame([H(0), A(2, 2)]);
    st.tokens[0] = [2, 22, 56, 56];    // token0 → abs 8 safe star; token1 → abs 28 (threatened)
    st.tokens[1] = [0, 1, -1, -1];     // yellow abs 26 & 27 sit 2 and 1 behind abs 28
    const pick = AI.chooseMove(st, 0, 6, 2);
    eq(pick.token, 0);
  }
});
t('threatAt math: 1..6 behind = threat, safe cells = 0, out of range = 0', () => {
  const st = mkGame([H(0), A(2, 1)]);
  st.tokens[1] = [25, -1, -1, -1];     // yellow abs 51, dist 6 to red abs 5
  eq(AI.threatAt(st, 0, 5), 1 / 6);
  st.tokens[1] = [26, 26, -1, -1];     // two yellow tokens at abs 0, dist 1 to red abs 1
  eq(AI.threatAt(st, 0, 1), 1 / 3);
  eq(AI.threatAt(st, 0, 8), 0, 'safe star');
  eq(AI.threatAt(st, 0, 11), 0, 'out of range');
  st.tokens[1] = [47, -1, -1, -1];     // abs 21; overshoots its ring exit (47+6>50)
  eq(AI.threatAt(st, 0, 1), 0, 'overshooting token cannot hit');
});
AI.setNoise(null);

console.log('\nFULL GAME SIMULATIONS (AI vs AI)');
function simulate(seatCount, level, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const seats = [0, 1, 2, 3].slice(0, seatCount).map(c => A(c, level));
  const st = E.createGame({ mode: 'quick', seats });
  let plies = 0;
  AI.setNoise(0);
  while (st.phase !== 'over') {
    if (plies++ > 8000) throw new Error('game did not terminate');
    E.beginsTurn(st);
    let turnDone = false;
    while (!turnDone) {
      const v = 1 + Math.floor(rnd() * 6);
      const r = E.registerRoll(st, v);
      if (r.forfeit) { E.endTurn(st, false); turnDone = true; break; }
      const mv = AI.chooseMove(st, st.turn, v, level);
      if (mv) {
        const ev = E.applyMove(st, mv);
        if (ev.win) { AI.setNoise(null); return { st, plies }; }
        const extra = v === 6 || ev.captures.length > 0 || ev.home;
        E.endTurn(st, extra);
        turnDone = !extra;
      } else {
        E.endTurn(st, v === 6);        // a six with no moves still re-rolls
        turnDone = v !== 6;
      }
    }
  }
  AI.setNoise(null);
  return { st, plies };
}
t('2/3/4-player games all terminate with valid winners (144 games)', () => {
  for (const n of [2, 3, 4]) {
    for (let g = 0; g < 12; g++) {
      for (const lvl of [0, 2]) {
        const { st, plies } = simulate(n, lvl, 1234 + g * 7919 + n * 13 + lvl);
        assert(st.winner !== null);
        assert(st.phase === 'over');
        assert(st.rankings.length === n);
        assert(plies < 8000);
        st.tokens.forEach(toks => toks.forEach(p => assert(p >= -1 && p <= 56, 'pos ' + p)));
        assert(st.tokens[st.winner].every(p => p === 56), 'winner has 4 home');
      }
    }
    console.log('    · ' + n + '-player: 24 games ok');
  }
});
t('dice are uniform: six ratio ≈ 1/6 across many games', () => {
  let rolls = 0, sixes = 0;
  for (let g = 0; g < 30; g++) {
    const { st } = simulate(4, 1, 999 + g);
    st.stats.forEach(x => { rolls += x.rolls; sixes += x.sixes; });
  }
  const ratio = sixes / rolls;
  assert(ratio > 0.14 && ratio < 0.19, 'six ratio ' + ratio.toFixed(3));
});
t('full pipeline is deterministic under a fixed dice sequence', () => {
  const run = () => {
    let s = 42;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const st = E.createGame({ mode: 'quick', seats: [A(0, 2), A(2, 2)] });
    AI.setNoise(0);
    for (let i = 0; i < 400 && st.phase !== 'over'; i++) {
      E.beginsTurn(st);
      const v = 1 + Math.floor(rnd() * 6);
      const r = E.registerRoll(st, v);
      if (r.forfeit) { E.endTurn(st, false); continue; }
      const mv = AI.chooseMove(st, st.turn, v, 2);
      if (mv) {
        const ev = E.applyMove(st, mv);
        if (ev.win) break;
        E.endTurn(st, v === 6 || ev.captures.length > 0 || ev.home);
      } else E.endTurn(st, v === 6);
    }
    AI.setNoise(null);
    return st;
  };
  eq(run().tokens, run().tokens);
});

console.log('\nSTORE');
t('save → load round-trip', () => {
  Store.save('unit', { a: 1 });
  eq(Store.load('unit', o => o.a === 1), { a: 1 });
});
t('failing validator discards corrupted data', () => {
  Store.save('unit', { a: 'corrupted' });
  eq(Store.load('unit', o => typeof o.a === 'number'), null);
  eq(Store.load('unit'), null, 'key removed after corruption');
});
t('unparseable raw bytes return null', () => {
  Store.saveRaw('unit', '{"a": not json');
  eq(Store.load('unit'), null);
  Store.saveRaw('unit', 'undefined');
  eq(Store.load('unit'), null);
  Store.remove('unit');
});
t('engine state survives store round-trip via validateState', () => {
  const st = mkGame([H(0), A(1, 2), A(2, 1)]);
  st.tokens[2] = [1, 2, 3, 4];
  Store.save('unit2', st);
  const back = Store.load('unit2', E.validateState);
  assert(back);
  eq(back.tokens, st.tokens);
  Store.remove('unit2');
});

console.log('\nPROFILE / PROGRESSION / DAILY');
t('level curve is monotonic with increasing costs', () => {
  let xp = 0, lastNeed = 0;
  for (let l = 1; l <= 20; l++) {
    const need = P.xpForNext(l);
    assert(need >= lastNeed); lastNeed = need;
    eq(P.levelFromXp(xp).level, l);
    xp += need;
  }
  eq(P.levelFromXp(0).level, 1);
  eq(P.levelFromXp(99).level, 1);
  eq(P.levelFromXp(100).level, 2);
});
t('match result applies xp, stats, streaks, history, achievements', () => {
  const prof = P.defaultProfile();
  const res = P.applyMatchResult(prof, {
    mode: 'quick', winnerSeat: 0, youSeat: 0, seatCount: 2, maxAiLevel: 2, hardWin: true,
    winnerName: 'You', seatNames: ['You', 'Aria'], durationS: 300,
    you: { captures: 3, sixes: 5, timesCaptured: 1, turns: 30, homes: 4 }
  });
  eq(res.xpGained, 130 + 12 + 5, 'hard win + captures + sixes');
  eq(prof.stats.wins, 1);
  eq(prof.stats.streak, 1);
  eq(prof.stats.captures, 3);
  eq(prof.stats.sixes, 5);
  eq(prof.history.length, 1);
  assert(res.newAchievements.some(a => a.id === 'first-win'));
  assert(res.newAchievements.some(a => a.id === 'mastermind'));
});
t('loss breaks the streak and still grants xp', () => {
  const prof = P.defaultProfile();
  prof.stats.streak = 4;
  P.applyMatchResult(prof, { mode: 'quick', winnerSeat: 1, youSeat: 0, seatCount: 2, maxAiLevel: 1, winnerName: 'Aria', seatNames: ['You', 'Aria'], durationS: 200, you: { captures: 1, sixes: 2, timesCaptured: 2, turns: 40, homes: 2 } });
  eq(prof.stats.wins, 0);
  eq(prof.stats.losses, 1);
  eq(prof.stats.streak, 0);
  assert(prof.xp > 0);
});
t('pass & play awards flat xp, no win/loss stats', () => {
  const prof = P.defaultProfile();
  const res = P.applyMatchResult(prof, { mode: 'pass', winnerSeat: 1, youSeat: null, seatCount: 4, maxAiLevel: 0, winnerName: 'Neha', seatNames: ['Amit', 'Neha', 'Raj', 'Priya'], durationS: 900, you: null });
  eq(res.xpGained, 20);
  eq(prof.stats.matches, 1);
  eq(prof.stats.wins, 0);
  eq(prof.stats.losses, 0);
});
t('daily counts once per day; streak grows on consecutive days', () => {
  const prof = P.defaultProfile();
  const mk = () => ({ mode: 'daily', winnerSeat: 0, youSeat: 0, seatCount: 2, maxAiLevel: 2, hardWin: true, winnerName: 'You', seatNames: ['You', 'Aria'], durationS: 400, you: { captures: 2, sixes: 3, timesCaptured: 0, turns: 35, homes: 4 } });
  const res1 = P.applyMatchResult(prof, mk());
  eq(prof.daily.streak, 1);
  eq(res1.daily, true);
  eq(P.applyMatchResult(prof, mk()).daily, false, 'no double count');
  eq(prof.daily.streak, 1);
  const today = P.dateKey();
  delete prof.daily.done[today];                  // simulate the next day
  const y = P.dateKey(new Date(Date.now() - 86400000));
  prof.daily.done[y] = true; prof.daily.last = y;
  P.applyMatchResult(prof, mk());
  eq(prof.daily.streak, 2);
  assert(prof.xp >= 150 + 170);
});
t('dailyFor is deterministic per date and varies across dates', () => {
  const a = P.dailyFor('2026-08-24'), a2 = P.dailyFor('2026-08-24');
  eq(a.name, a2.name);
  eq(JSON.stringify(a.seats), JSON.stringify(a2.seats));
  const types = new Set();
  for (let d = 1; d <= 60; d++) types.add(P.dailyFor('2026-' + String(Math.floor(d / 30) + 8) + '-' + String((d % 28) + 1).padStart(2, '0')).type);
  assert(types.size >= 2, 'variety across dates: ' + types.size);
});
t('daily configs are valid games', () => {
  for (let d = 1; d <= 30; d++) {
    const cfg = P.dailyFor('2026-09-' + String(d).padStart(2, '0'));
    const st = E.createGame({ mode: 'daily', seats: cfg.seats, rules: cfg.rules });
    assert(st.seats.length >= 2);
  }
});
t('cosmetics unlock by level', () => {
  const prof = P.defaultProfile();
  eq(P.isUnlocked(P.COSMETICS.boards[1], prof), false);
  prof.xp = 100 + 160 + 220 + 279;                // level 4, one xp short of 5
  eq(P.levelFromXp(prof.xp).level, 4);
  eq(P.isUnlocked(P.COSMETICS.boards[1], prof), true);
  P.applyMatchResult(prof, { mode: 'quick', winnerSeat: 1, youSeat: 0, seatCount: 2, maxAiLevel: 1, winnerName: 'Aria', seatNames: ['You', 'Aria'], durationS: 100, you: { captures: 0, sixes: 0, timesCaptured: 0, turns: 10, homes: 0 } });
  assert(prof.cosmetics.owned.indexOf('walnut-b') >= 0, 'walnut granted');
});
t('profile v2: online stats tracked, legacy fields intact', () => {
  const prof = P.defaultProfile();
  eq(prof.v, 2);
  eq(prof.stats.onlineMatches, 0);
  P.applyMatchResult(prof, { mode: 'online', winnerSeat: 0, youSeat: 0, seatCount: 2, maxAiLevel: 1,
    winnerName: 'You', seatNames: ['You', 'B'], durationS: 400,
    you: { captures: 2, sixes: 4, timesCaptured: 1, turns: 40, homes: 4 } });
  eq(prof.stats.onlineMatches, 1);
  eq(prof.stats.onlineWins, 1);
  eq(prof.stats.wins, 1);
  assert(prof.xp > 0);
});
t('handoff defaults to off and validates all three modes', () => {
  const prof = P.defaultProfile();
  eq(prof.settings.handoff, 'off', 'no popups by default');
  ['off', 'quick', 'full'].forEach((v) => {
    prof.settings.handoff = v;
    assert(P.validateProfile(prof), v + ' valid');
  });
  prof.settings.handoff = 'always';
  eq(P.validateProfile(prof), null, 'junk rejected');
});
t('appearance setting persists and validates', () => {
  const prof = P.defaultProfile();
  eq(prof.settings.theme, 'auto');
  prof.settings.theme = 'light';
  P.saveProfile(prof);
  eq(P.loadProfile().settings.theme, 'light');
  prof.settings.theme = 'neon';
  eq(P.validateProfile(prof), null, 'invalid appearance rejected');
});
t('layout setting validates (auto/phone/tablet/desktop)', () => {
  const prof = P.defaultProfile();
  eq(prof.settings.layout, 'auto');
  prof.settings.layout = 'desktop';
  P.saveProfile(prof);
  eq(P.loadProfile().settings.layout, 'desktop');
  ['phone', 'tablet'].forEach((v) => {
    prof.settings.layout = v;
    assert(P.validateProfile(prof), v + ' valid');
  });
  prof.settings.layout = 'diagonal';
  eq(P.validateProfile(prof), null, 'junk layout rejected');
  delete prof.settings.layout;               // legacy profiles: absent = auto
  assert(P.validateProfile(prof), 'absent layout allowed');
});
t('board themes include the premium set', () => {
  const Board = require('../js/board.js');
  const ids = Object.keys(Board.THEMES);
  ['ivory', 'walnut', 'midnight', 'sakura', 'arctic', 'canyon', 'emerald', 'aurora', 'royal'].forEach((id) => {
    assert(ids.indexOf(id) >= 0, 'theme ' + id);
    const t2 = Board.THEMES[id];
    ['frameA', 'frameB', 'field', 'cell'].forEach((k) => assert(/^#[0-9A-Fa-f]{6}$/.test(t2[k]), id + '.' + k));
  });
});
t('validateProfile rejects tampered profiles', () => {
  eq(P.validateProfile(null), null);
  eq(P.validateProfile({ v: 2 }), null);
  eq(P.validateProfile({ v: 1, name: 'x', xp: -5, stats: {}, daily: {}, achievements: {}, cosmetics: { board: 'x', dice: 'y', token: 'z' }, history: [], settings: { sound: true } }), null);
});

console.log('\n' + (failed ? '✗ ' + failed + ' FAILED, ' + passed + ' passed' : 'ALL ' + passed + ' TESTS PASSED') + '\n');
process.exit(failed ? 1 : 0);
