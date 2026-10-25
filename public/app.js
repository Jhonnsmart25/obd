'use strict';
/* Traductor OBD-II · interfaz. Sin estilos en línea (la CSP solo permite styles.css). */
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg, ms = 3500) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), ms);
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nada */ } },
};

const state = { token: store.get('obd_token'), user: null, dtc: null, tab: 'scan', scan: null, auth: 'register', offline: false };

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const headers = {};
  if (state.token && !path.startsWith('/auth/')) headers.Authorization = 'Bearer ' + state.token;
  let body = opts.body;
  if (body) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  let res;
  try { res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body }); }
  catch { throw Object.assign(new Error('Sin conexión a internet.'), { offline: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Algo salió mal.'), { status: res.status, code: data.code });
  return data;
}

function logout(silent) {
  store.del('obd_token'); store.del('obd_dtc');
  Object.assign(state, { token: null, user: null, dtc: null, scan: null, tab: 'scan', auth: 'login' });
  if (!silent) toast('Sesión cerrada');
  render();
}

/* ---------- Guard: sesión -> prueba/suscripción -> app ---------- */
function render() {
  $app.replaceChildren();
  window.scrollTo(0, 0);
  if (!state.token || !state.user) return $app.append(AuthScreen());
  if (!state.user.hasAccess) return $app.append(TrialScreen()); // sin prueba ni suscripción vigente: a Stripe
  if (!state.dtc) return $app.append(h('main', { class: 'screen' }, brand(), h('p', {}, 'No pudimos cargar las explicaciones. Revisa tu internet.'),
    h('button', { class: 'btn', type: 'button', onclick: async () => { try { await loadDtc(); } catch (e) { toast(e.message); } render(); } }, 'Reintentar')));
  return $app.append(Shell());
}

async function loadDtc() {
  try {
    state.dtc = await api('/dtc');
    store.set('obd_dtc', JSON.stringify(state.dtc)); // copia para usarla dentro del auto, sin señal
    state.offline = false;
  } catch (e) {
    if (e.status === 402) { state.user.hasAccess = false; return; }
    if (e.status === 401) return logout(true);
    const saved = store.get('obd_dtc');
    if (saved) { try { state.dtc = JSON.parse(saved); state.offline = true; } catch { /* copia dañada */ } }
    else throw e;
  }
}

/* ---------- Entrada ---------- */
const brand = () => h('div', { class: 'brand' }, h('span', { class: 'lights', 'aria-hidden': 'true' }, h('i', { class: 'r' }), h('i', { class: 'y' }), h('i', { class: 'g' })), 'Traductor OBD');

function AuthScreen() {
  const isReg = state.auth === 'register';
  const err = h('div', { class: 'error', hidden: true, role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'submit' }, isReg ? 'Crear mi cuenta' : 'Entrar');
  const form = h('form', { class: 'form', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true;
    try {
      const d = await api(isReg ? '/auth/register' : '/auth/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
      state.token = d.token; store.set('obd_token', d.token); state.user = d.user;
      await afterLogin();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  } },
    err,
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'Correo'), h('input', { class: 'input', id: 'email', name: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', required: true })),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Contraseña'),
      h('input', { class: 'input', id: 'password', name: 'password', type: 'password', autocomplete: isReg ? 'new-password' : 'current-password', minlength: 8, required: true }),
      isReg ? h('span', { class: 'hint' }, 'Mínimo 8 caracteres.') : null),
    btn);
  return h('main', { class: 'screen' }, brand(),
    h('div', { class: 'hero' },
      h('h1', {}, isReg ? 'Entiende lo que le pasa a tu auto.' : 'Qué bueno verte de nuevo.'),
      h('p', {}, isReg ? 'Conecta un adaptador OBD-II y te explicamos las fallas en palabras sencillas, con un semáforo que te dice qué tan grave es.' : 'Entra para leer tu auto.')),
    form,
    h('button', { class: 'linkbtn', type: 'button', onclick: () => { state.auth = isReg ? 'login' : 'register'; render(); } }, isReg ? 'Ya tengo cuenta' : 'Crear una cuenta'));
}

async function afterLogin() {
  if (state.user.hasAccess) await loadDtc().catch((e) => toast(e.message));
  render();
}

function TrialScreen() {
  const u = state.user;
  const canTrial = u.trialAvailable;
  const err = h('div', { class: 'error', hidden: true, role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    btn.disabled = true; err.hidden = true;
    try { const d = await api('/create-checkout-session', { method: 'POST' }); location.href = d.url; }
    catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  } }, canTrial ? 'Empezar mis 7 días gratis' : 'Suscribirme');
  return h('main', { class: 'screen' }, brand(),
    h('div', { class: 'hero' },
      h('h1', {}, canTrial ? 'Pruébalo 7 días gratis.' : 'Tu acceso terminó.'),
      h('p', {}, canTrial
        ? 'Para activar tu prueba te pedimos una tarjeta en Stripe. No se te cobra durante los 7 días y puedes cancelar cuando quieras antes de que termine.'
        : 'Suscríbete para volver a leer y entender las fallas de tu auto.')),
    h('ul', { class: 'perks' },
      h('li', {}, 'Cada falla explicada sin tecnicismos'),
      h('li', {}, 'Semáforo: verde, amarillo o rojo'),
      h('li', {}, 'Qué hacer y si puedes seguir manejando'),
      h('li', {}, 'Modo demo para practicar sin auto')),
    err, btn,
    u.status === 'canceled' || u.status === 'past_due' || u.status === 'unpaid' ? h('p', { class: 'muted small' }, 'Estado de tu suscripción: ' + statusLabel(u.status) + '.') : null,
    h('button', { class: 'linkbtn', type: 'button', onclick: () => logout() }, 'Cerrar sesión'));
}

const statusLabel = (s) => ({ trialing: 'En prueba gratis', active: 'Activa', canceled: 'Cancelada', past_due: 'Pago pendiente', unpaid: 'Sin pago', incomplete: 'Incompleta', none: 'Sin suscripción' }[s] || s);

/* ---------- Estructura de la app ---------- */
const TABS = [['scan', 'Escanear', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>'], ['lookup', 'Buscar código', '<circle cx="11" cy="11" r="6"/><path d="m20 20-4-4"/>'], ['account', 'Cuenta', '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>']];

function Shell() {
  const views = { scan: ScanView, lookup: LookupView, account: AccountView };
  return h('div', { class: 'app' },
    h('header', { class: 'topbar' }, brand()),
    state.offline ? h('div', { class: 'offline', role: 'status' }, 'Sin internet: usando las explicaciones guardadas en tu teléfono.') : null,
    h('main', { class: 'content' }, views[state.tab]()),
    h('nav', { class: 'tabbar', 'aria-label': 'Secciones' }, TABS.map(([id, label, icon]) => {
      const svg = h('span'); svg.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
      return h('button', { class: 'tab', type: 'button', 'aria-current': state.tab === id ? 'page' : null, onclick: () => { state.tab = id; render(); } }, svg, label);
    })));
}

/* ---------- Tarjeta de falla (semáforo) ---------- */
const SEMAFORO = { verde: { label: 'Verde', short: 'No urgente' }, amarillo: { label: 'Amarillo', short: 'Revisar pronto' }, rojo: { label: 'Rojo', short: 'Serio' } };

function codeCard(t, open) {
  const s = SEMAFORO[t.gravedad];
  return h('details', { class: 'code ' + t.gravedad, open: open || null },
    h('summary', {},
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 'ct' },
        h('span', { class: 'pill' }, `${s.label} · ${s.short}`),
        h('span', { class: 'title' }, t.titulo),
        h('span', { class: 'meta' }, `${t.codigo} · ${t.sistema}`))),
    h('div', { class: 'cbody' },
      h('h4', {}, '¿Qué pasa?'), h('p', {}, t.explicacion),
      h('h4', {}, '¿Puedo seguir manejando?'), h('p', {}, t.puedes_manejar),
      h('h4', {}, 'Qué te conviene hacer'), h('ul', {}, t.consejos.map((c) => h('li', {}, c))),
      t.conocido ? null : h('p', { class: 'muted small' }, 'Este código aún no está en nuestra lista. Te damos una explicación general; un taller podrá darte el detalle.')));
}

/* ---------- Escanear ---------- */
function ScanView() {
  const sc = state.scan;
  if (sc && sc.busy) return h('section', { class: 'stack' }, h('div', { class: 'busy card', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, sc.step || 'Un momento…')));
  if (sc && sc.result) return ResultView(sc);

  const bleOk = !!navigator.bluetooth;
  return h('section', { class: 'stack' },
    h('div', { class: 'section-title' }, h('h2', {}, 'Lee tu auto'), h('p', { class: 'muted' }, 'Conecta el adaptador OBD-II al puerto bajo el volante, enciende el auto (o ponlo en contacto) y toca el botón.')),
    h('button', { class: 'btn big', type: 'button', disabled: !bleOk || null, onclick: () => runScan(new OBD.BleTransport()) }, 'Conectar adaptador Bluetooth'),
    bleOk ? null : h('p', { class: 'notice' }, 'Este navegador no permite Bluetooth. Abre la app en Chrome para Android, o prueba el modo demo.'),
    h('p', { class: 'muted small' }, 'Funciona con adaptadores ELM327 de Bluetooth de bajo consumo (BLE). Los adaptadores Bluetooth "clásico" baratos no funcionan desde el navegador.'),
    h('div', { class: 'section-title demo' }, h('h3', {}, 'Modo demo'), h('p', { class: 'muted' }, 'Practica sin auto. Es una simulación con datos de ejemplo.')),
    h('div', { class: 'scenarios' }, Object.entries(OBD.SCENARIOS).map(([key, s]) =>
      h('button', { class: 'scenario', type: 'button', onclick: () => runScan(OBD.SimTransport(key)) }, h('b', {}, s.nombre), h('span', {}, s.detalle)))),
    Disclaimer());
}

const Disclaimer = () => h('p', { class: 'fineprint' }, 'Esta app explica los códigos que guarda tu auto; no sustituye a un mecánico. Solo lee: no borra fallas ni cambia nada en tu auto.');

async function runScan(transport) {
  state.scan = { busy: true, step: 'Buscando adaptador…' };
  render();
  try {
    await transport.connect();
    const r = await OBD.readAll(transport, (step) => { state.scan.step = step; if (state.tab === 'scan') render(); });
    const items = r.codes.map((c) => OBD.translate(c, state.dtc));
    state.scan = { result: { items, live: r.live, simulated: !!transport.simulated, source: transport.name } };
  } catch (e) {
    state.scan = null;
    if (e && e.name === 'NotFoundError') toast('No elegiste ningún adaptador.');
    else toast((e && e.message) || 'No pudimos leer el auto.', 6000);
  } finally { transport.close(); }
  render();
}

function ResultView(sc) {
  const { items, live, simulated, source } = sc.result;
  const worst = items.length ? OBD.worst(items) : 'verde';
  const msg = items.length ? state.dtc.semaforo[worst] : 'Tu auto no tiene fallas guardadas. Si algo se siente raro, un mecánico puede revisar cosas que este escaneo no ve.';
  const head = items.length ? `${items.length} ${items.length === 1 ? 'falla encontrada' : 'fallas encontradas'}` : 'Todo en orden';
  return h('section', { class: 'stack' },
    simulated ? h('p', { class: 'notice' }, 'Esto es una simulación con datos de ejemplo, no tu auto.') : null,
    h('div', { class: 'verdict ' + worst, role: 'status' },
      h('span', { class: 'big-dot', 'aria-hidden': 'true' }),
      h('div', {}, h('h2', {}, head), h('p', {}, `Nivel: ${SEMAFORO[worst].label}. ${msg}`))),
    live && (live.rpm != null || live.temp != null) ? h('div', { class: 'live' },
      live.rpm != null ? h('div', {}, h('b', {}, live.rpm), h('span', {}, 'RPM')) : null,
      live.temp != null ? h('div', {}, h('b', {}, live.temp + '°C'), h('span', {}, 'Temperatura del motor')) : null) : null,
    h('div', { class: 'list' }, items.map((t, i) => codeCard(t, items.length === 1 || i === 0))),
    h('p', { class: 'muted small' }, 'Leído con: ' + source),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.scan = null; render(); } }, 'Hacer otra lectura'),
    Disclaimer());
}

