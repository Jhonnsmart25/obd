'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const OBD = require('../public/obd.js');
const DB = require('../data/dtc.json');

test('base JSON: 20 códigos completos con semáforo válido', () => {
  const codes = Object.entries(DB.codes);
  assert.equal(codes.length, 20);
  for (const [code, c] of codes) {
    assert.match(code, /^[PBCU][0-3][0-9A-F]{3}$/);
    assert.ok(['verde', 'amarillo', 'rojo'].includes(c.gravedad), code);
    assert.ok(c.sistema && c.sistema.length >= 3, code + '.sistema');
    for (const f of ['titulo', 'explicacion', 'puedes_manejar']) assert.ok(c[f] && c[f].length > 10, `${code}.${f}`);
    assert.ok(Array.isArray(c.consejos) && c.consejos.length >= 2, code);
  }
  for (const g of ['verde', 'amarillo', 'rojo']) assert.ok(codes.some(([, c]) => c.gravedad === g), 'falta ' + g);
  assert.deepEqual(Object.keys(DB.genericos).sort(), ['B', 'C', 'P', 'U']);
});

test('dtcFromBytes / encodeDtc son inversos', () => {
  for (const c of ['P0301', 'P0420', 'U0100', 'C0035', 'B1234', 'P2A00']) {
    const bytes = OBD.encodeDtc(c).split(' ').map((x) => parseInt(x, 16));
    assert.equal(OBD.dtcFromBytes(bytes[0], bytes[1]), c);
  }
});

test('decodeDtcResponse: CAN, varios cuadros y protocolos antiguos', () => {
  assert.deepEqual(OBD.decodeDtcResponse('43 00 00 00 00 00 00'), []);
  assert.deepEqual(OBD.decodeDtcResponse('43 01 01 33 00 00 00'), ['P0133']);
  assert.deepEqual(OBD.decodeDtcResponse('43 02 03 01 04 20 00'), ['P0301', 'P0420']);
  assert.deepEqual(OBD.decodeDtcResponse('0: 43 02 03 01\r\n1: 04 20 00 00'), ['P0301', 'P0420']);
  assert.deepEqual(OBD.decodeDtcResponse('43 03 01 04 20 00 00 00', false), ['P0301', 'P0420']);
  assert.deepEqual(OBD.decodeDtcResponse('43 03 01 04 20 00 00 00\r\n43 00 00 00 00 00 00', false), ['P0301', 'P0420']);
  assert.deepEqual(OBD.decodeDtcResponse('NO DATA'), []);
  assert.deepEqual(OBD.decodeDtcResponse('SEARCHING...\r\n43 01 C1 00 00 00 00'), ['U0100']);
  assert.deepEqual(OBD.decodeDtcResponse(''), []);
});

test('parsePid: RPM y temperatura', () => {
  assert.equal(OBD.parsePid('41 0C 1A F8', '0C'), 1726);
  assert.equal(OBD.parsePid('41 05 82', '05'), 90);
  assert.equal(OBD.parsePid('NO DATA', '0C'), null);
});

test('translate: código conocido y genérico por letra', () => {
  const k = OBD.translate('p0420', DB);
  assert.equal(k.conocido, true); assert.equal(k.codigo, 'P0420'); assert.equal(k.gravedad, 'amarillo');
  const g = OBD.translate('P1234', DB);
  assert.equal(g.conocido, false); assert.equal(g.codigo, 'P1234'); assert.ok(g.consejos.length);
  assert.equal(OBD.translate('C0035', DB).sistema, 'Chasis');
});

test('worst: la gravedad más alta manda', () => {
  assert.equal(OBD.worst([{ gravedad: 'verde' }, { gravedad: 'amarillo' }]), 'amarillo');
  assert.equal(OBD.worst([{ gravedad: 'verde' }, { gravedad: 'rojo' }, { gravedad: 'amarillo' }]), 'rojo');
  assert.equal(OBD.worst([]), 'verde');
});

test('simulador: cada escenario se lee completo y todos sus códigos se traducen', async () => {
  for (const [key, sc] of Object.entries(OBD.SCENARIOS)) {
    const t = OBD.SimTransport(key);
    const steps = [];
    const r = await OBD.readAll(t, (s) => steps.push(s));
    assert.deepEqual(r.codes, sc.dtcs, key);
    assert.equal(r.live.rpm, sc.rpm); assert.equal(r.live.temp, sc.temp);
    assert.ok(steps.length >= 3);
    for (const c of r.codes) assert.equal(OBD.translate(c, DB).conocido, true, c);
  }
});

test('solo lectura: el lector nunca envía comandos de borrado ni escritura', async () => {
  const sent = [];
  const t = OBD.SimTransport('grave');
  const orig = t.send; t.send = (c) => { sent.push(c); return orig(c); };
  await OBD.readAll(t);
  for (const c of sent) assert.ok(/^(AT|01|03$)/.test(c), 'comando inesperado: ' + c);
  assert.ok(!sent.includes('04'));
});
