'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/harness');

const trialSub = (id, userId, extra = {}) => ({ id, customer: 'cus_1', status: 'trialing', trial_end: 1900000000, current_period_end: 1900000000, metadata: { userId }, ...extra });
const completed = (id, userId, subId = 'sub_1') => ({ id, type: 'checkout.session.completed', data: { object: { id: 'cs_x', mode: 'subscription', client_reference_id: userId, subscription: subId, customer: 'cus_1' } } });

test('registro, login y /me', async () => {
  const { call, register } = load();
  const { token, res } = await register();
  assert.equal(res.status, 201);
  assert.equal(res.body.user.hasAccess, false);
  assert.equal(res.body.user.trialAvailable, true);
  assert.equal(res.body.user.passHash, undefined);
  assert.equal((await call('POST', '/api/auth/register', { body: { email: 'ana@correo.com', password: 'contraseña-larga' } })).status, 409);
  assert.equal((await call('POST', '/api/auth/register', { body: { email: 'mal', password: 'contraseña-larga' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { body: { email: 'b@correo.com', password: 'corta' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'ana@correo.com', password: 'otra-cosa-larga' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'nadie@correo.com', password: 'contraseña-larga' } })).status, 401);
  const login = await call('POST', '/api/auth/login', { body: { email: 'ANA@correo.com', password: 'contraseña-larga' } });
  assert.equal(login.status, 200);
  assert.equal((await call('GET', '/api/me', { token })).body.user.email, 'ana@correo.com');
  assert.equal((await call('GET', '/api/me', { token: token + 'x' })).status, 401);
});

test('guard: /api/dtc exige sesión y prueba o suscripción vigente', async () => {
  const { call, register } = load();
  assert.equal((await call('GET', '/api/dtc')).status, 401);
  const { token } = await register();
  const r = await call('GET', '/api/dtc', { token });
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'SUBSCRIPTION_REQUIRED');
  assert.equal(r.body.codes, undefined);
});

test('create-checkout-session: suscripción mensual con 7 días de prueba', async () => {
  const { call, register, stripe } = load();
  const { token } = await register();
  const r = await call('POST', '/api/create-checkout-session', { token });
  assert.equal(r.status, 200);
  assert.match(r.body.url, /^https:\/\/checkout\.stripe\.test/);
  const a = stripe.calls.checkout[0];
  assert.equal(a.mode, 'subscription');
  assert.deepEqual(a.line_items, [{ price: 'price_test', quantity: 1 }]);
  assert.equal(a.subscription_data.trial_period_days, 7);
  assert.equal(a.customer_email, 'ana@correo.com');
  assert.ok(a.client_reference_id);
  assert.equal(a.subscription_data.metadata.userId, a.client_reference_id);
  assert.match(a.success_url, /^https:\/\/obd\.test\/\?checkout=success&session_id=\{CHECKOUT_SESSION_ID\}$/);
  assert.equal((await call('POST', '/api/create-checkout-session')).status, 401);
});

test('sin Stripe configurado: responde 503 y no se cae', async () => {
  const { call, register } = load({ env: { STRIPE_PRICE_ID: '' } });
  const { token } = await register();
  assert.equal((await call('POST', '/api/create-checkout-session', { token })).status, 503);
});

test('webhook: firma inválida se rechaza', async () => {
  const { call } = load();
  const r = await call('POST', '/api/webhook', { rawBody: Buffer.from('{}'), headers: { 'stripe-signature': 'mala' } });
  assert.equal(r.status, 400);
});

test('webhook checkout.session.completed activa la prueba y abre /api/dtc; subscription.deleted lo cierra', async () => {
  const { call, register, store, stripe, webhook } = load();
  const { token } = await register();
  const user = store.byEmail('ana@correo.com');
  stripe.subs.sub_1 = trialSub('sub_1', user.id);

  assert.equal((await webhook(completed('evt_1', user.id))).status, 200);
  const me = (await call('GET', '/api/me', { token })).body.user;
  assert.equal(me.status, 'trialing');
  assert.equal(me.hasAccess, true);
  assert.equal(me.trialAvailable, false);
  const dtc = await call('GET', '/api/dtc', { token });
  assert.equal(dtc.status, 200);
  assert.equal(Object.keys(dtc.body.codes).length, 20);

  // ya con prueba activa no se abre otro checkout
  assert.equal((await call('POST', '/api/create-checkout-session', { token })).status, 409);

  const del = { id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { ...trialSub('sub_1', user.id), status: 'canceled' } } };
  assert.equal((await webhook(del)).status, 200);
  assert.equal((await call('GET', '/api/dtc', { token })).status, 402);
  assert.equal((await call('GET', '/api/me', { token })).body.user.status, 'canceled');
});

