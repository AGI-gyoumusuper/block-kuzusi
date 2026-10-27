'use strict';

/**
 * 共有台帳（3アカウント・両モード・フォルダ1/2 共通）。
 *
 * 管理の流れ: 候補(candidate) → 担当決定(assignments) → 実行直前の予約(reserved)
 *            → 送信開始(sending) → 結果(succeeded / skipped / failed_before_send / unknown / blocked)
 *
 * - 対象者は表示名でなく安定した userId を優先して同定し、urlname(slug) の変更を identity_history に残す
 * - 一人につき担当アカウントは一つ。再起動しても維持する
 * - 履歴キーは (person_id, op_type)。スキ(like)とフォロー返し(follow_back)は区別する
 * - 予約は BEGIN IMMEDIATE のトランザクションで原子的に行い、同時起動でも同じ対象を二つの実行器が取れない
 * - sending に入った対象は予約期限切れだけでは他へ渡さない。中断時は unknown にする
 */

const { transaction, j, pj, b } = require('./db');
const { parseDate } = require('./clock');

const STATES = Object.freeze(['candidate', 'reserved', 'sending', 'succeeded', 'skipped', 'failed_before_send', 'unknown', 'blocked']);
const FINAL_STATES = Object.freeze(['succeeded', 'skipped', 'failed_before_send', 'unknown', 'blocked']);
const OP = Object.freeze({ LIKE: 'like', FOLLOW_BACK: 'follow_back' });

function rowToPerson(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    urlname: row.urlname,
    displayName: row.display_name,
    profileUrl: row.profile_url,
    identityConfirmed: !!row.identity_confirmed,
    followingCount: row.following_count,
    followerCount: row.follower_count,
    countsRaw: row.counts_raw,
    latestNote: pj(row.latest_note_json),
    pinnedNote: pj(row.pinned_note_json),
    notesFetchedAt: row.notes_fetched_at,
    firstSeenAt: row.first_seen_at,
    lastFetchedAt: row.last_fetched_at,
    lastFetchError: row.last_fetch_error,
  };
}

function rowToSource(row) {
  return {
    id: row.id,
    personId: row.person_id,
    mode: row.mode,
    listType: row.list_type,
    seedUrl: row.seed_url,
    seedUrlname: row.seed_urlname,
    seedNoteUrl: row.seed_note_url || null,
    seedNoteKey: row.seed_note_key,
    seedVerified: !!row.seed_verified,
    reactionAt: row.reaction_at,
    reactionEvidence: row.reaction_evidence,
    orderEvidence: row.order_evidence,
    listPosition: row.list_position,
    firstDiscoveredAt: row.first_discovered_at,
    lastSeenAt: row.last_seen_at,
  };
}

function rowToTarget(row) {
  if (!row) return null;
  return {
    personId: row.person_id,
    opType: row.op_type,
    state: row.state,
    accountId: row.account_id,
    mode: row.mode,
    noteKey: row.note_key,
    noteUrl: row.note_url,
    runId: row.run_id,
    reservedAt: row.reserved_at,
    reserveExpiresAt: row.reserve_expires_at,
    sendingStartedAt: row.sending_started_at,
    finishedAt: row.finished_at,
    reasonCode: row.reason_code,
    reasonText: row.reason_text,
    detail: pj(row.detail_json),
    updatedAt: row.updated_at,
  };
}

function rowToSeed(row) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    url: row.url,
    urlname: row.urlname,
    displayName: row.display_name,
    note: row.note,
    urlConfirmedBySpec: !!row.url_confirmed_by_spec,
    enabled: !!row.enabled,
    verified: !!row.verified,
    verifiedAt: row.verified_at,
    verification: pj(row.verification_json),
    createdAt: row.created_at,
  };
}

class Ledger {
  constructor(db) {
    this.db = db;
    this._stmts = new Map();
  }

  q(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }

  tx(fn) { return transaction(this.db, fn); }

  // ------------------------------------------------------------------ persons
  getPerson(id) { return rowToPerson(this.q('SELECT * FROM persons WHERE id = ?').get(id)); }

  findByUserId(userId) {
    if (!userId) return null;
    return rowToPerson(this.q('SELECT * FROM persons WHERE user_id = ?').get(String(userId)));
  }

  findByUrlname(urlname) {
    const rows = this.q('SELECT * FROM persons WHERE urlname = ? ORDER BY id DESC').all(urlname);
    return rows.map(rowToPerson);
  }

  listPersons() { return this.q('SELECT * FROM persons ORDER BY id').all().map(rowToPerson); }

