# Pakkescanner – Plan

## Formål

Et system hvor medarbejdere scanner pakkers stregkode med telefonens kamera:

- **Indscanning** – pakken er modtaget.
- **Udscanning** – pakken er afleveret, og der registreres *hvor* den er afleveret.
- Hver scanning gemmer **hvem** der scannede og **hvornår**.
- På en computer kan man se alle ind- og udscanninger, søge/filtrere og **eksportere til Excel (.xlsx)**.

---

## Overordnet løsning

Én **webapp** (ingen app store nødvendig), der virker både på telefon og computer.

```
 Telefon (browser)                     Server                       Computer (browser)
┌──────────────────┐   HTTPS/API   ┌───────────────────┐   HTTPS   ┌──────────────────────┐
│ Login            │ ────────────▶ │ Node.js + Express │ ◀──────── │ Oversigt/dashboard   │
│ Scan ind / ud    │               │ Login & sessioner │           │ Søg, filtrer         │
│ (kamera-scanner) │               │ SQLite database   │ ────────▶ │ Download Excel       │
└──────────────────┘               └───────────────────┘           └──────────────────────┘
```

**Hvorfor webapp?** Telefonens browser kan bruge kameraet direkte, så folk bare åbner et link og logger ind. Én kodebase til både telefon og computer.

---

## Teknologivalg

| Del | Valg | Begrundelse |
|---|---|---|
| Backend | **Node.js + Express** | Simpelt, samme sprog (JavaScript) i front- og backend |
| Database | **SQLite** (Nodes indbyggede `node:sqlite`) | Én fil, ingen server-opsætning, intet ekstra bibliotek. Kan senere skiftes til PostgreSQL |
| Stregkode-scanning | **`html5-qrcode`** (ZXing) | Læser almindelige 1D-stregkoder (EAN-13, Code 128 m.fl.) via kameraet i browseren |
| Login | Brugernavn + adgangskode, **bcrypt**-hash (`bcryptjs`), sessions gemt i databasen | Ingen adgangskoder gemmes i klartekst |
| Excel-eksport | **`exceljs`** | Laver rigtige .xlsx-filer |
| Frontend | Almindelig HTML/CSS/JS som **PWA** | Let, hurtigt, kan "installeres" på hjemmeskærmen og virker offline |
| Offline | **Service worker** + **IndexedDB**-kø | Scanninger og billeder gemmes på telefonen og sendes, når nettet er tilbage |
| HTTPS | Påkrævet | Browsere giver **kun kameraadgang over HTTPS** (eller localhost) |

---

## Datamodel

### `users`
| Felt | Type | Note |
|---|---|---|
| id | integer | primærnøgle |
| username | text | unik |
| password_hash | text | bcrypt |
| name | text | fulde navn, vises i oversigt |
| role | text | `scanner` eller `admin` |
| created_at | datetime | |

### `scans`
| Felt | Type | Note |
|---|---|---|
| id | integer | primærnøgle |
| client_id | text | unikt id lavet på telefonen (UUID), så en scanning aldrig gemmes to gange |
| barcode | text | stregkodens værdi |
| type | text | `IN` eller `OUT` |
| user_id | integer | hvem scannede |
| location | text | afleveringssted (ved `OUT`), evt. også modtagested ved `IN` |
| note | text | valgfri kommentar |
| photo_path | text | billede taget ved udscanning |
| warning | text | sat af serveren, fx "Aldrig scannet ind" / "Allerede scannet ud" |
| scanned_at | datetime | tidspunkt for selve scanningen (telefonens ur) |
| received_at | datetime | hvornår serveren modtog den (kan være senere ved offline) |

### `locations`
Faste afleveringssteder (fx "Reception", "Lager A"). Ved udscanning er der **ét felt**, hvor man enten vælger fra listen eller skriver frit. Steder man selv har skrevet, huskes på telefonen som forslag.

**Pakkens status** udledes af seneste scanning: seneste = `IN` → "på lager", seneste = `OUT` → "afleveret ved <location>".

---

## Funktioner

### 1. Login (telefon + computer)
- Log ind med brugernavn og kode.
- Admin kan oprette/deaktivere brugere og nulstille koder.

### 2. Scan ind (telefon)
1. Tryk **"Scan ind"** → kameraet åbner.
2. Stregkoden læses automatisk → bip/vibration.
3. Bekræft → gemmes med bruger + tidspunkt.
4. Klar til næste pakke (hurtig serie-scanning).

### 3. Scan ud (telefon)
1. Tryk **"Scan ud"** → scan stregkode.
2. Vælg eller skriv **afleveringssted** (+ evt. note).
3. Tag evt. et **billede** af den afleverede pakke.
4. Gem.
- Advarsel hvis pakken aldrig er scannet ind, eller allerede er scannet ud.

### 4. Offline-drift
Appen skal virke, selvom internettet forsvinder midt i arbejdet.

**Sådan virker det:**
1. **Appen ligger på telefonen.** En service worker gemmer siderne og scanner-koden lokalt, så scanner-siden kan åbnes uden net, når man har været logget ind én gang.
2. **Alle scanninger går gennem en lokal kø.** Når man trykker "Gem", lægges scanningen (inkl. billede) i telefonens IndexedDB, *før* der sendes noget. Så går intet tabt, heller ikke hvis nettet ryger midt i afsendelsen.
3. **Kø-sender.** Køen tømmes automatisk: med det samme hvis der er net, ellers når telefonen kommer online igen (`online`-event + nyt forsøg hvert 30. sekund og når appen åbnes).
4. **Ingen dubletter.** Hver scanning får et `client_id` (UUID) på telefonen. Sendes den to gange, gemmer serveren den kun én gang.
5. **Rigtigt tidspunkt.** `scanned_at` er tidspunktet på telefonen, da der blev scannet – ikke når den nåede serveren.
6. **Synlig status.** Øverst på skærmen: 🟢 *Online* / 🔴 *Offline – 7 scanninger venter*. Hver scanning i listen viser ✓ sendt eller ⏳ venter.

