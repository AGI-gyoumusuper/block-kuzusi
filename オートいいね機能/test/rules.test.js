'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkActivity, checkFollowRatio, chooseLatestNote, reactionEvidence, evaluateCandidate } = require('../shared/rules');
const { DAY_MS, HOUR_MS } = require('../shared/clock');

const now = new Date('2026-10-27T03:00:00.000Z');
const iso = (ms) => new Date(now.getTime() + ms).toISOString();

test('E.3 活動条件の境界: 13日23時間は合格、14日ちょうど・15日前・日時不明・未来は不合格', () => {
  assert.equal(checkActivity(iso(-(13 * DAY_MS + 23 * HOUR_MS)), now).ok, true);
  const exact = checkActivity(iso(-14 * DAY_MS), now);
  assert.equal(exact.ok, false);
  assert.equal(exact.code, 'inactive');
  assert.equal(checkActivity(iso(-15 * DAY_MS), now).code, 'inactive');
  assert.equal(checkActivity(null, now).code, 'date_unknown');
  assert.equal(checkActivity('not a date', now).code, 'date_unknown');
  assert.equal(checkActivity(iso(DAY_MS), now).code, 'future_date');
  // 14日未満ぎりぎり（14日 - 1ms）
  assert.equal(checkActivity(iso(-(14 * DAY_MS - 1)), now).ok, true);
});

test('E.2 フォロー数/フォロワー数の判定: 多い=採用、同数=不採用、少ない=不採用、不明=保留（0で埋めない）', () => {
  assert.equal(checkFollowRatio(500, 200).ok, true);
  assert.equal(checkFollowRatio(101, 100).ok, true);
  const eq = checkFollowRatio(100, 100);
  assert.equal(eq.ok, false); assert.equal(eq.hold, false); assert.equal(eq.code, 'equal');
  const lt = checkFollowRatio(50, 900);
  assert.equal(lt.ok, false); assert.equal(lt.code, 'following_lt_follower');
  const unk = checkFollowRatio(null, 120);
  assert.equal(unk.ok, false); assert.equal(unk.hold, true); assert.equal(unk.code, 'counts_unknown');
  assert.equal(checkFollowRatio(undefined, 0).code, 'counts_unknown');
  assert.equal(checkFollowRatio('500', 200).code, 'counts_unknown');
  assert.equal(checkFollowRatio(1, 0).ok, true);
});

test('E.4 固定記事が古い場合は公開日時が最新の通常投稿を選ぶ。固定記事が最新ならその根拠を付ける', () => {
  const r = chooseLatestNote({ notes: [
    { key: 'pin', publishedAt: iso(-60 * DAY_MS), updatedAt: iso(-DAY_MS), isPinned: true },
    { key: 'new', publishedAt: iso(-2 * DAY_MS), isPinned: false },
  ], complete: true });
  assert.equal(r.note.key, 'new');
  assert.equal(r.pinnedIsLatest, false);
  assert.equal(r.note_updated_only_ignored, true, '古い記事の更新は無視される');
  const r2 = chooseLatestNote({ notes: [
    { key: 'pin', publishedAt: iso(-DAY_MS), isPinned: true },
    { key: 'old', publishedAt: iso(-5 * DAY_MS) },
  ], complete: true });
  assert.equal(r2.note.key, 'pin');
  assert.equal(r2.pinnedIsLatest, true);
  assert.match(r2.evidence, /固定記事だが/);
});

test('最新記事の確定: 日時不明の記事が混ざれば確定しない。全件未取得で順序保証なしなら確定しない', () => {
  assert.equal(chooseLatestNote({ notes: [{ key: 'a', publishedAt: null }, { key: 'b', publishedAt: iso(-DAY_MS) }], complete: true }).code, 'date_unknown');
  assert.equal(chooseLatestNote({ notes: [], complete: true }).code, 'no_notes');
  assert.equal(chooseLatestNote({ notes: [{ key: 'b', publishedAt: iso(-DAY_MS) }], complete: false, orderClaim: 'unknown' }).code, 'notes_incomplete');
  assert.equal(chooseLatestNote({ notes: [{ key: 'b', publishedAt: iso(-DAY_MS) }], complete: false, orderClaim: 'published_desc' }).code, 'ok');
});

test('E.5 反応日時が無ければ unknown。収集日時や一覧順を反応日時に転用しない', () => {
  const ev = reactionEvidence([{ reactionAt: null, firstDiscoveredAt: iso(0), listPosition: 0 }]);
  assert.equal(ev.status, 'unknown');
  assert.equal(ev.reactionAt, null);
  const ev2 = reactionEvidence([{ reactionAt: null, orderEvidence: '取得元が新しい順と明示', listPosition: 2 }]);
  assert.equal(ev2.status, 'order_only');
  assert.equal(ev2.reactionAt, null);
  const ev3 = reactionEvidence([{ reactionAt: iso(-HOUR_MS), reactionEvidence: 'スキ一覧の反応日時' }, { reactionAt: iso(-5 * HOUR_MS) }]);
  assert.equal(ev3.status, 'known');
  assert.equal(ev3.reactionAt, iso(-HOUR_MS));
});

