'use strict';

/**
 * フォルダ2（任意フォロー返し・内部credits回復）のアプリ層。共通層（shared）を束ねる。
 * 台帳・実行管理・アカウント定義はフォルダ1と同じ共有DBを使う（独立した履歴を作らない）。
 */

const path = require('node:path');
const { openDb } = require('../../../shared/db');
const { Ledger, OP, STATES } = require('../../../shared/ledger');
const { Limits, OP_TYPES } = require('../../../shared/limits');
const { normalizeAccount, verifyAccountSession } = require('../../../shared/accounts');
const { loadConfig, KIND } = require('../../../shared/config');
const { createAdapter } = require('../../../shared/adapters');
const { collectFollowBack, planFollowTargets, FollowRunner } = require('../../../shared/follow');
const { exportAll } = require('../../../shared/export');
const { systemClock } = require('../../../shared/clock');

const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

const CRITERIA2 = [
  { id: 'F-1', text: '機能は初期OFF。ONにするまでは候補の確認だけを行う', source: 'フォルダ2要件 §1', kind: KIND.USER },
  { id: 'F-2', text: '採用（実行直前に全条件）: 対象者が操作アカウントを現在フォローしている', source: 'フォルダ2要件 §1', kind: KIND.USER },
  { id: 'F-3', text: '採用: 操作アカウントは対象者をまだフォローしていない', source: 'フォルダ2要件 §1', kind: KIND.USER },
  { id: 'F-4', text: '採用: 最新公開記事が14日未満（ちょうど14日・記事なし・取得失敗・日時不明・未来は不採用）', source: 'フォルダ2要件 §1（利用者追加の共通活動条件）', kind: KIND.USER },
  { id: 'F-5', text: '採用: 共通の除外条件、owner・履歴・予約の確認に合格。過去のフォロー通知で現在の関係を推定しない。確認できない候補は理由付きで保留', source: 'フォルダ2要件 §1', kind: KIND.USER },
  { id: 'F-6', text: '安定した userId と target owner を使う。既存 owner が別アカウントなら競合扱い（自動移管禁止）。同 owner なら like と follow は別 action として各1回', source: 'フォルダ2要件 §1 / 親文書 §4', kind: KIND.USER },
  { id: 'F-7', text: 'follow の上限は like から流用しない。初期状態では日次・直近1時間の上限を未設定とし、明示設定されるまで開始不可', source: 'フォルダ2要件 §1', kind: KIND.USER },
  { id: 'R-1', text: '「残数0なら20分後に+1」は内部 credits の規則。note 公式の制限や外部ロック解除時間ではない', source: 'フォルダ2要件 §2', kind: KIND.USER },
  { id: 'R-2', text: '回復間隔は既定20分・設定可能。容量上限も設定。未設定・0以下では開始しない', source: 'フォルダ2要件 §2', kind: KIND.USER },
  { id: 'R-3', text: '残数と上限はアカウント×action種別。2モードは同じ like 枠。follow は別枠', source: 'フォルダ2要件 §2', kind: KIND.USER },
  { id: 'R-4', text: '正→0 で empty_since / last_refill を設定。残数0の間の画面更新・再起動で起点を更新しない。引当込みの残数で計算し二重予約しない', source: 'フォルダ2要件 §2', kind: KIND.USER },
  { id: 'R-5', text: '整数区間ぶん加算し容量で打ち切り、処理した区間ぶん last_refill を進め、繰り越さない。一つのトランザクションで更新。再起動・二重起動・時計巻き戻りで余分に回復しない', source: 'フォルダ2要件 §2', kind: KIND.USER },
  { id: 'R-6', text: '有効残数 = min(内部, 日次(JST), 時間(直近60分))。内部が1に戻っても他が0なら実行しない。モード変更・再起動で利用件数をリセットしない', source: 'フォルダ2要件 §2', kind: KIND.USER },
  { id: 'R-7', text: '20分で1件は24時間で72件分。毎日200件と同一視しない。日次切替で満タンに戻さず繰り越す', source: 'フォルダ2要件 §2', kind: KIND.USER },
  { id: 'R-8', text: 'like の 200件/日・50件/時は教材の参考値。公式上限・安全値ではなく「200件まで安全」と表現しない', source: 'フォルダ2要件 §2 / 親文書 §6', kind: KIND.REFERENCE },
  { id: 'S-1', text: '送信前に共有予約を原子的に取得し、owner・履歴・全残数を再確認。候補選定だけでは枠を確保しない', source: 'フォルダ2要件 §3', kind: KIND.USER },
  { id: 'S-2', text: '送信済み結果不明は残数を使用したまま保持し、タイムアウト・予約期限切れ・再起動で再送しない。照合で解決するまで追加操作を止める', source: 'フォルダ2要件 §3', kind: KIND.USER },
  { id: 'X-1', text: '外部制限・認証切れ・結果不明・内部不足を別状態で管理。429/制限表示は外部制限、403は不明なら停止。内部回復では解除せず20分経過で再開しない', source: 'フォルダ2要件 §4', kind: KIND.USER },
];

