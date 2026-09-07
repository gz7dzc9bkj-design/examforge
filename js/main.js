/**
 * main — 画面遷移と結線。
 *
 * 判断のロジックはすべて別モジュール（frameSelect / videoFrames / db / sync）にあり、
 * ここは「押されたら何を呼ぶか」と「結果をどう出すか」だけを持つ。
 */

import * as db from './db.js';
import * as settings from './settings.js';
import * as sync from './sync.js';
import { extractPages, pagesNeedingReview } from './videoFrames.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ---------------- 状態 ---------------- */

const state = {
  screen: 's-home',
  pendingFile: null, // 枚数を聞いている最中の動画
  triageSource: null,
  pages: [],
  pageUrls: [], // ObjectURL。画面を離れるときに必ず解放する
  readIndex: 0,
  reviewed: new Set(),
};

const SUBJECT_SUGGESTIONS = ['化学', '世界史', '数学Ⅲ', '古典', '英語', '物理', '現代文'];

/* ---------------- 画面遷移 ---------------- */

function show(id) {
  if (id !== 's-read' && id !== 's-pages') releasePageUrls();
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === id));
  closeSheet();
  state.screen = id;
  const render = RENDERERS[id];
  if (render) render();
}

function releasePageUrls() {
  state.pageUrls.forEach(URL.revokeObjectURL);
  state.pageUrls = [];
}

function urlFor(blob) {
  const u = URL.createObjectURL(blob);
  state.pageUrls.push(u);
  return u;
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go]');
  if (t) show(t.getAttribute('data-go'));
});

/* ---------------- トースト ---------------- */

let toastTimer = null;
let undoAction = null;

function toast(message, onUndo) {
  const box = $('toast');
  box.firstElementChild.textContent = message;
  const btn = box.querySelector('button');
  undoAction = onUndo || null;
  btn.hidden = !onUndo;
  box.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('on'), onUndo ? 5000 : 2600);
}
$('toast').querySelector('button').addEventListener('click', () => {
  if (undoAction) undoAction();
  undoAction = null;
  $('toast').classList.remove('on');
});

/* ---------------- シート ---------------- */

function openSheet(build) {
  const inner = $('sheet-in');
  inner.innerHTML = '';
  build(inner);
  $('sheet').classList.add('on');
}
function closeSheet() {
  $('sheet').classList.remove('on');
}

/** 選択肢を下から出す。別画面へ飛ばさないのが要件。 */
function pick(title, options, onPick, { allowFree = true } = {}) {
  openSheet((box) => {
    box.appendChild(el('span', 'h', title));
    const list = el('div', 'picklist');
    options.forEach((opt) => {
      const b = el('button', null, opt);
      b.type = 'button';
      b.addEventListener('click', () => {
        closeSheet();
        onPick(opt);
      });
      list.appendChild(b);
    });
    box.appendChild(list);
    if (allowFree) {
      const free = el('button', 'btn ghost', '自分で書く');
      free.addEventListener('click', () => {
        const v = prompt(title);
        closeSheet();
        if (v && v.trim()) onPick(v.trim());
      });
      box.appendChild(free);
    }
    const cancel = el('button', 'btn ghost', 'やめる');
    cancel.addEventListener('click', closeSheet);
    box.appendChild(cancel);
  });
}

/* ---------------- 覆い ---------------- */

function showWork(phase, note) {
  $('work-phase').textContent = phase;
  $('work-note').textContent = note || '';
  $('work-count').textContent = '0 / 0';
  $('work-bar').style.width = '0%';
  $('ov-work').classList.add('on');
}
function updateWork(done, total, ratio) {
  $('work-count').textContent = `${done} / ${total}`;
  $('work-bar').style.width = `${Math.round((ratio ?? done / Math.max(1, total)) * 100)}%`;
}
function hideWork() {
  $('ov-work').classList.remove('on');
}

/* ---------------- ホーム ---------------- */

