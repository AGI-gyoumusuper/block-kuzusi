'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * 設定。各値には区分（教材に明記／教材の例示／利用者の追加要件／実装上の初期値）を付け、画面に表示する。
 */

const KIND = Object.freeze({
  MATERIAL: '教材に明記',
  EXAMPLE: '教材の例示',
  USER: '利用者の追加要件',
  DEFAULT: '実装上の初期値',
  REFERENCE: '教材の参考値（公式の保証値ではない）',
});

const DEFAULT_CONFIG = {
  // --- 安全側の初期状態（完了条件 7.6）---
  enableRealActions: false, // 実アカウントでの送信は利用者が明示的に ON にしたときだけ
  scheduler: { enabled: false, note: '定期実行は初期OFF。本ツールは定期実行を実装しない（手動開始のみ）' },

  // --- 選定条件 ---
  activityWindowDays: 14,          // 教材に明記（フォロワー獲得）。スキ獲得への適用は利用者の追加要件
  requireReactionEvidence: false,  // 利用者設定（既定OFF）
  seedRange: { followingMax: null, followerMin: null }, // 教材の例示（数十・数千）。未設定なら判定しない
  pinSuggestionLikeThreshold: 150, // 教材の推奨（提案表示のみ）
  oneLikePerPersonProjectWide: true, // 追加要件（重複防止）

  // --- 収集の規模（実装上の初期値）---
  seedNotesLimit: 5,
  likesPerNoteLimit: 100,
  followersLimit: 200,
  candidateNotesLimit: 20,
  requestIntervalMs: 1500,

  // --- 実行 ---
  betweenLikesMs: 20000,
  reserveTtlMs: 10 * 60 * 1000,
  executorLockTtlMs: 15 * 60 * 1000,
  stopOnUnknown: true,             // 結果不明が出たら実行を止める（結果不明は内部残数より優先）
  sequentialAcrossAccounts: true,  // 既定で3アカウントの外部操作は順番に実行

  // --- 実行管理層の初期値（限度の出典を併記）---
  limits: {
    tzOffsetMinutes: 540,
    minIntervalMs: 20000,
    defaults: {
      dailyLimit: 200,
      hourlyLimit: 50,
      capacity: 50,
      recoveryIntervalMin: 20,
      recoveryAmount: 10,
    },
    labels: {
      dailyLimit: KIND.REFERENCE,
      hourlyLimit: KIND.REFERENCE,
      capacity: KIND.DEFAULT,
      recoveryIntervalMin: KIND.USER,
      recoveryAmount: KIND.DEFAULT,
    },
  },

  // --- 保存先 ---
  dbPath: null,       // null なら OS 既定（Windows: 依頼書の指定パス）
  exportDir: null,    // null なら <オートいいね機能>/exports

  // --- 実 note 接続（未検証。probe で実際の応答を確認してから使う）---
  noteApi: {
    base: 'https://note.com',
    endpoints: {
      currentUser: '/api/v2/current_user',
      creator: '/api/v2/creators/{urlname}',
      creatorNotes: '/api/v2/creators/{urlname}/contents?kind=note&page={page}',
      note: '/api/v3/notes/{key}',
      noteLikes: '/api/v3/notes/{key}/likes?page={page}',
      followers: '/api/v2/creators/{urlname}/followers?page={page}',
      myNotes: '/api/v2/creators/{urlname}/contents?kind=note&page={page}',
    },
    verified: false,
  },
  browser: {
    articleBodySelector: 'article, .note-common-styles__textnote-body, [class*="textnote-body"]',
    likeButtonSelector: 'button[aria-label*="スキ"], button[data-testid*="like"], button:has-text("スキ")',
    likeConfirmTimeoutMs: 8000,
    scrollStepPx: 600,
    scrollPauseMs: 250,
    verified: false,
  },
};

const DEFAULT_ACCOUNTS = [
  { id: 'karasu', name: 'からす', url: 'https://note.com/_karasu', chromeProfileDir: 'C:\\Users\\taker\\Documents\\Codex\\chrome-profiles\\note-info\\karasu', cdpPort: 9271 },
  { id: 'koisi', name: 'こいし', url: 'https://note.com/koisi_', chromeProfileDir: 'C:\\Users\\taker\\Documents\\Codex\\chrome-profiles\\note-info\\pengi', cdpPort: 9273 },
  { id: 'pengi', name: 'ペンギ', url: 'https://note.com/pengi', chromeProfileDir: 'C:\\Users\\taker\\Documents\\Codex\\chrome-profiles\\note-info\\koisi', cdpPort: 9272 },
];

const CRITERIA_KINDS = {
  activityWindowDays: KIND.MATERIAL,
  requireReactionEvidence: KIND.USER,
  seedRange: KIND.EXAMPLE,
  pinSuggestionLikeThreshold: '教材の推奨（必須条件ではない）',
  oneLikePerPersonProjectWide: KIND.USER,
  seedNotesLimit: KIND.DEFAULT,
  likesPerNoteLimit: KIND.DEFAULT,
  followersLimit: KIND.DEFAULT,
  candidateNotesLimit: KIND.DEFAULT,
  requestIntervalMs: KIND.DEFAULT,
  betweenLikesMs: KIND.DEFAULT,
  reserveTtlMs: KIND.DEFAULT,
  stopOnUnknown: KIND.USER,
  sequentialAcrossAccounts: KIND.USER,
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && base[k] !== null) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function defaultDbPath() {
  if (process.platform === 'win32') {
    return 'C:\\Users\\taker\\Documents\\Codex\\note-engagement\\data\\state.sqlite3';
  }
  return path.join(os.homedir(), '.note-engagement', 'state.sqlite3');
}

function loadJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * rootDir: 「オートいいね機能」フォルダ
 */
function loadConfig({ rootDir, overrides = {}, env = process.env } = {}) {
  const configDir = path.join(rootDir, 'config');
  const fileCfg = loadJsonIfExists(path.join(configDir, 'config.json')) || {};
  const fileAccounts = loadJsonIfExists(path.join(configDir, 'accounts.json'));
  const cfg = deepMerge(deepMerge(DEFAULT_CONFIG, fileCfg), overrides);
  cfg.rootDir = rootDir;
  cfg.accounts = (overrides.accounts || (fileAccounts && fileAccounts.accounts) || DEFAULT_ACCOUNTS);
  cfg.dbPath = overrides.dbPath || env.NOTE_TOOL_DB || fileCfg.dbPath || defaultDbPath();
  cfg.exportDir = overrides.exportDir || fileCfg.exportDir || path.join(rootDir, 'exports');
  cfg.kinds = CRITERIA_KINDS;
  return cfg;
}

module.exports = { KIND, DEFAULT_CONFIG, DEFAULT_ACCOUNTS, CRITERIA_KINDS, loadConfig, deepMerge, defaultDbPath };