class App2 {
  constructor({ rootDir = ROOT_DIR, adapterKind = 'mock', overrides = {}, clock = systemClock(), dbPath = null, worldFile = null, log = () => {}, adapter = null, recover = true } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.log = log;
    this.recover = recover;
    // モックは実運用の共有DBを汚さないよう、明示指定が無ければ別ファイルを使う
    const effectiveKind = adapter ? adapter.name : adapterKind;
    const mockDb = effectiveKind === 'mock' && !dbPath && !overrides.dbPath ? path.join(rootDir, 'data', 'mock-state.sqlite3') : null;
    this.config = loadConfig({ rootDir, overrides: { ...overrides, dbPath: dbPath || overrides.dbPath || mockDb } });
    this.accounts = this.config.accounts.map(normalizeAccount);
    this.db = openDb(this.config.dbPath);
    this.ledger = new Ledger(this.db);
    this.limits = new Limits(this.db, { tzOffsetMinutes: this.config.limits.tzOffsetMinutes, minIntervalMs: this.config.limits.minIntervalMs, onEvent: (ev, nowIso) => this.ledger.logEvent(ev, nowIso) });
    this.adapterKind = adapter ? adapter.name : adapterKind;
    this.adapter = adapter || createAdapter({ kind: adapterKind, config: this.config, accounts: this.accounts, clock, log, worldFile });
    this.runner = new FollowRunner({ ledger: this.ledger, limits: this.limits, adapter: this.adapter, clock, config: this.config, accounts: this.accounts, log });
    this.startup = this._startup();
  }

  _nowIso() { return this.clock.now().toISOString(); }

  _startup() {
    const nowIso = this._nowIso();
    // 復旧は実行器を持つプロセスだけが行う。生存通知のある他プロセスの run には触らない
    const recovered = this.recover ? this.ledger.recoverOnStartup(nowIso, [], { staleMs: this.config.executorLockTtlMs }) : { sendingToUnknown: 0, reservedReleased: 0, runsInterrupted: 0, skipped: true };
    const limitsInitialized = [];
    for (const a of this.accounts) {
      for (const op of OP_TYPES) {
        const pool = this.config.limits.pools[op] || {};
        const labels = this.config.limits.labels[op] || {};
        const note = Object.entries(labels).map(([k, v]) => `${k}: ${v}`).join('; ');
        if (this.limits.ensureConfigured(a.id, op, { ...pool, labels, note }, nowIso)) limitsInitialized.push(`${a.id}/${op}`);
      }
    }
    if (this.ledger.getSetting('enableRealActions') === null) this.ledger.setSetting('enableRealActions', !!this.config.enableRealActions);
    if (this.ledger.getSetting('followBackEnabled') === null) this.ledger.setSetting('followBackEnabled', !!(this.config.followBack && this.config.followBack.enabled));
    if (this.ledger.getSetting('selectedAccountId') === null) this.ledger.setSetting('selectedAccountId', this.accounts[0] ? this.accounts[0].id : null);
    this._applyPersistedConfig();
    this.ledger.logEvent({ level: 'info', code: 'startup2', message: `起動（フォルダ2, adapter=${this.adapterKind}）復旧: sending→unknown ${recovered.sendingToUnknown}、予約解放 ${recovered.reservedReleased}`, data: { recovered, limitsInitialized } }, nowIso);
    return { recovered, limitsInitialized };
  }

