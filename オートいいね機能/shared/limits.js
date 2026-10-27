'use strict';

/**
 * 実行管理層（フォルダ1・2 共通）。
 *
 * 独立して働く 4 つの制約:
 *  1. 外部制限（スキの一時ロック、認証要求、結果不明）: 内部残数より優先。ブロック中は実行しない
 *  2. 内部残数: 上限 capacity まで、recovery_interval_min ごとに recovery_amount 回復（20分回復は追加要件）
 *  3. 日次上限（JST の日付で集計）
 *  4. 時間上限（直近60分）
 * さらに最小間隔（minIntervalMs）。
 *
 * 上限が未設定（null）のアカウントは実行を許可しない。既定値で黙って補完しない。
 * モード切替・日付変更・再起動で使用履歴（usage）や残数を初期化しない。
 */

const { HOUR_MS, dayKey, parseDate } = require('./clock');
const { j, pj } = require('./db');

class Limits {
  constructor(db, { tzOffsetMinutes = 540, minIntervalMs = null } = {}) {
    this.db = db;
    this.tzOffsetMinutes = tzOffsetMinutes;
    this.minIntervalMs = minIntervalMs;
  }

  q(sql) { return this.db.prepare(sql); }

  row(accountId) { return this.q('SELECT * FROM limit_accounts WHERE account_id = ?').get(accountId) || null; }

  /**
   * 値の設定。undefined の項目は変更しない。
   * 初期値を投入する場合は note に区分（教材の参考値／利用者の追加要件／実装上の初期値）を記す。
   */
  configure(accountId, { dailyLimit, hourlyLimit, capacity, internalRemaining, recoveryIntervalMin, recoveryAmount, note } = {}, nowIso) {
    const cur = this.row(accountId);
    const v = {
      daily_limit: cur ? cur.daily_limit : null,
      hourly_limit: cur ? cur.hourly_limit : null,
      capacity: cur ? cur.capacity : null,
      internal_remaining: cur ? cur.internal_remaining : null,
      recovery_interval_min: cur ? cur.recovery_interval_min : null,
      recovery_amount: cur ? cur.recovery_amount : null,
      last_recovery_at: cur ? cur.last_recovery_at : null,
      external_block_json: cur ? cur.external_block_json : null,
      note: cur ? cur.note : '',
    };
    if (dailyLimit !== undefined) v.daily_limit = dailyLimit;
    if (hourlyLimit !== undefined) v.hourly_limit = hourlyLimit;
    if (capacity !== undefined) v.capacity = capacity;
    if (internalRemaining !== undefined) v.internal_remaining = internalRemaining;
    else if (v.internal_remaining == null && v.capacity != null) v.internal_remaining = v.capacity;
    if (recoveryIntervalMin !== undefined) v.recovery_interval_min = recoveryIntervalMin;
    if (recoveryAmount !== undefined) v.recovery_amount = recoveryAmount;
    if (note !== undefined) v.note = note;
    if (v.last_recovery_at == null) v.last_recovery_at = nowIso;
    this.q(`INSERT INTO limit_accounts(account_id, daily_limit, hourly_limit, capacity, internal_remaining, recovery_interval_min, recovery_amount, last_recovery_at, external_block_json, note, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET daily_limit = excluded.daily_limit, hourly_limit = excluded.hourly_limit, capacity = excluded.capacity,
        internal_remaining = excluded.internal_remaining, recovery_interval_min = excluded.recovery_interval_min, recovery_amount = excluded.recovery_amount,
        last_recovery_at = excluded.last_recovery_at, external_block_json = excluded.external_block_json, note = excluded.note, updated_at = excluded.updated_at`)
      .run(accountId, v.daily_limit, v.hourly_limit, v.capacity, v.internal_remaining, v.recovery_interval_min, v.recovery_amount, v.last_recovery_at, v.external_block_json, v.note, nowIso);
    return this.status(accountId, parseDate(nowIso));
  }

  /** 既に設定済みなら触らない初期投入 */
  ensureConfigured(accountId, values, nowIso) {
    if (this.row(accountId)) return false;
    this.configure(accountId, values, nowIso);
    return true;
  }

  /**
   * 時間経過による内部残数の回復。経過した区間数ぶんだけ回復し、last_recovery_at は区間単位で進める
   * （now に揃えないので、半端な経過時間は次回に持ち越される）。
   */
  applyRecovery(accountId, now) {
    const a = this.row(accountId);
    if (!a || a.recovery_interval_min == null || a.recovery_amount == null || a.capacity == null || a.internal_remaining == null) return { recovered: 0 };
    const last = parseDate(a.last_recovery_at) || now;
    const intervalMs = a.recovery_interval_min * 60 * 1000;
    if (intervalMs <= 0) return { recovered: 0 };
    const elapsed = now.getTime() - last.getTime();
    if (elapsed < intervalMs) return { recovered: 0, nextAt: new Date(last.getTime() + intervalMs).toISOString() };
    const periods = Math.floor(elapsed / intervalMs);
    const before = a.internal_remaining;
    const after = Math.min(a.capacity, before + periods * a.recovery_amount);
    const newLast = new Date(last.getTime() + periods * intervalMs).toISOString();
    this.q('UPDATE limit_accounts SET internal_remaining = ?, last_recovery_at = ?, updated_at = ? WHERE account_id = ?')
      .run(after, newLast, now.toISOString(), accountId);
    return { recovered: after - before, periods, nextAt: new Date(parseDate(newLast).getTime() + intervalMs).toISOString() };
  }

