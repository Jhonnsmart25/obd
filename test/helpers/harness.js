'use strict';
// Carga server.js con un express falso (solo guarda las rutas) y llama a las rutas sin red.
// Lo simulado no sustituye una prueba con express real (paso 4 del README).
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

function makeStripe() {
  const calls = { checkout: [], portal: [], cancelled: [], retrieved: [] };
  const subs = {}; // id -> suscripción que "existe" en Stripe
  const stripe = {
    calls, subs,
    checkout: { sessions: {
      create: async (a) => { calls.checkout.push(a); return { id: 'cs_test_' + calls.checkout.length, url: 'https://checkout.stripe.test/' + calls.checkout.length }; },
      retrieve: async (id) => stripe.sessions[id],
    } },
    billingPortal: { sessions: { create: async (a) => { calls.portal.push(a); return { url: 'https://portal.stripe.test/1' }; } } },
    subscriptions: {
      retrieve: async (id) => { calls.retrieved.push(id); return subs[id]; },
      cancel: async (id) => { calls.cancelled.push(id); },
    },
    sessions: {},
    webhooks: { constructEvent: (raw, sig) => { if (sig !== 'firma-buena') throw new Error('firma inválida'); return JSON.parse(raw.toString()); } },
  };
  return stripe;
}

function load({ stripe = makeStripe(), env = {}, dir } = {}) {
  const routes = [];
  const add = (method) => (p, ...h) => { if (typeof p === 'string' && p.startsWith('/')) routes.push({ method, path: p, handlers: h }); };
  const app = { disable() {}, set() {}, use() {}, get: add('GET'), post: add('POST'), delete: add('DELETE'), listen() {} };
  const pass = () => (req, res, next) => next();
  const express = Object.assign(() => app, { json: pass, raw: pass, static: pass });
  const origLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'express' ? express : origLoad.call(this, request, ...rest); };
  const file = path.join(__dirname, '..', '..', 'server.js');
  delete require.cache[file];
  const { createApp } = require(file);
  const { createStore } = require('../../lib/store');
  Module._load = origLoad;

  const store = createStore(dir || null);
  const fullEnv = { APP_URL: 'https://obd.test', JWT_SECRET: 'j'.repeat(40), STRIPE_PRICE_ID: 'price_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', ...env };
  createApp({ store, stripe, env: fullEnv });

  let ipN = 0;
  async function call(method, urlPath, { body = {}, rawBody, token, headers = {}, ip } = {}) {
    const route = routes.find((r) => r.method === method && r.path === urlPath);
    if (!route) throw new Error(`Ruta no registrada: ${method} ${urlPath}`);
    ipN += 1;
    const req = { method, path: urlPath, body: rawBody || body, ip: ip || `10.0.0.${ipN % 250}`, headers: { ...headers, ...(token ? { authorization: 'Bearer ' + token } : {}) } };
    const res = { statusCode: 200, body: undefined, headers: {} };
    await new Promise((resolve, reject) => {
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (b) => { res.body = b; resolve(); return res; };
      res.send = (b) => { res.body = b; resolve(); return res; };
      res.setHeader = (k, v) => { res.headers[k] = v; };
      let i = 0;
      const next = (err) => {
        if (err) return reject(err);
        const h = route.handlers[i++];
        if (!h) return resolve();
        try { const out = h(req, res, next); if (out && out.catch) out.catch(reject); } catch (e) { reject(e); }
      };
      next();
    });
    return { status: res.statusCode, body: res.body, headers: res.headers };
  }

  const register = async (email = 'ana@correo.com') => {
    const r = await call('POST', '/api/auth/register', { body: { email, password: 'contraseña-larga' } });
    return { token: r.body.token, res: r };
  };
  const webhook = (event) => call('POST', '/api/webhook', { rawBody: Buffer.from(JSON.stringify(event)), headers: { 'stripe-signature': 'firma-buena' } });

  return { call, store, stripe, register, webhook };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'obd-'));
module.exports = { load, makeStripe, tmpDir };
