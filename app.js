// Omeka Library: fetch Omeka S items and show them as tiles in a grid.
// API reference: https://omeka.org/s/docs/developer/api/
// All API requests go through the local proxy in server.py, which avoids CORS
// and saves every fetched item to data/YYYYMMDD/<id>.json.

const MIN_SLOTS = 12;       // 4 columns x 3 rows; the grid grows past this as needed
const SCAN_SIZE = 10;       // "Scan for next 10"
const SCAN_ALL_SIZE = 25;   // items per request during "Scan all"
const SCAN_ALL_DELAY = 1000; // ms pause between "Scan all" requests
const PAUSE_EVERY = 1000;   // "Scan all" waits for the user every this many items
const STORAGE_KEY = 'omekaLibrary';

const $ = id => document.getElementById(id);
const sourceRow = $('source-row'), sourceSelect = $('source'), livePanel = $('live-panel');
const connectForm = $('connect-form'), endpointInput = $('endpoint'), totalEl = $('total');
const actions = $('actions'), addForm = $('add-form'), itemIdInput = $('item-id');
const scanBtn = $('scan-btn'), scanAllBtn = $('scan-all-btn');
const scanAllPanel = $('scan-all-panel'), progressBar = $('scan-progress'), progressText = $('scan-progress-text');
const continueBtn = $('continue-btn'), stopBtn = $('stop-btn');
const statusEl = $('status'), grid = $('grid');

// Only the endpoint is remembered between visits; items live on disk (data/).
const state = {
  endpoint: JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').endpoint || '',
  connected: false,
  total: 0,
  scanOffset: 0, // how far "Scan for next 10" has got (0, 10, 20...)
  items: [],     // items shown in the grid
};

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ endpoint: state.endpoint }));
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Omeka API (via proxy) ----------

async function apiGet(path) {
  const url = `${state.endpoint.replace(/\/+$/, '')}${path}`;
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

async function fetchItem(id) {
  return (await apiGet(`/items/${encodeURIComponent(id)}`)).json();
}

// One page of items in ID order.
async function fetchPage(page, perPage) {
  return (await apiGet(`/items?sort_by=id&sort_order=asc&per_page=${perPage}&page=${page}`)).json();
}

// ---------- Stored copies (data/YYYYMMDD) ----------

async function loadFolderList() {
  const folders = await (await fetch('/local')).json();
  const current = sourceSelect.value;
  sourceSelect.length = 1; // keep "Live"
  for (const { folder, count } of folders) {
    const label = `Stored: ${folder.slice(0, 4)}-${folder.slice(4, 6)}-${folder.slice(6)} (${count} items)`;
    sourceSelect.add(new Option(label, folder));
  }
  sourceSelect.value = [...sourceSelect.options].some(o => o.value === current) ? current : 'live';
  sourceRow.hidden = folders.length === 0;
}

sourceSelect.addEventListener('change', async () => {
  const source = sourceSelect.value;
  livePanel.hidden = source !== 'live';
  state.items = [];
  state.scanOffset = 0;
  if (source === 'live') {
    render();
    setStatus('');
    return;
  }
  setStatus(`Loading stored items from ${source}…`);
  try {
    state.items = await (await fetch(`/local/${source}`)).json();
    render();
    setStatus(`Showing ${state.items.length} stored items from ${source}.`);
  } catch (err) {
    setStatus(`Could not load stored items: ${err.message}`, true);
  }
});

// ---------- Rendering ----------

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
  remove.title = 'Remove from grid';
  remove.textContent = '×';
  remove.onclick = () => {
    state.items.splice(index, 1);
    render();
  };
  tile.appendChild(remove);

  const thumb = item.thumbnail_display_urls?.medium || item.thumbnail_display_urls?.square;
  if (thumb) {
    const img = document.createElement('img');
    img.src = thumb;
    img.alt = '';
    img.loading = 'lazy';
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
  actions.disabled = !state.connected;
  totalEl.textContent = state.connected ? `Connected: ${state.total} items available` : '';

  const start = state.scanOffset + 1;
  const end = Math.min(state.scanOffset + SCAN_SIZE, state.total);
  if (state.connected && start <= state.total) {
    scanBtn.textContent = `Scan for next 10 (items ${start}–${end})`;
    scanBtn.disabled = false;
  } else {
    scanBtn.textContent = state.connected ? 'Scan complete' : 'Scan for next 10';
    scanBtn.disabled = state.connected;
  }
  scanAllBtn.disabled = scanAll.running;
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

// ---------- Live actions ----------

connectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const endpoint = endpointInput.value.trim();
  if (endpoint !== state.endpoint) {
    // Different site: start fresh.
    state.items = [];
    state.scanOffset = 0;
  }
  state.endpoint = endpoint;
  setStatus('Connecting…');
  try {
    state.total = await fetchTotal();
    state.connected = true;
    save();
    setStatus('');
  } catch (err) {
    state.connected = false;
    setStatus(`Could not connect: ${err.message}`, true);
  }
  render();
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = itemIdInput.value.trim();
  setStatus(`Loading item ${id}…`);
  try {
    const added = addItems([await fetchItem(id)]);
    render();
    loadFolderList();
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
    const batch = await fetchPage(state.scanOffset / SCAN_SIZE + 1, SCAN_SIZE);
    const added = addItems(batch);
    state.scanOffset += SCAN_SIZE;
    render();
    loadFolderList();
    setStatus(`Scanned ${batch.length} items, added ${added} new.`);
  } catch (err) {
    setStatus(`Scan failed: ${err.message}`, true);
  }
});

