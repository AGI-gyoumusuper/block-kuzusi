'use strict';

/**
 * モックアダプタ（実 note に一切アクセスしない）。
 * fixtures/mock-world.json の形式で「世界」を与える。日時は now からの相対（offset）で指定できる。
 *
 * world = {
 *   currentUsers: { [accountId]: urlname },          // 各アカウントのブラウザでログイン中の人物
 *   creators: {
 *     [urlname]: {
 *       userId, displayName, followingCount|null, followerCount|null, countsRaw|null, inaccessible?,
 *       notes: [{ key, title, publishedAt | publishedAtOffsetDays | publishedAtOffsetHours, updatedAt..., isPinned, likeCount,
 *                 bodyRendered?, likeStateUnknown?, likes: [{ urlname, likedAtOffsetHours? | likedAt? }], likesOrderClaim?, likesComplete? }],
 *       notesComplete?, notesOrderClaim?,
 *       followers: [urlname...], followersComplete?
 *     }
 *   },
 *   likeBehavior: { [urlname or noteKey]: 'succeeded'|'unknown'|'failed'|'blocked'|'exception' },
 * }
 */

const { DAY_MS, HOUR_MS, parseDate } = require('../clock');

function resolveTime(obj, baseName, now) {
  if (obj[baseName] !== undefined) return obj[baseName];
  const d = obj[`${baseName}OffsetDays`];
  const h = obj[`${baseName}OffsetHours`];
  const m = obj[`${baseName}OffsetMinutes`];
  if (d === undefined && h === undefined && m === undefined) return null;
  let t = now.getTime();
  if (d) t += d * DAY_MS;
  if (h) t += h * HOUR_MS;
  if (m) t += m * 60 * 1000;
  return new Date(t).toISOString();
}

class MockAdapter {
  constructor(world, { clock, accounts = [] } = {}) {
    if (!clock) throw new Error('MockAdapter: clock が必要');
    this.name = 'mock';
    this.clock = clock;
    // realActions は「状態機械を最後まで通せる」の意。simulated=true で実 note には一切送らないことを示す
    this.capabilities = { realActions: true, simulated: true, reactionTimes: true, description: 'モック。実 note に接続しない（スキは模擬）' };
    this.world = JSON.parse(JSON.stringify(world || {}));
    this.world.creators = this.world.creators || {};
    this.world.currentUsers = this.world.currentUsers || {};
    this.world.likeBehavior = this.world.likeBehavior || {};
    for (const a of accounts) {
      if (!this.world.currentUsers[a.id]) this.world.currentUsers[a.id] = a.urlname;
    }
    this.likedBy = new Map(); // noteKey -> Set(accountId)
    this.followedBy = new Map(); // targetUrlname -> Set(accountId)  （本ツールが行ったフォロー）
    this.calls = [];
    this.likeCalls = [];
    this.followCalls = [];
    this._resolveTimes(clock.now());
  }

  _resolveTimes(now) {
    for (const [urlname, c] of Object.entries(this.world.creators)) {
      c.urlname = urlname;
      c.notes = c.notes || [];
      for (const n of c.notes) {
        n.publishedAt = resolveTime(n, 'publishedAt', now);
        n.updatedAt = resolveTime(n, 'updatedAt', now);
        n.url = n.url || `https://note.com/${urlname}/n/${n.key}`;
        n.author = urlname;
        for (const l of (n.likes || [])) l.likedAt = resolveTime(l, 'likedAt', now);
      }
    }
  }

  _rec(method, args) { this.calls.push({ method, args, at: this.clock.now().toISOString() }); }

  _creator(urlname) {
    const c = this.world.creators[urlname];
    if (!c) return null;
    if (c.inaccessible) throw new Error(`mock: ${urlname} はアクセス不可`);
    return c;
  }

  _findNote(key) {
    for (const c of Object.values(this.world.creators)) {
      const n = (c.notes || []).find((x) => x.key === key);
      if (n) return n;
    }
    return null;
  }

