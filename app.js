// Omeka Library: fetch Omeka S items and show them as tiles or CSV data.
// API reference: https://omeka.org/s/docs/developer/api/
// All API requests go through the local proxy in server.py, which avoids CORS
// and saves every fetched item to data/YYYYMMDD/<id>.json.

const MIN_SLOTS = 12;        // 4 columns x 3 rows; the grid grows past this as needed
const SCAN_SIZE = 10;        // "Scan for next 10"
const SCAN_ALL_SIZE = 25;    // items per request during "Scan all"
const SCAN_ALL_DELAY = 1000; // ms pause between "Scan all" requests
const PAUSE_EVERY = 1000;    // "Scan all" waits for the user every this many items
const STORAGE_KEY = 'omekaLibrary';

const $ = id => document.getElementById(id);
const sourceRow = $('source-row'), sourceSelect = $('source'), livePanel = $('live-panel');
const connectForm = $('connect-form'), endpointInput = $('endpoint'), totalEl = $('total');
const actions = $('actions'), addForm = $('add-form'), itemIdInput = $('item-id');
const scanBtn = $('scan-btn'), scanAllBtn = $('scan-all-btn');
const storedPanel = $('stored-panel'), resumeBtn = $('resume-btn'), resumeInfo = $('resume-info');
const scanAllPanel = $('scan-all-panel'), progressBar = $('scan-progress'), progressText = $('scan-progress-text');
const continueBtn = $('continue-btn'), stopBtn = $('stop-btn');
const tileViewBtn = $('tile-view-btn'), dataViewBtn = $('data-view-btn'), downloadBtn = $('download-btn');
const statusEl = $('status'), grid = $('grid'), dataView = $('data-view');

// Only the endpoint is remembered between visits; items live on disk (data/).
const state = {
  endpoint: JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').endpoint || '',
  connected: false,
  total: 0,
  scanOffset: 0,  // how far "Scan for next 10" has got (0, 10, 20...)
  items: [],      // items currently displayed
  source: 'live', // 'live' or a stored folder name (YYYYMMDD)
  folders: [],    // stored folders: [{ folder, count, meta }]
  view: 'tile',   // 'tile' or 'data'
};

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ endpoint: state.endpoint }));
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Today's folder name, e.g. 20261107
function todayFolder() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Omeka API (via proxy) ----------

