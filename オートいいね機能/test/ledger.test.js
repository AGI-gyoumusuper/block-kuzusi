'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openDb } = require('../shared/db');
const { Ledger, OP } = require('../shared/ledger');
const { harness, tmpDir, NOW } = require('./helpers');

const T0 = NOW;
const plus = (ms) => new Date(new Date(T0).getTime() + ms).toISOString();

test('人物の同定: userId を優先し、urlname 変更を追跡する。userId 不明なら urlname で統合', () => {
  const { ledger } = harness();
  const a = ledger.upsertPerson({ urlname: 'alice', userId: 'u1', displayName: 'A' }, null, T0);
  assert.equal(a.isNew, true);
  const b = ledger.upsertPerson({ urlname: 'alice_new', userId: 'u1' }, null, plus(1000));
  assert.equal(b.isNew, false);
  assert.equal(b.identityChanged, true);
  assert.equal(b.person.id, a.person.id);
  assert.equal(ledger.getPerson(a.person.id).urlname, 'alice_new');
  assert.ok(ledger.identityHistoryOf(a.person.id).some((h) => h.event === 'urlname_changed' && h.urlname === 'alice'));
  // userId 不明で登録された人に後から userId が付く
  const c = ledger.upsertPerson({ urlname: 'bob' }, null, T0);
  const d = ledger.upsertPerson({ urlname: 'bob', userId: 'u2' }, null, T0);
  assert.equal(d.person.id, c.person.id);
  assert.equal(ledger.getPerson(c.person.id).userId, 'u2');
  // 同じ urlname でも userId が異なれば別人
  const e = ledger.upsertPerson({ urlname: 'bob', userId: 'u3' }, null, T0);
  assert.notEqual(e.person.id, c.person.id);
});

test('出所の統合: 同じ人が複数の出所に現れても候補は一人。反応日時は取得できた値のみ上書き', () => {
  const { ledger } = harness();
  const src = (over) => ({ mode: 'suki', listType: 'note_likes', seedUrl: 'https://note.com/s', seedNoteUrl: 'https://note.com/s/n/1', seedVerified: true, reactionAt: null, listPosition: 0, ...over });
  const r1 = ledger.upsertPerson({ urlname: 'p', userId: 'u' }, src({ reactionAt: plus(-3600e3), reactionEvidence: '一覧のスキ日時' }), T0);
  const r2 = ledger.upsertPerson({ urlname: 'p', userId: 'u' }, src({ reactionAt: null }), plus(60e3));
  assert.equal(r2.isNew, false);
  assert.equal(r2.sourceIsNew, false);
  const sources = ledger.sourcesOf(r1.person.id);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].reactionAt, plus(-3600e3), '反応日時不明の更新で既知の反応日時を消さない');
  assert.equal(sources[0].lastSeenAt, plus(60e3));
  const r3 = ledger.upsertPerson({ urlname: 'p', userId: 'u' }, { mode: 'follower', listType: 'followers', seedUrl: 'https://note.com/f', seedVerified: true, listPosition: 3 }, T0);
  assert.equal(r3.sourceIsNew, true);
  assert.equal(ledger.listPersons().length, 1);
  assert.equal(ledger.sourcesOf(r1.person.id).length, 2);
});

test('担当は一人に一つ。偏りを抑えて割り当て、既存の担当は変更しない', () => {
  const { ledger } = harness();
  const ids = ['karasu', 'koisi', 'pengi'];
  const people = [];
  for (let i = 0; i < 7; i++) people.push(ledger.upsertPerson({ urlname: `p${i}`, userId: `u${i}` }, null, T0).person.id);
  const got = people.map((pid) => ledger.assignBalanced(pid, ids, {}, T0).accountId);
  const counts = ledger.assignmentCounts();
  assert.deepEqual(Object.values(counts).sort(), [2, 2, 3]);
  const again = ledger.assignBalanced(people[0], ['pengi'], {}, T0);
  assert.equal(again.created, false);
  assert.equal(again.accountId, got[0], '再割当しない');
  assert.equal(ledger.assignBalanced(99, [], {}, T0).ok, false);
});

