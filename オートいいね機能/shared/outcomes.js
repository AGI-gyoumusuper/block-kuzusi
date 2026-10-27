'use strict';

/**
 * 成果の記録（操作件数とは別）。
 *  - スキ返し: 成功した相手が、自分の記事にスキしたことを確認できた場合のみ記録
 *  - フォロー増加: 成功した相手が、自分のフォロワー一覧に現れたことを確認できた場合のみ記録
 * 全体のフォロワー数が増えたことを本ツールの効果と断定しない。確認できた相手との一致だけを保存する。
 */

const { OP } = require('./ledger');
const { parseDate } = require('./clock');

async function checkOutcomes({ adapter, ledger, account, clock, config }) {
  const nowIso = clock.now().toISOString();
  const succeeded = ledger.listTargets({ opType: OP.LIKE, accountId: account.id, state: 'succeeded' });
  const byUrlname = new Map();
  const byUserId = new Map();
  for (const t of succeeded) {
    const p = ledger.getPerson(t.personId);
    if (!p) continue;
    byUrlname.set(p.urlname, { person: p, target: t });
    if (p.userId) byUserId.set(String(p.userId), { person: p, target: t });
  }
  const result = { checkedAt: nowIso, succeededTargets: succeeded.length, sukiReturnNew: 0, sukiReturnTotal: 0, followGainedNew: 0, followGainedTotal: 0, notes: [], errors: [] };
  if (succeeded.length === 0) return result;

  // スキ返し
  try {
    const notesRes = await adapter.getCreatorNotes(account.urlname, { limit: 50 });
    for (const note of notesRes.notes || []) {
      const likes = await adapter.getNoteLikes(note.key, { limit: config.likesPerNoteLimit || 100 });
      for (const liker of likes.likers) {
        const hit = (liker.userId && byUserId.get(String(liker.userId))) || byUrlname.get(liker.urlname);
        if (!hit) continue;
        const likedAt = liker.likedAt ? parseDate(liker.likedAt) : null;
        const after = hit.target.finishedAt ? parseDate(hit.target.finishedAt) : null;
        // 反応日時が分かり、こちらの成功より前なら「返し」とは言えないので記録しない
        if (likedAt && after && likedAt < after) continue;
        const created = ledger.recordOutcome(hit.person.id, account.id, 'suki_return', {
          noteKey: note.key, noteUrl: note.url, likedAt: liker.likedAt || null, matchedBy: liker.userId ? 'userId' : 'urlname',
          causality: likedAt ? 'こちらの成功後にスキ日時あり' : 'スキ日時不明（順序は未確認）',
        }, nowIso);
        result.sukiReturnTotal++;
        if (created) result.sukiReturnNew++;
      }
    }
  } catch (e) {
    result.errors.push(`スキ返し確認: ${e.message}`);
  }

  // フォロー増加
  try {
    const fol = await adapter.getFollowers(account.urlname, { limit: config.followersLimit || 200 });
    for (const f of fol.followers) {
      const hit = (f.userId && byUserId.get(String(f.userId))) || byUrlname.get(f.urlname);
      if (!hit) continue;
      const created = ledger.recordOutcome(hit.person.id, account.id, 'follow_gained', {
        observedAt: nowIso, matchedBy: f.userId ? 'userId' : 'urlname', causality: 'フォロー日時は取得できないため、こちらの操作との因果は断定しない',
      }, nowIso);
      result.followGainedTotal++;
      if (created) result.followGainedNew++;
    }
    if (!fol.complete) result.notes.push('フォロワー一覧が全件でないため一致は部分的');
  } catch (e) {
    result.errors.push(`フォロー増加確認: ${e.message}`);
  }
  ledger.logEvent({ level: 'info', code: 'outcomes_checked', message: `成果確認: スキ返し ${result.sukiReturnTotal}（新規 ${result.sukiReturnNew}）、フォロー増加 ${result.followGainedTotal}（新規 ${result.followGainedNew}）`, accountId: account.id, data: result }, nowIso);
  return result;
}

module.exports = { checkOutcomes };
