'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, NOW } = require('./helpers');
const { collect, checkModeAvailability, ownArticleInfo } = require('../shared/collect');
const { OP } = require('../shared/ledger');

async function setup(mode, { configOverrides, worldOverride } = {}) {
  const h = harness({ configOverrides, worldOverride });
  const seedUrl = mode === 'suki' ? 'https://note.com/seed_suki_demo' : 'https://note.com/bold_cobra8451';
  const { seed } = h.seeds.add({ mode, url: seedUrl }, h.nowIso);
  await h.seeds.verify(seed.id, h.adapter, h.nowIso, h.config);
  return { ...h, seed };
}
const run = (h, mode, accountId = 'karasu') => collect({ adapter: h.adapter, ledger: h.ledger, seeds: h.seeds, accounts: h.accounts, account: h.accounts.find((a) => a.id === accountId), mode, config: h.config, clock: h.clock });
const byUrl = (h, u) => h.ledger.findByUrlname(u)[0];
// 担当が付いた人はその担当の評価を見る（他アカウントの評価は assigned_other で reject になる）
const evalOf = (h, u, mode, acc) => { const p = byUrl(h, u); return h.ledger.getEvaluation(p.id, mode, acc || h.ledger.assignedTo(p.id) || 'karasu'); };

test('E.1 スキ獲得は起点記事のスキ一覧から、フォロワー獲得は起点のフォロワー一覧から抽出する', async () => {
  const a = await setup('suki');
  const ra = await run(a, 'suki');
  assert.equal(ra.stopped, false);
  assert.equal(ra.kind, 'initial');
  const srcA = a.ledger.sourcesOf(byUrl(a, 'p_active_3d').id);
  assert.ok(srcA.every((s) => s.listType === 'note_likes' && s.seedUrl === 'https://note.com/seed_suki_demo' && s.seedNoteUrl));
  assert.equal(byUrl(a, 'p_ratio_gt'), undefined, 'フォロワー一覧の人はスキ獲得では現れない');
  assert.ok(a.adapter.calls.some((c) => c.method === 'getNoteLikes'));
  assert.ok(!a.adapter.calls.some((c) => c.method === 'getFollowers'), 'スキ獲得で起点のフォロワー一覧を使わない');

  const b = await setup('follower');
  const rb = await run(b, 'follower');
  assert.equal(rb.stopped, false);
  const srcB = b.ledger.sourcesOf(byUrl(b, 'p_ratio_gt').id);
  assert.ok(srcB.every((s) => s.listType === 'followers' && s.seedUrl === 'https://note.com/bold_cobra8451'));
  assert.ok(!b.adapter.calls.some((c) => c.method === 'getNoteLikes'), 'フォロワー獲得で記事のスキ一覧を使わない');
});

test('未確認の起点・URL未確認の起点は収集に使わない', async () => {
  const h = harness();
  h.seeds.add({ mode: 'suki', url: null, displayName: 'しちゃうおじさん' }, h.nowIso);
  const { seed } = h.seeds.add({ mode: 'suki', url: 'https://note.com/seed_suki_demo' }, h.nowIso); // 未確認のまま
  const r = await run(h, 'suki');
  assert.equal(r.stats.seedsUsed, 0);
  assert.equal(r.skippedSeeds.length, 2);
  assert.ok(r.skippedSeeds.some((s) => s.reason.startsWith('no_url')));
  assert.ok(r.skippedSeeds.some((s) => s.id === seed.id && s.reason.startsWith('unverified')));
  assert.equal(h.ledger.listPersons().length, 0);
});

test('E.3/E.2 収集時の評価: 境界・比率・日時不明が正しく分類される', async () => {
  const a = await setup('suki');
  await run(a, 'suki');
  assert.equal(evalOf(a, 'p_boundary_13d23h', 'suki').verdict, 'adopt');
  assert.equal(evalOf(a, 'p_boundary_14d', 'suki').verdict, 'reject');
  assert.equal(evalOf(a, 'p_15d', 'suki').verdict, 'reject');
  assert.equal(evalOf(a, 'p_date_unknown', 'suki').verdict, 'hold');
  const b = await setup('follower');
  await run(b, 'follower');
  assert.equal(evalOf(b, 'p_ratio_gt', 'follower').verdict, 'adopt');
  assert.equal(evalOf(b, 'p_ratio_eq', 'follower').verdict, 'reject');
  assert.equal(evalOf(b, 'p_ratio_lt', 'follower').verdict, 'reject');
  assert.equal(evalOf(b, 'p_ratio_unknown', 'follower').verdict, 'hold');
  assert.equal(byUrl(b, 'p_ratio_unknown').followingCount, null, '省略表記を 0 で埋めない');
  assert.equal(evalOf(b, 'p_15d_follower', 'follower').verdict, 'reject');
  assert.equal(evalOf(b, 'p_future', 'follower').verdict, 'hold');
});

