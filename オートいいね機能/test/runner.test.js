'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, NOW } = require('./helpers');
const { collect } = require('../shared/collect');
const { OP } = require('../shared/ledger');
const { Runner } = require('../shared/runner');

async function prepared({ configOverrides = {}, worldOverride = null, mode = 'follower' } = {}) {
  const h = harness({ configOverrides: { enableRealActions: true, ...configOverrides }, worldOverride });
  const url = mode === 'suki' ? 'https://note.com/seed_suki_demo' : 'https://note.com/bold_cobra8451';
  const { seed } = h.seeds.add({ mode, url }, h.nowIso);
  await h.seeds.verify(seed.id, h.adapter, h.nowIso, h.config);
  for (const a of h.accounts) {
    await collect({ adapter: h.adapter, ledger: h.ledger, seeds: h.seeds, accounts: h.accounts, account: a, mode, config: h.config, clock: h.clock });
  }
  return h;
}
const byUrl = (h, u) => h.ledger.findByUrlname(u)[0];
async function runAll(h, { accountId, mode, dryRun, maxCount = null }) {
  const r = await h.runner.start({ accountId, mode, dryRun, maxCount });
  if (!r.started) return { ...r, last: null };
  const last = await r.promise;
  return { ...r, last };
}

test('7.6/E 初期状態では実アクションOFF。ドライランは候補を残したまま実スキを送らない', async () => {
  const h = await prepared({ configOverrides: { enableRealActions: false } });
  const real = await runAll(h, { accountId: 'karasu', mode: 'follower', dryRun: false });
  assert.equal(real.started, false);
  assert.equal(real.code, 'real_actions_disabled');
  const dry = await runAll(h, { accountId: 'karasu', mode: 'follower', dryRun: true });
  assert.equal(dry.started, true);
  assert.ok(dry.last.summary.dryRunWouldLike > 0);
  assert.equal(h.adapter.likeCalls.length, 0, '実スキは送られない');
  assert.equal(h.ledger.listTargets({ state: 'succeeded' }).length, 0);
  assert.equal(h.ledger.listTargets({ accountId: 'karasu', state: 'candidate' }).length, dry.last.summary.dryRunWouldLike + 0, 'ドライラン後も候補のまま');
  assert.equal(h.limits.status('karasu', h.clock.now()).usedToday, 0, 'ドライランは枠を消費しない');
  assert.equal(h.ledger.attemptStats('karasu').attempted, 0);
  assert.ok(h.ledger.attemptStats('karasu').dry_run > 0);
});

test('E.6/7.1 同一候補が3アカウント・両モードに現れても担当は一つ、実スキは1件だけ', async () => {
  const h = await prepared({ mode: 'suki', configOverrides: { stopOnUnknown: false } });
  const { seed } = h.seeds.add({ mode: 'follower', url: 'https://note.com/bold_cobra8451' }, h.nowIso);
  await h.seeds.verify(seed.id, h.adapter, h.nowIso, h.config);
  for (const a of h.accounts) {
    await collect({ adapter: h.adapter, ledger: h.ledger, seeds: h.seeds, accounts: h.accounts, account: a, mode: 'follower', config: h.config, clock: h.clock });
  }
  const p = byUrl(h, 'p_both_modes');
  assert.equal(h.ledger.findByUrlname('p_both_modes').length, 1);
  const owner = h.ledger.assignedTo(p.id);
  for (const mode of ['suki', 'follower']) {
    for (const a of h.accounts) {
      await runAll(h, { accountId: a.id, mode, dryRun: false });
    }
  }
  const likes = h.adapter.likeCalls.filter((c) => c.noteKey === 'bm1');
  assert.equal(likes.length, 1, 'プロジェクト全体でスキは1件');
  assert.equal(likes[0].accountId, owner);
  assert.equal(h.ledger.getTarget(p.id, OP.LIKE).state, 'succeeded');
  // 全体でも、同じ記事に二度スキした記録はない
  const keys = h.adapter.likeCalls.map((c) => c.noteKey);
  assert.equal(new Set(keys).size, keys.length);
});

