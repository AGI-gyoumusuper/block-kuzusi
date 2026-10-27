'use strict';

/**
 * 実行器。候補 → 予約（原子的）→ 実行直前の再確認 → 送信開始 → 結果確認。
 *
 * - 実アクションは config.enableRealActions が true かつ dryRun=false のときだけ
 * - 3アカウントの外部操作は既定で順番に（executor_lock）
 * - 送信開始後に結果を確認できなければ unknown。自動再送しない。既定では unknown が出た時点で実行を止める
 * - 外部制限（ロック・認証要求）に遭遇したら blocked にして止める。内部残数より優先
 * - 対象不足は件数未達で終了。無作為補充・条件緩和・再割当はしない
 */

const crypto = require('node:crypto');
const { chooseLatestNote, evaluateCandidate, isKnownCount } = require('./rules');
const { OP } = require('./ledger');
const { verifyAccountSession } = require('./accounts');
const { checkModeAvailability } = require('./collect');
const { parseDate } = require('./clock');

function defaultSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 実行予定（この口座・このモードで採用済みの候補）。最近の反応者を優先する */
function planTargets(ledger, accountId, mode) {
  const targets = ledger.listTargets({ opType: OP.LIKE, accountId, state: 'candidate' });
  const items = [];
  for (const t of targets) {
    const ev = ledger.getEvaluation(t.personId, mode, accountId);
    if (!ev || ev.verdict !== 'adopt') continue;
    const person = ledger.getPerson(t.personId);
    const sources = ledger.sourcesOf(t.personId).filter((s) => s.listType === (mode === 'suki' ? 'note_likes' : 'followers'));
    const reaction = ev.checks && ev.checks.reaction ? ev.checks.reaction : null;
    const reactionAt = reaction && reaction.reactionAt ? parseDate(reaction.reactionAt) : null;
    const pos = sources.length ? Math.min(...sources.map((s) => (s.listPosition == null ? 1e9 : s.listPosition))) : 1e9;
    items.push({ target: t, person, evaluation: ev, reactionAt, hasOrderEvidence: !!(reaction && reaction.status === 'order_only'), pos });
  }
  items.sort((a, b) => {
    if (a.reactionAt && b.reactionAt) return b.reactionAt - a.reactionAt;
    if (a.reactionAt) return -1;
    if (b.reactionAt) return 1;
    if (a.hasOrderEvidence !== b.hasOrderEvidence) return a.hasOrderEvidence ? -1 : 1;
    if (a.pos !== b.pos) return a.pos - b.pos;
    return (a.person.firstSeenAt || '').localeCompare(b.person.firstSeenAt || '');
  });
  return items;
}

class Runner {
  constructor({ ledger, limits, adapter, clock, config, accounts, log = () => {}, sleep = defaultSleep }) {
    this.ledger = ledger;
    this.limits = limits;
    this.adapter = adapter;
    this.clock = clock;
    this.config = config;
    this.accounts = accounts;
    this.log = log;
    this.sleep = sleep;
    this._state = 'idle';
    this._paused = false;
    this._stop = false;
    this.current = null;
    this.summary = null;
    this.waitReason = null;
    this.lastRun = null;
  }

  status() {
    return {
      state: this._state,
      paused: this._paused,
      current: this.current,
      summary: this.summary,
      waitReason: this.waitReason,
      lastRun: this.lastRun,
    };
  }

  pause() { if (this._state === 'running') { this._paused = true; this._state = 'paused'; return true; } return false; }
  resume() { if (this._state === 'paused') { this._paused = false; this._state = 'running'; return true; } return false; }
  stop() { if (this._state === 'running' || this._state === 'paused') { this._stop = true; this._paused = false; this._state = 'stopping'; return true; } return false; }

  _nowIso() { return this.clock.now().toISOString(); }