/* ---------- Buscar código ---------- */
function LookupView() {
  const out = h('div', { class: 'list' });
  const input = h('input', { class: 'input', id: 'code', placeholder: 'Ejemplo: P0420', maxlength: 5, autocapitalize: 'characters', autocomplete: 'off', 'aria-label': 'Código de falla' });
  const show = (code) => {
    const c = code.trim().toUpperCase();
    out.replaceChildren();
    if (!/^[PBCU][0-3][0-9A-F]{3}$/.test(c)) { out.append(h('p', { class: 'notice' }, 'Un código tiene una letra y cuatro números, como P0420.')); return; }
    out.append(codeCard(OBD.translate(c, state.dtc), true));
  };
  const form = h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); show(input.value); } }, input, h('button', { class: 'btn', type: 'submit' }, 'Traducir'));
  return h('section', { class: 'stack' },
    h('div', { class: 'section-title' }, h('h2', {}, 'Buscar un código'), h('p', { class: 'muted' }, '¿Un mecánico te dio un código? Escríbelo y te lo explicamos.')),
    form, out,
    h('h3', {}, 'Los más comunes'),
    h('div', { class: 'chips' }, Object.entries(state.dtc.codes).map(([code, c]) =>
      h('button', { class: 'chip ' + c.gravedad, type: 'button', onclick: () => { input.value = code; show(code); } }, code))),
    Disclaimer());
}