test('E.4 固定記事が古い人は、通常投稿の最新記事が対象になる', async () => {
  const a = await setup('suki');
  await run(a, 'suki');
  const p = byUrl(a, 'p_pinned_old');
  assert.equal(p.latestNote.note.key, 'pin_new');
  assert.equal(p.pinnedNote.key, 'pin_old');
  assert.equal(evalOf(a, 'p_pinned_old', 'suki').verdict, 'adopt');
});

test('E.5 反応日時が取れない人は「反応日時不明」のまま。収集時刻を転用しない', async () => {
  const a = await setup('suki');
  await run(a, 'suki');
  const p = byUrl(a, 'p_nolikedat');
  const src = a.ledger.sourcesOf(p.id).find((s) => s.seedNoteKey === 'ss1');
  assert.equal(src.reactionAt, null);
  assert.equal(src.reactionEvidence, null);
  assert.ok(src.orderEvidence, '一覧順の証拠（取得元が新しい順と明示）は別項目に残る');
  assert.equal(src.firstDiscoveredAt, NOW);
  const ev = evalOf(a, 'p_nolikedat', 'suki');
  assert.equal(ev.verdict, 'adopt');
  assert.equal(ev.checks.reaction.status, 'order_only');
  assert.equal(ev.checks.reaction.reactionAt, null);
  // ss2 の一覧は順序不明 → unknown
  const src2 = a.ledger.sourcesOf(byUrl(a, 'p_unknown_result').id).find((s) => s.seedNoteKey === 'ss2');
  assert.equal(src2.orderEvidence, null);
  // 証拠必須設定: 反応日時も一覧順の証拠も無い人（ss2 のみ）は保留。一覧順の証拠がある人（ss1）は採用
  const b = await setup('suki', { configOverrides: { requireReactionEvidence: true } });
  await run(b, 'suki');
  assert.equal(evalOf(b, 'p_unknown_result', 'suki').verdict, 'hold');
  assert.ok(evalOf(b, 'p_unknown_result', 'suki').reasons.some((r) => r.code === 'reaction_evidence_missing'));
  assert.equal(evalOf(b, 'p_nolikedat', 'suki').verdict, 'adopt');
  assert.equal(evalOf(b, 'p_active_3d', 'suki').verdict, 'adopt');
});

test('E.7 自分の公開記事が0件なら、スキ獲得は止まりフォロワー獲得は使える', async () => {
  const h = await setup('suki');
  const pengi = h.accounts.find((a) => a.id === 'pengi'); // モック世界で記事0件
  const ra = await collect({ adapter: h.adapter, ledger: h.ledger, seeds: h.seeds, accounts: h.accounts, account: pengi, mode: 'suki', config: h.config, clock: h.clock });
  assert.equal(ra.stopped, true);
  assert.equal(ra.code, 'no_own_articles');
  assert.match(ra.message, /スキを集める先がない/);
  assert.equal(h.ledger.listPersons().length, 0);
  const { seed } = h.seeds.add({ mode: 'follower', url: 'https://note.com/bold_cobra8451' }, h.nowIso);
  await h.seeds.verify(seed.id, h.adapter, h.nowIso, h.config);
  const rb = await collect({ adapter: h.adapter, ledger: h.ledger, seeds: h.seeds, accounts: h.accounts, account: pengi, mode: 'follower', config: h.config, clock: h.clock });
  assert.equal(rb.stopped, false);
  assert.ok(rb.stats.passed > 0);
  assert.equal((await checkModeAvailability({ adapter: h.adapter, account: pengi, mode: 'follower' })).available, true);
});

