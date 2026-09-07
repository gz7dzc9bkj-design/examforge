# ExamForge

紙のプリント・板書・手書きノートを「**PCのClaudeが読める状態**」にするまでの取り込み専用PWA。

問題づくりはこのアプリの仕事ではない。撮って、ページを切り出して、PCへ降ろすところまで。
そこから先はPCのClaudeが画像を直接読んで、要点も問題も作る。

- 仕様の正本: `../../notes/2026-09-07-examforge-08-壁打ち差分.md`（rev.3）
- 進捗: `../../notes/examforge-継続タスク.md`
- 画面のモック: https://claude.ai/code/artifact/506df99d-98f1-4c58-bccd-839769d9134c
- 切り出しの実機テスト: https://claude.ai/code/artifact/25931bab-31bb-4416-9d0f-dff9abd7a8b4

## 何も要らない

外部サービスを使わない。**新規アカウント0個・APIキー0個・課金0円。**

| | |
|---|---|
| 置き場所 | GitHub Pages |
| 端末の保存 | IndexedDB |
| PCへの同期 | プライベートGitHubリポジトリへ push → PCで `git pull` |
| 文字起こし | しない。PCのClaudeが画像を読む |
| ビルド | なし。素のESモジュール。依存パッケージ0 |

## 動かす

```
npm test          # 51件
python -m http.server 8901
```

## 中身

GitHub Pages で配信するため、アプリはリポジトリ直下に置いている。

```
index.html              5画面ぶんのDOM
css/style.css           承認済みデザイントークン
js/frameSelect.js       凍結モジュール（純粋関数。I/Oを持たない）
js/videoFrames.js       I/O層（video/Canvas。ブラウザ専用）
js/db.js                IndexedDB
js/settings.js          端末内設定（GitHubトークン）
js/github.js            Git Data API で1コミットにまとめる
js/sync.js              フォルダ構成と index.md の生成
js/main.js              画面遷移と結線
sw.js                   オフライン。ネット優先で古いJSが残らないようにする
test/                   node --test
spike/                  フェーズ0の実機テストページ
```

## 触るときに知っておくこと

`js/frameSelect.js` は**純粋関数だけ**を置く場所。DOMもCanvasも持ち込まない。
テストがNode上で回るのはそのため。I/Oが要るものは `videoFrames.js` に置く。

### すでに間違えた道（同じところを通らないこと）

1. **8x8平均ハッシュ** — 同じ体裁のプリントが全部同一に見え、8ページ中7ページが重複扱いになった
2. **差分ハッシュ(dHash)** — もっと悪い。白地に黒インクの文書は平坦な面が多く、別ページの距離が0になった。256bit中11bitしか立たない。写真向けの手法で文書には効かない
3. **机ごと解析** — ハッシュが「紙の位置」しか符号化せず、白紙判定も机をインクと数える。`findPaperBox` での切り出しは飾りではなく必須

いまの正解は **16x16平均ハッシュ + 紙の矩形切り出し**。実測で同一0 / 別ページ35、しきい値16。

### iOS Safari の地雷（実測）

- blob URL は `seeked` のあと更に80-100ms待たないと前のコマを掴む
- 並列にシークすると透明な画像が返る。**必ず逐次**
- Canvasの総メモリ上限384MB。1枚ごとにJPEG化して解放しないと落ちる
- **画面を離れると止まる**。だから切り出しは撮影直後にその場でやる
- 一部の動画は `duration` が Infinity。末尾へシークして確定させる

## はじめての準備（1回だけ）

1. GitHubで**プライベートリポジトリ**を1つ作る（READMEを付けて作る）
2. Settings → Developer settings → **Fine-grained tokens** でトークンを作る
   - 対象リポジトリはその1つだけ / 権限は `Contents: Read and write` のみ
3. アプリの設定画面にユーザー名・リポジトリ名・トークンを入れる

トークンは端末のlocalStorageにだけ入る。コードにもリポジトリにも入らない。いつでも失効できる。
