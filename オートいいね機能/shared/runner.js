'use strict';

/**
 * 実行器（基底）。候補 → 予約＋引当（原子的）→ 実行直前の再確認 → 送信開始（枠消費）→ 結果確認。
 *
 * - 実アクションは config.enableRealActions が true かつ dryRun=false のときだけ
 * - 3アカウントの外部操作は既定で順番に（executor_lock）
 * - 予約は limits.reserveWithCredit で、有効残数（引当込み）の確認と対象の予約を一つのトランザクションで行う
 * - 送信開始（markSending）と枠の消費（consume）も一つのトランザクションで行う
 * - 送信開始後に結果を確認できなければ unknown。自動再送しない。既定では unknown が出た時点で実行を止める
 * - 外部制限（429・制限表示）・認証切れ・権限不明は別状態のブロックにして止める。内部回復では解除しない
 * - 対象不足は件数未達で終了。無作為補充・条件緩和・再割当はしない
 *
 * like 用の実装は本ファイルの Runner、follow_back 用は shared/follow.js の FollowRunner（継承）。
 */

const crypto = require('node:crypto');
const { chooseLatestNote, evaluateCandidate, isKnownCount } = require('./rules');
const { OP } = require('./ledger');
const { verifyAccountSession } = require('./accounts');
const { checkModeAvailability } = require('./collect');
const { blockFromError } = require('./limits');
const { parseDate } = require('./clock');

function defaultSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const STOP_CODES = new Set(['blocked_external_limit', 'blocked_auth', 'blocked_permission_unknown', 'limits_unset', 'limits_invalid', 'internal_exhausted', 'daily_exhausted', 'hourly_exhausted']);

/** 実行予定（like）。この担当・このモードで採用済みの候補。最近の反応者を優先する */
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
    const hasOrderEvidence = !!(reaction && reaction.status === 'order_only');
    // 一覧上の位置は、取得元が新しい順と明示している場合にだけ優先順の根拠にする（取得順を最新順と決めつけない）
    const ordered = sources.filter((s) => s.orderEvidence && s.listPosition != null);
    const pos = hasOrderEvidence && ordered.length ? Math.min(...ordered.map((s) => s.listPosition)) : null;
    items.push({ target: t, person, evaluation: ev, reactionAt, hasOrderEvidence, pos });
  }
  items.sort((a, b) => {
    if (a.reactionAt && b.reactionAt) return b.reactionAt - a.reactionAt;
    if (a.reactionAt) return -1;
    if (b.reactionAt) return 1;
    if (a.hasOrderEvidence !== b.hasOrderEvidence) return a.hasOrderEvidence ? -1 : 1;
    if (a.pos != null && b.pos != null && a.pos !== b.pos) return a.pos - b.pos;
    const f = (a.person.firstSeenAt || '').localeCompare(b.person.firstSeenAt || '');
    return f !== 0 ? f : a.person.id - b.person.id;
  });
  return items;
}

class Runner {
  constructor({ ledger, limits, adapter, clock, config, accounts, log = () => {}, sleep = defaultSleep, opType = OP.LIKE }) {
    this.ledger = ledger;
    this.limits = limits;
    this.adapter = adapter;
    this.clock = clock;
    this.config = config;
    this.accounts = accounts;
    this.log = log;
    this.sleep = sleep;
    this.opType = opType;
    this._state = 'idle';
    this._paused = false;
    this._stop = false;
    this.current = null;
    this.summary = null;
    this.waitReason = null;
    this.lastRun = null;
  }

  status() {
    return { opType: this.opType, state: this._state, paused: this._paused, current: this.current, summary: this.summary, waitReason: this.waitReason, lastRun: this.lastRun };
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
    // 一時停止中も生存通知と実行ロックを更新し、他の実行器に奪われない
    let n = 0;
    while (this._paused && !this._stop) {
      await this.sleep(100);
      if (++n % 50 === 0) this._keepAlive();
    }
  }