test('E.8/7.3 対象不足なら件数未達で終了し、代替操作で埋めない', async () => {
  const h = await prepared();
  h.adapter.setLikeBehavior('p_unknown_result', 'succeeded');
  const plan = require('../shared/runner').planTargets(h.ledger, 'karasu', 'follower');
  const maxCount = plan.length + 5;
  const r = await runAll(h, { accountId: 'karasu', mode: 'follower', dryRun: false, maxCount });
  assert.equal(r.last.summary.shortfall, maxCount - r.last.summary.succeeded, '未達 = 予定 - 成功');
  assert.ok(r.last.summary.shortfall >= 5, '見送りがあれば未達はさらに増え、埋めない');
  assert.equal(r.last.summary.processed, r.last.summary.succeeded + r.last.summary.skipped + r.last.summary.unknown + r.last.summary.failedBeforeSend + r.last.summary.alreadyLiked);
  assert.equal(r.last.stopReason, 'completed');
  assert.equal(h.adapter.likeCalls.length, r.last.summary.succeeded + r.last.summary.unknown);
  // 他アカウントの担当や不採用の人には手を出していない
  const likedUrlnames = h.adapter.likeCalls.map((c) => h.ledger.listPersons().find((p) => p.latestNote && p.latestNote.note && p.latestNote.note.key === c.noteKey).urlname);
  for (const u of likedUrlnames) assert.equal(h.ledger.assignedTo(byUrl(h, u).id), 'karasu');
  assert.ok(!likedUrlnames.includes('p_ratio_eq'));
  assert.ok(!likedUrlnames.includes('p_15d_follower'));
});

test('C 実行直前の再確認: 収集後に最新記事が古くなった相手は見送る', async () => {
  const h = await prepared();
  const p = byUrl(h, 'p_ratio_gt');
  const owner = h.ledger.assignedTo(p.id);
  h.adapter.setNotes('p_ratio_gt', [{ key: 'g1', title: '最新', publishedAtOffsetDays: -20 }]);
  const r = await runAll(h, { accountId: owner, mode: 'follower', dryRun: false });
  const t = h.ledger.getTarget(p.id, OP.LIKE);
  assert.equal(t.state, 'skipped');
  assert.equal(t.reasonCode, 'recheck_inactive');
  assert.ok(!h.adapter.likeCalls.some((c) => c.noteKey === 'g1'));
  assert.ok(r.last.summary.skipped >= 1);
});

test('C 実行直前の再確認: 本人不一致・記事著者不一致・本文未表示は見送り、既スキはサイト状態を尊重して再クリックしない', async () => {
  const h = await prepared();
  // 本文未表示
  const pb = byUrl(h, 'p_body_not_rendered');
  const ownerB = h.ledger.assignedTo(pb.id);
  await runAll(h, { accountId: ownerB, mode: 'follower', dryRun: false });
  assert.equal(h.ledger.getTarget(pb.id, OP.LIKE).state, 'skipped');
  assert.equal(h.ledger.getTarget(pb.id, OP.LIKE).reasonCode, 'body_not_rendered');
  // 既スキ（サイト上で既に押されている）
  const h2 = await prepared();
  const pg = byUrl(h2, 'p_ratio_gt');
  const owner = h2.ledger.assignedTo(pg.id);
  h2.adapter.likedBy.set('g1', new Set([owner]));
  await runAll(h2, { accountId: owner, mode: 'follower', dryRun: false });
  const t = h2.ledger.getTarget(pg.id, OP.LIKE);
  assert.equal(t.state, 'succeeded');
  assert.equal(t.reasonCode, 'already_liked_on_site');
  assert.ok(!h2.adapter.likeCalls.some((c) => c.noteKey === 'g1'), '再クリックしない（解除になる可能性）');
  assert.equal(h2.ledger.attemptStats(owner).attempted, h2.adapter.likeCalls.filter((c) => c.accountId === owner).length, '既スキは送信試行に数えない');
  // 本人不一致（userId が変わった）
  const h3 = await prepared();
  const px = byUrl(h3, 'p_ratio_gt');
  const ownerX = h3.ledger.assignedTo(px.id);
  h3.adapter.world.creators.p_ratio_gt.userId = 'someone_else';
  await runAll(h3, { accountId: ownerX, mode: 'follower', dryRun: false });
  assert.equal(h3.ledger.getTarget(px.id, OP.LIKE).reasonCode, 'user_id_mismatch');
});

