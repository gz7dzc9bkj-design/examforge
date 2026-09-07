/**
 * Service Worker — オフラインで開けるようにするのが目的。
 *
 * ホーム画面に置いた PWA として使うことが前提。Safari は7日間使わないサイトの
 * ストレージを消すが、ホーム画面のPWAは対象外になる。テスト前しか開かない
 * 使い方なので、これは飾りではなく必須（08差分 §7-4）。
 *
 * キャッシュは「入れ替えたら必ず新しい方を使う」形にする。
 * 過去に「キャッシュで古いJSが残る」不具合を踏んでいるので、
 * バージョンを上げたら古いキャッシュを消し切る。
 */

const VERSION = 'v1';
const CACHE = `examforge-${VERSION}`;

const SHELL = [
  '.',
  'index.html',
  'css/style.css',
  'js/main.js',
  'js/db.js',
  'js/settings.js',
  'js/sync.js',
  'js/github.js',
  'js/videoFrames.js',
  'js/frameSelect.js',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // GitHub API と外部フォントはキャッシュしない。常にネットワークへ。
  if (url.origin !== self.location.origin) return;

  // 自分のファイルはネット優先・落ちたらキャッシュ。
  // これで「古いJSが残り続ける」事故を防ぐ。
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
