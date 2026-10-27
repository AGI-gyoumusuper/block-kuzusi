'use strict';

/**
 * 候補収集。
 *  スキ獲得:     確認済み起点の記事 → スキした人一覧 → 候補
 *  フォロワー獲得: 確認済み起点のフォロワー一覧 → 候補
 * 取得した人物を共有台帳に統合し（一人一件）、各モードの適合を評価し、適合した人には担当を一つ割り当てる。
 * 新規取得・条件合格・重複除外・活動条件不合格・実行可能の件数は分けて返す。
 */

const { chooseLatestNote, evaluateCandidate, isKnownCount, MODE_LIST_TYPE } = require('./rules');
const { OP } = require('./ledger');

async function sleep(ms) { if (ms > 0) await new Promise((r) => setTimeout(r, ms)); }

/** スキ獲得モードは自分の公開記事が0件なら止める。フォロワー獲得モードは0件でも使える */
async function checkModeAvailability({ adapter, account, mode }) {
  if (mode !== 'suki') return { available: true, code: 'ok', message: 'フォロワー獲得モードは自分の公開記事が0件でも利用できる' };
  let notesRes = null;
  try {
    notesRes = await adapter.getCreatorNotes(account.urlname, { limit: 50 });
  } catch (e) {
    return { available: false, code: 'own_notes_unavailable', message: `自分の記事一覧を取得できない: ${e.message}` };
  }
  const count = notesRes && Array.isArray(notesRes.notes) ? notesRes.notes.length : 0;
  if (count === 0) {
    return { available: false, code: 'no_own_articles', message: 'スキを集める先がない（自分の公開記事が0件）。記事の新規投稿や固定設定は自動で変更しない' };
  }
  return { available: true, code: 'ok', message: `自分の公開記事 ${count} 件`, ownNotes: notesRes.notes };
}

/** 自分側の固定記事と、教材の推奨（150スキ超で次の記事を固定）の提案表示 */
async function ownArticleInfo({ adapter, account, config }) {
  let notesRes;
  try {
    notesRes = await adapter.getCreatorNotes(account.urlname, { limit: 50 });
  } catch (e) {
    return { count: null, error: e.message, pinned: null, suggestion: null };
  }
  const notes = notesRes.notes || [];
  const pinned = notes.find((n) => n.isPinned) || null;
  const threshold = config.pinSuggestionLikeThreshold;
  let suggestion = null;
  if (pinned && threshold != null && pinned.likeCount > threshold) {
    suggestion = `固定記事「${pinned.title}」のスキが ${pinned.likeCount} 件で ${threshold} を超えています。教材では次の記事を固定することが推奨されています（提案のみ。本ツールは固定設定を変更しません）`;
  }
  return { count: notes.length, pinned, suggestion, latest: chooseLatestNote(notesRes).note || null };
}

/** 人物のプロフィールと最新記事を取得して台帳へ反映 */
async function refreshPerson({ adapter, ledger, personId, config, nowIso }) {
  const person = ledger.getPerson(personId);
  const creator = await adapter.getCreator(person.urlname);
  if (!creator) {
    ledger.updateProfile(personId, { lastFetchedAt: nowIso, lastFetchError: 'profile_not_found' });
    return { ok: false, code: 'profile_not_found' };
  }
  if (creator.urlname !== person.urlname) {
    ledger.updateProfile(personId, { lastFetchedAt: nowIso, lastFetchError: 'identity_mismatch' });
    return { ok: false, code: 'identity_mismatch' };
  }
  if (creator.userId && person.userId && String(creator.userId) !== String(person.userId)) {
    ledger.updateProfile(personId, { lastFetchedAt: nowIso, lastFetchError: 'user_id_mismatch' });
    return { ok: false, code: 'user_id_mismatch' };
  }
  const notesRes = await adapter.getCreatorNotes(person.urlname, { limit: config.candidateNotesLimit });
  const latest = chooseLatestNote(notesRes);
  const pinned = (notesRes.notes || []).find((n) => n.isPinned) || null;
  ledger.updateProfile(personId, {
    userId: creator.userId != null ? String(creator.userId) : person.userId,
    displayName: creator.displayName || person.displayName,
    identityConfirmed: true,
    followingCount: isKnownCount(creator.followingCount) ? creator.followingCount : null,
    followerCount: isKnownCount(creator.followerCount) ? creator.followerCount : null,
    countsRaw: creator.countsRaw || null,
    latestNote: latest,
    pinnedNote: pinned,
    notesFetchedAt: nowIso,
    lastFetchedAt: nowIso,
    lastFetchError: null,
  });
  return { ok: true, latest };
}

