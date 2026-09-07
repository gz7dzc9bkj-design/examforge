/**
 * videoFrames — めくり動画から1ページずつ切り出す I/O 層。**ブラウザ専用。**
 *
 * 判断のロジックは frameSelect.js（純粋関数）に置き、ここは Canvas と video の
 * 面倒を見るだけにする。07書 §1-2 の「I/O層だけ差し替える」方針そのまま。
 *
 * iOS Safari で踏む地雷（スパイクで実測済み）:
 *  - blob URL では seeked のあと更に 80-100ms 待たないと前のコマを掴む
 *  - 並列にシークすると透明な画像が返る。**必ず逐次で回す**
 *  - Canvas の総メモリ上限は 384MB。1枚ごとに JPEG にして解放しないと落ちる
 *  - 画面を離れると止まる。呼び出し側は「開いたままにして」と出すこと
 *  - 一部の動画は duration が Infinity。末尾へシークして確定させる
 */

import {
  frameDiff,
  segmentStillPeriods,
  pickRepresentatives,
  computeDHash,
  dedupeByHash,
  inkRatio,
  findPaperBox,
  cropGray,
  BLANK_INK_THRESHOLD,
  DUPE_MAX_DIST,
} from './frameSelect.js';

/** 解析用の縮小幅。動きとインク量はこの解像度で十分で、メモリも食わない。 */
const ANALYSIS_WIDTH = 160;
/** 書き出す JPEG の長辺。1600px で文字は十分読める。 */
const EXPORT_MAX_EDGE = 1600;
const EXPORT_QUALITY = 0.82;
/** サンプル数の上限。長すぎる動画で端末が固まるのを防ぐ。 */
const MAX_SAMPLES = 900;

export const DEFAULTS = {
  fps: 4, // 1秒あたり何回調べるか
  minStillSamples: 3, // 何サンプル続けて止まったら1ページとみなすか
  motionThreshold: 7, // これ以下なら「止まっている」
};

/** duration が Infinity で返る動画のために、末尾までシークして長さを確定させる。 */
function resolveDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return Promise.resolve(video.duration);
  }
  return new Promise((resolve) => {
    const done = (d) => {
      video.removeEventListener('durationchange', onChange);
      clearTimeout(timer);
      resolve(d);
    };
    const onChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        const d = video.duration;
        video.currentTime = 0;
        done(d);
      }
    };
    const timer = setTimeout(() => done(video.duration), 4000);
    video.addEventListener('durationchange', onChange);
    video.currentTime = 1e101;
  });
}

/** 指定時刻へシークし、コマが確実に描けるようになるまで待つ。 */
function seekTo(video, t, settleMs = 90) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => video.removeEventListener('seeked', onSeeked);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`シークが返ってきませんでした（${t.toFixed(2)}秒）`));
    }, 6000);
    function onSeeked() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      setTimeout(resolve, settleMs); // ← iOS ではこの待ちが無いと前のコマを掴む
    }
    video.addEventListener('seeked', onSeeked);
    try {
      video.currentTime = t;
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    }
  });
}

/** 次の描画まで制御を返す。これが無いと進捗が画面に出ない。 */
const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * 動画からページを切り出す。
 *
 * @param {File|Blob} file めくり動画
 * @param {object} [options] DEFAULTS を上書きする値
 * @param {(p:{phase:string,done:number,total:number,ratio:number})=>void} [onProgress]
 * @returns {Promise<{pages:Array, diag:object}>}
 */