test('状態機械: candidate → reserved → sending → 終端。reserved からしか sending に入れず、sending は release で戻らない', () => {
  const { ledger } = harness();
  const pid = ledger.upsertPerson({ urlname: 'p', userId: 'u' }, null, T0).person.id;
  ledger.assignBalanced(pid, ['karasu'], {}, T0);
  assert.equal(ledger.ensureCandidate(pid, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, T0).state, 'candidate');
  assert.equal(ledger.markSending(pid, OP.LIKE, 'r1', { noteKey: 'n' }, T0), false, 'candidate から直接 sending にできない');
  assert.equal(ledger.reserve(pid, OP.LIKE, 'koisi', 'r1', T0, 60e3).code, 'assigned_other');
  assert.equal(ledger.reserve(pid, OP.LIKE, 'karasu', 'r1', T0, 60e3).ok, true);
  assert.equal(ledger.reserve(pid, OP.LIKE, 'karasu', 'r2', T0, 60e3).code, 'reserved_by_other_run');
  assert.equal(ledger.finish(pid, OP.LIKE, 'r2', { state: 'succeeded' }, T0), false, '別 run は終了させられない');
  assert.equal(ledger.markSending(pid, OP.LIKE, 'r1', { noteKey: 'n', noteUrl: 'https://note.com/p/n/n' }, T0), true);
  assert.equal(ledger.releaseReservation(pid, OP.LIKE, 'r1', 'x', T0), false, 'sending は candidate に戻せない');
  // 期限切れでも sending は他 run に渡らない
  assert.equal(ledger.reserve(pid, OP.LIKE, 'karasu', 'r3', plus(3600e3), 60e3).code, 'state_sending');
  assert.equal(ledger.finish(pid, OP.LIKE, 'r1', { state: 'unknown', reasonCode: 'timeout' }, T0), true);
  assert.equal(ledger.likeState(pid), 'unknown');
  assert.equal(ledger.ensureCandidate(pid, OP.LIKE, { accountId: 'karasu', mode: 'suki', reopen: true }, T0).state, 'unknown', 'unknown は再収集でも候補に戻らない');
  // 状態照合で確定
  assert.equal(ledger.resolveUnknown(pid, OP.LIKE, 'unknown', {}, T0).ok, false);
  assert.equal(ledger.resolveUnknown(pid, OP.LIKE, 'liked', { by: 'test' }, T0).state, 'succeeded');
  assert.equal(ledger.likeState(pid), 'liked');
  assert.equal(ledger.ensureCandidate(pid, OP.LIKE, { accountId: 'karasu', mode: 'suki', reopen: true }, T0).state, 'succeeded', '成功は再対象化しない');
  assert.throws(() => ledger.finish(pid, OP.LIKE, 'r1', { state: 'candidate' }, T0));
});

test('期限切れの予約（sending 前）は同じ担当の別 run が取り直せる。skipped は再収集で候補に戻せる', () => {
  const { ledger } = harness();
  const pid = ledger.upsertPerson({ urlname: 'p', userId: 'u' }, null, T0).person.id;
  ledger.ensureCandidate(pid, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, T0);
  assert.equal(ledger.reserve(pid, OP.LIKE, 'karasu', 'r1', T0, 60e3).ok, true);
  assert.equal(ledger.reserve(pid, OP.LIKE, 'karasu', 'r2', plus(30e3), 60e3).ok, false);
  const r = ledger.reserve(pid, OP.LIKE, 'karasu', 'r2', plus(61e3), 60e3);
  assert.equal(r.ok, true);
  assert.equal(r.code, 'reserved_after_expiry');
  assert.equal(ledger.finish(pid, OP.LIKE, 'r2', { state: 'skipped', reasonCode: 'inactive' }, T0), true);
  assert.equal(ledger.ensureCandidate(pid, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, T0).state, 'skipped');
  assert.equal(ledger.ensureCandidate(pid, OP.LIKE, { accountId: 'karasu', mode: 'suki', reopen: true }, T0).state, 'candidate');
});

