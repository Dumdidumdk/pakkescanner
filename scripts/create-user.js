// Opret en bruger fra kommandolinjen
// Brug: npm run create-user -- <brugernavn> <kode> "<navn>" [admin|scanner]
const { createUser } = require('../auth');

const [username, password, name, role = 'scanner'] = process.argv.slice(2);

if (!username || !password || !name || !['admin', 'scanner'].includes(role)) {
  console.error('Brug: npm run create-user -- <brugernavn> <kode> "<navn>" [admin|scanner]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Koden skal være mindst 8 tegn');
  process.exit(1);
}

try {
  const id = createUser({ username, password, name, role });
  console.log(`Oprettet ${role} "${username}" (id ${id})`);
} catch (err) {
  if (String(err.message).includes('UNIQUE')) {
    console.error(`Brugernavnet "${username}" findes allerede`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
}
