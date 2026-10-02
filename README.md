# Pakkescanner

Scan pakker ind og ud med telefonens kamera. Virker også uden internet – scanninger gemmes på telefonen og sendes, når nettet er tilbage. Alle scanninger kan ses på en computer.

Se [PLAN.md](PLAN.md) for hele planen og hvad der er lavet.

## Krav

- **Node.js 24 eller nyere** (bruger den indbyggede SQLite, `node:sqlite`)
- git

## Opsætning på en ny computer

```bash
git clone https://github.com/Dumdidumdk/pakkescanner.git
cd pakkescanner
npm install

# Opret den første administrator (koden skal være mindst 8 tegn)
npm run create-user -- admin <kode> "Dit Navn" admin

# Opret almindelige brugere, der kun skal scanne
npm run create-user -- per <kode> "Per Hansen"

# Faste afleveringssteder (man kan også skrive frit i appen)
npm run add-location -- "Reception" "Lager A"

npm start
```

Åbn derefter <http://localhost:3000>.

Serveren bruger port 3000. En anden port vælges med `PORT=8080 npm start`.

## Data

Databasen og billederne ligger i mappen `data/` (`data/pakker.db` og `data/photos/`). Den mappe er **ikke** med i git – hver computer har sine egne brugere og scanninger. Tag backup af mappen, og kopiér den med, hvis serveren flyttes.

## Brug fra telefonen

Telefonens browser giver kun adgang til kameraet over **HTTPS**. Serveren skal derfor nås gennem en HTTPS-adresse, fx med en Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Kommandoen udskriver en `https://…trycloudflare.com`-adresse, som åbnes på telefonen.

## Opdatering

```bash
git pull
npm install
npm start
```
