'use strict';

/**
 * フォルダ2 §5 受入試験（実送信なし。モック／ドライラン）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, NOW, world } = require('./helpers');
const { App2 } = require('../2/完成品2/src/app2');
const { fixedClock, DAY_MS, HOUR_MS } = require('../shared/clock');
const { OP } = require('../shared/ledger');
const { openDb } = require('../shared/db');
const { Ledger } = require('../shared/ledger');
const { Limits } = require('../shared/limits');

const ROOT = path.resolve(__dirname, '..');
const MIN = 60e3;

/** フォロー返し用のモック世界: からす(_karasu) のフォロワーに各種ケース */
function fbWorld() {
  const w = world();
  w.creators._karasu.followers = ['fb_ok', 'fb_eq14', 'fb_13d23h', 'fb_15d', 'fb_nodate', 'fb_future', 'fb_already', 'fb_other_owner', 'fb_unknown_rel', 'fb_liked_before', 'fb_noid', 'koisi_'];
  w.creators._karasu.following = ['fb_already'];
  w.creators.koisi_.followers = ['fb_other_owner'];
  const mk = (id, days, extra = {}) => ({ userId: `u_${id}`, displayName: id, followingCount: 10, followerCount: 5, notes: days === null ? [{ key: `${id}_n`, publishedAt: null }] : [{ key: `${id}_n`, title: '最新', publishedAtOffsetDays: days }], ...extra });
  Object.assign(w.creators, {
    fb_ok: mk('fb_ok', -3),
    fb_eq14: mk('fb_eq14', -14),
    fb_13d23h: { ...mk('fb_13d23h', 0), notes: [{ key: 'fb13_n', publishedAtOffsetDays: -13, publishedAtOffsetHours: -23 }] },
    fb_15d: mk('fb_15d', -15),
    fb_nodate: mk('fb_nodate', null),
    fb_future: mk('fb_future', 1),
    fb_already: mk('fb_already', -1),
    fb_other_owner: mk('fb_other_owner', -1),
    fb_unknown_rel: mk('fb_unknown_rel', -1),
    fb_liked_before: mk('fb_liked_before', -2),
    fb_noid: { displayName: 'userId不明', followingCount: 1, followerCount: 1, notes: [{ key: 'noid_n', publishedAtOffsetDays: -1 }] },
  });
  return w;
}

function makeApp2({ clockIso = NOW, dbPath = ':memory:', overrides = {}, w = null } = {}) {
  const clock = fixedClock(clockIso);
  const { MockAdapter } = require('../shared/adapters/mock');
  const { loadConfig } = require('../shared/config');
  const { normalizeAccount } = require('../shared/accounts');
  const accounts = loadConfig({ rootDir: ROOT, env: {} }).accounts.map(normalizeAccount);
  const adapter = new MockAdapter(w || fbWorld(), { clock, accounts });
  const app = new App2({ rootDir: ROOT, adapterKind: 'mock', overrides: { requestIntervalMs: 0, betweenLikesMs: 0, limits: { minIntervalMs: 0 }, exportDir: path.join(tmpDir(), 'exports'), ...overrides }, clock, dbPath, adapter });
  app.runner.sleep = async () => {};
  return app;
}
const FOLLOW_LIMITS = { dailyLimit: 20, hourlyLimit: 10, capacity: 5, credits: 5, recoveryIntervalMin: 20, recoveryAmount: 1 };
const byUrl = (app, u) => app.ledger.findByUrlname(u)[0];
const evalOf = (app, u, acc = 'karasu') => app.ledger.getEvaluation(byUrl(app, u).id, 'follow_back', acc);
async function runAll(app, opts) { const r = await app.startRun(opts); if (r.started) await app.waitRun(); return { ...r, last: app.runner.status().lastRun }; }

