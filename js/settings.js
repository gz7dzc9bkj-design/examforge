/**
 * settings — 端末に閉じた設定。localStorage に置く。
 *
 * GitHub のトークンをここに置くのが、サーバーを一切持たずに済ませる肝。
 * トークンはこの端末の外に出ないし、アプリのコード（公開リポジトリ）にも入らない。
 * 万一 iPhone を落としても、影響はこの1リポジトリに限られ、いつでも失効させられる。
 */

const KEY = 'examforge.settings.v1';

const DEFAULTS = {
  githubToken: '', // fine-grained PAT（対象リポジトリ1つ・Contents: Read and write）
  owner: '',
  repo: '',
  branch: 'main',
  basePath: 'notes', // リポジトリ内のどこに置くか
  authorName: 'ExamForge',
  authorEmail: 'examforge@localhost',
};

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(patch) {
  const next = { ...load(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* プライベートモード等。設定は保たれないが動作は続ける */
  }
  return next;
}

export function isConfigured(s = load()) {
  return Boolean(s.githubToken && s.owner && s.repo);
}

/** トークンをそのまま画面に出さないための伏せ字。 */
export function maskToken(token) {
  if (!token) return '未設定';
  if (token.length <= 8) return '•'.repeat(token.length);
  return `${token.slice(0, 4)}${'•'.repeat(10)}${token.slice(-4)}`;
}

export function clearToken() {
  return save({ githubToken: '' });
}
