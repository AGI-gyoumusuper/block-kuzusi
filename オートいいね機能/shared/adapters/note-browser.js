'use strict';

/**
 * 実 note 用アダプタ（Playwright + 既存 Chrome への CDP 接続）。
 *
 * - アカウントごとに remote debugging の port へ接続し、既存セッション（ログイン状態）を再利用する
 * - 読み取り API はブラウザ側の context.request で呼ぶ（Cookie はブラウザ内に留まり、本ツールは複製しない）
 * - スキはページ上のボタンを実際に押し、押下後の状態を確認する。確認できなければ unknown
 * - ロック・認証要求らしき表示を検出したら blocked を返す
 *
 * 【未検証】この環境から note.com へ接続できないため、API の経路・項目名・画面のセレクタは
 * 既知の形から推定した初期値である。必ず `probe` コマンドで実際の応答を確認してから使うこと。
 */

const { parseDate } = require('../clock');

function tpl(s, vars) { return s.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? '')); }

/** 複数候補の項目名から最初に存在する値を取る。無ければ null（捏造しない） */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : undefined), obj);
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

/** note の日時表記。tz が無い "YYYY/MM/DD HH:mm" は JST とみなす */
function parseNoteDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000).toISOString();
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T${(m[4] || '00').padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'}+09:00`;
    const d = parseDate(iso);
    return d ? d.toISOString() : null;
  }
  const d = parseDate(s);
  return d ? d.toISOString() : null;
}

function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

class NoteBrowserAdapter {
  constructor({ config, accounts, clock, log = () => {} }) {
    this.name = 'note';
    this.config = config;
    this.accounts = accounts;
    this.clock = clock;
    this.log = log;
    this.capabilities = { realActions: true, reactionTimes: 'unverified', description: '実 note（CDP 接続）。API 項目・セレクタは未検証' };
    this.browsers = new Map(); // accountId -> { browser, context }
    this._playwright = null;
  }

  _pw() {
    if (this._playwright) return this._playwright;
    try {
      this._playwright = require('playwright');
    } catch (e) {
      throw new Error('playwright が見つかりません。オートいいね機能 フォルダで `npm install playwright` を実行してください');
    }
    return this._playwright;
  }

  _account(accountId) {
    const a = this.accounts.find((x) => x.id === accountId);
    if (!a) throw new Error(`不明なアカウント: ${accountId}`);
    if (!a.cdpPort) throw new Error(`アカウント ${accountId} の cdpPort が未設定`);
    return a;
  }

