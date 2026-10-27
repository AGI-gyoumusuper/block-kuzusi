'use strict';

/**
 * 共有DB（SQLite）。1 と 2 が同じファイルを使う。
 * - Node.js 組み込みの node:sqlite を使用（ネイティブ依存なし、Node 22.13 以上）
 * - WAL + busy_timeout で複数プロセスからの同時アクセスに耐える
 * - 予約などの原子的操作は BEGIN IMMEDIATE のトランザクションで行う
 */

const fs = require('node:fs');
const path = require('node:path');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch (e) {
  sqlite = null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT UNIQUE,
  urlname TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  profile_url TEXT,
  identity_confirmed INTEGER NOT NULL DEFAULT 0,
  following_count INTEGER,
  follower_count INTEGER,
  counts_raw TEXT,
  latest_note_json TEXT,
  pinned_note_json TEXT,
  notes_fetched_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_fetched_at TEXT,
  last_fetch_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_persons_urlname ON persons(urlname);

CREATE TABLE IF NOT EXISTS identity_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  urlname TEXT,
  user_id TEXT,
  event TEXT NOT NULL,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  list_type TEXT NOT NULL,
  seed_url TEXT NOT NULL,
  seed_urlname TEXT,
  seed_note_url TEXT NOT NULL DEFAULT '',
  seed_note_key TEXT,
  seed_verified INTEGER NOT NULL DEFAULT 0,
  reaction_at TEXT,
  reaction_evidence TEXT,
  order_evidence TEXT,
  list_position INTEGER,
  first_discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(person_id, list_type, seed_url, seed_note_url)
);

CREATE TABLE IF NOT EXISTS evaluations (
  person_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  account_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY(person_id, mode, account_id)
);

CREATE TABLE IF NOT EXISTS assignments (
  person_id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  basis_json TEXT,
  conflict_json TEXT
);

CREATE TABLE IF NOT EXISTS targets (
  person_id INTEGER NOT NULL,
  op_type TEXT NOT NULL,
  state TEXT NOT NULL,
  account_id TEXT,
  mode TEXT,
  note_key TEXT,
  note_url TEXT,
  run_id TEXT,
  reserved_at TEXT,
  reserve_expires_at TEXT,
  sending_started_at TEXT,
  finished_at TEXT,
  reason_code TEXT,
  reason_text TEXT,
  detail_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(person_id, op_type)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  op_type TEXT NOT NULL,
  account_id TEXT NOT NULL,
  run_id TEXT,
  note_key TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  dry_run INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  state TEXT NOT NULL,
  stop_reason TEXT,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  seed_urls_json TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS seeds (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  url TEXT,
  urlname TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  url_confirmed_by_spec INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  verification_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS limit_accounts (
  account_id TEXT PRIMARY KEY,
  daily_limit INTEGER,
  hourly_limit INTEGER,
  capacity INTEGER,
  internal_remaining INTEGER,
  recovery_interval_min INTEGER,
  recovery_amount INTEGER,
  last_recovery_at TEXT,
  external_block_json TEXT,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  op_type TEXT NOT NULL,
  at TEXT NOT NULL,
  person_id INTEGER,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_account_at ON usage(account_id, at);

CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(person_id, account_id, kind)
);

CREATE TABLE IF NOT EXISTS exclusions (
  urlname TEXT PRIMARY KEY,
  user_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS executor_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  account_id TEXT,
  run_id TEXT,
  level TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT
);
`;

function openDb(file) {
  if (!sqlite || !sqlite.DatabaseSync) {
    throw new Error('node:sqlite が利用できません。Node.js 22.13 以上（または 23.4 以上）で実行してください');
  }
  const isMemory = !file || file === ':memory:';
  if (!isMemory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(isMemory ? ':memory:' : file);
  if (!isMemory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** 書き込みトランザクション（BEGIN IMMEDIATE で他プロセスの書き込みと直列化） */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* no-op */ }
    throw e;
  }
}

function j(v) { return v === undefined ? null : JSON.stringify(v); }
function pj(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch (_) { return fallback; }
}
function b(v) { return v ? 1 : 0; }

module.exports = { openDb, transaction, j, pj, b, SCHEMA, sqliteAvailable: !!(sqlite && sqlite.DatabaseSync) };