// `folder` is where the proxy saves fetched items (default: today's folder).
async function apiGet(path, folder = todayFolder()) {
  const url = `${state.endpoint.replace(/\/+$/, '')}${path}`;
  const res = await fetch(`/proxy?folder=${folder}&url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res;
}

// Total item count comes from the Omeka-S-Total-Results header on any list request.
async function fetchTotal(folder) {
  const res = await apiGet('/items?per_page=1', folder);
  const total = parseInt(res.headers.get('Omeka-S-Total-Results'), 10);
  if (Number.isNaN(total)) throw new Error('No Omeka-S-Total-Results header. Is this an Omeka S API URL?');
  return total;
}

async function fetchItem(id) {
  return (await apiGet(`/items/${encodeURIComponent(id)}`)).json();
}

// One page of items in ID order.
async function fetchPage(page, perPage, folder) {
  return (await apiGet(`/items?sort_by=id&sort_order=asc&per_page=${perPage}&page=${page}`, folder)).json();
}

// ---------- Stored copies (data/YYYYMMDD) ----------

async function loadFolderList() {
  state.folders = await (await fetch('/local')).json();
  sourceSelect.length = 1; // keep "Live"
  for (const { folder, count } of state.folders) {
    const label = `Stored: ${folder.slice(0, 4)}-${folder.slice(4, 6)}-${folder.slice(6)} (${count} items)`;
    sourceSelect.add(new Option(label, folder));
  }
  if (!state.folders.some(f => f.folder === state.source)) state.source = 'live';
  sourceSelect.value = state.source;
  sourceRow.hidden = state.folders.length === 0;
  renderControls();
}

async function showSource(source) {
  state.source = source;
  sourceSelect.value = source;
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
}

sourceSelect.addEventListener('change', () => showSource(sourceSelect.value));

// Scan info for the stored folder on display, if its scan can be resumed.
function resumableMeta() {
  const meta = state.folders.find(f => f.folder === state.source)?.meta;
  return meta && !meta.complete ? meta : null;
}

// ---------- Metadata and CSV ----------

function addItems(items) {
  const have = new Set(state.items.map(i => i['o:id']));
  const fresh = items.filter(i => !have.has(i['o:id']));
  state.items.push(...fresh);
  return fresh.length;
}

// Omeka S JSON-LD stores metadata as "prefix:term": [{ "@value", "property_label", ... }]
// Returns [[term, label, text], ...]
function getProperties(item) {
  const rows = [];
  for (const [key, values] of Object.entries(item)) {
    if (!/^[a-z]+:[A-Za-z]+$/.test(key) || key.startsWith('o:')) continue;
    if (!Array.isArray(values)) continue;
    const label = values[0]?.property_label || key;
    const text = values
      .map(v => v['@value'] ?? v['o:label'] ?? v['@id'] ?? v.display_title ?? '')
      .filter(Boolean)
      .join('; ');
    if (text) rows.push([key, label, text]);
  }
  return rows;
}

function csvField(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Columns: o:id, o:title, then every property term found, in order of first appearance.
function toCsv(items) {
  const terms = [];
  const seen = new Set();
  const rows = items.map(item => {
    const props = {};
    for (const [term, , text] of getProperties(item)) {
      props[term] = text;
      if (!seen.has(term)) { seen.add(term); terms.push(term); }
    }
    return { id: item['o:id'], title: item['o:title'], props };
  });
  const header = ['o:id', 'o:title', ...terms];
  const lines = rows.map(r => [r.id, r.title, ...terms.map(t => r.props[t])].map(csvField).join(','));
  return [header.map(csvField).join(','), ...lines].join('\n');
}

downloadBtn.addEventListener('click', () => {
  const blob = new Blob([toCsv(state.items)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `omeka-items-${state.source === 'live' ? todayFolder() + '-live' : state.source}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- Rendering ----------

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
  const rows = [['Omeka ID', String(item['o:id'])], ...getProperties(item).map(([, label, text]) => [label, text])];
  for (const [label, text] of rows) {
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
  const live = state.source === 'live';
  livePanel.hidden = !live;

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

  const meta = live ? null : resumableMeta();
  storedPanel.hidden = !meta;
  resumeBtn.disabled = scanAll.running;
  if (meta) resumeInfo.textContent = `Scan stopped at ${meta.scanned} / ${meta.total} from ${meta.endpoint}`;

  tileViewBtn.classList.toggle('active', state.view === 'tile');
  dataViewBtn.classList.toggle('active', state.view === 'data');
  downloadBtn.hidden = state.view !== 'data';
}

function render() {
  renderControls();
  grid.hidden = state.view !== 'tile';
  dataView.hidden = state.view !== 'data';

  if (state.view === 'data') {
    grid.innerHTML = '';
    dataView.textContent = state.items.length ? toCsv(state.items) : 'No items to show.';
    return;
  }

  dataView.textContent = '';
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

tileViewBtn.addEventListener('click', () => { state.view = 'tile'; render(); });
dataViewBtn.addEventListener('click', () => { state.view = 'data'; render(); });

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

// ---------- Scan all / Resume scan (background, saves to disk) ----------

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

// Records scan progress in the folder's _meta.json so it can be resumed later.
function saveMeta(folder, scanned, complete) {
  return fetch(`/local/${folder}/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: state.endpoint, total: state.total, scanned, complete }),
  });
}

// Scans all items in ID order into `folder`, starting after `startDone` items.
async function runScan(folder, startDone) {
  scanAll.running = true;
  scanAll.stopped = false;
  scanAllPanel.hidden = false;
  continueBtn.hidden = true;
  stopBtn.hidden = false;
  renderControls();

  let done = startDone;
  let page = Math.floor(startDone / SCAN_ALL_SIZE) + 1;
  const scanning = `Scanning all items… (saving to data/${folder})`;
  updateProgress(done);
  setStatus(scanning);
  try {
    while (!scanAll.stopped && done < state.total) {
      const batch = await fetchPage(page, SCAN_ALL_SIZE, folder);
      done += batch.length;
      updateProgress(done);
      const finished = batch.length < SCAN_ALL_SIZE || done >= state.total;
      await saveMeta(folder, done, finished);
      if (finished) break;

      if (done % PAUSE_EVERY === 0) {
        setStatus(`Paused after ${done} items. Click Continue to keep going.`);
        await waitForContinue();
        if (!scanAll.stopped) setStatus(scanning);
      } else {
        await sleep(SCAN_ALL_DELAY);
      }
      page++;
    }
    setStatus(scanAll.stopped
      ? `Scan stopped at ${done} of ${state.total}. You can resume it from the stored folder.`
      : `Scan complete: ${done} items saved to data/${folder}.`);
  } catch (err) {
    setStatus(`Scan failed after ${done} items: ${err.message}`, true);
  }
  scanAll.running = false;
  continueBtn.hidden = true;
  stopBtn.hidden = true;
  await loadFolderList();
}

scanAllBtn.addEventListener('click', () => runScan(todayFolder(), 0));

resumeBtn.addEventListener('click', async () => {
  const meta = resumableMeta();
  if (!meta) return;
  const folder = state.source;
  state.endpoint = meta.endpoint;
  endpointInput.value = meta.endpoint;
  setStatus(`Connecting to ${meta.endpoint}…`);
  try {
    state.total = await fetchTotal(folder);
    state.connected = true;
    save();
  } catch (err) {
    setStatus(`Could not connect: ${err.message}`, true);
    return;
  }
  await runScan(folder, meta.scanned);
  // Refresh the stored view with the newly saved items.
  if (state.source === folder) {
    const msg = statusEl.textContent, isError = statusEl.className === 'error';
    await showSource(folder);
    setStatus(msg, isError);
  }
});

// ---------- Start ----------

endpointInput.value = state.endpoint;
render();
loadFolderList().catch(() => {});
