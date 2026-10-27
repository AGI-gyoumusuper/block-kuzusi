'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, NOW } = require('./helpers');
const { HOUR_MS, DAY_MS } = require('../shared/clock');
const { OP } = require('../shared/ledger');

const at = (ms) => new Date(new Date(NOW).getTime() + ms);
const MIN = 60e3;

test('上限未設定・不正なアカウント/枠は開始不可（黙って補完しない）。follow 枠は初期状態で未設定', () => {
  const { limits } = harness();
  assert.equal(limits.canExecute('karasu', 'follow_back', at(0)).code, 'limits_unset');
  assert.equal(limits.canExecute('nobody', 'like', at(0)).code, 'limits_unset');
  limits.configure('x', 'like', { dailyLimit: null, hourlyLimit: 50, capacity: 50, credits: 50, recoveryIntervalMin: 20, recoveryAmount: 1 }, NOW);
  const r = limits.canExecute('x', 'like', at(0));
  assert.equal(r.code, 'limits_unset');
  assert.deepEqual(r.status.validity.missing, ['daily_limit']);
  limits.configure('y', 'like', { dailyLimit: 10, hourlyLimit: 5, capacity: 0, credits: 0, recoveryIntervalMin: 20, recoveryAmount: 1 }, NOW);
  assert.equal(limits.canExecute('y', 'like', at(0)).code, 'limits_invalid');
  limits.configure('z', 'like', { dailyLimit: 10, hourlyLimit: 5, capacity: 5, credits: 5, recoveryIntervalMin: 0, recoveryAmount: 1 }, NOW);
  assert.equal(limits.canExecute('z', 'like', at(0)).code, 'limits_invalid');
});

test('枠はアカウント×action種別。2モードは同じ like 枠、follow は別枠、3アカウントは混同しない', () => {
  const { limits } = harness();
  limits.configure('karasu', 'follow_back', { dailyLimit: 10, hourlyLimit: 10, capacity: 3, credits: 3, recoveryIntervalMin: 20, recoveryAmount: 1 }, NOW);
  limits.consume('karasu', 'like', at(0));
  limits.consume('karasu', 'like', at(1000));
  assert.equal(limits.status('karasu', 'like', at(2000)).credits, 48);
  assert.equal(limits.status('karasu', 'follow_back', at(2000)).credits, 3, 'like の消費は follow 枠に影響しない');
  assert.equal(limits.status('koisi', 'like', at(2000)).credits, 50, '他アカウントの枠に影響しない');
  assert.equal(limits.status('karasu', 'like', at(2000)).usedToday, 2);
  assert.equal(limits.status('karasu', 'follow_back', at(2000)).usedToday, 0);
});

test('§2 残数0の起点: 正→0 の時点で empty_since/last_refill を設定し、19分59秒では回復せず 20分で +1', () => {
  const { limits } = harness();
  limits.configure('karasu', 'like', { capacity: 2, credits: 1 }, NOW);
  // 10分経過後に消費して 0 になる → 起点は消費時刻
  limits.consume('karasu', 'like', at(10 * MIN));
  const s0 = limits.status('karasu', 'like', at(10 * MIN));
  assert.equal(s0.credits, 0);
  assert.equal(s0.emptySince, at(10 * MIN).toISOString());
  assert.equal(s0.lastRefill, at(10 * MIN).toISOString());
  assert.equal(limits.status('karasu', 'like', at(10 * MIN + 19 * MIN + 59e3)).credits, 0, '19分59秒では回復しない');
  // 残数0の間の画面更新（status 呼び出し）で起点が動かない
  assert.equal(limits.status('karasu', 'like', at(10 * MIN + 19 * MIN + 59e3)).lastRefill, at(10 * MIN).toISOString());
  const s1 = limits.status('karasu', 'like', at(30 * MIN));
  assert.equal(s1.credits, 1, '20分ちょうどで +1');
  assert.equal(s1.emptySince, null);
  assert.equal(s1.lastRefill, at(30 * MIN).toISOString());
  assert.equal(s1.nextRefillAt, at(50 * MIN).toISOString());
});

test('§2 初期残数0で開始する場合は起点を一度だけ保存し、再起動（再構築）で更新しない', () => {
  const h = harness();
  h.limits.configure('karasu', 'follow_back', { dailyLimit: 10, hourlyLimit: 10, capacity: 5, credits: 0, recoveryIntervalMin: 20, recoveryAmount: 1 }, NOW);
  const s0 = h.limits.status('karasu', 'follow_back', at(5 * MIN));
  assert.equal(s0.emptySince, NOW);
  assert.equal(s0.lastRefill, NOW);
  // 別の Limits インスタンス（再起動相当）で status を読んでも起点は動かない
  const { Limits } = require('../shared/limits');
  const l2 = new Limits(h.db, { tzOffsetMinutes: 540 });
  assert.equal(l2.status('karasu', 'follow_back', at(15 * MIN)).lastRefill, NOW);
  assert.equal(l2.status('karasu', 'follow_back', at(20 * MIN)).credits, 1);
});

