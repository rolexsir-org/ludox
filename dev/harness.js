/* Ludora — dev/harness.js
   Node test harness: fake deterministic clock + stub 2D canvas + script
   loader, so the REAL engine/AI/net/mp/game controllers run headlessly
   (no jsdom needed for multiplayer protocol tests). */
'use strict';
const fs = require('fs');
const path = require('path');

function makeHarness() {
  const H = { now: 0, pending: new Map(), nid: 1, errs: [] };

  /* ---- deterministic timers ---- */
  global.performance = { now: () => H.now };
  global.setTimeout = (fn, ms) => { const id = H.nid++; H.pending.set(id, { fn, at: H.now + (ms || 0) }); return id; };
  global.clearTimeout = (id) => { if (H.pending.has(id)) H.pending.get(id).dead = true; };
  global.clearInterval = (id) => { if (H.pending.has(id)) H.pending.get(id).dead = true; };
  H.realSetInterval = (fn, ms) => { const id = H.nid++; H.pending.set(id, { fn, at: H.now + ms, every: ms }); return id; };
  global.setInterval = H.realSetInterval;
  global.requestAnimationFrame = (fn) => { const id = H.nid++; H.pending.set(id, { fn, at: H.now + 16 }); return id; };
  global.cancelAnimationFrame = (id) => { if (H.pending.has(id)) H.pending.get(id).dead = true; };
  global.matchMedia = undefined;

  /* ---- advance the virtual clock, firing due timers in order ---- */
  H.advance = (ms) => {
    const target = H.now + ms;
    for (;;) {
      let next = null, nid = -1;
      for (const [id, p] of H.pending) {
        if (!p.dead && p.at <= target && (!next || p.at < next.at)) { next = p; nid = id; }
      }
      if (!next) break;
      H.now = next.at;
      if (next.every !== undefined) next.at += next.every;
      else H.pending.delete(nid);
      try { next.fn(next.at); } catch (e) { H.errs.push(e); }
    }
    H.now = target;
  };

  /* async variant: performs the advance in chunks across real microtask
     turns so promise chains (WebRTC offer/answer hops) interleave with the
     virtual clock exactly like they would in a browser event loop. */
  H.advanceAsync = async (ms) => {
    const step = 25;
    for (let done = 0; done < ms; done += step) {
      await Promise.resolve();      // flush queued microtasks
      if (global.setImmediate) await new Promise((r) => global.setImmediate(r));
      H.advance(step);
    }
    await Promise.resolve();
    if (global.setImmediate) await new Promise((r) => global.setImmediate(r));
  };

  /* ---- stub canvas 2D ---- */
  const ctxStub = () => new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return null;
      return (...a) => {
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop: () => {} };
        if (k === 'measureText') return { width: 10 };
      };
    },
    set() { return true; }
  });
  H.makeCanvas = (w, h) => {
    const cv = {
      width: 0, height: 0, style: {},
      getContext: () => ctxStub(),
      parentElement: { clientWidth: w || 600, clientHeight: h || 600 },
      addEventListener: () => {}
    };
    return cv;
  };
  global.document = {
    createElement: (tag) => (tag === 'canvas' ? H.makeCanvas() : { style: {}, appendChild: () => {} })
  };

  /* ---- load app scripts in order ---- */
  H.load = (files) => {
    for (const f of files) {
      const code = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
      try { eval(code); } catch (e) { H.errs.push(new Error(f + ': ' + e.message)); }
    }
  };
  return H;
}

module.exports = { makeHarness };