  async _context(accountId) {
    const cached = this.browsers.get(accountId);
    if (cached && cached.browser.isConnected()) return cached.context;
    const a = this._account(accountId);
    const { chromium } = this._pw();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${a.cdpPort}`);
    const context = browser.contexts()[0] || (await browser.newContext());
    this.browsers.set(accountId, { browser, context });
    return context;
  }

  /** 読み取り用の既定アカウント（有効な最初のアカウント）。読み取りはどのセッションでもよい */
  _readerAccountId(preferred) {
    if (preferred) return preferred;
    const a = this.accounts.find((x) => x.enabled !== false);
    if (!a) throw new Error('有効なアカウントがない');
    return a.id;
  }

  async _getJson(pathTemplate, vars, { accountId } = {}) {
    const ctx = await this._context(this._readerAccountId(accountId));
    const url = this.config.noteApi.base + tpl(pathTemplate, vars);
    const res = await ctx.request.get(url, { headers: { accept: 'application/json' } });
    this._lastHttp = { url, status: res.status(), contentType: res.headers()['content-type'] || '' };
    if (res.status() === 401) {
      const err = new Error(`認証要求 (401): ${url}`);
      err.code = 'auth_required';
      throw err;
    }
    if (res.status() === 403) {
      // 403 は認証切れか権限かを区別できない場合がある。不明なら停止して理由を残す（フォルダ2要件 §4）
      const err = new Error(`拒否 (403): ${url}`);
      err.code = 'forbidden';
      throw err;
    }
    if (res.status() === 404) return null;
    if (res.status() === 429) {
      const err = new Error(`レート制限 (429): ${url}`);
      err.code = 'rate_limited';
      throw err;
    }
    if (!res.ok()) throw new Error(`HTTP ${res.status()}: ${url}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) {
      const err = new Error(`JSON として解釈できない応答 (${this._lastHttp.contentType}): ${url}`);
      err.code = 'unrecognized_response';
      throw err;
    }
  }

  /** 応答に一覧の項目が無い（形式が未知）場合は例外にする。0件と確定しない */
  _listOrThrow(d, keys, what) {
    if (!d || typeof d !== 'object') { const e = new Error(`${what}: 応答が空`); e.code = 'unrecognized_response'; throw e; }
    const list = pick(d, keys);
    if (!Array.isArray(list)) { const e = new Error(`${what}: 応答に一覧（${keys.join('/')}）が無い。項目名を probe で確認して config/pick を直す`); e.code = 'unrecognized_response'; throw e; }
    return list;
  }

  /** probe 用: HTTP ステータス・Content-Type・生ボディの先頭も返す */
  async probeRaw(endpointName, vars, { accountId } = {}) {
    const t = this.config.noteApi.endpoints[endpointName];
    if (!t) throw new Error(`不明なエンドポイント名: ${endpointName}`);
    const ctx = await this._context(this._readerAccountId(accountId));
    const url = this.config.noteApi.base + tpl(t, { page: 1, ...vars });
    const res = await ctx.request.get(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    return { url, status: res.status(), contentType: res.headers()['content-type'] || '', bodyHead: text.slice(0, 2000), json };
  }

  /** probe 用: ページを開き、本文セレクタ・スキ/フォローボタンの状態・ロック検出の結果を返す（押さない） */
  async probePage(url, { accountId } = {}) {
    const ctx = await this._context(this._readerAccountId(accountId));
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      const body = page.locator(this.config.browser.articleBodySelector).first();
      const likeBtn = page.locator(this.config.browser.likeButtonSelector).first();
      const followBtn = page.locator(this.config.browser.followButtonSelector).first();
      const attrs = async (loc) => ((await loc.count()) === 0 ? null : {
        text: ((await loc.textContent().catch(() => '')) || '').trim().slice(0, 80),
        ariaPressed: await loc.getAttribute('aria-pressed').catch(() => null),
        ariaLabel: await loc.getAttribute('aria-label').catch(() => null),
        className: await loc.getAttribute('class').catch(() => null),
      });
      return {
        finalUrl: page.url(), title: await page.title(),
        bodySelectorMatches: await body.count(), likeButton: await attrs(likeBtn), likeState: await this._likeState(page), followButton: await attrs(followBtn),
        blocked: await this._detectBlock(page),
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** 生の応答を返す（probe 用） */
  async probe(endpointName, vars, { accountId } = {}) {
    const t = this.config.noteApi.endpoints[endpointName];
    if (!t) throw new Error(`不明なエンドポイント名: ${endpointName}`);
    return this._getJson(t, { page: 1, ...vars }, { accountId });
  }

  async getCurrentUser({ accountId }) {
    const raw = await this._getJson(this.config.noteApi.endpoints.currentUser, {}, { accountId });
    const d = raw && (raw.data || raw);
    const urlname = pick(d, ['urlname', 'user.urlname', 'creator.urlname']);
    if (!urlname) return null;
    return { urlname, userId: pick(d, ['id', 'user.id', 'creator.id']), displayName: pick(d, ['nickname', 'name', 'user.nickname']) || '' };
  }

  async getCreator(urlname, { accountId } = {}) {
    const raw = await this._getJson(this.config.noteApi.endpoints.creator, { urlname }, { accountId });
    const d = raw && (raw.data || raw);
    if (!d) return null;
    const got = pick(d, ['urlname']);
    if (!got) return null;
    const following = pick(d, ['followingCount', 'following_count']);
    const follower = pick(d, ['followerCount', 'follower_count']);
    return {
      urlname: got,
      userId: pick(d, ['id', 'userId']) != null ? String(pick(d, ['id', 'userId'])) : null,
      displayName: pick(d, ['nickname', 'name']) || '',
      profileUrl: `https://note.com/${got}`,
      followingCount: toInt(following),
      followerCount: toInt(follower),
      countsRaw: (toInt(following) == null || toInt(follower) == null) ? `following=${following ?? '?'} follower=${follower ?? '?'}` : null,
      noteCount: toInt(pick(d, ['noteCount', 'note_count'])),
    };
  }

  _normalizeNote(n, urlname) {
    const key = pick(n, ['key', 'id']);
    const author = pick(n, ['user.urlname', 'creator.urlname']) || urlname || null;
    return {
      key: key != null ? String(key) : null,
      url: pick(n, ['noteUrl', 'note_url', 'url']) || (author && key ? `https://note.com/${author}/n/${key}` : null),
      title: pick(n, ['name', 'title']) || '',
      publishedAt: parseNoteDate(pick(n, ['publishAt', 'publish_at', 'publishedAt', 'published_at'])),
      updatedAt: parseNoteDate(pick(n, ['updatedAt', 'updated_at', 'lastUpdatedAt'])),
      isPinned: !!pick(n, ['isPinned', 'is_pinned', 'pinned']),
      likeCount: toInt(pick(n, ['likeCount', 'like_count'])), // 取得できなければ null（0 で補完しない）
      authorUrlname: author,
      authorUserId: pick(n, ['user.id', 'creator.id']) != null ? String(pick(n, ['user.id', 'creator.id'])) : null,
      isLikedByMe: (() => { const v = pick(n, ['isLiked', 'is_liked', 'liked']); return typeof v === 'boolean' ? v : null; })(),
    };
  }

  async getCreatorNotes(urlname, { limit = 20, accountId } = {}) {
    const notes = [];
    let page = 1;
    let complete = false;
    while (notes.length < limit && page <= 10) {
      const raw = await this._getJson(this.config.noteApi.endpoints.creatorNotes, { urlname, page }, { accountId });
      if (raw === null) { const e = new Error(`記事一覧が 404: ${urlname}`); e.code = 'not_found'; throw e; }
      const d = raw.data || raw;
      const list = this._listOrThrow(d, ['contents', 'notes', 'items'], '記事一覧');
      if (list.length === 0) { complete = true; break; }
      for (const n of list) notes.push(this._normalizeNote(n, urlname));
      const isLast = pick(d, ['isLastPage', 'is_last_page']);
      if (isLast === true) { complete = true; break; }
      // isLastPage が取れない場合、少件数でも「最終ページ」と推定しない（次ページを試み、上限で打ち切る）
      page++;
      await this._pause();
    }
    // 並び順: 取得元が公開日時降順であることを利用者が実応答で確認したら config.noteApi.notesOrderClaim = 'published_desc' にする。
    // 未確認のままなら 'unknown' とし、全件取得できない場合は最新記事を確定しない（取得順を最新順と決めつけない）
    return { notes: notes.slice(0, limit), complete: complete && notes.length <= limit, orderClaim: this.config.noteApi.notesOrderClaim || 'unknown' };
  }

  async getNoteLikes(noteKey, { limit = 100, accountId } = {}) {
    const likers = [];
    let page = 1;
    let complete = false;
    while (likers.length < limit && page <= 10) {
      const raw = await this._getJson(this.config.noteApi.endpoints.noteLikes, { key: noteKey, page }, { accountId });
      if (raw === null) { const e = new Error(`スキ一覧が 404: ${noteKey}`); e.code = 'not_found'; throw e; }
      const d = raw.data || raw;
      const list = this._listOrThrow(d, ['likes', 'users', 'items', 'contents'], 'スキ一覧');
      if (list.length === 0) { complete = true; break; }
      for (const item of list) {
        // item が「スキ」レコード（user/creator を内包）のときだけ、その作成日時を反応日時として使う。
        // item がユーザー本体のときは createdAt がアカウント作成日時なので、反応日時は不明（null）
        const wrapped = item.user || item.creator || null;
        const u = wrapped || item;
        const urlname = pick(u, ['urlname']);
        if (!urlname) continue;
        likers.push({
          urlname,
          userId: pick(u, ['id']) != null ? String(pick(u, ['id'])) : null,
          displayName: pick(u, ['nickname', 'name']) || '',
          likedAt: wrapped ? parseNoteDate(pick(item, ['likedAt', 'liked_at', 'createdAt', 'created_at'])) : null,
        });
      }
      const isLast = pick(d, ['isLastPage', 'is_last_page']);
      if (isLast === true) { complete = true; break; }
      page++;
      await this._pause();
    }
    const orderClaim = this.config.noteApi.likesOrderClaim || 'unknown';
    return {
      likers: likers.slice(0, limit),
      complete,
      orderClaim,
      orderEvidence: orderClaim === 'latest_first' ? '利用者が実応答で確認したスキ一覧の並び（新しい順）' : null,
      reactionTimeEvidence: likers.some((l) => l.likedAt) ? 'note API のスキ作成日時（未検証）' : null,
    };
  }

  async getFollowers(urlname, { limit = 200, accountId } = {}) {
    const followers = [];
    let page = 1;
    let complete = false;
    while (followers.length < limit && page <= 20) {
      const raw = await this._getJson(this.config.noteApi.endpoints.followers, { urlname, page }, { accountId });
      if (raw === null) { const e = new Error(`フォロワー一覧が 404: ${urlname}`); e.code = 'not_found'; throw e; }
      const d = raw.data || raw;
      const list = this._listOrThrow(d, ['followers', 'users', 'items', 'contents'], 'フォロワー一覧');
      if (list.length === 0) { complete = true; break; }
      for (const item of list) {
        const u = item.user || item.creator || item;
        const got = pick(u, ['urlname']);
        if (!got) continue;
        followers.push({ urlname: got, userId: pick(u, ['id']) != null ? String(pick(u, ['id'])) : null, displayName: pick(u, ['nickname', 'name']) || '' });
      }
      const isLast = pick(d, ['isLastPage', 'is_last_page']);
      if (isLast === true) { complete = true; break; }
      page++;
      await this._pause();
    }
    return { followers: followers.slice(0, limit), complete };
  }

  async getFollowing(urlname, { limit = 200, accountId } = {}) {
    const following = [];
    let page = 1;
    let complete = false;
    while (following.length < limit && page <= 20) {
      const raw = await this._getJson(this.config.noteApi.endpoints.following, { urlname, page }, { accountId });
      if (raw === null) { const e = new Error(`フォロー中一覧が 404: ${urlname}`); e.code = 'not_found'; throw e; }
      const d = raw.data || raw;
      const list = this._listOrThrow(d, ['followings', 'following', 'users', 'items', 'contents'], 'フォロー中一覧');
      if (list.length === 0) { complete = true; break; }
      for (const item of list) {
        const u = item.user || item.creator || item;
        const got = pick(u, ['urlname']);
        if (!got) continue;
        following.push({ urlname: got, userId: pick(u, ['id']) != null ? String(pick(u, ['id'])) : null, displayName: pick(u, ['nickname', 'name']) || '' });
      }
      const isLast = pick(d, ['isLastPage', 'is_last_page']);
      if (isLast === true) { complete = true; break; }
      page++;
      await this._pause();
    }
    return { following: following.slice(0, limit), complete };
  }

  /**
   * 現在の関係。自分のフォロワー一覧・フォロー中一覧（現在の状態）から判定する。
   * 一覧が全件取得できず相手が見つからない場合は「不明（null）」とし、false と決めつけない。
   * 【未検証】経路・項目名は推定。
   */
  async getRelationship(targetUrlname, { accountId } = {}) {
    const me = await this.getCurrentUser({ accountId });
    if (!me || !me.urlname) return { targetFollowsMe: null, iFollowTarget: null, evidence: 'ログイン中ユーザーを取得できない' };
    const fol = await this.getFollowers(me.urlname, { limit: this.config.followersLimit || 200, accountId });
    const fw = await this.getFollowing(me.urlname, { limit: this.config.followersLimit || 200, accountId });
    const inFollowers = fol.followers.some((f) => f.urlname === targetUrlname);
    const inFollowing = fw.following.some((f) => f.urlname === targetUrlname);
    return {
      targetFollowsMe: inFollowers ? true : (fol.complete ? false : null),
      iFollowTarget: inFollowing ? true : (fw.complete ? false : null),
      evidence: `現在のフォロワー一覧（${fol.complete ? '全件' : '一部'}）とフォロー中一覧（${fw.complete ? '全件' : '一部'}）`,
    };
  }

  /**
   * フォロー返し。相手のプロフィールページでフォローボタンを押し、「フォロー中」になったことを確認できたときだけ succeeded。
   * 【未検証】セレクタ・文言は推定。
   */
  _followingRe() {
    const v = this.config.browser.followingButtonText;
    return v instanceof RegExp ? v : new RegExp(v || 'フォロー中');
  }

  async follow(targetUrlname, { accountId } = {}) {
    const ctx = await this._context(accountId);
    const page = await ctx.newPage();
    let clicked = false;
    const followingRe = this._followingRe();
    try {
      await page.goto(`https://note.com/${targetUrlname}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const blocked = await this._detectBlock(page);
      if (blocked) return { result: 'blocked', clicked: false, code: blocked.code, message: blocked.message, stateAfter: 'unknown' };
      const btn = page.locator(this.config.browser.followButtonSelector).first();
      if ((await btn.count()) === 0) return { result: 'failed', clicked: false, code: 'button_not_found', message: 'フォローボタンが見つからない', stateAfter: 'unknown' };
      const before = (await btn.textContent().catch(() => '')) || '';
      if (followingRe.test(before)) return { result: 'succeeded', clicked: false, code: 'already_following', message: '既にフォロー中（再クリックしない）', stateAfter: 'following' };
      try { await btn.click({ timeout: 5000 }); clicked = true; } catch (e) { return { result: 'failed', clicked: false, code: 'click_failed', message: `クリック失敗: ${e.message}`, stateAfter: 'unknown' }; }
      const deadline = Date.now() + this.config.browser.likeConfirmTimeoutMs;
      while (Date.now() < deadline) {
        const b2 = await this._detectBlock(page);
        if (b2) return { result: 'blocked', clicked, code: b2.code, message: b2.message, stateAfter: 'unknown' };
        const txt = (await btn.textContent().catch(() => '')) || '';
        if (followingRe.test(txt)) return { result: 'succeeded', clicked, code: 'ok', message: '押下後にフォロー中を確認', stateAfter: 'following' };
        await page.waitForTimeout(400);
      }
      return { result: 'unknown', clicked, code: 'confirm_timeout', message: '押下後の状態確認がタイムアウト。自動再送しない', stateAfter: 'unknown' };
    } catch (e) {
      if (!clicked) return { result: 'failed', clicked: false, code: 'exception_before_click', message: `押下前に例外: ${e.message}`, stateAfter: 'unknown' };
      return { result: 'unknown', clicked: true, code: 'exception_after_click', message: `押下処理中に例外: ${e.message}`, stateAfter: 'unknown' };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async getNote(noteKey, { accountId } = {}) {
    const raw = await this._getJson(this.config.noteApi.endpoints.note, { key: noteKey }, { accountId });
    const d = raw && (raw.data || raw);
    if (!d) return null;
    return this._normalizeNote(d, null);
  }

  async _detectBlock(page) {
    // 記事本文の文言で誤検出しないよう、本文要素を除いたテキスト（ダイアログ・通知・ヘッダ等）だけを見る
    const text = (await page.evaluate((bodySel) => {
      if (!document.body) return '';
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll(bodySel).forEach((el) => el.remove());
      clone.querySelectorAll('script, style').forEach((el) => el.remove());
      return clone.innerText || clone.textContent || '';
    }, this.config.browser.articleBodySelector).catch(() => '')) || '';
    const url = page.url();
    if (/\/login|\/signup/.test(url)) return { code: 'auth_required', message: 'ログイン画面へ遷移（認証要求）' };
    if (/一時的に(スキ|いいね|フォロー).{0,20}(制限|ロック|できません)|(スキ|フォロー).{0,10}ロック|しばらく(時間|お時間)をおいて|アクセスが集中/.test(text)) return { code: 'like_locked', message: '一時ロック・制限と思われる表示' };
    if (/ログインしてください|ログインが必要/.test(text)) return { code: 'auth_required', message: 'ログインを求める表示' };
    return null;
  }

  async _likeButton(page) {
    const sel = this.config.browser.likeButtonSelector;
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) return null;
    return loc;
  }

  async _likeState(page) {
    const btn = await this._likeButton(page);
    if (!btn) return 'unknown';
    const pressed = await btn.getAttribute('aria-pressed').catch(() => null);
    if (pressed === 'true') return 'liked';
    if (pressed === 'false') return 'not_liked';
    const label = (await btn.getAttribute('aria-label').catch(() => null)) || '';
    if (/取り消|解除|済/.test(label)) return 'liked';
    const tokens = ((await btn.getAttribute('class').catch(() => null)) || '').split(/\s+/);
    const on = new Set(['active', 'is-active', 'liked', 'is-liked', 'is-on', 'on']);
    const off = new Set(['inactive', 'is-inactive', 'unliked', 'is-unliked', 'off', 'is-off']);
    if (tokens.some((t) => off.has(t))) return 'not_liked';
    if (tokens.some((t) => on.has(t))) return 'liked';
    return 'unknown';
  }

  /** 直前に開いた記事ページを閉じる（実行器が各対象の処理後に呼ぶ） */
  async release() {
    const lp = this._lastPage;
    if (!lp) return;
    this._lastPage = null;
    if (lp.page && !lp.page.isClosed()) await lp.page.close().catch(() => {});
  }

  async openAndReadNote(noteUrl, { accountId } = {}) {
    await this.release();
    const ctx = await this._context(accountId);
    const page = await ctx.newPage();
    try {
      await page.goto(noteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const blocked = await this._detectBlock(page);
      if (blocked) { await page.close().catch(() => {}); return { ok: false, bodyRendered: false, scrolledToEnd: false, likeState: 'unknown', finalUrl: page.url(), noteKey: null, authorUrlname: null, blocked }; }
      const body = page.locator(this.config.browser.articleBodySelector).first();
      let bodyRendered = false;
      try { await body.waitFor({ state: 'visible', timeout: 15000 }); bodyRendered = true; } catch (_) { bodyRendered = false; }
      this._lastPage = { accountId, page, url: noteUrl };
      // 本文を末尾まで表示する（制限回避の効果は仮定しない。教材の手順を再現するだけ）
      let scrolledToEnd = false;
      if (bodyRendered) {
        for (let i = 0; i < 60; i++) {
          const done = await page.evaluate((step) => {
            window.scrollBy(0, step);
            return window.innerHeight + window.scrollY >= document.body.scrollHeight - 2;
          }, this.config.browser.scrollStepPx);
          await page.waitForTimeout(this.config.browser.scrollPauseMs);
          if (done) { scrolledToEnd = true; break; }
        }
      }
      const m = page.url().match(/note\.com\/([A-Za-z0-9_]+)\/n\/([A-Za-z0-9]+)/);
      const likeState = await this._likeState(page);
      return { ok: bodyRendered, bodyRendered, scrolledToEnd, likeState, finalUrl: page.url(), noteKey: m ? m[2] : null, authorUrlname: m ? m[1] : null, blocked: null, _page: page };
    } catch (e) {
      await page.close().catch(() => {});
      return { ok: false, bodyRendered: false, scrolledToEnd: false, likeState: 'unknown', finalUrl: noteUrl, noteKey: null, authorUrlname: null, blocked: null, error: e.message };
    }
  }

  /**
   * スキを押す。直前に openAndReadNote で開いたページを再利用する。
   * 押下後に状態が liked になったことを確認できたときだけ succeeded。確認できなければ unknown。
   */
  async like(noteKey, { accountId, noteUrl } = {}) {
    let page = this._lastPage && this._lastPage.accountId === accountId && this._lastPage.url === noteUrl ? this._lastPage.page : null;
    let opened = false;
    if (!page || page.isClosed()) {
      const r = await this.openAndReadNote(noteUrl, { accountId });
      if (r.blocked) return { result: 'blocked', clicked: false, code: r.blocked.code, message: r.blocked.message, likeStateAfter: 'unknown' };
      if (!r.bodyRendered) return { result: 'failed', clicked: false, code: 'body_not_rendered', message: '本文が表示されない', likeStateAfter: 'unknown' };
      page = r._page;
      opened = true;
    }
    let clicked = false;
    try {
      const before = await this._likeState(page);
      if (before === 'liked') return { result: 'succeeded', clicked: false, code: 'already_liked', message: '既にスキ済み（再クリックしない）', likeStateAfter: 'liked' };
      if (before !== 'not_liked') return { result: 'failed', clicked: false, code: 'state_unknown_before_click', message: '押下前のスキ状態を確認できないため押さない（再クリックは解除になる可能性）', likeStateAfter: 'unknown' };
      const btn = await this._likeButton(page);
      if (!btn) return { result: 'failed', clicked: false, code: 'button_not_found', message: 'スキボタンが見つからない', likeStateAfter: 'unknown' };
      await btn.scrollIntoViewIfNeeded();
      try {
        await btn.click({ timeout: 5000 });
        clicked = true;
      } catch (e) {
        return { result: 'failed', clicked: false, code: 'click_failed', message: `クリック失敗: ${e.message}`, likeStateAfter: 'unknown' };
      }
      const deadline = Date.now() + this.config.browser.likeConfirmTimeoutMs;
      while (Date.now() < deadline) {
        const blocked = await this._detectBlock(page);
        if (blocked) return { result: 'blocked', clicked, code: blocked.code, message: blocked.message, likeStateAfter: 'unknown' };
        const st = await this._likeState(page);
        if (st === 'liked') return { result: 'succeeded', clicked, code: 'ok', message: '押下後にスキ状態を確認', likeStateAfter: 'liked' };
        await page.waitForTimeout(400);
      }
      return { result: 'unknown', clicked, code: 'confirm_timeout', message: '押下後の状態確認がタイムアウト。自動再送しない', likeStateAfter: 'unknown' };
    } catch (e) {
      if (!clicked) return { result: 'failed', clicked: false, code: 'exception_before_click', message: `押下前に例外: ${e.message}`, likeStateAfter: 'unknown' };
      return { result: 'unknown', clicked: true, code: 'exception_after_click', message: `押下処理中に例外: ${e.message}`, likeStateAfter: 'unknown' };
    } finally {
      if (page && !page.isClosed()) await page.close().catch(() => {});
      this._lastPage = null;
    }
  }

  async _pause() {
    const ms = this.config.requestIntervalMs || 0;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  async close() {
    for (const { browser } of this.browsers.values()) {
      // CDP 接続を切るだけ。ユーザーの Chrome は閉じない
      await browser.close().catch(() => {});
    }
    this.browsers.clear();
  }
}

module.exports = { NoteBrowserAdapter, parseNoteDate, pick, toInt };