test('webhook: evento repetido se ignora y un error devuelve 500 para que Stripe reintente', async () => {
  const { register, store, stripe, webhook } = load();
  await register();
  const user = store.byEmail('ana@correo.com');
  stripe.subs.sub_1 = trialSub('sub_1', user.id);
  await webhook(completed('evt_1', user.id));
  const again = await webhook(completed('evt_1', user.id));
  assert.equal(again.body.duplicate, true);
  assert.equal(stripe.calls.retrieved.length, 1);
  const fail = await webhook(completed('evt_2', user.id, 'sub_inexistente'));
  assert.equal(fail.status, 500);
  assert.equal(store.seen('evt_2'), false);
});

test('webhook subscription.updated: trialing -> active, y llega aunque el checkout no haya llegado (usa metadata.userId)', async () => {
  const { call, register, store, webhook } = load();
  const { token } = await register();
  const user = store.byEmail('ana@correo.com');
  const upd = { id: 'evt_u', type: 'customer.subscription.updated', data: { object: trialSub('sub_9', user.id, { status: 'active', trial_end: null }) } };
  await webhook(upd);
  assert.equal((await call('GET', '/api/me', { token })).body.user.status, 'active');
  const unpaid = { id: 'evt_p', type: 'customer.subscription.updated', data: { object: trialSub('sub_9', user.id, { status: 'past_due' }) } };
  await webhook(unpaid);
  assert.equal((await call('GET', '/api/dtc', { token })).status, 402);
});

test('quien ya usó su prueba no recibe otra al volver a suscribirse', async () => {
  const { call, register, store, stripe, webhook } = load();
  const { token } = await register();
  const user = store.byEmail('ana@correo.com');
  stripe.subs.sub_1 = trialSub('sub_1', user.id);
  await webhook(completed('evt_1', user.id));
  await webhook({ id: 'evt_2', type: 'customer.subscription.deleted', data: { object: trialSub('sub_1', user.id) } });
  await call('POST', '/api/create-checkout-session', { token });
  const a = stripe.calls.checkout[0];
  assert.equal(a.subscription_data.trial_period_days, undefined);
  assert.equal(a.customer, 'cus_1');
  assert.equal(a.customer_email, undefined);
});

test('checkout/confirm: respaldo del webhook, solo para la sesión propia', async () => {
  const { call, register, store, stripe } = load();
  const { token } = await register();
  const other = await register('luis@correo.com');
  const user = store.byEmail('ana@correo.com');
  stripe.subs.sub_1 = trialSub('sub_1', user.id);
  stripe.sessions.cs_abc = { id: 'cs_abc', status: 'complete', mode: 'subscription', client_reference_id: user.id, subscription: 'sub_1' };
  assert.equal((await call('POST', '/api/checkout/confirm', { token: other.token, body: { sessionId: 'cs_abc' } })).status, 403);
  assert.equal((await call('POST', '/api/checkout/confirm', { token, body: { sessionId: 'no-valido' } })).status, 400);
  const ok = await call('POST', '/api/checkout/confirm', { token, body: { sessionId: 'cs_abc' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.hasAccess, true);
});

test('portal y borrar cuenta (cancela la suscripción)', async () => {
  const { call, register, store, stripe, webhook } = load();
  const { token } = await register();
  assert.equal((await call('POST', '/api/portal', { token })).status, 400);
  const user = store.byEmail('ana@correo.com');
  stripe.subs.sub_1 = trialSub('sub_1', user.id);
  await webhook(completed('evt_1', user.id));
  assert.equal((await call('POST', '/api/portal', { token })).body.url, 'https://portal.stripe.test/1');
  assert.equal((await call('DELETE', '/api/account', { token })).status, 200);
  assert.deepEqual(stripe.calls.cancelled, ['sub_1']);
  assert.equal(store.byEmail('ana@correo.com'), null);
  assert.equal((await call('GET', '/api/me', { token })).status, 401);
});

test('límite de intentos en login: el intento 11 desde la misma IP recibe 429', async () => {
  const { call } = load();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await call('POST', '/api/auth/login', { body: { email: 'x@correo.com', password: 'xxxxxxxxxx' }, ip: '9.9.9.9' })).status);
  assert.equal(codes.slice(0, 10).every((c) => c === 401), true);
  assert.equal(codes[10], 429);
});

test('sin JWT_SECRET el servidor no arranca', () => {
  assert.throws(() => load({ env: { JWT_SECRET: 'corto' } }), /JWT_SECRET/);
});
