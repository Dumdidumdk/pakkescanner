// Hvis man allerede er logget ind, gå direkte videre
fetch('/api/me').then(r => r.ok ? r.json() : null).then(user => {
  if (user) location.href = landingPage(user);
}).catch(() => {
  // Offline: har nogen været logget ind på telefonen, kan de stadig scanne
  try {
    if (localStorage.getItem('pakkescanner.user')) location.href = '/scan.html';
  } catch {}
});

function landingPage(user) {
  // Admins på en stor skærm lander på oversigten, ellers scanneren
  return user.role === 'admin' && window.innerWidth >= 900 ? '/admin.html' : '/scan.html';
}

const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const button = form.querySelector('button');
  button.disabled = true;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login fejlede');
    try { localStorage.setItem('pakkescanner.user', JSON.stringify(data)); } catch {}
    location.href = landingPage(data);
  } catch (err) {
    errorEl.textContent = err instanceof TypeError ? 'Ingen forbindelse til serveren' : err.message;
    errorEl.hidden = false;
  } finally {
    button.disabled = false;
  }
});
