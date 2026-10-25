'use strict';
// Almacén de usuarios en un archivo JSON (prototipo).
// OJO: en Render el disco es temporal. Cada deploy o reinicio BORRA este archivo, y con él las cuentas.
// Para producción agrega un Disco persistente de Render (DATA_DIR=/var/data) o cambia esto por Supabase/Postgres.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createStore(dir) {
  const file = dir ? path.join(dir, 'db.json') : null;
  let db = { users: [], events: [] };
  if (file) {
    fs.mkdirSync(dir, { recursive: true });
    try { db = { users: [], events: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* archivo nuevo */ }
  }
  let writing = Promise.resolve();
  function save() {
    if (!file) return writing;
    const snapshot = JSON.stringify(db);
    writing = writing.then(async () => {
      const tmp = file + '.tmp';
      await fs.promises.writeFile(tmp, snapshot);
      await fs.promises.rename(tmp, file); // escritura atómica: nunca queda un archivo a medias
    }).catch((e) => console.error('No se pudo guardar la base:', e.message));
    return writing;
  }

  return {
    byId: (id) => db.users.find((u) => u.id === id) || null,
    byEmail: (email) => db.users.find((u) => u.email === email) || null,
    byCustomer: (cid) => (cid ? db.users.find((u) => u.sub.customerId === cid) || null : null),
    async create({ email, passHash }) {
      const user = { id: crypto.randomUUID(), email, passHash, createdAt: Date.now(), trialUsed: false,
        sub: { status: 'none', customerId: null, subscriptionId: null, trialEnd: null, periodEnd: null } };
      db.users.push(user);
      await save();
      return user;
    },
    async update(user, patch) {
      Object.assign(user, patch.user || {});
      if (patch.sub) Object.assign(user.sub, patch.sub);
      await save();
      return user;
    },
    // Stripe puede reenviar un evento: se procesa una sola vez
    seen: (id) => db.events.includes(id),
    async markSeen(id) { db.events.push(id); if (db.events.length > 500) db.events.shift(); await save(); },
    async delete(user) { db.users = db.users.filter((u) => u.id !== user.id); await save(); },
    flush: () => writing,
  };
}

module.exports = { createStore };