/* ---------- Cuenta ---------- */
function AccountView() {
  const u = state.user;
  const fmt = (t) => (t ? new Date(t).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }) : null);
  return h('section', { class: 'stack' },
    h('div', { class: 'section-title' }, h('h2', {}, 'Tu cuenta'), h('p', { class: 'muted' }, u.email)),
    h('div', { class: 'card' },
      h('div', { class: 'kv' }, h('span', {}, 'Estado'), h('b', {}, statusLabel(u.status))),
      u.status === 'trialing' && u.trialEnd ? h('div', { class: 'kv' }, h('span', {}, 'La prueba termina'), h('b', {}, fmt(u.trialEnd))) : null,
      u.status === 'active' && u.periodEnd ? h('div', { class: 'kv' }, h('span', {}, 'Próximo cobro'), h('b', {}, fmt(u.periodEnd))) : null),
    u.billing ? h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
      try { const d = await api('/portal', { method: 'POST' }); location.href = d.url; } catch (e) { toast(e.message); }
    } }, 'Administrar o cancelar mi suscripción') : null,
    installBanner(),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => logout() }, 'Cerrar sesión'),
    h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (!confirm('Se borrará tu cuenta y se cancelará tu suscripción. No se puede deshacer. ¿Continuar?')) return;
      try { await api('/account', { method: 'DELETE' }); logout(true); toast('Tu cuenta se borró.'); } catch (e) { toast(e.message, 6000); }
    } }, 'Borrar mi cuenta'),
    h('p', { class: 'fineprint' }, 'Para el cobro usamos Stripe. No guardamos los datos de tu tarjeta. Las lecturas de tu auto se procesan en tu teléfono y no se envían a nuestros servidores.'));
}

