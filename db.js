// Database-opsætning (Nodes indbyggede SQLite)
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'pakker.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'scanner' CHECK (role IN ('scanner', 'admin')),
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS locations (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS scans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  TEXT NOT NULL UNIQUE,  -- UUID fra telefonen, forhindrer dubletter ved gensending
    barcode    TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('IN', 'OUT')),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    location   TEXT,
    note       TEXT,
    photo_path TEXT,
    warning    TEXT,  -- fx "Aldrig scannet ind", sat af serveren ved modtagelse
    scanned_at  TEXT NOT NULL,  -- telefonens tidspunkt for scanningen
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_scans_barcode ON scans(barcode);
  CREATE INDEX IF NOT EXISTS idx_scans_scanned_at ON scans(scanned_at);
`);

// Billeder ligger i en mappe ved siden af databasen
db.photoDir = path.join(path.dirname(dbPath), 'photos');
fs.mkdirSync(db.photoDir, { recursive: true });

module.exports = db;
