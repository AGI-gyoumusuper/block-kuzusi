'use strict';

/**
 * フォルダ2: 任意フォロー返し（教材外の追加機能。初期OFF）。
 *  - 候補: 操作するアカウントの「現在の」フォロワー一覧（過去の通知で推定しない）
 *  - 採用（実行直前に全条件）: 相手が現在こちらをフォロー／こちらは未フォロー／最新公開記事が14日未満／共通除外・owner・履歴・予約に合格
 *  - owner が別アカウントなら競合として表示し、返さない（自動移管禁止）。同 owner なら like と follow は別 action として各1回
 *  - follow 用の上限は like から流用しない。未設定のままでは開始不可
 */

const { evaluateFollowBack } = require('./rules');
const { OP } = require('./ledger');
const { Runner } = require('./runner');
const { refreshPerson } = require('./collect');
const { blockFromError } = require('./limits');

async function sleep(ms) { if (ms > 0) await new Promise((r) => setTimeout(r, ms)); }

async function collectFollowBack({ adapter, ledger, accounts, account, config, clock, log = () => {}, limits = null }) {
  const now = clock.now();
  const nowIso = now.toISOString();
  const ownUrlnames = accounts.map((a) => a.urlname);
  const stats = {
    mode: 'follow_back', accountId: account.id, startedAt: nowIso,
    listedTotal: 0, newPersons: 0, knownPersons: 0, duplicateWithinRun: 0, duplicatesExcluded: 0, newSources: 0,
    profileFetched: 0, profileFetchFailed: 0, relationshipFetched: 0, relationshipFailed: 0,
    adoptable: 0, held: 0, rejected: 0, ownerConflicts: 0, activityFailed: 0, alreadyFollowing: 0, notFollowingMe: 0, unverified: 0, ownAccounts: 0,
    newlyAssigned: 0, executable: 0, followersComplete: null,
  };
  let fol;
  try {
    fol = await adapter.getFollowers(account.urlname, { limit: config.followersLimit, accountId: account.id });
  } catch (e) {
    ledger.logEvent({ level: 'warn', code: 'followers_unavailable', message: `フォロワー一覧を取得できない: ${e.message}`, accountId: account.id }, nowIso);
    return { stopped: true, code: 'followers_unavailable', message: `フォロワー一覧を取得できない: ${e.message}`, stats: null };
  }
  stats.followersComplete = !!fol.complete;
  stats.listedTotal = fol.followers.length;

  const seen = new Map();
  fol.followers.forEach((f, i) => {
    const r = ledger.upsertPerson(f, {
      mode: 'follow_back', listType: 'my_followers', seedUrl: account.url, seedUrlname: account.urlname, seedNoteUrl: null, seedNoteKey: null, seedVerified: true,
      reactionAt: null, reactionEvidence: null, orderEvidence: null, listPosition: i,
    }, nowIso);
    if (seen.has(r.person.id)) { stats.duplicateWithinRun++; return; }
    seen.set(r.person.id, r);
    if (r.isNew) stats.newPersons++; else stats.knownPersons++;
    if (r.sourceIsNew) stats.newSources++;
  });
  stats.duplicatesExcluded = stats.duplicateWithinRun + stats.knownPersons;

  const roster = ledger.rosterView();
  for (const personId of seen.keys()) {
    const p0 = ledger.getPerson(personId);
    let relationship = null;
    if (!ownUrlnames.includes(p0.urlname)) {
      try {
        const r = await refreshPerson({ adapter, ledger, personId, config, nowIso, accountId: account.id });
        if (r.ok) stats.profileFetched++; else stats.profileFetchFailed++;
      } catch (e) {
        stats.profileFetchFailed++;
        ledger.updateProfile(personId, { lastFetchedAt: nowIso, lastFetchError: e.message, latestNote: { note: null, code: 'fetch_error', message: `取得失敗: ${e.message}` } });
        const blk = blockFromError(e);
        if (blk) {
          if (limits) limits.setExternalBlock(account.id, { ...blk, source: 'collect_follow_back' }, clock.now().toISOString());
          ledger.logEvent({ level: 'error', code: `blocked_${blk.kind}`, message: `収集中に外部要因で停止: ${e.message}`, accountId: account.id }, clock.now().toISOString());
          return { stopped: true, code: `blocked_${blk.kind}`, message: `収集を停止: ${blk.message}`, stats };
        }
      }
      try {
        relationship = await adapter.getRelationship(p0.urlname, { accountId: account.id });
        if (relationship) { relationship.checkedAt = nowIso; stats.relationshipFetched++; } else stats.relationshipFailed++;
      } catch (e) {
        stats.relationshipFailed++;
        relationship = null;
      }
      await sleep(config.requestIntervalMs || 0);
    }
    const cand = ledger.candidateView(personId);
    const ev = evaluateFollowBack(cand, { now, config, ownUrlnames, accountId: account.id, roster, relationship });
    const codes = new Set(ev.reasons.map((r) => r.code));
    if (ev.verdict === 'adopt') stats.adoptable++; else if (ev.verdict === 'hold') stats.held++; else stats.rejected++;
    if (codes.has('owner_conflict')) {
      stats.ownerConflicts++;
      ledger.recordAssignmentConflict(personId, { kind: 'follow_back', requestedBy: account.id, owner: ledger.assignedTo(personId), at: nowIso, message: '相手がこのアカウントをフォローしているが owner は別アカウント。自動移管しない' });
    }
    if (['inactive', 'date_unknown', 'future_date', 'no_notes', 'notes_incomplete', 'latest_not_fetched'].some((c) => codes.has(c))) stats.activityFailed++;
    if (codes.has('already_following')) stats.alreadyFollowing++;
    if (codes.has('not_following_me')) stats.notFollowingMe++;
    if (codes.has('relationship_unverified') || codes.has('follows_me_unverified') || codes.has('my_follow_unverified') || codes.has('user_id_unknown')) stats.unverified++;
    if (codes.has('own_account')) stats.ownAccounts++;

    let assignedTo = ledger.assignedTo(personId);
    if (ev.verdict === 'adopt' && !assignedTo) {
      // フォロー返しは相手がフォローしているアカウントだけが適合するため、このアカウントを owner にする（共通仕様の担当確定）
      const r = ledger.assignBalanced(personId, [account.id], { mode: 'follow_back', reason: 'collect_follow_back', at: nowIso }, nowIso);
      if (r.created) stats.newlyAssigned++;
      assignedTo = r.accountId;
    }
    ledger.setEvaluation(personId, 'follow_back', account.id, ev, nowIso);
    if (ev.verdict === 'adopt' && assignedTo === account.id) {
      const t = ledger.ensureCandidate(personId, OP.FOLLOW_BACK, { accountId: account.id, mode: 'follow_back', reopen: true }, nowIso);
      if (t.state === 'candidate') stats.executable++;
    }
  }
  stats.finishedAt = clock.now().toISOString();
  ledger.recordCollection({ mode: 'follow_back', accountId: account.id, kind: ledger.hasCollected('follow_back', account.url) ? 'update' : 'initial', seedUrls: [account.url], stats, startedAt: nowIso, finishedAt: stats.finishedAt });
  ledger.logEvent({ level: 'info', code: 'collect_follow_back_done', message: `フォロー返し候補の収集完了: フォロワー ${stats.listedTotal}、採用可 ${stats.adoptable}、競合 ${stats.ownerConflicts}、未確認 ${stats.unverified}、実行可能 ${stats.executable}`, accountId: account.id, data: stats }, stats.finishedAt);
  return { stopped: false, stats };
}

