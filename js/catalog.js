'use strict';

(function exposeCatalog(global) {
  // Suba esta versión cada vez que cambie data.json.
  const OFFICIAL_SOURCE_VERSION = 'ago2026-v2.3';
  const OFFICIAL_SOURCE_LABEL = 'Catálogo Oferta Análisis HSJD (Versión Depurada)';
  // La versión en la URL evita que la caché del service worker entregue el archivo anterior.
  const OFFICIAL_SOURCE_URL = `./data.json?v=${OFFICIAL_SOURCE_VERSION}`;
  // SHA-256 de catálogos oficiales anteriores tal como quedan guardados en el dispositivo.
  // Una base local idéntica no tiene cambios propios y puede actualizarse sin perder datos.
  const PREVIOUS_OFFICIAL_FINGERPRINTS = Object.freeze({
    'ago2026-v2.1': '2b3a32aeed33dcbe0c9594d5954f4f68e3aff89abe9a1e3d1c50459cd87f3ead',
    'ago2026-v2.2': '7e1df5a5f2da824d28327c740637822231d2b1a6c9c34f13b80b881ea304eda0'
  });
  const MAX_RECORDS = 5000;
  const MAX_CENTERS = 1000;
  const MAX_AUDIT_RECORDS = 5000;
  const MAX_FIELD_LENGTH = 12000;

  const SECTIONS = Object.freeze([
    {
      title: 'Muestra',
      fields: [
        ['tipo_muestra', 'Tipo de muestra'],
        ['cantidad_minima', 'Cantidad mínima'],
        ['proc_toma', 'Procedimiento de toma'],
        ['obs_toma', 'Observaciones de la toma']
      ]
    },
    {
      title: 'Preparación del paciente',
      fields: [
        ['prep_paciente', 'Preparación del paciente'],
        ['indic_paciente', 'Indicaciones al paciente']
      ]
    },
    {
      title: 'Conservación',
      fields: [
        ['estab_contenedor', 'Estabilidad del contenedor primario'],
        ['estab_alicuota', 'Estabilidad de la muestra alicuotada'],
        ['nota_conservacion', 'Nota de conservación']
      ]
    },
    {
      title: 'Resultado',
      fields: [
        ['tiempo_respuesta', 'Tiempo de respuesta'],
        ['restriccion', 'Restricción'],
        ['valores_criticos', 'Valores críticos'],
        ['valores_referencia', 'Valores de referencia'],
        ['referido_a', 'Referido a'],
        ['indic_otros_centros', 'Indicaciones para otros centros']
      ]
    },
    {
      title: 'Uso clínico',
      fields: [['uso_clinico', 'Uso clínico']]
    },
    {
      title: 'Datos de laboratorio',
      fields: [
        ['division', 'División'],
        ['perfil', 'Perfil'],
        ['codigo_digitacion', 'Código de digitación'],
        ['obs_digitacion', 'Observaciones de digitación'],
        ['equipo_automatizado', 'Equipo automatizado'],
        ['control_externo', 'Control externo'],
        ['control_interno', 'Control interno'],
        ['contacto', 'Contacto'],
        ['revisado_por', 'Revisado por'],
        ['fecha_revision', 'Fecha de revisión']
      ]
    }
  ]);

  const FIELD_LABELS = new Map([['nombre', 'Nombre de la prueba'], ...SECTIONS.flatMap((section) => section.fields)]);
  const FIELD_KEYS = Object.freeze(Array.from(FIELD_LABELS.keys()));
  const CRITICAL_FIELDS = new Set(['valores_criticos', 'restriccion']);
  const WIDE_FIELDS = new Set([
    'nombre', 'uso_clinico', 'prep_paciente', 'indic_paciente', 'proc_toma', 'obs_toma',
    'estab_contenedor', 'estab_alicuota', 'nota_conservacion', 'valores_criticos',
    'valores_referencia', 'referido_a', 'indic_otros_centros', 'obs_digitacion'
  ]);

  const DIVISION_COLORS = Object.freeze({
    'Química Clínica': '#2e6f8e',
    'Hematología': '#8e4a6b',
    'Inmunología': '#0b5d52',
    'Hormonas y Marcadores Tumorales': '#a8652d',
    'Banco de Sangre': '#a13d48',
    'Microbiología': '#5b6f3f',
    'Biología Molecular': '#5a4b8e',
    'Laboratorio Emergencias': '#b23a2e',
    'Banco de Cordón Umbilical': '#3f8fa8'
  });

  const TUBE_RULES = Object.freeze([
    [/edta/i, '#6b4fa0'],
    [/citrat/i, '#4fa9d9'],
    [/heparin/i, '#3f8f5c'],
    [/orina/i, '#d98e2b'],
    [/heces/i, '#7a5230'],
    [/l[ií]quido|lcr|amni[oó]tico/i, '#8b98a0'],
    [/suero/i, '#c0392b']
  ]);

  function cleanText(value, maxLength = MAX_FIELD_LENGTH) {
    return String(value ?? '')
      .replace(/\u0000/g, '')
      .replace(/\r\n?/g, '\n')
      .trim()
      .slice(0, maxLength);
  }

  function cleanDivision(value) {
    let division = cleanText(value, 180);
    if (division.endsWith(')') && !division.includes('(')) division = division.slice(0, -1).trim();
    return division.replace(/\s{2,}/g, ' ');
  }

  function createId() {
    return global.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function normalizeId(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = cleanText(value, 128);
    return text || createId();
  }

  function normalizeTest(input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Existe una ficha que no es un objeto válido.');
    const record = { id: normalizeId(input.id) };

    for (const key of FIELD_KEYS) {
      record[key] = key === 'division' ? cleanDivision(input[key]) : cleanText(input[key]);
    }

    if (!record.nombre) throw new Error('Todas las fichas deben incluir el nombre de la prueba.');
    record.createdAt = cleanText(input.createdAt, 64) || options.now || new Date().toISOString();
    record.updatedAt = options.now || cleanText(input.updatedAt, 64) || record.createdAt;
    if (input.source) record.source = cleanText(input.source, 160);
    return record;
  }

  function normalizeCatalog(list, options = {}) {
    if (!Array.isArray(list)) throw new Error('El archivo no contiene una lista de pruebas.');
    if (list.length === 0 && !options.allowEmpty) throw new Error('El catálogo recibido está vacío.');
    if (list.length > MAX_RECORDS) throw new Error(`El catálogo supera el máximo de ${MAX_RECORDS} registros.`);

    const seen = new Set();
    const now = new Date().toISOString();
    return list.map((item, index) => {
      const record = normalizeTest(item, { now: item?.updatedAt ? undefined : now });
      const key = `${typeof record.id}:${String(record.id)}`;
      if (seen.has(key)) throw new Error(`El identificador de la ficha ${index + 1} está duplicado.`);
      seen.add(key);
      return record;
    });
  }

  function normalizeCenter(input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Existe un establecimiento que no es un objeto válido.');
    }
    const codigo = cleanText(input.codigo, 40).toUpperCase().replace(/\s+/g, '-');
    const nombre = cleanText(input.nombre, 220);
    if (!codigo) throw new Error('Cada área o unidad debe incluir un código interno.');
    if (!nombre) throw new Error(`El establecimiento ${codigo} debe incluir un nombre.`);

    return {
      codigo,
      nombre,
      tipo: cleanText(input.tipo, 80) || 'Área de Salud',
      unidadEjecutora: cleanText(input.unidadEjecutora, 12),
      parentAreaCode: cleanText(input.parentAreaCode, 40).toUpperCase(),
      region: cleanText(input.region, 120),
      red: cleanText(input.red, 160),
      hospitalReferencia: cleanText(input.hospitalReferencia, 220),
      areaAtraccion: cleanText(input.areaAtraccion, 160),
      esAreaAtraccionHsjd: Boolean(input.esAreaAtraccionHsjd) || normalizeSearch(input.areaAtraccion).includes('atraccion hsjd'),
      source: cleanText(input.source, 40) || options.source || 'local',
      createdAt: cleanText(input.createdAt, 64) || options.now || new Date().toISOString(),
      updatedAt: options.now || cleanText(input.updatedAt, 64) || cleanText(input.createdAt, 64) || new Date().toISOString()
    };
  }

  function normalizeCenters(list, options = {}) {
    if (!Array.isArray(list)) throw new Error('El respaldo no contiene una lista válida de áreas y unidades.');
    if (list.length > MAX_CENTERS) throw new Error(`El directorio supera el máximo de ${MAX_CENTERS} registros.`);
    const seen = new Set();
    return list.map((item, index) => {
      const record = normalizeCenter(item, options);
      if (seen.has(record.codigo)) throw new Error(`El código de establecimiento ${record.codigo} está duplicado (registro ${index + 1}).`);
      seen.add(record.codigo);
      return record;
    });
  }

  function normalizeAudit(list) {
    if (!Array.isArray(list)) throw new Error('El historial del respaldo no es una lista válida.');
    if (list.length > MAX_AUDIT_RECORDS) throw new Error(`El historial supera el máximo de ${MAX_AUDIT_RECORDS} registros.`);
    const seen = new Set();
    return list.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`La entrada ${index + 1} del historial no es válida.`);
      const id = cleanText(entry.id, 160);
      const createdAt = new Date(entry.createdAt);
      if (!id || Number.isNaN(createdAt.getTime())) throw new Error(`La entrada ${index + 1} del historial no tiene identificador o fecha válida.`);
      if (seen.has(id)) throw new Error(`El historial contiene el identificador duplicado ${id}.`);
      seen.add(id);
      return {
        id,
        action: cleanText(entry.action, 120) || 'cambio',
        summary: cleanText(entry.summary, 4000),
        details: entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details) ? entry.details : null,
        createdAt: createdAt.toISOString()
      };
    });
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      cache: options.cache || 'no-store',
      mode: options.mode || 'cors',
      credentials: 'omit',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`No se pudo descargar el catálogo (${response.status}).`);
    return response.json();
  }

  async function fetchOfficialCatalog() {
    const sources = [
      { url: OFFICIAL_SOURCE_URL, label: 'data.json local', mode: 'same-origin' },
      { url: OFFICIAL_SOURCE_URL, label: OFFICIAL_SOURCE_LABEL, mode: 'cors' }
    ];
    let lastError = null;

    for (const source of sources) {
      try {
        const payload = await fetchJson(source.url, { mode: source.mode });
        const tests = normalizeCatalog(payload);
        return { tests, sourceLabel: source.label, sourceVersion: OFFICIAL_SOURCE_VERSION };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('No se pudo recuperar el catálogo original.');
  }

  async function catalogFingerprint(tests) {
    const subtle = global.crypto?.subtle;
    if (!subtle) return '';
    const rows = tests
      .map((test) => [String(test.id), ...FIELD_KEYS.map((key) => String(test[key] ?? ''))])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // Devuelve la cantidad de pruebas si actualizó, o 0 si dejó la base local como estaba.
  async function updateUntouchedCatalog(database, storedVersion) {
    const previous = PREVIOUS_OFFICIAL_FINGERPRINTS[storedVersion];
    if (!previous) return 0;
    try {
      const isUntouched = async () => (await catalogFingerprint(await database.getAllTests())) === previous;
      if (!(await isUntouched())) return 0;
      const catalog = await fetchOfficialCatalog();
      // Si el servidor o una caché aún entregan el archivo anterior, no se marca como actualizado.
      if ((await catalogFingerprint(catalog.tests)) === previous) return 0;
      // Segunda comprobación: otra pestaña pudo editar mientras se descargaba.
      if (!(await isUntouched())) return 0;
      await database.replaceTests(catalog.tests, {
        action: 'actualización de versión',
        summary: `Catálogo sin cambios locales actualizado a ${catalog.sourceVersion} con ${catalog.tests.length} pruebas.`,
        source: catalog.sourceLabel,
        meta: {
          catalog_source_version: catalog.sourceVersion,
          catalog_source_label: catalog.sourceLabel,
          seeded_at: new Date().toISOString()
        }
      });
      return catalog.tests.length;
    } catch (error) {
      console.warn('No se pudo actualizar el catálogo oficial:', error);
      return 0;
    }
  }

  async function seedIfEmpty(database) {
    const [count, storedVersion] = await Promise.all([
      database.countTests(),
      database.getMeta('catalog_source_version')
    ]);
    if (count > 0) {
      if (storedVersion === OFFICIAL_SOURCE_VERSION) return { seeded: false, count, updateAvailable: false };
      const updated = await updateUntouchedCatalog(database, storedVersion);
      if (updated) return { seeded: false, autoUpdated: true, count: updated, updateAvailable: false };
      return { seeded: false, count, updateAvailable: true };
    }
    const catalog = await fetchOfficialCatalog();
    await database.replaceTests(catalog.tests, {
      action: count > 0 ? 'actualización de versión' : 'carga inicial',
      summary: `Catálogo sincronizado a ${catalog.sourceVersion} con ${catalog.tests.length} pruebas.`,
      source: catalog.sourceLabel,
      meta: {
        catalog_source_version: catalog.sourceVersion,
        catalog_source_label: catalog.sourceLabel,
        seeded_at: new Date().toISOString()
      }
    });
    return { seeded: true, count: catalog.tests.length, ...catalog };
  }

  function parseBackupPayload(payload) {
    if (Array.isArray(payload)) {
      return {
        schema: 'legacy-array',
        version: 1,
        sourceLabel: 'Importación heredada',
        tests: normalizeCatalog(payload),
        audit: [],
        centers: []
      };
    }
    if (!payload || typeof payload !== 'object') throw new Error('El respaldo no tiene una estructura válida.');
    if (payload.schema !== 'preanalitica-backup' || ![1, 2, 3].includes(Number(payload.version))) {
      throw new Error('El formato o la versión del respaldo no son compatibles.');
    }
    return {
      ...payload,
      tests: normalizeCatalog(payload.tests),
      audit: normalizeAudit(payload.audit || []),
      centers: normalizeCenters(payload.centers || [])
    };
  }

  function normalizeSearch(value) {
    return cleanText(value, 500)
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');
  }

  function buildSearchIndex(test) {
    return FIELD_KEYS.map((key) => normalizeSearch(test[key])).join(' ');
  }

  function matchesQuery(test, query) {
    const normalized = normalizeSearch(query);
    if (!normalized) return true;
    const terms = normalized.split(' ').filter(Boolean);
    if (test._searchIndex) {
      return terms.every((term) => test._searchIndex.includes(term));
    }
    return terms.every((term) =>
      FIELD_KEYS.some((key) => normalizeSearch(test[key]).includes(term))
    );
  }

  function divisionName(value) {
    let name = cleanDivision(value).split(/[.\n]/)[0].trim();
    if (name.includes(')')) {
      name = name.split(')')[0].trim();
    }
    return name;
  }

  function divisionColor(name) {
    return DIVISION_COLORS[name] || '#657870';
  }

  function hexToRgba(hex, alpha) {
    const safe = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#657870';
    const number = Number.parseInt(safe.slice(1), 16);
    return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
  }

  function tubeColor(sampleType) {
    const value = cleanText(sampleType, 500);
    for (const [pattern, color] of TUBE_RULES) if (pattern.test(value)) return color;
    return '#bdccc6';
  }

  function isUninformativeValue(value) {
    const text = cleanText(value);
    if (!text) return true;
    const normalized = text.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[.,;:()\-_—–]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const patterns = [
      /^sin indicacion(es)?( adicional(es)?)?$/,
      /^flebotomia( sin indicacion(es)?)?( adicional(es)?)?$/,
      /^(no aplica|n\/?a|n\/ap|n\/apl|ninguno|ninguna|no hay|ningun)$/,
      /^no indica$/,
      /^no se indica$/,
      /^sin datos$/,
      /^sin control$/
    ];

    return patterns.some((pat) => pat.test(normalized));
  }

  function isCriticalValue(key, value) {
    const clean = cleanText(value);
    return CRITICAL_FIELDS.has(key) && clean && !isUninformativeValue(clean);
  }

  function plainText(value) {
    return cleanText(value).replace(/\*\*/g, '');
  }

  function incompleteFields(test) {
    const entries = global.PreanalyticsIncompleteTexts?.[String(test?.id)] || [];
    return entries
      .filter(([key, ending]) => plainText(test[key]).replace(/\s+/g, ' ').endsWith(ending))
      .map(([key]) => ({ key, label: FIELD_LABELS.get(key) || key }));
  }

  function formatTestText(test, options = {}) {
    const incomplete = incompleteFields(test);
    const incompleteKeys = new Set(incomplete.map((field) => field.key));
    const lines = [`PRUEBA: ${test.nombre}`];
    if (options.center) {
      lines.push(`Centro seleccionado: ${options.center.nombre} (${options.center.codigo})`);
      if (options.center.unidadEjecutora) lines.push(`Unidad ejecutora: ${options.center.unidadEjecutora}`);
    }
    if (options.referralPublished === false) {
      lines.push('Estado de referencia: EN PROCESO. Esta ficha no confirma autorización para referir la prueba.');
    }

    for (const section of SECTIONS) {
      const details = section.fields
        .filter(([key]) => cleanText(test[key]) && !isUninformativeValue(test[key]))
        .map(([key, label]) => {
          const value = plainText(test[key]).split('\n').join('\n  ');
          const mark = incompleteKeys.has(key) ? ' [texto incompleto en la fuente]' : '';
          return `- ${label}${mark}: ${value}`;
        });
      if (details.length) lines.push('', `[ ${section.title.toUpperCase()} ]`, ...details);
    }
    return lines.join('\n');
  }

  function csvSafe(value) {
    let text = String(value ?? '').replace(/\r?\n/g, ' ');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function catalogToCsv(tests) {
    const headers = FIELD_KEYS.map((key) => FIELD_LABELS.get(key));
    const rows = tests.map((test) => FIELD_KEYS.map((key) => test[key] || ''));
    return '\uFEFF' + [headers, ...rows].map((row) => row.map(csvSafe).join(',')).join('\r\n');
  }

  async function fetchReferenceRules() {
    try {
      const payload = await fetchJson('./config/reglas_referencia.json');
      return payload;
    } catch (_) {
      return null;
    }
  }

  async function fetchOfertaCentros() {
    try {
      const payload = await fetchJson('./config/oferta_centros.json');
      return payload;
    } catch (_) {
      return null;
    }
  }

  async function fetchCenterDirectory() {
    const payload = await fetchJson('./config/directorio_centros.json');
    if (!Array.isArray(payload?.centros)) throw new Error('El directorio de centros no tiene una estructura válida.');
    return { ...payload, centros: normalizeCenters(payload.centros, { source: 'official' }) };
  }

  async function fetchEstadoClasificacion() {
    try {
      const payload = await fetchJson('./config/estado_clasificacion.json');
      return payload;
    } catch (_) {
      return null;
    }
  }

  async function fetchExecutiveUnits() {
    try {
      return await fetchJson('./config/unidades_ejecutoras.json');
    } catch (_) {
      return null;
    }
  }

  function getAuthTagInfo(tipo) {
    switch (tipo) {
      case 'hsjd':
        return { label: 'Área HSJD', className: 'auth-hsjd', title: 'Autorizada para área de atracción HSJD' };
      case 'todos_ccss':
        return { label: 'Todos CCSS', className: 'auth-todos', title: 'Autorizada para todos los centros CCSS' };
      case 'centros_especificos':
        return { label: 'Centros específicos', className: 'auth-especificos', title: 'Autorizada para centros de salud específicos' };
      case 'condicionada':
        return { label: 'Recepción condicionada', className: 'auth-condicionada', title: 'Recepción bajo condición clínica o administrativa' };
      case 'pendiente':
        return { label: 'Pendiente', className: 'auth-pendiente', title: 'Pendiente de clasificar por jefatura' };
      default:
        return null;
    }
  }

  global.PreanalyticsCatalog = Object.freeze({
    OFFICIAL_SOURCE_VERSION,
    OFFICIAL_SOURCE_LABEL,
    OFFICIAL_SOURCE_URL,
    SECTIONS,
    FIELD_LABELS,
    FIELD_KEYS,
    WIDE_FIELDS,
    normalizeTest,
    normalizeCatalog,
    normalizeCenter,
    normalizeCenters,
    fetchOfficialCatalog,
    fetchReferenceRules,
    fetchOfertaCentros,
    fetchCenterDirectory,
    fetchEstadoClasificacion,
    fetchExecutiveUnits,
    getAuthTagInfo,
    seedIfEmpty,
    catalogFingerprint,
    incompleteFields,
    parseBackupPayload,
    normalizeSearch,
    buildSearchIndex,
    matchesQuery,
    divisionName,
    divisionColor,
    hexToRgba,
    tubeColor,
    isUninformativeValue,
    isCriticalValue,
    formatTestText,
    catalogToCsv,
    createId
  });
})(window);
