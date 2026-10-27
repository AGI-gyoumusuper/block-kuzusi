'use strict';

/**
 * 実行管理層（フォルダ1・2 共通）。残数と上限は「操作するアカウント × action種別（like / follow_back）」で持つ。
 *  - スキ獲得・フォロワー獲得の2モードは同じアカウントの同じ like 枠を使う（モードごとに枠を持たない）
 *  - follow_back は別枠。3アカウントの枠を混同しない
 *
 * 内部 credits の回復（アプリ内の規則。note 公式の制限や外部ロック解除時間ではない）:
 *  - 回復間隔（既定20分、設定可能）ごとに recovery_amount（既定1）加算し、capacity で打ち切る
 *  - 残数が正から 0 へ変化した時点で empty_since と last_refill をその時刻に設定し、最初の +1 はその間隔後
 *  - 初期残数 0 で開始する場合も起点を一度だけ保存する。残数 0 の間に画面更新・再起動しただけで起点を更新しない
 *  - 経過時間 ÷ 間隔 の整数切り捨て回数だけ加算し、処理した区間ぶん last_refill を進める。容量に収まらなかった分は繰り越さない
 *  - 時計の巻き戻り（経過が負）では回復せず、起点を現在に置き直して記録する
 *
 * 有効残数 = min(内部残数 − 引当, 日次残数 − 引当, 時間残数 − 引当)。引当 = 予約中（reserved）の対象数。
 * 日次は JST の日付、時間は実行時点から直近60分の履歴。モード変更・再起動で利用件数をリセットしない。
 *
 * 外部制限（429・制限表示）、認証切れ（401・ログイン要求）、権限不明（403）はアカウント単位の別状態で持ち、
 * 内部回復が進んでも解除しない。利用者が解除を確認するまで実行しない。
 */

const { HOUR_MS, dayKey, parseDate } = require('./clock');
const { transaction, j, pj } = require('./db');

const OP_TYPES = Object.freeze(['like', 'follow_back']);
const BLOCK_KINDS = Object.freeze({ EXTERNAL_LIMIT: 'external_limit', AUTH: 'auth', PERMISSION_UNKNOWN: 'permission_unknown' });
const REQUIRED = ['daily_limit', 'hourly_limit', 'capacity', 'credits', 'recovery_interval_min', 'recovery_amount'];

function isIntOrNull(v) { return v == null || (typeof v === 'number' && Number.isInteger(v)); }

class Limits {
  constructor(db, { tzOffsetMinutes = 540, minIntervalMs = null, onEvent = null } = {}) {
    this.db = db;
    this.tzOffsetMinutes = tzOffsetMinutes;
    this.minIntervalMs = minIntervalMs;
    this.onEvent = onEvent;
  }

  q(sql) { return this.db.prepare(sql); }
  tx(fn) { return transaction(this.db, fn); }

  pool(accountId, opType) {
    return this.q('SELECT * FROM limit_pools WHERE account_id = ? AND op_type = ?').get(accountId, opType) || null;
  }

  /**
   * 値の設定。undefined の項目は変更しない。null は「未設定」。
   * labels: 各値の区分（教材の参考値／利用者の追加要件／実装上の初期値／未設定）
   */
  configure(accountId, opType, { dailyLimit, hourlyLimit, capacity, credits, recoveryIntervalMin, recoveryAmount, labels, note } = {}, nowIso) {
    if (!OP_TYPES.includes(opType)) throw new Error(`不明な action 種別: ${opType}`);
    return this.tx(() => {
      const cur = this.pool(accountId, opType);
      const v = {
        daily_limit: cur ? cur.daily_limit : null,
        hourly_limit: cur ? cur.hourly_limit : null,
        capacity: cur ? cur.capacity : null,
        credits: cur ? cur.credits : null,
        recovery_interval_min: cur ? cur.recovery_interval_min : null,
        recovery_amount: cur ? cur.recovery_amount : null,
        last_refill: cur ? cur.last_refill : null,
        empty_since: cur ? cur.empty_since : null,
        labels_json: cur ? cur.labels_json : null,
        note: cur ? cur.note : '',
      };
      const set = (key, val) => { if (val !== undefined) { if (!isIntOrNull(val)) throw new Error(`${key} は整数または null`); v[key] = val; } };
      set('daily_limit', dailyLimit);
      set('hourly_limit', hourlyLimit);
      set('capacity', capacity);
      set('recovery_interval_min', recoveryIntervalMin);
      set('recovery_amount', recoveryAmount);
      if (credits !== undefined) set('credits', credits);
      else if (v.credits == null && v.capacity != null) v.credits = v.capacity;
      if (v.capacity != null && v.credits != null && v.credits > v.capacity) v.credits = v.capacity;
      if (labels !== undefined) v.labels_json = j(labels);
      if (note !== undefined) v.note = note;
      // 起点を一度だけ保存（残数が決まった時点）。残数 0 で始まる場合は empty_since も同時に
      if (v.last_refill == null && v.credits != null) {
        v.last_refill = nowIso;
        if (v.credits === 0 && v.empty_since == null) v.empty_since = nowIso;
      }
      this.q(`INSERT INTO limit_pools(account_id, op_type, daily_limit, hourly_limit, capacity, credits, recovery_interval_min, recovery_amount, last_refill, empty_since, labels_json, note, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id, op_type) DO UPDATE SET daily_limit = excluded.daily_limit, hourly_limit = excluded.hourly_limit, capacity = excluded.capacity,
          credits = excluded.credits, recovery_interval_min = excluded.recovery_interval_min, recovery_amount = excluded.recovery_amount,
          last_refill = excluded.last_refill, empty_since = excluded.empty_since, labels_json = excluded.labels_json, note = excluded.note, updated_at = excluded.updated_at`)
        .run(accountId, opType, v.daily_limit, v.hourly_limit, v.capacity, v.credits, v.recovery_interval_min, v.recovery_amount, v.last_refill, v.empty_since, v.labels_json, v.note, nowIso);
      return this.status(accountId, opType, parseDate(nowIso));
    });
  }

