// Omeka Library: fetch Omeka S items and show them as tiles in a grid.
// API reference: https://omeka.org/s/docs/developer/api/
// All requests go through the local proxy in server.py (avoids CORS).

const MIN_SLOTS = 12; // 4 columns x 3 rows; the grid grows past this as needed
const SCAN_SIZE = 10;
const STORAGE_KEY = 'omekaLibrary';

const connectForm = document.getElementById('connect-form');
const endpointInput = document.getElementById('endpoint');
const totalEl = document.getElementById('total');
const actions = document.getElementById('actions');
const addForm = document.getElementById('add-form');
const itemIdInput = document.getElementById('item-id');
const scanBtn = document.getElementById('scan-btn');
const statusEl = document.getElementById('status');
const grid = document.getElementById('grid');

// Saved state:
//   endpoint   - connected API URL ('' if not connected)
//   total      - total items reported by the API
//   scanOffset - how many items "Scan for next 10" has covered so far (0, 10, 20...)
//   items      - item JSON objects shown in the grid
let state = Object.assign(
  { endpoint: '', total: 0, scanOffset: 0, items: [] },
  JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
);

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

function apiUrl(path) {
  return `${state.endpoint.replace(/\/+$/, '')}${path}`;
}

async function apiGet(path) {
  const url = apiUrl(path);
  const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res;
}

// Total item count comes from the Omeka-S-Total-Results header on any list request.
async function fetchTotal() {
  const res = await apiGet('/items?per_page=1');
  const total = parseInt(res.headers.get('Omeka-S-Total-Results'), 10);
  if (Number.isNaN(total)) throw new Error('No Omeka-S-Total-Results header. Is this an Omeka S API URL?');
  return total;
}

// GET /items/{id}
async function fetchItem(id) {
  return (await apiGet(`/items/${encodeURIComponent(id)}`)).json();
}

// GET /items?sort_by=id&page=N&per_page=10 -> the next batch, in ID order
async function fetchBatch(offset) {
  const page = Math.floor(offset / SCAN_SIZE) + 1;
  return (await apiGet(`/items?sort_by=id&sort_order=asc&per_page=${SCAN_SIZE}&page=${page}`)).json();
}

function addItems(items) {
  const have = new Set(state.items.map(i => i['o:id']));
  const fresh = items.filter(i => !have.has(i['o:id']));
  state.items.push(...fresh);
  return fresh.length;
}

// Omeka S JSON-LD stores metadata as "prefix:term": [{ "@value", "property_label", ... }]
function getMetadata(item) {
  const rows = [['Omeka ID', String(item['o:id'])]];
  for (const [key, values] of Object.entries(item)) {
    if (!/^[a-z]+:[A-Za-z]+$/.test(key) || key.startsWith('o:')) continue;
    if (!Array.isArray(values)) continue;
    const label = values[0]?.property_label || key;
    const text = values
      .map(v => v['@value'] ?? v['o:label'] ?? v['@id'] ?? v.display_title ?? '')
      .filter(Boolean)
      .join('; ');
    if (text) rows.push([label, text]);
  }
  return rows;
}

function renderTile(item, index) {
  const tile = document.createElement('article');
  tile.className = 'tile';

  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.title = 'Remove';
  remove.textContent = '×';
  remove.onclick = () => {
    state.items.splice(index, 1);
    save();
    render();
  };
  tile.appendChild(remove);

  const thumb = item.thumbnail_display_urls?.medium || item.thumbnail_display_urls?.square;
  if (thumb) {
    const img = document.createElement('img');
    img.src = thumb;
    img.alt = '';
    tile.appendChild(img);
  }

  const title = document.createElement('h2');
  title.textContent = item['o:title'] || `Item ${item['o:id']}`;
  tile.appendChild(title);

  const dl = document.createElement('dl');
  for (const [label, text] of getMetadata(item)) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = text;
    dl.append(dt, dd);
  }
  tile.appendChild(dl);

  return tile;
}

function renderControls() {
  const connected = Boolean(state.endpoint);
  actions.disabled = !connected;
  totalEl.textContent = connected ? `Connected: ${state.total} items available` : '';

  const start = state.scanOffset + 1;
  const end = Math.min(state.scanOffset + SCAN_SIZE, state.total);
  if (connected && start <= state.total) {
    scanBtn.textContent = `Scan for next 10 (items ${start}–${end})`;
    scanBtn.disabled = false;
  } else {
    scanBtn.textContent = connected ? 'Scan complete' : 'Scan for next 10';
    scanBtn.disabled = true;
  }
}

function render() {
  renderControls();
  grid.innerHTML = '';
  // Always show at least 12 slots; add rows of 4 when there are more items.
  const slots = Math.max(MIN_SLOTS, Math.ceil(state.items.length / 4) * 4);
  for (let i = 0; i < slots; i++) {
    const item = state.items[i];
    if (item) {
      grid.appendChild(renderTile(item, i));
    } else {
      const empty = document.createElement('div');
      empty.className = 'tile empty';
      empty.textContent = 'Empty';
      grid.appendChild(empty);
    }
  }
}

connectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const endpoint = endpointInput.value.trim();
  const isNew = endpoint !== state.endpoint;
  setStatus('Connecting…');
  try {
    state.endpoint = endpoint;
    state.total = await fetchTotal();
    if (isNew) {
      // Different site: start fresh.
      state.items = [];
      state.scanOffset = 0;
    }
    save();
    render();
    setStatus('');
  } catch (err) {
    state.endpoint = '';
    save();
    render();
    setStatus(`Could not connect: ${err.message}`, true);
  }
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = itemIdInput.value.trim();
  setStatus(`Loading item ${id}…`);
  try {
    const added = addItems([await fetchItem(id)]);
    save();
    render();
    setStatus(added ? `Loaded item ${id}.` : `Item ${id} is already in the grid.`);
    itemIdInput.value = '';
  } catch (err) {
    setStatus(`Could not load item: ${err.message}`, true);
  }
});

scanBtn.addEventListener('click', async () => {
  const start = state.scanOffset + 1;
  setStatus(`Scanning items ${start}–${Math.min(start + SCAN_SIZE - 1, state.total)}…`);
  try {
    const batch = await fetchBatch(state.scanOffset);
    const added = addItems(batch);
    state.scanOffset += SCAN_SIZE;
    save();
    render();
    setStatus(`Scanned ${batch.length} items, added ${added} new.`);
  } catch (err) {
    setStatus(`Scan failed: ${err.message}`, true);
  }
});

endpointInput.value = state.endpoint;
render();
