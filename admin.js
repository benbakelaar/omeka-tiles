// Admin page: view and edit config.json via the server's /config endpoint.

const form = document.getElementById('config-form');
const statusEl = document.getElementById('status');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

async function load() {
  const config = await (await fetch('/config')).json();
  for (const [name, value] of Object.entries(config)) {
    if (form.elements[name]) form.elements[name].value = value;
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const changes = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    changes[el.name] = el.type === 'number' ? Number(el.value) : el.value.trim();
  }
  const res = await fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  const result = await res.json();
  if (res.ok) {
    setStatus('Saved.');
  } else {
    setStatus(`Not saved: ${result.error}`, true);
  }
});

load().catch(err => setStatus(`Could not load settings: ${err.message}`, true));
