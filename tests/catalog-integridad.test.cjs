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
  assert.equal(listed, 254);
  assert.equal(matched, listed);
  assert.equal(Object.keys(incomplete).length, 188);
});

test('completes only the fields whose continuation exists elsewhere in the source file', () => {
  const { Catalog } = loadCatalog();
  const tests = new Map(Catalog.normalizeCatalog(data).map((item) => [item.id, item]));
  const endings = {
    97: ['indic_paciente', 'La orina debe mantenerse en refrigeración.'],
    111: ['indic_paciente', 'La orina debe mantenerse en refrigeración.'],
    140: ['indic_paciente', 'La orina debe mantenerse en refrigeración.'],
    145: ['indic_paciente', 'La orina debe mantenerse en refrigeración.'],
    190: ['obs_toma', 'en las muestras de fluidos.'],
    191: ['obs_toma', 'en las muestras de fluidos.'],
    199: ['obs_toma', 'garantizando la cadena de frío en todo momento.'],
    552: ['proc_toma', 'realizar la misma toma.']
  };
  for (const [id, [key, ending]] of Object.entries(endings)) {
    const record = tests.get(Number(id));
    assert.ok(record[key].replace(/\*\*/g, '').endsWith(ending), id);
    assert.ok(!Catalog.incompleteFields(record).some((field) => field.key === key), id);
  }
});

test('keeps unit and character notation consistent', () => {
  const skipped = new Set(['codigo_digitacion', 'contacto', 'revisado_por', 'equipo_automatizado', 'nombre', 'perfil', 'control_interno', 'control_externo']);
  for (const record of data) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== 'string') continue;
      assert.equal(value, value.normalize('NFC'), `${record.id} ${key}`);
      assert.ok(!/[\u02c2\u02c3\u2011\u00aa]/.test(value), `${record.id} ${key}`);
      if (skipped.has(key)) continue;
      assert.ok(!/(?<![A-Za-zµ])(ml|dl|ul|ug|hrs)(?![A-Za-z])/.test(value), `${record.id} ${key}`);
      assert.ok(!/\dº ?C|\d°C|\d ?C(?![A-Za-zÁÉÍÓÚáéíóúñ0-9])/.test(value), `${record.id} ${key}`);
    }
  }
});

test('marks incomplete fields in copied text, strips bold markers and drops the mark once the field is completed', () => {
  const { Catalog } = loadCatalog();
  const record = Catalog.normalizeCatalog(data).find((item) => item.id === 21);
  const text = Catalog.formatTestText(record);
  assert.match(text, /\[texto incompleto en la fuente\]/);
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
  for (const version of ['ago2026-v2.1', 'ago2026-v2.2', 'respaldo-desconocido']) {
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
