/* Ludora — dev/qr-tests.cjs
   QR encoder verification: structural invariants, published known-answer
   vector for the format information, capacity table vs ISO/IEC 18004,
   mask/format consistency, and oversized-payload refusal. */
'use strict';
const QR = require('../js/qr.js');
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e && e.message || e)); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

function check(qr, v) {
  if (!qr) throw new Error('encode failed');
  if (qr.size !== v * 4 + 17) throw new Error('bad size');
  const m = qr.modules, n = qr.size;
  [[0, 0], [0, n - 7], [n - 7, 0]].forEach(([r, c]) => {
    if (!m[r + 3][c + 3] || m[r][c] !== 1 || m[r + 6][c + 6] !== 1) throw new Error('finder broken');
  });
  for (let t2 = 8; t2 < n - 8; t2++) if (m[6][t2] !== (t2 % 2 === 0 ? 1 : 0)) throw new Error('timing broken');
  if (m[n - 8][8] !== 1) throw new Error('dark module missing');
  const A = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  let fmt1 = 0;
  A.forEach(([r, c]) => { fmt1 = (fmt1 << 1) | m[r][c]; });
  let fmt2 = 0;
  for (let j = 0; j < 7; j++) fmt2 = (fmt2 << 1) | m[n - 1 - j][8];
  for (let k = 0; k < 7; k++) fmt2 = (fmt2 << 1) | m[8][n - 7 + k];
  const f1h = (fmt1 >> 8) & 0x7f, f1l = fmt1 & 0x7f, f2h = (fmt2 >> 7) & 0x7f, f2l = fmt2 & 0x7f;
  if (f1h !== f2h || f1l !== f2l) throw new Error('format copies differ');
  let rem = fmt1 ^ 0x5412;                     // full 15-bit BCH check
  for (let i = 4; i >= 0; i--) if (rem & (1 << (i + 10))) rem ^= (0x537 << i);
  if (rem !== 0) throw new Error('format BCH invalid');
  const data = (fmt1 ^ 0x5412) >> 10;
  if ((data >> 3) !== 1) throw new Error('not EC-L');
  if ((data & 7) !== qr.mask) throw new Error('mask mismatch');
  return true;
}

console.log('\nQR ENCODER');
t('format info matches the published (EC-L, mask 0) vector 0x77C4', () => {
  assert(QR._bchFormat(0) === 0x77c4, 'got 0x' + QR._bchFormat(0).toString(16));
});
t('capacity table matches ISO EC-L data codeword counts (v1–20)', () => {
  const caps = { 1: 19, 2: 34, 3: 55, 4: 80, 5: 108, 6: 136, 7: 156, 8: 194, 9: 232, 10: 274,
                 11: 324, 12: 370, 13: 428, 14: 461, 15: 523, 16: 589, 17: 647, 18: 721, 19: 795, 20: 861 };
  for (const v of Object.keys(caps)) assert(QR._capacityOf(+v) === caps[v], 'v' + v);
});
t('payloads across versions encode with valid structure', () => {
  for (const len of [5, 30, 100, 300, 600, 858]) {
    check(QR.encodeText('A'.repeat(len)), QR._pickVersion(len));
  }
});
t('invite-code-sized URL encodes (multi-block version)', () => {
  const url = 'https://ludora.app/#j=LUD0.' + 'a'.repeat(520);
  check(QR.encodeText(url), QR._pickVersion(url.length));
});
t('oversized payloads are refused, not corrupted', () => {
  assert(QR.encodeText('X'.repeat(2000)) === null);
});
t('RS encoder produces the correct number of EC codewords deterministically', () => {
  const ec1 = QR._rsEncode([0x10, 0x20, 0x0B, 0xEC, 0x11], 7);
  const ec2 = QR._rsEncode([0x10, 0x20, 0x0B, 0xEC, 0x11], 7);
  if (ec1.length !== 7) throw new Error('bad length');
  if (JSON.stringify(ec1) !== JSON.stringify(ec2)) throw new Error('not deterministic');
});

console.log('\n' + (failed ? '✗ ' + failed + ' FAILED, ' + passed + ' passed' : 'ALL ' + passed + ' QR TESTS PASSED') + '\n');
process.exit(failed ? 1 : 0);
