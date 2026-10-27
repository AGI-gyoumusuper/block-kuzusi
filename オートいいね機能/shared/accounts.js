'use strict';

/**
 * 対象3アカウント。物理フォルダ名と実アカウント名が一部入れ替わっているため、
 * フォルダ名で推測せず、接続先（port）→ 現在のログイン中 note ID を実際に照合する。
 * パスワード・Cookie・認証トークンは台帳やログへ複製しない（本モジュールは一切保持しない）。
 */

const { parseNoteUrl } = require('./seeds');

function normalizeAccount(a) {
  if (!a || !a.id || !a.url) throw new Error('アカウント定義には id と url が必要');
  const parsed = parseNoteUrl(a.url);
  if (!parsed) throw new Error(`アカウント ${a.id} の url が note のプロフィールURLではない: ${a.url}`);
  return {
    id: a.id,
    name: a.name || a.id,
    url: parsed.canonicalUrl,
    urlname: parsed.urlname,
    userId: a.userId != null ? String(a.userId) : null,
    chromeProfileDir: a.chromeProfileDir || null,
    cdpPort: a.cdpPort != null ? Number(a.cdpPort) : null,
    shortcut: a.shortcut || null,
    enabled: a.enabled !== false,
  };
}

/**
 * ブラウザ側のログイン状態と期待アカウントの照合。
 * adapter.getCurrentUser({ accountId }) → { urlname, userId, displayName } | null
 */
async function verifyAccountSession(adapter, account) {
  let cur = null;
  try {
    cur = await adapter.getCurrentUser({ accountId: account.id });
  } catch (e) {
    return { ok: false, code: 'fetch_failed', message: `ログイン情報の取得に失敗: ${e.message}`, expected: account.urlname, actual: null };
  }
  if (!cur || !cur.urlname) {
    return { ok: false, code: 'not_logged_in', message: 'ログイン中の note ID を取得できない（未ログインまたは認証要求）', expected: account.urlname, actual: null };
  }
  if (cur.urlname !== account.urlname) {
    return { ok: false, code: 'account_mismatch', message: `接続先のログインID(${cur.urlname})が期待(${account.urlname})と異なる。フォルダ名で推測しない`, expected: account.urlname, actual: cur.urlname };
  }
  if (account.userId && cur.userId != null && String(cur.userId) !== account.userId) {
    return { ok: false, code: 'user_id_mismatch', message: `userId が一致しない（期待 ${account.userId} / 実際 ${cur.userId}）`, expected: account.urlname, actual: cur.urlname };
  }
  return { ok: true, code: 'ok', message: 'ログイン中の note ID が期待アカウントと一致', expected: account.urlname, actual: cur.urlname, userId: cur.userId != null ? String(cur.userId) : null };
}

module.exports = { normalizeAccount, verifyAccountSession };
