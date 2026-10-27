'use strict';

/**
 * 操作画面の自動テスト（Playwright + モックアダプタ）。playwright が無い環境では skip。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp } = require('./helpers');
const { createServer, listen } = require('../1/完成品/src/server');

let playwright = null;
try { playwright = require('playwright'); } catch (_) { playwright = null; }

test('操作画面: アカウント・モード・起点確認・収集・予定・ドライラン実行・結果不明・CSV', { skip: !playwright && 'playwright 未導入' }, async () => {
  const app = makeApp();
  app.runner.sleep = async (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  const server = createServer(app);
  const addr = await listen(server, { port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  try {
    await page.goto(base);
    await page.waitForSelector('#accounts .card');
    assert.equal(await page.locator('#accounts .card').count(), 3, '3アカウント');
    assert.match(await page.locator('#f-real').textContent(), /OFF/);
    assert.match(await page.locator('#f-sched').textContent(), /OFF/);
    // 起点の本人確認（かみなり / モック起点）
    await page.waitForSelector('#seeds tbody tr');
    const verifyButtons = page.locator('#seeds [data-sv]:not([disabled])');
    const n = await verifyButtons.count();
    for (let i = 0; i < n; i++) { await verifyButtons.nth(i).click(); await page.waitForTimeout(150); }
    await page.waitForFunction(() => document.querySelectorAll('#seeds .badge.adopt').length >= 2);
    assert.ok((await page.locator('#seeds').textContent()).includes('URL未確認'), 'しちゃうおじさんは URL 未確認表示');
    // モード切替 → フォロワー獲得
    await page.locator('input[name=mode][value=follower]').check();
    await page.waitForFunction(() => document.querySelector('input[name=mode][value=follower]').checked);
    // 収集
    await page.locator('#collect').click();
    await page.waitForFunction(() => document.querySelector('#collect-msg').textContent === '完了');
    const statsText = await page.locator('#collect-stats').textContent();
    assert.ok(statsText.includes('新規取得') && statsText.includes('重複除外') && statsText.includes('活動条件不合格') && statsText.includes('実行可能'));
    await page.waitForFunction(() => document.querySelectorAll('#plan tbody tr').length >= 1);
    // 名簿プレビューに反応日時不明・理由ボタン
    await page.waitForFunction(() => document.querySelectorAll('#preview tbody tr').length >= 5);
    await page.locator('#preview [data-why]').first().click();
    await page.waitForSelector('dialog[open]');
    assert.ok((await page.locator('#dlg-body').textContent()).includes('evaluations'));
    await page.locator('#dlg-close').click();
    // ドライラン実行（既定チェック済み）
    assert.equal(await page.locator('#run-dry').isChecked(), true);
    await page.locator('#run-start').click();
    await page.waitForFunction(() => /ドライラン対象/.test(document.querySelector('#run-summary').textContent) && document.querySelector('#run-start').disabled === false, null, { timeout: 15000 });
    assert.equal(app.adapter.likeCalls.length, 0, '画面からのドライランで実スキは送られない');
    // 実送信は実アクションOFFのため拒否される（確認ダイアログは accept）
    await page.locator('#run-dry').uncheck();
    await page.locator('#run-start').click();
    await page.waitForTimeout(300);
    assert.equal(app.adapter.likeCalls.length, 0);
    assert.ok(app.ledger.listEvents(5).some((e) => e.code === 'real_actions_disabled'));
    // CSV 出力
    await page.locator('#export').click();
    await page.waitForFunction(() => /roster_/.test(document.querySelector('#export-msg').textContent));
    assert.deepEqual(errors, [], `画面の JS エラー: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
    server.close();
    await app.close();
  }
});
