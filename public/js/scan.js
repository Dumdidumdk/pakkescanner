// Scanner-siden: kamera, formular, lokal kø og liste over seneste scanninger
(async () => {
  const $ = (id) => document.getElementById(id);
  const LOCATIONS_KEY = 'pakkescanner.locations';
  const MODE_KEY = 'pakkescanner.mode';

  const user = await initPage({ beforeLogout: confirmLogout });
  if (!user) return;
  if (user.role === 'admin') $('admin-link').hidden = false;

  Queue.currentUserId = user.id;
  registerServiceWorker();

  let mode = 'IN';
  let photoBlob = null;
  let scanner = null;
  let scannerRunning = false;

  // ---------- Kamera ----------

  // Almindelige 1D-stregkoder
  const FORMATS = [
    'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'CODABAR',
  ].map(f => Html5QrcodeSupportedFormats[f]);

  // Kræv samme stregkode læst to gange i træk, så vi undgår fejllæsninger
  let lastRead = null;
  let lastReadAt = 0;

  async function startScanner() {
    if (scannerRunning || !$('scan-form').hidden) return;
    $('camera-error').hidden = true;
    scanner ??= new Html5Qrcode('reader', {
      formatsToSupport: FORMATS,
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false,
    });
    try {
      scannerRunning = true;
      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 15,
          // Bredt, lavt felt passer til stregkoder
          qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(Math.min(h * 0.45, w * 0.45)) }),
        },
        onRead,
        () => {},
      );
    } catch (err) {
      scannerRunning = false;
      $('camera-error').textContent = cameraErrorText(err);
      $('camera-error').hidden = false;
    }
  }

  async function stopScanner() {
    if (!scannerRunning) return;
    scannerRunning = false;
    try { await scanner.stop(); } catch {}
  }

  function cameraErrorText(err) {
    const msg = String(err?.message || err);
    if (/NotAllowed|Permission/i.test(msg)) return 'Kameraet er blokeret. Giv siden adgang til kameraet i browserens indstillinger.';
    if (!window.isSecureContext) return 'Kameraet kræver HTTPS.';
    return 'Kunne ikke starte kameraet: ' + msg;
  }

  function onRead(text) {
    const now = Date.now();
    if (text !== lastRead || now - lastReadAt > 1500) {
      lastRead = text;
      lastReadAt = now;
      return;
    }
    lastRead = null;
    beep();
    openForm(text.trim());
  }

  function beep() {
    navigator.vibrate?.(80);
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.frequency.value = 1200;
      osc.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
      osc.onended = () => ctx.close();
    } catch {}
  }

  // Sluk kameraet når appen ikke er synlig (sparer batteri)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopScanner();
    else startScanner();
  });

  // ---------- Ind/ud-valg ----------

  function setMode(newMode) {
    mode = newMode;
    $('mode-in').classList.toggle('active', mode === 'IN');
    $('mode-out').classList.toggle('active', mode === 'OUT');
    document.body.dataset.mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch {}
    if (!$('scan-form').hidden) updateFormForMode();
  }
  $('mode-in').addEventListener('click', () => setMode('IN'));
  $('mode-out').addEventListener('click', () => setMode('OUT'));

  // ---------- Formular ----------

  async function openForm(barcode) {
    await stopScanner();
    $('scanner-view').hidden = true;
    $('scan-form').hidden = false;
    $('scan-form').reset();
    $('barcode').value = barcode;
    $('form-error').hidden = true;
    clearPhoto();
    updateFormForMode();
    fillLocations();
    if (barcode) {
      $('save-btn').focus();
      showWarning(barcode);
    } else {
      $('barcode').focus();
    }
  }

  async function closeForm() {
    $('scan-form').hidden = true;
    $('scanner-view').hidden = false;
    $('warning').hidden = true;
    clearPhoto();
    await startScanner();
  }

  function updateFormForMode() {
    $('form-title').textContent = mode === 'IN' ? 'Scan ind' : 'Scan ud';
    $('out-fields').hidden = mode !== 'OUT';
    $('location').required = mode === 'OUT';
    $('save-btn').textContent = mode === 'IN' ? 'Gem indscanning' : 'Gem udscanning';
    const barcode = $('barcode').value.trim();
    if (barcode) showWarning(barcode);
  }

  $('manual-btn').addEventListener('click', () => openForm(''));
  $('cancel-btn').addEventListener('click', closeForm);
  $('barcode').addEventListener('change', () => showWarning($('barcode').value.trim()));

  $('scan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = $('barcode').value.trim();
    const location = $('location').value.trim();
    if (!barcode) return showFormError('Indtast en stregkode');
    if (mode === 'OUT' && !location) return showFormError('Skriv hvor pakken er afleveret');

    await Queue.add({
      barcode,
      type: mode,
      location: mode === 'OUT' ? location : null,
      note: $('note').value.trim() || null,
      photo: mode === 'OUT' ? photoBlob : null,
      user_id: user.id,
      user_name: user.name,
      warning: $('warning').hidden ? null : $('warning').textContent,
    });
    if (mode === 'OUT') rememberLocation(location);
    await closeForm();
  });

  function showFormError(text) {
    $('form-error').textContent = text;
    $('form-error').hidden = false;
  }

  // ---------- Advarsel: giver scanningen mening? ----------

  function serverTime(t) {
    return new Date(t.replace(' ', 'T') + 'Z');
  }

  async function showWarning(barcode) {
    const forMode = mode;
    $('warning').hidden = true;
    if (!barcode) return;

    let last = null;
    try {
      const res = await fetch(`/api/packages/${encodeURIComponent(barcode)}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        if (data.last) last = { type: data.last.type, at: serverTime(data.last.scanned_at) };
      }
    } catch {
      // offline – vi bruger kun det telefonen selv ved
    }
    const local = await Queue.lastLocal(barcode);
    if (local && (!last || new Date(local.scanned_at) > last.at)) {
      last = { type: local.type, at: new Date(local.scanned_at) };
    }

    // Brugeren kan have skiftet stregkode eller ind/ud imens
    if ($('barcode').value.trim() !== barcode || mode !== forMode) return;

    let text = null;
    if (mode === 'IN' && last?.type === 'IN') text = 'Pakken er allerede scannet ind';
    if (mode === 'OUT' && !last) text = 'Pakken er aldrig scannet ind';
    if (mode === 'OUT' && last?.type === 'OUT') text = 'Pakken er allerede scannet ud';
    if (text) {
      $('warning').textContent = text;
      $('warning').hidden = false;
    }
  }

  // ---------- Afleveringssteder (fast liste + dem man selv har skrevet) ----------

  function storedLocations() {
    try { return JSON.parse(localStorage.getItem(LOCATIONS_KEY)) || { fixed: [], used: [] }; }
    catch { return { fixed: [], used: [] }; }
  }

  function saveLocations(data) {
    try { localStorage.setItem(LOCATIONS_KEY, JSON.stringify(data)); } catch {}
  }

  function rememberLocation(name) {
    const data = storedLocations();
    data.used = [name, ...data.used.filter(n => n !== name)].slice(0, 20);
    saveLocations(data);
  }

  function fillLocations() {
    const { fixed, used } = storedLocations();
    const names = [...new Set([...fixed, ...used])];
    $('location-list').replaceChildren(...names.map(n => {
      const opt = document.createElement('option');
      opt.value = n;
      return opt;
    }));
  }

  async function refreshLocations() {
    try {
      const res = await fetch('/api/locations');
      if (!res.ok) return;
      const data = storedLocations();
      data.fixed = await res.json();
      saveLocations(data);
    } catch {}
  }

  // ---------- Billede ----------

  $('photo').addEventListener('change', async () => {
    const file = $('photo').files[0];
    if (!file) return;
    try {
      photoBlob = await compressImage(file);
      $('photo-preview').src = URL.createObjectURL(photoBlob);
      $('photo-preview').hidden = false;
      $('photo-remove').hidden = false;
      $('photo-label').textContent = '📷 Tag nyt billede';
    } catch {
      showFormError('Kunne ikke læse billedet');
    }
  });

  $('photo-remove').addEventListener('click', clearPhoto);

  function clearPhoto() {
    photoBlob = null;
    $('photo').value = '';
    if ($('photo-preview').src) URL.revokeObjectURL($('photo-preview').src);
    $('photo-preview').removeAttribute('src');
    $('photo-preview').hidden = true;
    $('photo-remove').hidden = true;
    $('photo-label').textContent = '📷 Tag billede';
  }

  // Gør billedet mindre (max 1600 px, JPEG), så det fylder lidt og sendes hurtigt
  async function compressImage(file) {
    const MAX = 1600;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', 0.75));
  }

  // ---------- Status og seneste scanninger ----------

  async function render() {
    const items = await Queue.list();
    const mine = items.filter(i => i.user_id === user.id);
    const pending = mine.filter(i => i.status === 'pending').length;
    const othersPending = items.filter(i => i.status === 'pending' && i.user_id !== user.id);

    const status = $('net-status');
    if (Queue.authProblem) {
      status.className = 'net-status bad';
      status.innerHTML = '';
      status.append(`⚠ Du er logget ud – ${pending} scanning(er) venter. `);
      const a = document.createElement('a');
      a.href = '/';
      a.textContent = 'Log ind igen';
      status.append(a);
    } else if (!navigator.onLine || Queue.unreachable) {
      status.className = 'net-status bad';
      status.textContent = pending ? `🔴 Offline – ${pending} scanning(er) venter` : '🔴 Offline – scanninger gemmes på telefonen';
    } else if (pending) {
      status.className = 'net-status wait';
      status.textContent = `⏳ Sender ${pending} scanning(er)…`;
    } else {
      status.className = 'net-status ok';
      status.textContent = '🟢 Online – alt er sendt';
    }
    if (othersPending.length) {
      const names = [...new Set(othersPending.map(i => i.user_name))].join(', ');
      status.append(` · ${othersPending.length} venter på at ${names} logger ind`);
    }

    $('recent-empty').hidden = items.length > 0;
    $('recent-list').replaceChildren(...items.slice(0, 30).map(renderItem));
  }

  function renderItem(item) {
    const li = document.createElement('li');
    li.className = `recent-item ${item.type === 'IN' ? 'in' : 'out'} ${item.status}`;

    const top = document.createElement('div');
    top.className = 'recent-top';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = item.type === 'IN' ? 'IND' : 'UD';
    const code = document.createElement('strong');
    code.textContent = item.barcode;
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = { pending: '⏳ venter', sent: '✓ sendt', failed: '✗ afvist' }[item.status];
    top.append(badge, code, state);

    const meta = document.createElement('div');
    meta.className = 'muted small';
    const parts = [new Date(item.scanned_at).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' })];
    if (item.location) parts.push(item.location);
    if (item.has_photo) parts.push('📷');
    if (item.user_id !== user.id) parts.push(item.user_name);
    meta.textContent = parts.join(' · ');

    li.append(top, meta);

    for (const text of [item.warning, item.error].filter(Boolean)) {
      const p = document.createElement('div');
      p.className = item.error === text ? 'error small' : 'warning-text small';
      p.textContent = '⚠ ' + text;
      li.append(p);
    }

    if (item.status === 'failed') {
      const del = document.createElement('button');
      del.className = 'link small';
      del.textContent = 'Fjern';
      del.addEventListener('click', () => Queue.remove(item.client_id));
      li.append(del);
    }
    return li;
  }

  async function confirmLogout() {
    const pending = (await Queue.list()).filter(i => i.status === 'pending' && i.user_id === user.id).length;
    if (!pending) return true;
    return confirm(`${pending} scanning(er) er ikke sendt endnu.\nDe bliver gemt på telefonen og sendt, næste gang du logger ind.\n\nLog ud alligevel?`);
  }

  Queue.onChange(render);
  window.addEventListener('online', render);
  window.addEventListener('offline', render);

  let savedMode = 'IN';
  try { savedMode = localStorage.getItem(MODE_KEY) === 'OUT' ? 'OUT' : 'IN'; } catch {}
  setMode(savedMode);
  render();
  refreshLocations();
  Queue.flush();
  startScanner();
})();