function planFollowTargets(ledger, accountId) {
  const targets = ledger.listTargets({ opType: OP.FOLLOW_BACK, accountId, state: 'candidate' });
  const items = [];
  for (const t of targets) {
    const ev = ledger.getEvaluation(t.personId, 'follow_back', accountId);
    if (!ev || ev.verdict !== 'adopt') continue;
    items.push({ target: t, person: ledger.getPerson(t.personId), evaluation: ev });
  }
  items.sort((a, b) => (a.person.firstSeenAt || '').localeCompare(b.person.firstSeenAt || ''));
  return items;
}

class FollowRunner extends Runner {
  constructor(opts) { super({ ...opts, opType: OP.FOLLOW_BACK }); }

  async _preflightExtra() {
    if (!this.config.followBack || !this.config.followBack.enabled) {
      return { ok: false, code: 'follow_back_disabled', message: 'フォロー返しは初期OFF。ONにするまでは候補の確認だけを行う' };
    }
    return null;
  }

  _plan(account) { return planFollowTargets(this.ledger, account.id); }

  async _processReserved({ account, dryRun, runId, personId, ownUrlnames, roster }) {
    const s = this.summary;
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const person = this.ledger.getPerson(personId);

    // 1) 本人の再確認と最新記事
    let creator = null;
    try { creator = await this.adapter.getCreator(person.urlname, { accountId: account.id }); } catch (e) {
      return this._adapterError(e, personId, runId, account, 'profile_unavailable', `${person.urlname}: プロフィール取得失敗`);
    }
    if (!creator || creator.urlname !== person.urlname) return this._skip(personId, runId, 'identity_mismatch', `${person.urlname}: 本人情報が一致しない`);
    if (person.userId && creator.userId && String(creator.userId) !== String(person.userId)) return this._skip(personId, runId, 'user_id_mismatch', `${person.urlname}: userId が一致しない`);
    try {
      const r = await refreshPerson({ adapter: this.adapter, ledger: this.ledger, personId, config: this.config, nowIso, accountId: account.id });
      if (!r.ok) return this._skip(personId, runId, `recheck_${r.code}`, `${person.urlname}: 本人情報の再取得で不一致（${r.code}）`);
    } catch (e) {
      return this._adapterError(e, personId, runId, account, 'notes_unavailable', `${person.urlname}: 記事一覧取得失敗`);
    }

    // 2) 現在の関係（通知ではなく現在の状態）
    let relationship = null;
    try { relationship = await this.adapter.getRelationship(person.urlname, { accountId: account.id }); } catch (e) {
      return this._adapterError(e, personId, runId, account, 'relationship_unavailable', `${person.urlname}: 関係の取得失敗`);
    }
    if (relationship) relationship.checkedAt = nowIso;

    // 3) 全条件の再評価（owner・履歴・除外・14日・関係）
    const cand = this.ledger.candidateView(personId);
    const ev = evaluateFollowBack(cand, { now, config: this.config, ownUrlnames, accountId: account.id, relationship, roster: {
      ...roster,
      followState: (c) => { const st = roster.followState(c); return st === 'reserved' ? 'none' : st; },
    } });
    this.ledger.setEvaluation(personId, 'follow_back', account.id, ev, nowIso);
    if (ev.verdict !== 'adopt') {
      const first = ev.reasons.find((r) => r.level !== 'info') || { code: 'not_adopt', message: '条件不一致' };
      return this._skip(personId, runId, `recheck_${first.code}`, `${person.urlname}: 実行直前の再確認で条件不一致（${first.message}）`, { reasons: ev.reasons });
    }

    // 4) ドライランはここまで
    if (dryRun) {
      s.dryRunWouldAct++;
      const attemptId = this.ledger.startAttempt({ personId, opType: this.opType, accountId: account.id, runId, consumed: false }, this._nowIso());
      this.ledger.finishAttempt(attemptId, 'dry_run', { message: 'ドライラン。実フォローは送らない' }, this._nowIso());
      this.ledger.releaseReservation(personId, this.opType, runId, 'dry_run', this._nowIso());
      this._event('info', 'dry_run', `ドライラン: ${person.urlname} へフォロー返し可能（送信なし）`);
      return { kind: 'dry_run' };
    }

    // 5) 送信開始（枠を消費）→ 結果確認
    const attemptId = this._beginSend({ personId, runId, account });
    if (attemptId == null) return this._skip(personId, runId, 'sending_transition_failed', `${person.urlname}: 送信開始への遷移に失敗`);
    let res;
    try {
      res = await this.adapter.follow(person.urlname, { accountId: account.id });
    } catch (e) {
      res = { result: 'unknown', clicked: true, code: 'exception', message: `送信中に例外: ${e.message}` };
    }
    if (res.result === 'succeeded' && res.code === 'already_following') s.alreadyDone++;
    return this._settle({ personId, runId, account, attemptId, res, successLog: `${person.urlname}: フォロー返しの成功を確認` });
  }

  async _siteState(t, account) {
    const person = this.ledger.getPerson(t.personId);
    try {
      const rel = await this.adapter.getRelationship(person.urlname, { accountId: account.id });
      if (!rel) return 'unknown';
      if (rel.iFollowTarget === true) return 'done';
      if (rel.iFollowTarget === false) return 'not_done';
    } catch (_) { /* unknown */ }
    return 'unknown';
  }
}

module.exports = { collectFollowBack, planFollowTargets, FollowRunner };