  // ---- テスト用の操作 ----
  setCurrentUser(accountId, urlname) { this.world.currentUsers[accountId] = urlname; }
  setNotes(urlname, notes) {
    const c = this.world.creators[urlname];
    if (!c) throw new Error(`mock: ${urlname} がない`);
    c.notes = JSON.parse(JSON.stringify(notes));
    this._resolveTimes(this.clock.now());
  }
  setLikeBehavior(key, behavior) { this.world.likeBehavior[key] = behavior; }
  addFollower(urlname, followerUrlname) {
    const c = this.world.creators[urlname];
    c.followers = c.followers || [];
    if (!c.followers.includes(followerUrlname)) c.followers.push(followerUrlname);
  }
  addLike(noteKey, likerUrlname, likedAt) {
    const n = this._findNote(noteKey);
    n.likes = n.likes || [];
    n.likes.unshift({ urlname: likerUrlname, likedAt: likedAt || null });
  }

  /** テスト用: 「こちらが相手をフォロー済み」を世界側で設定（ツール外のフォロー） */
  setFollowing(accountUrlname, targetUrlname, following = true) {
    const c = this.world.creators[accountUrlname];
    c.following = c.following || [];
    const i = c.following.indexOf(targetUrlname);
    if (following && i < 0) c.following.push(targetUrlname);
    if (!following && i >= 0) c.following.splice(i, 1);
  }
  /** テスト用: 関係を確認できない相手 */
  setRelationshipUnknown(targetUrlname, unknown = true) {
    this.world.relationshipUnknown = this.world.relationshipUnknown || {};
    this.world.relationshipUnknown[targetUrlname] = unknown;
  }

  async getFollowing(urlname, { limit = 200 } = {}) {
    this._rec('getFollowing', { urlname, limit });
    const c = this._creator(urlname);
    if (!c) return { following: [], complete: true };
    const all = (c.following || []).map((u) => ({ urlname: u, userId: this.world.creators[u] && this.world.creators[u].userId != null ? String(this.world.creators[u].userId) : null }));
    return { following: all.slice(0, limit), complete: all.length <= limit };
  }

  /** 現在の関係（通知ではなく現在の一覧から）。確認できない場合は null を返す */
  async getRelationship(targetUrlname, { accountId } = {}) {
    this._rec('getRelationship', { targetUrlname, accountId });
    const me = this.world.currentUsers[accountId];
    if (!me) return { targetFollowsMe: null, iFollowTarget: null, evidence: 'ログイン中ユーザー不明' };
    if (this.world.relationshipUnknown && this.world.relationshipUnknown[targetUrlname]) {
      return { targetFollowsMe: null, iFollowTarget: null, evidence: 'mock: 関係を確認できない' };
    }
    const myCreator = this.world.creators[me];
    const targetFollowsMe = (myCreator.followers || []).includes(targetUrlname);
    const byTool = this.followedBy.get(targetUrlname);
    const iFollowTarget = (myCreator.following || []).includes(targetUrlname) || !!(byTool && byTool.has(accountId));
    return { targetFollowsMe, iFollowTarget, evidence: 'mock: 現在のフォロワー一覧／フォロー中一覧' };
  }

  async follow(targetUrlname, { accountId } = {}) {
    this._rec('follow', { targetUrlname, accountId });
    const behavior = this.world.followBehavior && this.world.followBehavior[targetUrlname] || 'succeeded';
    this.followCalls.push({ targetUrlname, accountId, behavior, at: this.clock.now().toISOString() });
    if (behavior === 'exception') throw new Error('mock: クリック後にブラウザが終了');
    if (behavior === 'failed') return { result: 'failed', clicked: false, code: 'button_not_found', message: 'mock: フォローボタンが見つからない', stateAfter: 'not_following' };
    if (behavior === 'blocked') return { result: 'blocked', clicked: true, code: 'rate_limited', message: 'mock: 429 制限', stateAfter: 'unknown' };
    if (behavior === 'auth') return { result: 'blocked', clicked: true, code: 'auth_required', message: 'mock: ログイン要求', stateAfter: 'unknown' };
    if (behavior === 'unknown') return { result: 'unknown', clicked: true, code: 'confirm_timeout', message: 'mock: 押下後の状態確認がタイムアウト', stateAfter: 'unknown' };
    if (!this.followedBy.has(targetUrlname)) this.followedBy.set(targetUrlname, new Set());
    this.followedBy.get(targetUrlname).add(accountId);
    return { result: 'succeeded', clicked: true, code: 'ok', message: 'mock: フォロー中を確認', stateAfter: 'following' };
  }

