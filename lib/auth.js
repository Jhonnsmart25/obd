'use strict';
// Contraseñas con scrypt y sesiones firmadas con HMAC. Solo usa módulos de Node (sin dependencias extra).
const crypto = require('crypto');

const b64 = (b) => Buffer.from(b).toString('base64url');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await new Promise((res, rej) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
  return `s1$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [v, saltB64, keyB64] = String(stored).split('$');
  if (v !== 's1') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await new Promise((res, rej) => crypto.scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
  return crypto.timingSafeEqual(key, expected);
}

function signToken(uid, secret, days = 30) {
  const body = b64(JSON.stringify({ uid, exp: Date.now() + days * 864e5 }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token, secret) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
