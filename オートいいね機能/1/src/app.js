'use strict';

/**
 * フォルダ1（スキ獲得・フォロワー獲得）のアプリ層。共通層（shared）を束ね、画面・CLI から使う操作を提供する。
 */

const path = require('node:path');
const { openDb } = require('../../shared/db');
const { Ledger, OP, STATES } = require('../../shared/ledger');
const { Limits, OP_TYPES } = require('../../shared/limits');
const { Seeds } = require('../../shared/seeds');
const { normalizeAccount, verifyAccountSession } = require('../../shared/accounts');
const { loadConfig, KIND } = require('../../shared/config');
const { criteriaFor, CRITERIA } = require('../../shared/criteria');
const { createAdapter } = require('../../shared/adapters');
const { collect, ownArticleInfo, checkModeAvailability } = require('../../shared/collect');
const { Runner, planTargets } = require('../../shared/runner');
const { checkOutcomes } = require('../../shared/outcomes');
const { exportAll, buildRosterRows } = require('../../shared/export');
const { systemClock } = require('../../shared/clock');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

class App {
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
    this.seeds = new Seeds(this.ledger);
    this.adapterKind = adapter ? adapter.name : adapterKind;
    this.adapter = adapter || createAdapter({ kind: adapterKind, config: this.config, accounts: this.accounts, clock, log, worldFile });
    this.runner = new Runner({ ledger: this.ledger, limits: this.limits, adapter: this.adapter, clock, config: this.config, accounts: this.accounts, log });
    this.startup = this._startup();
  }

  _nowIso() { return this.clock.now().toISOString(); }

  _startup() {
    const nowIso = this._nowIso();
    // 再起動復旧: 実行中の run は無いので、sending → unknown、reserved → candidate
    // 復旧は実行器を持つプロセスだけが行う。生存通知のある他プロセスの run には触らない
    const recovered = this.recover ? this.ledger.recoverOnStartup(nowIso, [], { staleMs: this.config.executorLockTtlMs }) : { sendingToUnknown: 0, reservedReleased: 0, runsInterrupted: 0, skipped: true };
    // 実行管理層の初期値（アカウント × action種別。既に設定済みなら触らない。follow_back は未設定のまま）
    const limitsInitialized = [];
    for (const a of this.accounts) {
      for (const op of OP_TYPES) {
        const pool = this.config.limits.pools[op] || {};
        const labels = this.config.limits.labels[op] || {};
        const note = Object.entries(labels).map(([k, v]) => `${k}: ${v}`).join('; ');
        if (this.limits.ensureConfigured(a.id, op, { ...pool, labels, note }, nowIso)) limitsInitialized.push(`${a.id}/${op}`);
      }
    }
    // 設定の永続値（初期OFF）
    if (this.ledger.getSetting('enableRealActions') === null) this.ledger.setSetting('enableRealActions', !!this.config.enableRealActions);
    if (this.ledger.getSetting('mode') === null) this.ledger.setSetting('mode', 'suki');
    if (this.ledger.getSetting('selectedAccountId') === null) this.ledger.setSetting('selectedAccountId', this.accounts[0] ? this.accounts[0].id : null);
    if (this.ledger.getSetting('requireReactionEvidence') === null) this.ledger.setSetting('requireReactionEvidence', !!this.config.requireReactionEvidence);
    if (this.ledger.getSetting('seedRange') === null) this.ledger.setSetting('seedRange', this.config.seedRange);
    this._applyPersistedConfig();
    // 既定の起点
    const seedsAdded = [];
    if (this.seeds.list().length === 0) {
      seedsAdded.push(this.seeds.add({ mode: 'follower', url: 'https://note.com/bold_cobra8451', displayName: 'かみなり', note: '依頼書で確認済みとされた著者URL。本人確認は「確認」ボタンで実施', urlConfirmedBySpec: true }, nowIso).seed.id);
      seedsAdded.push(this.seeds.add({ mode: 'suki', url: null, displayName: 'しちゃうおじさん', note: '教材の具体例。URLが確認できるまで推測で埋めない（未確認のため収集に使わない）' }, nowIso).seed.id);
      if (this.adapterKind === 'mock') {
        seedsAdded.push(this.seeds.add({ mode: 'suki', url: 'https://note.com/seed_suki_demo', displayName: 'スキして回る発信者（モック）', note: 'モック世界の起点。実在しない' }, nowIso).seed.id);
      }
    }
    this.ledger.logEvent({ level: 'info', code: 'startup', message: `起動（adapter=${this.adapterKind}）復旧: sending→unknown ${recovered.sendingToUnknown}、予約解放 ${recovered.reservedReleased}、中断run ${recovered.runsInterrupted}`, data: { recovered, limitsInitialized, seedsAdded } }, nowIso);
    return { recovered, limitsInitialized, seedsAdded };
  }

  _applyPersistedConfig() {
    this.config.enableRealActions = !!this.ledger.getSetting('enableRealActions', false);
    this.config.requireReactionEvidence = !!this.ledger.getSetting('requireReactionEvidence', false);
    this.config.seedRange = this.ledger.getSetting('seedRange', this.config.seedRange) || { followingMax: null, followerMin: null };
  }

  // ------------------------------------------------------------ 選択状態
  get selectedAccountId() { return this.ledger.getSetting('selectedAccountId'); }
  get mode() { return this.ledger.getSetting('mode', 'suki'); }
  get account() { return this.accounts.find((a) => a.id === this.selectedAccountId) || this.accounts[0]; }

  selectAccount(id) {
    if (!this.accounts.find((a) => a.id === id)) throw new Error(`不明なアカウント: ${id}`);
    this.ledger.setSetting('selectedAccountId', id);
    return id;
  }

  /** モード切替。担当・スキ履歴・使用済み枠は一切触らない */
  setMode(mode) {
    if (mode !== 'suki' && mode !== 'follower') throw new Error(`不明なモード: ${mode}`);
    this.ledger.setSetting('mode', mode);
    this.ledger.logEvent({ level: 'info', code: 'mode_switch', message: `モード切替 → ${mode}（担当・履歴・使用済み枠は保持）` }, this._nowIso());
    return mode;
  }

  setConfig(patch) {
    const allowed = ['enableRealActions', 'requireReactionEvidence', 'seedRange', 'stopOnUnknown'];
    const applied = {};
    for (const k of allowed) {
      if (patch[k] === undefined) continue;
      if (k === 'seedRange') {
        const v = patch[k] || {};
        const norm = { followingMax: v.followingMax == null || v.followingMax === '' ? null : Number(v.followingMax), followerMin: v.followerMin == null || v.followerMin === '' ? null : Number(v.followerMin) };
        this.ledger.setSetting('seedRange', norm);
        applied[k] = norm;
      } else if (k === 'stopOnUnknown') {
        this.config.stopOnUnknown = !!patch[k];
        applied[k] = !!patch[k];
      } else {
        this.ledger.setSetting(k, !!patch[k]);
        applied[k] = !!patch[k];
      }
    }
    this._applyPersistedConfig();
    this.ledger.logEvent({ level: 'info', code: 'config_change', message: `設定変更 ${JSON.stringify(applied)}` }, this._nowIso());
    return applied;
  }

  // ------------------------------------------------------------ 起点
  addSeed({ mode, url, displayName, note }) { return this.seeds.add({ mode: mode || this.mode, url, displayName, note }, this._nowIso()); }
  async verifySeed(id) { return this.seeds.verify(id, this.adapter, this._nowIso(), this.config); }
  setSeedUrl(id, url) { return this.seeds.setUrl(id, url); }
  setSeedEnabled(id, enabled) { return this.seeds.setEnabled(id, enabled); }
  removeSeed(id) { return this.seeds.remove(id); }

  // ------------------------------------------------------------ 収集・予定・実行
  async collect({ mode, accountId } = {}) {
    const account = accountId ? this.accounts.find((a) => a.id === accountId) : this.account;
    const m = mode || this.mode;
    return collect({ adapter: this.adapter, ledger: this.ledger, seeds: this.seeds, accounts: this.accounts, account, mode: m, config: this.config, clock: this.clock, log: this.log, limits: this.limits });
  }

  plan({ mode, accountId } = {}) {
    const a = accountId || this.account.id;
    return planTargets(this.ledger, a, mode || this.mode).map((it) => ({
      personId: it.person.id, urlname: it.person.urlname, displayName: it.person.displayName, profileUrl: it.person.profileUrl,
      latestNoteUrl: it.person.latestNote && it.person.latestNote.note ? it.person.latestNote.note.url : null,
      latestNotePublishedAt: it.person.latestNote && it.person.latestNote.note ? it.person.latestNote.note.publishedAt : null,
      reactionAt: it.reactionAt ? it.reactionAt.toISOString() : null,
      reasons: it.evaluation.reasons,
    }));
  }

  async startRun({ dryRun = true, maxCount = null, mode, accountId } = {}) {
    const a = accountId || this.account.id;
    const r = await this.runner.start({ accountId: a, mode: mode || this.mode, dryRun: dryRun !== false, maxCount: maxCount == null || maxCount === '' ? null : Number(maxCount) });
    if (r.started) {
      this._runPromise = r.promise;
      r.promise.catch((e) => this.log(`run error: ${e.message}`));
    }
    const { promise, ...rest } = r;
    return rest;
  }

  async waitRun() { if (this._runPromise) await this._runPromise; }
  pause() { return this.runner.pause(); }
  resume() { return this.runner.resume(); }
  stop() { return this.runner.stop(); }

  async resolveUnknown(personId, accountId) { return this.runner.resolveUnknownByCheck({ personId: Number(personId), accountId }); }

  async checkOutcomes(accountId) {
    const account = accountId ? this.accounts.find((a) => a.id === accountId) : this.account;
    return checkOutcomes({ adapter: this.adapter, ledger: this.ledger, account, clock: this.clock, config: this.config });
  }

  export() { return exportAll({ ledger: this.ledger, accounts: this.accounts, exportDir: this.config.exportDir, clock: this.clock }); }

  explain(personId) { return this.ledger.explain(Number(personId)); }

  async ownArticle(accountId) {
    const account = accountId ? this.accounts.find((a) => a.id === accountId) : this.account;
    const info = await ownArticleInfo({ adapter: this.adapter, account, config: this.config });
    const avail = await checkModeAvailability({ adapter: this.adapter, account, mode: 'suki' });
    return { ...info, sukiModeAvailable: avail.available, sukiModeMessage: avail.message };
  }

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
    return this.limits.status(accountId, OP.LIKE, this.clock.now());
  }

  addExclusion({ urlname, userId, reason }) { this.ledger.addExclusion({ urlname, userId, reason }, this._nowIso()); return this.ledger.listExclusions(); }
  removeExclusion(urlname) { this.ledger.removeExclusion(urlname); return this.ledger.listExclusions(); }

  // ------------------------------------------------------------ 表示用
  preview({ mode, accountId } = {}) {
    const m = mode || this.mode;
    const a = accountId || this.account.id;
    const accountsById = Object.fromEntries(this.accounts.map((x) => [x.id, x]));
    const rows = buildRosterRows(this.ledger, accountsById);
    return rows.map((r) => {
      const ev = this.ledger.getEvaluation(r.personId, m, a);
      return { ...r, verdict: ev ? ev.verdict : '未評価', reasons: ev ? ev.reasons : [], evaluatedAt: ev ? ev.evaluatedAt : null };
    });
  }

  state() {
    const now = this.clock.now();
    const byState = this.ledger.targetsByState(OP.LIKE);
    const counts = Object.fromEntries(STATES.map((s) => [s, byState[s].length]));
    const assignmentCounts = this.ledger.assignmentCounts();
    const perAccount = this.accounts.map((a) => ({
      id: a.id, name: a.name, url: a.url, urlname: a.urlname, cdpPort: a.cdpPort, chromeProfileDir: a.chromeProfileDir, enabled: a.enabled,
      assigned: assignmentCounts[a.id] || 0,
      targets: Object.fromEntries(STATES.map((s) => [s, byState[s].filter((t) => t.accountId === a.id).length])),
      pools: { like: this.limits.status(a.id, OP.LIKE, now), follow_back: this.limits.status(a.id, OP.FOLLOW_BACK, now) },
      block: this.limits.externalBlock(a.id),
      attempts: this.ledger.attemptStats(a.id, OP.LIKE),
      outcomes: { sukiReturn: this.ledger.listOutcomes(a.id).filter((o) => o.kind === 'suki_return').length, followGained: this.ledger.listOutcomes(a.id).filter((o) => o.kind === 'follow_gained').length },
    }));
    return {
      now: now.toISOString(),
      adapter: { name: this.adapter.name, capabilities: this.adapter.capabilities },
      dbPath: this.config.dbPath,
      exportDir: this.config.exportDir,
      selectedAccountId: this.account ? this.account.id : null,
      mode: this.mode,
      flags: {
        enableRealActions: this.config.enableRealActions,
        schedulerEnabled: false, // 定期実行は実装しない（設定値に関わらず何も起動しない）
        schedulerNote: this.config.scheduler ? this.config.scheduler.note : '',
        requireReactionEvidence: this.config.requireReactionEvidence,
        stopOnUnknown: this.config.stopOnUnknown !== false,
        sequentialAcrossAccounts: this.config.sequentialAcrossAccounts !== false,
        oneLikePerPersonProjectWide: this.config.oneLikePerPersonProjectWide !== false,
      },
      configValues: {
        activityWindowDays: { value: this.config.activityWindowDays, kind: this.config.kinds.activityWindowDays, note: 'スキ獲得への適用は利用者の追加要件' },
        requireReactionEvidence: { value: this.config.requireReactionEvidence, kind: this.config.kinds.requireReactionEvidence },
        seedRange: { value: this.config.seedRange, kind: this.config.kinds.seedRange, note: '未設定なら判定しない' },
        pinSuggestionLikeThreshold: { value: this.config.pinSuggestionLikeThreshold, kind: this.config.kinds.pinSuggestionLikeThreshold },
        oneLikePerPersonProjectWide: { value: this.config.oneLikePerPersonProjectWide, kind: this.config.kinds.oneLikePerPersonProjectWide },
        betweenLikesMs: { value: this.config.betweenLikesMs, kind: this.config.kinds.betweenLikesMs },
        stopOnUnknown: { value: this.config.stopOnUnknown !== false, kind: this.config.kinds.stopOnUnknown },
        limitsLabels: this.config.limits.labels,
        limitsPools: this.config.limits.pools,
        refillNote: this.config.limits.refillNote,
      },
      accounts: perAccount,
      seeds: this.seeds.list(),
      criteria: criteriaFor(this.mode),
      counts,
      runner: this.runner.status(),
      plan: this.plan(),
      executorLock: this.ledger.executorLock(),
      recentRuns: this.ledger.listRuns(5),
      recentCollections: this.ledger.listCollections(5),
      events: this.ledger.listEvents(30),
      exclusions: this.ledger.listExclusions(),
      attempts: this.ledger.attemptStats(null, OP.LIKE),
      startup: this.startup,
      kinds: KIND,
    };
  }

  async close() {
    try { await this.adapter.close(); } catch (_) { /* no-op */ }
    try { this.db.close(); } catch (_) { /* no-op */ }
  }
}

module.exports = { App, ROOT_DIR, CRITERIA };
