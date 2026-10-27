'use strict';

/**
 * 起点（スキ獲得: スキして回っている発信者 / フォロワー獲得: フォロー数十・フォロワー数千の発信者）の管理。
 * - URL が未確認の起点は verified=false のまま。表示名だけで採用しない
 * - verify() でアダプタから本人情報を取得し、urlname の一致を確認してから verified=true
 * 保存先は共有台帳（seeds テーブル）。
 */

const NOTE_URL_RE = /^https?:\/\/(?:www\.)?note\.com\/([A-Za-z0-9_]+)(?:[/?#].*)?$/;
const RESERVED = new Set(['api', 'notes', 'n', 'search', 'login', 'signup', 'info', 'magazines', 'hashtag', 'sitesettings', 'settings', 'notice', 'contests', 'creators']);

function parseNoteUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(NOTE_URL_RE);
  if (!m) return null;
  const urlname = m[1];
  if (RESERVED.has(urlname)) return null;
  return { urlname, canonicalUrl: `https://note.com/${urlname}` };
}

function isMode(v) { return v === 'suki' || v === 'follower'; }

class Seeds {
  constructor(ledger) { this.ledger = ledger; }

  list(mode) { return this.ledger.listSeeds(mode); }

  get(id) { return this.ledger.getSeed(id); }

  add({ mode, url, displayName, note, urlConfirmedBySpec }, nowIso) {
    if (!isMode(mode)) throw new Error(`不明なモード: ${mode}`);
    const parsed = url ? parseNoteUrl(url) : null;
    if (url && !parsed) throw new Error(`note のプロフィールURLとして解釈できません: ${url}`);
    if (parsed) {
      const dup = this.ledger.findSeed(mode, parsed.urlname);
      if (dup) return { seed: dup, created: false };
    }
    const n = this.ledger.listSeeds().length + 1;
    const id = `seed_${n}_${mode}_${parsed ? parsed.urlname : 'nourl'}_${nowIso.replace(/[^0-9]/g, '').slice(0, 14)}`;
    const seed = this.ledger.insertSeed({
      id,
      mode,
      url: parsed ? parsed.canonicalUrl : null,
      urlname: parsed ? parsed.urlname : null,
      displayName: displayName || '',
      note: note || '',
      urlConfirmedBySpec: !!urlConfirmedBySpec,
      enabled: true,
      verified: false,
      verifiedAt: null,
      verification: null,
      createdAt: nowIso,
    });
    return { seed, created: true };
  }

  setUrl(id, url) {
    const seed = this.get(id);
    if (!seed) throw new Error(`起点がない: ${id}`);
    const parsed = parseNoteUrl(url);
    if (!parsed) throw new Error(`note のプロフィールURLとして解釈できません: ${url}`);
    return this.ledger.updateSeed(id, { url: parsed.canonicalUrl, urlname: parsed.urlname, verified: false, verifiedAt: null, verification: null });
  }

  setEnabled(id, enabled) {
    if (!this.get(id)) throw new Error(`起点がない: ${id}`);
    return this.ledger.updateSeed(id, { enabled: !!enabled });
  }

  remove(id) { return this.ledger.deleteSeed(id); }

  /**
   * 本人同一性の確認。アダプタが返す urlname が登録値と一致した場合のみ verified。
   * フォロワー獲得の起点は seedRange が設定されていれば範囲判定も併記（未設定なら「閾値未設定」）。
   */
  async verify(id, adapter, nowIso, config = {}) {
    const seed = this.get(id);
    if (!seed) throw new Error(`起点がない: ${id}`);
    if (!seed.urlname) {
      return this.ledger.updateSeed(id, { verified: false, verification: { ok: false, code: 'no_url', message: 'URLが未確認のため検証できない。推測で埋めない', checkedAt: nowIso } });
    }
    let creator = null;
    try {
      creator = await adapter.getCreator(seed.urlname);
    } catch (e) {
      return this.ledger.updateSeed(id, { verified: false, verification: { ok: false, code: 'fetch_failed', message: `取得失敗: ${e.message}`, checkedAt: nowIso } });
    }
    if (!creator || creator.urlname !== seed.urlname) {
      return this.ledger.updateSeed(id, { verified: false, verification: { ok: false, code: 'identity_mismatch', message: '取得した本人情報の urlname が登録URLと一致しない', checkedAt: nowIso } });
    }
    const v = {
      ok: true,
      code: 'ok',
      message: '登録URLの本人情報を取得し、urlname の一致を確認',
      creatorUrlname: creator.urlname,
      creatorDisplayName: creator.displayName || '',
      userId: creator.userId != null ? String(creator.userId) : null,
      followingCount: creator.followingCount ?? null,
      followerCount: creator.followerCount ?? null,
      noteCount: creator.noteCount ?? null,
      checkedAt: nowIso,
    };
    if (seed.mode === 'follower') v.seedRange = evaluateSeedRange(creator, config.seedRange);
    const patch = { verified: true, verifiedAt: nowIso, verification: v };
    if (!seed.displayName && creator.displayName) patch.displayName = creator.displayName;
    return this.ledger.updateSeed(id, patch);
  }
}

/**
 * フォロワー獲得の起点形状（教材: フォロー数十・フォロワー数千は例示）。
 * 範囲は設定値。未設定なら判定せず「閾値未設定」を返す。
 */
function evaluateSeedRange(creator, seedRange) {
  const materialText = '教材の例示: 自分からのフォロー数が数十、フォロワー数が数千（例 フォロー50・フォロワー2000）。明示条件ではない';
  if (!seedRange || (seedRange.followingMax == null && seedRange.followerMin == null)) {
    return { evaluated: false, code: 'threshold_unset', message: '数値範囲が未設定のため判定しない（黙って補完しない）', materialText };
  }
  const reasons = [];
  let ok = true;
  if (seedRange.followingMax != null) {
    if (creator.followingCount == null) { ok = false; reasons.push('フォロー数が不明'); }
    else if (creator.followingCount > seedRange.followingMax) { ok = false; reasons.push(`フォロー数 ${creator.followingCount} > 上限 ${seedRange.followingMax}`); }
  }
  if (seedRange.followerMin != null) {
    if (creator.followerCount == null) { ok = false; reasons.push('フォロワー数が不明'); }
    else if (creator.followerCount < seedRange.followerMin) { ok = false; reasons.push(`フォロワー数 ${creator.followerCount} < 下限 ${seedRange.followerMin}`); }
  }
  return { evaluated: true, ok, code: ok ? 'in_range' : 'out_of_range', reasons, seedRange, materialText };
}

module.exports = { Seeds, parseNoteUrl, evaluateSeedRange, isMode };