test('§5 初期OFF: 候補の確認はできるが開始できない。上限未設定でも開始不可。両方の理由が画面に分かれて出る', async () => {
  const app = makeApp2();
  assert.equal(app.state().flags.followBackEnabled, false);
  const c = await app.collect();
  assert.equal(c.stopped, false);
  assert.ok(c.stats.adoptable >= 1, '候補の確認はできる');
  let r = await runAll(app, { dryRun: true });
  assert.equal(r.started, false);
  assert.equal(r.code, 'follow_back_disabled');
  const reasons = app.state().accounts.find((a) => a.id === 'karasu').startReasons.map((x) => x.code);
  assert.ok(reasons.includes('follow_back_disabled') && reasons.includes('limits_unset') && reasons.includes('owner_conflicts') === false);
  app.setConfig({ followBackEnabled: true });
  r = await runAll(app, { dryRun: true });
  assert.equal(r.started, false);
  assert.equal(r.code, 'limits_unset', 'follow 用の上限を明示設定するまで開始不可（like の値を流用しない）');
  assert.equal(app.limits.status('karasu', 'like', app.clock.now()).valid, true, 'like 枠は設定済みでも follow 枠は別');
  app.setLimits('karasu', 'follow_back', FOLLOW_LIMITS);
  r = await runAll(app, { dryRun: true });
  assert.equal(r.started, true);
  assert.equal(app.adapter.followCalls.length, 0, 'ドライランでは実フォローを送らない');
  await app.close();
});

test('§5 採用条件の成立・不成立・14日境界・未確認の保留', async () => {
  const app = makeApp2();
  await app.collect();
  assert.equal(evalOf(app, 'fb_ok').verdict, 'adopt');
  assert.equal(evalOf(app, 'fb_13d23h').verdict, 'adopt');
  assert.equal(evalOf(app, 'fb_eq14').verdict, 'reject');
  assert.equal(evalOf(app, 'fb_15d').verdict, 'reject');
  assert.equal(evalOf(app, 'fb_nodate').verdict, 'hold');
  assert.equal(evalOf(app, 'fb_future').verdict, 'hold');
  const already = evalOf(app, 'fb_already');
  assert.equal(already.verdict, 'reject');
  assert.ok(already.reasons.some((r) => r.code === 'already_following'));
  const unk = evalOf(app, 'fb_unknown_rel');
  assert.equal(unk.verdict, 'adopt', '関係が取れる世界では採用');
  // 関係を確認できない相手は理由付きで保留（通知で推定しない）
  app.adapter.setRelationshipUnknown('fb_unknown_rel', true);
  await app.collect();
  const unk2 = evalOf(app, 'fb_unknown_rel');
  assert.equal(unk2.verdict, 'hold');
  assert.ok(unk2.reasons.some((r) => r.code === 'follows_me_unverified'));
  // userId が取れない相手は本人識別が確定しないので保留
  const noid = evalOf(app, 'fb_noid');
  assert.equal(noid.verdict, 'hold');
  assert.ok(noid.reasons.some((r) => r.code === 'user_id_unknown'));
  // 自アカウント
  assert.equal(evalOf(app, 'koisi_').verdict, 'reject');
  await app.close();
});

test('§5 別 owner 競合: 相手がこちらをフォローしていても返さず、競合として表示。owner を自動移管しない', async () => {
  const app = makeApp2();
  // こいしの収集で fb_other_owner の owner が koisi になる
  app.selectAccount('koisi');
  await app.collect();
  const p = byUrl(app, 'fb_other_owner');
  assert.equal(app.ledger.assignedTo(p.id), 'koisi');
  app.selectAccount('karasu');
  const c = await app.collect();
  assert.equal(c.stats.ownerConflicts, 1);
  const ev = evalOf(app, 'fb_other_owner', 'karasu');
  assert.equal(ev.verdict, 'reject');
  assert.ok(ev.reasons.some((r) => r.code === 'owner_conflict'));
  assert.equal(app.ledger.assignedTo(p.id), 'koisi', '自動移管しない');
  assert.match(app.ledger.getAssignment(p.id).conflict.message, /自動移管しない/);
  assert.ok(app.state().accounts.find((a) => a.id === 'karasu').startReasons.some((x) => x.code === 'owner_conflicts'));
  const row = app.preview().find((r) => r.urlname === 'fb_other_owner');
  assert.ok(row.ownerConflict);
  // 実行しても karasu は fb_other_owner をフォローしない
  app.setConfig({ followBackEnabled: true, enableRealActions: true });
  app.setLimits('karasu', 'follow_back', FOLLOW_LIMITS);
  await runAll(app, { dryRun: false });
  assert.ok(!app.adapter.followCalls.some((f) => f.targetUrlname === 'fb_other_owner'));
  await app.close();
});

