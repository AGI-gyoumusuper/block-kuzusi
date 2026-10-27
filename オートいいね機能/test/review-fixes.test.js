'use strict';

/** レビュー指摘への修正の検証 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { harness, makeApp, tmpDir, NOW, world } = require('./helpers');
const { collect, checkModeAvailability } = require('../shared/collect');
const { planTargets } = require('../shared/runner');
const { OP, Ledger } = require('../shared/ledger');
const { openDb } = require('../shared/db');
const { NoteBrowserAdapter } = require('../shared/adapters/note-browser');
const { jst } = require('../shared/export');
const { createServer, listen } = require('../1/完成品/src/server');
const { App } = require('../1/完成品/src/app');
const { fixedClock } = require('../shared/clock');

const ROOT = path.resolve(__dirname, '..');

test('別プロセスの起動復旧は、生存通知のある実行中 run の対象を unknown にしない', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'state.sqlite3');
  const app = makeApp({ dbPath, overrides: { enableRealActions: true } });
  app.setConfig({ enableRealActions: true });
  for (const s of app.seeds.list()) if (s.urlname) await app.verifySeed(s.id);
  app.setMode('follower');
  await app.collect();
  // 実行中を模す: 予約→送信中にし、run に生存通知を入れる
  const t = app.ledger.listTargets({ opType: OP.LIKE, accountId: 'karasu', state: 'candidate' })[0];
  app.ledger.createRun({ id: 'live', accountId: 'karasu', mode: 'follower', dryRun: false }, NOW);
  app.ledger.reserve(t.personId, OP.LIKE, 'karasu', 'live', NOW, 60e3);
  app.ledger.markSending(t.personId, OP.LIKE, 'live', { noteKey: 'x' }, NOW);
  app.ledger.heartbeat('live', NOW);
  // 読み取り専用の別プロセス（recover=false）は何も触らない
  const ro = new App({ rootDir: ROOT, adapterKind: 'mock', dbPath, clock: fixedClock(NOW), recover: false });
  assert.equal(ro.ledger.getTarget(t.personId, OP.LIKE).state, 'sending');
  assert.equal(ro.startup.recovered.skipped, true);
  await ro.close();
  // 復旧ありの別プロセスでも、生存通知が新しければ触らない
  const other = new App({ rootDir: ROOT, adapterKind: 'mock', dbPath, clock: fixedClock(new Date(new Date(NOW).getTime() + 5 * 60e3).toISOString()) });
  assert.equal(other.ledger.getTarget(t.personId, OP.LIKE).state, 'sending');
  await other.close();
  // 生存通知が古ければ（プロセス消滅）unknown にする
  const later = new App({ rootDir: ROOT, adapterKind: 'mock', dbPath, clock: fixedClock(new Date(new Date(NOW).getTime() + 60 * 60e3).toISOString()) });
  assert.equal(later.ledger.getTarget(t.personId, OP.LIKE).state, 'unknown');
  await later.close();
  await app.close();
});

test('実行器は反復ごと・一時停止中に生存通知と実行ロックを更新する', async () => {
  const h = harness({ configOverrides: { enableRealActions: true } });
  const { seed } = h.seeds.add({ mode: 'follower', url: 'https://note.com/bold_cobra8451' }, h.nowIso);
  await h.seeds.verify(seed.id, h.adapter, h.nowIso, h.config);
  await collect({ adapter: h.adapter, ledger: h.ledger, seeds: h.seeds, accounts: h.accounts, account: h.accounts[0], mode: 'follower', config: h.config, clock: h.clock });
  const r = await h.runner.start({ accountId: 'karasu', mode: 'follower', dryRun: true });
  assert.equal(r.started, true);
  h.runner.pause();
  h.clock.advance(20 * 60e3);
  h.runner._keepAlive();
  assert.equal(h.ledger.getRun(r.runId).heartbeatAt, h.clock.now().toISOString());
  assert.ok(new Date(h.ledger.executorLock().expiresAt) > h.clock.now(), '一時停止中もロックが延長される');
  h.runner.resume(); h.runner.stop();
  await r.promise;
});

test('順序の証拠が無い出所では一覧の位置を優先順に使わない（初回発見順）', () => {
  const { ledger } = harness();
  const mk = (u, pos, orderEvidence, firstSeen) => {
    const p = ledger.upsertPerson({ urlname: u, userId: `u_${u}` }, { mode: 'suki', listType: 'note_likes', seedUrl: 's', seedNoteUrl: 'n', seedVerified: true, reactionAt: null, orderEvidence, listPosition: pos }, firstSeen).person.id;
    ledger.updateProfile(p, { latestNote: { code: 'ok', note: { key: `${u}_n`, publishedAt: NOW } } });
    ledger.assignBalanced(p, ['karasu'], {}, NOW);
    ledger.setEvaluation(p, 'suki', 'karasu', { verdict: 'adopt', reasons: [], checks: { reaction: { status: orderEvidence ? 'order_only' : 'unknown', reactionAt: null } } }, NOW);
    ledger.ensureCandidate(p, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, NOW);
    return p;
  };
  const later = mk('a_pos0_seen_later', 0, null, '2026-10-27T05:00:00.000Z');
  const earlier = mk('b_pos5_seen_first', 5, null, '2026-10-27T04:00:00.000Z');
  const withEvidence = mk('c_pos9_evidence', 9, '取得元が新しい順と明示', '2026-10-27T06:00:00.000Z');
  const order = planTargets(ledger, 'karasu', 'suki').map((i) => i.person.id);
  assert.deepEqual(order, [withEvidence, earlier, later]);
});

test('スキ獲得の担当は、そのモードを実行できるアカウント（公開記事あり）にだけ付く', async () => {
  const h = harness();
  const { seed } = h.seeds.add({ mode: 'suki', url: 'https://note.com/seed_suki_demo' }, h.nowIso);
  await h.seeds.verify(seed.id, h.adapter, h.nowIso, h.config);
  const r = await collect({ adapter: h.adapter, ledger: h.ledger, seeds: h.seeds, accounts: h.accounts, account: h.accounts[0], mode: 'suki', config: h.config, clock: h.clock });
  assert.deepEqual(r.stats.assignableAccounts, ['karasu', 'koisi'], 'pengi は記事0件のため除外');
  const counts = h.ledger.assignmentCounts();
  assert.equal(counts.pengi, undefined);
});

test('送信前失敗（failed_before_send）の対象は再収集で候補に戻る', async () => {
  const h = harness({ configOverrides: { enableRealActions: true } });
  const { seed } = h.seeds.add({ mode: 'follower', url: 'https://note.com/bold_cobra8451' }, h.nowIso);
  await h.seeds.verify(seed.id, h.adapter, h.nowIso, h.config);
  const run = () => collect({ adapter: h.adapter, ledger: h.ledger, seeds: h.seeds, accounts: h.accounts, account: h.accounts[0], mode: 'follower', config: h.config, clock: h.clock });
  await run();
  const p = h.ledger.findByUrlname('p_ratio_gt')[0];
  const owner = h.ledger.assignedTo(p.id);
  h.adapter.setLikeBehavior('p_ratio_gt', 'failed');
  const r = await h.runner.start({ accountId: owner, mode: 'follower', dryRun: false });
  await r.promise;
  assert.equal(h.ledger.getTarget(p.id, OP.LIKE).state, 'failed_before_send');
  const sm = h.runner.status().lastRun.summary;
  assert.equal(h.limits.status(owner, 'like', h.clock.now()).credits, 50 - (sm.succeeded + sm.failedBeforeSend + sm.unknown), '送信開始時に消費した枠は戻さない（確定失敗でも記録として残る）');
  await run();
  assert.equal(h.ledger.getTarget(p.id, OP.LIKE).state, 'candidate');
});

test('更新収集で本人不一致・取得失敗になった候補は、前回の値で採用にならない', async () => {
  const h = harness();
  const { seed } = h.seeds.add({ mode: 'follower', url: 'https://note.com/bold_cobra8451' }, h.nowIso);
  await h.seeds.verify(seed.id, h.adapter, h.nowIso, h.config);
  const run = () => collect({ adapter: h.adapter, ledger: h.ledger, seeds: h.seeds, accounts: h.accounts, account: h.accounts[0], mode: 'follower', config: h.config, clock: h.clock });
  await run();
  const p = h.ledger.findByUrlname('p_ratio_gt')[0];
  const owner = h.ledger.assignedTo(p.id);
  assert.equal(h.ledger.getEvaluation(p.id, 'follower', owner).verdict, 'adopt');
  // 同じ urlname を別の userId が使うようになった（別人）: 古い行は本人識別が確定しない状態になり、採用のまま残らない
  h.adapter.world.creators.p_ratio_gt.userId = 'someone_else';
  await run();
  const ev = h.ledger.getEvaluation(p.id, 'follower', owner);
  assert.notEqual(ev.verdict, 'adopt');
  assert.ok(ev.reasons.some((r) => r.code === 'urlname_reassigned'));
  assert.equal(h.ledger.getPerson(p.id).identityConfirmed, false);
  assert.ok(h.ledger.identityHistoryOf(p.id).some((x) => x.event === 'urlname_reassigned'));
  const newcomer = h.ledger.findByUrlname('p_ratio_gt').find((x) => x.userId === 'someone_else');
  assert.ok(newcomer && newcomer.id !== p.id, '別人として新しい行になる');
  // 取得失敗（アクセス不可）: 前回の値で採用にならない
  h.adapter.world.creators.p_ratio_gt.userId = 'someone_else';
  h.adapter.world.creators.p_ratio_gt.inaccessible = true;
  await run();
  const ev2 = h.ledger.getEvaluation(newcomer.id, 'follower', h.ledger.assignedTo(newcomer.id) || owner);
  assert.notEqual(ev2.verdict, 'adopt');
  assert.ok(ev2.reasons.some((r) => r.code === 'fetch_error'));
});

test('自分の記事一覧が空でもプロフィールの記事数が正なら「0件」と確定しない', async () => {
  const h = harness();
  const karasu = h.accounts[0];
  h.adapter.world.creators._karasu.notes = [];
  const orig = h.adapter.getCreator.bind(h.adapter);
  h.adapter.getCreator = async (u) => { const c = await orig(u); if (c && u === '_karasu') c.noteCount = 2; return c; };
  const r = await checkModeAvailability({ adapter: h.adapter, account: karasu, mode: 'suki' });
  assert.equal(r.available, false);
  assert.equal(r.code, 'own_notes_unavailable');
  h.adapter.getCreator = orig;
  const r2 = await checkModeAvailability({ adapter: h.adapter, account: karasu, mode: 'suki' });
  assert.equal(r2.code, 'no_own_articles');
});

test('実 note アダプタ: スキ一覧の item がユーザー本体のとき createdAt を反応日時にしない。件数不明は 0 にしない。最終ページ不明は完全扱いしない', async () => {
  const { loadConfig } = require('../shared/config');
  const cfg = loadConfig({ rootDir: ROOT, env: {}, overrides: { requestIntervalMs: 0 } });
  const a = new NoteBrowserAdapter({ config: cfg, accounts: [], clock: fixedClock(NOW) });
  a._getJson = async (tpl) => {
    if (/likes/.test(tpl)) return { data: { likes: [{ urlname: 'bare_user', id: 1, createdAt: '2020/01/01 00:00' }, { user: { urlname: 'wrapped', id: 2 }, createdAt: '2026/10/27 10:00' }], isLastPage: true } };
    if (/contents/.test(tpl)) return { data: { contents: [{ key: 'k1', name: 't', publishAt: '2026/10/20 12:00' }] } };
    if (/followers/.test(tpl)) return { data: { something: 1 } };
    if (/followings/.test(tpl)) return null;
    return null;
  };
  const likes = await a.getNoteLikes('k');
  assert.equal(likes.likers[0].likedAt, null, 'ユーザー作成日時を反応日時に転用しない');
  assert.equal(likes.likers[1].likedAt, '2026-10-27T01:00:00.000Z', 'JST 10:00 → UTC 01:00');
  const notes = await a.getCreatorNotes('x', { limit: 5 });
  assert.equal(notes.notes[0].likeCount, null);
  assert.equal(notes.complete, false, 'isLastPage 不明なら完全とは言わない');
  // 未知の応答形は 0件にせず例外（保留になる）。404 も 0件にしない
  await assert.rejects(() => a.getFollowers('x'), (e) => e.code === 'unrecognized_response');
  await assert.rejects(() => a.getFollowing('x'), (e) => e.code === 'not_found');
});

test('実 note アダプタ: 押下前の例外は送信前失敗、ボタンの class は字句単位で判定（inactive を liked にしない）', async () => {
  const { loadConfig } = require('../shared/config');
  const cfg = loadConfig({ rootDir: ROOT, env: {}, overrides: { requestIntervalMs: 0 } });
  const a = new NoteBrowserAdapter({ config: cfg, accounts: [{ id: 'k', urlname: 'k', cdpPort: 1 }], clock: fixedClock(NOW) });
  const fakeBtn = (cls, pressed = null) => ({ count: async () => 1, getAttribute: async (n) => (n === 'class' ? cls : n === 'aria-pressed' ? pressed : null) });
  a._likeButton = async () => fakeBtn('btn inactive');
  assert.equal(await a._likeState({}), 'not_liked');
  a._likeButton = async () => fakeBtn('btn is-active');
  assert.equal(await a._likeState({}), 'liked');
  a._likeButton = async () => fakeBtn('btn');
  assert.equal(await a._likeState({}), 'unknown');
  a._likeButton = async () => fakeBtn('btn', 'true');
  assert.equal(await a._likeState({}), 'liked');
  // 押下前に例外 → failed（clicked:false）。like() は openAndReadNote を経由するので差し替える
  a.openAndReadNote = async () => ({ blocked: null, bodyRendered: true, _page: { isClosed: () => false, close: async () => {} } });
  a._likeState = async () => { throw new Error('page gone'); };
  const r = await a.like('k', { accountId: 'k', noteUrl: 'https://note.com/x/n/k' });
  assert.equal(r.result, 'failed');
  assert.equal(r.clicked, false);
});

test('ローカルサーバーは他オリジン／専用ヘッダ無しの書き込みを拒否する', async () => {
  const app = makeApp();
  const server = createServer(app);
  const addr = await listen(server, { port: 0 });
  const req = (headers, method = 'POST') => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: addr.port, path: '/api/mode', method, headers: { 'content-type': 'application/json', ...headers } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.end(JSON.stringify({ mode: 'follower' }));
  });
  try {
    assert.equal((await req({})).status, 403, 'ヘッダ無し');
    assert.equal((await req({ 'x-note-tool': '1', origin: 'https://evil.example' })).status, 403, '他オリジン');
    assert.equal((await req({ 'x-note-tool': '1', host: 'evil.example' })).status, 403, 'Host 不一致（DNS リバインディング）');
    assert.equal((await req({ 'x-note-tool': '1' })).status, 200);
    assert.equal((await req({ 'x-note-tool': '1', origin: `http://127.0.0.1:${addr.port}` })).status, 200);
    assert.equal(app.mode, 'follower');
  } finally {
    server.close(); await app.close();
  }
});

test('成果: こちらの操作前から観測されていたフォロワーは「増加」に数えない。スキ日時不明は返しと記録しない', async () => {
  const app = makeApp({ overrides: { enableRealActions: true } });
  app.setConfig({ enableRealActions: true });
  for (const s of app.seeds.list()) if (s.urlname) await app.verifySeed(s.id);
  app.setMode('follower');
  await app.collect();
  // フォロワー獲得候補の p_ratio_gt は、モック世界で元から _karasu のフォロワー（fixture）。フォロー返し収集で観測しておく
  const { collectFollowBack } = require('../shared/follow');
  await collectFollowBack({ adapter: app.adapter, ledger: app.ledger, accounts: app.accounts, account: app.account, config: app.config, clock: app.clock });
  app.clock.advance(60e3);
  await app.startRun({ dryRun: false });
  await app.waitRun();
  const succeeded = app.ledger.listTargets({ accountId: 'karasu', state: 'succeeded' });
  const pre = succeeded.find((t) => app.ledger.getPerson(t.personId).urlname === 'p_ratio_gt');
  if (pre) {
    app.adapter.addLike('k2', 'p_ratio_gt', null); // 日時不明
    const r = await app.checkOutcomes('karasu');
    assert.equal(r.followGainedNew, 0, '元からのフォロワーは増加ではない');
    assert.equal(r.followPreexisting, 1);
    assert.equal(r.sukiReturnNew, 0);
    assert.equal(r.sukiReturnUnconfirmed, 1);
  }
  await app.close();
});

test('CSV/JSON の日時は JST 表記', () => {
  assert.equal(jst('2026-10-27T03:00:00.000Z'), '2026-10-27 12:00:00+09:00');
  assert.equal(jst(null), '');
  const app = makeApp();
  const out = app.export();
  assert.match(path.basename(out.files.rosterCsv), /JST\.csv$/);
  const json = JSON.parse(require('node:fs').readFileSync(out.files.json, 'utf8'));
  assert.equal(json.timezone, 'JST(+09:00)');
});

test('定期実行は設定に関わらず常に OFF と表示される', async () => {
  const app = makeApp({ overrides: { scheduler: { enabled: true } } });
  assert.equal(app.state().flags.schedulerEnabled, false);
  await app.close();
});
