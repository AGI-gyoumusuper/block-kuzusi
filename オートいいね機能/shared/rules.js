'use strict';

/**
 * 選定規則（純粋関数）。時計は引数で受け取り、現在時刻を内部で生成しない。
 * 依頼書の出典は criteria.js にまとめる。
 */

const { DAY_MS, parseDate } = require('./clock');

const DEFAULT_ACTIVITY_WINDOW_DAYS = 14;

const MODES = Object.freeze({ SUKI: 'suki', FOLLOWER: 'follower' });
const LIST_TYPES = Object.freeze({ NOTE_LIKES: 'note_likes', FOLLOWERS: 'followers' });
const MODE_LIST_TYPE = Object.freeze({ suki: 'note_likes', follower: 'followers' });

function isMode(v) { return v === MODES.SUKI || v === MODES.FOLLOWER; }

function isKnownCount(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * 活動条件: 0 <= 現在時刻 - 最新公開日時 < windowDays 日
 * 14日ちょうど以上・未来日時・日時不明は不合格。
 */
function checkActivity(latestPublishedAt, now, windowDays = DEFAULT_ACTIVITY_WINDOW_DAYS) {
  const published = parseDate(latestPublishedAt);
  if (!published) {
    return { ok: false, code: 'date_unknown', hold: true, message: '最新公開日時が不明' };
  }
  const diff = now.getTime() - published.getTime();
  if (diff < 0) {
    return { ok: false, code: 'future_date', hold: true, message: '最新公開日時が未来（データ不整合）', ageMs: diff };
  }
  if (diff >= windowDays * DAY_MS) {
    return { ok: false, code: 'inactive', hold: false, message: `最新投稿が${windowDays}日以上前`, ageMs: diff };
  }
  return { ok: true, code: 'active', message: `最新投稿が${windowDays}日未満`, ageMs: diff };
}

/**
 * フォロワー獲得モードの相手条件: フォロー数 > フォロワー数（厳密）。
 * 同数は不採用。どちらかが不明・省略表記なら保留（0で埋めない）。
 */
function checkFollowRatio(followingCount, followerCount) {
  if (!isKnownCount(followingCount) || !isKnownCount(followerCount)) {
    return { ok: false, hold: true, code: 'counts_unknown', message: 'フォロー数またはフォロワー数が不明・省略表記のため保留' };
  }
  if (followingCount > followerCount) {
    return { ok: true, hold: false, code: 'following_gt_follower', message: 'フォロー数がフォロワー数より多い' };
  }
  if (followingCount === followerCount) {
    return { ok: false, hold: false, code: 'equal', message: 'フォロー数とフォロワー数が同数のため不採用' };
  }
  return { ok: false, hold: false, code: 'following_lt_follower', message: 'フォロー数がフォロワー数より少ないため不採用' };
}

/**
 * 最新の通常投稿を公開日時で確定する。
 * - 固定記事を「一番上だから最新」と扱わない
 * - 更新日時ではなく初回公開日時で比較する
 * - 公開日時不明の記事が混ざる場合、最新を確定できないので保留
 * - 一覧が全件でなく、取得元が公開日時降順を明示していない場合も保留
 *
 * notesResult: { notes: [{ key, url, title, publishedAt, updatedAt, isPinned }], complete, orderClaim }
 */
function chooseLatestNote(notesResult) {
  const notes = notesResult && Array.isArray(notesResult.notes) ? notesResult.notes : [];
  if (notes.length === 0) {
    return { note: null, code: 'no_notes', message: '公開記事なし' };
  }
  const unknownDates = notes.filter((n) => !parseDate(n.publishedAt));
  if (unknownDates.length > 0) {
    return {
      note: null,
      code: 'date_unknown',
      message: `公開日時不明の記事が${unknownDates.length}件あり最新記事を確定できない`,
    };
  }
  if (notesResult.complete === false && notesResult.orderClaim !== 'published_desc') {
    return {
      note: null,
      code: 'notes_incomplete',
      message: '記事一覧が全件でなく、取得元が公開日時順を明示していないため最新を確定できない',
    };
  }
  let best = null;
  for (const n of notes) {
    if (!best || parseDate(n.publishedAt) > parseDate(best.publishedAt)) best = n;
  }
  const pinnedIsLatest = !!best.isPinned;
  const evidence = pinnedIsLatest
    ? '固定記事だが、公開日時が取得済み記事の中で最新であることを確認'
    : '公開日時が最新の通常投稿';
  const updatedOnly = notes.some((n) => n !== best && parseDate(n.updatedAt) && parseDate(n.updatedAt) > parseDate(best.publishedAt));
  return {
    note: best,
    code: 'ok',
    evidence,
    pinnedIsLatest,
    coverage: notesResult.complete === false ? 'partial' : 'all',
    note_updated_only_ignored: updatedOnly,
  };
}

/**
 * 出所（sources）から「最近の反応」の証拠を取り出す。
 * - reactionAt があれば known
 * - 一覧の時系列順が取得元で確認できていれば order_only
 * - どちらもなければ unknown（収集日時を反応日時に転用しない）
 */
function reactionEvidence(sources) {
  const withTime = sources.filter((s) => parseDate(s.reactionAt));
  if (withTime.length > 0) {
    const latest = withTime.reduce((a, b) => (parseDate(a.reactionAt) >= parseDate(b.reactionAt) ? a : b));
    return { status: 'known', reactionAt: latest.reactionAt, evidence: latest.reactionEvidence || 'スキ一覧の反応日時' };
  }
  const ordered = sources.filter((s) => s.orderEvidence);
  if (ordered.length > 0) {
    const s = ordered[0];
    return {
      status: 'order_only',
      reactionAt: null,
      evidence: `${s.orderEvidence}（一覧内の位置 ${s.listPosition != null ? s.listPosition + 1 : '不明'}）`,
    };
  }
  return { status: 'unknown', reactionAt: null, evidence: null };
}

function sourcesForMode(candidate, mode) {
  const listType = MODE_LIST_TYPE[mode];
  return (candidate.sources || []).filter((s) => s.listType === listType && s.seedVerified === true);
}

/**
 * 候補の採否を判定する。
 * ctx: { mode, now, config, ownUrlnames, accountId, roster }
 * 戻り値: { verdict: 'adopt'|'hold'|'reject', reasons: [{level, code, message}], checks }
 */
function evaluateCandidate(candidate, ctx) {
  const { mode, now, config = {}, ownUrlnames = [], accountId, roster } = ctx;
  if (!isMode(mode)) throw new Error(`不明なモード: ${mode}`);
  const reasons = [];
  let verdict = 'adopt';
  const hold = (code, message) => { reasons.push({ level: 'hold', code, message }); if (verdict !== 'reject') verdict = 'hold'; };
  const reject = (code, message) => { reasons.push({ level: 'reject', code, message }); verdict = 'reject'; };
  const info = (code, message) => { reasons.push({ level: 'info', code, message }); };
  const checks = {};

  // 出所
  const srcs = sourcesForMode(candidate, mode);
  checks.sourceCount = srcs.length;
  if (srcs.length === 0) {
    reject('no_source_for_mode', mode === MODES.SUKI
      ? '確認済み起点の記事スキ一覧に出所がない'
      : '確認済み起点のフォロワー一覧に出所がない');
  }

  // 共通除外
  if (ownUrlnames.includes(candidate.urlname)) reject('own_account', '対象アカウント自身');
  if (roster && roster.isExcluded(candidate)) reject('excluded', '除外リスト');
  const likeState = roster ? roster.likeState(candidate) : 'none';
  checks.likeState = likeState;
  if (likeState === 'liked') reject('already_liked', 'スキ実施済み');
  else if (likeState === 'unknown') reject('result_unknown', '送信結果が不明のため再実行しない（状態照合で確定するまで）');
  else if (likeState === 'sending' || likeState === 'reserved') reject('in_progress', '他の実行器が処理中');
  // blocked（外部制限に遭遇した対象）はアカウント側のブロック状態で実行が止まる。解除後の再収集で候補に戻せるよう、ここでは保留にしない
  else if (likeState === 'failed') info('last_attempt_failed', '前回の実行は送信前に失敗（記録あり）。条件を満たせば再び候補になる');
  const assigned = roster ? roster.assignedTo(candidate) : null;
  checks.assignedTo = assigned;
  if (assigned && accountId && assigned !== accountId) reject('assigned_other', `他アカウント（${assigned}）が担当`);

  // フォロワー獲得モード: フォロー数 > フォロワー数
  if (mode === MODES.FOLLOWER) {
    const r = checkFollowRatio(candidate.followingCount, candidate.followerCount);
    checks.followRatio = r;
    if (!r.ok) (r.hold ? hold : reject)(r.code, r.message);
  }

  // 最新記事（公開日時で確定）
  const latest = candidate.latestNote;
  checks.latestNote = latest ? { code: latest.code, key: latest.note ? latest.note.key : null } : null;
  if (!latest) {
    hold('latest_not_fetched', '最新記事が未取得');
  } else if (!latest.note) {
    (latest.code === 'no_notes' ? reject : hold)(latest.code, latest.message);
  }

  // 活動条件（両モード。スキ獲得側は利用者の追加要件）
  const windowDays = config.activityWindowDays || DEFAULT_ACTIVITY_WINDOW_DAYS;
  const act = checkActivity(latest && latest.note ? latest.note.publishedAt : null, now, windowDays);
  checks.activity = act;
  if (!act.ok && !(latest && !latest.note)) {
    const suffix = mode === MODES.SUKI ? '【利用者の追加要件】' : '';
    (act.hold ? hold : reject)(act.code, act.message + suffix);
  }

  // スキ獲得モード: 反応の証拠
  if (mode === MODES.SUKI) {
    const ev = reactionEvidence(srcs);
    checks.reaction = ev;
    if (ev.status === 'unknown') {
      if (config.requireReactionEvidence) hold('reaction_evidence_missing', '最近の反応の証拠がない（証拠必須設定が有効）');
      else info('reaction_unknown', '反応日時不明。出所と最新投稿の活動確認により候補とする');
    } else if (ev.status === 'order_only') {
      info('reaction_order_only', `反応日時は不明だが一覧順の証拠あり: ${ev.evidence}`);
    }
  }

  return { verdict, reasons, checks };
}

/**
 * フォロー返しの採否（フォルダ2要件 §1）。実行直前に全条件を満たすこと。
 * ctx: { now, config, ownUrlnames, accountId, roster, relationship }
 *   relationship: { targetFollowsMe: true|false|null, iFollowTarget: true|false|null, evidence, checkedAt }  （現在の関係。過去の通知で推定しない）
 *   roster: { isExcluded(c), followState(c), assignedTo(c) }
 * like を先にしたことだけを理由に follow を排除しない（同 owner なら like と follow は別 action として各1回）。
 */
function evaluateFollowBack(candidate, ctx) {
  const { now, config = {}, ownUrlnames = [], accountId, roster, relationship } = ctx;
  const reasons = [];
  let verdict = 'adopt';
  const hold = (code, message) => { reasons.push({ level: 'hold', code, message }); if (verdict !== 'reject') verdict = 'hold'; };
  const reject = (code, message) => { reasons.push({ level: 'reject', code, message }); verdict = 'reject'; };
  const info = (code, message) => { reasons.push({ level: 'info', code, message }); };
  const checks = { relationship: relationship || null };

  if (ownUrlnames.includes(candidate.urlname)) reject('own_account', '対象アカウント自身');
  if (roster && roster.isExcluded(candidate)) reject('excluded', '除外リスト');
  if (!candidate.userId) hold('user_id_unknown', '安定した userId が未取得のため本人識別が確定しない');

  const followState = roster && roster.followState ? roster.followState(candidate) : 'none';
  checks.followState = followState;
  if (followState === 'followed') reject('already_followed', 'フォロー返し実施済み');
  else if (followState === 'unknown') reject('result_unknown', '送信結果が不明のため再実行しない（状態照合で確定するまで）');
  else if (followState === 'sending' || followState === 'reserved') reject('in_progress', '他の実行器が処理中');
  // blocked はアカウント側のブロック状態で実行が止まる。解除後の再収集で候補に戻せるよう、ここでは保留にしない
  else if (followState === 'failed') info('last_attempt_failed', '前回の実行は送信前に失敗（記録あり）。条件を満たせば再び候補になる');

  const likeState = roster && roster.likeState ? roster.likeState(candidate) : 'none';
  checks.likeState = likeState;
  if (likeState === 'liked') info('liked_before', 'スキ実施済みだが、follow は別 action として判定する');

  // 現在の関係（通知ではなく現在の一覧・状態で確認）
  if (!relationship) hold('relationship_unverified', '現在のフォロー関係を確認できない');
  else {
    if (relationship.targetFollowsMe === true) info('follows_me', `相手が現在こちらをフォローしている（${relationship.evidence || '確認方法不明'}）`);
    else if (relationship.targetFollowsMe === false) reject('not_following_me', '相手は現在こちらをフォローしていない');
    else hold('follows_me_unverified', '相手がこちらをフォローしているか確認できない');
    if (relationship.iFollowTarget === false) info('not_following_yet', 'こちらはまだ相手をフォローしていない');
    else if (relationship.iFollowTarget === true) reject('already_following', 'こちらは既に相手をフォローしている');
    else hold('my_follow_unverified', 'こちらが相手をフォローしているか確認できない');
  }

  // owner（担当）。既存 owner が別アカウントなら競合扱い。自動移管しない
  const assigned = roster ? roster.assignedTo(candidate) : null;
  checks.assignedTo = assigned;
  if (assigned && accountId && assigned !== accountId) reject('owner_conflict', `担当（owner）は ${assigned}。相手がこのアカウントをフォローしていても返さない（owner の自動移管は禁止）`);

  // 最新記事（公開日時で確定）と活動条件（14日: 利用者追加の共通活動条件）
  const latest = candidate.latestNote;
  checks.latestNote = latest ? { code: latest.code, key: latest.note ? latest.note.key : null } : null;
  if (!latest) hold('latest_not_fetched', '最新記事が未取得');
  else if (!latest.note) (latest.code === 'no_notes' ? reject : hold)(latest.code, latest.message);
  const windowDays = config.activityWindowDays || DEFAULT_ACTIVITY_WINDOW_DAYS;
  const act = checkActivity(latest && latest.note ? latest.note.publishedAt : null, now, windowDays);
  checks.activity = act;
  if (!act.ok && !(latest && !latest.note)) (act.hold ? hold : reject)(act.code, `${act.message}【利用者追加の共通活動条件】`);

  return { verdict, reasons, checks };
}

module.exports = {
  evaluateFollowBack,
  MODES,
  LIST_TYPES,
  MODE_LIST_TYPE,
  DEFAULT_ACTIVITY_WINDOW_DAYS,
  isMode,
  isKnownCount,
  checkActivity,
  checkFollowRatio,
  chooseLatestNote,
  reactionEvidence,
  sourcesForMode,
  evaluateCandidate,
};
