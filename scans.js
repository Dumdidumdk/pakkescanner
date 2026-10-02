// API til scanninger, pakkehistorik og afleveringssteder
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const db = require('./db');
const { requireLogin } = require('./auth');

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

// Seneste status + historik for én pakke
router.get('/packages/:barcode', requireLogin, (req, res) => {
  const history = db.prepare(`
    SELECT s.id, s.barcode, s.type, s.location, s.note, s.warning, s.scanned_at,
           s.photo_path IS NOT NULL AS has_photo, u.name AS user_name
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

module.exports = { router, photoDir };
