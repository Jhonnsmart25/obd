'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('../lib/auth');
const { createStore } = require('../lib/store');
const { tmpDir } = require('./helpers/harness');

test('contraseñas: hash distinto cada vez y verificación correcta', async () => {
  const a = await hashPassword('mi-clave-larga'), b = await hashPassword('mi-clave-larga');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('mi-clave-larga', a), true);
  assert.equal(await verifyPassword('otra-clave', a), false);
  assert.equal(await verifyPassword('x', 'basura'), false);
});

test('token: firma, manipulación y vencimiento', () => {
  const secret = 's'.repeat(32);
  const t = signToken('u1', secret);
  assert.equal(verifyToken(t, secret).uid, 'u1');
  assert.equal(verifyToken(t, 'z'.repeat(32)), null);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'u2', exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal(verifyToken(forged + '.' + sig, secret), null);
  assert.equal(verifyToken(signToken('u1', secret, -1), secret), null);
  assert.equal(verifyToken('', secret), null);
  assert.equal(verifyToken(body, secret), null);
});

test('almacén: guarda en disco y se recupera al reiniciar', async () => {
  const dir = tmpDir();
  const s1 = createStore(dir);
  const u = await s1.create({ email: 'a@b.co', passHash: 'x' });
  await s1.update(u, { sub: { status: 'trialing', customerId: 'cus_9' } });
  await s1.markSeen('evt_1');
  await s1.flush();
  assert.ok(fs.existsSync(path.join(dir, 'db.json')));
  const s2 = createStore(dir);
  assert.equal(s2.byEmail('a@b.co').sub.status, 'trialing');
  assert.equal(s2.byCustomer('cus_9').id, u.id);
  assert.equal(s2.seen('evt_1'), true);
});