  _applyPersistedConfig() {
    this.config.enableRealActions = !!this.ledger.getSetting('enableRealActions', false);
    this.config.followBack = { ...(this.config.followBack || {}), enabled: !!this.ledger.getSetting('followBackEnabled', false) };
  }

  get selectedAccountId() { return this.ledger.getSetting('selectedAccountId'); }
  get account() { return this.accounts.find((a) => a.id === this.selectedAccountId) || this.accounts[0]; }

  selectAccount(id) {
    if (!this.accounts.find((a) => a.id === id)) throw new Error(`不明なアカウント: ${id}`);
    this.ledger.setSetting('selectedAccountId', id);
    return id;
  }

  setConfig(patch) {
    const applied = {};
    if (patch.followBackEnabled !== undefined) { this.ledger.setSetting('followBackEnabled', !!patch.followBackEnabled); applied.followBackEnabled = !!patch.followBackEnabled; }
    if (patch.enableRealActions !== undefined) { this.ledger.setSetting('enableRealActions', !!patch.enableRealActions); applied.enableRealActions = !!patch.enableRealActions; }
    if (patch.stopOnUnknown !== undefined) { this.config.stopOnUnknown = !!patch.stopOnUnknown; applied.stopOnUnknown = !!patch.stopOnUnknown; }
    this._applyPersistedConfig();
    this.ledger.logEvent({ level: 'info', code: 'config_change2', message: `設定変更 ${JSON.stringify(applied)}` }, this._nowIso());
    return applied;
  }

  async collect({ accountId } = {}) {
    const account = accountId ? this.accounts.find((a) => a.id === accountId) : this.account;
    return collectFollowBack({ adapter: this.adapter, ledger: this.ledger, accounts: this.accounts, account, config: this.config, clock: this.clock, log: this.log, limits: this.limits });
  }

  plan({ accountId } = {}) {
    const a = accountId || this.account.id;
    return planFollowTargets(this.ledger, a).map((it) => ({
      personId: it.person.id, urlname: it.person.urlname, userId: it.person.userId, displayName: it.person.displayName, profileUrl: it.person.profileUrl,
      latestNotePublishedAt: it.person.latestNote && it.person.latestNote.note ? it.person.latestNote.note.publishedAt : null,
      relationship: it.evaluation.checks && it.evaluation.checks.relationship ? it.evaluation.checks.relationship : null,
      reasons: it.evaluation.reasons,
    }));
  }

  async startRun({ dryRun = true, maxCount = null, accountId } = {}) {
    const a = accountId || this.account.id;
    const r = await this.runner.start({ accountId: a, mode: 'follow_back', dryRun: dryRun !== false, maxCount: maxCount == null || maxCount === '' ? null : Number(maxCount) });
    if (r.started) { this._runPromise = r.promise; r.promise.catch((e) => this.log(`run error: ${e.message}`)); }
    const { promise, ...rest } = r;
    return rest;
  }

  async waitRun() { if (this._runPromise) await this._runPromise; }
  pause() { return this.runner.pause(); }
  resume() { return this.runner.resume(); }
  stop() { return this.runner.stop(); }
  async resolveUnknown(personId, accountId) { return this.runner.resolveUnknownByCheck({ personId: Number(personId), accountId }); }
  export() { return exportAll({ ledger: this.ledger, accounts: this.accounts, exportDir: this.config.exportDir, clock: this.clock }); }
  explain(personId) { return this.ledger.explain(Number(personId)); }