export async function extractPages(file, options = {}, onProgress = () => {}) {
  const opt = { ...DEFAULTS, ...options };
  const startedAt = performance.now();

  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.preload = 'auto';

  const objectUrl = URL.createObjectURL(file);
  const createdUrls = [];
  const analysis = document.createElement('canvas');
  const actx = analysis.getContext('2d', { willReadFrequently: true });
  const exporter = document.createElement('canvas');
  const ectx = exporter.getContext('2d');

  try {
    video.src = objectUrl;
    onProgress({ phase: 'load', done: 0, total: 1, ratio: 0 });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('動画を読み込めませんでした')), 15000);
      video.addEventListener(
        'loadeddata',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      video.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('この形式の動画は開けませんでした'));
        },
        { once: true }
      );
      video.load();
    });

    const duration = await resolveDuration(video);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('動画の長さが取れませんでした');
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const aw = ANALYSIS_WIDTH;
    const ah = Math.max(1, Math.round((ANALYSIS_WIDTH * vh) / vw));
    analysis.width = aw;
    analysis.height = ah;

    let sampleCount = Math.floor(duration * opt.fps);
    let step = 1 / opt.fps;
    if (sampleCount > MAX_SAMPLES) {
      sampleCount = MAX_SAMPLES;
      step = duration / sampleCount;
    }
    if (sampleCount < 2) throw new Error('動画が短すぎます');

    /* ---- pass 1: 動きとインク量を測る ---- */
    const scores = [];
    const times = [];
    const hashes = [];
    const inks = [];
    const seekMs = [];
    let previous = null;
    let transparentFrames = 0;

    for (let i = 0; i < sampleCount; i++) {
      const t = Math.min(duration - 0.02, i * step);
      const s0 = performance.now();
      await seekTo(video, t);
      seekMs.push(performance.now() - s0);

      actx.drawImage(video, 0, 0, aw, ah);
      const pixels = actx.getImageData(0, 0, aw, ah).data;
      const gray = new Uint8Array(aw * ah);
      let opaque = false;
      for (let p = 0, g = 0; p < pixels.length; p += 4, g++) {
        gray[g] = (pixels[p] * 299 + pixels[p + 1] * 587 + pixels[p + 2] * 114) / 1000;
        if (pixels[p + 3] !== 0) opaque = true;
      }
      if (!opaque) transparentFrames++;

      scores.push(frameDiff(previous, gray));
      times.push(t);

      // 机を含めたまま測るとハッシュもインク量も壊れる（実測済み）
      const box = findPaperBox(gray, aw, ah);
      const paper = cropGray(gray, aw, box);
      hashes.push(computeDHash(paper, box.x1 - box.x0, box.y1 - box.y0));
      inks.push(inkRatio(paper));

      previous = gray;

      if (i % 4 === 0 || i === sampleCount - 1) {
        onProgress({
          phase: 'scan',
          done: i + 1,
          total: sampleCount,
          ratio: ((i + 1) / sampleCount) * 0.7,
        });
        await yieldToUI();
      }
    }

    /* ---- 静止区間 → 代表コマ ---- */
    // 先頭は前フレームが無く常に最大値なので、比較対象から外して番号を戻す
    const periods = segmentStillPeriods(
      scores.slice(1),
      opt.motionThreshold,
      opt.minStillSamples
    ).map((p) => ({ startIdx: p.startIdx + 1, endIdx: p.endIdx + 1 }));

    if (periods.length === 0) {
      throw new Error(
        '止まっているコマが見つかりませんでした。1枚ずつもう少し長く止めて撮ってみてください。'
      );
    }
    const reps = pickRepresentatives(periods);

    /* ---- pass 2: 代表コマを JPEG にする ---- */
    const pages = [];
    for (let k = 0; k < reps.length; k++) {
      const idx = reps[k];
      onProgress({
        phase: 'export',
        done: k + 1,
        total: reps.length,
        ratio: 0.7 + ((k + 1) / reps.length) * 0.3,
      });
      await seekTo(video, times[idx]);

      const scale = Math.min(1, EXPORT_MAX_EDGE / Math.max(vw, vh));
      exporter.width = Math.round(vw * scale);
      exporter.height = Math.round(vh * scale);
      ectx.drawImage(video, 0, 0, exporter.width, exporter.height);
      const blob = await new Promise((res) =>
        exporter.toBlob(res, 'image/jpeg', EXPORT_QUALITY)
      );

      pages.push({
        index: k,
        time: times[idx],
        hash: hashes[idx],
        ink: inks[idx],
        blank: inks[idx] < BLANK_INK_THRESHOLD,
        blob,
        bytes: blob ? blob.size : 0,
      });
      await yieldToUI();
    }

    dedupeByHash(pages, DUPE_MAX_DIST);
    markThinPages(pages);

    const diag = {
      durationSec: duration,
      videoWidth: vw,
      videoHeight: vh,
      samples: sampleCount,
      fps: opt.fps,
      stillPeriods: periods.length,
      transparentFrames,
      avgSeekMs: seekMs.reduce((a, b) => a + b, 0) / seekMs.length,
      maxSeekMs: Math.max(...seekMs),
      elapsedSec: (performance.now() - startedAt) / 1000,
      userAgent: navigator.userAgent,
    };

    return { pages, diag };
  } finally {
    createdUrls.forEach(URL.revokeObjectURL);
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute('src');
    video.load();
    releaseCanvas(analysis);
    releaseCanvas(exporter);
  }
}

/**
 * 中身が極端に薄いページに印を付ける。
 * 白紙ではないが「指で隠れた」「半分はみ出した」ページを拾うのが狙い。
 * 全体の中央値を基準にするので、資料の濃さが違っても効く。
 */
export function markThinPages(pages) {
  const inks = pages.filter((p) => !p.blank).map((p) => p.ink).sort((a, b) => a - b);
  if (inks.length < 4) return pages;
  const median = inks[Math.floor(inks.length / 2)];
  const cut = median * 0.25;
  for (const p of pages) {
    if (!p.blank && p.ink < cut) p.thin = true;
  }
  return pages;
}

/** ページに付いた印を、確認が要る順に並べて返す。 */
export function pagesNeedingReview(pages) {
  return pages.filter((p) => p.blank || p.thin || p.dupeOf != null);
}