**Begrænsninger offline:**
- Advarslen "pakken er ikke scannet ind" kan ikke tjekkes mod serveren. Telefonen tjekker i stedet sine egne seneste scanninger, og serveren markerer eventuelle konflikter, når data kommer frem, så de kan ses i oversigten.
- Man kan ikke logge ind første gang uden net. Login holder 14 dage, og udløber det mens man er offline, gemmes scanningerne stadig og sendes efter næste login.
- Listen over afleveringssteder gemmes lokalt og opdateres, når der er net.

### 5. Manuel indtastning
Hvis en stregkode er beskadiget, kan nummeret tastes ind.

### 6. Oversigt (computer)
- Tabel med alle scanninger: tid, stregkode, ind/ud, bruger, sted.
- Filtre: dato-interval, bruger, type, sted, søg på stregkode.
- Klik på en stregkode → se hele pakkens historik.
- Fane med "pakker der er inde lige nu".

### 7. Excel-eksport
- Knappen **"Download Excel"** eksporterer det, der er filtreret frem.
- Ark 1: alle scanninger. Ark 2: status pr. pakke (indscannet tid, udscannet tid, afleveret hvor, af hvem).

---

## API (udkast)

| Metode | Sti | Beskrivelse |
|---|---|---|
| POST | `/api/login` | Log ind |
| POST | `/api/logout` | Log ud |
| POST | `/api/scans` | Ny scanning `{client_id, barcode, type, location, note, scanned_at}` + evt. billede. Samme `client_id` to gange = ignoreres |
| GET | `/api/scans` | Liste med filtre (`from`, `to`, `user`, `type`, `q`) |
| GET | `/api/packages/:barcode` | Historik for én pakke |
| GET | `/api/export.xlsx` | Excel-fil med samme filtre |
| GET/POST | `/api/users` | Brugeradministration (kun admin) |
| GET/POST | `/api/locations` | Afleveringssteder (kun admin) |

---

## Mappestruktur

```
pakkescanner/
├── PLAN.md
├── package.json
├── server.js            # Express-app, routes
├── db.js                # SQLite-opsætning og tabeller
├── auth.js              # login, sessions, roller
├── export.js            # Excel-generering
├── public/
│   ├── index.html       # login
│   ├── scan.html        # telefon: scan ind/ud
│   ├── admin.html       # computer: oversigt + eksport
│   ├── sw.js            # service worker (offline)
│   ├── manifest.json    # PWA – installér på hjemmeskærm
│   ├── css/
│   └── js/
└── data/
    └── pakker.db        # SQLite-databasen
```

---

## Faser

| Fase | Indhold | Resultat |
|---|---|---|
| **1. Grundlag** ✅ | Projekt, database, login, opret første admin-bruger | Man kan logge ind |
| **2. Scanning** ✅ | Kamera-scanner, scan ind/ud, billede, manuel indtastning, **offline-kø** | Telefonen kan scanne og gemme – også uden net |
| **3. Oversigt** | Admin-tabel, filtre, pakkehistorik | Alt kan ses på computeren |
| **4. Excel** | Eksport af filtrerede data | .xlsx-fil kan downloades |
| **5. Brugere & steder** | Admin-sider til brugere og afleveringssteder | Ingen manuel database-redigering |
| **6. Drift** | HTTPS, hosting, backup af databasen | Kan bruges i virkeligheden |

---

## Kom i gang

```bash
npm install
npm run create-user -- admin <kode> "Dit Navn" admin    # eller scanner
npm run add-location -- "Reception" "Lager A"           # faste afleveringssteder
npm start                                               # http://localhost:3000
```

## Test lokalt med telefon

Kameraet kræver HTTPS. Muligheder under udvikling:
- Kør serveren på computeren og brug en tunnel (fx **Cloudflare Tunnel** eller `ngrok`) → giver en HTTPS-adresse telefonen kan åbne.
- Eller lav et selvsigneret certifikat på det lokale netværk (kræver at telefonen accepterer det).

## Hosting senere

- Lille VPS (fx Hetzner) eller en Raspberry Pi med Cloudflare Tunnel.
- Daglig backup af `pakker.db`.

---

## Sikkerhed

- Adgangskoder hashes med bcrypt.
- Sessions-cookie med `HttpOnly` og `Secure`.
- Kun admin kan se oversigt, eksportere og administrere brugere.
- Rate-limit på login.
- Al trafik over HTTPS.

---

## Åbne spørgsmål

1. ~~Hvilken type stregkoder bruges?~~ **Besvaret:** almindelige 1D-stregkoder.
2. ~~Fast liste eller fritekst?~~ **Besvaret:** begge dele.
3. ~~Foto / GPS ved udscanning?~~ **Besvaret:** billeder ja, GPS nej.
4. Hvor mange brugere og cirka hvor mange pakker om dagen?
5. Skal scannere selv kunne se deres egne scanninger på telefonen?
6. Hvor skal systemet køre – egen server, Raspberry Pi eller i skyen?
7. ~~Skal det virke uden internet?~~ **Besvaret:** ja – scanninger gemmes på telefonen og sendes, når nettet er tilbage.