  /** 既に設定済みなら触らない初期投入 */
  ensureConfigured(accountId, opType, values, nowIso) {
    if (this.pool(accountId, opType)) return false;
    this.configure(accountId, opType, values, nowIso);
    return true;
  }

  /** 設定の妥当性。未設定・0以下などでは開始しない */
  validity(p) {
    if (!p) return { ok: false, code: 'limits_unset', message: '上限が未設定（この action 種別の枠がない）', missing: REQUIRED.slice() };
    const missing = REQUIRED.filter((k) => p[k] == null);
    if (missing.length) return { ok: false, code: 'limits_unset', message: `上限が未設定: ${missing.join(', ')}。明示設定されるまで開始できない`, missing };
    if (p.capacity <= 0 || p.recovery_interval_min <= 0 || p.recovery_amount < 0 || p.daily_limit < 0 || p.hourly_limit < 0 || p.credits < 0) {
      return { ok: false, code: 'limits_invalid', message: '上限の設定が不正（容量・回復間隔は正の整数、各上限は0以上）' };
    }
    return { ok: true, code: 'ok' };
  }

  /**
   * 時間経過による回復（トランザクション内で呼ぶ。同じ時刻で何度呼んでも二重に回復しない）。
   */
  applyRefill(accountId, opType, now) {
    return this.tx(() => {
      const p = this.pool(accountId, opType);
      if (!p || !this.validity(p).ok) return { refilled: 0, periods: 0 };
      const nowIso = now.toISOString();
      if (p.last_refill == null) {
        this.q('UPDATE limit_pools SET last_refill = ?, empty_since = CASE WHEN credits = 0 AND empty_since IS NULL THEN ? ELSE empty_since END, updated_at = ? WHERE account_id = ? AND op_type = ?')
          .run(nowIso, nowIso, nowIso, accountId, opType);
        return { refilled: 0, periods: 0, anchored: true };
      }
      const last = parseDate(p.last_refill);
      const elapsed = now.getTime() - last.getTime();
      if (elapsed < 0) {
        // 時計の巻き戻り: 回復せず、起点を現在に置き直す（負値・余分な回復を防ぐ）
        this.q('UPDATE limit_pools SET last_refill = ?, updated_at = ? WHERE account_id = ? AND op_type = ?').run(nowIso, nowIso, accountId, opType);
        if (this.onEvent) this.onEvent({ level: 'warn', code: 'clock_rollback', message: `時計の巻き戻りを検出（${p.last_refill} → ${nowIso}）。回復せず起点を置き直した`, accountId, data: { opType } }, nowIso);
        return { refilled: 0, periods: 0, clockRollback: true };
      }
      const intervalMs = p.recovery_interval_min * 60 * 1000;
      const periods = Math.floor(elapsed / intervalMs);
      if (periods === 0) return { refilled: 0, periods: 0, nextAt: new Date(last.getTime() + intervalMs).toISOString() };
      const newLast = new Date(last.getTime() + periods * intervalMs).toISOString();
      const before = p.credits;
      const after = before >= p.capacity ? before : Math.min(p.capacity, before + periods * p.recovery_amount);
      this.q('UPDATE limit_pools SET credits = ?, last_refill = ?, empty_since = CASE WHEN ? > 0 THEN NULL ELSE empty_since END, updated_at = ? WHERE account_id = ? AND op_type = ?')
        .run(after, newLast, after, nowIso, accountId, opType);
      return { refilled: after - before, periods, nextAt: new Date(parseDate(newLast).getTime() + intervalMs).toISOString() };
    });
  }

