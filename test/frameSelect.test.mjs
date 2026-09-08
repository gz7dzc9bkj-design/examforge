import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameDiff,
  segmentStillPeriods,
  pickRepresentatives,
  computeDHash,
  hamming,
  dedupeByHash,
  inkRatio,
  otsuThreshold,
  findPaperBox,
  cropGray,
  adaptiveMotionThreshold,
  BLANK_INK_THRESHOLD,
  DUPE_MAX_DIST,
} from '../js/frameSelect.js';

/* ---------------- frameDiff ---------------- */

test('frameDiff: 同じ画は 0', () => {
  const a = Uint8Array.from([10, 20, 30, 40]);
  assert.equal(frameDiff(a, Uint8Array.from(a)), 0);
});

test('frameDiff: 前フレームが無ければ最大値', () => {
  assert.equal(frameDiff(null, Uint8Array.from([1, 2])), 255);
});

test('frameDiff: 長さが違えば最大値（サイズ変化を動き扱いしない）', () => {
  assert.equal(frameDiff(Uint8Array.from([1]), Uint8Array.from([1, 2])), 255);
});

test('frameDiff: 平均絶対差', () => {
  assert.equal(frameDiff(Uint8Array.from([0, 0]), Uint8Array.from([10, 20])), 15);
});

/* ---------------- segmentStillPeriods ---------------- */

test('segmentStillPeriods: 止まり→動き→止まり を2区間に分ける', () => {
  //            0  1  2  3   4   5  6  7  8
  const s = [1, 1, 1, 40, 40, 2, 2, 2, 1];
  const p = segmentStillPeriods(s, 5, 3);
  assert.deepEqual(p, [
    { startIdx: 0, endIdx: 2 },
    { startIdx: 5, endIdx: 8 },
  ]);
});

test('segmentStillPeriods: 短すぎる静止は捨てる（めくり途中の一瞬の停止）', () => {
  const s = [1, 1, 40, 40, 1, 1, 1, 1];
  const p = segmentStillPeriods(s, 5, 3);
  assert.deepEqual(p, [{ startIdx: 4, endIdx: 7 }]);
});

test('segmentStillPeriods: 末尾が静止のまま終わっても拾う', () => {
  const s = [40, 1, 1, 1];
  assert.deepEqual(segmentStillPeriods(s, 5, 3), [{ startIdx: 1, endIdx: 3 }]);
});

test('segmentStillPeriods: ずっと動いていれば 0 個', () => {
  assert.deepEqual(segmentStillPeriods([50, 60, 70], 5, 2), []);
});

test('segmentStillPeriods: しきい値ちょうどは静止扱い', () => {
  assert.deepEqual(segmentStillPeriods([5, 5, 5], 5, 3), [{ startIdx: 0, endIdx: 2 }]);
});

/* ---------------- pickRepresentatives ---------------- */

test('pickRepresentatives: 区間の中央を選ぶ', () => {
  assert.deepEqual(
    pickRepresentatives([
      { startIdx: 0, endIdx: 4 },
      { startIdx: 10, endIdx: 11 },
    ]),
    [2, 10]
  );
});

/* ---------------- computeDHash / hamming ---------------- */

const W = 16;
const H = 16;

function makeGray(fn) {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = fn(x, y);
  return g;
}