test('§5 同 owner で like 済み → follow は別 action として1回許可。2回目はしない', async () => {
  const app = makeApp2({ overrides: { enableRealActions: true } });
  app.setConfig({ followBackEnabled: true, enableRealActions: true });
  app.setLimits('karasu', 'follow_back', FOLLOW_LIMITS);
  await app.collect();
  const p = byUrl(app, 'fb_liked_before');
  // 同じ owner（karasu）が先に like 済み
  app.ledger.ensureCandidate(p.id, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, NOW);
  app.ledger.reserve(p.id, OP.LIKE, 'karasu', 'rl', NOW, 60e3);
  app.ledger.markSending(p.id, OP.LIKE, 'rl', { noteKey: 'x' }, NOW);
  app.ledger.finish(p.id, OP.LIKE, 'rl', { state: 'succeeded' }, NOW);
  await app.collect();
  const ev = evalOf(app, 'fb_liked_before');
  assert.equal(ev.verdict, 'adopt', 'like 済みを理由に follow を排除しない');
  assert.ok(ev.reasons.some((r) => r.code === 'liked_before' && r.level === 'info'));
  await runAll(app, { dryRun: false });
  assert.equal(app.adapter.followCalls.filter((f) => f.targetUrlname === 'fb_liked_before').length, 1);
  assert.equal(app.ledger.getTarget(p.id, OP.FOLLOW_BACK).state, 'succeeded');
  assert.equal(app.ledger.getTarget(p.id, OP.LIKE).state, 'succeeded');
  await app.collect();
  await runAll(app, { dryRun: false });
  assert.equal(app.adapter.followCalls.filter((f) => f.targetUrlname === 'fb_liked_before').length, 1, '2回目はしない');
  assert.equal(evalOf(app, 'fb_liked_before').verdict, 'reject');
  await app.close();
});

test('§5 3アカウント同時予約: 同じファイルDBの3つの台帳が同じ対象・同じ action を予約しても一つだけ', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.sqlite3');
  const ledgers = [0, 1, 2].map(() => new Ledger(openDb(file)));
  const limitsList = ledgers.map((l) => new Limits(l.db, { tzOffsetMinutes: 540 }));
  const pid = ledgers[0].upsertPerson({ urlname: 't', userId: 'ut' }, null, NOW).person.id;
  ledgers[0].assignBalanced(pid, ['karasu'], {}, NOW);
  ledgers[0].ensureCandidate(pid, OP.FOLLOW_BACK, { accountId: 'karasu', mode: 'follow_back' }, NOW);
  limitsList[0].configure('karasu', 'follow_back', FOLLOW_LIMITS, NOW);
  const results = ledgers.map((l, i) => limitsList[i].reserveWithCredit(l, { personId: pid, opType: OP.FOLLOW_BACK, accountId: 'karasu', runId: `run${i}` }, new Date(NOW), 60e3));
  assert.equal(results.filter((r) => r.ok).length, 1);
  // like の予約は別 action なので同時に取れる（同 owner）
  ledgers[1].ensureCandidate(pid, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, NOW);
  limitsList[1].configure('karasu', 'like', { dailyLimit: 10, hourlyLimit: 10, capacity: 5, credits: 5, recoveryIntervalMin: 20, recoveryAmount: 1 }, NOW);
  assert.equal(limitsList[1].reserveWithCredit(ledgers[1], { personId: pid, opType: OP.LIKE, accountId: 'karasu', runId: 'rl' }, new Date(NOW), 60e3).ok, true);
  for (const l of ledgers) l.db.close();
});