function daysUntil(dateStr) {
  const target = new Date(`${dateStr}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

async function renderHome() {
  const now = new Date();
  const wd = ['日', '月', '火', '水', '木', '金', '土'][now.getDay()];
  $('home-date').textContent = `${now.getMonth() + 1}月${now.getDate()}日(${wd})`;

  const sources = await db.allSources();
  const pending = sources.filter((s) => s.status !== db.STATUS.SYNCED);
  $('home-pending').innerHTML = `${pending.length}<small>件</small>`;
  $('cap-pending').textContent = `${pending.length}件`;
  $('home-eta').textContent = pending.length
    ? `手を動かす ${Math.max(1, Math.round(pending.length * 0.7))}分 ＋ 送信 ${Math.max(1, pending.length)}分`
    : '撮ったものはここに溜まります';

  const subjects = await db.allSubjects();
  const withDays = subjects
    .map((s) => ({ ...s, days: s.examDate ? daysUntil(s.examDate) : null }))
    .sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));

  const soon = withDays.find((s) => s.days != null && s.days >= 0);
  const examBox = $('home-exam');
  examBox.innerHTML = '';
  if (soon) {
    const w = el('div', 'examday');
    const left = el('span');
    left.appendChild(el('span', 'lab', 'いちばん近いテスト'));
    left.appendChild(el('span', 'sub', `${soon.name} · ${soon.examDate.replace(/-/g, '/')}`));
    w.appendChild(left);
    const n = el('span', 'n mono');
    n.innerHTML = `${soon.days}<small>日</small>`;
    w.appendChild(n);
    examBox.appendChild(w);
  }

  // 科目ごとのページ数
  const counts = {};
  for (const s of sources) {
    const pages = await db.pagesOf(s.id);
    const kept = db.keptPages(pages).length;
    const key = s.subject || '未分類';
    counts[key] = (counts[key] || 0) + kept;
  }

  const box = $('home-subjects');
  box.innerHTML = '';
  const names = new Set([...withDays.map((s) => s.name), ...Object.keys(counts)]);
  if (names.size === 0) {
    box.appendChild(el('p', 'muted', 'まだ何もありません。下の「撮る」から始めてください。'));
  }
  [...names]
    .map((name) => {
      const sub = withDays.find((s) => s.name === name);
      return { name, days: sub ? sub.days : null, pages: counts[name] || 0 };
    })
    .sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999))
    .forEach((r) => {
      const row = el('div', 'subj-row');
      row.appendChild(el('span', 'nm', r.name));
      const dl = el('span', r.days == null ? 'dl far' : r.days <= 7 ? 'dl' : 'dl far');
      dl.textContent = r.days == null ? '未設定' : r.days < 0 ? '終了' : `あと${r.days}日`;
      row.appendChild(dl);
      row.appendChild(el('span', 'ct mono', `${r.pages}ページ`));
      box.appendChild(row);
    });

  const synced = sources.filter((s) => s.status === db.STATUS.SYNCED);
  let syncedPages = 0;
  for (const s of synced) syncedPages += db.keptPages(await db.pagesOf(s.id)).length;
  $('home-synced').textContent = `${syncedPages}ページ`;
}

/* ---------------- 撮る ---------------- */

$('to-capture').addEventListener('click', () => show('s-capture'));
$('to-triage').addEventListener('click', () => show('s-triage'));
$('to-settings').addEventListener('click', () => show('s-settings'));

$('btn-video').addEventListener('click', () => $('file-video').click());
$('file-video').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  state.pendingFile = f;
  $('cnt-val').textContent = '10';
  $('ov-count').classList.add('on');
});

$('cnt-plus').addEventListener('click', () => {
  $('cnt-val').textContent = String(Math.min(200, Number($('cnt-val').textContent) + 1));
});
$('cnt-minus').addEventListener('click', () => {
  $('cnt-val').textContent = String(Math.max(0, Number($('cnt-val').textContent) - 1));
});
$('cnt-ok').addEventListener('click', () => startExtract(Number($('cnt-val').textContent)));
$('cnt-skip').addEventListener('click', () => startExtract(null));

async function startExtract(countedSheets) {
  const file = state.pendingFile;
  state.pendingFile = null;
  $('ov-count').classList.remove('on');
  if (!file) return;

  showWork('ページを切り出しています', '動画は端末の外に出ません');
  try {
    const { pages, diag } = await extractPages(file, {}, (p) => {
      if (p.phase === 'load') $('work-phase').textContent = '動画を読み込んでいます';
      else if (p.phase === 'scan') $('work-phase').textContent = '動きを調べています';
      else if (p.phase === 'export') $('work-phase').textContent = 'ページを書き出しています';
      updateWork(p.done, p.total, p.ratio);
    });

    const source = await db.createSource({ kind: 'video', countedSheets, diag });
    await db.savePages(source.id, pages);
    hideWork();

    const kept = pages.filter((p) => !p.blank).length;
    toast(`${kept}枚とれました。整理は電車でどうぞ`);
    show('s-capture');
    renderHome();
  } catch (err) {
    hideWork();
    console.error(err);
    toast(err.message || '切り出せませんでした');
  }
}

/* 写真は切り出し不要。そのまま1ページとして入れる。 */
$('btn-photo').addEventListener('click', () => $('file-photo').click());
$('file-photo').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const source = await db.createSource({ kind: 'photo', countedSheets: files.length, diag: null });
  await db.savePages(
    source.id,
    files.map((f, i) => ({ time: i, hash: '', ink: 1, blank: false, blob: f, bytes: f.size }))
  );
  toast(`${files.length}枚を入れました`);
  renderHome();
});

/* ---------------- 整理 ---------------- */

async function renderTriage() {
  const sources = (await db.allSources()).filter((s) => s.status !== db.STATUS.SYNCED);
  const body = $('triage-body');
  const foot = $('triage-foot');
  body.innerHTML = '';
  foot.innerHTML = '';
  $('triage-remaining').textContent = `残り${sources.length}件`;

  if (!sources.length) {
    body.appendChild(el('p', 'empty', '未整理はありません。\nよく片づいています。'));
    const b = el('button', 'btn ghost', 'ホームへ');
    b.addEventListener('click', () => show('s-home'));
    foot.appendChild(b);
    return;
  }

  const source = sources[0];
  state.triageSource = source;
  const pages = await db.pagesOf(source.id);
  const kept = db.keptPages(pages);
  const blanks = pages.filter((p) => p.blank).length;
  const need = pagesNeedingReview(pages).filter((p) => !p.blank).length;

  const card = el('div', 'srccard');
  const top = el('div', 'top');
  top.appendChild(el('span', 't', source.kind === 'video' ? 'めくり動画' : '写真'));
  const d = new Date(source.capturedAt);
  top.appendChild(
    el('span', 'm mono', `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${kept.length}枚`)
  );
  card.appendChild(top);

  const inner = el('div', 'in');
  inner.appendChild(el('span', 'sec-label', 'ちがったらタップ'));
  const chips = el('div', 'chips');

  const subjectChip = el('button', `chip${source.subject ? ' set' : ''}`, source.subject || '科目を選ぶ');
  subjectChip.addEventListener('click', async () => {
    const known = (await db.allSubjects()).map((s) => s.name);
    const opts = [...new Set([...known, ...SUBJECT_SUGGESTIONS])];
    pick('科目', opts, async (v) => {
      await db.updateSource(source.id, { subject: v });
      renderTriage();
    });
  });
  chips.appendChild(subjectChip);

  const topicChip = el('button', `chip${source.topic ? ' set' : ''}`, source.topic || '単元を書く');
  topicChip.addEventListener('click', () => {
    const v = prompt('単元', source.topic || '');
    if (v && v.trim()) db.updateSource(source.id, { topic: v.trim() }).then(renderTriage);
  });
  chips.appendChild(topicChip);
  inner.appendChild(chips);

  const det = el('div', 'detected');
  if (source.countedSheets != null) {
    const ok = source.countedSheets === kept.length;
    const p = el('span', ok ? 'pill good' : 'pill warn');
    p.textContent = ok
      ? `教室で数えた${source.countedSheets}枚と一致`
      : `教室では${source.countedSheets}枚 / 取り込み${kept.length}枚`;
    det.appendChild(p);
  }
  if (blanks) det.appendChild(el('span', 'pill', `白紙${blanks}枚を除外`));
  if (need) det.appendChild(el('span', 'pill warn', `要確認${need}枚`));
  inner.appendChild(det);
  card.appendChild(inner);
  body.appendChild(card);

  const drop = el('button', 'btn ghost', 'この1件を丸ごと捨てる');
  drop.addEventListener('click', async () => {
    const snapshot = { source, pages };
    await db.deleteSource(source.id);
    renderTriage();
    renderHome();
    toast('この1件を捨てました', async () => {
      await db.restoreSource(snapshot);
      renderTriage();
      renderHome();
    });
  });
  body.appendChild(drop);

  if (sources.length > 1) {
    body.appendChild(el('p', 'sec-label', 'このあとの順番'));
    const list = el('div', 'card');
    sources.slice(1, 4).forEach((s, i) => {
      const row = el('div', 'row');
      row.style.padding = '6px 0';
      row.appendChild(el('span', null, `${i + 2}. ${s.subject || '未分類'}`));
      row.appendChild(el('span', 'mono', `${s.kind === 'video' ? '動画' : '写真'}`));
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  const go = el('button', 'btn', need ? `要確認の${need}枚を見る` : `${kept.length}枚を確認する`);
  go.addEventListener('click', () => {
    state.reviewed = new Set();
    show('s-pages');
  });
  foot.appendChild(go);

  const skip = el('button', 'btn ghost', 'この1件は飛ばす');
  skip.addEventListener('click', async () => {
    await db.updateSource(source.id, { capturedAt: Date.now() });
    renderTriage();
  });
  foot.appendChild(skip);
}

/* ---------------- ページ確認 ---------------- */

function flagOf(p) {
  if (p.dropped) return '';
  if (p.blank) return 'blank';
  if (p.dupeOf != null) return 'dupe';
  if (p.thin) return 'thin';
  return '';
}
const TAG_TEXT = { blank: '白紙', dupe: '重複', thin: '薄い' };

async function renderPages() {
  const source = state.triageSource;
  if (!source) return show('s-triage');
  const pages = await db.pagesOf(source.id);
  state.pages = pages;
  releasePageUrls();

  $('pages-sub').textContent = `${source.subject || '未分類'} · ${source.topic || '単元未設定'}`;

  const kept = db.keptPages(pages);
  const box = $('pages-match');
  box.innerHTML = '';
  if (source.countedSheets != null) {
    const ok = source.countedSheets === kept.length;
    const w = el('div', ok ? 'matched' : 'matched bad');
    w.appendChild(el('span', null, ok ? '✓' : '!'));
    const s = el('span');
    s.appendChild(
      el('span', 't', ok ? `教室で数えた${source.countedSheets}枚と一致しました` : `枚数が合っていません`)
    );
    s.appendChild(
      el('span', 'd', ok ? '中身が薄いページだけ拾っています' : `実物${source.countedSheets}枚 / 取り込み${kept.length}枚`)
    );
    w.appendChild(s);
    box.appendChild(w);
  }

  const need = pagesNeedingReview(pages).filter((p) => !p.dropped);
  $('pages-tasktitle').textContent = need.length ? `見るのは${need.length}枚だけ` : '確認するものはありません';
  $('pages-prog').textContent = `${state.reviewed.size}/${need.length}`;

  const grid = $('pages-grid');
  grid.innerHTML = '';
  pages.forEach((p) => {
    const b = el('button', `pg${p.dropped ? ' gone' : ''}${state.reviewed.has(p.id) ? ' checked' : ''}`);
    b.type = 'button';
    const flag = flagOf(p);
    b.setAttribute('data-flag', flag);
    const img = el('img', 'thumb');
    img.src = urlFor(p.blob);
    img.alt = `${p.index + 1}ページ目`;
    img.loading = 'lazy';
    b.appendChild(img);
    b.appendChild(el('span', 'done', '✓'));
    b.appendChild(el('span', 'no mono', String(p.index + 1)));
    b.appendChild(el('span', 'tag', TAG_TEXT[flag] || ''));
    b.addEventListener('click', () => openPageSheet(p));
    grid.appendChild(b);
  });
}

function openPageSheet(page) {
  const flag = flagOf(page);
  const partner = page.dupeOf != null ? state.pages.find((q) => q.index === page.dupeOf) : null;

  openSheet((box) => {
    const heads = {
      blank: `${page.index + 1}ページ目 · 白紙のようです`,
      dupe: `${page.index + 1}・${(partner?.index ?? 0) + 1}ページ目 · 同じページかも`,
      thin: `${page.index + 1}ページ目 · 中身がほとんどありません`,
      '': `${page.index + 1}ページ目`,
    };
    const notes = {
      blank: '裏面か、めくる途中の机だと思われます。要るなら残してください。',
      dupe: 'めくる途中で2回写ったようです。残すほうを選んでください。',
      thin: '指で隠れたか、枠からはみ出したかもしれません。読めそうなら残してください。',
      '': 'きちんと写っています。',
    };
    box.appendChild(el('span', 'h', heads[flag]));
    box.appendChild(el('p', 'p', notes[flag]));

    const prev = el('div', 'preview');
    const add = (p) => {
      const i = el('img');
      i.src = urlFor(p.blob);
      i.alt = `${p.index + 1}ページ目`;
      prev.appendChild(i);
    };
    add(page);
    if (partner) add(partner);
    box.appendChild(prev);

    const keep = el('button', 'btn', partner ? `${page.index + 1}ページ目を残す` : 'このまま使う');
    keep.addEventListener('click', async () => {
      await db.updatePage(page.id, { blank: false, thin: false, dupeOf: null, dropped: false });
      if (partner) await db.updatePage(partner.id, { dropped: true });
      state.reviewed.add(page.id);
      closeSheet();
      renderPages();
    });
    box.appendChild(keep);

    if (partner) {
      const other = el('button', 'btn ghost', `${partner.index + 1}ページ目を残す`);
      other.addEventListener('click', async () => {
        await db.updatePage(partner.id, { dupeOf: null });
        await db.updatePage(page.id, { dropped: true });
        state.reviewed.add(page.id);
        closeSheet();
        renderPages();
      });
      box.appendChild(other);
    }

    const drop = el('button', 'btn danger', '捨てる');
    drop.addEventListener('click', async () => {
      await db.updatePage(page.id, { dropped: true });
      state.reviewed.add(page.id);
      closeSheet();
      renderPages();
      toast(`${page.index + 1}ページ目を捨てました`, async () => {
        await db.updatePage(page.id, { dropped: false });
        renderPages();
      });
    });
    box.appendChild(drop);
  });
}

$('pages-next').addEventListener('click', () => {
  const next = pagesNeedingReview(state.pages).find((p) => !p.dropped && !state.reviewed.has(p.id));
  if (next) openPageSheet(next);
  else toast('要確認はもうありません');
});

$('pages-done').addEventListener('click', doSync);

/* ---------------- 送る ---------------- */

async function doSync() {
  const source = state.triageSource;
  if (!source) return;
  const cfg = settings.load();
  if (!settings.isConfigured(cfg)) {
    toast('先に設定でGitHubの情報を入れてください');
    return show('s-settings');
  }
  if (!source.subject) {
    toast('科目を選んでください');
    return show('s-triage');
  }

  showWork('PCに送っています', '電波が弱いと時間がかかります');
  try {
    const res = await sync.syncSource(source.id, cfg, (p) => {
      const label = { prepare: '画像を準備しています', upload: 'アップロードしています', commit: '記録しています' };
      $('work-phase').textContent = label[p.phase] || '送っています';
      updateWork(p.done, p.total);
    });
    hideWork();
    toast(`PCに送りました（${res.files}ファイル）`);
    state.triageSource = null;
    show('s-triage');
    renderHome();
  } catch (err) {
    hideWork();
    console.error(err);
    toast(err.message || '送れませんでした');
  }
}

/* ---------------- 見る ---------------- */

function renderRead() {
  const pages = db.keptPages(state.pages);
  if (!pages.length) return show('s-home');
  state.readIndex = Math.min(state.readIndex, pages.length - 1);
  const p = pages[state.readIndex];
  $('read-img').src = urlFor(p.blob);
  $('read-pos').textContent = String(state.readIndex + 1);
  $('read-total').textContent = String(pages.length);
}
$('read-prev').addEventListener('click', () => {
  state.readIndex = Math.max(0, state.readIndex - 1);
  renderRead();
});
$('read-next').addEventListener('click', () => {
  state.readIndex = Math.min(db.keptPages(state.pages).length - 1, state.readIndex + 1);
  renderRead();
});

/* ---------------- 設定 ---------------- */

async function renderSettings() {
  const cfg = settings.load();
  $('set-owner').value = cfg.owner;
  $('set-repo').value = cfg.repo;
  $('set-token').value = '';
  $('set-tokenstate').textContent = `いま保存されているトークン: ${settings.maskToken(cfg.githubToken)}`;

  const usage = await db.estimateUsage();
  $('set-usage').textContent = usage
    ? `${(usage.usage / 1048576).toFixed(0)}MB / ${(usage.quota / 1048576).toFixed(0)}MB`
    : '取得できません';

  const box = $('set-subjects');
  box.innerHTML = '';
  const subjects = await db.allSubjects();
  if (!subjects.length) box.appendChild(el('p', 'muted', 'まだありません。テスト日を入れると、ホームで近い順に並びます。'));
  subjects.forEach((s) => {
    const row = el('div', 'row');
    row.style.padding = '8px 0';
    row.style.borderBottom = '1px solid var(--line)';
    row.appendChild(el('span', null, s.name));
    const right = el('span');
    right.style.display = 'flex';
    right.style.gap = '8px';
    right.style.alignItems = 'center';
    right.appendChild(el('span', 'mono', s.examDate || '未設定'));
    const edit = el('button', 'btn ghost', '変更');
    edit.style.cssText = 'width:auto;min-height:36px;padding:6px 10px;font-size:12px';
    edit.addEventListener('click', async () => {
      const v = prompt(`${s.name} のテスト日（YYYY-MM-DD）`, s.examDate || '');
      if (v === null) return;
      if (v.trim() === '') await db.deleteSubject(s.id);
      else await db.upsertSubject({ ...s, examDate: v.trim() });
      renderSettings();
    });
    right.appendChild(edit);
    row.appendChild(right);
    box.appendChild(row);
  });
}

$('set-add-subject').addEventListener('click', () => {
  pick('科目', SUBJECT_SUGGESTIONS, async (name) => {
    const date = prompt(`${name} のテスト日（YYYY-MM-DD）`, '');
    await db.upsertSubject({ name, examDate: date && date.trim() ? date.trim() : null });
    renderSettings();
    renderHome();
  });
});

$('set-save').addEventListener('click', async () => {
  const patch = {
    owner: $('set-owner').value.trim(),
    repo: $('set-repo').value.trim(),
  };
  const token = $('set-token').value.trim();
  if (token) patch.githubToken = token;
  const cfg = settings.save(patch);

  const box = $('set-result');
  box.innerHTML = '';
  if (!settings.isConfigured(cfg)) {
    box.appendChild(el('p', 'keep', 'ユーザー名・リポジトリ名・トークンの3つが要ります。'));
    return;
  }
  box.appendChild(el('p', 'muted', 'つないでいます…'));
  try {
    const gh = await import('./github.js');
    const info = await gh.checkAccess(cfg);
    box.innerHTML = '';
    const ok = el('div', 'matched');
    ok.appendChild(el('span', null, '✓'));
    const s = el('span');
    s.appendChild(el('span', 't', 'つながりました'));
    s.appendChild(el('span', 'd', `${info.fullName}${info.private ? '（プライベート）' : '（公開リポジトリです。要注意）'}`));
    ok.appendChild(s);
    box.appendChild(ok);
    $('set-token').value = '';
    renderSettings();
  } catch (err) {
    box.innerHTML = '';
    box.appendChild(el('p', 'keep', err.message || 'つながりませんでした'));
  }
});

$('set-purge').addEventListener('click', async () => {
  const n = await db.purgeSynced(30);
  toast(n ? `${n}件を消しました` : '消せるものはありません');
  renderSettings();
  renderHome();
});

/* ---------------- 起動 ---------------- */

const RENDERERS = {
  's-home': renderHome,
  's-triage': renderTriage,
  's-pages': renderPages,
  's-read': renderRead,
  's-settings': renderSettings,
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

renderHome();