test('§2 複数区間の回復、容量上限での打ち切り、繰り越し禁止、二重回復の防止', () => {
  const { limits } = harness();
  limits.configure('karasu', 'like', { capacity: 3, credits: 0 }, NOW);
  assert.equal(limits.status('karasu', 'like', at(65 * MIN)).credits, 3, '3区間で+3');
  assert.equal(limits.status('karasu', 'like', at(65 * MIN)).lastRefill, at(60 * MIN).toISOString(), '処理した区間ぶん進む（半端5分は次へ）');
  assert.equal(limits.status('karasu', 'like', at(10 * HOUR_MS)).credits, 3, '容量で打ち切り');
  // 容量超過分は繰り越さない: 10時間後に1消費しても、次の+1は last_refill 起点の区間で
  limits.consume('karasu', 'like', at(10 * HOUR_MS + 1000));
  assert.equal(limits.status('karasu', 'like', at(10 * HOUR_MS + 2000)).credits, 2);
  const lr = limits.status('karasu', 'like', at(10 * HOUR_MS + 2000)).lastRefill;
  assert.equal(limits.status('karasu', 'like', at(new Date(lr).getTime() - new Date(NOW).getTime() + 19 * MIN)).credits, 2, '直前区間の残りを繰り越さない');
  // 同じ時刻で何度呼んでも二重に回復しない
  const t = 12 * HOUR_MS;
  const a = limits.status('karasu', 'like', at(t)).credits;
  const b = limits.status('karasu', 'like', at(t)).credits;
  assert.equal(a, b);
  assert.equal(a, 3);
});

test('§2 時計の巻き戻り: 負値にならず、余分な回復もしない', () => {
  const { limits, ledger } = harness();
  limits.configure('karasu', 'like', { capacity: 5, credits: 0 }, NOW);
  assert.equal(limits.status('karasu', 'like', at(40 * MIN)).credits, 2);
  const back = limits.status('karasu', 'like', at(-60 * MIN));
  assert.equal(back.credits, 2, '巻き戻りで減らない');
  assert.equal(back.lastRefill, at(-60 * MIN).toISOString(), '起点を現在に置き直す');
  assert.equal(limits.status('karasu', 'like', at(-41 * MIN)).credits, 2, '置き直した起点から19分では回復しない');
  assert.equal(limits.status('karasu', 'like', at(-40 * MIN)).credits, 3);
  assert.ok(ledger.listEvents(5).some((e) => e.code === 'clock_rollback'));
});

test('§2 有効残数 = min(内部, 日次, 時間) − 引当。内部が回復しても他が0なら実行しない', () => {
  const { limits } = harness();
  limits.configure('karasu', 'like', { dailyLimit: 3, hourlyLimit: 2, capacity: 10, credits: 10 }, NOW);
  assert.equal(limits.status('karasu', 'like', at(0)).effective, 2);
  limits.consume('karasu', 'like', at(0)); limits.consume('karasu', 'like', at(MIN));
  assert.equal(limits.canExecute('karasu', 'like', at(2 * MIN)).code, 'hourly_exhausted');
  assert.equal(limits.canExecute('karasu', 'like', at(HOUR_MS + 1)).ok, true, '最初の1件が窓から出る');
  limits.consume('karasu', 'like', at(HOUR_MS + 1));
  assert.equal(limits.canExecute('karasu', 'like', at(2 * HOUR_MS + 2)).code, 'daily_exhausted');
  // 内部 credits が回復しても日次0なら止まったまま
  assert.equal(limits.status('karasu', 'like', at(5 * HOUR_MS)).credits, 10);
  assert.equal(limits.canExecute('karasu', 'like', at(5 * HOUR_MS)).code, 'daily_exhausted');
  // 内部のみ枯渇
  limits.configure('koisi', 'like', { dailyLimit: 100, hourlyLimit: 100, capacity: 1, credits: 1, recoveryAmount: 0 }, NOW);
  limits.consume('koisi', 'like', at(0));
  const r = limits.canExecute('koisi', 'like', at(0));
  assert.equal(r.code, 'internal_exhausted');
  assert.equal(r.status.dailyAvailable, 99);
});

