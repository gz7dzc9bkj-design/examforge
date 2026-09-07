/**
 * github — プライベートリポジトリへ1回のコミットで押し込む。
 *
 * これが Turso と Cloudflare R2 と Vercel の代わり。ブラウザから api.github.com を
 * 直接叩けることは実測で確認済み（別オリジンからの PUT が認証層まで到達）。
 *
 * Contents API を1ファイルずつ叩くとファイル数ぶんコミットが増えるので、
 * Git Data API（blob → tree → commit → ref）で1コミットにまとめる。
 */

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

/** 人が読める日本語に直す。ここを通さないと英語のまま画面に出る。 */
function explain(status, body) {
  const msg = (body && body.message) || '';
  if (status === 401) return 'トークンが無効です。設定を見直してください。';
  if (status === 403 && /rate limit/i.test(msg)) return 'GitHubの回数制限に当たりました。しばらく待ってください。';
  if (status === 403) return 'このトークンにはこのリポジトリへの書き込み権限がありません。';
  if (status === 404) return 'リポジトリが見つかりません。所有者名とリポジトリ名を確認してください。';
  if (status === 409) return 'リポジトリが空です。GitHubで最初のファイル（READMEなど）を1つ作ってください。';
  if (status === 422) return `GitHubに拒否されました: ${msg}`;
  if (status >= 500) return 'GitHub側で問題が起きています。しばらく待ってください。';
  return msg || `通信に失敗しました（${status}）`;
}

async function call(settings, path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${settings.githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) throw new GitHubError(explain(res.status, body), res.status, body);
  return body;
}

/** 大きい配列を spread すると落ちるので、分割して base64 にする。 */
export function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

export function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** 設定が正しいか、書き込み権限があるかを1回で確かめる。 */
export async function checkAccess(settings) {
  const repo = await call(settings, `/repos/${settings.owner}/${settings.repo}`);
  if (!repo.permissions || !repo.permissions.push) {
    throw new GitHubError('このトークンには書き込み権限がありません。', 403, null);
  }
  return {
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
    sizeKb: repo.size,
  };
}

async function getRef(settings) {
  try {
    const ref = await call(settings, `/repos/${settings.owner}/${settings.repo}/git/ref/heads/${settings.branch}`);
    return ref.object.sha;
  } catch (e) {
    if (e.status === 404) return null; // 空のリポジトリ、またはブランチが無い
    throw e;
  }
}

/**
 * ファイル一式を1コミットで push する。
 *
 * @param {object} settings
 * @param {Array<{path:string, base64:string}>} files パスはリポジトリ基準
 * @param {string} message コミットメッセージ
 * @param {(p:{phase:string,done:number,total:number})=>void} [onProgress]
 * @returns {Promise<{commitSha:string, url:string, files:number}>}
 */
export async function commitFiles(settings, files, message, onProgress = () => {}) {
  const base = `/repos/${settings.owner}/${settings.repo}`;
  const parentSha = await getRef(settings);

  let baseTree = null;
  if (parentSha) {
    const parent = await call(settings, `${base}/git/commits/${parentSha}`);
    baseTree = parent.tree.sha;
  }

  const tree = [];
  for (let i = 0; i < files.length; i++) {
    onProgress({ phase: 'upload', done: i, total: files.length });
    const blob = await call(settings, `${base}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: files[i].base64, encoding: 'base64' }),
    });
    tree.push({ path: files[i].path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  onProgress({ phase: 'upload', done: files.length, total: files.length });

  onProgress({ phase: 'commit', done: 0, total: 1 });
  const newTree = await call(settings, `${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify(baseTree ? { base_tree: baseTree, tree } : { tree }),
  });

  const author = { name: settings.authorName, email: settings.authorEmail, date: new Date().toISOString() };
  const commit = await call(settings, `${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: newTree.sha,
      parents: parentSha ? [parentSha] : [],
      author,
      committer: author,
    }),
  });

  if (parentSha) {
    await call(settings, `${base}/git/refs/heads/${settings.branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha }),
    });
  } else {
    await call(settings, `${base}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${settings.branch}`, sha: commit.sha }),
    });
  }

  onProgress({ phase: 'commit', done: 1, total: 1 });
  return {
    commitSha: commit.sha,
    url: `https://github.com/${settings.owner}/${settings.repo}/commit/${commit.sha}`,
    files: files.length,
  };
}
