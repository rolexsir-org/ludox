/* Ludora — dev/svgbridge.js
   Minimal Canvas2D → SVG recorder so board.js can be previewed in Node.
   Approximate (arcs are sampled, text is approximate) — design preview only. */
'use strict';

function mat() { return [1, 0, 0, 1, 0, 0]; }
function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}
function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

function SvgCtx(w, h) {
  this.w = w; this.h = h;
  this.defs = []; this.body = [];
  this.m = mat(); this.stack = [];
  this.fillStyle = '#000'; this.strokeStyle = '#000';
  this.lineWidth = 1; this.lineCap = 'butt'; this.lineJoin = 'miter';
  this.globalAlpha = 1; this._alphaStack = [];
  this.font = '14px sans-serif'; this.textAlign = 'left'; this.textBaseline = 'alphabetic';
  this._d = null; this._newPos = true;
  this._gid = 0;
}
SvgCtx.prototype._esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
SvgCtx.prototype._col = function (c) {
  if (c && c.__grad) return 'url(#' + c.__grad + ')';
  return this._esc(c);
};
SvgCtx.prototype._attrs = function () {
  var a = '';
  if (this.globalAlpha < 1) a += ' opacity="' + this.globalAlpha.toFixed(3) + '"';
  return a;
};
SvgCtx.prototype.clearRect = function (x, y, w, h) {
  this.body.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="#fff"/>');
};
SvgCtx.prototype.save = function () { this.stack.push([this.m, this.globalAlpha]); };
SvgCtx.prototype.restore = function () {
  var s = this.stack.pop();
  if (s) { this.m = s[0]; this.globalAlpha = s[1]; }
};
SvgCtx.prototype.translate = function (x, y) { this.m = mul(this.m, mat.call(null) && [1, 0, 0, 1, x, y]); };
SvgCtx.prototype.rotate = function (a) {
  var c = Math.cos(a), s = Math.sin(a);
  this.m = mul(this.m, [c, s, -s, c, 0, 0]);
};
SvgCtx.prototype.scale = function (x, y) { this.m = mul(this.m, [x, 0, 0, y, 0, 0]); };

SvgCtx.prototype.beginPath = function () { this._d = ''; this._newPos = true; };
SvgCtx.prototype._cmd = function (s) { this._d += s; this._newPos = false; };
SvgCtx.prototype.moveTo = function (x, y) { var p = apply(this.m, x, y); this._cmd('M' + p[0].toFixed(2) + ' ' + p[1].toFixed(2)); this._last = [x, y]; };
SvgCtx.prototype.lineTo = function (x, y) { var p = apply(this.m, x, y); this._cmd('L' + p[0].toFixed(2) + ' ' + p[1].toFixed(2)); this._last = [x, y]; };
SvgCtx.prototype.arcTo = function (x1, y1, x2, y2, r) {
  var prev = this._last || [x1, y1];
  var v1x = prev[0] - x1, v1y = prev[1] - y1;
  var v2x = x2 - x1, v2y = y2 - y1;
  var l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
  var t1 = Math.min(r / l1, 0.5), t2 = Math.min(r / l2, 0.5);
  var a = [x1 + v1x * t1, y1 + v1y * t1];
  var b = [x1 + v2x * t2, y1 + v2y * t2];
  this.lineTo(a[0], a[1]);
  this.quadraticCurveTo(x1, y1, b[0], b[1]);
  this._last = b;
};
SvgCtx.prototype.quadraticCurveTo = function (cx0, cy0, x, y) {
  var c = apply(this.m, cx0, cy0), p = apply(this.m, x, y);
  this._cmd('Q' + c[0].toFixed(2) + ' ' + c[1].toFixed(2) + ' ' + p[0].toFixed(2) + ' ' + p[1].toFixed(2));
  this._last = [x, y];
};
SvgCtx.prototype.bezierCurveTo = function (c1x, c1y, c2x, c2y, x, y) {
  var c1 = apply(this.m, c1x, c1y), c2 = apply(this.m, c2x, c2y), p = apply(this.m, x, y);
  this._cmd('C' + c1[0].toFixed(2) + ' ' + c1[1].toFixed(2) + ' ' + c2[0].toFixed(2) + ' ' + c2[1].toFixed(2) + ' ' + p[0].toFixed(2) + ' ' + p[1].toFixed(2));
  this._last = [x, y];
};
SvgCtx.prototype.closePath = function () { this._cmd('Z'); };
SvgCtx.prototype.arc = function (x, y, r, a0, a1, ccw) {
  var steps = 26, i;
  for (i = 0; i <= steps; i++) {
    var t = a0 + (a1 - a0) * (i / steps);
    var px = x + Math.cos(t) * r, py = y + Math.sin(t) * r;
    if (i === 0 && this._newPos) this.moveTo(px, py); else this.lineTo(px, py);
  }
};
SvgCtx.prototype.ellipse = function (x, y, rx, ry, rot, a0, a1) {
  var steps = 26, i, m2 = this.m;
  for (i = 0; i <= steps; i++) {
    var t = a0 + (a1 - a0) * (i / steps);
    var px = x + Math.cos(t) * rx * Math.cos(rot) - Math.sin(t) * ry * Math.sin(rot);
    var py = y + Math.cos(t) * rx * Math.sin(rot) + Math.sin(t) * ry * Math.cos(rot);
    var p = apply(m2, px, py);
    if (i === 0 && this._newPos) this._cmd('M' + p[0].toFixed(2) + ' ' + p[1].toFixed(2));
    else this._cmd('L' + p[0].toFixed(2) + ' ' + p[1].toFixed(2));
  }
};
SvgCtx.prototype.fillRect = function (x, y, w, h) {
  var p = apply(this.m, x, y);
  this.body.push('<rect x="' + p[0].toFixed(2) + '" y="' + p[1].toFixed(2) + '" width="' + (w * this.m[0]).toFixed(2) + '" height="' + (h * this.m[3]).toFixed(2) + '" fill="' + this._col(this.fillStyle) + '"' + this._attrs() + '/>');
};
SvgCtx.prototype._pathEl = function (fill, stroke) {
  if (!this._d) return;
  var el = '<path d="' + this._d + '"';
  if (fill) el += ' fill="' + this._col(fill) + '"';
  else el += ' fill="none"';
  if (stroke && this.lineWidth > 0) {
    el += ' stroke="' + this._col(stroke) + '" stroke-width="' + (this.lineWidth * Math.sqrt(Math.abs(this.m[0] * this.m[3] - this.m[1] * this.m[2]))).toFixed(2) + '"';
    el += ' stroke-linecap="' + this.lineCap + '" stroke-linejoin="' + this.lineJoin + '"';
  }
  el += this._attrs() + '/>';
  this.body.push(el);
};
SvgCtx.prototype.fill = function () { this._pathEl(this.fillStyle, null); };
SvgCtx.prototype.stroke = function () { this._pathEl(null, this.strokeStyle); };
SvgCtx.prototype.fillText = function (txt, x, y) {
  var p = apply(this.m, x, y);
  var size = (parseFloat(this.font) || 14) * Math.sqrt(Math.abs(this.m[0]));
  this.body.push('<text x="' + p[0].toFixed(1) + '" y="' + p[1].toFixed(1) + '" font-size="' + size.toFixed(1) + '" fill="' + this._col(this.fillStyle) + '" text-anchor="' + (this.textAlign === 'center' ? 'middle' : this.textAlign === 'right' ? 'end' : 'start') + '"' + this._attrs() + '>' + this._esc(txt) + '</text>');
};
SvgCtx.prototype.measureText = function (t) { return { width: t.length * 7 }; };