test('§2 日次は JST の日付、直近1時間は日付跨ぎでも継続、credits は満タンに戻さず繰り越す', () => {
  const { limits } = harness();
  limits.configure('karasu', 'like', { dailyLimit: 1, hourlyLimit: 10, capacity: 10, credits: 10, recoveryAmount: 0 }, NOW);
  limits.consume('karasu', 'like', new Date('2026-10-27T14:50:00Z')); // JST 23:50
  assert.equal(limits.canExecute('karasu', 'like', new Date('2026-10-27T14:59:00Z')).code, 'daily_exhausted');
  const next = limits.status('karasu', 'like', new Date('2026-10-27T15:00:00Z')); // JST 翌日 00:00
  assert.equal(next.usedToday, 0, '日次は切り替わる');
  assert.equal(next.usedLastHour, 1, '直近1時間は継続');
  assert.equal(next.credits, 9, 'credits は繰り越し（満タンに戻さない）');
  assert.equal(limits.usageRows('karasu', 'like').length, 1, '使用履歴は消えない');
});

test('§3 予約と引当: 有効残数が引当込みで計算され、同じ枠を二重予約しない', () => {
  const { limits, ledger } = harness();
  limits.configure('karasu', 'like', { dailyLimit: 10, hourlyLimit: 10, capacity: 1, credits: 1 }, NOW);
  const p1 = ledger.upsertPerson({ urlname: 'a', userId: 'ua' }, null, NOW).person.id;
  const p2 = ledger.upsertPerson({ urlname: 'b', userId: 'ub' }, null, NOW).person.id;
  ledger.ensureCandidate(p1, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, NOW);
  ledger.ensureCandidate(p2, OP.LIKE, { accountId: 'karasu', mode: 'suki' }, NOW);
  const r1 = limits.reserveWithCredit(ledger, { personId: p1, opType: OP.LIKE, accountId: 'karasu', runId: 'r' }, at(0), 60e3);
  assert.equal(r1.ok, true);
  assert.equal(limits.status('karasu', 'like', at(0)).holds, 1);
  assert.equal(limits.status('karasu', 'like', at(0)).effective, 0);
  const r2 = limits.reserveWithCredit(ledger, { personId: p2, opType: OP.LIKE, accountId: 'karasu', runId: 'r' }, at(0), 60e3);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'internal_exhausted', '引当込みで枠が無い');
  assert.equal(ledger.getTarget(p2, OP.LIKE).state, 'candidate');
  // 送信前の見送りで引当は戻る
  ledger.releaseReservation(p1, OP.LIKE, 'r', 'skip', NOW);
  assert.equal(limits.status('karasu', 'like', at(0)).effective, 1);
  assert.equal(limits.reserveWithCredit(ledger, { personId: p2, opType: OP.LIKE, accountId: 'karasu', runId: 'r' }, at(0), 60e3).ok, true);
});

test('§4 外部制限・認証切れ・権限不明は別状態で、内部回復では解除されず、20分経過で勝手に再開しない', () => {
  const { limits } = harness();
  limits.setExternalBlock('karasu', { kind: 'external_limit', code: 'rate_limited', message: '429' }, NOW);
  let r = limits.canExecute('karasu', 'like', at(DAY_MS));
  assert.equal(r.code, 'blocked_external_limit');
  assert.ok(r.status.credits > 0);
  limits.setExternalBlock('koisi', { kind: 'auth', code: 'auth_required', message: 'ログイン要求' }, NOW);
  assert.equal(limits.canExecute('koisi', 'like', at(DAY_MS)).code, 'blocked_auth');
  limits.setExternalBlock('pengi', { kind: 'permission_unknown', code: 'forbidden', message: '403' }, NOW);
  assert.equal(limits.canExecute('pengi', 'like', at(DAY_MS)).code, 'blocked_permission_unknown');
  assert.equal(limits.canExecute('karasu', 'follow_back', at(DAY_MS)).code, 'blocked_external_limit', 'ブロックはアカウント単位');
  limits.clearExternalBlock('karasu');
  assert.equal(limits.canExecute('karasu', 'like', at(DAY_MS)).ok, true);
  assert.throws(() => limits.setExternalBlock('karasu', { kind: 'nope' }, NOW));
});

test('最小間隔が未経過なら待ち時間を返す', () => {
  const { limits } = harness();
  limits.minIntervalMs = 20000;
  limits.consume('karasu', 'like', at(0));
  const r = limits.canExecute('karasu', 'like', at(5000));
  assert.equal(r.code, 'interval');
  assert.equal(r.waitMs, 15000);
  assert.equal(limits.canExecute('karasu', 'like', at(20000)).ok, true);
});