test('§5 結果不明の保持: 送信後タイムアウトは unknown のまま枠を使用済みで保持し、再起動後も再送しない。照合で解決するまで追加操作を止める', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'state.sqlite3');
  let app = makeApp2({ dbPath });
  app.setConfig({ followBackEnabled: true, enableRealActions: true });
  app.setLimits('karasu', 'follow_back', FOLLOW_LIMITS);
  await app.collect();
  app.adapter.setFollowBehavior('fb_ok', 'unknown');
  const r = await runAll(app, { dryRun: false });
  const p = byUrl(app, 'fb_ok');
  assert.equal(app.ledger.getTarget(p.id, OP.FOLLOW_BACK).state, 'unknown');
  assert.equal(r.last.stopReason, 'unknown_result', '解決するまで追加操作を止める');
  const creditsAfter = app.limits.status('karasu', 'follow_back', app.clock.now()).credits;
  assert.equal(creditsAfter, 4, '枠は使用済みのまま');
  const calls = app.adapter.followCalls.length;
  await app.close();
  app = makeApp2({ dbPath });
  app.setConfig({ followBackEnabled: true, enableRealActions: true });
  assert.equal(app.ledger.getTarget(p.id, OP.FOLLOW_BACK).state, 'unknown', '再起動後も unknown');
  assert.equal(app.limits.status('karasu', 'follow_back', app.clock.now()).credits, 4);
  await app.collect();
  await runAll(app, { dryRun: false });
  assert.equal(app.adapter.followCalls.filter((f) => f.targetUrlname === 'fb_ok').length, 0, '再送しない（新しいモックなので再送があれば 1 になる）');
  void calls;
  // 照合: サイト上で未フォロー → candidate に戻る。フォロー中 → succeeded
  const res = await app.resolveUnknown(p.id);
  assert.equal(res.siteState, 'not_done');
  assert.equal(res.state, 'candidate');
  await app.close();
});

test('§5 送信中にプロセスが落ちた対象（sending のまま）は再起動で unknown になり再送されない', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'state.sqlite3');
  let app = makeApp2({ dbPath });
  app.setConfig({ followBackEnabled: true, enableRealActions: true });
  app.setLimits('karasu', 'follow_back', FOLLOW_LIMITS);
  await app.collect();
  const p = byUrl(app, 'fb_ok');
  app.ledger.reserve(p.id, OP.FOLLOW_BACK, 'karasu', 'crash', NOW, 60e3);
  app.ledger.markSending(p.id, OP.FOLLOW_BACK, 'crash', {}, NOW);
  app.limits.consume('karasu', 'follow_back', new Date(NOW), { personId: p.id, runId: 'crash' });
  await app.close();
  app = makeApp2({ dbPath });
  app.setConfig({ followBackEnabled: true, enableRealActions: true });
  assert.equal(app.ledger.getTarget(p.id, OP.FOLLOW_BACK).state, 'unknown');
  assert.equal(app.limits.status('karasu', 'follow_back', app.clock.now()).credits, 4, '使用した枠は戻さない');
  await runAll(app, { dryRun: false });
  assert.equal(app.adapter.followCalls.filter((f) => f.targetUrlname === 'fb_ok').length, 0);
  await app.close();
});

