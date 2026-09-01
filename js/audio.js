/* =========================================================================
   Ludora — audio.js
   Tiny WebAudio synth (zero assets, works offline) + haptic feedback.
   All calls are safe no-ops when unsupported or disabled.
   ========================================================================= */
(function (global) {
  'use strict';
  var ctx = null, master = null;
  var enabled = true, hapticsOn = true, unlocked = false;

  function ensure() {
    if (ctx || !enabled) return ctx;
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
      return ctx;
    } catch (e) { ctx = null; return null; }
  }
  function unlock() {
    var c = ensure();
    if (c && c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    unlocked = true;
  }
  function tone(freq, dur, type, gain, delay, slideTo) {
    if (!ctx || !enabled) return;
    try {
      var t0 = ctx.currentTime + (delay || 0);
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain == null ? 0.5 : gain, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + dur + 0.02);
    } catch (e) {}
  }
  function noise(dur, gain, delay, hp) {
    if (!ctx || !enabled) return;
    try {
      var t0 = ctx.currentTime + (delay || 0);
      var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      var src = ctx.createBufferSource(); src.buffer = buf;
      var f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 900;
      var g = ctx.createGain(); g.gain.value = gain == null ? 0.3 : gain;
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0);
    } catch (e) {}
  }

  var SOUNDS = {
    tap:     function () { tone(1250, 0.04, 'sine', 0.18); },
    roll:    function () { noise(0.16, 0.22, 0, 1600); tone(210, 0.05, 'triangle', 0.3, 0.02); tone(260, 0.05, 'triangle', 0.25, 0.1); },
    land:    function (v) { tone(196 + v * 22, 0.09, 'triangle', 0.5); noise(0.03, 0.18, 0, 2400); },
    step:    function (i) { tone(560 + (i % 6) * 66, 0.035, 'sine', 0.20); },
    capture: function () { tone(420, 0.16, 'sawtooth', 0.30, 0, 110); noise(0.08, 0.3, 0.02, 700); tone(95, 0.14, 'sine', 0.5, 0.05); },
    home:    function () { tone(523, 0.1, 'sine', 0.4); tone(659, 0.1, 'sine', 0.4, 0.09); tone(784, 0.16, 'sine', 0.42, 0.18); },
    six:     function () { tone(880, 0.07, 'sine', 0.35); tone(1318, 0.12, 'sine', 0.32, 0.07); },
    win:     function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.16, 'triangle', 0.42, i * 0.12); }); tone(1319, 0.4, 'sine', 0.3, 0.5); },
    lose:    function () { tone(392, 0.14, 'sine', 0.3); tone(311, 0.22, 'sine', 0.3, 0.12); },
    pass:    function () { tone(330, 0.06, 'sine', 0.22); },
    achieve: function () { tone(740, 0.09, 'sine', 0.34); tone(1109, 0.14, 'sine', 0.3, 0.08); },
    unlock:  function () { tone(587, 0.08, 'triangle', 0.34); tone(880, 0.08, 'triangle', 0.32, 0.08); tone(1175, 0.16, 'triangle', 0.3, 0.16); },
    noMove:  function () { tone(240, 0.09, 'sine', 0.3); tone(200, 0.1, 'sine', 0.3, 0.09); }
  };

  function play(name, arg) {
    if (!enabled || !unlocked) return;
    var s = SOUNDS[name];
    if (s) { try { s(arg); } catch (e) {} }
  }

  var HAPTIC = {
    tap: 8, roll: 18, land: 12, step: 0, capture: [16, 34, 26], home: [12, 20, 12, 20, 24],
    six: 24, win: [30, 40, 30, 40, 60], pass: 10, noMove: [8, 24]
  };
  function haptic(name) {
    if (!hapticsOn) return;
    if (typeof navigator === 'undefined' || !navigator.vibrate) return;
    try { navigator.vibrate(HAPTIC[name] || 8); } catch (e) {}
  }

  global.LudoraAudio = {
    unlock: unlock, play: play, haptic: haptic,
    setEnabled: function (v) { enabled = v; if (!v && ctx) { try { ctx.suspend(); } catch (e) {} } else if (v && ctx) { try { ctx.resume(); } catch (e) {} } },
    setHaptics: function (v) { hapticsOn = v; },
    isEnabled: function () { return enabled; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraAudio;
})(typeof window !== 'undefined' ? window : globalThis);
