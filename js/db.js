/**
 * db — 端末内の保存。IndexedDB を薄く包むだけ。
 *
 * クラウドDBは使わない（08差分 rev.3）。正本は PC 側の git リポジトリで、
 * ここは「PCに送るまでの控え室」。送信済みのものは掃除してよい。
 *
 * 画像は Blob のまま入れる。IndexedDB は Blob を素で保存できるので、
 * base64 にして 33% 太らせる必要はない。
 */

const DB_NAME = 'examforge';
const DB_VERSION = 1;

/** 受信箱の状態。07書 §1-4 の inboxStatus をそのまま使う。 */
export const STATUS = {
  PENDING: 'PENDING', // 撮ったが、まだ見ていない
  TRIAGED: 'TRIAGED', // 科目と単元を確定した
  SYNCED: 'SYNCED', // PCに送った
  FAILED: 'FAILED',
};

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sources')) {
        const s = db.createObjectStore('sources', { keyPath: 'id' });
        s.createIndex('status', 'status');
        s.createIndex('capturedAt', 'capturedAt');
      }
      if (!db.objectStoreNames.contains('pages')) {
        const p = db.createObjectStore('pages', { keyPath: 'id' });
        p.createIndex('sourceId', 'sourceId');
      }
      if (!db.objectStoreNames.contains('subjects')) {
        db.createObjectStore('subjects', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const result = fn(t.objectStore(store));
        t.oncomplete = () => resolve(result && result.__value !== undefined ? result.__value : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function req(request) {
  const holder = {};
  request.onsuccess = () => {
    holder.__value = request.result;
  };
  return holder;
}

export function newId(prefix) {
  const rnd =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

/* ---------------- sources ---------------- */

/**
 * 撮ったものを1件ぶん記録する。
 * @param {{kind:'video'|'photo'|'audio', countedSheets:number|null, diag:object}} data
 */
export async function createSource(data) {
  const source = {
    id: newId('src'),
    kind: data.kind,
    status: STATUS.PENDING,
    capturedAt: Date.now(),
    subject: data.subject ?? null,
    topic: data.topic ?? null,
    countedSheets: data.countedSheets ?? null, // 教室で数えた実物の枚数
    diag: data.diag ?? null,
    syncedAt: null,
  };
  await tx('sources', 'readwrite', (store) => store.put(source));
  return source;
}

export function getSource(id) {
  return tx('sources', 'readonly', (store) => req(store.get(id)));
}

export function allSources() {
  return tx('sources', 'readonly', (store) => req(store.getAll())).then((rows) =>
    (rows || []).sort((a, b) => b.capturedAt - a.capturedAt)
  );
}

export function sourcesByStatus(status) {
  return allSources().then((rows) => rows.filter((s) => s.status === status));
}

export async function updateSource(id, patch) {
  const current = await getSource(id);
  if (!current) throw new Error(`見つかりません: ${id}`);
  const next = { ...current, ...patch };
  await tx('sources', 'readwrite', (store) => store.put(next));
  return next;
}

export async function deleteSource(id) {
  const pages = await pagesOf(id);
  await tx('pages', 'readwrite', (store) => {
    pages.forEach((p) => store.delete(p.id));
  });
  await tx('sources', 'readwrite', (store) => store.delete(id));
}

/**
 * 消したものを元に戻す。取り消しトースト用。
 * 最優先要件が「1枚も取りこぼさない」なので、消す操作には必ず戻り道を用意する。
 * @param {{source:object, pages:object[]}} snapshot deleteSource の前に取っておいたもの
 */
export async function restoreSource(snapshot) {
  await tx('sources', 'readwrite', (store) => store.put(snapshot.source));
  await tx('pages', 'readwrite', (store) => {
    snapshot.pages.forEach((p) => store.put(p));
  });
  return snapshot.source;
}

/* ---------------- pages ---------------- */

/** 切り出したページをまとめて保存する。 */
export async function savePages(sourceId, extracted) {
  const rows = extracted.map((p, i) => ({
    id: `${sourceId}_p${String(i + 1).padStart(3, '0')}`,
    sourceId,
    index: i,
    time: p.time,
    hash: p.hash,
    ink: p.ink,
    blank: !!p.blank,
    thin: !!p.thin,
    dupeOf: p.dupeOf ?? null,
    dropped: false, // 捨てたページ。消さずに印だけ付ける（取りこぼしゼロが最優先）
    reviewed: false,
    blob: p.blob,
    bytes: p.bytes,
  }));
  await tx('pages', 'readwrite', (store) => {
    rows.forEach((r) => store.put(r));
  });
  return rows;
}

export function pagesOf(sourceId) {
  return tx('pages', 'readonly', (store) =>
    req(store.index('sourceId').getAll(sourceId))
  ).then((rows) => (rows || []).sort((a, b) => a.index - b.index));
}

export async function updatePage(id, patch) {
  const current = await tx('pages', 'readonly', (store) => req(store.get(id)));
  if (!current) throw new Error(`見つかりません: ${id}`);
  const next = { ...current, ...patch };
  await tx('pages', 'readwrite', (store) => store.put(next));
  return next;
}

/** PC に送る対象。捨てたものと白紙は除く。 */
export function keptPages(pages) {
  return pages.filter((p) => !p.dropped && !p.blank);
}

/* ---------------- subjects（テスト日） ---------------- */

export function allSubjects() {
  return tx('subjects', 'readonly', (store) => req(store.getAll())).then((rows) => rows || []);
}

export async function upsertSubject(subject) {
  const row = { id: subject.id ?? newId('sub'), ...subject };
  await tx('subjects', 'readwrite', (store) => store.put(row));
  return row;
}

export function deleteSubject(id) {
  return tx('subjects', 'readwrite', (store) => store.delete(id));
}

/* ---------------- 掃除 ---------------- */

/**
 * PC に送ってから一定日数たったものを消す。
 * 端末の容量を守るためで、正本は git 側にあるので消して問題ない。
 */
export async function purgeSynced(olderThanDays = 30) {
  const cutoff = Date.now() - olderThanDays * 86400000;
  const rows = await allSources();
  const targets = rows.filter((s) => s.status === STATUS.SYNCED && s.syncedAt && s.syncedAt < cutoff);
  for (const s of targets) await deleteSource(s.id);
  return targets.length;
}

/** 端末がどれくらい使っているか。設定画面に出す。 */
export async function estimateUsage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}
