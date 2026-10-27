'use strict';

/**
 * フォルダ1 の起動入口。
 *   serve   操作画面（既定: モック + ドライラン）
 *   status / collect / plan / run / export / verify-session / outcomes / probe
 */

const path = require('node:path');
const { App, ROOT_DIR } = require('./app');
const { createServer, listen } = require('./server');

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(`使い方:
  node src/cli.js serve [--adapter=mock|note] [--port=3747] [--db=path] [--world=fixture.json]
  node src/cli.js status [--adapter=...] [--db=...]
  node src/cli.js collect [--account=karasu|koisi|pengi] [--mode=suki|follower]
  node src/cli.js plan    [--account=...] [--mode=...]
  node src/cli.js run     [--account=...] [--mode=...] [--max=N] [--real]   （既定はドライラン）
  node src/cli.js export
  node src/cli.js verify-session [--account=...]
  node src/cli.js outcomes [--account=...]
  node src/cli.js probe <currentUser|creator|creatorNotes|note|noteLikes|followers> [urlname=..] [key=..] [page=1]  （--adapter=note のみ）
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'serve';
  if (cmd === 'help' || args.help) { usage(); return; }
  const adapterKind = args.adapter || 'mock';
  const app = new App({ rootDir: ROOT_DIR, adapterKind, dbPath: args.db || null, worldFile: args.world || null, log: (m) => console.log(m) });
  const account = args.account ? app.accounts.find((a) => a.id === args.account) : app.account;
  if (args.account && !account) throw new Error(`不明なアカウント: ${args.account}`);
  const mode = args.mode || app.mode;

  try {
    switch (cmd) {
      case 'serve': {
        const server = createServer(app, { log: (m) => console.log(m) });
        const addr = await listen(server, { port: Number(args.port || 3747) });
        console.log(`操作画面: http://127.0.0.1:${addr.port}/  （adapter=${adapterKind}、実アクション=${app.config.enableRealActions ? 'ON' : 'OFF'}、定期実行=OFF）`);
        console.log(`共有DB: ${app.config.dbPath}`);
        await new Promise((resolve) => { process.on('SIGINT', resolve); process.on('SIGTERM', resolve); });
        server.close();
        break;
      }
      case 'status': {
        const s = app.state();
        console.log(JSON.stringify({ adapter: s.adapter.name, mode: s.mode, selectedAccountId: s.selectedAccountId, flags: s.flags, counts: s.counts, accounts: s.accounts.map((a) => ({ id: a.id, assigned: a.assigned, targets: a.targets, limits: { internalRemaining: a.limits.internalRemaining, usedToday: a.limits.usedToday, usedLastHour: a.limits.usedLastHour, externalBlock: a.limits.externalBlock } })) }, null, 2));
        break;
      }
      case 'collect': {
        const r = await app.collect({ mode, accountId: account.id });
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'plan': {
        console.log(JSON.stringify(app.plan({ mode, accountId: account.id }), null, 2));
        break;
      }
      case 'run': {
        const dryRun = !args.real;
        const r = await app.startRun({ dryRun, maxCount: args.max || null, mode, accountId: account.id });
        console.log(JSON.stringify(r, null, 2));
        if (r.started) { await app.waitRun(); console.log(JSON.stringify(app.runner.status().lastRun, null, 2)); }
        break;
      }
      case 'export': {
        console.log(JSON.stringify(app.export(), null, 2));
        break;
      }
      case 'verify-session': {
        console.log(JSON.stringify(await app.verifySession(account.id), null, 2));
        break;
      }
      case 'outcomes': {
        console.log(JSON.stringify(await app.checkOutcomes(account.id), null, 2));
        break;
      }
      case 'probe': {
        if (adapterKind !== 'note') throw new Error('probe は --adapter=note でのみ使えます');
        const name = args._[1];
        const vars = {};
        for (const kv of args._.slice(2)) { const [k, v] = kv.split('='); vars[k] = v; }
        const raw = await app.adapter.probe(name, vars, { accountId: account.id });
        console.log(JSON.stringify(raw, null, 2));
        break;
      }
      default:
        usage();
        process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => { console.error(`エラー: ${e.message}`); process.exitCode = 1; });