  _event(level, code, message, data) {
    const nowIso = this._nowIso();
    const runId = this.current ? this.current.runId : null;
    const accountId = this.current ? this.current.accountId : null;
    this.ledger.logEvent({ level, code, message, accountId, runId, data }, nowIso);
    this.log(`[${level}] ${message}`);
  }

  async _waitWhilePaused() {
    while (this._paused && !this._stop) await this.sleep(100);
  }

  /** 実行前の前提確認（開始できない理由を返す） */
  async preflight({ account, mode, dryRun }) {
    if (!dryRun && !this.config.enableRealActions) {
      return { ok: false, code: 'real_actions_disabled', message: '実アクションは初期OFF。設定 enableRealActions を明示的に true にし、ドライランを外した場合のみ送信する' };
    }
    if (!dryRun && !this.adapter.capabilities.realActions) {
      return { ok: false, code: 'adapter_cannot_act', message: `アダプタ ${this.adapter.name} は実アクションを行えない` };
    }
    const session = await verifyAccountSession(this.adapter, account);
    if (!session.ok) return { ok: false, code: session.code, message: session.message, session };
    const avail = await checkModeAvailability({ adapter: this.adapter, account, mode });
    if (!avail.available) return { ok: false, code: avail.code, message: avail.message };
    const lim = this.limits.canExecute(account.id, this.clock.now());
    if (!lim.ok && lim.code !== 'interval') return { ok: false, code: lim.code, message: lim.message, limits: lim.status };
    return { ok: true, session, limits: lim.status };
  }