  /** 引当 = 予約中（reserved）の対象数 */
  holds(accountId, opType) {
    const r = this.q("SELECT COUNT(*) AS n FROM targets WHERE state = 'reserved' AND account_id = ? AND op_type = ?").get(accountId, opType);
    return r ? r.n : 0;
  }

  usageRows(accountId, opType) {
    return opType
      ? this.q('SELECT at, op_type FROM usage WHERE account_id = ? AND op_type = ?').all(accountId, opType)
      : this.q('SELECT at, op_type FROM usage WHERE account_id = ?').all(accountId);
  }

  usageCounts(accountId, opType, now) {
    const today = dayKey(now, this.tzOffsetMinutes);
    const usage = this.usageRows(accountId, opType).map((u) => parseDate(u.at)).filter(Boolean);
    const usedToday = usage.filter((d) => dayKey(d, this.tzOffsetMinutes) === today).length;
    const usedLastHour = usage.filter((d) => now.getTime() - d.getTime() < HOUR_MS && now.getTime() - d.getTime() >= 0).length;
    const lastAt = usage.length ? usage.reduce((x, y) => (x > y ? x : y)) : null;
    return { usedToday, usedLastHour, lastAt: lastAt ? lastAt.toISOString() : null, dayKey: today };
  }

  externalBlock(accountId) {
    const r = this.q('SELECT * FROM account_blocks WHERE account_id = ?').get(accountId);
    return r ? { kind: r.kind, code: r.code, message: r.message, source: r.source, at: r.at } : null;
  }

  status(accountId, opType, now) {
    this.applyRefill(accountId, opType, now);
    const p = this.pool(accountId, opType);
    const u = usageCountsSafe(this, accountId, opType, now);
    const holds = this.holds(accountId, opType);
    const valid = this.validity(p);
    const block = this.externalBlock(accountId);
    const internalAvailable = p && p.credits != null ? Math.max(0, p.credits - holds) : null;
    const dailyAvailable = p && p.daily_limit != null ? Math.max(0, p.daily_limit - u.usedToday - holds) : null;
    const hourlyAvailable = p && p.hourly_limit != null ? Math.max(0, p.hourly_limit - u.usedLastHour - holds) : null;
    const effective = valid.ok ? Math.min(internalAvailable, dailyAvailable, hourlyAvailable) : null;
    const intervalMs = p && p.recovery_interval_min ? p.recovery_interval_min * 60 * 1000 : null;
    const nextRefillAt = p && p.last_refill && intervalMs && p.credits != null && p.capacity != null && p.credits < p.capacity
      ? new Date(parseDate(p.last_refill).getTime() + intervalMs).toISOString() : null;
    return {
      accountId,
      opType,
      configured: !!p,
      valid: valid.ok,
      validity: valid,
      dailyLimit: p ? p.daily_limit : null,
      hourlyLimit: p ? p.hourly_limit : null,
      capacity: p ? p.capacity : null,
      credits: p ? p.credits : null,
      recoveryIntervalMin: p ? p.recovery_interval_min : null,
      recoveryAmount: p ? p.recovery_amount : null,
      lastRefill: p ? p.last_refill : null,
      emptySince: p ? p.empty_since : null,
      nextRefillAt,
      usedToday: u.usedToday,
      usedLastHour: u.usedLastHour,
      lastAt: u.lastAt,
      dayKey: u.dayKey,
      holds,
      internalAvailable,
      dailyAvailable,
      hourlyAvailable,
      effective,
      externalBlock: block,
      minIntervalMs: this.minIntervalMs,
      labels: p ? pj(p.labels_json, {}) : {},
      note: p ? p.note : '',
    };
  }

  /**
   * 実行可否。外部制限／認証切れ → 未設定・不正 → 内部残数 → 日次 → 時間 → 最小間隔 の順。
   * 内部 credits が 1 に戻っても、他の残数が 0 なら実行しない。
   */
  canExecute(accountId, opType, now) {
    const s = this.status(accountId, opType, now);
    if (s.externalBlock) {
      const label = { external_limit: '外部制限', auth: '認証切れ・認証要求', permission_unknown: '権限不明（403）' }[s.externalBlock.kind] || s.externalBlock.kind;
      return { ok: false, code: `blocked_${s.externalBlock.kind}`, kind: s.externalBlock.kind, message: `${label}により停止中: ${s.externalBlock.message || s.externalBlock.code}。内部回復では解除されない。解除を確認するまで実行しない`, status: s };
    }
    if (!s.valid) return { ok: false, code: s.validity.code, message: s.validity.message, status: s };
    if (s.internalAvailable <= 0) return { ok: false, code: 'internal_exhausted', message: `内部残数が0（次回回復 ${s.nextRefillAt || '不明'}）`, status: s };
    if (s.dailyAvailable <= 0) return { ok: false, code: 'daily_exhausted', message: `日次上限 ${s.dailyLimit} に到達（JST ${s.dayKey}）`, status: s };
    if (s.hourlyAvailable <= 0) return { ok: false, code: 'hourly_exhausted', message: `直近1時間の上限 ${s.hourlyLimit} に到達`, status: s };
    if (this.minIntervalMs && s.lastAt) {
      const since = now.getTime() - parseDate(s.lastAt).getTime();
      if (since >= 0 && since < this.minIntervalMs) return { ok: false, code: 'interval', message: '最小間隔未経過', waitMs: this.minIntervalMs - since, status: s };
    }
    return { ok: true, code: 'ok', status: s };
  }

