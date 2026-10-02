// Oversigten på computeren: alle scanninger med filtre, pakker inde nu, og historik pr. pakke
(async () => {
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 100;
  const REFRESH_MS = 30_000;

  const user = await initPage();
  if (!user) return;

  const filters = $('filters');
  let page = 0;
  let total = 0;

  // ---------- Hjælpere ----------

  // Serveren gemmer tid i UTC ("2026-10-02 14:03:11")
  const parseTime = (t) => new Date(t.replace(' ', 'T') + 'Z');
  const formatTime = (t) => parseTime(t).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'medium' });

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter(c => c != null));
    return node;
  }

  async function api(path) {
    const res = await fetch(path);
    if (res.status === 401) {
      location.href = '/';
      throw new Error('Ikke logget ind');
    }
    if (!res.ok) throw new Error(`Fejl ${res.status}`);
    return res.json();
  }

  const typeBadge = (type) => el('span', { className: `badge ${type === 'IN' ? 'in' : 'out'}`, textContent: type === 'IN' ? 'IND' : 'UD' });

  function barcodeLink(barcode) {
    const a = el('a', { href: '#', textContent: barcode, title: 'Se pakkens historik' });
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openPackage(barcode);
    });
    return a;
  }

  function photoThumb(row) {
    if (!row.photo_path) return null;
    const src = `/photos/${row.photo_path}`;
    const img = el('img', { src, className: 'thumb', alt: 'Billede', loading: 'lazy' });
    img.addEventListener('click', () => {
      $('photo-big').src = src;
      $('photo-dialog').showModal();
    });
    return img;
  }

  // Vis hvis scanningen kom frem meget senere end den blev lavet (telefonen var offline)
  function timeCell(row) {
    const td = el('td', { textContent: formatTime(row.scanned_at) });
    const delayMin = (parseTime(row.received_at) - parseTime(row.scanned_at)) / 60000;
    if (delayMin > 5) {
      td.append(' ', el('span', {
        className: 'late',
        textContent: '⏱',
        title: `Scannet offline – modtaget af serveren ${formatTime(row.received_at)}`,
      }));
    }
    return td;
  }

  // ---------- Alle scanninger ----------

  // Lokal dato (YYYY-MM-DD) -> UTC-tidspunkt for dagens start, evt. + antal dage
  function dayStart(value, addDays = 0) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d + addDays).toISOString();
  }

  function filterParams() {
    const f = new FormData(filters);
    const params = new URLSearchParams();
    if (f.get('from')) params.set('from', dayStart(f.get('from')));
    if (f.get('to')) params.set('to', dayStart(f.get('to'), 1)); // til og med den valgte dag
    for (const key of ['user', 'type', 'q', 'warnings']) {
      if (f.get(key)) params.set(key, f.get(key));
    }
    return params;
  }

  async function loadScans() {
    const params = filterParams();
    params.set('limit', PAGE_SIZE);
    params.set('offset', page * PAGE_SIZE);
    const data = await api(`/api/scans?${params}`);
    total = data.total;

    $('scan-rows').replaceChildren(...data.rows.map(row => el('tr', { className: row.warning ? 'has-warning' : '' },
      timeCell(row),
      el('td', {}, barcodeLink(row.barcode)),
      el('td', {}, typeBadge(row.type)),
      el('td', { textContent: row.user_name }),
      el('td', { textContent: row.location || '' }),
      el('td', { textContent: row.note || '' }),
      el('td', {}, photoThumb(row)),
      el('td', { className: 'warning-text', textContent: row.warning ? '⚠ ' + row.warning : '' }),
    )));

    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    $('scan-empty').hidden = total > 0;
    $('scan-count').textContent = `${total} scanning${total === 1 ? '' : 'er'}`;
    $('page-info').textContent = `Side ${page + 1} af ${pages}`;
    $('prev-page').disabled = page === 0;
    $('next-page').disabled = page >= pages - 1;
  }

  function filtersChanged() {
    page = 0;
    loadScans();
  }

  let searchTimer;
  filters.addEventListener('input', (e) => {
    // Vent lidt mens der skrives i søgefeltet
    clearTimeout(searchTimer);
    searchTimer = setTimeout(filtersChanged, e.target.type === 'search' ? 300 : 0);
  });
  filters.addEventListener('reset', () => setTimeout(filtersChanged));
  filters.addEventListener('submit', (e) => e.preventDefault());

  $('prev-page').addEventListener('click', () => { page--; loadScans(); });
  $('next-page').addEventListener('click', () => { page++; loadScans(); });

  async function loadUsers() {
    const users = await api('/api/users');
    filters.user.append(...users.map(u => el('option', { value: u.id, textContent: u.name })));
  }

  // ---------- Pakker inde nu ----------

  async function loadInside() {
    const params = new URLSearchParams({ status: 'in' });
    if ($('inside-q').value.trim()) params.set('q', $('inside-q').value.trim());
    const data = await api(`/api/packages?${params}`);

    $('inside-rows').replaceChildren(...data.rows.map(row => el('tr', { className: row.warning ? 'has-warning' : '' },
      el('td', {}, barcodeLink(row.barcode)),
      timeCell(row),
      el('td', { textContent: row.user_name }),
      el('td', { textContent: row.note || '' }),
      el('td', { className: 'warning-text', textContent: row.warning ? '⚠ ' + row.warning : '' }),
    )));
    $('inside-empty').hidden = data.total > 0;
    $('inside-count').textContent = `${data.total} pakke${data.total === 1 ? '' : 'r'} inde`;
  }

  let insideTimer;
  $('inside-q').addEventListener('input', () => {
    clearTimeout(insideTimer);
    insideTimer = setTimeout(loadInside, 300);
  });

  // ---------- Faner ----------

  let activeTab = 'scans';
  const loaders = { scans: loadScans, inside: loadInside };

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      $('tab-scans').hidden = activeTab !== 'scans';
      $('tab-inside').hidden = activeTab !== 'inside';
      loaders[activeTab]();
    });
  }

  // ---------- Historik for én pakke ----------

  async function openPackage(barcode) {
    const data = await api(`/api/packages/${encodeURIComponent(barcode)}`);
    $('package-title').textContent = `Pakke ${barcode}`;

    const last = data.last;
    $('package-status').replaceChildren(
      el('strong', { textContent: 'Status: ' }),
      !last ? 'Ingen scanninger'
        : last.type === 'IN' ? 'Inde – scannet ind ' + formatTime(last.scanned_at)
        : `Afleveret: ${last.location} – ${formatTime(last.scanned_at)}`,
    );

    $('package-history').replaceChildren(...data.history.map(row => el('li', { className: row.type === 'IN' ? 'in' : 'out' },
      el('div', {}, typeBadge(row.type), ' ', el('strong', { textContent: formatTime(row.scanned_at) }), ` · ${row.user_name}`),
      row.location ? el('div', { textContent: `Afleveret: ${row.location}` }) : null,
      row.note ? el('div', { className: 'muted', textContent: `Note: ${row.note}` }) : null,
      row.warning ? el('div', { className: 'warning-text', textContent: '⚠ ' + row.warning }) : null,
      photoThumb(row),
    )));
    $('package-dialog').showModal();
  }

  $('package-close').addEventListener('click', () => $('package-dialog').close());
  for (const dialog of document.querySelectorAll('dialog')) {
    // Klik uden for boksen (eller på det store billede) lukker
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog || dialog.id === 'photo-dialog') dialog.close();
    });
  }

  // ---------- Start ----------

  await Promise.all([loadUsers(), loadScans()]);

  // Hent nye scanninger automatisk, når man står på første side og ikke har en boks åben
  setInterval(() => {
    if (document.hidden || document.querySelector('dialog[open]')) return;
    if (activeTab === 'scans' && page > 0) return;
    loaders[activeTab]().catch(() => {});
  }, REFRESH_MS);
})();
