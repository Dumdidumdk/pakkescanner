// Fælles for beskyttede sider: find bruger, vis navn og håndter log ud.
// Virker også offline: så bruges den bruger, der sidst var logget ind på telefonen.
const USER_KEY = 'pakkescanner.user';

function rememberUser(user) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {}
}

function rememberedUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
}

function forgetUser() {
  try { localStorage.removeItem(USER_KEY); } catch {}
}

async function currentUser() {
  try {
    const res = await fetch('/api/me');
    if (res.status === 401) return { user: null, offline: false };
    if (res.ok) {
      const user = await res.json();
      rememberUser(user);
      return { user, offline: false };
    }
  } catch {
    // intet net
  }
  return { user: rememberedUser(), offline: true };
}

async function initPage({ beforeLogout } = {}) {
  const { user, offline } = await currentUser();
  if (!user) {
    if (!offline) location.href = '/';
    return null;
  }
  document.getElementById('user-name').textContent = user.name;
  document.getElementById('logout').addEventListener('click', async () => {
    if (beforeLogout && !(await beforeLogout())) return;
    try { await fetch('/api/logout', { method: 'POST' }); } catch {}
    forgetUser();
    location.href = '/';
  });
  return user;
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker fejlede', err));
  }
}