  /**
   * 予約と引当を一つのトランザクションで行う。候補選定だけでは枠を確保した扱いにしない。
   * 有効残数（引当込み）が 0 なら予約しない。同じ枠の二重予約を防ぐ。
   */
  reserveWithCredit(ledger, { personId, opType, accountId, runId }, now, ttlMs) {
    return this.tx(() => {
      this.applyRefill(accountId, opType, now);
      const can = this.canExecute(accountId, opType, now);
      if (!can.ok) return { ok: false, ...can };
      const r = ledger.reserve(personId, opType, accountId, runId, now.toISOString(), ttlMs);
      if (!r.ok) return { ok: false, code: r.code, assignedTo: r.assignedTo, runId: r.runId };
      return { ok: true, code: r.code, status: this.status(accountId, opType, now) };
    });
  }

  /**
   * 枠の消費（送信開始時に呼ぶ。ドライランでは呼ばない）。
   * 残数が正から 0 へ変化したら empty_since と last_refill をこの時刻にする。
   */
  consume(accountId, opType, now, { personId = null, runId = null } = {}) {
    return this.tx(() => {
      const p = this.pool(accountId, opType);
      if (!p) throw new Error(`consume: 未設定の枠 ${accountId}/${opType}`);
      const nowIso = now.toISOString();
      this.q('INSERT INTO usage(account_id, op_type, at, person_id, run_id) VALUES (?,?,?,?,?)').run(accountId, opType, nowIso, personId, runId);
      if (p.credits != null) {
        const after = Math.max(0, p.credits - 1);
        if (p.credits > 0 && after === 0) {
          this.q('UPDATE limit_pools SET credits = ?, empty_since = ?, last_refill = ?, updated_at = ? WHERE account_id = ? AND op_type = ?')
            .run(after, nowIso, nowIso, nowIso, accountId, opType);
        } else {
          this.q('UPDATE limit_pools SET credits = ?, updated_at = ? WHERE account_id = ? AND op_type = ?').run(after, nowIso, accountId, opType);
        }
      }
      return this.pool(accountId, opType).credits;
    });
  }

  setExternalBlock(accountId, { kind, code, message, source = null }, nowIso) {
    if (!Object.values(BLOCK_KINDS).includes(kind)) throw new Error(`不明なブロック種別: ${kind}`);
    this.q(`INSERT INTO account_blocks(account_id, kind, code, message, source, at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET kind = excluded.kind, code = excluded.code, message = excluded.message, source = excluded.source, at = excluded.at`)
      .run(accountId, kind, code || null, message || null, source, nowIso);
  }

  clearExternalBlock(accountId) {
    return this.q('DELETE FROM account_blocks WHERE account_id = ?').run(accountId).changes === 1;
  }

  allStatuses(accountIds, now, opTypes = OP_TYPES) {
    const out = {};
    for (const a of accountIds) {
      out[a] = {};
      for (const op of opTypes) out[a][op] = this.status(a, op, now);
    }
    return out;
  }
}

function usageCountsSafe(limits, accountId, opType, now) { return limits.usageCounts(accountId, opType, now); }

/** アダプタの例外から外部ブロック種別を判定する（該当しなければ null） */
function blockFromError(e) {
  if (!e || !e.code) return null;
  if (e.code === 'rate_limited' || e.code === 'like_locked' || e.code === 'external_limit') return { kind: BLOCK_KINDS.EXTERNAL_LIMIT, code: e.code, message: e.message };
  if (e.code === 'auth_required') return { kind: BLOCK_KINDS.AUTH, code: e.code, message: e.message };
  if (e.code === 'forbidden') return { kind: BLOCK_KINDS.PERMISSION_UNKNOWN, code: e.code, message: `403: 認証か権限か不明。停止して理由を残す（${e.message}）` };
  return null;
}

module.exports = { Limits, OP_TYPES, BLOCK_KINDS, blockFromError };