// ---------- Scan all (background, saves to disk; does not fill the grid) ----------

const scanAll = { running: false, stopped: false, resume: null };

function updateProgress(done) {
  progressBar.max = state.total || 1;
  progressBar.value = done;
  progressText.textContent = `${done} / ${state.total} retrieved`;
}

// Resolves when the user clicks Continue (or Stop).
function waitForContinue() {
  continueBtn.hidden = false;
  return new Promise(resolve => {
    scanAll.resume = () => {
      continueBtn.hidden = true;
      scanAll.resume = null;
      resolve();
    };
  });
}

continueBtn.addEventListener('click', () => scanAll.resume?.());
stopBtn.addEventListener('click', () => {
  scanAll.stopped = true;
  scanAll.resume?.();
});

scanAllBtn.addEventListener('click', async () => {
  scanAll.running = true;
  scanAll.stopped = false;
  scanAllPanel.hidden = false;
  continueBtn.hidden = true;
  stopBtn.hidden = false;
  renderControls();

  let done = 0;
  let page = 1;
  updateProgress(0);
  setStatus('Scanning all items… (saved to the data folder)');
  try {
    while (!scanAll.stopped && done < state.total) {
      const batch = await fetchPage(page, SCAN_ALL_SIZE);
      done += batch.length;
      updateProgress(done);
      if (batch.length < SCAN_ALL_SIZE) break; // last page

      if (done % PAUSE_EVERY === 0 && done < state.total) {
        setStatus(`Paused after ${done} items. Click Continue to keep going.`);
        await waitForContinue();
        if (!scanAll.stopped) setStatus('Scanning all items… (saved to the data folder)');
      } else {
        await sleep(SCAN_ALL_DELAY);
      }
      page++;
    }
    setStatus(scanAll.stopped
      ? `Scan stopped at ${done} of ${state.total}.`
      : `Scan complete: ${done} items saved.`);
  } catch (err) {
    setStatus(`Scan failed after ${done} items: ${err.message}`, true);
  }
  scanAll.running = false;
  continueBtn.hidden = true;
  stopBtn.hidden = true;
  renderControls();
  loadFolderList();
});

// ---------- Start ----------

endpointInput.value = state.endpoint;
render();
loadFolderList().catch(() => {});