  /**
   * 人物を解決して登録する。userId を優先し、slug 変更を追跡する。
   * person: { urlname, userId?, displayName?, profileUrl? }
   */
  resolvePerson(person, nowIso) {
    if (!person || !person.urlname) throw new Error('resolvePerson: urlname が必要');
    const userId = person.userId != null ? String(person.userId) : null;
    const urlname = person.urlname;
    let row = null;
    let isNew = false;
    let identityChanged = false;
    const stalePersonIds = [];

    if (userId) {
      row = this.findByUserId(userId);
      if (row) {
        if (row.urlname !== urlname) {
          this.q('INSERT INTO identity_history(person_id, urlname, user_id, event, seen_at) VALUES (?,?,?,?,?)')
            .run(row.id, row.urlname, row.userId, 'urlname_changed', nowIso);
          this.q('UPDATE persons SET urlname = ?, profile_url = ? WHERE id = ?')
            .run(urlname, person.profileUrl || `https://note.com/${urlname}`, row.id);
          identityChanged = true;
        }
      } else {
        const byUrl = this.findByUrlname(urlname).find((p) => p.userId == null);
        if (byUrl) {
          this.q('INSERT INTO identity_history(person_id, urlname, user_id, event, seen_at) VALUES (?,?,?,?,?)')
            .run(byUrl.id, urlname, userId, 'user_id_attached', nowIso);
          this.q('UPDATE persons SET user_id = ? WHERE id = ?').run(userId, byUrl.id);
          row = byUrl;
        }
      }
    } else {
      const candidates = this.findByUrlname(urlname);
      row = candidates[0] || null;
    }

    if (!row) {
      // 同じ urlname を別の userId が使っている既存行は「本人識別が確定しない」状態にする（urlname の再利用・変更を追跡）
      if (userId) {
        for (const old of this.findByUrlname(urlname)) {
          if (old.userId && old.userId !== userId) {
            this.q('INSERT INTO identity_history(person_id, urlname, user_id, event, seen_at) VALUES (?,?,?,?,?)')
              .run(old.id, urlname, old.userId, 'urlname_reassigned', nowIso);
            this.q('UPDATE persons SET identity_confirmed = 0, latest_note_json = ?, last_fetch_error = ? WHERE id = ?')
              .run(j({ note: null, code: 'urlname_reassigned', message: 'この urlname が別の userId で観測された。本人識別が確定しない' }), 'urlname_reassigned', old.id);
            stalePersonIds.push(old.id);
          }
        }
      }
      isNew = true;
      const r = this.q(`INSERT INTO persons(user_id, urlname, display_name, profile_url, identity_confirmed, first_seen_at)
        VALUES (?,?,?,?,?,?)`).run(userId, urlname, person.displayName || '', person.profileUrl || `https://note.com/${urlname}`, b(person.identityConfirmed), nowIso);
      this.q('INSERT INTO identity_history(person_id, urlname, user_id, event, seen_at) VALUES (?,?,?,?,?)')
        .run(Number(r.lastInsertRowid), urlname, userId, 'created', nowIso);
      row = this.getPerson(Number(r.lastInsertRowid));
    } else {
      const patch = [];
      const vals = [];
      if (person.displayName && person.displayName !== row.displayName) { patch.push('display_name = ?'); vals.push(person.displayName); }
      if (person.identityConfirmed && !row.identityConfirmed) { patch.push('identity_confirmed = 1'); }
      if (patch.length) {
        vals.push(row.id);
        this.q(`UPDATE persons SET ${patch.join(', ')} WHERE id = ?`).run(...vals);
      }
      row = this.getPerson(row.id);
    }
    return { person: row, isNew, identityChanged, stalePersonIds };
  }

  /**
   * 出所を登録・更新する。既存の出所なら last_seen_at を更新し、反応日時は取得できた場合のみ上書き。
   */
  upsertSource(personId, source, nowIso) {
    const seedNoteUrl = source.seedNoteUrl || '';
    const existing = this.q('SELECT id FROM sources WHERE person_id = ? AND list_type = ? AND seed_url = ? AND seed_note_url = ?')
      .get(personId, source.listType, source.seedUrl, seedNoteUrl);
    this.q(`INSERT INTO sources(person_id, mode, list_type, seed_url, seed_urlname, seed_note_url, seed_note_key, seed_verified,
        reaction_at, reaction_evidence, order_evidence, list_position, first_discovered_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(person_id, list_type, seed_url, seed_note_url) DO UPDATE SET
        mode = excluded.mode,
        seed_urlname = excluded.seed_urlname,
        seed_note_key = excluded.seed_note_key,
        seed_verified = excluded.seed_verified,
        reaction_at = COALESCE(excluded.reaction_at, sources.reaction_at),
        reaction_evidence = CASE WHEN excluded.reaction_at IS NOT NULL THEN excluded.reaction_evidence ELSE sources.reaction_evidence END,
        order_evidence = excluded.order_evidence,
        list_position = excluded.list_position,
        last_seen_at = excluded.last_seen_at`)
      .run(personId, source.mode, source.listType, source.seedUrl, source.seedUrlname || null, seedNoteUrl, source.seedNoteKey || null,
        b(source.seedVerified), source.reactionAt || null, source.reactionEvidence || null, source.orderEvidence || null,
        source.listPosition == null ? null : source.listPosition, nowIso, nowIso);
    return { sourceIsNew: !existing };
  }

  upsertPerson(person, source, nowIso) {
    return this.tx(() => {
      const r = this.resolvePerson(person, nowIso);
      let sourceIsNew = false;
      if (source) ({ sourceIsNew } = this.upsertSource(r.person.id, source, nowIso));
      return { ...r, sourceIsNew };
    });
  }

