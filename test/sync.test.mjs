import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeSegment, dateStamp, folderFor, buildIndexMarkdown } from '../js/sync.js';
import { bytesToBase64, textToBase64 } from '../js/github.js';

/* ---------------- パス ---------------- */

test('safeSegment: 日本語はそのまま通す', () => {
  assert.equal(safeSegment('世界史'), '世界史');
  assert.equal(safeSegment('フランス革命'), 'フランス革命');
});

test('safeSegment: git と OS で困る文字を落とす', () => {
  assert.equal(safeSegment('数学/物理'), '数学物理');
  assert.equal(safeSegment('第1章:導入'), '第1章導入');
  assert.equal(safeSegment('a*b?c"d<e>f|g'), 'abcdefg');
});

test('safeSegment: 区切りに使う - と空白は _ に寄せる', () => {
  assert.equal(safeSegment('第一次-世界大戦'), '第一次_世界大戦');
  assert.equal(safeSegment('酸 と 塩基'), '酸_と_塩基');
});

test('safeSegment: 先頭のドットは隠しファイルになるので落とす', () => {
  assert.equal(safeSegment('..gitignore'), 'gitignore');
});

test('safeSegment: 空なら代わりの名前を使う', () => {
  assert.equal(safeSegment(''), '未分類');
  assert.equal(safeSegment(null), '未分類');
  assert.equal(safeSegment('///'), '未分類');
  assert.equal(safeSegment(undefined, '単元未設定'), '単元未設定');
});

test('dateStamp: 現地時間の YYYY-MM-DD', () => {
  const d = new Date(2026, 8, 7, 10, 22); // 2026-09-07 10:22 現地
  assert.equal(dateStamp(d.getTime()), '2026-09-07');
});

test('folderFor: 同じ日に同じ単元を2本撮っても衝突しない', () => {
  const at = new Date(2026, 8, 7).getTime();
  const a = folderFor({ id: 'src_abc_1111aaaa', subject: '世界史', topic: 'フランス革命', capturedAt: at });
  const b = folderFor({ id: 'src_abc_2222bbbb', subject: '世界史', topic: 'フランス革命', capturedAt: at });
  assert.notEqual(a, b, 'sourceId が入っているので別フォルダになる');
  assert.equal(a, 'notes/世界史/2026-09-07-フランス革命-1111aaaa');
});

test('folderFor: 科目と単元が空でも壊れない', () => {
  const f = folderFor({ id: 'src_x_zzzz', subject: null, topic: null, capturedAt: Date.now() });
  assert.match(f, /^notes\/未分類\/\d{4}-\d{2}-\d{2}-単元未設定-zzzz$/);
});

/* ---------------- index.md ---------------- */

const page = (i, extra = {}) => ({
  index: i,
  blank: false,
  dropped: false,
  blob: null,
  ...extra,
});

test('buildIndexMarkdown: front matter と枚数が入る', () => {
  const source = {
    id: 'src_1_abcd',
    subject: '化学',
    topic: '電池',
    kind: 'video',
    capturedAt: new Date(2026, 8, 7).getTime(),
    countedSheets: 3,
  };
  const pages = [page(0), page(1), page(2)];
  const md = buildIndexMarkdown(source, pages, 'notes/化学/x');

  assert.match(md, /^---\n/);
  assert.match(md, /source_id: src_1_abcd/);
  assert.match(md, /subject: 化学/);
  assert.match(md, /pages: 3/);
  assert.match(md, /counted_sheets: 3/);
  assert.match(md, /# 化学 · 電池/);
  assert.match(md, /!\[1ページ目\]\(p001\.jpg\)/);
  assert.match(md, /!\[3ページ目\]\(p003\.jpg\)/);
});

test('buildIndexMarkdown: 枚数が合っていれば一致と書く', () => {
  const source = { id: 'a_b_c', subject: '化学', topic: '電池', kind: 'video', capturedAt: Date.now(), countedSheets: 2 };
  const md = buildIndexMarkdown(source, [page(0), page(1)], 'x');
  assert.match(md, /教室で数えた 2 枚と一致/);
});

test('buildIndexMarkdown: 枚数が合わなければ警告を出す（取りこぼしの唯一の手がかり）', () => {
  const source = { id: 'a_b_c', subject: '化学', topic: '電池', kind: 'video', capturedAt: Date.now(), countedSheets: 5 };
  const md = buildIndexMarkdown(source, [page(0), page(1)], 'x');
  assert.match(md, /枚数が合っていません/);
  assert.match(md, /実物は 5 枚、取り込めたのは 2 枚/);
});

test('buildIndexMarkdown: 白紙と捨てたページは本文に載せない', () => {
  const source = { id: 'a_b_c', subject: '化学', topic: '電池', kind: 'video', capturedAt: Date.now(), countedSheets: null };
  const pages = [page(0), page(1, { blank: true }), page(2, { dropped: true }), page(3)];
  const md = buildIndexMarkdown(source, pages, 'x');
  assert.match(md, /pages: 2/);
  assert.match(md, /白紙 1 枚 \/ 手で捨てた 1 枚/);
  assert.match(md, /p002\.jpg/);
  assert.ok(!md.includes('p003.jpg'), '残った2枚ぶんしか参照しない');
});

test('buildIndexMarkdown: Claude への指示が入っている', () => {
  const source = { id: 'a_b_c', subject: '化学', topic: '電池', kind: 'video', capturedAt: Date.now(), countedSheets: null };
  const md = buildIndexMarkdown(source, [page(0)], 'x');
  assert.match(md, /## Claude へ/);
  assert.match(md, /文字起こしはしてありません/);
  assert.match(md, /撮り直しが要る/);
});

/* ---------------- base64 ---------------- */

test('bytesToBase64: 素直な変換', () => {
  assert.equal(bytesToBase64(new Uint8Array([104, 105])), 'aGk=');
});

test('bytesToBase64: 大きい配列でも落ちない（spread だと落ちる大きさ）', () => {
  const big = new Uint8Array(300000).fill(65);
  const b64 = bytesToBase64(big);
  assert.equal(b64.length, Math.ceil(300000 / 3) * 4);
});

test('textToBase64: 日本語が壊れない', () => {
  const b64 = textToBase64('世界史');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), '世界史');
});
