'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('uses storage names and an install identity different from the original site', () => {
  const db = read('js/db.js');
  assert.match(db, /DB_NAME = 'ofertanalisis_correcciones_db'/);
  assert.match(db, /SYNC_CHANNEL = 'ofertanalisis-correcciones-sync'/);
  const manifest = JSON.parse(read('manifest.json'));
  const identity = new URL(manifest.id, 'https://luiszunigaanchia-droid.github.io').href;
  assert.equal(identity, 'https://luiszunigaanchia-droid.github.io/Oferta-Analisis-2.0-correcciones/');
});

test('activation only deletes older caches of this copy', async () => {
  const listeners = new Map();
  const deleted = [];
  const self = {
    location: { origin: 'https://example.test' },
    registration: { scope: 'https://example.test/copy/' },
    clients: { claim: async () => {} },
    addEventListener: (type, callback) => listeners.set(type, callback)
  };
  const caches = {
    keys: async () => [
      'oferta-analisis2-preanalitica-v7.0.2', 'oferta-analisis2-preanalitica-v7.0.3',
      'preanalitica-v1', 'oferta-correcciones-preanalitica-v0'
    ],
    delete: async (key) => { deleted.push(key); return true; }
  };
  vm.runInNewContext(read('sw.js'), { self, caches, URL });
  let activation;
  listeners.get('activate')({ waitUntil: (promise) => { activation = promise; } });
  await activation;
  assert.deepEqual(deleted, ['oferta-correcciones-preanalitica-v0']);
});