  sourcesOf(personId) {
    return this.q('SELECT * FROM sources WHERE person_id = ? ORDER BY id').all(personId).map(rowToSource);
  }

  identityHistoryOf(personId) {
    return this.q('SELECT * FROM identity_history WHERE person_id = ? ORDER BY id').all(personId);
  }

  updateProfile(personId, patch) {
    const map = {
      userId: 'user_id', displayName: 'display_name', profileUrl: 'profile_url', identityConfirmed: 'identity_confirmed',
      followingCount: 'following_count', followerCount: 'follower_count', countsRaw: 'counts_raw',
      latestNote: 'latest_note_json', pinnedNote: 'pinned_note_json', notesFetchedAt: 'notes_fetched_at',
      lastFetchedAt: 'last_fetched_at', lastFetchError: 'last_fetch_error',
    };
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      if (k === 'latestNote' || k === 'pinnedNote') vals.push(j(v));
      else if (k === 'identityConfirmed') vals.push(b(v));
      else if (k === 'userId') vals.push(v == null ? null : String(v));
      else vals.push(v === undefined ? null : v);
    }
    if (!sets.length) return this.getPerson(personId);
    vals.push(personId);
    this.q(`UPDATE persons SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.getPerson(personId);
  }

  // -------------------------------------------------------------- evaluations
  setEvaluation(personId, mode, accountId, ev, nowIso) {
    this.q(`INSERT INTO evaluations(person_id, mode, account_id, verdict, reasons_json, checks_json, evaluated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(person_id, mode, account_id) DO UPDATE SET verdict = excluded.verdict, reasons_json = excluded.reasons_json,
        checks_json = excluded.checks_json, evaluated_at = excluded.evaluated_at`)
      .run(personId, mode, accountId, ev.verdict, j(ev.reasons || []), j(ev.checks || {}), nowIso);
  }

  getEvaluation(personId, mode, accountId) {
    const row = this.q('SELECT * FROM evaluations WHERE person_id = ? AND mode = ? AND account_id = ?').get(personId, mode, accountId);
    return row ? { verdict: row.verdict, reasons: pj(row.reasons_json, []), checks: pj(row.checks_json, {}), evaluatedAt: row.evaluated_at, mode, accountId } : null;
  }

  evaluationsOf(personId) {
    return this.q('SELECT * FROM evaluations WHERE person_id = ? ORDER BY mode, account_id').all(personId)
      .map((row) => ({ mode: row.mode, accountId: row.account_id, verdict: row.verdict, reasons: pj(row.reasons_json, []), checks: pj(row.checks_json, {}), evaluatedAt: row.evaluated_at }));
  }

  /** 両モードの適合を併記するための要約 */
  modeFitOf(personId) {
    const fit = { suki: null, follower: null };
    for (const ev of this.evaluationsOf(personId)) {
      const cur = fit[ev.mode];
      // 採用が一つでもあれば adopt、なければ hold、なければ reject
      const rank = { adopt: 3, hold: 2, reject: 1 };
      if (!cur || rank[ev.verdict] > rank[cur]) fit[ev.mode] = ev.verdict;
    }
    return fit;
  }

  // -------------------------------------------------------------- assignments
  assignedTo(personId) {
    const row = this.q('SELECT account_id FROM assignments WHERE person_id = ?').get(personId);
    return row ? row.account_id : null;
  }

  getAssignment(personId) {
    const row = this.q('SELECT * FROM assignments WHERE person_id = ?').get(personId);
    return row ? { personId: row.person_id, accountId: row.account_id, assignedAt: row.assigned_at, basis: pj(row.basis_json), conflict: pj(row.conflict_json) } : null;
  }

  assignmentCounts() {
    const out = {};
    for (const row of this.q('SELECT account_id, COUNT(*) AS n FROM assignments GROUP BY account_id').all()) out[row.account_id] = row.n;
    return out;
  }

  /**
   * 担当を一つに決める。既に担当があればそれを返す（変更しない）。
   * eligibleAccountIds: 適合条件を満たしたアカウント（順序は優先順）。偏りを抑えるため担当数が最少のものを選ぶ。
   */
  assignBalanced(personId, eligibleAccountIds, basis, nowIso) {
    return this.tx(() => {
      const existing = this.getAssignment(personId);
      if (existing) return { ok: existing.accountId !== null, accountId: existing.accountId, created: false, existing: true };
      if (!eligibleAccountIds || eligibleAccountIds.length === 0) return { ok: false, accountId: null, created: false, code: 'no_eligible_account' };
      const counts = this.assignmentCounts();
      let best = null;
      for (const id of eligibleAccountIds) {
        const n = counts[id] || 0;
        if (best === null || n < best.n) best = { id, n };
      }
      this.q('INSERT INTO assignments(person_id, account_id, assigned_at, basis_json, conflict_json) VALUES (?,?,?,?,NULL)')
        .run(personId, best.id, nowIso, j(basis || null));
      return { ok: true, accountId: best.id, created: true, existing: false };
    });
  }

  recordAssignmentConflict(personId, conflict) {
    this.q('UPDATE assignments SET conflict_json = ? WHERE person_id = ?').run(j(conflict), personId);
  }

  // ------------------------------------------------------------------ targets
  getTarget(personId, opType) {
    return rowToTarget(this.q('SELECT * FROM targets WHERE person_id = ? AND op_type = ?').get(personId, opType));
  }

  /**
   * 候補行を用意する。成功・結果不明・送信中・予約中は触らない。
   * reopen=true のとき skipped / failed_before_send / blocked を candidate に戻す（再収集で条件を満たした場合）。
   */
  ensureCandidate(personId, opType, { accountId, mode, reopen = false }, nowIso) {
    return this.tx(() => {
      const row = this.getTarget(personId, opType);
      if (!row) {
        this.q(`INSERT INTO targets(person_id, op_type, state, account_id, mode, updated_at) VALUES (?,?,?,?,?,?)`)
          .run(personId, opType, 'candidate', accountId || null, mode || null, nowIso);
        return { state: 'candidate', changed: true };
      }
      if (row.state === 'candidate') {
        if (row.accountId !== accountId || row.mode !== mode) {
          this.q('UPDATE targets SET account_id = ?, mode = ?, updated_at = ? WHERE person_id = ? AND op_type = ? AND state = ?')
            .run(accountId || null, mode || null, nowIso, personId, opType, 'candidate');
        }
        return { state: 'candidate', changed: false };
      }
      if (reopen && ['skipped', 'failed_before_send', 'blocked'].includes(row.state)) {
        this.q(`UPDATE targets SET state = 'candidate', account_id = ?, mode = ?, run_id = NULL, reserved_at = NULL, reserve_expires_at = NULL,
            sending_started_at = NULL, finished_at = NULL, reason_code = NULL, reason_text = NULL, detail_json = ?, updated_at = ?
          WHERE person_id = ? AND op_type = ?`)
          .run(accountId || null, mode || null, j({ reopenedFrom: row.state, previousReason: row.reasonCode }), nowIso, personId, opType);
        return { state: 'candidate', changed: true, reopenedFrom: row.state };
      }
      return { state: row.state, changed: false };
    });
  }

  /**
   * 実行直前の原子的予約。
   * candidate で担当が自分のものだけ予約できる。期限切れの自分の予約（別 run）も取り直せる。
   * sending の対象は期限切れでも取れない。
   */
  reserve(personId, opType, accountId, runId, nowIso, ttlMs) {
    const expires = new Date(parseDate(nowIso).getTime() + ttlMs).toISOString();
    return this.tx(() => {
      const row = this.getTarget(personId, opType);
      if (!row) return { ok: false, code: 'no_target' };
      if (row.state === 'candidate' && row.accountId === accountId) {
        const r = this.q(`UPDATE targets SET state = 'reserved', run_id = ?, reserved_at = ?, reserve_expires_at = ?, updated_at = ?
          WHERE person_id = ? AND op_type = ? AND state = 'candidate' AND account_id = ?`)
          .run(runId, nowIso, expires, nowIso, personId, opType, accountId);
        return r.changes === 1 ? { ok: true, code: 'reserved' } : { ok: false, code: 'race_lost' };
      }
      if (row.state === 'reserved' && row.accountId === accountId && row.runId !== runId
          && row.reserveExpiresAt && parseDate(row.reserveExpiresAt) < parseDate(nowIso)) {
        const r = this.q(`UPDATE targets SET run_id = ?, reserved_at = ?, reserve_expires_at = ?, updated_at = ?
          WHERE person_id = ? AND op_type = ? AND state = 'reserved' AND account_id = ? AND run_id = ?`)
          .run(runId, nowIso, expires, nowIso, personId, opType, accountId, row.runId);
        return r.changes === 1 ? { ok: true, code: 'reserved_after_expiry', previousRunId: row.runId } : { ok: false, code: 'race_lost' };
      }
      if (row.state === 'candidate') return { ok: false, code: 'assigned_other', assignedTo: row.accountId };
      if (row.state === 'reserved') return { ok: false, code: 'reserved_by_other_run', runId: row.runId };
      return { ok: false, code: `state_${row.state}` };
    });
  }

  markSending(personId, opType, runId, { noteKey, noteUrl }, nowIso) {
    const r = this.q(`UPDATE targets SET state = 'sending', note_key = ?, note_url = ?, sending_started_at = ?, updated_at = ?
      WHERE person_id = ? AND op_type = ? AND state = 'reserved' AND run_id = ?`)
      .run(noteKey || null, noteUrl || null, nowIso, nowIso, personId, opType, runId);
    return r.changes === 1;
  }

  /** reserved / sending から終端状態へ */
  finish(personId, opType, runId, { state, reasonCode, reasonText, detail, noteKey, noteUrl }, nowIso) {
    if (!FINAL_STATES.includes(state)) throw new Error(`finish: 終端状態ではない ${state}`);
    const r = this.q(`UPDATE targets SET state = ?, reason_code = ?, reason_text = ?, detail_json = ?, finished_at = ?, updated_at = ?,
        note_key = COALESCE(?, note_key), note_url = COALESCE(?, note_url)
      WHERE person_id = ? AND op_type = ? AND run_id = ? AND state IN ('reserved','sending')`)
      .run(state, reasonCode || null, reasonText || null, j(detail || null), nowIso, nowIso, noteKey || null, noteUrl || null, personId, opType, runId);
    return r.changes === 1;
  }

  /** reserved を candidate に戻す（sending は戻さない） */
  releaseReservation(personId, opType, runId, reason, nowIso) {
    const r = this.q(`UPDATE targets SET state = 'candidate', run_id = NULL, reserved_at = NULL, reserve_expires_at = NULL,
        detail_json = ?, updated_at = ?
      WHERE person_id = ? AND op_type = ? AND run_id = ? AND state = 'reserved'`)
      .run(j({ released: reason || null }), nowIso, personId, opType, runId);
    return r.changes === 1;
  }

  /**
   * 結果不明の対象を、サイト上の現在状態の照合結果で確定する（利用者の明示操作または実行器の照合のみ）。
   * siteState: 'done'（スキ済み／フォロー中）→ succeeded（再クリックしない） / 'not_done' → candidate（再試行可能） / 'unknown' → そのまま
   */
  resolveUnknown(personId, opType, siteState, evidence, nowIso) {
    if (siteState === 'liked') siteState = 'done';
    if (siteState === 'not_liked') siteState = 'not_done';
    return this.tx(() => {
      const row = this.getTarget(personId, opType);
      if (!row || row.state !== 'unknown') return { ok: false, code: row ? `state_${row.state}` : 'no_target' };
      if (siteState === 'done') {
        this.q(`UPDATE targets SET state = 'succeeded', reason_code = 'confirmed_by_state_check', reason_text = ?, detail_json = ?, finished_at = ?, updated_at = ?
          WHERE person_id = ? AND op_type = ?`)
          .run('サイト上の状態照合で実施済みを確認', j(evidence || null), nowIso, nowIso, personId, opType);
        return { ok: true, state: 'succeeded' };
      }
      if (siteState === 'not_done') {
        this.q(`UPDATE targets SET state = 'candidate', run_id = NULL, reserved_at = NULL, reserve_expires_at = NULL, sending_started_at = NULL,
            finished_at = NULL, reason_code = NULL, reason_text = NULL, detail_json = ?, updated_at = ?
          WHERE person_id = ? AND op_type = ?`)
          .run(j({ resolvedFromUnknown: evidence || null }), nowIso, personId, opType);
        return { ok: true, state: 'candidate' };
      }
      return { ok: false, code: 'still_unknown' };
    });
  }

  followState(personId) {
    const t = this.getTarget(personId, OP.FOLLOW_BACK);
    if (!t) return 'none';
    switch (t.state) {
      case 'succeeded': return 'followed';
      case 'unknown': return 'unknown';
      case 'sending': return 'sending';
      case 'reserved': return 'reserved';
      case 'failed_before_send': return 'failed';
      case 'blocked': return 'blocked';
      default: return 'none';
    }
  }

  likeState(personId) {
    const t = this.getTarget(personId, OP.LIKE);
    if (!t) return 'none';
    switch (t.state) {
      case 'succeeded': return 'liked';
      case 'unknown': return 'unknown';
      case 'sending': return 'sending';
      case 'reserved': return 'reserved';
      case 'failed_before_send': return 'failed';
      case 'blocked': return 'blocked';
      default: return 'none';
    }
  }

  targetsByState(opType) {
    const rows = opType
      ? this.q('SELECT * FROM targets WHERE op_type = ? ORDER BY updated_at').all(opType)
      : this.q('SELECT * FROM targets ORDER BY updated_at').all();
    const out = {};
    for (const s of STATES) out[s] = [];
    for (const r of rows) out[r.state].push(rowToTarget(r));
    return out;
  }

  listTargets({ opType, accountId, state } = {}) {
    const conds = [];
    const vals = [];
    if (opType) { conds.push('op_type = ?'); vals.push(opType); }
    if (accountId) { conds.push('account_id = ?'); vals.push(accountId); }
    if (state) { conds.push('state = ?'); vals.push(state); }
    const sql = `SELECT * FROM targets${conds.length ? ' WHERE ' + conds.join(' AND ') : ''} ORDER BY updated_at`;
    return this.q(sql).all(...vals).map(rowToTarget);
  }

  /**
   * 起動時の復旧。実行中でない run に属する sending は unknown（中断）、reserved は candidate に戻す。
   * 生存通知（heartbeat）が staleMs 以内の run は他プロセスで動いている可能性があるため触らない。
   */
  recoverOnStartup(nowIso, activeRunIds = [], { staleMs = 15 * 60 * 1000 } = {}) {
    return this.tx(() => {
      const active = new Set([...activeRunIds, ...this.liveRunIds(nowIso, staleMs)]);
      let sendingToUnknown = 0;
      let reservedReleased = 0;
      let runsInterrupted = 0;
      for (const row of this.q("SELECT * FROM targets WHERE state IN ('sending','reserved')").all()) {
        if (row.run_id && active.has(row.run_id)) continue;
        if (row.state === 'sending') {
          this.q(`UPDATE targets SET state = 'unknown', reason_code = 'interrupted_during_send', reason_text = ?, finished_at = ?, updated_at = ?
            WHERE person_id = ? AND op_type = ?`)
            .run('送信開始後に実行器が終了したため結果不明。自動再送しない', nowIso, nowIso, row.person_id, row.op_type);
          sendingToUnknown++;
        } else {
          this.q(`UPDATE targets SET state = 'candidate', run_id = NULL, reserved_at = NULL, reserve_expires_at = NULL, detail_json = ?, updated_at = ?
            WHERE person_id = ? AND op_type = ?`)
            .run(j({ released: 'restart' }), nowIso, row.person_id, row.op_type);
          reservedReleased++;
        }
      }
      for (const run of this.q("SELECT id FROM runs WHERE state IN ('running','paused')").all()) {
        if (active.has(run.id)) continue;
        this.q("UPDATE runs SET state = 'interrupted', finished_at = ?, stop_reason = COALESCE(stop_reason, 'process_restart') WHERE id = ?").run(nowIso, run.id);
        runsInterrupted++;
      }
      // 消滅したプロセスが残した実行ロックは解放する（holder は "accountId:runId"）
      let lockReleased = false;
      const lock = this.q('SELECT * FROM executor_lock WHERE id = 1').get();
      if (lock) {
        const runId = String(lock.holder).split(':').slice(1).join(':');
        if (!active.has(runId)) { this.q('DELETE FROM executor_lock WHERE id = 1').run(); lockReleased = true; }
      }
      return { sendingToUnknown, reservedReleased, runsInterrupted, lockReleased };
    });
  }

  // ----------------------------------------------------------------- attempts
  startAttempt({ personId, opType, accountId, runId, noteKey, consumed = false }, nowIso) {
    const r = this.q('INSERT INTO attempts(person_id, op_type, account_id, run_id, note_key, started_at, consumed) VALUES (?,?,?,?,?,?,?)')
      .run(personId, opType, accountId, runId || null, noteKey || null, nowIso, consumed ? 1 : 0);
    return Number(r.lastInsertRowid);
  }

  finishAttempt(id, result, detail, nowIso) {
    this.q('UPDATE attempts SET finished_at = ?, result = ?, detail_json = ? WHERE id = ?').run(nowIso, result, j(detail || null), id);
  }

  attemptStats(accountId, opType) {
    const conds = [];
    const vals = [];
    if (accountId) { conds.push('account_id = ?'); vals.push(accountId); }
    if (opType) { conds.push('op_type = ?'); vals.push(opType); }
    const rows = this.q(`SELECT result, COUNT(*) AS n FROM attempts${conds.length ? ' WHERE ' + conds.join(' AND ') : ''} GROUP BY result`).all(...vals);
    const out = { attempted: 0, succeeded: 0, unknown: 0, failed: 0, dry_run: 0 };
    for (const r of rows) {
      if (r.result === 'dry_run') { out.dry_run += r.n; continue; }
      out.attempted += r.n;
      if (r.result === 'succeeded') out.succeeded += r.n;
      else if (r.result === 'unknown') out.unknown += r.n;
      else out.failed += r.n;
    }
    return out;
  }

  // --------------------------------------------------------------------- runs
  createRun({ id, accountId, mode, dryRun }, nowIso) {
    this.q('INSERT INTO runs(id, account_id, mode, dry_run, started_at, state, heartbeat_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, accountId, mode, b(dryRun), nowIso, 'running', nowIso);
  }

  /** 実行中の run の生存通知（別プロセスの起動復旧に巻き込まれないため） */
  heartbeat(runId, nowIso) {
    this.q("UPDATE runs SET heartbeat_at = ? WHERE id = ? AND state IN ('running','paused')").run(nowIso, runId);
  }

  /** 生存通知が staleMs 以内の実行中 run（他プロセスで動いている可能性がある） */
  liveRunIds(nowIso, staleMs) {
    const threshold = new Date(parseDate(nowIso).getTime() - staleMs).toISOString();
    return this.q("SELECT id FROM runs WHERE state IN ('running','paused') AND heartbeat_at IS NOT NULL AND heartbeat_at >= ?").all(threshold).map((r) => r.id);
  }

  updateRun(id, patch) {
    const map = { state: 'state', finishedAt: 'finished_at', stopReason: 'stop_reason', summary: 'summary_json' };
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!map[k]) continue;
      sets.push(`${map[k]} = ?`);
      vals.push(k === 'summary' ? j(v) : (v === undefined ? null : v));
    }
    if (!sets.length) return;
    vals.push(id);
    this.q(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getRun(id) {
    const r = this.q('SELECT * FROM runs WHERE id = ?').get(id);
    return r ? { id: r.id, accountId: r.account_id, mode: r.mode, dryRun: !!r.dry_run, startedAt: r.started_at, finishedAt: r.finished_at, state: r.state, stopReason: r.stop_reason, summary: pj(r.summary_json), heartbeatAt: r.heartbeat_at } : null;
  }

  listRuns(limit = 20) {
    return this.q('SELECT id FROM runs ORDER BY started_at DESC LIMIT ?').all(limit).map((r) => this.getRun(r.id));
  }

  // -------------------------------------------------------------- collections
  recordCollection(rec) {
    this.q('INSERT INTO collections(mode, account_id, kind, seed_urls_json, stats_json, started_at, finished_at) VALUES (?,?,?,?,?,?,?)')
      .run(rec.mode, rec.accountId, rec.kind, j(rec.seedUrls || []), j(rec.stats || {}), rec.startedAt, rec.finishedAt || null);
  }

  hasCollected(mode, seedUrl) {
    const rows = this.q('SELECT seed_urls_json FROM collections WHERE mode = ?').all(mode);
    return rows.some((r) => (pj(r.seed_urls_json, []) || []).includes(seedUrl));
  }

  listCollections(limit = 20) {
    return this.q('SELECT * FROM collections ORDER BY id DESC LIMIT ?').all(limit)
      .map((r) => ({ id: r.id, mode: r.mode, accountId: r.account_id, kind: r.kind, seedUrls: pj(r.seed_urls_json, []), stats: pj(r.stats_json, {}), startedAt: r.started_at, finishedAt: r.finished_at }));
  }

  // -------------------------------------------------------------------- seeds
  listSeeds(mode) {
    const rows = mode ? this.q('SELECT * FROM seeds WHERE mode = ? ORDER BY created_at').all(mode) : this.q('SELECT * FROM seeds ORDER BY created_at').all();
    return rows.map(rowToSeed);
  }

  getSeed(id) { return rowToSeed(this.q('SELECT * FROM seeds WHERE id = ?').get(id)); }

  findSeed(mode, urlname) { return rowToSeed(this.q('SELECT * FROM seeds WHERE mode = ? AND urlname = ?').get(mode, urlname)); }

  insertSeed(seed) {
    this.q(`INSERT INTO seeds(id, mode, url, urlname, display_name, note, url_confirmed_by_spec, enabled, verified, verified_at, verification_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(seed.id, seed.mode, seed.url || null, seed.urlname || null, seed.displayName || '', seed.note || '', b(seed.urlConfirmedBySpec),
        b(seed.enabled !== false), b(seed.verified), seed.verifiedAt || null, j(seed.verification || null), seed.createdAt);
    return this.getSeed(seed.id);
  }

  updateSeed(id, patch) {
    const map = { url: 'url', urlname: 'urlname', displayName: 'display_name', note: 'note', enabled: 'enabled', verified: 'verified', verifiedAt: 'verified_at', verification: 'verification_json' };
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!map[k]) continue;
      sets.push(`${map[k]} = ?`);
      if (k === 'enabled' || k === 'verified') vals.push(b(v));
      else if (k === 'verification') vals.push(j(v));
      else vals.push(v === undefined ? null : v);
    }
    if (!sets.length) return this.getSeed(id);
    vals.push(id);
    this.q(`UPDATE seeds SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.getSeed(id);
  }

  deleteSeed(id) { return this.q('DELETE FROM seeds WHERE id = ?').run(id).changes === 1; }

  // ----------------------------------------------------------------- outcomes
  recordOutcome(personId, accountId, kind, evidence, nowIso) {
    const r = this.q('INSERT OR IGNORE INTO outcomes(person_id, account_id, kind, evidence_json, observed_at) VALUES (?,?,?,?,?)')
      .run(personId, accountId, kind, j(evidence || {}), nowIso);
    return r.changes === 1;
  }

  listOutcomes(accountId) {
    const rows = accountId ? this.q('SELECT * FROM outcomes WHERE account_id = ? ORDER BY id').all(accountId) : this.q('SELECT * FROM outcomes ORDER BY id').all();
    return rows.map((r) => ({ id: r.id, personId: r.person_id, accountId: r.account_id, kind: r.kind, evidence: pj(r.evidence_json), observedAt: r.observed_at }));
  }

  // --------------------------------------------------------------- exclusions
  addExclusion({ urlname, userId = null, reason = '' }, nowIso) {
    this.q('INSERT INTO exclusions(urlname, user_id, reason, added_at) VALUES (?,?,?,?) ON CONFLICT(urlname) DO UPDATE SET user_id = excluded.user_id, reason = excluded.reason')
      .run(urlname, userId == null ? null : String(userId), reason, nowIso);
  }

  removeExclusion(urlname) { return this.q('DELETE FROM exclusions WHERE urlname = ?').run(urlname).changes === 1; }

  listExclusions() {
    return this.q('SELECT * FROM exclusions ORDER BY added_at').all().map((r) => ({ urlname: r.urlname, userId: r.user_id, reason: r.reason, addedAt: r.added_at }));
  }

  isExcluded(person) {
    if (!person) return false;
    const byUrl = this.q('SELECT 1 FROM exclusions WHERE urlname = ?').get(person.urlname);
    if (byUrl) return true;
    if (person.userId != null) {
      const byId = this.q('SELECT 1 FROM exclusions WHERE user_id = ?').get(String(person.userId));
      if (byId) return true;
    }
    return false;
  }

  /** rules.evaluateCandidate に渡す名簿ビュー */
  rosterView() {
    return {
      isExcluded: (c) => this.isExcluded(c),
      likeState: (c) => (c && c.id != null ? this.likeState(c.id) : 'none'),
      followState: (c) => (c && c.id != null ? this.followState(c.id) : 'none'),
      assignedTo: (c) => (c && c.id != null ? this.assignedTo(c.id) : null),
    };
  }

  /** 候補ビュー（person + sources） */
  candidateView(personId) {
    const p = this.getPerson(personId);
    if (!p) return null;
    return { ...p, sources: this.sourcesOf(personId) };
  }

  // ----------------------------------------------------------------- settings
  getSetting(key, fallback = null) {
    const r = this.q('SELECT value_json FROM settings WHERE key = ?').get(key);
    return r ? pj(r.value_json, fallback) : fallback;
  }

  setSetting(key, value) {
    this.q('INSERT INTO settings(key, value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(key, j(value));
  }

  // ------------------------------------------------------------------- events
  logEvent({ level = 'info', code, message, accountId = null, runId = null, data = null }, nowIso) {
    this.q('INSERT INTO events(at, account_id, run_id, level, code, message, data_json) VALUES (?,?,?,?,?,?,?)')
      .run(nowIso, accountId, runId, level, code || 'event', message || '', j(data));
  }

  listEvents(limit = 50, runId) {
    const rows = runId
      ? this.q('SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?').all(runId, limit)
      : this.q('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ id: r.id, at: r.at, accountId: r.account_id, runId: r.run_id, level: r.level, code: r.code, message: r.message, data: pj(r.data_json) }));
  }

  // ------------------------------------------------------------ executor lock
  /** 3アカウントの外部操作を順番に実行するための単一ロック */
  acquireExecutorLock(holder, nowIso, ttlMs) {
    const expires = new Date(parseDate(nowIso).getTime() + ttlMs).toISOString();
    return this.tx(() => {
      const row = this.q('SELECT * FROM executor_lock WHERE id = 1').get();
      if (!row) {
        this.q('INSERT INTO executor_lock(id, holder, acquired_at, expires_at) VALUES (1,?,?,?)').run(holder, nowIso, expires);
        return { ok: true };
      }
      if (row.holder === holder || parseDate(row.expires_at) < parseDate(nowIso)) {
        this.q('UPDATE executor_lock SET holder = ?, acquired_at = ?, expires_at = ? WHERE id = 1').run(holder, nowIso, expires);
        return { ok: true, tookOverFrom: row.holder === holder ? null : row.holder };
      }
      return { ok: false, holder: row.holder, expiresAt: row.expires_at };
    });
  }

  renewExecutorLock(holder, nowIso, ttlMs) {
    const expires = new Date(parseDate(nowIso).getTime() + ttlMs).toISOString();
    return this.q('UPDATE executor_lock SET expires_at = ? WHERE id = 1 AND holder = ?').run(expires, holder).changes === 1;
  }

  releaseExecutorLock(holder) {
    return this.q('DELETE FROM executor_lock WHERE id = 1 AND holder = ?').run(holder).changes === 1;
  }

  executorLock() {
    const row = this.q('SELECT * FROM executor_lock WHERE id = 1').get();
    return row ? { holder: row.holder, acquiredAt: row.acquired_at, expiresAt: row.expires_at } : null;
  }

  // ------------------------------------------------------------------ summary
  /** 対象ごとの「なぜ選ばれたか」 */
  explain(personId) {
    const person = this.getPerson(personId);
    if (!person) return null;
    return {
      person,
      sources: this.sourcesOf(personId),
      evaluations: this.evaluationsOf(personId),
      modeFit: this.modeFitOf(personId),
      assignment: this.getAssignment(personId),
      targets: { like: this.getTarget(personId, OP.LIKE), follow_back: this.getTarget(personId, OP.FOLLOW_BACK) },
      attempts: this.q('SELECT * FROM attempts WHERE person_id = ? ORDER BY id').all(personId)
        .map((a) => ({ id: a.id, opType: a.op_type, accountId: a.account_id, runId: a.run_id, noteKey: a.note_key, startedAt: a.started_at, finishedAt: a.finished_at, result: a.result, consumed: !!a.consumed, detail: pj(a.detail_json) })),
      identityHistory: this.identityHistoryOf(personId),
      outcomes: this.q('SELECT * FROM outcomes WHERE person_id = ? ORDER BY id').all(personId)
        .map((r) => ({ accountId: r.account_id, kind: r.kind, evidence: pj(r.evidence_json), observedAt: r.observed_at })),
    };
  }
}

module.exports = { Ledger, STATES, FINAL_STATES, OP, rowToPerson, rowToSource, rowToTarget, rowToSeed };
