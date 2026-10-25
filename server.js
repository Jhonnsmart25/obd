'use strict';
// Traductor OBD-II · servidor Express (Render) con cuentas, prueba gratis de 7 días y suscripción con Stripe.
const path = require('path');
const express = require('express');
const { createStore } = require('./lib/store');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./lib/auth');
const DTC = require('./data/dtc.json');

const ACCESS = ['trialing', 'active'];
const TRIAL_DAYS = 7;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function createApp({ store, stripe, env = process.env }) {
  const app = express();
  const isProd = env.NODE_ENV === 'production';
  const appUrl = (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 16) throw new Error('Falta JWT_SECRET (mínimo 16 caracteres).');

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render va detrás de un proxy

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
      "manifest-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; '));
    if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  /* ---------- Webhook de Stripe: necesita el cuerpo SIN procesar, por eso va antes de express.json ---------- */
  app.post('/api/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!stripe || !env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe no está configurado.');
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET); }
    catch { return res.status(400).send('Firma inválida.'); }
    try {
      if (store.seen(event.id)) return res.json({ received: true, duplicate: true });
      await handleEvent(event);
      await store.markSeen(event.id);
      res.json({ received: true });
    } catch (e) {
      console.error('Webhook falló:', event.type, e.message);
      res.status(500).send('Error procesando el evento.'); // Stripe reintenta
    }
  });

  async function handleEvent(event) {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': return applyCheckoutSession(obj);
      case 'customer.subscription.created':
      case 'customer.subscription.updated': return applySubscription(obj);
      case 'customer.subscription.deleted': return applySubscription({ ...obj, status: 'canceled' });
      default: return undefined; // otros eventos se ignoran
    }
  }

  // Marca la cuenta con los datos de la suscripción de Stripe
  async function applySubscription(sub) {
    const user = store.byId(sub.metadata && sub.metadata.userId) || store.byCustomer(sub.customer);
    if (!user) return;
    await store.update(user, {
      user: sub.trial_end || sub.status === 'trialing' ? { trialUsed: true } : {},
      sub: {
        status: sub.status, customerId: sub.customer, subscriptionId: sub.id,
        trialEnd: sub.trial_end ? sub.trial_end * 1000 : null,
        periodEnd: sub.current_period_end ? sub.current_period_end * 1000 : null,
      },
    });
  }

  async function applyCheckoutSession(session) {
    const user = store.byId(session.client_reference_id);
    if (!user || session.mode !== 'subscription' || !session.subscription) return;
    const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    const sub = await stripe.subscriptions.retrieve(subId); // estado real: trialing o active
    await applySubscription({ ...sub, metadata: { ...(sub.metadata || {}), userId: user.id } });
  }

  app.use(express.json({ limit: '20kb' }));

  /* ---------- Límite de intentos en login y registro ---------- */
  const hits = new Map();
  const limit = (max, windowMs) => (req, res, next) => {
    const key = req.ip + req.path, now = Date.now();
    const rec = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (rec.length >= max) return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.' });
    rec.push(now); hits.set(key, rec);
    if (hits.size > 5000) hits.clear();
    next();
  };

  const publicUser = (u) => ({
    email: u.email,
    status: u.sub.status,
    hasAccess: ACCESS.includes(u.sub.status),
    trialAvailable: !u.trialUsed,
    trialEnd: u.sub.trialEnd,
    periodEnd: u.sub.periodEnd,
    billing: !!(stripe && env.STRIPE_PRICE_ID),
  });

  const auth = (req, res, next) => {
    const h = req.headers.authorization || '';
    const p = h.startsWith('Bearer ') ? verifyToken(h.slice(7), secret) : null;
    const user = p && store.byId(p.uid);
    if (!user) return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo.', code: 'AUTH' });
    req.user = user;
    next();
  };

  // Guard de suscripción: solo con prueba activa o suscripción vigente
  const requireAccess = (req, res, next) => {
    if (ACCESS.includes(req.user.sub.status)) return next();
    res.status(402).json({ error: 'Necesitas iniciar tu prueba gratis de 7 días.', code: 'SUBSCRIPTION_REQUIRED' });
  };

  /* ---------- Cuenta ---------- */
  const credentials = (body) => {
    const email = String((body && body.email) || '').trim().toLowerCase();
    const password = String((body && body.password) || '');
    return { email, password };
  };

  app.post('/api/auth/register', limit(10, 60000), async (req, res) => {
    const { email, password } = credentials(req.body);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Escribe un correo válido.' });
    if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'La contraseña debe tener de 8 a 72 caracteres.' });
    if (store.byEmail(email)) return res.status(409).json({ error: 'Ese correo ya tiene cuenta. Entra con tu contraseña.' });
    const user = await store.create({ email, passHash: await hashPassword(password) });
    res.status(201).json({ token: signToken(user.id, secret), user: publicUser(user) });
  });

  app.post('/api/auth/login', limit(10, 60000), async (req, res) => {
    const { email, password } = credentials(req.body);
    const user = store.byEmail(email);
    // Misma respuesta si no existe o la contraseña no coincide
    const ok = user && (await verifyPassword(password, user.passHash));
    if (!ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    res.json({ token: signToken(user.id, secret), user: publicUser(user) });
  });

  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  /* ---------- Stripe ---------- */
  app.post('/api/create-checkout-session', auth, async (req, res) => {
    if (!stripe || !env.STRIPE_PRICE_ID) return res.status(503).json({ error: 'Los pagos aún no están configurados.' });
    const u = req.user;
    if (ACCESS.includes(u.sub.status)) return res.status(409).json({ error: 'Ya tienes una suscripción activa.' });
    try {
      const subscription_data = { metadata: { userId: u.id } };
      if (!u.trialUsed) subscription_data.trial_period_days = TRIAL_DAYS; // la prueba se da una sola vez por cuenta
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
        subscription_data,
        client_reference_id: u.id,
        ...(u.sub.customerId ? { customer: u.sub.customerId } : { customer_email: u.email }),
        allow_promotion_codes: true,
        success_url: `${appUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/?checkout=cancel`,
      });
      res.json({ url: session.url });
    } catch (e) {
      console.error('Checkout falló:', e.message);
      res.status(502).json({ error: 'No pudimos abrir el pago. Inténtalo otra vez.' });
    }
  });

  // Respaldo del webhook: al volver de Stripe, la app confirma la sesión directamente.
  app.post('/api/checkout/confirm', auth, async (req, res) => {
    const id = String((req.body && req.body.sessionId) || '');
    if (!stripe || !/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'Sesión inválida.' });
    try {
      const session = await stripe.checkout.sessions.retrieve(id);
      if (session.client_reference_id !== req.user.id) return res.status(403).json({ error: 'Esa sesión no es tuya.' });
      if (session.status === 'complete') await applyCheckoutSession(session);
      res.json({ user: publicUser(store.byId(req.user.id)) });
    } catch (e) {
      console.error('Confirmación falló:', e.message);
      res.status(502).json({ error: 'No pudimos confirmar el pago todavía.' });
    }
  });

  app.post('/api/portal', auth, async (req, res) => {
    if (!stripe || !req.user.sub.customerId) return res.status(400).json({ error: 'Aún no tienes una suscripción.' });
    try {
      const s = await stripe.billingPortal.sessions.create({ customer: req.user.sub.customerId, return_url: appUrl });
      res.json({ url: s.url });
    } catch (e) { console.error('Portal falló:', e.message); res.status(502).json({ error: 'No pudimos abrir tu suscripción.' }); }
  });

  app.delete('/api/account', auth, async (req, res) => {
    const u = req.user;
    try { if (stripe && u.sub.subscriptionId && ACCESS.includes(u.sub.status)) await stripe.subscriptions.cancel(u.sub.subscriptionId); }
    catch (e) { return res.status(502).json({ error: 'No pudimos cancelar tu suscripción. Cancélala desde "Administrar suscripción" y vuelve a intentarlo.' }); }
    await store.delete(u);
    res.json({ ok: true });
  });

  /* ---------- Contenido protegido ---------- */
  // La base de traducciones solo se entrega con prueba o suscripción vigente
  app.get('/api/dtc', auth, requireAccess, (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(DTC);
  });

  app.get('/healthz', (req, res) => res.send('ok'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));

  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, file) => { if (/(sw\.js|index\.html)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
  }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'))); // la app resuelve sus rutas

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos inválidos.' });
    console.error(err);
    res.status(500).json({ error: 'Algo salió mal.' });
  });

  return app;
}

module.exports = { createApp, ACCESS };

if (require.main === module) {
  const Stripe = process.env.STRIPE_SECRET_KEY ? require('stripe') : null;
  const stripe = Stripe ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  const store = createStore(process.env.DATA_DIR || path.join(__dirname, 'data-store'));
  const port = process.env.PORT || 3000;
  createApp({ store, stripe }).listen(port, () => console.log(`Traductor OBD-II en el puerto ${port}${stripe ? '' : ' (sin Stripe: define STRIPE_SECRET_KEY)'}`));
}