/* ---------- Instalación PWA ---------- */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
window.addEventListener('appinstalled', () => { deferredInstall = null; toast('App instalada'); });
function installBanner() {
  if (!deferredInstall) return null;
  return h('button', { class: 'btn', type: 'button', onclick: async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; render(); } }, 'Instalar en mi teléfono');
}

/* ---------- Arranque ---------- */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const q = new URLSearchParams(location.search);

  if (state.token) {
    try { state.user = (await api('/me')).user; }
    catch (e) {
      if (e.status === 401) { store.del('obd_token'); state.token = null; state.auth = 'login'; }
      else if (e.offline && store.get('obd_dtc')) state.user = { email: 'Sin conexión', hasAccess: true, status: 'active', billing: false };
      else toast(e.message);
    }
  }

  // Regreso desde Stripe: confirmamos la sesión (respaldo del webhook) y esperamos a que se active
  if (q.get('checkout') === 'success' && state.token && state.user) {
    const sid = q.get('session_id');
    history.replaceState({}, '', '/');
    toast('Confirmando tu prueba gratis…', 5000);
    for (let i = 0; i < 8 && !state.user.hasAccess; i++) {
      try { state.user = sid ? (await api('/checkout/confirm', { method: 'POST', body: { sessionId: sid } })).user : (await api('/me')).user; } catch { /* reintenta */ }
      if (!state.user.hasAccess) await new Promise((r) => setTimeout(r, 1500));
    }
    if (state.user.hasAccess) toast('¡Listo! Tu prueba de 7 días ya empezó.', 5000);
  } else if (q.get('checkout') === 'cancel') { history.replaceState({}, '', '/'); toast('No se activó la prueba. Puedes intentarlo cuando quieras.'); }

  if (state.user && state.user.hasAccess) await loadDtc().catch((e) => toast(e.message));
  if (!state.user) state.auth = state.token ? state.auth : (store.get('obd_seen') ? 'login' : 'register');
  store.set('obd_seen', '1');
  render();
}

boot();