test('computeDHash: 既定16x16 は 64文字の16進（256bit）', () => {
  const h = computeDHash(makeGray((x) => x * 8), W, H);
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('computeDHash: 同じ画は同じハッシュ', () => {
  const f = (x, y) => (x + y) * 4;
  assert.equal(computeDHash(makeGray(f), W, H), computeDHash(makeGray(f), W, H));
});

test('computeDHash: 全面同色でも落ちない', () => {
  assert.equal(computeDHash(makeGray(() => 128), W, H).length, 64);
});

test('hamming: 同一は 0、左右反転は大きく離れる', () => {
  const a = computeDHash(makeGray((x) => (x < 8 ? 0 : 255)), W, H);
  const b = computeDHash(makeGray((x) => (x < 8 ? 255 : 0)), W, H);
  assert.equal(hamming(a, a), 0);
  assert.ok(hamming(a, b) > DUPE_MAX_DIST, `期待: ${DUPE_MAX_DIST}超, 実際: ${hamming(a, b)}`);
});

test('computeDHash: 同じ体裁で中身だけ違うページを区別できる（実測バグの再発防止）', () => {
  // どちらも「上に見出し、下に罫線」の同じ体裁。行の長さだけが違う。
  // 8x8 平均ハッシュではこれが同一と判定され、8ページ中7ページが重複扱いになった。
  const BIG = 64;
  const page = (seed) => {
    const g = new Uint8Array(BIG * BIG).fill(245);
    for (let x = 8; x < 40; x++) for (let y = 6; y < 12; y++) g[y * BIG + x] = 40; // 見出し
    for (let r = 0; r < 12; r++) {
      const len = 20 + ((r * 7 + seed * 11) % 30); // 行の長さが seed で変わる
      const y = 20 + r * 3;
      for (let x = 8; x < 8 + len; x++) g[y * BIG + x] = 30;
    }
    return g;
  };
  const h1 = computeDHash(page(1), BIG, BIG);
  const h2 = computeDHash(page(2), BIG, BIG);
  const d = hamming(h1, h2);
  assert.ok(d > DUPE_MAX_DIST, `別ページと判定されるべき。距離 ${d} / しきい値 ${DUPE_MAX_DIST}`);
  assert.equal(hamming(h1, computeDHash(page(1), BIG, BIG)), 0, '同じページは距離0');
});

/* ---------------- dedupeByHash ---------------- */

test('dedupeByHash: 隣り合う同一コマに dupeOf を付ける（消さない）', () => {
  const items = [{ hash: 'ffff0000ffff0000' }, { hash: 'ffff0000ffff0000' }, { hash: '0000ffff0000ffff' }];
  const out = dedupeByHash(items, DUPE_MAX_DIST);
  assert.equal(out.length, 3, '要素は消えない');
  assert.equal(out[0].dupeOf, undefined);
  assert.equal(out[1].dupeOf, 0);
  assert.equal(out[2].dupeOf, undefined);
});

test('dedupeByHash: 白紙どうしは重複にしない', () => {
  const items = [
    { hash: 'ffffffffffffffff', blank: true },
    { hash: 'ffffffffffffffff', blank: true },
  ];
  assert.equal(dedupeByHash(items, DUPE_MAX_DIST)[1].dupeOf, undefined);
});

test('dedupeByHash: 距離がしきい値を超えれば別物', () => {
  const items = [{ hash: '0'.repeat(64) }, { hash: 'f'.repeat(64) }];
  assert.equal(dedupeByHash(items, DUPE_MAX_DIST)[1].dupeOf, undefined);
});

/* ---------------- otsu / findPaperBox / cropGray ---------------- */

/** 暗い机の上に明るい紙が1枚ある画をつくる */
function deskWithPaper(w, h, px0, py0, px1, py1, inkFn) {
  const g = new Uint8Array(w * h).fill(45); // 机
  for (let y = py0; y < py1; y++)
    for (let x = px0; x < px1; x++) g[y * w + x] = inkFn ? inkFn(x - px0, y - py0) : 240;
  return g;
}

test('otsuThreshold: 「これより上が紙」を返す（机は含まれない）', () => {
  const g = deskWithPaper(64, 64, 10, 10, 54, 54);
  const t = otsuThreshold(g);
  // 大津法が返すのは境界の値そのもの。45（机）を返せば「45より上＝紙」で正しい。
  assert.ok(t >= 45 && t < 240, `机45と紙240を分けられるべき。実際 ${t}`);
  assert.ok(!(45 > t), '机は前景に入らない');
  assert.ok(240 > t, '紙は前景に入る');
});

test('findPaperBox: 紙の範囲をだいたい当てる', () => {
  const g = deskWithPaper(64, 64, 12, 8, 52, 56);
  const b = findPaperBox(g, 64, 64);
  assert.ok(Math.abs(b.x0 - 12) <= 2 && Math.abs(b.x1 - 52) <= 2, `x: ${b.x0}-${b.x1}`);
  assert.ok(Math.abs(b.y0 - 8) <= 2 && Math.abs(b.y1 - 56) <= 2, `y: ${b.y0}-${b.y1}`);
});

test('findPaperBox: 画面いっぱいが紙なら全体を返す', () => {
  const b = findPaperBox(makeGray(() => 240), W, H);
  assert.deepEqual(b, { x0: 0, y0: 0, x1: W, y1: H });
});

test('findPaperBox: 紙が写っていなければ全体を返す（勝手に切らない）', () => {
  const b = findPaperBox(makeGray(() => 30), W, H);
  assert.deepEqual(b, { x0: 0, y0: 0, x1: W, y1: H });
});

test('cropGray: 切り出した画素が元と一致する', () => {
  const g = makeGray((x, y) => (x + y * W) % 256);
  const box = { x0: 2, y0: 3, x1: 6, y1: 7 };
  const c = cropGray(g, W, box);
  assert.equal(c.length, 16);
  assert.equal(c[0], g[3 * W + 2]);
  assert.equal(c[5], g[4 * W + 3]);
});

test('通し: 机つきの画は、切り出してからでないとページを区別できない（実測バグの再発防止）', () => {
  const S = 64;
  const mk = (seed) =>
    deskWithPaper(S, S, 10, 6, 54, 58, (x, y) => {
      if (y % 4 !== 0) return 242;
      const len = 12 + ((y * 3 + seed * 9) % 26);
      return x < len ? 30 : 242;
    });
  const a = mk(1);
  const b = mk(2);

  // 机を含めたまま → ハッシュが「紙の位置」しか見ず、別ページなのに近い
  const dRaw = hamming(computeDHash(a, S, S), computeDHash(b, S, S));

  // 紙だけ切り出す → 中身の違いが出る
  const ba = findPaperBox(a, S, S);
  const bb = findPaperBox(b, S, S);
  const dCrop = hamming(
    computeDHash(cropGray(a, S, ba), ba.x1 - ba.x0, ba.y1 - ba.y0),
    computeDHash(cropGray(b, S, bb), bb.x1 - bb.x0, bb.y1 - bb.y0)
  );

  assert.ok(dCrop > dRaw, `切り出した方が離れるはず。切り出し後 ${dCrop} / 生 ${dRaw}`);
  assert.ok(dCrop > DUPE_MAX_DIST, `別ページと判定されるべき。距離 ${dCrop} / しきい値 ${DUPE_MAX_DIST}`);
});

/* ---------------- inkRatio ---------------- */

test('inkRatio: 一様な面は 0（白紙・机）', () => {
  assert.equal(inkRatio(makeGray(() => 240)), 0);
  assert.equal(inkRatio(makeGray(() => 10)), 0);
});

test('inkRatio: 白紙の紙を切り出すと 0（机を含めると外れる）', () => {
  const S = 64;
  const g = deskWithPaper(S, S, 10, 6, 54, 58); // 真っ白な紙
  const box = findPaperBox(g, S, S);
  const cropped = cropGray(g, S, box);
  assert.equal(inkRatio(cropped), 0, '切り出せば白紙と分かる');
  assert.ok(inkRatio(g) > BLANK_INK_THRESHOLD, '机ごと渡すと机をインクと数えてしまう');
});

test('inkRatio: 白地に黒い行があれば 0 より大きい', () => {
  const g = makeGray((x, y) => (y % 4 === 0 ? 20 : 245));
  const r = inkRatio(g);
  assert.ok(r > BLANK_INK_THRESHOLD, `期待: ${BLANK_INK_THRESHOLD} 超, 実際: ${r}`);
});

test('inkRatio: 白紙しきい値は、ごく薄い汚れを白紙側に落とす', () => {
  // 256画素中1画素だけ黒 = 0.0039 < 0.012
  const g = makeGray(() => 245);
  g[0] = 0;
  assert.ok(inkRatio(g) < BLANK_INK_THRESHOLD);
});

/* ---------------- 通し ---------------- */

test('通し: 8ページぶんの動きスコアから8枚を取り出す', () => {
  // 1ページ = 静止4サンプル + めくり2サンプル
  const scores = [];
  for (let p = 0; p < 8; p++) {
    scores.push(2, 1, 2, 1); // 止まっている
    if (p < 7) scores.push(60, 55); // めくっている
  }
  const periods = segmentStillPeriods(scores, 6, 3);
  assert.equal(periods.length, 8, `8区間を期待, 実際 ${periods.length}`);
  assert.equal(pickRepresentatives(periods).length, 8);
});

/* ---------------- adaptiveMotionThreshold ---------------- */

test('adaptiveMotionThreshold: 先頭の番兵255を無視する', () => {
  const t = adaptiveMotionThreshold([255, 10, 10, 10, 10]);
  assert.equal(t, 13, '中央値10 x1.3');
});

test('adaptiveMotionThreshold: 実機の分布で、静止帯とめくり帯の谷に入る', () => {
  // 2026-09-08 の実測（手持ち・見開き6枚・11秒）を写したもの。
  // 静止中でも 5〜12 まで揺れ、めくり中は 16〜31。
  const still = [6.7, 7.4, 9.4, 10.0, 6.3, 6.6, 7.5, 6.8, 8.3, 7.2, 6.8, 6.1, 8.4, 8.1, 5.7, 9.7, 5.5, 7.7];
  const flip = [18.2, 26.3, 30.1, 28.6, 23.7, 16.6, 20.8, 25.0, 30.2, 21.6];
  const t = adaptiveMotionThreshold([255, ...still, ...flip]);
  assert.ok(t > Math.max(...still), `静止帯(最大${Math.max(...still)})より上であるべき。実際 ${t}`);
  assert.ok(t < Math.min(...flip), `めくり帯(最小${Math.min(...flip)})より下であるべき。実際 ${t}`);
});

test('adaptiveMotionThreshold: 固定7ではこの実機データが1区間も取れない（回帰防止）', () => {
  const still = [6.7, 7.4, 9.4, 10.0, 6.3, 6.6, 7.5, 6.8, 8.3];
  const flip = [18.2, 26.3, 30.1];
  const scores = [...still, ...flip, ...still];
  assert.equal(segmentStillPeriods(scores, 7, 3).length, 0, '固定7では取れない');
  const t = adaptiveMotionThreshold([255, ...scores]);
  assert.ok(segmentStillPeriods(scores, t, 3).length >= 2, `自動なら取れる。しきい値 ${t}`);
});

test('adaptiveMotionThreshold: 完全に静止した合成動画でも壊れない', () => {
  const scores = [255, 1, 2, 1, 2, 55, 60, 1, 2, 1, 2];
  const t = adaptiveMotionThreshold(scores);
  assert.ok(t < 55, '静止1-2とめくり55を分けられる');
  assert.equal(segmentStillPeriods(scores.slice(1), t, 3).length, 2);
});

test('adaptiveMotionThreshold: 上下に歯止めがある', () => {
  assert.equal(adaptiveMotionThreshold([255, 0, 0, 0, 0]), 4, '下限4');
  assert.equal(adaptiveMotionThreshold([255, 200, 200, 200, 200]), 40, '上限40');
});

test('adaptiveMotionThreshold: サンプルが少なすぎるときは下限を返す', () => {
  assert.equal(adaptiveMotionThreshold([255, 9]), 4);
});
