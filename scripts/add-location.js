// Tilføj faste afleveringssteder fra kommandolinjen
// Brug: npm run add-location -- "Reception" "Lager A" ...
const db = require('../db');

const names = process.argv.slice(2).map(n => n.trim()).filter(Boolean);
if (names.length === 0) {
  console.error('Brug: npm run add-location -- "<navn>" ["<navn>" ...]');
  process.exit(1);
}

const insert = db.prepare(`INSERT INTO locations (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET active = 1`);
for (const name of names) {
  insert.run(name);
  console.log(`Afleveringssted: ${name}`);
}
