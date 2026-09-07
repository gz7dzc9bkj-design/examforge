/**
 * videoFrames の DOM を触らない部分だけをテストする。
 * extractPages は Canvas と video が要るのでブラウザ側で検証している
 * （spike/index.html の合成動画による通しテスト）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markThinPages, pagesNeedingReview, DEFAULTS } from '../js/videoFrames.js';

const page = (ink, extra = {}) => ({ ink, blank: false, ...extra });

test('markThinPages: 中央値の1/4を切ったページに印を付ける', () => {
  const pages = [page(0.10), page(0.12), page(0.11), page(0.13), page(0.01)];
  markThinPages(pages);
  assert.equal(pages[4].thin, true, '0.01 は中央値0.11の1/4未満なので薄い');
  assert.equal(pages[0].thin, undefined);
  assert.equal(pages[1].thin, undefined);
});

test('markThinPages: 資料全体が薄くても、そろっていれば誰も薄くならない', () => {
  // 鉛筆の手書きノートのつもり。絶対値は小さいが全ページ同じくらい。
  const pages = [page(0.02), page(0.022), page(0.019), page(0.021), page(0.02)];
  markThinPages(pages);
  assert.ok(pages.every((p) => !p.thin), '中央値基準なので全体が薄くても印は付かない');
});

test('markThinPages: 白紙は対象外（白紙として別に扱う）', () => {
  const pages = [page(0.1), page(0.1), page(0.1), page(0.1), { ink: 0, blank: true }];
  markThinPages(pages);
  assert.equal(pages[4].thin, undefined);
});

test('markThinPages: ページが少なすぎると中央値が当てにならないので何もしない', () => {
  const pages = [page(0.1), page(0.001)];
  markThinPages(pages);
  assert.equal(pages[1].thin, undefined);
});

test('pagesNeedingReview: 白紙・薄い・重複だけを拾う', () => {
  const pages = [
    page(0.1),
    { ink: 0, blank: true },
    page(0.01, { thin: true }),
    page(0.1, { dupeOf: 0 }),
    page(0.1),
  ];
  const need = pagesNeedingReview(pages);
  assert.equal(need.length, 3);
  assert.ok(!need.includes(pages[0]));
  assert.ok(!need.includes(pages[4]));
});

test('DEFAULTS: 実機テストで詰めた値から動かない', () => {
  assert.deepEqual(DEFAULTS, { fps: 4, minStillSamples: 3, motionThreshold: 7 });
});