function classify(stats, ev) {
  const codes = new Set(ev.reasons.map((r) => r.code));
  if (ev.verdict === 'adopt') stats.passed++;
  else if (ev.verdict === 'hold') stats.held++;
  else stats.rejected++;
  if (['inactive', 'date_unknown', 'future_date', 'no_notes', 'notes_incomplete', 'latest_not_fetched'].some((c) => codes.has(c))) stats.activityFailed++;
  if (codes.has('own_account')) stats.ownAccounts++;
  if (codes.has('already_liked')) stats.alreadyLiked++;
  if (codes.has('result_unknown')) stats.resultUnknown++;
  if (codes.has('excluded')) stats.excluded++;
  if (codes.has('counts_unknown') || codes.has('equal') || codes.has('following_lt_follower')) stats.ratioFailed++;
}

async function collect({ adapter, ledger, seeds, accounts, account, mode, config, clock, log = () => {} }) {
  const now = clock.now();
  const nowIso = now.toISOString();
  const enabledAccounts = accounts.filter((a) => a.enabled !== false);
  const ownUrlnames = accounts.map((a) => a.urlname);

  const avail = await checkModeAvailability({ adapter, account, mode });
  if (!avail.available) {
    ledger.logEvent({ level: 'warn', code: avail.code, message: avail.message, accountId: account.id }, nowIso);
    return { stopped: true, code: avail.code, message: avail.message, stats: null, seedReports: [], skippedSeeds: [] };
  }

  const allSeeds = seeds.list(mode);
  const usable = allSeeds.filter((s) => s.enabled && s.verified && s.urlname);
  const skippedSeeds = allSeeds.filter((s) => !usable.includes(s)).map((s) => ({
    id: s.id, url: s.url, displayName: s.displayName,
    reason: !s.urlname ? 'no_url（URL未確認。推測で埋めない）' : !s.verified ? 'unverified（本人確認が未完了）' : 'disabled',
  }));

  const stats = {
    mode, accountId: account.id, startedAt: nowIso,
    seedsUsed: usable.length, seedsSkipped: skippedSeeds.length,
    listedTotal: 0, newPersons: 0, knownPersons: 0, duplicateWithinRun: 0, duplicatesExcluded: 0, newSources: 0, identityChanged: 0,
    profileFetched: 0, profileFetchFailed: 0,
    passed: 0, held: 0, rejected: 0, activityFailed: 0, ratioFailed: 0, ownAccounts: 0, alreadyLiked: 0, resultUnknown: 0, excluded: 0,
    newlyAssigned: 0, executable: 0, executableAllAccounts: 0,
  };
  const listed = [];
  const seedReports = [];
  const listType = MODE_LIST_TYPE[mode];

  for (const seed of usable) {
    let creator = null;
    try {
      creator = await adapter.getCreator(seed.urlname);
    } catch (e) {
      seedReports.push({ id: seed.id, url: seed.url, status: 'fetch_failed', message: e.message });
      continue;
    }
    if (!creator || creator.urlname !== seed.urlname) {
      seedReports.push({ id: seed.id, url: seed.url, status: 'identity_mismatch', message: '起点の本人情報が登録URLと一致しない' });
      continue;
    }
    const kind = ledger.hasCollected(mode, seed.url) ? 'update' : 'initial';
    let n = 0;
    if (mode === 'suki') {
      const notesRes = await adapter.getCreatorNotes(seed.urlname, { limit: config.seedNotesLimit });
      for (const note of notesRes.notes) {
        const likes = await adapter.getNoteLikes(note.key, { limit: config.likesPerNoteLimit });
        likes.likers.forEach((liker, i) => {
          listed.push({
            person: liker,
            source: {
              mode, listType, seedUrl: seed.url, seedUrlname: seed.urlname, seedNoteUrl: note.url, seedNoteKey: note.key, seedVerified: true,
              reactionAt: liker.likedAt || null,
              reactionEvidence: liker.likedAt ? (likes.reactionTimeEvidence || 'スキ一覧の反応日時') : null,
              orderEvidence: likes.orderClaim === 'latest_first' ? (likes.orderEvidence || '取得元がスキ一覧を新しい順と明示') : null,
              listPosition: i,
            },
          });
          n++;
        });
        await sleep(config.requestIntervalMs || 0);
      }
    } else {
      const fol = await adapter.getFollowers(seed.urlname, { limit: config.followersLimit });
      fol.followers.forEach((f, i) => {
        listed.push({
          person: f,
          source: { mode, listType, seedUrl: seed.url, seedUrlname: seed.urlname, seedNoteUrl: null, seedNoteKey: null, seedVerified: true, reactionAt: null, reactionEvidence: null, orderEvidence: null, listPosition: i },
        });
        n++;
      });
    }
    seedReports.push({ id: seed.id, url: seed.url, status: 'ok', kind, listed: n });
    log(`起点 ${seed.url}: ${n} 件（${kind === 'initial' ? '初回収集' : '更新収集'}）`);
    await sleep(config.requestIntervalMs || 0);
  }
  stats.listedTotal = listed.length;

  // 統合（一人一件）
  const seen = new Map();
  for (const { person, source } of listed) {
    const r = ledger.upsertPerson(person, source, nowIso);
    if (seen.has(r.person.id)) { stats.duplicateWithinRun++; continue; }
    seen.set(r.person.id, r);
    if (r.isNew) stats.newPersons++; else stats.knownPersons++;
    if (r.sourceIsNew) stats.newSources++;
    if (r.identityChanged) stats.identityChanged++;
  }
  stats.duplicatesExcluded = stats.duplicateWithinRun + stats.knownPersons;

  // プロフィール更新・評価・担当
  const roster = ledger.rosterView();
  for (const personId of seen.keys()) {
    const p0 = ledger.getPerson(personId);
    if (!ownUrlnames.includes(p0.urlname)) {
      try {
        const r = await refreshPerson({ adapter, ledger, personId, config, nowIso });
        if (r.ok) stats.profileFetched++; else stats.profileFetchFailed++;
      } catch (e) {
        stats.profileFetchFailed++;
        ledger.updateProfile(personId, { lastFetchedAt: nowIso, lastFetchError: e.message });
      }
      await sleep(config.requestIntervalMs || 0);
    }
    const cand = ledger.candidateView(personId);
    const fit = evaluateCandidate(cand, { mode, now, config, ownUrlnames, accountId: null, roster });
    classify(stats, fit);

    let assignedTo = ledger.assignedTo(personId);
    if (fit.verdict === 'adopt' && !assignedTo) {
      const r = ledger.assignBalanced(personId, enabledAccounts.map((a) => a.id), { mode, reason: 'collect', at: nowIso }, nowIso);
      if (r.created) stats.newlyAssigned++;
      assignedTo = r.accountId;
    }
    for (const a of enabledAccounts) {
      const ev = evaluateCandidate(cand, { mode, now, config, ownUrlnames, accountId: a.id, roster });
      ledger.setEvaluation(personId, mode, a.id, ev, nowIso);
    }
    if (fit.verdict === 'adopt' && assignedTo) {
      const t = ledger.ensureCandidate(personId, OP.LIKE, { accountId: assignedTo, mode, reopen: true }, nowIso);
      if (t.state === 'candidate') {
        stats.executableAllAccounts++;
        if (assignedTo === account.id) stats.executable++;
      }
    }
  }

  const kinds = new Set(seedReports.filter((r) => r.status === 'ok').map((r) => r.kind));
  const kind = kinds.size === 0 ? 'none' : (kinds.size === 1 ? [...kinds][0] : 'mixed');
  stats.finishedAt = clock.now().toISOString();
  ledger.recordCollection({ mode, accountId: account.id, kind, seedUrls: usable.map((s) => s.url), stats, startedAt: nowIso, finishedAt: stats.finishedAt });
  ledger.logEvent({ level: 'info', code: 'collect_done', message: `収集完了（${mode}）: 一覧 ${stats.listedTotal}、新規 ${stats.newPersons}、合格 ${stats.passed}、実行可能 ${stats.executable}`, accountId: account.id, data: stats }, stats.finishedAt);
  return { stopped: false, kind, stats, seedReports, skippedSeeds };
}

module.exports = { collect, checkModeAvailability, ownArticleInfo, refreshPerson };
