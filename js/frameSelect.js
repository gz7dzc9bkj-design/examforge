/**
 * frameSelect — めくり動画から「静止しているコマ＝ページ」を選び出す純粋関数群。
 *
 * 07_HANDOFF_CLAUDE_CODE.md §1-2 に従い、ここには I/O を一切置かない。
 * ブラウザ（Canvas API）でも Node.js（テスト）でも無改変で動く。
 * I/O 層は lib/client/videoFrames.js（ブラウザ専用）が担当する。
 *
 * 原本の 05_frameSelect.ts が見つかった場合は、この実装を破棄して原本に差し替えること。
 */

/** 縮小グレースケール2枚の平均絶対差（0-255）。前フレームが無い場合は最大値。 */
export function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/**
 * 動きスコアの列から、静止している区間を切り出す。
 * @param {number[]} scores  各サンプルの動きスコア
 * @param {number} threshold これ以下なら「止まっている」
 * @param {number} minLen    この本数以上続いて初めて1ページとみなす
 * @returns {{startIdx:number,endIdx:number}[]}
 */
export function segmentStillPeriods(scores, threshold, minLen) {
  const out = [];
  let run = -1;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] <= threshold) {
      if (run < 0) run = i;
    } else {
      if (run >= 0 && i - run >= minLen) out.push({ startIdx: run, endIdx: i - 1 });
      run = -1;
    }
  }
  if (run >= 0 && scores.length - run >= minLen) {
    out.push({ startIdx: run, endIdx: scores.length - 1 });
  }
  return out;
}

/** 各静止区間の中央を代表コマとして選ぶ（端はめくり動作が混ざりやすい）。 */
export function pickRepresentatives(periods) {
  return periods.map((p) => Math.floor((p.startIdx + p.endIdx) / 2));
}

/**
 * ページの見た目ハッシュ。16x16 = 256bit を16進64文字で返す。
 * 07書の API 名 computeDHash を保つが、中身は**平均ハッシュ**である。
 *
 * ここに至るまでに2回間違えているので、経緯を残す（同じ道を通らないため）:
 *
 *  1. 8x8 の平均ハッシュ（64bit）
 *     → 合成動画の実測で 8ページ中 7ページが重複扱い。同じ体裁のプリントを
 *       区別するには粗すぎた。実際のプリントは40ページとも同じ体裁なので致命的。
 *
 *  2. 差分ハッシュ（隣接セルの大小、16x16）
 *     → さらに悪化し、別ページの距離が 0 になった。256bit 中 11bit しか立たない。
 *       白地に黒インクの文書は平坦な面が多く、大小比較がほぼ引き分けになる。
 *       しかも拾えるのは「白→黒」の左端だけで、行の長さの違い（右端）が
 *       構造的に一切反映されない。写真向けの手法で、文書には効かない。
 *
 *  3. 平均ハッシュ 16x16（これ）
 *     → 実測: 同じ体裁で中身違いのページ 35 / 同一コマ 0。
 *       解像度別の実測は S=8:6, 12:14, 16:35, 24:63。16 で十分に分離する。
 *
 * 文書では「インクがどこにあるか」がページの個性なので、
 * 勾配ではなく明暗そのものを符号化するのが正しい。
 *
 * @param {Uint8Array} gray グレースケール画素（w*h）
 * @param {number} S グリッドの一辺。ビット数は S*S
 */
export function computeDHash(gray, w, h, S = 16) {
  const cell = new Float64Array(S * S);
  const cnt = new Uint32Array(S * S);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(S - 1, Math.floor((y * S) / h));
    for (let x = 0; x < w; x++) {
      const gx = Math.min(S - 1, Math.floor((x * S) / w));
      const k = gy * S + gx;
      cell[k] += gray[y * w + x];
      cnt[k]++;
    }
  }
  let mean = 0;
  for (let i = 0; i < cell.length; i++) {
    cell[i] /= cnt[i] || 1;
    mean += cell[i];
  }
  mean /= cell.length;

  let hex = '';
  for (let b = 0; b < cell.length; b += 4) {
    let nib = 0;
    for (let j = 0; j < 4; j++) if (cell[b + j] > mean) nib |= 1 << (3 - j);
    hex += nib.toString(16);
  }
  return hex;
}