  async verifySession(accountId) {
    const account = accountId ? this.accounts.find((a) => a.id === accountId) : this.account;
    return verifyAccountSession(this.adapter, account);
  }

  setLimits(accountId, opType, values) {
    const nowIso = this._nowIso();
    const num = (v) => (v === undefined ? undefined : (v === null || v === '' ? null : Number(v)));
    const patch = { dailyLimit: num(values.dailyLimit), hourlyLimit: num(values.hourlyLimit), capacity: num(values.capacity), credits: num(values.credits), recoveryIntervalMin: num(values.recoveryIntervalMin), recoveryAmount: num(values.recoveryAmount) };
    const labels = { ...(this.limits.status(accountId, opType, this.clock.now()).labels || {}) };
    for (const k of Object.keys(patch)) if (patch[k] !== undefined) labels[k] = `利用者が画面から設定（${nowIso}）`;
    const r = this.limits.configure(accountId, opType, { ...patch, labels, note: `利用者が画面から設定 ${nowIso}` }, nowIso);
    this.ledger.logEvent({ level: 'info', code: 'limits_change', message: `上限変更 ${accountId}/${opType} ${JSON.stringify(patch)}`, accountId }, nowIso);
    return r;
  }

  clearExternalBlock(accountId) {
    this.limits.clearExternalBlock(accountId);
    this.ledger.logEvent({ level: 'info', code: 'external_block_cleared', message: '外部制限・認証切れの解除を利用者が確認', accountId }, this._nowIso());
    return this.limits.externalBlock(accountId);
  }

  /** 名簿（フォロー返しの観点） */
  preview({ accountId } = {}) {
    const a = accountId || this.account.id;
    const accountsById = Object.fromEntries(this.accounts.map((x) => [x.id, x]));
    const rows = [];
    for (const p of this.ledger.listPersons()) {
      const ev = this.ledger.getEvaluation(p.id, 'follow_back', a);
      const sources = this.ledger.sourcesOf(p.id);
      if (!ev && !sources.some((s) => s.listType === 'my_followers')) continue;
      const assignment = this.ledger.getAssignment(p.id);
      const tf = this.ledger.getTarget(p.id, OP.FOLLOW_BACK);
      const tl = this.ledger.getTarget(p.id, OP.LIKE);
      const latest = p.latestNote && p.latestNote.note ? p.latestNote.note : null;
      rows.push({
        personId: p.id, userId: p.userId || '', urlname: p.urlname, profileUrl: p.profileUrl, displayName: p.displayName,
        followerOf: [...new Set(sources.filter((s) => s.listType === 'my_followers').map((s) => accountsById[Object.values(accountsById).find((x) => x.urlname === s.seedUrlname)?.id]?.name || s.seedUrlname))].join(' | '),
        latestNotePublishedAt: latest ? latest.publishedAt : '', latestNoteEvidence: p.latestNote ? (p.latestNote.evidence || p.latestNote.message || p.latestNote.code) : '',
        owner: assignment ? (accountsById[assignment.accountId] ? accountsById[assignment.accountId].name : assignment.accountId) : '',
        ownerConflict: assignment && assignment.conflict ? assignment.conflict.message : '',
        relationship: ev && ev.checks && ev.checks.relationship ? ev.checks.relationship : null,
        likeState: tl ? tl.state : '', followState: tf ? tf.state : '', followReason: tf ? [tf.reasonCode, tf.reasonText].filter(Boolean).join(': ') : '',
        verdict: ev ? ev.verdict : '未評価', reasons: ev ? ev.reasons : [], evaluatedAt: ev ? ev.evaluatedAt : null, lastFetchedAt: p.lastFetchedAt || '',
      });
    }
    return rows;
  }