  setFollowBehavior(targetUrlname, behavior) { this.world.followBehavior = this.world.followBehavior || {}; this.world.followBehavior[targetUrlname] = behavior; }

  // ---- アダプタ契約 ----
  async getCurrentUser({ accountId }) {
    this._rec('getCurrentUser', { accountId });
    const urlname = this.world.currentUsers[accountId];
    if (!urlname) return null;
    const c = this.world.creators[urlname];
    return { urlname, userId: c && c.userId != null ? String(c.userId) : null, displayName: c ? c.displayName : urlname };
  }

  async getCreator(urlname, { accountId } = {}) {
    this._rec('getCreator', { urlname, accountId });
    const c = this._creator(urlname);
    if (!c) return null;
    return {
      urlname,
      userId: c.userId != null ? String(c.userId) : null,
      displayName: c.displayName || urlname,
      profileUrl: `https://note.com/${urlname}`,
      followingCount: Number.isInteger(c.followingCount) ? c.followingCount : null,
      followerCount: Number.isInteger(c.followerCount) ? c.followerCount : null,
      countsRaw: c.countsRaw || null,
      noteCount: (c.notes || []).length,
    };
  }

  async getCreatorNotes(urlname, { limit = 20 } = {}) {
    this._rec('getCreatorNotes', { urlname, limit });
    const c = this._creator(urlname);
    if (!c) return { notes: [], complete: true, orderClaim: 'unknown' };
    const all = (c.notes || []).map((n) => ({
      key: n.key, url: n.url, title: n.title || '', publishedAt: n.publishedAt, updatedAt: n.updatedAt, isPinned: !!n.isPinned, likeCount: n.likeCount || 0,
    }));
    const notes = all.slice(0, limit);
    return { notes, complete: c.notesComplete !== undefined ? !!c.notesComplete : notes.length === all.length, orderClaim: c.notesOrderClaim || 'unknown' };
  }

  async getNoteLikes(noteKey, { limit = 100 } = {}) {
    this._rec('getNoteLikes', { noteKey, limit });
    const n = this._findNote(noteKey);
    if (!n) return { likers: [], complete: true, orderClaim: 'unknown', orderEvidence: null, reactionTimeEvidence: null };
    const all = (n.likes || []).map((l) => {
      const c = this.world.creators[l.urlname];
      return { urlname: l.urlname, userId: c && c.userId != null ? String(c.userId) : null, displayName: c ? c.displayName : l.urlname, likedAt: l.likedAt || null };
    });
    const likers = all.slice(0, limit);
    const orderClaim = n.likesOrderClaim || 'unknown';
    return {
      likers,
      complete: n.likesComplete !== undefined ? !!n.likesComplete : likers.length === all.length,
      orderClaim,
      orderEvidence: orderClaim === 'latest_first' ? 'mock: スキ一覧が新しい順であると取得元が明示' : null,
      reactionTimeEvidence: 'mock: スキ一覧の likedAt',
    };
  }