test('件数の内訳: 新規取得・重複除外・条件合格・活動不合格・実行可能を分けて返し、更新収集で別人として増やさない', async () => {
  const a = await setup('suki');
  const r1 = await run(a, 'suki');
  const s1 = r1.stats;
  assert.equal(s1.listedTotal, 11, 'ss1 9件 + ss2 2件');
  assert.equal(s1.duplicateWithinRun, 1, 'p_active_3d が両記事に出る');
  assert.equal(s1.newPersons, 10);
  assert.equal(s1.ownAccounts, 1, '_karasu 自身');
  assert.ok(s1.activityFailed >= 3, '14日ちょうど・15日・日時不明');
  assert.equal(s1.passed + s1.held + s1.rejected, 10);
  assert.equal(s1.executableAllAccounts, s1.passed, '採用された人は全員どこかの担当に割り当てられ候補になる');
  assert.ok(s1.executable <= s1.executableAllAccounts);
  const persons1 = a.ledger.listPersons().length;
  const r2 = await run(a, 'suki');
  assert.equal(r2.kind, 'update');
  assert.equal(r2.stats.newPersons, 0);
  assert.equal(r2.stats.knownPersons, 10);
  assert.equal(r2.stats.duplicatesExcluded, 11);
  assert.equal(a.ledger.listPersons().length, persons1, '更新収集で候補が増えない');
  assert.equal(r2.stats.newlyAssigned, 0, '担当は変わらない');
});

test('両モードで同じ人が見つかっても候補は一人に統合され、適合したモードが併記され、担当は一つ', async () => {
  const h = await setup('suki');
  const { seed } = h.seeds.add({ mode: 'follower', url: 'https://note.com/bold_cobra8451' }, h.nowIso);
  await h.seeds.verify(seed.id, h.adapter, h.nowIso, h.config);
  await run(h, 'suki', 'karasu');
  const before = h.ledger.getAssignment(byUrl(h, 'p_both_modes').id);
  await run(h, 'follower', 'koisi');
  const p = byUrl(h, 'p_both_modes');
  assert.equal(h.ledger.findByUrlname('p_both_modes').length, 1);
  assert.deepEqual(h.ledger.modeFitOf(p.id), { suki: 'adopt', follower: 'adopt' });
  assert.equal(h.ledger.sourcesOf(p.id).length, 2);
  const after = h.ledger.getAssignment(p.id);
  assert.equal(after.accountId, before.accountId, 'フォロワー獲得側の収集で担当を付け替えない');
  const t = h.ledger.getTarget(p.id, OP.LIKE);
  assert.equal(t.state, 'candidate');
  assert.equal(t.accountId, before.accountId);
});

test('担当は適合した人にだけ付き、3アカウントで偏りを抑えて割り当てられる', async () => {
  const h = await setup('follower');
  await run(h, 'follower');
  const counts = h.ledger.assignmentCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const max = Math.max(...Object.values(counts));
  const min = Math.min(...Object.values(counts), ...(Object.keys(counts).length < 3 ? [0] : []));
  assert.ok(max - min <= 1, `偏り: ${JSON.stringify(counts)}`);
  assert.equal(total, (await run(h, 'follower')).stats.passed, '適合した人数と担当数が一致');
  assert.equal(h.ledger.getAssignment(byUrl(h, 'p_ratio_eq').id), null, '不採用の人に担当は付かない');
  assert.equal(h.ledger.getAssignment(byUrl(h, 'koisi_').id), null, '自アカウントに担当は付かない');
});

test('自分の固定記事が150スキを超えたら提案だけ表示し、設定は変更しない', async () => {
  const h = harness();
  const karasu = h.accounts.find((a) => a.id === 'karasu');
  const info = await ownArticleInfo({ adapter: h.adapter, account: karasu, config: h.config });
  assert.equal(info.count, 2);
  assert.equal(info.pinned.key, 'k1');
  assert.match(info.suggestion, /150 を超えて/);
  assert.match(info.suggestion, /変更しません/);
  assert.equal(info.latest.key, 'k2', '自分側も固定記事ではなく公開日時で最新を確定');
  assert.ok(!h.adapter.calls.some((c) => /pin|set/i.test(c.method)), '固定設定を変更する呼び出しは存在しない');
});
