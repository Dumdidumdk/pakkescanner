// Login, sessioner og adgangskontrol
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const COOKIE_NAME = 'sid';
const SESSION_DAYS = 14;

// Simpel beskyttelse mod gætteri: max 10 fejlede forsøg pr. IP pr. 15 min
const failedLogins = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED = 10;

function tooManyAttempts(ip) {
  const entry = failedLogins.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    failedLogins.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILED;
}

function recordFailure(ip) {
  const entry = failedLogins.get(ip);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) {
    failedLogins.set(ip, { first: Date.now(), count: 1 });
  } else {
    entry.count++;
  }
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

function cookieOptions(req) {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    req.secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`
  ).run(id, userId, `+${SESSION_DAYS} days`);
  return id;
}

// Middleware: sætter req.user hvis der er en gyldig session
function loadUser(req, res, next) {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (sid) {
    const user = db.prepare(`
      SELECT u.id, u.username, u.name, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > datetime('now') AND u.active = 1
    `).get(sid);
    if (user) {
      req.user = user;
      req.sessionId = sid;
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Du skal være logget ind' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Du skal være logget ind' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Kun for administratorer' });
  next();
}

function login(req, res) {
  const ip = req.ip;
  if (tooManyAttempts(ip)) {
    return res.status(429).json({ error: 'For mange forsøg. Prøv igen om lidt.' });
  }

  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Udfyld brugernavn og kode' });
  }

  const user = db.prepare(
    `SELECT id, username, name, role, password_hash FROM users WHERE username = ? AND active = 1`
  ).get(username.trim());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Forkert brugernavn eller kode' });
  }

  failedLogins.delete(ip);
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
  const sid = createSession(user.id);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sid}; Max-Age=${SESSION_DAYS * 86400}; ${cookieOptions(req)}`);
  res.json({ id: user.id, username: user.username, name: user.name, role: user.role });
}

function logout(req, res) {
  if (req.sessionId) db.prepare(`DELETE FROM sessions WHERE id = ?`).run(req.sessionId);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; ${cookieOptions(req)}`);
  res.json({ ok: true });
}

function createUser({ username, password, name, role = 'scanner' }) {
  const hash = bcrypt.hashSync(password, 12);
  const result = db.prepare(
    `INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)`
  ).run(username.trim(), hash, name.trim(), role);
  return Number(result.lastInsertRowid);
}

module.exports = { loadUser, requireLogin, requireAdmin, login, logout, createUser };