  state() {
    const now = this.clock.now();
    const byState = this.ledger.targetsByState(OP.FOLLOW_BACK);
    const counts = Object.fromEntries(STATES.map((s) => [s, byState[s].length]));
    const assignmentCounts = this.ledger.assignmentCounts();
    const perAccount = this.accounts.map((a) => ({
      id: a.id, name: a.name, url: a.url, urlname: a.urlname, cdpPort: a.cdpPort, enabled: a.enabled,
      assigned: assignmentCounts[a.id] || 0,
      targets: Object.fromEntries(STATES.map((s) => [s, byState[s].filter((t) => t.accountId === a.id).length])),
      pools: { like: this.limits.status(a.id, OP.LIKE, now), follow_back: this.limits.status(a.id, OP.FOLLOW_BACK, now) },
      block: this.limits.externalBlock(a.id),
      attempts: this.ledger.attemptStats(a.id, OP.FOLLOW_BACK),
      startReasons: this._startReasons(a, now),
    }));
    return {
      now: now.toISOString(),
      adapter: { name: this.adapter.name, capabilities: this.adapter.capabilities },
      dbPath: this.config.dbPath,
      exportDir: this.config.exportDir,
      selectedAccountId: this.account ? this.account.id : null,
      flags: {
        followBackEnabled: !!this.config.followBack.enabled,
        enableRealActions: this.config.enableRealActions,
        schedulerEnabled: false, // 定期実行は実装しない（設定値に関わらず何も起動しない）
        stopOnUnknown: this.config.stopOnUnknown !== false,
        sequentialAcrossAccounts: this.config.sequentialAcrossAccounts !== false,
      },
      configValues: { activityWindowDays: this.config.activityWindowDays, limitsPools: this.config.limits.pools, limitsLabels: this.config.limits.labels, refillNote: this.config.limits.refillNote },
      accounts: perAccount,
      criteria: CRITERIA2,
      counts,
      runner: this.runner.status(),
      plan: this.plan(),
      executorLock: this.ledger.executorLock(),
      recentRuns: this.ledger.listRuns(5).filter((r) => r.mode === 'follow_back'),
      recentCollections: this.ledger.listCollections(10).filter((c) => c.mode === 'follow_back').slice(0, 5),
      events: this.ledger.listEvents(30),
      attempts: this.ledger.attemptStats(null, OP.FOLLOW_BACK),
      startup: this.startup,
      kinds: KIND,
    };
  }

  /** 開始不可の原因を分けて示す（上限未設定、他ownerとの競合、条件未確認、外部制限、OFF） */
  _startReasons(account, now) {
    const reasons = [];
    if (!this.config.followBack.enabled) reasons.push({ code: 'follow_back_disabled', message: 'フォロー返しが OFF（候補の確認のみ）' });
    const can = this.limits.canExecute(account.id, OP.FOLLOW_BACK, now);
    if (!can.ok && can.code !== 'interval') reasons.push({ code: can.code, message: can.message });
    const evals = this.ledger.listPersons().map((p) => this.ledger.getEvaluation(p.id, 'follow_back', account.id)).filter(Boolean);
    const conflicts = evals.filter((e) => e.reasons.some((r) => r.code === 'owner_conflict')).length;
    const unverified = evals.filter((e) => e.verdict === 'hold').length;
    if (conflicts) reasons.push({ code: 'owner_conflicts', message: `他 owner との競合 ${conflicts} 件（返さない。自動移管しない）` });
    if (unverified) reasons.push({ code: 'unverified', message: `条件未確認で保留 ${unverified} 件` });
    return reasons;
  }

  async close() {
    try { await this.adapter.close(); } catch (_) { /* no-op */ }
    try { this.db.close(); } catch (_) { /* no-op */ }
  }
}

module.exports = { App2, ROOT_DIR, CRITERIA2 };