  _keepAlive() {
    if (!this.current) return;
    const nowIso = this._nowIso();
    this.ledger.heartbeat(this.current.runId, nowIso);
    if (this.config.sequentialAcrossAccounts !== false) this.ledger.renewExecutorLock(this.current.holder, nowIso, this.config.executorLockTtlMs);
  }

  /** 派生クラスが追加の前提確認を行う（開始できない理由を返す。問題なければ null） */
  async _preflightExtra({ account, mode }) {
    if (this.opType !== OP.LIKE) return null;
    const avail = await checkModeAvailability({ adapter: this.adapter, account, mode });
    if (!avail.available) return { ok: false, code: avail.code, message: avail.message };
    return null;
  }

  /** 実行予定の列挙（派生クラスで差し替え） */
  _plan(account, mode) { return planTargets(this.ledger, account.id, mode); }

  /** 実行前の前提確認（開始できない理由を返す） */
  async preflight({ account, mode, dryRun }) {
    if (!dryRun && !this.config.enableRealActions) {
      return { ok: false, code: 'real_actions_disabled', message: '実アクションは初期OFF。設定 enableRealActions を明示的に true にし、ドライランを外した場合のみ送信する' };
    }
    if (!dryRun && !this.adapter.capabilities.realActions) {
      return { ok: false, code: 'adapter_cannot_act', message: `アダプタ ${this.adapter.name} は実アクションを行えない` };
    }
    const extra = await this._preflightExtra({ account, mode, dryRun });
    if (extra) return extra;
    const session = await verifyAccountSession(this.adapter, account);
    if (!session.ok) return { ok: false, code: session.code, message: session.message, session };
    const lim = this.limits.canExecute(account.id, this.opType, this.clock.now());
    if (!lim.ok && lim.code !== 'interval') return { ok: false, code: lim.code, message: lim.message, limits: lim.status };
    return { ok: true, session, limits: lim.status };
  }

