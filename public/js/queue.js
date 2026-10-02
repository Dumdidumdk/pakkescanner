// Lokal kø i IndexedDB: alle scanninger gemmes her først og sendes derefter til serveren.
// Status pr. scanning: 'pending' (venter), 'sent' (modtaget af server), 'failed' (afvist af server).
const Queue = (() => {
  const DB_NAME = 'pakkescanner';
  const STORE = 'scans';
  const KEEP_SENT = 200; // hvor mange sendte scanninger vi gemmer til historik på telefonen
  const RETRY_MS = 30_000;

  let dbPromise;
  let flushing = false;
  const listeners = new Set();

  function open() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'client_id' });
        store.createIndex('created', 'created');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result?.result ?? result);
      t.onerror = () => reject(t.error);
    });
  }

  const put = (item) => tx('readwrite', s => s.put(item));
  const all = () => tx('readonly', s => s.index('created').getAll());

  function notify() {
    for (const fn of listeners) fn();
  }

  // Tilføj en scanning til køen og prøv at sende med det samme
  async function add(scan) {
    const item = {
      ...scan,
      client_id: crypto.randomUUID(),
      scanned_at: new Date().toISOString(),
      created: Date.now(),
      has_photo: Boolean(scan.photo),
      status: 'pending',
      warning: scan.warning ?? null,
      error: null,
    };
    await put(item);
    notify();
    flush();
    return item;
  }

  // Nyeste først
  async function list() {
    return (await all()).reverse();
  }

  async function pendingCount() {
    return (await all()).filter(i => i.status === 'pending').length;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // Send alt der venter, i den rækkefølge det blev scannet.
  // userId: kun scanninger lavet af den bruger der er logget ind sendes.
  async function flush() {
    if (flushing) return;
    if (!navigator.onLine) {
      Queue.unreachable = true;
      notify();
      return;
    }
    const userId = Queue.currentUserId;
    if (!userId) return;
    flushing = true;
    let authProblem = false;
    let unreachable = Queue.unreachable;

    try {
      const pending = (await all()).filter(i => i.status === 'pending' && i.user_id === userId);
      if (pending.length === 0) unreachable = false; // intet at sende – så er der intet at vise
      for (const item of pending) {
        let res;
        try {
          res = await fetch('/api/scans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: item.client_id,
              barcode: item.barcode,
              type: item.type,
              location: item.location,
              note: item.note,
              scanned_at: item.scanned_at,
              photo: item.photo ? await blobToDataUrl(item.photo) : null,
            }),
          });
        } catch {
          unreachable = true;
          break; // intet net – prøv igen senere
        }
        unreachable = false;

        if (res.status === 401) {
          authProblem = true;
          break;
        }

        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          item.status = 'sent';
          item.warning = 'warning' in data ? data.warning : item.warning; // serverens vurdering vinder
          item.photo = null; // billedet ligger nu på serveren
        } else if (res.status >= 400 && res.status < 500) {
          item.status = 'failed';
          item.error = data.error || `Fejl ${res.status}`;
        } else {
          break; // serverfejl – prøv igen senere
        }
        await put(item);
        notify();
      }
      await prune();
    } finally {
      flushing = false;
      Queue.authProblem = authProblem;
      Queue.unreachable = unreachable;
      notify();
    }
  }

  // Slet gamle sendte scanninger, så telefonen ikke fyldes op
  async function prune() {
    const sent = (await all()).filter(i => i.status === 'sent');
    const excess = sent.slice(0, Math.max(0, sent.length - KEEP_SENT));
    if (excess.length) await tx('readwrite', s => excess.forEach(i => s.delete(i.client_id)));
  }

  // Seneste lokale scanning af en stregkode (bruges til advarsel når vi er offline)
  async function lastLocal(barcode) {
    return (await list()).find(i => i.barcode === barcode && i.status !== 'failed') || null;
  }

  async function remove(clientId) {
    await tx('readwrite', s => s.delete(clientId));
    notify();
  }

  window.addEventListener('online', () => flush());
  setInterval(() => flush(), RETRY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flush();
  });

  return {
    currentUserId: null,
    authProblem: false,
    unreachable: false, // true hvis seneste forsøg ikke kunne nå serveren (fx wifi uden internet)
    add, list, pendingCount, flush, lastLocal, remove,
    onChange: (fn) => listeners.add(fn),
  };
})();
