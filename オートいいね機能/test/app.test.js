'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeApp, tmpDir, NOW } = require('./helpers');
const { OP } = require('../shared/ledger');

async function verifiedApp(opts = {}) {
  const app = makeApp(opts);
  for (const s of app.seeds.list()) if (s.urlname) await app.verifySeed(s.id);
  return app;
}

test('7.6 初期状態: 実アクションOFF・定期実行OFF。既定の起点（かみなり=URL確認済み、しちゃうおじさん=URL未確認）', async () => {
  const app = makeApp();
  const s = app.state();
  assert.equal(s.flags.enableRealActions, false);
  assert.equal(s.flags.schedulerEnabled, false);
  const kaminari = s.seeds.find((x) => x.displayName === 'かみなり');
  assert.equal(kaminari.url, 'https://note.com/bold_cobra8451');
  assert.equal(kaminari.urlConfirmedBySpec, true);
  assert.equal(kaminari.verified, false, 'URLが依頼書で確認済みでも本人確認は別に行う');
  const oji = s.seeds.find((x) => x.displayName === 'しちゃうおじさん');
  assert.equal(oji.url, null);
  assert.equal(oji.verified, false);
  assert.ok(s.criteria.length > 0);
  assert.ok(s.accounts.every((a) => a.pools.like.valid && JSON.stringify(a.pools.like.labels).includes('教材の参考値')), 'like 枠の値に区分が付く');
  assert.ok(s.accounts.every((a) => !a.pools.follow_back.valid && a.pools.follow_back.validity.code === 'limits_unset'), 'follow 枠は未設定で開始不可');
  const r = await app.startRun({ dryRun: false });
  assert.equal(r.started, false);
  assert.equal(r.code, 'real_actions_disabled');
  await app.close();
});

test('起点の本人確認: URL未確認は検証できず、確認済みは本人情報と起点形状（例示・閾値未設定）を表示', async () => {
  const app = makeApp();
  const oji = app.seeds.list().find((x) => x.displayName === 'しちゃうおじさん');
  const v = await app.verifySeed(oji.id);
  assert.equal(v.verified, false);
  assert.equal(v.verification.code, 'no_url');
  const k = app.seeds.list().find((x) => x.displayName === 'かみなり');
  const kv = await app.verifySeed(k.id);
  assert.equal(kv.verified, true);
  assert.equal(kv.verification.seedRange.evaluated, false);
  assert.equal(kv.verification.seedRange.code, 'threshold_unset');
  app.setConfig({ seedRange: { followingMax: 100, followerMin: 2000 } });
  const kv2 = await app.verifySeed(k.id);
  assert.equal(kv2.verification.seedRange.ok, true);
  app.setConfig({ seedRange: { followingMax: 10, followerMin: null } });
  assert.equal((await app.verifySeed(k.id)).verification.seedRange.ok, false);
  app.setSeedUrl(oji.id, 'https://note.com/seed_suki_demo');
  assert.equal((await app.verifySeed(oji.id)).verified, true);
  assert.throws(() => app.addSeed({ mode: 'suki', url: 'https://example.com/x' }));
  await app.close();
});

test('7.4/D モード切替・日付変更で担当・履歴・使用済み枠を初期化しない', async () => {
  const app = await verifiedApp({ overrides: { enableRealActions: true } });
  app.setConfig({ enableRealActions: true });
  app.setMode('follower');
  await app.collect();
  const r = await app.startRun({ dryRun: false, maxCount: 1 });
  assert.equal(r.started, true);
  await app.waitRun();
  const before = app.state();
  const used = before.accounts.find((a) => a.id === 'karasu').pools.like.usedToday;
  assert.ok(used >= 1);
  const assigned = app.ledger.assignmentCounts();
  const succeeded = app.ledger.listTargets({ state: 'succeeded' }).length;
  app.setMode('suki');
  app.clock.advance(2 * 24 * 3600e3);
  const after = app.state();
  assert.deepEqual(app.ledger.assignmentCounts(), assigned);
  assert.equal(app.ledger.listTargets({ state: 'succeeded' }).length, succeeded);
  assert.equal(after.accounts.find((a) => a.id === 'karasu').attempts.attempted, before.accounts.find((a) => a.id === 'karasu').attempts.attempted);
  assert.equal(app.limits.usageRows('karasu', 'like').length, used, '使用履歴は消えない');
  await app.close();
});

