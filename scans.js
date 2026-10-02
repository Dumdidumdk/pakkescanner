// API til scanninger, pakkehistorik og afleveringssteder
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const db = require('./db');
const { requireLogin, requireAdmin } = require('./auth');

const router = express.Router();

const { photoDir } = db;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;

// ISO-tid fra telefonen -> SQLite-format i UTC ("2026-10-02 14:03:11")
function toDbTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function cleanText(value, max) {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length > max) return undefined;
  return v || null;
}

// Find den scanning der lå lige før, og afgør om den nye giver mening
function warningFor(barcode, type, scannedAt) {
  const prev = db.prepare(`
    SELECT type FROM scans
    WHERE barcode = ? AND scanned_at <= ?
    ORDER BY scanned_at DESC, id DESC LIMIT 1
  `).get(barcode, scannedAt);

  if (type === 'IN' && prev?.type === 'IN') return 'Allerede scannet ind';
  if (type === 'OUT' && !prev) return 'Aldrig scannet ind';
  if (type === 'OUT' && prev.type === 'OUT') return 'Allerede scannet ud';
  return null;
}

router.post('/scans', requireLogin, (req, res) => {
  const body = req.body || {};
  const clientId = body.client_id;
  const barcode = cleanText(body.barcode, 100);
  const type = body.type;
  const location = cleanText(body.location, 200);
  const note = cleanText(body.note, 500);
  const scannedAt = toDbTime(body.scanned_at);

  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) return res.status(400).json({ error: 'Ugyldigt client_id' });
  if (!barcode) return res.status(400).json({ error: 'Stregkode mangler' });
  if (type !== 'IN' && type !== 'OUT') return res.status(400).json({ error: 'Type skal være IN eller OUT' });
  if (location === undefined || note === undefined) return res.status(400).json({ error: 'Sted eller note er for langt' });
  if (type === 'OUT' && !location) return res.status(400).json({ error: 'Afleveringssted mangler' });
  if (!scannedAt) return res.status(400).json({ error: 'Ugyldigt tidspunkt' });

  // Er scanningen allerede modtaget (telefonen har sendt igen)? Så svar som om alt gik godt.
  const existing = db.prepare(`SELECT id, warning FROM scans WHERE client_id = ?`).get(clientId);
  if (existing) return res.json({ id: existing.id, warning: existing.warning, duplicate: true });

  let photoPath = null;
  if (body.photo) {
    const match = typeof body.photo === 'string' && PHOTO_RE.exec(body.photo);
    if (!match) return res.status(400).json({ error: 'Ugyldigt billede' });
    photoPath = `${clientId.toLowerCase()}.jpg`;
    fs.writeFileSync(path.join(photoDir, photoPath), Buffer.from(match[1], 'base64'));
  }

  const warning = warningFor(barcode, type, scannedAt);
  const result = db.prepare(`
    INSERT INTO scans (client_id, barcode, type, user_id, location, note, photo_path, warning, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (client_id) DO NOTHING
  `).run(clientId, barcode, type, req.user.id, location, note, photoPath, warning, scannedAt);

  res.status(201).json({ id: Number(result.lastInsertRowid), warning });
});

// Byg WHERE-del ud fra filtre i query-strengen. Bruges af både oversigten og Excel-eksporten.
// from/to er ISO-tidspunkter (browseren omregner lokale datoer til UTC).
function scanFilter(query) {
  const where = [];
  const params = [];
  const from = query.from && toDbTime(query.from);
  const to = query.to && toDbTime(query.to);
  if (from) { where.push('s.scanned_at >= ?'); params.push(from); }
  if (to) { where.push('s.scanned_at < ?'); params.push(to); }
  if (query.user) { where.push('s.user_id = ?'); params.push(Number(query.user) || 0); }
  if (query.type === 'IN' || query.type === 'OUT') { where.push('s.type = ?'); params.push(query.type); }
  if (query.warnings === '1') where.push('s.warning IS NOT NULL');
  if (typeof query.q === 'string' && query.q.trim()) {
    const like = `%${query.q.trim().replace(/[\\%_]/g, '\\$&')}%`;
    where.push(`(s.barcode LIKE ? ESCAPE '\\' OR s.location LIKE ? ESCAPE '\\' OR s.note LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const SCAN_COLUMNS = `
  s.id, s.barcode, s.type, s.location, s.note, s.warning, s.scanned_at, s.received_at,
  s.photo_path, u.name AS user_name
`;

// Alle scanninger, nyeste først (kun admin)
router.get('/scans', requireAdmin, (req, res) => {
  const filter = scanFilter(req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM scans s ${filter.sql}`).get(...filter.params).n;
  const rows = db.prepare(`
    SELECT ${SCAN_COLUMNS}
    FROM scans s JOIN users u ON u.id = s.user_id
    ${filter.sql}
    ORDER BY s.scanned_at DESC, s.id DESC
    LIMIT ? OFFSET ?
  `).all(...filter.params, limit, offset);
  res.json({ total, rows });
});

// Status pr. pakke ud fra seneste scanning (kun admin). status=in viser pakker der er inde lige nu.
router.get('/packages', requireAdmin, (req, res) => {
  const where = [`s.id = (SELECT id FROM scans WHERE barcode = s.barcode ORDER BY scanned_at DESC, id DESC LIMIT 1)`];
  const params = [];
  if (req.query.status === 'in') where.push(`s.type = 'IN'`);
  if (req.query.status === 'out') where.push(`s.type = 'OUT'`);
  if (typeof req.query.q === 'string' && req.query.q.trim()) {
    where.push(`s.barcode LIKE ? ESCAPE '\\'`);
    params.push(`%${req.query.q.trim().replace(/[\\%_]/g, '\\$&')}%`);
  }
  const rows = db.prepare(`
    SELECT ${SCAN_COLUMNS},
           (SELECT MIN(scanned_at) FROM scans WHERE barcode = s.barcode AND type = 'IN') AS first_in_at
    FROM scans s JOIN users u ON u.id = s.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.scanned_at DESC, s.id DESC
    LIMIT 1000
  `).all(...params);
  res.json({ total: rows.length, rows });
});

// Brugere til filteret i oversigten (kun admin)
router.get('/users', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT id, username, name, role, active FROM users ORDER BY name`).all());
});

// Seneste status + historik for én pakke
router.get('/packages/:barcode', requireLogin, (req, res) => {
  const history = db.prepare(`
    SELECT ${SCAN_COLUMNS}, s.photo_path IS NOT NULL AS has_photo
    FROM scans s JOIN users u ON u.id = s.user_id
    WHERE s.barcode = ?
    ORDER BY s.scanned_at DESC, s.id DESC
  `).all(req.params.barcode);
  res.json({ barcode: req.params.barcode, last: history[0] || null, history });
});

// Faste afleveringssteder (man kan også skrive frit)
router.get('/locations', requireLogin, (req, res) => {
  const rows = db.prepare(`SELECT name FROM locations WHERE active = 1 ORDER BY name`).all();
  res.json(rows.map(r => r.name));
});

module.exports = { router, photoDir, scanFilter, SCAN_COLUMNS };