test('同時起動: 同じファイルDBを開いた二つの台帳が同じ対象を予約しても一方しか取れない', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.sqlite3');
  const l1 = new Ledger(openDb(file));
  const l2 = new Ledger(openDb(file));
  const pid = l1.upsertPerson({ urlname: 'p', userId: 'u' }, null, T0).person.id;
  l1.ensureCandidate(pid, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, T0);
  const a = l1.reserve(pid, OP.LIKE, 'karasu', 'runA', T0, 60e3);
  const b = l2.reserve(pid, OP.LIKE, 'karasu', 'runB', T0, 60e3);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  assert.equal(l2.getTarget(pid, OP.LIKE).runId, 'runA');
  // 実行ロックも一つだけ
  assert.equal(l1.acquireExecutorLock('karasu:runA', T0, 60e3).ok, true);
  assert.equal(l2.acquireExecutorLock('koisi:runB', T0, 60e3).ok, false);
  assert.equal(l2.acquireExecutorLock('koisi:runB', plus(61e3), 60e3).ok, true, '期限切れは取れる');
  l1.db.close(); l2.db.close();
});

test('再起動復旧: sending は unknown に、reserved は candidate に戻る。run は interrupted', () => {
  const { ledger } = harness();
  const p1 = ledger.upsertPerson({ urlname: 'p1', userId: 'u1' }, null, T0).person.id;
  const p2 = ledger.upsertPerson({ urlname: 'p2', userId: 'u2' }, null, T0).person.id;
  ledger.createRun({ id: 'r1', accountId: 'karasu', mode: 'suki', dryRun: false }, T0);
  ledger.ensureCandidate(p1, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, T0);
  ledger.ensureCandidate(p2, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, T0);
  ledger.reserve(p1, OP.LIKE, 'karasu', 'r1', T0, 60e3);
  ledger.markSending(p1, OP.LIKE, 'r1', { noteKey: 'n' }, T0);
  ledger.reserve(p2, OP.LIKE, 'karasu', 'r1', T0, 60e3);
  const r = ledger.recoverOnStartup(plus(1000), []);
  assert.deepEqual(r, { sendingToUnknown: 1, reservedReleased: 1, runsInterrupted: 1 });
  assert.equal(ledger.getTarget(p1, OP.LIKE).state, 'unknown');
  assert.equal(ledger.getTarget(p2, OP.LIKE).state, 'candidate');
  assert.equal(ledger.getRun('r1').state, 'interrupted');
  // 実行中の run を指定すれば触らない
  ledger.reserve(p2, OP.LIKE, 'karasu', 'r2', T0, 60e3);
  assert.deepEqual(ledger.recoverOnStartup(plus(2000), ['r2']).reservedReleased, 0);
});

test('除外リストは urlname または userId で一致する', () => {
  const { ledger } = harness();
  ledger.addExclusion({ urlname: 'x', userId: 'ux', reason: 'test' }, T0);
  assert.equal(ledger.isExcluded({ urlname: 'x', userId: null }), true);
  assert.equal(ledger.isExcluded({ urlname: 'x_renamed', userId: 'ux' }), true);
  assert.equal(ledger.isExcluded({ urlname: 'y', userId: 'uy' }), false);
  ledger.removeExclusion('x');
  assert.equal(ledger.isExcluded({ urlname: 'x', userId: 'ux' }), false);
});

test('履歴キーは操作種別を含む: スキとフォロー返しは別に記録される', () => {
  const { ledger } = harness();
  const pid = ledger.upsertPerson({ urlname: 'p', userId: 'u' }, null, T0).person.id;
  ledger.ensureCandidate(pid, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, T0);
  ledger.ensureCandidate(pid, OP.FOLLOW_BACK, { accountId: 'karasu', mode: null }, T0);
  ledger.reserve(pid, OP.LIKE, 'karasu', 'r1', T0, 60e3);
  ledger.markSending(pid, OP.LIKE, 'r1', { noteKey: 'n' }, T0);
  ledger.finish(pid, OP.LIKE, 'r1', { state: 'succeeded' }, T0);
  assert.equal(ledger.getTarget(pid, OP.LIKE).state, 'succeeded');
  assert.equal(ledger.getTarget(pid, OP.FOLLOW_BACK).state, 'candidate');
  const ex = ledger.explain(pid);
  assert.equal(ex.targets.like.state, 'succeeded');
  assert.equal(ex.targets.follow_back.state, 'candidate');
});