test('7.2 結果不明は unknown として残り、自動再送しない。既定では実行を止め、状態照合で確定できる', async () => {
  const h = await prepared();
  const pu = byUrl(h, 'p_unknown_result');
  const owner = h.ledger.assignedTo(pu.id);
  const r = await runAll(h, { accountId: owner, mode: 'follower', dryRun: false });
  const t = h.ledger.getTarget(pu.id, OP.LIKE);
  assert.equal(t.state, 'unknown');
  assert.equal(r.last.stopReason, 'unknown_result');
  assert.equal(h.adapter.likeCalls.filter((c) => c.noteKey === 'ur1').length, 1);
  assert.equal(h.limits.status(owner, h.clock.now()).usedToday, r.last.summary.succeeded + r.last.summary.unknown, '結果不明でも送信開始時に枠は消費済み');
  // もう一度実行しても再送しない
  const r2 = await runAll(h, { accountId: owner, mode: 'follower', dryRun: false });
  assert.equal(h.adapter.likeCalls.filter((c) => c.noteKey === 'ur1').length, 1);
  assert.equal(h.ledger.attemptStats(owner).unknown, 1);
  const succeededAttempts = r.last.summary.succeeded + r2.last.summary.succeeded;
  assert.equal(h.ledger.attemptStats(owner).succeeded, succeededAttempts, '成功と確認できたものだけを成功に数える');
  // 再収集しても候補に戻らない
  await collect({ adapter: h.adapter, ledger: h.ledger, seeds: h.seeds, accounts: h.accounts, account: h.accounts[0], mode: 'follower', config: h.config, clock: h.clock });
  assert.equal(h.ledger.getTarget(pu.id, OP.LIKE).state, 'unknown');
  // 状態照合: サイト上は押されていない → candidate に戻る（利用者の明示操作）
  h.adapter.setLikeBehavior('p_unknown_result', 'succeeded');
  const res = await h.runner.resolveUnknownByCheck({ personId: pu.id });
  assert.equal(res.siteState, 'not_liked');
  assert.equal(res.state, 'candidate');
  // 照合でスキ済みなら succeeded（二重計上しない）
  const pu2 = byUrl(h, 'p_unknown_result');
  h.adapter.likedBy.set('ur1', new Set([owner]));
  h.ledger.reserve(pu2.id, OP.LIKE, owner, 'rx', NOW, 60e3);
  h.ledger.markSending(pu2.id, OP.LIKE, 'rx', { noteKey: 'ur1', noteUrl: 'https://note.com/p_unknown_result/n/ur1' }, NOW);
  h.ledger.finish(pu2.id, OP.LIKE, 'rx', { state: 'unknown' }, NOW);
  const res2 = await h.runner.resolveUnknownByCheck({ personId: pu2.id });
  assert.equal(res2.state, 'succeeded');
  assert.equal(h.ledger.attemptStats(owner).succeeded, succeededAttempts, '照合による確定は送信試行に数えない');
});

test('7.2 送信中に実行器が落ちても（例外）unknown になり、再起動後も再送されない', async () => {
  const h = await prepared();
  const pg = byUrl(h, 'p_ratio_gt');
  const owner = h.ledger.assignedTo(pg.id);
  h.adapter.setLikeBehavior('p_ratio_gt', 'exception');
  await runAll(h, { accountId: owner, mode: 'follower', dryRun: false });
  assert.equal(h.ledger.getTarget(pg.id, OP.LIKE).state, 'unknown');
  // 送信開始直後にプロセスが終了した状況（finish されない sending）
  const pb = byUrl(h, 'p_both_modes') || byUrl(h, 'p_future');
  const anyCandidate = h.ledger.listTargets({ opType: OP.LIKE, state: 'candidate' })[0];
  h.ledger.reserve(anyCandidate.personId, OP.LIKE, anyCandidate.accountId, 'crash', NOW, 60e3);
  h.ledger.markSending(anyCandidate.personId, OP.LIKE, 'crash', { noteKey: 'x' }, NOW);
  const rec = h.ledger.recoverOnStartup(NOW, []);
  assert.equal(rec.sendingToUnknown, 1);
  assert.equal(h.ledger.getTarget(anyCandidate.personId, OP.LIKE).state, 'unknown');
  const before = h.adapter.likeCalls.length;
  const runner2 = new Runner({ ledger: h.ledger, limits: h.limits, adapter: h.adapter, clock: h.clock, config: h.config, accounts: h.accounts, sleep: async () => {} });
  for (const a of h.accounts) { const r = await runner2.start({ accountId: a.id, mode: 'follower', dryRun: false }); if (r.started) await r.promise; }
  assert.ok(!h.adapter.likeCalls.slice(before).some((c) => c.noteKey === 'g1' || c.noteKey === 'x'), 'unknown の対象は再送されない');
  void pb;
});

