// Pakkescanner – webserver
const path = require('node:path');
const express = require('express');
const { loadUser, requireLogin, requireAdmin, login, logout } = require('./auth');
const scans = require('./scans');

const app = express();
const PORT = process.env.PORT || 3000;

// Bag en tunnel/proxy (Cloudflare, ngrok) skal Express stole på X-Forwarded-*
app.set('trust proxy', 1);

// Billeder sendes som base64 i JSON, så grænsen skal være større end standard
app.use(express.json({ limit: '8mb' }));
app.use(loadUser);

// --- API ---
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', requireLogin, (req, res) => res.json(req.user));
app.use('/api', scans.router);

// Billeder fra udscanninger – kun for admins
app.use('/photos', requireAdmin, express.static(scans.photoDir));

// --- Sider ---
// Beskyttede sider: send til login hvis man ikke er logget ind
function pageGuard(adminOnly) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/');
    if (adminOnly && req.user.role !== 'admin') return res.redirect('/scan.html');
    next();
  };
}
app.get('/scan.html', pageGuard(false));
app.get('/admin.html', pageGuard(true));

// Stregkode-biblioteket serveres direkte fra node_modules
app.get('/vendor/html5-qrcode.min.js', (req, res) => {
  res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js'));
});

// Service workeren må aldrig caches af browseren, ellers kommer opdateringer ikke ud
app.get('/sw.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Pakkescanner kører på http://localhost:${PORT}`);
});
