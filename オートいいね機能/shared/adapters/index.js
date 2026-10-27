'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createAdapter({ kind, config, accounts, clock, log, worldFile }) {
  if (kind === 'mock') {
    const { MockAdapter } = require('./mock');
    const file = worldFile || path.join(config.rootDir, 'fixtures', 'mock-world.json');
    const world = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new MockAdapter(world, { clock, accounts });
  }
  if (kind === 'note') {
    const { NoteBrowserAdapter } = require('./note-browser');
    return new NoteBrowserAdapter({ config, accounts, clock, log });
  }
  throw new Error(`不明なアダプタ: ${kind}（mock | note）`);
}

module.exports = { createAdapter };