  async start({ accountId, mode, dryRun = true, maxCount = null }) {
    if (this._state === 'running' || this._state === 'paused' || this._state === 'stopping') {
      return { started: false, code: 'already_running', message: '実行中です' };
    }
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return { started: false, code: 'unknown_account', message: `不明なアカウント ${accountId}` };
    if (this.opType === OP.LIKE && mode !== 'suki' && mode !== 'follower') return { started: false, code: 'unknown_mode', message: `不明なモード ${mode}` };
    if (this.opType !== OP.LIKE) mode = this.opType;

    const pre = await this.preflight({ account, mode, dryRun });
    if (!pre.ok) {
      this.ledger.logEvent({ level: 'warn', code: pre.code, message: `開始拒否（${this.opType}）: ${pre.message}`, accountId }, this._nowIso());
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
    this.current = { runId, accountId, mode, opType: this.opType, dryRun, startedAt: this._nowIso(), holder, currentTarget: null };
    this.summary = {
      planned: maxCount, considered: 0, processed: 0, succeeded: 0, alreadyDone: 0, unknown: 0, failedBeforeSend: 0, skipped: 0, blocked: 0,
      dryRunWouldAct: 0, reservationLost: 0, skippedReasons: [], shortfall: null, stopReason: null,
    };
    this.ledger.createRun({ id: runId, accountId, mode, dryRun }, this.current.startedAt);
    this._event('info', 'run_start', `実行開始 ${dryRun ? '（ドライラン: 実送信なし）' : '（実送信）'} account=${account.name} action=${this.opType} mode=${mode}`);

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
      const plan = this._plan(account, mode);
      s.considered = plan.length;
      if (plan.length === 0) this._event('info', 'no_targets', '実行可能な対象がない（対象不足）。件数未達のまま終了し、補充はしない');
      for (const item of plan) {
        await this._waitWhilePaused();
        if (this._stop) { stopReason = 'stopped_by_user'; break; }
        if (maxCount != null && s.processed >= maxCount) { stopReason = 'planned_count_reached'; break; }
        this._keepAlive();

        const personId = item.target.personId;
        const person0 = item.person;
        this.current.currentTarget = { personId, urlname: person0.urlname, displayName: person0.displayName };

        // 予約＋引当（原子的）。有効残数（引当込み）が無ければ予約しない
        let rsv = this.limits.reserveWithCredit(this.ledger, { personId, opType: this.opType, accountId: account.id, runId }, this.clock.now(), this.config.reserveTtlMs);
        if (!rsv.ok && rsv.code === 'interval') {
          this.waitReason = `最小間隔待ち ${Math.ceil(rsv.waitMs / 1000)} 秒`;
          await this.sleep(rsv.waitMs);
          this.waitReason = null;
          rsv = this.limits.reserveWithCredit(this.ledger, { personId, opType: this.opType, accountId: account.id, runId }, this.clock.now(), this.config.reserveTtlMs);
        }
        if (!rsv.ok) {
          if (STOP_CODES.has(rsv.code)) {
            stopReason = rsv.code;
            this._event('warn', rsv.code, `停止: ${rsv.message}`);
            break;
          }
          s.reservationLost++;
          this._event('info', 'reserve_failed', `予約できず見送り ${person0.urlname}: ${rsv.code}`);
          continue;
        }
        s.processed++;

        let outcome;
        try {
          outcome = await this._processReserved({ account, mode, dryRun, runId, personId, ownUrlnames, roster });
        } catch (e) {
          // 送信前の未捕捉例外: 予約を解放して見送る（sending に入っていれば unknown のまま残す）
          const t = this.ledger.getTarget(personId, this.opType);
          if (t && t.state === 'reserved' && t.runId === runId) {
            outcome = this._skip(personId, runId, 'unexpected_error', `${person0.urlname}: 処理中に例外（送信前）: ${e.message}`);
          } else if (t && t.state === 'sending' && t.runId === runId) {
            this.ledger.finish(personId, this.opType, runId, { state: 'unknown', reasonCode: 'exception_during_send', reasonText: `送信中に例外: ${e.message}` }, this._nowIso());
            s.unknown++;
            outcome = { kind: 'unknown' };
          } else {
            throw e;
          }
        } finally {
          if (typeof this.adapter.release === 'function') await this.adapter.release(account.id).catch(() => {});
        }
        if (outcome.kind === 'blocked') { stopReason = `blocked_${outcome.blockKind}`; break; }
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
      if (maxCount != null) s.shortfall = Math.max(0, maxCount - (dryRun ? s.dryRunWouldAct : s.succeeded));
      s.stopReason = stopReason;
      const finishedAt = this._nowIso();
      this.ledger.updateRun(runId, { state: 'finished', finishedAt, stopReason, summary: s });
      if (this.config.sequentialAcrossAccounts !== false) this.ledger.releaseExecutorLock(holder);
      this._event('info', 'run_end', `実行終了: 理由=${stopReason} 成功=${s.succeeded} 結果不明=${s.unknown} 見送り=${s.skipped} 送信前失敗=${s.failedBeforeSend}` + (dryRun ? ` ドライラン対象=${s.dryRunWouldAct}` : '') + (s.shortfall != null ? ` 未達=${s.shortfall}` : ''));
      this.lastRun = { runId, accountId: account.id, mode, opType: this.opType, dryRun, startedAt: this.current.startedAt, finishedAt, stopReason, summary: s };
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
    this.ledger.finish(personId, this.opType, runId, { state: 'skipped', reasonCode: code, reasonText: text, detail }, this._nowIso());
    this._event('info', 'skip', `見送り (${code}): ${text}`, { personId });
    return { kind: 'skipped', code };
  }

  /** 外部制限・認証切れ・権限不明: 対象を blocked にし、アカウントのブロック状態を立て、実行を止める */
  _blocked(personId, runId, account, { kind, code, message, source, noteKey = null, noteUrl = null }) {
    const s = this.summary;
    s.blocked++;
    const nowIso = this._nowIso();
    this.ledger.finish(personId, this.opType, runId, { state: 'blocked', reasonCode: code, reasonText: message, detail: { kind, source }, noteKey, noteUrl }, nowIso);
    this.limits.setExternalBlock(account.id, { kind, code, message, source }, nowIso);
    const label = { external_limit: '外部制限', auth: '認証切れ・認証要求', permission_unknown: '権限不明（403）' }[kind] || kind;
    this._event('error', `blocked_${kind}`, `${label}: ${message}。実行を止める（内部残数より優先。20分の内部回復では再開しない）`);
    return { kind: 'blocked', blockKind: kind };
  }

  /** アダプタ例外の振り分け。外部要因ならブロック、それ以外は見送り */
  _adapterError(e, personId, runId, account, skipCode, text, extra = {}) {
    const b = blockFromError(e);
    if (b) return this._blocked(personId, runId, account, { ...b, source: skipCode, ...extra });
    return this._skip(personId, runId, skipCode, `${text}: ${e.message}`);
  }

  /** 送信開始と枠の消費を一つのトランザクションで行い、試行IDを返す */
  _beginSend({ personId, runId, account, noteKey = null, noteUrl = null }) {
    const now = this.clock.now();
    return this.ledger.tx(() => {
      if (!this.ledger.markSending(personId, this.opType, runId, { noteKey, noteUrl }, now.toISOString())) return null;
      this.limits.consume(account.id, this.opType, now, { personId, runId });
      return this.ledger.startAttempt({ personId, opType: this.opType, accountId: account.id, runId, noteKey, consumed: true }, now.toISOString());
    });
  }

  /** 送信結果の確定（succeeded / blocked / failed_before_send / unknown） */
  _settle({ personId, runId, account, attemptId, res, noteKey = null, noteUrl = null, successLog }) {
    const s = this.summary;
    const finishedAt = this._nowIso();
    if (res.result === 'succeeded') {
      s.succeeded++;
      this.ledger.finishAttempt(attemptId, 'succeeded', res, finishedAt);
      this.ledger.finish(personId, this.opType, runId, { state: 'succeeded', reasonCode: res.code, reasonText: res.message, detail: res, noteKey, noteUrl }, finishedAt);
      this._event('info', 'succeeded', successLog);
      return { kind: 'succeeded' };
    }
    if (res.result === 'blocked') {
      this.ledger.finishAttempt(attemptId, 'blocked', res, finishedAt);
      const b = blockFromError({ code: res.code, message: res.message }) || { kind: 'external_limit', code: res.code, message: res.message };
      return this._blocked(personId, runId, account, { ...b, source: this.opType, noteKey, noteUrl });
    }
    if (res.result === 'failed' && res.clicked === false) {
      s.failedBeforeSend++;
      this.ledger.finishAttempt(attemptId, 'failed_before_send', res, finishedAt);
      this.ledger.finish(personId, this.opType, runId, { state: 'failed_before_send', reasonCode: res.code, reasonText: res.message, detail: res, noteKey, noteUrl }, finishedAt);
      this._event('warn', 'failed_before_send', `送信前に失敗 (${res.message})`, { personId });
      return { kind: 'failed_before_send' };
    }
    s.unknown++;
    this.ledger.finishAttempt(attemptId, 'unknown', res, finishedAt);
    this.ledger.finish(personId, this.opType, runId, { state: 'unknown', reasonCode: res.code || 'unknown', reasonText: res.message || '結果不明', detail: res, noteKey, noteUrl }, finishedAt);
    this._event('warn', 'unknown', `結果不明 (${res.message})。枠は消費したまま保持し、自動再送しない`, { personId });
    return { kind: 'unknown' };
  }

  // ------------------------------------------------------------- like の実装
  async _processReserved({ account, mode, dryRun, runId, personId, ownUrlnames, roster }) {
    const s = this.summary;
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const person = this.ledger.getPerson(personId);

    // 1) 本人の再確認
    let creator = null;
    try { creator = await this.adapter.getCreator(person.urlname, { accountId: account.id }); } catch (e) {
      return this._adapterError(e, personId, runId, account, 'profile_unavailable', `${person.urlname}: プロフィール取得失敗`);
    }
    if (!creator || creator.urlname !== person.urlname) return this._skip(personId, runId, 'identity_mismatch', `${person.urlname}: 本人情報が一致しない`);
    if (person.userId && creator.userId && String(creator.userId) !== String(person.userId)) return this._skip(personId, runId, 'user_id_mismatch', `${person.urlname}: userId が一致しない`);

    // 2) 最新記事の再確認（公開日時で確定）と条件の再評価
    let notesRes = null;
    try { notesRes = await this.adapter.getCreatorNotes(person.urlname, { limit: this.config.candidateNotesLimit, accountId: account.id }); } catch (e) {
      return this._adapterError(e, personId, runId, account, 'notes_unavailable', `${person.urlname}: 記事一覧取得失敗`);
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
      return this._adapterError(e, personId, runId, account, 'note_unavailable', `${person.urlname}: 記事取得失敗`);
    }
    if (!note) return this._skip(personId, runId, 'note_unavailable', `${person.urlname}: 記事 ${noteKey} を取得できない`);
    if (note.authorUrlname && note.authorUrlname !== person.urlname) return this._skip(personId, runId, 'author_mismatch', `${person.urlname}: 記事の著者が本人でない`);
    const noteUrl = note.url || latest.note.url;

    // 4) 記事を開き、本文を末尾まで表示し、既スキ状態を確認
    const page = await this.adapter.openAndReadNote(noteUrl, { accountId: account.id });
    if (page.blocked) {
      const b = blockFromError({ code: page.blocked.code, message: page.blocked.message }) || { kind: 'external_limit', code: page.blocked.code, message: page.blocked.message };
      return this._blocked(personId, runId, account, { ...b, source: 'open_note', noteKey, noteUrl });
    }
    if (!page.bodyRendered) return this._skip(personId, runId, 'body_not_rendered', `${person.urlname}: 記事本文を表示できない`, { finalUrl: page.finalUrl });
    // 開いたページから記事ID・著者を確認できない場合は保留（確認に必要な部分へアクセスできない）
    if (!page.noteKey || !page.authorUrlname) return this._skip(personId, runId, 'page_identity_unverified', `${person.urlname}: 開いたページから記事ID・著者を確認できないため保留`, { finalUrl: page.finalUrl });
    if (page.noteKey !== noteKey) return this._skip(personId, runId, 'note_key_mismatch', `${person.urlname}: 開いた記事ID(${page.noteKey})が最新記事(${noteKey})と異なる`);
    if (page.authorUrlname !== person.urlname) return this._skip(personId, runId, 'page_author_mismatch', `${person.urlname}: 開いたページの著者が本人でない`);

    let likeState = 'unknown';
    if (note.isLikedByMe === true || page.likeState === 'liked') likeState = 'liked';
    else if (page.likeState === 'not_liked' || note.isLikedByMe === false) likeState = 'not_liked';
    if (likeState === 'liked') {
      s.alreadyDone++;
      this.ledger.finish(personId, this.opType, runId, { state: 'succeeded', reasonCode: 'already_liked_on_site', reasonText: 'サイト上で既にスキ済み（再クリックしない）', noteKey, noteUrl }, this._nowIso());
      this._event('info', 'already_liked', `${person.urlname}: 既にスキ済みのため実施しない`);
      return { kind: 'succeeded', alreadyDone: true };
    }
    if (likeState === 'unknown') return this._skip(personId, runId, 'like_state_unknown', `${person.urlname}: 既スキ状態を確認できないため保留`);

    // 5) ドライランはここまで（予約を戻し、候補のまま残す。枠は消費しない）
    if (dryRun) {
      s.dryRunWouldAct++;
      const attemptId = this.ledger.startAttempt({ personId, opType: this.opType, accountId: account.id, runId, noteKey, consumed: false }, this._nowIso());
      this.ledger.finishAttempt(attemptId, 'dry_run', { noteUrl, message: 'ドライラン。実スキは送らない' }, this._nowIso());
      this.ledger.releaseReservation(personId, this.opType, runId, 'dry_run', this._nowIso());
      this._event('info', 'dry_run', `ドライラン: ${person.urlname} の最新記事 ${noteUrl} へスキ可能（送信なし）`);
      return { kind: 'dry_run' };
    }

    // 6) 送信開始（枠を消費）→ 結果確認
    const attemptId = this._beginSend({ personId, runId, account, noteKey, noteUrl });
    if (attemptId == null) return this._skip(personId, runId, 'sending_transition_failed', `${person.urlname}: 送信開始への遷移に失敗`);
    let res;
    try {
      res = await this.adapter.like(noteKey, { accountId: account.id, noteUrl });
    } catch (e) {
      res = { result: 'unknown', clicked: true, code: 'exception', message: `送信中に例外: ${e.message}` };
    }
    return this._settle({ personId, runId, account, attemptId, res, noteKey, noteUrl, successLog: `${person.urlname}: スキ成功を確認 (${noteUrl})` });
  }

  /**
   * 結果不明の対象を、サイト上の現在状態を実際に照合して確定する（利用者の明示操作で呼ぶ）。
   */
  async resolveUnknownByCheck({ personId, accountId }) {
    const t = this.ledger.getTarget(personId, this.opType);
    if (!t || t.state !== 'unknown') return { ok: false, code: t ? `state_${t.state}` : 'no_target' };
    // 照合は送信したアカウント（owner）のセッションでのみ行う
    if (accountId && accountId !== t.accountId) return { ok: false, code: 'account_mismatch', message: `照合は送信したアカウント（${t.accountId}）で行う` };
    const account = this.accounts.find((a) => a.id === t.accountId);
    if (!account) return { ok: false, code: 'unknown_account' };
    const session = await verifyAccountSession(this.adapter, account);
    if (!session.ok) return { ok: false, code: session.code, message: session.message };
    const siteState = await this._siteState(t, account);
    const r = this.ledger.resolveUnknown(personId, this.opType, siteState, { checkedAt: this._nowIso(), siteState, by: account.id }, this._nowIso());
    this.ledger.logEvent({ level: 'info', code: 'resolve_unknown', message: `状態照合（${this.opType}）: ${siteState} → ${r.state || r.code}`, accountId: account.id, data: { personId } }, this._nowIso());
    return { ...r, siteState };
  }

  /** like: 記事ページ／記事詳細から既スキ状態を読む → 'done' | 'not_done' | 'unknown' */
  async _siteState(t, account) {
    if (!t.noteUrl) return 'unknown';
    const page = await this.adapter.openAndReadNote(t.noteUrl, { accountId: account.id });
    if (typeof this.adapter.release === 'function') await this.adapter.release(account.id).catch(() => {});
    let st = page.likeState === 'liked' ? 'done' : page.likeState === 'not_liked' ? 'not_done' : 'unknown';
    if (st === 'unknown' && t.noteKey) {
      try { const n = await this.adapter.getNote(t.noteKey, { accountId: account.id }); if (n && n.isLikedByMe === true) st = 'done'; else if (n && n.isLikedByMe === false) st = 'not_done'; } catch (_) { /* unknown のまま */ }
    }
    return st;
  }
}

module.exports = { Runner, planTargets, STOP_CODES };
