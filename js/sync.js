/**
 * sync — 端末に貯まったものを PC（git リポジトリ）へ降ろす。
 *
 * 出力は「Markdown ＋ 元画像の JPEG」。両方を降ろすのが要件で、
 * Markdown だけだと崩れる数式や図が PC の Claude に永久に届かない（08差分 §5）。
 *
 * 文字起こしはここではやらない。PC の Claude が画像を直接読む（rev.3）。
 * index.md は「何が入っているか」と「Claude に何をしてほしいか」を書いた案内書。
 */

import * as db from './db.js';
import * as gh from './github.js';

/**
 * git のパスに使えない文字を落とす。日本語はそのまま通す。
 * フォルダ名は `日付-単元-ID` の形なので、単元の中の `-` は `_` に寄せて
 * 区切りと混ざらないようにする。
 */
export function safeSegment(text, fallback = '未分類') {
  const cleaned = String(text ?? '')
    .replace(/[\\/:*?"<>|]/g, '') // git と OS で困る文字
    .replace(/[-\s]+/g, '_') // 区切りの - と空白は _ に寄せる
    .replace(/^\.+/, '') // 先頭のドットは隠しファイル扱いになる
    .replace(/^_+|_+$/g, '')
    .trim();
  return cleaned || fallback;
}

export function dateStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** そのソースが置かれるフォルダ。sourceId を含めるので、同じ日に同じ単元を2本撮っても衝突しない。 */
export function folderFor(source, basePath = 'notes') {
  const subject = safeSegment(source.subject, '未分類');
  const topic = safeSegment(source.topic, '単元未設定');
  const shortId = source.id.split('_').pop();
  return `${basePath}/${subject}/${dateStamp(source.capturedAt)}-${topic}-${shortId}`;
}

/**
 * PC の Claude が最初に読むファイル。
 * 「これは何で、どう扱ってほしいか」を人にも Claude にも分かる形で書く。
 */
export function buildIndexMarkdown(source, pages, folder) {
  const kept = db.keptPages(pages);
  const dropped = pages.filter((p) => p.dropped).length;
  const blank = pages.filter((p) => p.blank).length;
  const counted = source.countedSheets;
  const matches = counted == null ? null : counted === kept.length;

  const lines = [];
  lines.push('---');
  lines.push(`source_id: ${source.id}`);
  lines.push(`subject: ${source.subject ?? ''}`);
  lines.push(`topic: ${source.topic ?? ''}`);
  lines.push(`captured_at: ${new Date(source.capturedAt).toISOString()}`);
  lines.push(`kind: ${source.kind}`);
  lines.push(`pages: ${kept.length}`);
  if (counted != null) lines.push(`counted_sheets: ${counted}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${source.subject ?? '未分類'} · ${source.topic ?? '単元未設定'}`);
  lines.push('');
  lines.push(`${dateStamp(source.capturedAt)} に撮影。ページ画像 ${kept.length} 枚。`);
  lines.push('');

  if (matches === false) {
    lines.push(
      `> **枚数が合っていません。** 教室で数えた実物は ${counted} 枚、取り込めたのは ${kept.length} 枚です。`
    );
    lines.push('> 抜けているページがある可能性があります。');
    lines.push('');
  } else if (matches === true) {
    lines.push(`> 教室で数えた ${counted} 枚と一致しています。`);
    lines.push('');
  }
  if (blank || dropped) {
    lines.push(`除外: 白紙 ${blank} 枚 / 手で捨てた ${dropped} 枚（このフォルダには入れていません）`);
    lines.push('');
  }

  lines.push('## Claude へ');
  lines.push('');
  lines.push('この画像は学校のプリント・板書・手書きノートです。文字起こしはしてありません。');
  lines.push('必要に応じて画像を直接読んでください。次のことを頼まれます:');
  lines.push('');
  lines.push('- 内容の要点をまとめる');
  lines.push('- 一問一答や記述問題を作る（形式は都度指示されます）');
  lines.push('- 過去問と突き合わせて出そうなところを挙げる');
  lines.push('');
  lines.push('読めないページがあれば、無理に推測せず「このページは撮り直しが要る」と伝えてください。');
  lines.push('');
  lines.push('## ページ');
  lines.push('');
  kept.forEach((p, i) => {
    const name = `p${String(i + 1).padStart(3, '0')}.jpg`;
    lines.push(`### ${i + 1}`);
    lines.push('');
    lines.push(`![${i + 1}ページ目](${name})`);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * 1件ぶんをコミットする。
 * @param {string} sourceId
 * @param {object} settings
 * @param {(p:{phase:string,done:number,total:number})=>void} [onProgress]
 */
export async function syncSource(sourceId, settings, onProgress = () => {}) {
  const source = await db.getSource(sourceId);
  if (!source) throw new Error('見つかりません');

  const pages = await db.pagesOf(sourceId);
  const kept = db.keptPages(pages);
  if (kept.length === 0) throw new Error('送るページがありません');

  const folder = folderFor(source, settings.basePath);
  const files = [];

  onProgress({ phase: 'prepare', done: 0, total: kept.length });
  for (let i = 0; i < kept.length; i++) {
    files.push({
      path: `${folder}/p${String(i + 1).padStart(3, '0')}.jpg`,
      base64: await gh.blobToBase64(kept[i].blob),
    });
    onProgress({ phase: 'prepare', done: i + 1, total: kept.length });
  }

  files.push({
    path: `${folder}/index.md`,
    base64: gh.textToBase64(buildIndexMarkdown(source, pages, folder)),
  });

  const message = `${source.subject ?? '未分類'} ${source.topic ?? ''} ${kept.length}ページ (${dateStamp(source.capturedAt)})`.trim();
  const result = await gh.commitFiles(settings, files, message, onProgress);

  await db.updateSource(sourceId, { status: db.STATUS.SYNCED, syncedAt: Date.now() });
  return { ...result, folder };
}
