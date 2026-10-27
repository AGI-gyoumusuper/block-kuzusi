'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, NOW } = require('./helpers');
const { HOUR_MS, DAY_MS } = require('../shared/clock');

const at = (ms) => new Date(new Date(NOW).getTime() + ms);

test('上限未設定のアカウントは実行できない（黙って補完しない）', () => {
  const { limits, clock } = harness();
  limits.configure('x', { dailyLimit: null, hourlyLimit: 50, capacity: 50, internalRemaining: 50, recoveryIntervalMin: 20, recoveryAmount: 10 }, clock.now().toISOString());
  const r = limits.canExecute('x', clock.now());
  assert.equal(r.ok, false);
  assert.equal(r.code, 'limits_unset');
  assert.equal(limits.canExecute('nobody', clock.now()).code, 'limits_unset');
});

test('7.5 20分回復: 区間ごとに回復し、上限で止まり、半端な経過は持ち越す', () => {
  const { limits } = harness();
  limits.configure('karasu', { capacity: 50, internalRemaining: 0, recoveryIntervalMin: 20, recoveryAmount: 10 }, NOW);
  assert.equal(limits.status('karasu', at(19 * 60e3)).internalRemaining, 0);
  assert.equal(limits.status('karasu', at(20 * 60e3)).internalRemaining, 10);
  assert.equal(limits.status('karasu', at(59 * 60e3)).internalRemaining, 20, '20分→10、40分→20、59分はまだ20');
  assert.equal(limits.status('karasu', at(60 * 60e3)).internalRemaining, 30);
  assert.equal(limits.status('karasu', at(10 * HOUR_MS)).internalRemaining, 50, '上限 capacity で止まる');
  const s = limits.status('karasu', at(10 * HOUR_MS));
  assert.ok(s.nextRecoveryAt);
});

test('7.5 内部残数・日次・時間上限は独立に働く', () => {
  const { limits } = harness();
  limits.configure('karasu', { dailyLimit: 3, hourlyLimit: 2, capacity: 10, internalRemaining: 10, recoveryIntervalMin: 20, recoveryAmount: 0 }, NOW);
  assert.equal(limits.canExecute('karasu', at(0)).ok, true);
  limits.consume('karasu', at(0)); limits.consume('karasu', at(60e3));
  assert.equal(limits.canExecute('karasu', at(120e3)).code, 'hourly_exhausted');
  assert.equal(limits.canExecute('karasu', at(HOUR_MS + 1)).ok, true, '1時間経てば時間上限は解ける（最初の1件が窓から出る）');
  limits.consume('karasu', at(HOUR_MS + 1));
  assert.equal(limits.canExecute('karasu', at(2 * HOUR_MS + 2)).code, 'daily_exhausted', '日次3件に到達');
  assert.equal(limits.status('karasu', at(0)).internalRemaining, 7);
  // 内部残数のみ枯渇
  limits.configure('koisi', { dailyLimit: 100, hourlyLimit: 100, capacity: 1, internalRemaining: 1, recoveryIntervalMin: 20, recoveryAmount: 0 }, NOW);
  limits.consume('koisi', at(0));
  assert.equal(limits.canExecute('koisi', at(0)).code, 'internal_exhausted');
});

test('日次集計は JST の日付で切り替わる（日付変更で使用済み枠を都合よく初期化しない: 当日分は残る）', () => {
  const { limits } = harness();
  limits.configure('karasu', { dailyLimit: 1, hourlyLimit: 10, capacity: 10, internalRemaining: 10, recoveryIntervalMin: 20, recoveryAmount: 0 }, NOW);
  // NOW = 2026-10-27T03:00Z = JST 12:00
  limits.consume('karasu', at(0));
  assert.equal(limits.canExecute('karasu', at(HOUR_MS)).code, 'daily_exhausted');
  // JST 23:59 はまだ同じ日
  assert.equal(limits.canExecute('karasu', new Date('2026-10-27T14:59:00Z')).code, 'daily_exhausted');
  // JST 翌日 00:00 で日次は新しい日に
  const next = limits.canExecute('karasu', new Date('2026-10-27T15:00:00Z'));
  assert.equal(next.ok, true);
  assert.equal(next.status.usedToday, 0);
  // ただし使用履歴と内部残数は消えない
  assert.equal(limits.status('karasu', new Date('2026-10-27T15:00:00Z')).internalRemaining, 9);
  assert.equal(limits.usageRows('karasu').length, 1);
});

test('7.5 外部制限は内部残数より優先し、解除確認まで実行しない', () => {
  const { limits } = harness();
  limits.configure('karasu', { dailyLimit: 100, hourlyLimit: 100, capacity: 50, internalRemaining: 50, recoveryIntervalMin: 20, recoveryAmount: 10 }, NOW);
  limits.setExternalBlock('karasu', { code: 'like_locked', message: 'スキの一時ロック' }, NOW);
  const r = limits.canExecute('karasu', at(DAY_MS));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'external_block');
  assert.equal(r.status.internalRemaining, 50, '残数があっても止まる');
  limits.clearExternalBlock('karasu', NOW);
  assert.equal(limits.canExecute('karasu', at(DAY_MS)).ok, true);
});

test('最小間隔が未経過なら待ち時間を返す', () => {
  const { limits } = harness({ configOverrides: { limits: { minIntervalMs: 20000 } } });
  limits.minIntervalMs = 20000;
  limits.consume('karasu', at(0));
  const r = limits.canExecute('karasu', at(5000));
  assert.equal(r.code, 'interval');
  assert.equal(r.waitMs, 15000);
  assert.equal(limits.canExecute('karasu', at(20000)).ok, true);
});
