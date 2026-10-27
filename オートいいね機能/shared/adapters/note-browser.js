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
    if (res.status() === 401 || res.status() === 403) {
      const err = new Error(`認証要求または拒否 (${res.status()}): ${url}`);
      err.code = 'auth_required';
      throw err;
    }
    if (res.status() === 404) return null;
    if (res.status() === 429) {
      const err = new Error(`レート制限 (429): ${url}`);
      err.code = 'rate_limited';
      throw err;
    }
    if (!res.ok()) throw new Error(`HTTP ${res.status()}: ${url}`);
    return res.json();
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

  async getCreator(urlname) {
    const raw = await this._getJson(this.config.noteApi.endpoints.creator, { urlname });
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
      likeCount: toInt(pick(n, ['likeCount', 'like_count'])) || 0,
      authorUrlname: author,
      authorUserId: pick(n, ['user.id', 'creator.id']) != null ? String(pick(n, ['user.id', 'creator.id'])) : null,
      isLikedByMe: (() => { const v = pick(n, ['isLiked', 'is_liked', 'liked']); return typeof v === 'boolean' ? v : null; })(),
    };
  }

  async getCreatorNotes(urlname, { limit = 20 } = {}) {
    const notes = [];
    let page = 1;
    let complete = false;
    while (notes.length < limit && page <= 10) {
      const raw = await this._getJson(this.config.noteApi.endpoints.creatorNotes, { urlname, page });
      const d = raw && (raw.data || raw);
      const list = pick(d, ['contents', 'notes', 'items']) || [];
      if (!Array.isArray(list) || list.length === 0) { complete = true; break; }
      for (const n of list) notes.push(this._normalizeNote(n, urlname));
      const isLast = pick(d, ['isLastPage', 'is_last_page']);
      if (isLast === true) { complete = true; break; }
      if (isLast === null && list.length < 5) { complete = true; break; }
      page++;
      await this._pause();
    }
    // 並び順: 取得元が公開日時降順であることを利用者が実応答で確認したら config.noteApi.notesOrderClaim = 'published_desc' にする。
    // 未確認のままなら 'unknown' とし、全件取得できない場合は最新記事を確定しない（取得順を最新順と決めつけない）
    return { notes: notes.slice(0, limit), complete: complete && notes.length <= limit, orderClaim: this.config.noteApi.notesOrderClaim || 'unknown' };
  }

  async getNoteLikes(noteKey, { limit = 100 } = {}) {
    const likers = [];
    let page = 1;
    let complete = false;
    while (likers.length < limit && page <= 10) {
      const raw = await this._getJson(this.config.noteApi.endpoints.noteLikes, { key: noteKey, page });
      const d = raw && (raw.data || raw);
      const list = pick(d, ['likes', 'users', 'items', 'contents']) || [];
      if (!Array.isArray(list) || list.length === 0) { complete = true; break; }
      for (const item of list) {
        const u = item.user || item.creator || item;
        const urlname = pick(u, ['urlname']);
        if (!urlname) continue;
        likers.push({
          urlname,
          userId: pick(u, ['id']) != null ? String(pick(u, ['id'])) : null,
          displayName: pick(u, ['nickname', 'name']) || '',
          likedAt: parseNoteDate(pick(item, ['createdAt', 'created_at', 'likedAt', 'liked_at'])),
        });
      }
      const isLast = pick(d, ['isLastPage', 'is_last_page']);
      if (isLast === true) { complete = true; break; }
      if (isLast === null && list.length < 5) { complete = true; break; }
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

  async getFollowers(urlname, { limit = 200 } = {}) {
    const followers = [];
    let page = 1;
    let complete = false;
    while (followers.length < limit && page <= 20) {
      const raw = await this._getJson(this.config.noteApi.endpoints.followers, { urlname, page });
      const d = raw && (raw.data || raw);
      const list = pick(d, ['followers', 'users', 'items', 'contents']) || [];
      if (!Array.isArray(list) || list.length === 0) { complete = true; break; }
      for (const item of list) {
        const u = item.user || item.creator || item;
        const got = pick(u, ['urlname']);
        if (!got) continue;
        followers.push({ urlname: got, userId: pick(u, ['id']) != null ? String(pick(u, ['id'])) : null, displayName: pick(u, ['nickname', 'name']) || '' });
      }
      const isLast = pick(d, ['isLastPage', 'is_last_page']);
      if (isLast === true) { complete = true; break; }
      if (isLast === null && list.length < 5) { complete = true; break; }
      page++;
      await this._pause();
    }
    return { followers: followers.slice(0, limit), complete };
  }

  async getNote(noteKey, { accountId } = {}) {
    const raw = await this._getJson(this.config.noteApi.endpoints.note, { key: noteKey }, { accountId });
    const d = raw && (raw.data || raw);
    if (!d) return null;
    return this._normalizeNote(d, null);
  }

  async _detectBlock(page) {
    const text = (await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')) || '';
    const url = page.url();
    if (/\/login|\/signup/.test(url)) return { code: 'auth_required', message: 'ログイン画面へ遷移（認証要求）' };
    if (/一時的に(スキ|いいね).{0,20}(制限|ロック|できません)|スキ.{0,10}ロック|しばらく(時間|お時間)をおいて/.test(text)) return { code: 'like_locked', message: 'スキの一時ロックと思われる表示' };
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
    const cls = (await btn.getAttribute('class').catch(() => null)) || '';
    if (/active|liked|is-on/.test(cls)) return 'liked';
    return 'unknown';
  }

  /** 直前に開いた記事ページを閉じる（実行器が各対象の処理後に呼ぶ） */
  async release(accountId) {
    const lp = this._lastPage;
    if (!lp || (accountId && lp.accountId !== accountId)) return;
    this._lastPage = null;
    if (lp.page && !lp.page.isClosed()) await lp.page.close().catch(() => {});
  }

  async openAndReadNote(noteUrl, { accountId } = {}) {
    await this.release(accountId);
    const ctx = await this._context(accountId);
    const page = await ctx.newPage();
    try {
      await page.goto(noteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const blocked = await this._detectBlock(page);
      if (blocked) return { ok: false, bodyRendered: false, scrolledToEnd: false, likeState: 'unknown', finalUrl: page.url(), noteKey: null, authorUrlname: null, blocked };
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
    try {
      const before = await this._likeState(page);
      if (before === 'liked') return { result: 'succeeded', clicked: false, code: 'already_liked', message: '既にスキ済み（再クリックしない）', likeStateAfter: 'liked' };
      const btn = await this._likeButton(page);
      if (!btn) return { result: 'failed', clicked: false, code: 'button_not_found', message: 'スキボタンが見つからない', likeStateAfter: 'unknown' };
      await btn.scrollIntoViewIfNeeded();
      let clicked = false;
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
