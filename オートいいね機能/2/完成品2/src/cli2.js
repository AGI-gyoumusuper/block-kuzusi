'use strict';

/** フォルダ2 の起動入口。serve / status / collect / plan / run / export / verify-session */
const { App2, ROOT_DIR } = require('./app2');
const { createServer2, listen } = require('./server2');

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) { const m = a.match(/^--([\w-]+)(?:=(.*))?$/); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; else args._.push(a); }
  return args;
}
function usage() {
  console.log(`使い方:
  node src/cli2.js serve [--adapter=mock|note] [--port=3748] [--db=path] [--world=fixture.json]
  node src/cli2.js status | collect | plan | run [--real] [--max=N] | export | verify-session   [--account=karasu|koisi|pengi]
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'serve';
  if (cmd === 'help' || args.help) { usage(); return; }
  const adapterKind = args.adapter || 'mock';
  const readOnly = ['status', 'plan', 'export', 'verify-session'].includes(cmd);
  const app = new App2({ rootDir: ROOT_DIR, adapterKind, dbPath: args.db || null, worldFile: args.world || null, log: (m) => console.log(m), recover: !readOnly });
  const account = args.account ? app.accounts.find((a) => a.id === args.account) : app.account;
  if (args.account && !account) throw new Error(`不明なアカウント: ${args.account}`);
  try {
    switch (cmd) {
      case 'serve': {
        const server = createServer2(app, { log: (m) => console.log(m) });
        const addr = await listen(server, { port: Number(args.port || 3748) });
        console.log(`フォルダ2 操作画面: http://127.0.0.1:${addr.port}/  （adapter=${adapterKind}、フォロー返し=${app.config.followBack.enabled ? 'ON' : 'OFF'}、実アクション=${app.config.enableRealActions ? 'ON' : 'OFF'}、定期実行=OFF）`);
        console.log(`共有DB: ${app.config.dbPath}`);
        await new Promise((resolve) => { process.on('SIGINT', resolve); process.on('SIGTERM', resolve); });
        server.close();
        break;
      }
      case 'status': { const s = app.state(); console.log(JSON.stringify({ flags: s.flags, counts: s.counts, accounts: s.accounts.map((a) => ({ id: a.id, pools: a.pools, block: a.block, startReasons: a.startReasons })) }, null, 2)); break; }
      case 'collect': console.log(JSON.stringify(await app.collect({ accountId: account.id }), null, 2)); break;
      case 'plan': console.log(JSON.stringify(app.plan({ accountId: account.id }), null, 2)); break;
      case 'run': { const r = await app.startRun({ dryRun: !args.real, maxCount: args.max || null, accountId: account.id }); console.log(JSON.stringify(r, null, 2)); if (r.started) { await app.waitRun(); console.log(JSON.stringify(app.runner.status().lastRun, null, 2)); } break; }
      case 'export': console.log(JSON.stringify(app.export(), null, 2)); break;
      case 'verify-session': console.log(JSON.stringify(await app.verifySession(account.id), null, 2)); break;
      default: usage(); process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}
main().catch((e) => { console.error(`エラー: ${e.message}`); process.exitCode = 1; });