  usageRows(accountId) {
    return this.q('SELECT at, op_type FROM usage WHERE account_id = ?').all(accountId);
  }

  status(accountId, now) {
    this.applyRecovery(accountId, now);
    const a = this.row(accountId);
    const today = dayKey(now, this.tzOffsetMinutes);
    const usage = this.usageRows(accountId).map((u) => parseDate(u.at)).filter(Boolean);
    const usedToday = usage.filter((d) => dayKey(d, this.tzOffsetMinutes) === today).length;
    const usedLastHour = usage.filter((d) => now.getTime() - d.getTime() < HOUR_MS && now.getTime() - d.getTime() >= 0).length;
    const lastAt = usage.length ? usage.reduce((x, y) => (x > y ? x : y)) : null;
    if (!a) {
      return { accountId, configured: false, dailyLimit: null, hourlyLimit: null, capacity: null, internalRemaining: null, recoveryIntervalMin: null, recoveryAmount: null, usedToday, usedLastHour, lastAt: lastAt ? lastAt.toISOString() : null, externalBlock: null, nextRecoveryAt: null, note: '' };
    }
    const configured = a.daily_limit != null && a.hourly_limit != null && a.capacity != null && a.internal_remaining != null
      && a.recovery_interval_min != null && a.recovery_amount != null;
    const nextRecoveryAt = a.recovery_interval_min != null && a.last_recovery_at
      ? new Date(parseDate(a.last_recovery_at).getTime() + a.recovery_interval_min * 60 * 1000).toISOString() : null;
    return {
      accountId,
      configured,
      dailyLimit: a.daily_limit,
      hourlyLimit: a.hourly_limit,
      capacity: a.capacity,
      internalRemaining: a.internal_remaining,
      recoveryIntervalMin: a.recovery_interval_min,
      recoveryAmount: a.recovery_amount,
      lastRecoveryAt: a.last_recovery_at,
      nextRecoveryAt,
      usedToday,
      usedLastHour,
      remainingToday: a.daily_limit != null ? Math.max(0, a.daily_limit - usedToday) : null,
      remainingThisHour: a.hourly_limit != null ? Math.max(0, a.hourly_limit - usedLastHour) : null,
      lastAt: lastAt ? lastAt.toISOString() : null,
      minIntervalMs: this.minIntervalMs,
      externalBlock: pj(a.external_block_json),
      dayKey: today,
      note: a.note || '',
    };
  }

  /** 実行可否。外部制限 → 未設定 → 内部残数 → 日次 → 時間 → 最小間隔 の順に判定 */
  canExecute(accountId, now) {
    const s = this.status(accountId, now);
    if (s.externalBlock) {
      return { ok: false, code: 'external_block', message: `外部制限により停止中: ${s.externalBlock.message || s.externalBlock.code}`, status: s };
    }
    if (!s.configured) {
      return { ok: false, code: 'limits_unset', message: '実行上限（日次/時間/内部残数/回復）が未設定。管理層の値を設定してください', status: s };
    }
    if (s.internalRemaining <= 0) return { ok: false, code: 'internal_exhausted', message: `内部残数が0（次回回復 ${s.nextRecoveryAt || '不明'}）`, status: s };
    if (s.usedToday >= s.dailyLimit) return { ok: false, code: 'daily_exhausted', message: `日次上限 ${s.dailyLimit} に到達（JST ${s.dayKey}）`, status: s };
    if (s.usedLastHour >= s.hourlyLimit) return { ok: false, code: 'hourly_exhausted', message: `時間上限 ${s.hourlyLimit} に到達`, status: s };
    if (this.minIntervalMs && s.lastAt) {
      const since = now.getTime() - parseDate(s.lastAt).getTime();
      if (since >= 0 && since < this.minIntervalMs) {
        return { ok: false, code: 'interval', message: '最小間隔未経過', waitMs: this.minIntervalMs - since, status: s };
      }
    }
    return { ok: true, code: 'ok', status: s };
  }

  /** 実行枠の消費（送信開始時に呼ぶ。ドライランでは呼ばない） */
  consume(accountId, now, { opType = 'like', personId = null, runId = null } = {}) {
    const a = this.row(accountId);
    if (!a) throw new Error(`consume: 未設定のアカウント ${accountId}`);
    this.q('INSERT INTO usage(account_id, op_type, at, person_id, run_id) VALUES (?,?,?,?,?)')
      .run(accountId, opType, now.toISOString(), personId, runId);
    if (a.internal_remaining != null) {
      this.q('UPDATE limit_accounts SET internal_remaining = MAX(0, internal_remaining - 1), updated_at = ? WHERE account_id = ?')
        .run(now.toISOString(), accountId);
    }
  }

  setExternalBlock(accountId, { code, message, source = null, until = null }, nowIso) {
    const a = this.row(accountId);
    if (!a) throw new Error(`setExternalBlock: 未設定のアカウント ${accountId}`);
    this.q('UPDATE limit_accounts SET external_block_json = ?, updated_at = ? WHERE account_id = ?')
      .run(j({ code, message, source, until, at: nowIso }), nowIso, accountId);
  }

  clearExternalBlock(accountId, nowIso) {
    this.q('UPDATE limit_accounts SET external_block_json = NULL, updated_at = ? WHERE account_id = ?').run(nowIso, accountId);
  }

  allStatuses(accountIds, now) {
    return accountIds.map((id) => this.status(id, now));
  }
}

module.exports = { Limits };
