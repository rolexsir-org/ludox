/* Ludora — dev/preview-board.cjs
   Renders board.js through the SVG bridge → PNG for visual design review. */
'use strict';
global.LudoraEngine = require('../js/engine.js');
const Board = require('../js/board.js');
const SvgCtx = require('./svgbridge.js');

const S = 1020;
const ctx = new SvgCtx(S, S);
const m = Board.metrics(S);

Board.drawStatic(ctx, m, process.argv[2] || 'ivory');

/* sample mid-game tokens + effects to preview everything at once */
const demo = [
  [0, 0, 5], [0, 1, 20], [0, 2, 34], [0, 3, 55],
  [1, 0, 8], [1, 1, 8], [1, 2, 44], [1, 3, 56],
  [2, 0, 0], [2, 1, 13], [2, 2, 30], [2, 3, 51],
  [3, 0, 26], [3, 1, 39], [3, 2, 47], [3, 3, 21]
];
const shapes = ['classic', 'orb', 'gem', 'regal'];
demo.forEach(([ci, ti, pos]) => {
  const homeCount = demo.filter(d => d[0] === ci && d[2] === 56 && d[1] < ti).length;
  const pt = Board.pointForPos(m, ci, pos, ti, homeCount);
  const scale = pos === 56 ? 0.52 : 1;
  Board.drawToken(ctx, pt.x, pt.y + m.cell * 0.14, m.cell * 0.42, ci, shapes[ci], { scale, lift: 0 });
});
/* stack badge on green pair at pos 8 */
const g8 = Board.pointForPos(m, 1, 8, 0);
Board.drawCountBadge(ctx, g8.x + m.cell * 0.34, g8.y - m.cell * 0.52, 2, m.cell);
/* halo + target preview */
const r0 = Board.pointForPos(m, 2, 13, 1);
Board.drawHalo(ctx, r0.x, r0.y + m.cell * 0.14, m.cell * 0.42, 0.8, 2);
Board.drawYardGlow(ctx, m, 0, 0.9);
Board.drawBurst(ctx, Board.pointForPos(m, 2, 30, 2).x, Board.pointForPos(m, 2, 30, 2).y, m.cell, 3, 0.45);

const fs = require('fs');
fs.writeFileSync('/home/user/dev/preview.svg', ctx.toSVG());
console.log('wrote dev/preview.svg');