  async start({ accountId, mode, dryRun = true, maxCount = null }) {
    if (this._state === 'running' || this._state === 'paused' || this._state === 'stopping') {
      return { started: false, code: 'already_running', message: '実行中です' };
    }
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return { started: false, code: 'unknown_account', message: `不明なアカウント ${accountId}` };
    if (mode !== 'suki' && mode !== 'follower') return { started: false, code: 'unknown_mode', message: `不明なモード ${mode}` };

    const pre = await this.preflight({ account, mode, dryRun });
    if (!pre.ok) {
      this.ledger.logEvent({ level: 'warn', code: pre.code, message: `開始拒否: ${pre.message}`, accountId }, this._nowIso());
      return { started: false, code: pre.code, message: pre.message };
    }

    const runId = `run_${this._nowIso().replace(/[^0-9]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
    const holder = `${accountId}:${runId}`;
    if (this.config.sequentialAcrossAccounts !== false) {
      const lock = this.ledger.acquireExecutorLock(holder, this._nowIso(), this.config.executorLockTtlMs);
      if (!lock.ok) {
        return { started: false, code: 'executor_busy', message: `他の実行器（${lock.holder}）が外部操作中。順番に実行する既定のため待機` };
      }
    }

    this._state = 'running';
    this._paused = false;
    this._stop = false;
    this.waitReason = null;
    this.current = { runId, accountId, mode, dryRun, startedAt: this._nowIso(), holder, currentTarget: null };
    this.summary = {
      planned: maxCount, considered: 0, processed: 0, succeeded: 0, alreadyLiked: 0, unknown: 0, failedBeforeSend: 0, skipped: 0, blocked: 0,
      dryRunWouldLike: 0, reservationLost: 0, skippedReasons: [], shortfall: null, stopReason: null,
    };
    this.ledger.createRun({ id: runId, accountId, mode, dryRun }, this.current.startedAt);
    this._event('info', 'run_start', `実行開始 ${dryRun ? '（ドライラン: 実スキなし）' : '（実送信）'} account=${account.name} mode=${mode}`);

    // 呼び出し直後の pause() を反映させるために一度譲る
    await this.sleep(0);
    const promise = this._loop({ account, mode, dryRun, maxCount, runId, holder });
    return { started: true, runId, promise };
  }

  async _loop({ account, mode, dryRun, maxCount, runId, holder }) {
    const s = this.summary;
    const ownUrlnames = this.accounts.map((a) => a.urlname);
    const roster = this.ledger.rosterView();
    let stopReason = null;
    try {
      const plan = planTargets(this.ledger, account.id, mode);
      s.considered = plan.length;
      if (plan.length === 0) {
        this._event('info', 'no_targets', '実行可能な対象がない（対象不足）。件数未達のまま終了し、補充はしない');
      }
      for (const item of plan) {
        await this._waitWhilePaused();
        if (this._stop) { stopReason = 'stopped_by_user'; break; }
        if (maxCount != null && s.processed >= maxCount) { stopReason = 'planned_count_reached'; break; }
        if (this.config.sequentialAcrossAccounts !== false) this.ledger.renewExecutorLock(holder, this._nowIso(), this.config.executorLockTtlMs);

        const now = this.clock.now();
        let lim = this.limits.canExecute(account.id, now);
        if (!lim.ok && lim.code === 'interval') {
          this.waitReason = `最小間隔待ち ${Math.ceil(lim.waitMs / 1000)} 秒`;
          await this.sleep(lim.waitMs);
          this.waitReason = null;
          lim = this.limits.canExecute(account.id, this.clock.now());
        }
        if (!lim.ok) {
          stopReason = lim.code;
          this._event('warn', lim.code, `停止: ${lim.message}`);
          break;
        }

        const personId = item.target.personId;
        const person0 = item.person;
        this.current.currentTarget = { personId, urlname: person0.urlname, displayName: person0.displayName };

        const rsv = this.ledger.reserve(personId, OP.LIKE, account.id, runId, this._nowIso(), this.config.reserveTtlMs);
        if (!rsv.ok) {
          s.reservationLost++;
          this._event('info', 'reserve_failed', `予約できず見送り ${person0.urlname}: ${rsv.code}`);
          continue;
        }
        s.processed++;

        let outcome;
        try {
          outcome = await this._processReserved({ account, mode, dryRun, runId, personId, ownUrlnames, roster });
        } finally {
          // 開いた記事ページを必ず閉じる（タブを残さない）
          if (typeof this.adapter.release === 'function') await this.adapter.release(account.id).catch(() => {});
        }
        if (outcome.kind === 'blocked') {
          stopReason = 'external_block';
          break;
        }
        if (outcome.kind === 'unknown' && this.config.stopOnUnknown !== false) {
          stopReason = 'unknown_result';
          this._event('warn', 'stop_on_unknown', '結果不明が発生したため実行を止める（自動再送しない。状態照合で確定してから再開）');
          break;
        }
        if (!dryRun && outcome.kind === 'succeeded' && this.config.betweenLikesMs > 0) {
          this.waitReason = `次の対象まで待機 ${Math.ceil(this.config.betweenLikesMs / 1000)} 秒`;
          await this.sleep(this.config.betweenLikesMs);
          this.waitReason = null;
        }
      }
      if (!stopReason) stopReason = s.processed === 0 && s.considered === 0 ? 'no_targets' : 'completed';
    } catch (e) {
      stopReason = 'error';
      this._event('error', 'run_error', `実行器で例外: ${e.message}`, { stack: e.stack });
    } finally {
      if (maxCount != null) s.shortfall = Math.max(0, maxCount - (dryRun ? s.dryRunWouldLike : s.succeeded));
      s.stopReason = stopReason;
      const finishedAt = this._nowIso();
      this.ledger.updateRun(runId, { state: 'finished', finishedAt, stopReason, summary: s });
      if (this.config.sequentialAcrossAccounts !== false) this.ledger.releaseExecutorLock(holder);
      this._event('info', 'run_end', `実行終了: 理由=${stopReason} 成功=${s.succeeded} 結果不明=${s.unknown} 見送り=${s.skipped} 送信前失敗=${s.failedBeforeSend}` + (dryRun ? ` ドライラン対象=${s.dryRunWouldLike}` : '') + (s.shortfall != null ? ` 未達=${s.shortfall}` : ''));
      this.lastRun = { runId, accountId: account.id, mode, dryRun, startedAt: this.current.startedAt, finishedAt, stopReason, summary: s };
      this._state = 'idle';
      this._paused = false;
      this._stop = false;
      this.current = null;
      this.waitReason = null;
    }
    return this.lastRun;
  }

  _skip(personId, runId, code, text, detail) {
    const s = this.summary;
    s.skipped++;
    s.skippedReasons.push({ personId, code, text });
    this.ledger.finish(personId, OP.LIKE, runId, { state: 'skipped', reasonCode: code, reasonText: text, detail }, this._nowIso());
    this._event('info', 'skip', `見送り (${code}): ${text}`, { personId });
    return { kind: 'skipped', code };
  }

  async _processReserved({ account, mode, dryRun, runId, personId, ownUrlnames, roster }) {
    const s = this.summary;
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const person = this.ledger.getPerson(personId);

    // 1) 本人の再確認
    let creator = null;
    try { creator = await this.adapter.getCreator(person.urlname); } catch (e) {
      return this._skip(personId, runId, 'profile_unavailable', `${person.urlname}: プロフィール取得失敗 ${e.message}`);
    }
    if (!creator || creator.urlname !== person.urlname) return this._skip(personId, runId, 'identity_mismatch', `${person.urlname}: 本人情報が一致しない`);
    if (person.userId && creator.userId && String(creator.userId) !== String(person.userId)) return this._skip(personId, runId, 'user_id_mismatch', `${person.urlname}: userId が一致しない`);

    // 2) 最新記事の再確認（公開日時で確定）と条件の再評価
    let notesRes = null;
    try { notesRes = await this.adapter.getCreatorNotes(person.urlname, { limit: this.config.candidateNotesLimit }); } catch (e) {
      return this._skip(personId, runId, 'notes_unavailable', `${person.urlname}: 記事一覧取得失敗 ${e.message}`);
    }
    const latest = chooseLatestNote(notesRes);
    this.ledger.updateProfile(personId, {
      followingCount: isKnownCount(creator.followingCount) ? creator.followingCount : null,
      followerCount: isKnownCount(creator.followerCount) ? creator.followerCount : null,
      countsRaw: creator.countsRaw || null,
      latestNote: latest, notesFetchedAt: nowIso, lastFetchedAt: nowIso, lastFetchError: null, identityConfirmed: true,
    });
    const cand = this.ledger.candidateView(personId);
    const ev = evaluateCandidate(cand, { mode, now, config: this.config, ownUrlnames, accountId: account.id, roster: {
      ...roster,
      // 自分の予約は進行中扱いにしない
      likeState: (c) => { const st = roster.likeState(c); return st === 'reserved' ? 'none' : st; },
    } });
    this.ledger.setEvaluation(personId, mode, account.id, ev, nowIso);
    if (ev.verdict !== 'adopt') {
      const first = ev.reasons.find((r) => r.level !== 'info') || { code: 'not_adopt', message: '条件不一致' };
      return this._skip(personId, runId, `recheck_${first.code}`, `${person.urlname}: 実行直前の再確認で条件不一致（${first.message}）`, { reasons: ev.reasons });
    }
    const noteKey = latest.note.key;

    // 3) 対象記事の確認（記事ID・本人・既スキ）
    let note = null;
    try { note = await this.adapter.getNote(noteKey, { accountId: account.id }); } catch (e) {
      return this._skip(personId, runId, 'note_unavailable', `${person.urlname}: 記事取得失敗 ${e.message}`);
    }
    if (!note) return this._skip(personId, runId, 'note_unavailable', `${person.urlname}: 記事 ${noteKey} を取得できない`);
    if (note.authorUrlname && note.authorUrlname !== person.urlname) return this._skip(personId, runId, 'author_mismatch', `${person.urlname}: 記事の著者が本人でない`);
    const noteUrl = note.url || latest.note.url;

    // 4) 記事を開き、本文を末尾まで表示し、既スキ状態を確認
    const page = await this.adapter.openAndReadNote(noteUrl, { accountId: account.id });
    if (page.blocked) {
      s.blocked++;
      this.ledger.finish(personId, OP.LIKE, runId, { state: 'blocked', reasonCode: page.blocked.code, reasonText: page.blocked.message, noteKey, noteUrl }, this._nowIso());
      this.limits.setExternalBlock(account.id, { code: page.blocked.code, message: page.blocked.message, source: 'open_note' }, this._nowIso());
      this._event('error', 'external_block', `外部制限: ${page.blocked.message}。実行を止める（内部残数より優先）`);
      return { kind: 'blocked' };
    }
    if (!page.bodyRendered) return this._skip(personId, runId, 'body_not_rendered', `${person.urlname}: 記事本文を表示できない`, { finalUrl: page.finalUrl });
    if (page.noteKey && page.noteKey !== noteKey) return this._skip(personId, runId, 'note_key_mismatch', `${person.urlname}: 開いた記事ID(${page.noteKey})が最新記事(${noteKey})と異なる`);
    if (page.authorUrlname && page.authorUrlname !== person.urlname) return this._skip(personId, runId, 'page_author_mismatch', `${person.urlname}: 開いたページの著者が本人でない`);

    let likeState = 'unknown';
    if (note.isLikedByMe === true || page.likeState === 'liked') likeState = 'liked';
    else if (page.likeState === 'not_liked' || note.isLikedByMe === false) likeState = 'not_liked';
    if (likeState === 'liked') {
      s.alreadyLiked++;
      this.ledger.finish(personId, OP.LIKE, runId, { state: 'succeeded', reasonCode: 'already_liked_on_site', reasonText: 'サイト上で既にスキ済み（再クリックしない）', noteKey, noteUrl }, this._nowIso());
      this._event('info', 'already_liked', `${person.urlname}: 既にスキ済みのため実施しない`);
      return { kind: 'succeeded', alreadyLiked: true };
    }
    if (likeState === 'unknown') return this._skip(personId, runId, 'like_state_unknown', `${person.urlname}: 既スキ状態を確認できないため保留`);

    // 5) ドライランはここまで（予約を戻し、候補のまま残す）
    if (dryRun) {
      s.dryRunWouldLike++;
      const attemptId = this.ledger.startAttempt({ personId, opType: OP.LIKE, accountId: account.id, runId, noteKey }, this._nowIso());
      this.ledger.finishAttempt(attemptId, 'dry_run', { noteUrl, message: 'ドライラン。実スキは送らない' }, this._nowIso());
      this.ledger.releaseReservation(personId, OP.LIKE, runId, 'dry_run', this._nowIso());
      this._event('info', 'dry_run', `ドライラン: ${person.urlname} の最新記事 ${noteUrl} へスキ可能（送信なし）`);
      return { kind: 'dry_run' };
    }

    // 6) 送信開始（枠を消費）→ 結果確認
    if (!this.ledger.markSending(personId, OP.LIKE, runId, { noteKey, noteUrl }, this._nowIso())) {
      return this._skip(personId, runId, 'sending_transition_failed', `${person.urlname}: 送信開始への遷移に失敗`);
    }
    this.limits.consume(account.id, this.clock.now(), { opType: OP.LIKE, personId, runId });
    const attemptId = this.ledger.startAttempt({ personId, opType: OP.LIKE, accountId: account.id, runId, noteKey }, this._nowIso());
    let res;
    try {
      res = await this.adapter.like(noteKey, { accountId: account.id, noteUrl });
    } catch (e) {
      res = { result: 'unknown', clicked: true, code: 'exception', message: `送信中に例外: ${e.message}` };
    }
    const finishedAt = this._nowIso();
    if (res.result === 'succeeded') {
      s.succeeded++;
      this.ledger.finishAttempt(attemptId, 'succeeded', res, finishedAt);
      this.ledger.finish(personId, OP.LIKE, runId, { state: 'succeeded', reasonCode: res.code, reasonText: res.message, detail: res, noteKey, noteUrl }, finishedAt);
      this._event('info', 'succeeded', `${person.urlname}: スキ成功を確認 (${noteUrl})`);
      return { kind: 'succeeded' };
    }
    if (res.result === 'blocked') {
      s.blocked++;
      this.ledger.finishAttempt(attemptId, 'blocked', res, finishedAt);
      this.ledger.finish(personId, OP.LIKE, runId, { state: 'blocked', reasonCode: res.code, reasonText: res.message, detail: res, noteKey, noteUrl }, finishedAt);
      this.limits.setExternalBlock(account.id, { code: res.code, message: res.message, source: 'like' }, finishedAt);
      this._event('error', 'external_block', `外部制限: ${res.message}。実行を止める（内部残数より優先）`);
      return { kind: 'blocked' };
    }
    if (res.result === 'failed' && res.clicked === false) {
      s.failedBeforeSend++;
      this.ledger.finishAttempt(attemptId, 'failed_before_send', res, finishedAt);
      this.ledger.finish(personId, OP.LIKE, runId, { state: 'failed_before_send', reasonCode: res.code, reasonText: res.message, detail: res, noteKey, noteUrl }, finishedAt);
      this._event('warn', 'failed_before_send', `${person.urlname}: 送信前に失敗 (${res.message})`);
      return { kind: 'failed_before_send' };
    }
    s.unknown++;
    this.ledger.finishAttempt(attemptId, 'unknown', res, finishedAt);
    this.ledger.finish(personId, OP.LIKE, runId, { state: 'unknown', reasonCode: res.code || 'unknown', reasonText: res.message || '結果不明', detail: res, noteKey, noteUrl }, finishedAt);
    this._event('warn', 'unknown', `${person.urlname}: 結果不明 (${res.message})。自動再送しない`);
    return { kind: 'unknown' };
  }

  /**
   * 結果不明の対象を、サイト上の現在状態を実際に照合して確定する（利用者の明示操作で呼ぶ）。
   */
  async resolveUnknownByCheck({ personId, accountId }) {
    const t = this.ledger.getTarget(personId, OP.LIKE);
    if (!t || t.state !== 'unknown') return { ok: false, code: t ? `state_${t.state}` : 'no_target' };
    const account = this.accounts.find((a) => a.id === (accountId || t.accountId));
    if (!account) return { ok: false, code: 'unknown_account' };
    const session = await verifyAccountSession(this.adapter, account);
    if (!session.ok) return { ok: false, code: session.code, message: session.message };
    const noteUrl = t.noteUrl;
    if (!noteUrl) return { ok: false, code: 'no_note_url' };
    const page = await this.adapter.openAndReadNote(noteUrl, { accountId: account.id });
    let siteState = page.likeState;
    if (siteState === 'unknown' && t.noteKey) {
      try { const n = await this.adapter.getNote(t.noteKey, { accountId: account.id }); if (n && n.isLikedByMe === true) siteState = 'liked'; else if (n && n.isLikedByMe === false) siteState = 'not_liked'; } catch (_) { /* unknown のまま */ }
    }
    const r = this.ledger.resolveUnknown(personId, OP.LIKE, siteState, { checkedAt: this._nowIso(), noteUrl, siteState, by: account.id }, this._nowIso());
    this.ledger.logEvent({ level: 'info', code: 'resolve_unknown', message: `状態照合: ${siteState} → ${r.state || r.code}`, accountId: account.id, data: { personId } }, this._nowIso());
    return { ...r, siteState };
  }
}

module.exports = { Runner, planTargets };