test('§5 外部制限（429）と認証切れを分離し、内部回復・20分経過で勝手に再開しない', async () => {
  const app = makeApp2();
  app.setConfig({ followBackEnabled: true, enableRealActions: true });
  app.setLimits('karasu', 'follow_back', FOLLOW_LIMITS);
  await app.collect();
  app.adapter.setFollowBehavior('fb_ok', 'blocked');
  const r = await runAll(app, { dryRun: false });
  assert.equal(r.last.stopReason, 'blocked_external_limit');
  assert.equal(app.limits.externalBlock('karasu').kind, 'external_limit');
  app.clock.advance(60 * MIN);
  assert.equal((await runAll(app, { dryRun: true })).code, 'blocked_external_limit', '内部回復が進んでも解除されない');
  app.clearExternalBlock('karasu');
  app.adapter.setFollowBehavior('fb_ok', 'auth');
  await app.collect();
  const r2 = await runAll(app, { dryRun: false });
  assert.equal(r2.last.stopReason, 'blocked_auth');
  assert.equal(app.limits.externalBlock('karasu').kind, 'auth');
  const reasons = app.state().accounts.find((a) => a.id === 'karasu').startReasons.map((x) => x.code);
  assert.ok(reasons.includes('blocked_auth'));
  await app.close();
});

test('§5 内部残数が回復しても日次・時間残数が0なら停止継続。日付跨ぎ・1時間窓・再起動で残数と履歴を保つ', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'state.sqlite3');
  let app = makeApp2({ dbPath, clockIso: '2026-10-27T14:30:00.000Z' }); // JST 23:30
  app.setConfig({ followBackEnabled: true, enableRealActions: true });
  app.setLimits('karasu', 'follow_back', { dailyLimit: 1, hourlyLimit: 1, capacity: 3, credits: 3, recoveryIntervalMin: 20, recoveryAmount: 1 });
  await app.collect();
  const r = await runAll(app, { dryRun: false });
  assert.equal(r.last.summary.succeeded, 1);
  assert.ok(['daily_exhausted', 'hourly_exhausted', 'completed'].includes(r.last.stopReason));
  app.clock.advance(25 * MIN); // JST 23:55: 内部は回復するが日次・時間は0
  const st = app.limits.status('karasu', 'follow_back', app.clock.now());
  assert.equal(st.credits, 3);
  assert.equal(st.effective, 0);
  assert.equal(app.limits.canExecute('karasu', 'follow_back', app.clock.now()).code, 'daily_exhausted');
  app.clock.advance(10 * MIN); // JST 翌日 00:05: 日次は新しい日、直近1時間はまだ1件
  assert.equal(app.limits.canExecute('karasu', 'follow_back', app.clock.now()).code, 'hourly_exhausted');
  const snapshot = app.limits.status('karasu', 'follow_back', app.clock.now());
  await app.close();
  app = makeApp2({ dbPath, clockIso: '2026-10-27T15:05:00.000Z' });
  const after = app.limits.status('karasu', 'follow_back', app.clock.now());
  assert.equal(after.credits, snapshot.credits);
  assert.equal(after.usedLastHour, 1, '再起動で利用件数をリセットしない');
  assert.equal(after.lastRefill, snapshot.lastRefill);
  app.clock.advance(60 * MIN);
  assert.equal(app.limits.canExecute('karasu', 'follow_back', app.clock.now()).ok, true);
  await app.close();
});

test('§5 画面の状態: action 種別ごとの内部・日次・時間・有効残数、次の回復予定、停止理由', async () => {
  const app = makeApp2();
  app.setLimits('karasu', 'follow_back', { ...FOLLOW_LIMITS, credits: 0 });
  const s = app.state();
  const a = s.accounts.find((x) => x.id === 'karasu');
  assert.equal(a.pools.follow_back.credits, 0);
  assert.equal(a.pools.follow_back.effective, 0);
  assert.ok(a.pools.follow_back.nextRefillAt);
  assert.equal(a.pools.follow_back.emptySince, NOW);
  assert.equal(a.pools.like.effective, 50);
  assert.ok(s.criteria.some((c) => /200件まで安全/.test(c.text)));
  assert.ok(s.configValues.refillNote.includes('72件'));
  assert.ok(a.startReasons.some((x) => x.code === 'internal_exhausted'));
  await app.close();
});
