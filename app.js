// Omeka Library: fetch Omeka S items by ID and show them as tiles in a 4x3 grid.
// API reference: https://omeka.org/s/docs/developer/api/

const GRID_SIZE = 12; // 4 columns x 3 rows
const STORAGE_KEY = 'omekaLibrary';

const form = document.getElementById('load-form');
const endpointInput = document.getElementById('endpoint');
const itemIdInput = document.getElementById('item-id');
const statusEl = document.getElementById('status');
const grid = document.getElementById('grid');

// Saved state: { endpoint: string, items: [item JSON, ...] }
let state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"endpoint":"","items":[]}');
endpointInput.value = state.endpoint;

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

// GET {endpoint}/items/{id}
async function fetchItem(endpoint, id) {
  const url = `${endpoint.replace(/\/+$/, '')}/items/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// Omeka S JSON-LD stores metadata as "prefix:term": [{ "@value", "property_label", ... }]
function getMetadata(item) {
  const rows = [];
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

function render() {
  grid.innerHTML = '';
  for (let i = 0; i < GRID_SIZE; i++) {
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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.items.length >= GRID_SIZE) {
    setStatus('Grid is full. Remove an item first.', true);
    return;
  }
  const endpoint = endpointInput.value.trim();
  const id = itemIdInput.value.trim();
  setStatus(`Loading item ${id}…`);
  try {
    const item = await fetchItem(endpoint, id);
    state.endpoint = endpoint;
    state.items.push(item);
    save();
    render();
    setStatus(`Loaded item ${id}.`);
    itemIdInput.value = '';
  } catch (err) {
    setStatus(`Could not load item: ${err.message}`, true);
  }
});

render();