function toSvgColor(v) {
  if (typeof v === 'string' && v[0] === '#') return v;
  var m = /rgba?\(([^)]+)\)/.exec(String(v));
  if (!m) return String(v);
  var parts = m[1].split(',').map(function (s) { return parseFloat(s); });
  if (parts.length === 4) {
    var hex = parts.slice(0, 3).map(function (n) { return ('0' + Math.round(n).toString(16)).slice(-2); }).join('');
    return { color: '#' + hex, opacity: parts[3] };
  }
  return { color: 'rgb(' + parts.slice(0, 3).join(',') + ')' };
}

SvgCtx.prototype._mkGrad = function (isRadial, coords, stops) {
  var id = 'g' + (++this._gid);
  var a0 = apply(this.m, coords[0], coords[1]);
  var a1 = apply(this.m, coords[2], coords[3]);
  var attrs = '', tag;
  var self = this;
  var stopEls = stops.map(function (s) {
    var c = toSvgColor(s[1]);
    var op = (typeof c === 'object' && c.opacity != null) ? ' stop-opacity="' + c.opacity + '"' : '';
    var col = typeof c === 'object' ? c.color : c;
    return '<stop offset="' + s[0] + '" stop-color="' + col + '"' + op + '/>';
  }).join('');
  if (isRadial) {
    tag = 'radialGradient';
    attrs = 'cx="' + a0[0].toFixed(1) + '" cy="' + a0[1].toFixed(1) + '" r="' + (coords[4] * Math.sqrt(Math.abs(this.m[0] * this.m[3] - this.m[1] * this.m[2]))).toFixed(1) + '" gradientUnits="userSpaceOnUse"';
    attrs += ' fx="' + a0[0].toFixed(1) + '" fy="' + a0[1].toFixed(1) + '"';
  } else {
    tag = 'linearGradient';
    attrs = 'x1="' + a0[0].toFixed(1) + '" y1="' + a0[1].toFixed(1) + '" x2="' + a1[0].toFixed(1) + '" y2="' + a1[1].toFixed(1) + '" gradientUnits="userSpaceOnUse"';
  }
  this.defs.push('<' + tag + ' id="' + id + '" ' + attrs + '>' + stopEls + '</' + tag + '>');
  return { __grad: id };
};
SvgCtx.prototype.createLinearGradient = function (x0, y0, x1, y1) {
  var self = this, stops = [];
  var g = { addColorStop: function (o, c) { stops.push([o, c]); } };
  g.__toSvg = function () { return self._mkGrad(false, [x0, y0, x1, y1], stops); };
  return g;
};
SvgCtx.prototype.createRadialGradient = function (x0, y0, r0, x1, y1, r1) {
  var self = this, stops = [];
  var g = { addColorStop: function (o, c) { stops.push([o, c]); } };
  g.__toSvg = function () { return self._mkGrad(true, [x0, y0, 0, 0, r1], stops); };
  return g;
};

/* resolve lazy gradients inside _col */
var origCol = SvgCtx.prototype._col;
SvgCtx.prototype._col = function (c) {
  if (c && c.__toSvg) { var g = c.__toSvg(); return 'url(#' + g.__grad + ')'; }
  if (c && c.__grad) return 'url(#' + c.__grad + ')';
  var col = origCol.call(this, c);
  return typeof col === 'object' ? col.color : col;
};

SvgCtx.prototype.toSVG = function () {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + this.w + '" height="' + this.h + '" viewBox="0 0 ' + this.w + ' ' + this.h + '">' +
    (this.defs.length ? '<defs>' + this.defs.join('') + '</defs>' : '') +
    this.body.join('') + '</svg>';
};

module.exports = SvgCtx;
