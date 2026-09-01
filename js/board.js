/* =========================================================================
   Ludora — board.js
   Canvas rendering for the tabletop: static board (frame, inlaid cells,
   yards, center home), dimensional tokens, halos, particles.
   Pure drawing functions on a supplied 2D context — no DOM access here,
   so the same code renders in the app and in the Node design preview.
   ========================================================================= */
(function (global) {
  'use strict';
  var E = global.LudoraEngine;

  /* spec palette — base / deep / glow per player */
  var PLAYERS = [
    { name: 'Red',    base: '#EF4444', light: '#F87171', lighter: '#FECACA', dark: '#DC2626', deep: '#991B1B' },
    { name: 'Green',  base: '#22C55E', light: '#4ADE80', lighter: '#BBF7D0', dark: '#16A34A', deep: '#14532D' },
    { name: 'Yellow', base: '#FBBF24', light: '#FDE047', lighter: '#FEF3C7', dark: '#D97706', deep: '#92400E' },
    { name: 'Blue',   base: '#3B82F6', light: '#60A5FA', lighter: '#BFDBFE', dark: '#2563EB', deep: '#1E3A8A' }
  ];

  var THEMES = {
    ivory:    { name: 'Slate', frameA: '#1B1D31', frameB: '#0A0C15', field: '#161829', cell: '#242642', line: 'rgba(139,143,163,.16)', yardLine: 'rgba(0,0,0,.30)' },
    walnut:   { name: 'Walnut',        frameA: '#4C301D', frameB: '#26150C', field: '#E9DBBE', cell: '#F5ECD6', line: 'rgba(84,60,34,.17)', yardLine: 'rgba(0,0,0,.22)' },
    midnight: { name: 'Midnight',      frameA: '#3A4150', frameB: '#1B1F28', field: '#DFE4EC', cell: '#EDF1F7', line: 'rgba(38,48,66,.15)', yardLine: 'rgba(0,0,0,.22)' },
    sakura:   { name: 'Sakura',        frameA: '#7E4458', frameB: '#4E2338', field: '#F6E9EB', cell: '#FCF2F1', line: 'rgba(110,62,78,.16)', yardLine: 'rgba(0,0,0,.20)' },
    arctic:   { name: 'Arctic',        frameA: '#40678C', frameB: '#203D59', field: '#E7EFF5', cell: '#F4F9FC', line: 'rgba(44,70,96,.14)', yardLine: 'rgba(0,0,0,.20)' },
    royal:    { name: 'Royal',         frameA: '#8F7334', frameB: '#574312', field: '#EFE7CF', cell: '#F9F2DC', line: 'rgba(96,80,34,.16)', yardLine: 'rgba(0,0,0,.22)' },
    canyon:   { name: 'Canyon',        frameA: '#A65832', frameB: '#69350F', field: '#F4E7D3', cell: '#FBF3E5', line: 'rgba(122,72,32,.16)', yardLine: 'rgba(0,0,0,.22)' },
    emerald:  { name: 'Emerald',       frameA: '#1F5C43', frameB: '#0D3A27', field: '#E9F2EA', cell: '#F4FAF5', line: 'rgba(28,82,56,.15)', yardLine: 'rgba(0,0,0,.2)' },
    aurora:   { name: 'Aurora',        frameA: '#332E5E', frameB: '#151330', field: '#EDEFF9', cell: '#F7F8FE', line: 'rgba(58,58,118,.15)', yardLine: 'rgba(0,0,0,.22)' }
  };

  /* ---------- geometry ---------- */
  function metrics(S) {
    var frame = S * 0.038;
    var cell = (S - frame * 2) / 15;
    return { S: S, frame: frame, cell: cell, ox: frame, oy: frame };
  }
  function cx(m, col) { return m.ox + (col + 0.5) * m.cell; }
  function cy(m, row) { return m.oy + (row + 0.5) * m.cell; }
  function cellRect(m, col, row) {
    var g = m.cell * 0.055;
    return { x: m.ox + col * m.cell + g, y: m.oy + row * m.cell + g, w: m.cell - g * 2, h: m.cell - g * 2, r: m.cell * 0.17 };
  }

  var YARD_REGIONS = [[0.5, 9.5], [0.5, 0.5], [9.5, 0.5], [9.5, 9.5]]; // top-left of 6×6 area, grid units
  /* which board side a player's yard/home points to (0=Red bottom,1=Green left,2=Yellow top,3=Blue right). */
  var SIDE_OF = ['bottom', 'left', 'top', 'right'];
  /* reserved lane width (x) / height (y) for the four player pods hugging the board.
     Pod is 92px wide (compact: 72px) + 12px padding on each side. */
  function podLanes() {
    var iw = (typeof global === 'object' && typeof global.innerWidth === 'number') ? global.innerWidth : 420;
    var compact = iw < 480;
    /* x: pod width + side padding. y: pod height + vertical padding */
    return { x: compact ? 84 : 104, y: compact ? 68 : 76 };
  }
  function yardDocks(m, colorIdx) {
    var reg = YARD_REGIONS[colorIdx];
    var midC = reg[0] + 3, midR = reg[1] + 3;
    var d = 1.42;
    return [
      { x: cx(m, midC - d), y: cy(m, midR - d) }, { x: cx(m, midC + d), y: cy(m, midR - d) },
      { x: cx(m, midC - d), y: cy(m, midR + d) }, { x: cx(m, midC + d), y: cy(m, midR + d) }
    ];
  }
  /* 4 slots inside each center triangle. dir: outward from board center. */
  var TRI_DIRS = [[0, 1], [-1, 0], [0, -1], [1, 0]]; // red bottom, green left, yellow top, blue right
  function homeSlots(m, colorIdx) {
    var dir = TRI_DIRS[colorIdx], perp = [-dir[1], dir[0]];
    var ctr = { x: cx(m, 7), y: cy(m, 7) }; // board center (7,7 cell-center = grid 7.5)
    var slots = [];
    var rows = [0.52, 1.05];
    for (var i = 0; i < 4; i++) {
      var side = (i % 2 === 0) ? -1 : 1;
      var along = rows[Math.floor(i / 2)];
      slots.push({
        x: ctr.x + dir[0] * along * m.cell + perp[0] * side * 0.52 * m.cell,
        y: ctr.y + dir[1] * along * m.cell + perp[1] * side * 0.52 * m.cell
      });
    }
    return slots;
  }
  function pointForPos(m, colorIdx, pos, tokenIdx, homeOrder) {
    if (pos === E.HOME) return homeSlots(m, colorIdx)[homeOrder != null ? homeOrder : tokenIdx];
    if (pos === E.YARD) return yardDocks(m, colorIdx)[tokenIdx];
    var c = E.posToCell(colorIdx, pos);
    return { x: cx(m, c[0]), y: cy(m, c[1]) };
  }

  /* ---------- primitives ---------- */
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function lg(ctx, x0, y0, x1, y1, stops) {
    var g = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    return g;
  }
  function rg(ctx, x, y, r0, x1, y1, r1, stops) {
    var g = ctx.createRadialGradient(x, y, r0, x1, y1, r1);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    return g;
  }
  function star4(ctx, x, y, R, k) {
    var pts = [[0, -R], [k, -k], [R, 0], [k, k], [0, R], [-k, k], [-R, 0], [-k, -k]];
    ctx.beginPath();
    pts.forEach(function (p, i) {
      var px = x + p[0], py = y + p[1];
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
  }

  /* letters double the color cue: yards are identifiable without color vision */
  var YARD_INITIALS = ['R', 'G', 'Y', 'B'];

  /* ---------- static board ---------- */
  function drawStatic(ctx, m, themeId) {
    var th = THEMES[themeId] || THEMES.ivory, S = m.S, cell = m.cell;
    ctx.clearRect(0, 0, S, S);

    /* frame */
    rr(ctx, 1, 1, S - 2, S - 2, S * 0.062);
    ctx.fillStyle = lg(ctx, 0, 0, S, S, [[0, th.frameA], [0.5, th.frameA], [1, th.frameB]]);
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,.38)'; ctx.stroke();
    rr(ctx, cell * 0.10, cell * 0.10, S - cell * 0.2, S - cell * 0.2, S * 0.055);
    ctx.lineWidth = Math.max(1, cell * 0.045); ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.stroke();

    /* field */
    var f = m.frame;
    rr(ctx, f, f, S - f * 2, S - f * 2, cell * 0.3);
    ctx.fillStyle = th.field; ctx.fill();
    ctx.lineWidth = Math.max(1, cell * 0.06); ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.stroke();

    /* cross cells (the plus-shaped track region) */
    for (var col = 0; col < 15; col++) {
      for (var row = 0; row < 15; row++) {
        var inCross = (col >= 6 && col <= 8) || (row >= 6 && row <= 8);
        if (!inCross) continue;
        var r = cellRect(m, col, row);
        rr(ctx, r.x, r.y, r.w, r.h, r.r);
        ctx.fillStyle = th.cell;
        ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = th.line; ctx.stroke();
      }
    }

    /* colored cells: lanes + tips + starts */
    for (var c = 0; c < 4; c++) {
      var pc = PLAYERS[c];
      var cells = [];
      cells.push(E.posToCell(c, 0));                                   // start
      for (var lp = E.FIRST_LANE_POS; lp <= 55; lp++) cells.push(E.posToCell(c, lp)); // lane
      cells.push(E.RING[(E.START[c] + 50) % 52]);                      // arm tip
      cells.forEach(function (cc) {
        var r = cellRect(m, cc[0], cc[1]);
        rr(ctx, r.x, r.y, r.w, r.h, r.r);
        ctx.fillStyle = lg(ctx, r.x, r.y, r.x, r.y + r.h, [[0, pc.light], [1, pc.base]]);
        ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.14)'; ctx.stroke();
      });
    }

    /* safe stars: unified gold with a soft glow (#FFD700) */
    [8, 21, 34, 47].forEach(function (idx) {
      var cc = E.RING[idx];
      ctx.save();
      ctx.shadowColor = 'rgba(255, 215, 0, 0.55)';
      ctx.shadowBlur = cell * 0.35;
      star4(ctx, cx(m, cc[0]), cy(m, cc[1]), cell * 0.30, cell * 0.105);
      ctx.fillStyle = '#FFD700';
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = Math.max(1, cell * 0.04); ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,215,0,.5)'; ctx.stroke();
    });
    for (var sc = 0; sc < 4; sc++) {
      var stc = E.posToCell(sc, 0);
      star4(ctx, cx(m, stc[0]), cy(m, stc[1]), cell * 0.30, cell * 0.105);
      ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fill();
    }

    /* center home square: four triangles */
    var x0 = m.ox + 6 * cell, y0 = m.oy + 6 * cell, x1 = m.ox + 9 * cell, y1 = m.oy + 9 * cell;
    var mxv = (x0 + x1) / 2, myv = (y0 + y1) / 2;
    var tris = [
      [x0, y1, x1, y1, PLAYERS[0]], // red bottom
      [x0, y0, x0, y1, PLAYERS[1]], // green left
      [x0, y0, x1, y0, PLAYERS[2]], // yellow top
      [x1, y0, x1, y1, PLAYERS[3]]  // blue right
    ];
    tris.forEach(function (t) {
      ctx.beginPath();
      ctx.moveTo(t[0], t[1]); ctx.lineTo(t[2], t[3]); ctx.lineTo(mxv, myv); ctx.closePath();
      var rgc = rg(ctx, mxv, myv, cell * 0.2, mxv, myv, cell * 2.1, [[0, t[4].light], [0.45, t[4].base], [1, t[4].deep]]);
      ctx.save();
      ctx.shadowColor = t[4].base;
      ctx.shadowBlur = cell * 0.5;                     /* central pulse-glow base */
      ctx.fillStyle = rgc;
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = Math.max(1, cell * 0.04); ctx.strokeStyle = th.field; ctx.stroke();
    });
    /* finish diamond */
    ctx.save();
    ctx.translate(mxv, myv); ctx.rotate(Math.PI / 4);
    rr(ctx, -cell * 0.30, -cell * 0.30, cell * 0.6, cell * 0.6, cell * 0.10);
    ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fill();
    ctx.lineWidth = Math.max(1, cell * 0.045); ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.stroke();
    ctx.restore();

    /* yards */
    for (var yc = 0; yc < 4; yc++) drawYard(ctx, m, yc, th);

    /* field vignette */
    rr(ctx, f, f, S - f * 2, S - f * 2, cell * 0.3);
    ctx.fillStyle = rg(ctx, mxv, myv, S * 0.2, mxv, myv, S * 0.78,
      [[0, 'rgba(0,0,0,0)'], [0.75, 'rgba(0,0,0,0)'], [1, 'rgba(20,16,8,.07)']]);
    ctx.fill();
  }

  function drawYard(ctx, m, colorIdx, th) {
    var pc = PLAYERS[colorIdx], cell = m.cell, reg = YARD_REGIONS[colorIdx];
    var x = m.ox + reg[0] * cell + cell * 0.42, y = m.oy + reg[1] * cell + cell * 0.42;
    var w = 6 * cell - cell * 0.84, h = w, r = cell * 0.95;

    rr(ctx, x, y, w, h, r);
    var midX = x + w / 2, midY = y + h / 2;
    ctx.fillStyle = rg(ctx, midX - w * 0.14, midY - h * 0.16, w * 0.06, midX, midY, w * 0.72,
      [[0, pc.light], [0.55, pc.base], [1, pc.dark]]);
    ctx.fill();
    ctx.lineWidth = Math.max(2, cell * 0.09); ctx.strokeStyle = 'rgba(0,0,0,.26)'; ctx.stroke();
    rr(ctx, x + cell * 0.09, y + cell * 0.09, w - cell * 0.18, h - cell * 0.18, r * 0.92);
    ctx.lineWidth = Math.max(1, cell * 0.05); ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.stroke();

    /* soft top sheen */
    ctx.beginPath();
    ctx.ellipse(midX, y + h * 0.24, w * 0.36, h * 0.16, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.09)'; ctx.fill();

    /* yard initial — non-color identification */
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.font = '800 ' + Math.round(cell * 1.1) + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(YARD_INITIALS[colorIdx], x + cell * 0.26, y + cell * 0.2);
    ctx.restore();

    /* docks */
    yardDocks(m, colorIdx).forEach(function (d) {
      ctx.beginPath();
      ctx.ellipse(d.x, d.y + cell * 0.06, cell * 0.62, cell * 0.55, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,.20)'; ctx.fill();
      ctx.beginPath();
      ctx.arc(d.x, d.y, cell * 0.60, 0, Math.PI * 2);
      ctx.fillStyle = pc.deep; ctx.fill();
      ctx.beginPath();
      ctx.arc(d.x, d.y, cell * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = rg(ctx, d.x - cell * 0.2, d.y - cell * 0.22, cell * 0.05, d.x, d.y, cell * 0.6,
        [[0, pc.dark], [1, pc.deep]]);
      ctx.fill();
      ctx.lineWidth = Math.max(1, cell * 0.04);
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.stroke();
    });
  }

  /* ---------- dynamic: glow under the active player’s yard ---------- */
  function drawYardGlow(ctx, m, colorIdx, t) {
    var pc = PLAYERS[colorIdx], cell = m.cell, reg = YARD_REGIONS[colorIdx];
    var x = m.ox + reg[0] * cell, y = m.oy + reg[1] * cell, w = 6 * cell;
    var pulse = 0.5 + 0.5 * Math.sin(t * 2.6);
    rr(ctx, x + cell * 0.3, y + cell * 0.3, w - cell * 0.6, w - cell * 0.6, cell * 0.9);
    ctx.lineWidth = cell * (0.14 + 0.10 * pulse);
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.16 + 0.16 * pulse).toFixed(3) + ')';
    ctx.stroke();
    rr(ctx, x + cell * 0.18, y + cell * 0.18, w - cell * 0.36, w - cell * 0.36, cell * 0.95);
    ctx.lineWidth = cell * 0.10;
    ctx.strokeStyle = pc.light; ctx.save(); ctx.globalAlpha = 0.35 + 0.25 * pulse; ctx.stroke(); ctx.restore();
  }

  /* ---------- tokens ---------- */
  /* (x, y) = base-center point of the pawn. r = base radius. */
  function drawToken(ctx, x, y, r, colorIdx, shape, o) {
    o = o || {};
    var pc = PLAYERS[colorIdx];
    var lift = o.lift || 0, scale = (o.scale || 1) * (1 + lift * 0.10);
    var yy = y - lift * r * 1.3;
    if (o.alpha != null) ctx.save(), ctx.globalAlpha = Math.max(0, Math.min(1, o.alpha));
    ctx.save();
    ctx.translate(x, yy);
    ctx.scale(scale, scale);

    /* shadow stays on the ground plane */
    ctx.beginPath();
    ctx.ellipse(0, (y - yy) + r * 0.92, r * 0.92 * (1 - lift * 0.30), r * 0.30 * (1 - lift * 0.30), 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(5,8,20,' + (0.34 * (1 - lift * 0.45)).toFixed(3) + ')';
    ctx.fill();

    var bodyGrad = lg(ctx, -r, 0, r, 0, [[0, pc.light], [0.45, pc.base], [1, pc.dark]]);
    var lw = Math.max(1, r * 0.06);

    if (shape === 'orb') {
      ctx.beginPath(); ctx.ellipse(0, r * 0.62, r * 1.0, r * 0.38, 0, 0, Math.PI * 2);
      ctx.fillStyle = lg(ctx, 0, r * 0.3, 0, r, [[0, pc.base], [1, pc.dark]]); ctx.fill();
      ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -r * 0.42, r * 0.86, 0, Math.PI * 2);
      ctx.fillStyle = rg(ctx, -r * 0.3, -r * 0.72, r * 0.08, 0, -r * 0.42, r * 0.95,
        [[0, pc.lighter], [0.25, pc.light], [0.7, pc.base], [1, pc.dark]]);
      ctx.fill(); ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(0,0,0,.30)'; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(-r * 0.28, -r * 0.75, r * 0.20, r * 0.13, -0.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill();
    } else if (shape === 'gem') {
      var top = -r * 1.72, girdle = -r * 0.78, bottom = r * 0.66;
      var gw = r * 0.98, tw = r * 0.52;
      ctx.beginPath();
      ctx.moveTo(-tw, top); ctx.lineTo(tw, top); ctx.lineTo(gw, girdle); ctx.lineTo(0, bottom); ctx.lineTo(-gw, girdle); ctx.closePath();
      ctx.fillStyle = lg(ctx, -gw, 0, gw, 0, [[0, pc.light], [0.5, pc.base], [1, pc.dark]]); ctx.fill();
      ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(0,0,0,.30)'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-tw, top); ctx.lineTo(tw, top); ctx.lineTo(gw * 0.6, girdle); ctx.lineTo(-gw * 0.6, girdle); ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,.34)'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(-gw, girdle); ctx.lineTo(0, bottom); ctx.lineTo(0, girdle); ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(gw, girdle); ctx.lineTo(0, bottom); ctx.lineTo(0, girdle); ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,.16)'; ctx.fill();
    } else {
      /* pawn (classic & regal) */
      ctx.beginPath(); ctx.ellipse(0, r * 0.58, r * 0.98, r * 0.36, 0, 0, Math.PI * 2);
      ctx.fillStyle = lg(ctx, 0, r * 0.25, 0, r * 0.95, [[0, pc.base], [0.55, pc.dark], [1, pc.deep]]); ctx.fill();
      ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(0,0,0,.26)'; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r * 0.96, r * 0.52);
      ctx.bezierCurveTo(-r * 0.96, -r * 0.16, -r * 0.46, -r * 0.28, -r * 0.42, -r * 0.92);
      ctx.lineTo(r * 0.42, -r * 0.92);
      ctx.bezierCurveTo(r * 0.46, -r * 0.28, r * 0.96, -r * 0.16, r * 0.96, r * 0.52);
      ctx.quadraticCurveTo(0, r * 0.86, -r * 0.96, r * 0.52);
      ctx.closePath();
      ctx.fillStyle = bodyGrad; ctx.fill();
      ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(0,0,0,.26)'; ctx.stroke();
      /* collar */
      ctx.beginPath(); ctx.ellipse(0, -r * 0.92, r * 0.44, r * 0.15, 0, 0, Math.PI * 2);
      ctx.fillStyle = pc.dark; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.stroke();
      if (shape === 'regal') {
        ctx.beginPath(); ctx.ellipse(0, -r * 0.90, r * 0.47, r * 0.16, 0, 0, Math.PI * 2);
        ctx.fillStyle = lg(ctx, -r * 0.5, 0, r * 0.5, 0, [[0, '#F7DE8B'], [0.5, '#E9BE55'], [1, '#B8871E']]); ctx.fill();
      }
      /* head */
      var hy = -r * 1.34, hr = r * 0.52;
      ctx.beginPath(); ctx.arc(0, hy, hr, 0, Math.PI * 2);
      ctx.fillStyle = rg(ctx, -hr * 0.35, hy - hr * 0.4, hr * 0.1, 0, hy, hr * 1.15,
        [[0, pc.lighter], [0.35, pc.light], [0.75, pc.base], [1, pc.dark]]);
      ctx.fill();
      ctx.lineWidth = lw; ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.stroke();
      if (shape === 'regal') {
        var cy0 = hy - hr - r * 0.05;
        ctx.beginPath();
        ctx.moveTo(-r * 0.30, cy0 + r * 0.16);
        ctx.lineTo(-r * 0.30, cy0 - r * 0.02); ctx.lineTo(-r * 0.15, cy0 + r * 0.08);
        ctx.lineTo(0, cy0 - r * 0.10); ctx.lineTo(r * 0.15, cy0 + r * 0.08);
        ctx.lineTo(r * 0.30, cy0 - r * 0.02); ctx.lineTo(r * 0.30, cy0 + r * 0.16);
        ctx.closePath();
        ctx.fillStyle = lg(ctx, 0, cy0 - r * 0.1, 0, cy0 + r * 0.2, [[0, '#F7DE8B'], [1, '#C8901F']]);
        ctx.fill(); ctx.lineWidth = Math.max(1, r * 0.045); ctx.strokeStyle = '#8A5E10'; ctx.stroke();
      }
      /* gloss */
      ctx.beginPath(); ctx.ellipse(-hr * 0.32, hy - hr * 0.38, hr * 0.26, hr * 0.17, -0.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.58)'; ctx.fill();   /* glossy specular arc */
    }
    ctx.restore();
    if (o.alpha != null) ctx.restore();
  }

  /* pulsing halo under a movable token */
  function drawHalo(ctx, x, y, r, t, colorIdx) {
    var pulse = 0.5 + 0.5 * Math.sin(t * 5.2);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.55, r * 1.35, r * 0.62, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.26 + 0.22 * pulse).toFixed(3) + ')';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.55, r * (1.5 + 0.22 * pulse), r * (0.70 + 0.10 * pulse), 0, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, r * 0.10);
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 + 0.30 * pulse).toFixed(3) + ')';
    ctx.stroke();
    ctx.restore();
  }

  /* destination outline */
  function drawTarget(ctx, m, colRow, t) {
    var pulse = 0.5 + 0.5 * Math.sin(t * 5.2);
    var r = cellRect(m, colRow[0], colRow[1]);
    rr(ctx, r.x + r.w * 0.10, r.y + r.h * 0.10, r.w * 0.80, r.h * 0.80, r.r * 0.8);
    ctx.lineWidth = Math.max(2, m.cell * 0.07);
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.4 + 0.3 * pulse).toFixed(3) + ')';
    ctx.stroke();
  }

  function drawCountBadge(ctx, x, y, n, cell) {
    var r = Math.max(9, cell * 0.30);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(18,13,7,.82)'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,.65)'; ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 ' + Math.round(r * 1.15) + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(n), x, y + r * 0.06);
  }

  /* capture burst shards; p ∈ [0,1] */
  function drawBurst(ctx, x, y, cell, colorIdx, p) {
    var pc = PLAYERS[colorIdx];
    var ease = 1 - Math.pow(1 - p, 2.6);
    var n = 10, i;
    for (i = 0; i < n; i++) {
      var ang = (i / n) * Math.PI * 2 + p * 1.2;
      var dist = ease * cell * 1.7;
      var px = x + Math.cos(ang) * dist, py = y + Math.sin(ang) * dist - p * p * cell * 0.5;
      var s = cell * 0.14 * (1 - p * 0.75);
      ctx.save();
      ctx.translate(px, py); ctx.rotate(ang + p * 5);
      ctx.beginPath();
      ctx.moveTo(0, -s); ctx.lineTo(s * 0.8, s * 0.7); ctx.lineTo(-s * 0.8, s * 0.7); ctx.closePath();
      ctx.globalAlpha = Math.max(0, 1 - p * 1.15);
      ctx.fillStyle = i % 3 === 0 ? '#F6EFE2' : pc.light;
      ctx.fill();
      ctx.restore();
    }
  }

  /* home arrival ripple */
  function drawRipple(ctx, x, y, r0, p) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r0 * (0.5 + p * 1.7), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r0 * 0.28 * (1 - p));
    ctx.strokeStyle = 'rgba(255,255,255,' + Math.max(0, 0.75 * (1 - p)).toFixed(3) + ')';
    ctx.stroke();
    ctx.restore();
  }

  global.LudoraBoard = {
    PLAYERS: PLAYERS, THEMES: THEMES,
    metrics: metrics, cx: cx, cy: cy, cellRect: cellRect,
    yardDocks: yardDocks, homeSlots: homeSlots, pointForPos: pointForPos,
    drawStatic: drawStatic, drawYardGlow: drawYardGlow,
    drawToken: drawToken, drawHalo: drawHalo, drawTarget: drawTarget,
    drawCountBadge: drawCountBadge, drawBurst: drawBurst, drawRipple: drawRipple,
    rr: rr,
    SIDE_OF: SIDE_OF, podLanes: podLanes
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraBoard;
})(typeof window !== 'undefined' ? window : globalThis);
