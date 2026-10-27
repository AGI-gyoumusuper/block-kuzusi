'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { openDb } = require('../shared/db');
const { Ledger } = require('../shared/ledger');
const { Limits } = require('../shared/limits');
const { Seeds } = require('../shared/seeds');
const { MockAdapter } = require('../shared/adapters/mock');
const { fixedClock } = require('../shared/clock');
const { loadConfig } = require('../shared/config');
const { normalizeAccount } = require('../shared/accounts');
const { Runner } = require('../shared/runner');
const { App } = require('../1/src/app');

const ROOT = path.resolve(__dirname, '..');
const NOW = '2026-10-27T03:00:00.000Z'; // JST 12:00

function world() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'mock-world.json'), 'utf8')); }

function testConfig(overrides = {}) {
  const cfg = loadConfig({ rootDir: ROOT, overrides: { requestIntervalMs: 0, betweenLikesMs: 0, limits: { minIntervalMs: 0, defaults: { dailyLimit: 200, hourlyLimit: 50, capacity: 50, recoveryIntervalMin: 20, recoveryAmount: 10 } }, ...overrides }, env: {} });
  return cfg;
}

/** 共通層の素組み（App を使わない低レベルテスト用） */
function harness({ clockIso = NOW, configOverrides = {}, worldOverride = null, dbFile = ':memory:' } = {}) {
  const clock = fixedClock(clockIso);
  const config = testConfig(configOverrides);
  const accounts = config.accounts.map(normalizeAccount);
  const db = openDb(dbFile);
  const ledger = new Ledger(db);
  const limits = new Limits(db, { tzOffsetMinutes: 540, minIntervalMs: config.limits.minIntervalMs });
  const nowIso = clock.now().toISOString();
  for (const a of accounts) limits.configure(a.id, { ...config.limits.defaults, note: 'test' }, nowIso);
  const seeds = new Seeds(ledger);
  const adapter = new MockAdapter(worldOverride || world(), { clock, accounts });
  const runner = new Runner({ ledger, limits, adapter, clock, config, accounts, sleep: async () => {} });
  return { clock, config, accounts, db, ledger, limits, seeds, adapter, runner, nowIso };
}

function tmpDir(prefix = 'note-tool-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** App を一時DBで作る */
function makeApp({ clockIso = NOW, dbPath = ':memory:', overrides = {}, adapter = null, worldOverride = null } = {}) {
  const clock = fixedClock(clockIso);
  const cfg = { requestIntervalMs: 0, betweenLikesMs: 0, limits: { minIntervalMs: 0, defaults: { dailyLimit: 200, hourlyLimit: 50, capacity: 50, recoveryIntervalMin: 20, recoveryAmount: 10 } }, exportDir: path.join(tmpDir(), 'exports'), ...overrides };
  let ad = adapter;
  if (!ad && worldOverride) {
    const accounts = loadConfig({ rootDir: ROOT, env: {} }).accounts.map(normalizeAccount);
    ad = new MockAdapter(worldOverride, { clock, accounts });
  }
  const app = new App({ rootDir: ROOT, adapterKind: 'mock', overrides: cfg, clock, dbPath, adapter: ad });
  app.runner.sleep = async () => {};
  return app;
}

async function seedAndVerify(app, mode, url) {
  const { seed } = app.addSeed({ mode, url });
  return app.verifySeed(seed.id);
}

module.exports = { ROOT, NOW, world, testConfig, harness, tmpDir, makeApp, seedAndVerify };
