'use strict';

/** フォルダ2 操作画面の自動テスト（Playwright + モック）。playwright が無い環境では skip */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, NOW, world } = require('./helpers');
const { App2 } = require('../2/完成品2/src/app2');
const { createServer2, listen } = require('../2/完成品2/src/server2');
const { fixedClock } = require('../shared/clock');

let playwright = null;
try { playwright = require('playwright'); } catch (_) { playwright = null; }

test('フォルダ2 画面: 初期OFF表示、枠の表示、収集、設定ON、上限設定、ドライラン、CSV', { skip: !playwright && 'playwright 未導入' }, async () => {
  const ROOT = path.resolve(__dirname, '..');
  const clock = fixedClock(NOW);
  const { MockAdapter } = require('../shared/adapters/mock');
  const { loadConfig } = require('../shared/config');
  const { normalizeAccount } = require('../shared/accounts');
  const accounts = loadConfig({ rootDir: ROOT, env: {} }).accounts.map(normalizeAccount);
  const w = world();
  w.creators._karasu.followers = ['p_ratio_gt', 'p_ratio_eq'];
  const adapter = new MockAdapter(w, { clock, accounts });
  const app = new App2({ rootDir: ROOT, adapterKind: 'mock', overrides: { requestIntervalMs: 0, betweenLikesMs: 0, limits: { minIntervalMs: 0 }, exportDir: path.join(tmpDir(), 'exports') }, clock, dbPath: ':memory:', adapter });
  app.runner.sleep = async (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  const server = createServer2(app);
  const addr = await listen(server, { port: 0 });
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') {
      const m = d.message();
      await d.accept(/日次/.test(m) ? '20' : /直近1時間/.test(m) ? '10' : /容量/.test(m) ? '5' : /内部残数/.test(m) ? '' : /回復間隔/.test(m) ? '20' : /回復量/.test(m) ? '1' : '');
    } else await d.accept();
  });
  try {
    await page.goto(`http://127.0.0.1:${addr.port}/`);
    await page.waitForSelector('#accounts .card');
    assert.match(await page.locator('#f-fb').textContent(), /OFF/);
    assert.match(await page.locator('#f-real').textContent(), /OFF/);
    assert.ok((await page.locator('#accounts').textContent()).includes('follow_back'));
    assert.ok((await page.locator('#accounts').textContent()).includes('上限が未設定'));
    await page.locator('#collect').click();
    await page.waitForFunction(() => document.querySelector('#collect-msg').textContent === '完了');
    assert.ok((await page.locator('#collect-stats').textContent()).includes('採用可'));
    await page.waitForFunction(() => document.querySelectorAll('#plan tbody tr').length >= 1);
    // OFF のまま開始 → 拒否（alert を accept）
    await page.locator('#run-start').click();
    await page.waitForTimeout(300);
    assert.ok(app.ledger.listEvents(5).some((e) => e.code === 'follow_back_disabled'));
    // ON にして上限を設定し、ドライラン
    await page.locator('#cfg-fb').check();
    await page.waitForFunction(() => /ON/.test(document.querySelector('#f-fb').textContent));
    await page.locator('[data-limits="karasu"][data-op="follow_back"]').click();
    await page.waitForFunction(() => !/上限が未設定/.test(document.querySelector('#accounts .card').textContent));
    await page.locator('#run-start').click();
    await page.waitForFunction(() => /ドライラン対象/.test(document.querySelector('#run-summary').textContent) && document.querySelector('#run-start').disabled === false, null, { timeout: 15000 });
    assert.equal(app.adapter.followCalls.length, 0, '画面からのドライランで実フォローは送らない');
    await page.locator('#export').click();
    await page.waitForFunction(() => /roster_/.test(document.querySelector('#export-msg').textContent));
    assert.deepEqual(errors, [], `画面の JS エラー: ${errors.join(' | ')}`);
  } finally {
    await browser.close(); server.close(); await app.close();
  }
});
