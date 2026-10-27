'use strict';

/**
 * 操作画面のローカルサーバー（node:http のみ。外部依存なし）。127.0.0.1 にのみ待ち受ける。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
}

/**
 * 書き込み要求は、同一オリジン（127.0.0.1/localhost の自ポート）からで、画面が付ける専用ヘッダを持つものだけ受け付ける。
 * 他サイトのページからの単純 POST（CSRF / DNS リバインディング）で実アクション ON や開始がされないようにする。
 */
function sameOriginWrite(req) {
  if (req.headers['x-note-tool'] !== '1') return false;
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { const o = new URL(origin); if (!/^(127\.0\.0\.1|localhost)$/.test(o.hostname) || (o.port || '80') !== (host.split(':')[1] || '80')) return false; } catch (_) { return false; }
  }
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('JSON を解釈できません')); } });
    req.on('error', reject);
  });
}

function createServer(app, { log = () => {} } = {}) {
  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  on('GET', '/api/state', async () => app.state());
  on('GET', '/api/criteria', async (_p, q) => require('../../shared/criteria').criteriaFor(q.get('mode') || app.mode));
  on('POST', '/api/account', async (_p, _q, body) => ({ selectedAccountId: app.selectAccount(body.id) }));
  on('POST', '/api/mode', async (_p, _q, body) => ({ mode: app.setMode(body.mode) }));
  on('POST', '/api/config', async (_p, _q, body) => app.setConfig(body));
  on('POST', '/api/seeds', async (_p, _q, body) => app.addSeed(body));
  on('POST', '/api/seeds/:id/verify', async (p) => app.verifySeed(p.id));
  on('POST', '/api/seeds/:id/url', async (p, _q, body) => app.setSeedUrl(p.id, body.url));
  on('POST', '/api/seeds/:id/enabled', async (p, _q, body) => app.setSeedEnabled(p.id, !!body.enabled));
  on('DELETE', '/api/seeds/:id', async (p) => ({ removed: app.removeSeed(p.id) }));
  on('POST', '/api/collect', async (_p, _q, body) => app.collect(body || {}));
  on('GET', '/api/plan', async () => app.plan());
  on('GET', '/api/preview', async (_p, q) => app.preview({ mode: q.get('mode') || undefined }));
  on('POST', '/api/run/start', async (_p, _q, body) => app.startRun(body || {}));
  on('POST', '/api/run/pause', async () => ({ paused: app.pause() }));
  on('POST', '/api/run/resume', async () => ({ resumed: app.resume() }));
  on('POST', '/api/run/stop', async () => ({ stopping: app.stop() }));
  on('GET', '/api/run/status', async () => app.runner.status());
  on('POST', '/api/unknown/:personId/resolve', async (p, _q, body) => app.resolveUnknown(p.personId, body && body.accountId));
  on('POST', '/api/outcomes/check', async (_p, _q, body) => app.checkOutcomes(body && body.accountId));
  on('POST', '/api/export', async () => app.export());
  on('GET', '/api/explain/:personId', async (p) => app.explain(p.personId));
  on('GET', '/api/own-article', async (_p, q) => app.ownArticle(q.get('accountId') || undefined));
  on('POST', '/api/session/verify', async (_p, _q, body) => app.verifySession(body && body.accountId));
  on('POST', '/api/limits/:accountId/clear-block', async (p) => app.clearExternalBlock(p.accountId));
  on('POST', '/api/limits/:accountId/:opType', async (p, _q, body) => app.setLimits(p.accountId, p.opType, body));
  on('POST', '/api/exclusions', async (_p, _q, body) => app.addExclusion(body));
  on('DELETE', '/api/exclusions/:urlname', async (p) => app.removeExclusion(decodeURIComponent(p.urlname)));
  on('GET', '/api/events', async (_p, q) => app.ledger.listEvents(Number(q.get('limit') || 100)));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && !sameOriginWrite(req)) {
          return send(res, 403, { error: '他オリジンからの書き込みは受け付けない（Origin/Host 不一致または専用ヘッダなし）' });
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          const body = req.method === 'POST' || req.method === 'DELETE' ? await readJson(req) : null;
          const out = await r.handler(m.groups || {}, url.searchParams, body);
          return send(res, 200, out == null ? {} : out);
        }
        return send(res, 404, { error: 'not found' });
      }
      let file = url.pathname === '/' ? '/index.html' : url.pathname;
      file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(PUBLIC_DIR, file);
      if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
      return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
    } catch (e) {
      log(`API error ${req.method} ${url.pathname}: ${e.message}`);
      return send(res, 400, { error: e.message });
    }
  });
  return server;
}

function listen(server, { port = 3747, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}

module.exports = { createServer, listen };
