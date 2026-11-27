'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const data = JSON.parse(read('data.json'));

function loadCatalog(fetchImpl) {
  const window = { crypto: webcrypto };
  const context = { window, TextEncoder, console: { warn() {} }, fetch: fetchImpl };
  vm.runInNewContext(read('js/textos-incompletos.js'), context);
  vm.runInNewContext(read('js/catalog.js'), context);
  return { Catalog: window.PreanalyticsCatalog, incomplete: window.PreanalyticsIncompleteTexts };
}

test('bold markers are balanced on every line and absent from reference and critical values', () => {
  for (const record of data) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== 'string') continue;
      for (const line of value.split('\n')) assert.equal(line.split('**').length % 2, 1, `${record.id} ${key}`);
    }
    assert.ok(!`${record.valores_referencia || ''}${record.valores_criticos || ''}`.includes('**'), `${record.id}`);
  }
});

test('keeps decimals and case-sensitive notation restored from the source file', () => {
  const byId = new Map(data.map((record) => [record.id, record]));
  assert.ok(byId.get(14).valores_referencia.includes('3,7-5,3'));
  for (const id of [311, 448]) assert.ok(!/0\. (25|5)/.test(byId.get(id).valores_referencia));
  assert.ok(byId.get(273).valores_referencia.includes('pH:'));
  assert.ok(byId.get(215).nombre.startsWith('del1p'));
  for (let id = 570; id <= 578; id += 1) assert.ok(byId.get(id).nombre.startsWith('t('), `${id}`);
  assert.ok(byId.get(554).valores_referencia.includes('mg/L'));
});

test('every incomplete-text entry still matches its field', () => {
  const { Catalog, incomplete } = loadCatalog();
  const tests = Catalog.normalizeCatalog(data);
  let matched = 0;
  for (const record of tests) matched += Catalog.incompleteFields(record).length;
  const listed = Object.values(incomplete).reduce((sum, entries) => sum + entries.length, 0);
  assert.equal(listed, 266);
  assert.equal(matched, listed);
  assert.equal(Object.keys(incomplete).length, 193);
});

test('warns in copied text, strips bold markers and drops the warning once the field is completed', () => {
  const { Catalog } = loadCatalog();
  const record = Catalog.normalizeCatalog(data).find((item) => item.id === 21);
  const text = Catalog.formatTestText(record);
  assert.match(text, /AVISO: texto incompleto/);
  assert.ok(!text.includes('**'));
  const completed = { ...record };
  for (const { key } of Catalog.incompleteFields(record)) completed[key] = `${record[key]} y texto completado.`;
  assert.equal(Catalog.incompleteFields(completed).length, 0);
});

function fakeDatabase(tests, version) {
  const calls = [];
  return {
    calls,
    countTests: async () => tests.length,
    getMeta: async () => version,
    getAllTests: async () => tests,
    replaceTests: async (list) => { calls.push(list.length); }
  };
}

test('never replaces a local catalog that differs from the previous official one', async () => {
  let fetched = false;
  const { Catalog } = loadCatalog(async () => { fetched = true; return { ok: true, json: async () => data }; });
  const edited = Catalog.normalizeCatalog(data);
  edited[0].obs_toma = 'Edición local';
  for (const version of ['ago2026-v2.1', 'respaldo-desconocido']) {
    const db = fakeDatabase(edited, version);
    const result = await Catalog.seedIfEmpty(db);
    assert.equal(result.updateAvailable, true);
    assert.deepEqual(db.calls, []);
  }
  assert.equal(fetched, false);
});

test('does nothing when the device already has the current version', async () => {
  const { Catalog } = loadCatalog();
  const db = fakeDatabase(Catalog.normalizeCatalog(data), Catalog.OFFICIAL_SOURCE_VERSION);
  const result = await Catalog.seedIfEmpty(db);
  assert.equal(result.updateAvailable, false);
  assert.deepEqual(db.calls, []);
});