  async getFollowers(urlname, { limit = 200 } = {}) {
    this._rec('getFollowers', { urlname, limit });
    const c = this._creator(urlname);
    if (!c) return { followers: [], complete: true };
    const all = (c.followers || []).map((u) => {
      const f = this.world.creators[u];
      return { urlname: u, userId: f && f.userId != null ? String(f.userId) : null, displayName: f ? f.displayName : u };
    });
    const followers = all.slice(0, limit);
    return { followers, complete: c.followersComplete !== undefined ? !!c.followersComplete : followers.length === all.length };
  }

  async getNote(noteKey, { accountId } = {}) {
    this._rec('getNote', { noteKey, accountId });
    const n = this._findNote(noteKey);
    if (!n) return null;
    const author = this.world.creators[n.author];
    if (author && author.inaccessible) throw new Error(`mock: ${n.author} の記事はアクセス不可`);
    const liked = this.likedBy.get(noteKey);
    return {
      key: n.key, url: n.url, title: n.title || '', publishedAt: n.publishedAt, updatedAt: n.updatedAt,
      authorUrlname: n.author, authorUserId: author && author.userId != null ? String(author.userId) : null,
      likeCount: n.likeCount || 0,
      isLikedByMe: n.likeStateUnknown ? null : !!(liked && accountId && liked.has(accountId)),
    };
  }

  async openAndReadNote(noteUrl, { accountId } = {}) {
    this._rec('openAndReadNote', { noteUrl, accountId });
    const n = Object.values(this.world.creators).flatMap((c) => c.notes || []).find((x) => x.url === noteUrl);
    if (!n) return { ok: false, bodyRendered: false, scrolledToEnd: false, likeState: 'unknown', finalUrl: noteUrl, noteKey: null, authorUrlname: null, blocked: null };
    const author = this.world.creators[n.author];
    if (author && author.inaccessible) return { ok: false, bodyRendered: false, scrolledToEnd: false, likeState: 'unknown', finalUrl: noteUrl, noteKey: n.key, authorUrlname: n.author, blocked: null };
    const liked = this.likedBy.get(n.key);
    const likeState = n.likeStateUnknown ? 'unknown' : (liked && accountId && liked.has(accountId) ? 'liked' : 'not_liked');
    const blockedBehavior = this.world.likeBehavior[`open:${n.author}`];
    return {
      ok: n.bodyRendered !== false,
      bodyRendered: n.bodyRendered !== false,
      scrolledToEnd: n.bodyRendered !== false,
      likeState,
      finalUrl: noteUrl,
      noteKey: n.key,
      authorUrlname: n.author,
      blocked: blockedBehavior === 'blocked' ? { code: 'auth_required', message: 'mock: 認証要求画面' } : null,
    };
  }

  async like(noteKey, { accountId, noteUrl } = {}) {
    this._rec('like', { noteKey, accountId, noteUrl });
    const n = this._findNote(noteKey);
    const behavior = (n && this.world.likeBehavior[n.author]) || this.world.likeBehavior[noteKey] || 'succeeded';
    this.likeCalls.push({ noteKey, accountId, behavior, at: this.clock.now().toISOString() });
    if (behavior === 'exception') throw new Error('mock: クリック後にブラウザが終了');
    if (behavior === 'failed') return { result: 'failed', clicked: false, code: 'button_not_found', message: 'mock: スキボタンが見つからない', likeStateAfter: 'not_liked' };
    if (behavior === 'blocked') return { result: 'blocked', clicked: true, code: 'like_locked', message: 'mock: スキの一時ロック表示', likeStateAfter: 'unknown' };
    if (behavior === 'unknown') return { result: 'unknown', clicked: true, code: 'confirm_timeout', message: 'mock: クリック後の状態確認がタイムアウト', likeStateAfter: 'unknown' };
    if (!this.likedBy.has(noteKey)) this.likedBy.set(noteKey, new Set());
    this.likedBy.get(noteKey).add(accountId);
    return { result: 'succeeded', clicked: true, code: 'ok', message: 'mock: スキ状態を確認', likeStateAfter: 'liked' };
  }

  async close() { this._rec('close', {}); }
}

module.exports = { MockAdapter, resolveTime };