function roster(over = {}) {
  return { isExcluded: () => false, likeState: () => 'none', assignedTo: () => null, ...over };
}
function cand(over = {}) {
  return {
    id: 1, urlname: 'p', userId: 'u', displayName: 'p',
    sources: [{ listType: 'note_likes', seedVerified: true, reactionAt: null, listPosition: 0 }, { listType: 'followers', seedVerified: true, listPosition: 0 }],
    followingCount: 300, followerCount: 100,
    latestNote: { code: 'ok', note: { key: 'n', publishedAt: iso(-3 * DAY_MS) } },
    ...over,
  };
}
const ctx = (over = {}) => ({ mode: 'follower', now, config: { activityWindowDays: 14 }, ownUrlnames: ['_karasu'], accountId: 'karasu', roster: roster(), ...over });

test('evaluateCandidate: 両モードで採用される基本ケース', () => {
  assert.equal(evaluateCandidate(cand(), ctx()).verdict, 'adopt');
  assert.equal(evaluateCandidate(cand(), ctx({ mode: 'suki' })).verdict, 'adopt');
});

test('evaluateCandidate: 出所が無いモードでは採用しない（スキ一覧とフォロワー一覧を取り違えない）', () => {
  const onlyLikes = cand({ sources: [{ listType: 'note_likes', seedVerified: true }] });
  assert.equal(evaluateCandidate(onlyLikes, ctx({ mode: 'suki' })).verdict, 'adopt');
  const r = evaluateCandidate(onlyLikes, ctx({ mode: 'follower' }));
  assert.equal(r.verdict, 'reject');
  assert.ok(r.reasons.some((x) => x.code === 'no_source_for_mode'));
  const unverifiedSeed = cand({ sources: [{ listType: 'note_likes', seedVerified: false }] });
  assert.equal(evaluateCandidate(unverifiedSeed, ctx({ mode: 'suki' })).verdict, 'reject');
});

test('evaluateCandidate: 共通除外（自アカウント・除外リスト・実施済み・結果不明・他担当）', () => {
  assert.ok(evaluateCandidate(cand({ urlname: '_karasu' }), ctx()).reasons.some((r) => r.code === 'own_account'));
  assert.ok(evaluateCandidate(cand(), ctx({ roster: roster({ isExcluded: () => true }) })).reasons.some((r) => r.code === 'excluded'));
  assert.ok(evaluateCandidate(cand(), ctx({ roster: roster({ likeState: () => 'liked' }) })).reasons.some((r) => r.code === 'already_liked'));
  assert.ok(evaluateCandidate(cand(), ctx({ roster: roster({ likeState: () => 'unknown' }) })).reasons.some((r) => r.code === 'result_unknown'));
  const other = evaluateCandidate(cand(), ctx({ roster: roster({ assignedTo: () => 'pengi' }) }));
  assert.equal(other.verdict, 'reject');
  assert.ok(other.reasons.some((r) => r.code === 'assigned_other'));
  // 自分が担当なら問題ない。accountId 未指定（モード適合の評価）なら担当チェックをしない
  assert.equal(evaluateCandidate(cand(), ctx({ roster: roster({ assignedTo: () => 'karasu' }) })).verdict, 'adopt');
  assert.equal(evaluateCandidate(cand(), ctx({ accountId: null, roster: roster({ assignedTo: () => 'pengi' }) })).verdict, 'adopt');
});

test('evaluateCandidate: スキ獲得でも14日条件を適用し、追加要件と明示する', () => {
  const r = evaluateCandidate(cand({ latestNote: { code: 'ok', note: { key: 'n', publishedAt: iso(-15 * DAY_MS) } } }), ctx({ mode: 'suki' }));
  assert.equal(r.verdict, 'reject');
  const reason = r.reasons.find((x) => x.code === 'inactive');
  assert.match(reason.message, /追加要件/);
});

test('evaluateCandidate: 証拠必須設定が有効なら反応日時不明は保留、無効なら採用（情報として記録）', () => {
  const c = cand();
  const off = evaluateCandidate(c, ctx({ mode: 'suki', config: { requireReactionEvidence: false } }));
  assert.equal(off.verdict, 'adopt');
  assert.ok(off.reasons.some((r) => r.code === 'reaction_unknown' && r.level === 'info'));
  const on = evaluateCandidate(c, ctx({ mode: 'suki', config: { requireReactionEvidence: true } }));
  assert.equal(on.verdict, 'hold');
  assert.ok(on.reasons.some((r) => r.code === 'reaction_evidence_missing'));
});

test('evaluateCandidate: フォロワー獲得は比率条件。同数は不採用、不明は保留', () => {
  assert.equal(evaluateCandidate(cand({ followingCount: 100, followerCount: 100 }), ctx()).verdict, 'reject');
  assert.equal(evaluateCandidate(cand({ followingCount: null, followerCount: 100 }), ctx()).verdict, 'hold');
  // スキ獲得モードでは比率条件を課さない
  assert.equal(evaluateCandidate(cand({ followingCount: 10, followerCount: 1000 }), ctx({ mode: 'suki' })).verdict, 'adopt');
});

test('evaluateCandidate: 最新記事が未取得・日時不明・未来なら保留、記事なしは不採用', () => {
  assert.equal(evaluateCandidate(cand({ latestNote: null }), ctx()).verdict, 'hold');
  assert.equal(evaluateCandidate(cand({ latestNote: { code: 'date_unknown', note: null, message: '不明' } }), ctx()).verdict, 'hold');
  assert.equal(evaluateCandidate(cand({ latestNote: { code: 'no_notes', note: null, message: '記事なし' } }), ctx()).verdict, 'reject');
  assert.equal(evaluateCandidate(cand({ latestNote: { code: 'ok', note: { key: 'n', publishedAt: iso(DAY_MS) } } }), ctx()).verdict, 'hold');
});