test('外部制限（ロック・認証要求）に遭遇したら blocked にして止め、内部残数より優先する', async () => {
  const h = await prepared();
  const pg = byUrl(h, 'p_ratio_gt');
  const owner = h.ledger.assignedTo(pg.id);
  h.adapter.setLikeBehavior('p_ratio_gt', 'blocked');
  const r = await runAll(h, { accountId: owner, mode: 'follower', dryRun: false });
  assert.equal(r.last.stopReason, 'external_block');
  assert.equal(h.ledger.getTarget(pg.id, OP.LIKE).state, 'blocked');
  const st = h.limits.status(owner, h.clock.now());
  assert.ok(st.externalBlock);
  assert.ok(st.internalRemaining > 0);
  const again = await runAll(h, { accountId: owner, mode: 'follower', dryRun: true });
  assert.equal(again.started, false);
  assert.equal(again.code, 'external_block');
  h.limits.clearExternalBlock(owner, NOW);
  assert.equal((await runAll(h, { accountId: owner, mode: 'follower', dryRun: true })).started, true);
});

test('アカウント照合: 接続先のログインIDが期待と違えば開始しない', async () => {
  const h = await prepared();
  h.adapter.setCurrentUser('karasu', 'pengi'); // フォルダ名が入れ替わっている状況
  const r = await runAll(h, { accountId: 'karasu', mode: 'follower', dryRun: true });
  assert.equal(r.started, false);
  assert.equal(r.code, 'account_mismatch');
  h.adapter.setCurrentUser('karasu', null);
  assert.equal((await runAll(h, { accountId: 'karasu', mode: 'follower', dryRun: true })).code, 'not_logged_in');
});

test('E.7 スキ獲得モードは自分の記事が0件なら開始できない。フォロワー獲得は開始できる', async () => {
  const h = await prepared({ mode: 'follower' });
  const r = await runAll(h, { accountId: 'pengi', mode: 'suki', dryRun: true });
  assert.equal(r.started, false);
  assert.equal(r.code, 'no_own_articles');
  assert.equal((await runAll(h, { accountId: 'pengi', mode: 'follower', dryRun: true })).started, true);
});

test('一時停止・再開・停止。3アカウントの外部操作は順番（実行ロック）', async () => {
  const h = await prepared();
  const r = await h.runner.start({ accountId: 'karasu', mode: 'follower', dryRun: true });
  assert.equal(r.started, true);
  assert.equal(h.runner.pause(), true);
  assert.equal(h.runner.status().state, 'paused');
  // 一時停止中は別の実行器も開始できない（同じロック）
  const h2runner = new Runner({ ledger: h.ledger, limits: h.limits, adapter: h.adapter, clock: h.clock, config: h.config, accounts: h.accounts, sleep: async () => {} });
  const other = await h2runner.start({ accountId: 'koisi', mode: 'follower', dryRun: true });
  assert.equal(other.started, false);
  assert.equal(other.code, 'executor_busy');
  assert.equal(h.runner.resume(), true);
  assert.equal(h.runner.stop(), true);
  const last = await r.promise;
  assert.equal(last.stopReason, 'stopped_by_user');
  assert.equal(h.runner.status().state, 'idle');
  assert.equal(h.ledger.executorLock(), null, '終了時にロックを離す');
  assert.equal((await h2runner.start({ accountId: 'koisi', mode: 'follower', dryRun: true })).started, true);
});

test('上限に達したら停止理由を残して止まる', async () => {
  const h = await prepared();
  const owner = 'karasu';
  h.limits.configure(owner, { dailyLimit: 1 }, NOW);
  const r = await runAll(h, { accountId: owner, mode: 'follower', dryRun: false });
  if (r.last.summary.considered > 1) {
    assert.equal(r.last.stopReason, 'daily_exhausted');
    assert.equal(h.adapter.likeCalls.filter((c) => c.accountId === owner).length, 1);
  } else {
    assert.ok(['completed', 'no_targets', 'daily_exhausted'].includes(r.last.stopReason));
  }
});