/** 2つのハッシュのハミング距離（0-64）。 */
export function hamming(h1, h2) {
  let d = 0;
  for (let i = 0; i < h1.length; i++) {
    let x = parseInt(h1[i], 16) ^ parseInt(h2[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/**
 * 連続する近いコマに dupeOf を付ける。**消さない**（08差分 §3「見せてから消す」）。
 * 白紙どうしは重複判定から外す（白紙は別枠で扱うため）。
 */
export function dedupeByHash(items, maxDist) {
  for (let i = 1; i < items.length; i++) {
    if (items[i].blank || items[i - 1].blank) continue;
    if (hamming(items[i].hash, items[i - 1].hash) <= maxDist) items[i].dupeOf = i - 1;
  }
  return items;
}

/**
 * 大津の二値化しきい値。紙（明るい）と机（暗い）を分ける。
 */
export function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) {
      bestVar = v;
      best = t;
    }
  }
  return best;
}

/**
 * 紙が写っている矩形を推定する。
 *
 * これは「後回しにできる装飾」ではない。机の背景を含んだまま解析すると、
 * ハッシュが「紙がどこにあるか」だけを符号化して全ページ同一に見え、
 * 白紙判定も暗い机をインクと数えて必ず外れる（どちらも実測で確認済み）。
 *
 * 行・列ごとの「明るい画素の割合」を取り、30%を超える範囲を紙とみなす。
 * 紙が見つからない（画面いっぱいが紙、または紙が無い）場合は全体を返す。
 *
 * @returns {{x0:number,y0:number,x1:number,y1:number}} x1,y1 は含まない
 */
export function findPaperBox(gray, w, h) {
  const full = { x0: 0, y0: 0, x1: w, y1: h };
  const t = otsuThreshold(gray);
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  let bright = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] > t) {
        rows[y]++;
        cols[x]++;
        bright++;
      }
    }
  }
  // 画面のほぼ全部が明るい＝紙で埋まっている。切らずに全体を使う。
  if (bright > w * h * 0.92) return full;
  // 明るい部分が少なすぎる＝紙が写っていない。判断材料が無いので全体を返す。
  if (bright < w * h * 0.05) return full;

  const span = (profile, len, limit) => {
    const need = limit * 0.3;
    let a = 0;
    let b = len - 1;
    while (a < len && profile[a] < need) a++;
    while (b > a && profile[b] < need) b--;
    return [a, b + 1];
  };
  const [y0, y1] = span(rows, h, w);
  const [x0, x1] = span(cols, w, h);
  if (x1 - x0 < w * 0.15 || y1 - y0 < h * 0.15) return full;
  return { x0, y0, x1, y1 };
}

/** 矩形で切り出した新しいグレースケールを返す。 */
export function cropGray(gray, w, box) {
  const cw = box.x1 - box.x0;
  const ch = box.y1 - box.y0;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const src = (box.y0 + y) * w + box.x0;
    out.set(gray.subarray(src, src + cw), y * cw);
  }
  return out;
}

/**
 * 「文字らしさ」。白紙の判定に使う。**紙の領域だけを渡すこと。**
 * 机が混ざると机の暗さをインクと数えてしまう。
 *
 * 紙の明るさを 90 パーセンタイルで見積もり、そこから十分暗い画素をインクとする。
 * 明暗差がほとんど無い面は 0 を返す（白紙・均一な面）。
 */
export function inkRatio(gray) {
  if (gray.length === 0) return 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let acc = 0;
  let p90 = 255;
  const target = gray.length * 0.9;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) {
      p90 = v;
      break;
    }
  }
  let min = 255;
  for (let i = 0; i < gray.length; i++) if (gray[i] < min) min = gray[i];
  if (p90 - min < 18) return 0;
  const cut = p90 * 0.72;
  let n = 0;
  for (let j = 0; j < gray.length; j++) if (gray[j] < cut) n++;
  return n / gray.length;
}

/** 白紙とみなすしきい値。08差分 §3「白紙は外すが消さない」で使う。 */
export const BLANK_INK_THRESHOLD = 0.012;

/**
 * 重複とみなすハミング距離のしきい値（256bit に対して）。
 * 実測: 同一コマ 0 / 同じ体裁で中身違いのページ 35。
 * 16（全体の6%）は両者のあいだにあり、動画のノイズぶんの余裕も残る。
 * ここを上げすぎると、同じ体裁のプリントが全部重複になる（過去に踏んだ）。
 */
export const DUPE_MAX_DIST = 16;