test('7.4 再起動後に担当・成功履歴・結果不明・残数・回復時刻が復元される', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'state.sqlite3');
  let app = await verifiedApp({ dbPath, overrides: { enableRealActions: true } });
  app.setConfig({ enableRealActions: true });
  app.setMode('follower');
  await app.collect();
  app.adapter.setLikeBehavior('p_ratio_gt', 'unknown');
  await app.startRun({ dryRun: false });
  await app.waitRun();
  const s1 = app.state();
  const snapshot = {
    assignments: app.ledger.assignmentCounts(),
    succeeded: app.ledger.listTargets({ state: 'succeeded' }).map((t) => t.personId),
    unknown: app.ledger.listTargets({ state: 'unknown' }).map((t) => t.personId),
    remaining: s1.accounts.map((a) => [a.id, a.pools.like.credits, a.pools.like.lastRefill]),
    mode: s1.mode,
  };
  await app.close();
  app = makeApp({ dbPath });
  const s2 = app.state();
  assert.deepEqual(app.ledger.assignmentCounts(), snapshot.assignments);
  assert.deepEqual(app.ledger.listTargets({ state: 'succeeded' }).map((t) => t.personId), snapshot.succeeded);
  assert.deepEqual(app.ledger.listTargets({ state: 'unknown' }).map((t) => t.personId), snapshot.unknown);
  assert.deepEqual(s2.accounts.map((a) => [a.id, a.pools.like.credits, a.pools.like.lastRefill]), snapshot.remaining);
  assert.equal(s2.mode, 'follower');
  assert.equal(s2.flags.enableRealActions, true, '利用者が明示した設定は保持');
  await app.close();
});

test('名簿プレビュー・なぜ選ばれたか・CSV/JSON 出力', async () => {
  const app = await verifiedApp();
  app.setMode('suki');
  const c = await app.collect();
  assert.equal(c.stopped, false);
  const rows = app.preview();
  assert.ok(rows.length >= 10);
  const row = rows.find((r) => r.urlname === 'p_nolikedat');
  assert.equal(row.reactionAt, '反応日時不明');
  assert.ok(row.seedUrls.includes('seed_suki_demo'));
  assert.equal(row.listTypes, '記事のスキ一覧');
  const own = rows.find((r) => r.urlname === '_karasu');
  assert.equal(own.verdict, 'reject');
  const ex = app.explain(row.personId);
  assert.ok(ex.sources.length >= 1);
  assert.ok(ex.evaluations.length >= 3, '3アカウント分の評価');
  const out = app.export();
  assert.ok(fs.existsSync(out.files.rosterCsv));
  const csv = fs.readFileSync(out.files.rosterCsv, 'utf8');
  assert.ok(csv.startsWith('﻿対象'.slice(0, 1)));
  assert.ok(csv.includes('反応日時不明'));
  assert.ok(csv.includes('起点URL'));
  const json = JSON.parse(fs.readFileSync(out.files.json, 'utf8'));
  assert.equal(json.roster.length, rows.length);
  await app.close();
});

test('成果の記録: 成功した相手のスキ返し・フォロー増加だけを一致で記録し、全体の増加を効果と断定しない', async () => {
  const app = await verifiedApp({ overrides: { enableRealActions: true } });
  app.setConfig({ enableRealActions: true });
  app.setMode('follower');
  await app.collect();
  await app.startRun({ dryRun: false });
  await app.waitRun();
  const succeeded = app.ledger.listTargets({ accountId: 'karasu', state: 'succeeded' });
  assert.ok(succeeded.length >= 1);
  const p = app.ledger.getPerson(succeeded[0].personId);
  // 相手がこちらの記事にスキし、フォローした
  app.adapter.addLike('k2', p.urlname, new Date(new Date(NOW).getTime() + 3600e3).toISOString());
  app.adapter.addFollower('_karasu', p.urlname);
  // 無関係の人もスキ・フォローしているが記録されない
  app.adapter.addLike('k2', 'p_ratio_eq', null);
  app.adapter.addFollower('_karasu', 'p_ratio_eq');
  const r = await app.checkOutcomes('karasu');
  assert.equal(r.sukiReturnNew, 1);
  assert.equal(r.followGainedNew, 1);
  const r2 = await app.checkOutcomes('karasu');
  assert.equal(r2.sukiReturnNew, 0, '二重計上しない');
  const st = app.state().accounts.find((a) => a.id === 'karasu');
  assert.deepEqual(st.outcomes, { sukiReturn: 1, followGained: 1 });
  const o = app.ledger.listOutcomes('karasu').find((x) => x.kind === 'follow_gained');
  assert.match(o.evidence.causality, /断定しない/);
  await app.close();
});

test('除外リストに入れた人は候補から外れる', async () => {
  const app = await verifiedApp();
  app.setMode('follower');
  app.addExclusion({ urlname: 'p_ratio_gt', reason: 'test' });
  await app.collect();
  const row = app.preview().find((r) => r.urlname === 'p_ratio_gt');
  assert.equal(row.verdict, 'reject');
  assert.ok(row.reasons.some((x) => x.code === 'excluded'));
  assert.equal(app.ledger.getTarget(row.personId, OP.LIKE), null);
  await app.close();
});
