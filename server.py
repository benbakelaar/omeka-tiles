"""Local dev server for Omeka Library.

- Serves the app's files.
- /proxy?url=...   Forwards API requests to Omeka, so the browser never makes
                   a cross-origin request (no CORS needed). Every item it
                   fetches is also saved to data/YYYYMMDD/<o:id>.json
                   (today's folder, or &folder=YYYYMMDD to resume an older one).
- /local           Lists the dated folders in data/ with item counts and scan info.
- /local/YYYYMMDD?page=1&per_page=100
                   Returns one page of stored items, sorted by ID:
                   {"total": N, "items": [...]}
- /local/YYYYMMDD/csv  Downloads every item in the folder as one CSV file.
- POST /local/YYYYMMDD/meta  Saves scan info (endpoint, progress) to _meta.json.
- /config          GET returns settings from config.json; POST updates them.

Run:   python3 server.py
Open:  http://localhost:8000
"""

import csv
import datetime
import http.server
import io
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

PORT = 8000
APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, "data")
CONFIG_PATH = os.path.join(APP_DIR, "config.json")

# Settings and their defaults. Saved to config.json (edited via admin.html).
# name: (default, type, min, max)
CONFIG_FIELDS = {
    "endpoint":         ("", str, None, None),    # Omeka S API URL
    "scan_chunk_size":  (25, int, 1, 1000),       # items per request in Scan all
    "scan_delay_ms":    (1000, int, 0, 60000),    # wait between Scan all requests
    "scan_pause_every": (1000, int, 1, 1000000),  # Scan all waits for Continue every N items
    "page_size":        (100, int, 1, 1000),      # items per page in stored folders
}

# Omeka response headers the app needs (total count, pagination links).
PASS_HEADERS = ("Omeka-S-Total-Results", "Link")

# Matches .../items and .../items/<id>
ITEMS_PATH = re.compile(r"/items(/\d+)?/?$")
FOLDER_NAME = re.compile(r"^\d{8}$")


def load_config():
    config = {name: spec[0] for name, spec in CONFIG_FIELDS.items()}
    if os.path.isfile(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            saved = json.load(f)
        config.update({k: v for k, v in saved.items() if k in CONFIG_FIELDS})
    return config


def update_config(changes):
    """Validate and save changed settings. Returns (config, error)."""
    config = load_config()
    for name, value in changes.items():
        if name not in CONFIG_FIELDS:
            return None, f"Unknown setting: {name}"
        _, kind, low, high = CONFIG_FIELDS[name]
        if kind is int:
            try:
                value = int(value)
            except (TypeError, ValueError):
                return None, f"{name} must be a whole number"
            if not low <= value <= high:
                return None, f"{name} must be between {low} and {high}"
        else:
            value = str(value).strip()
            if name == "endpoint" and value and not value.startswith(("http://", "https://")):
                return None, "endpoint must start with http:// or https://"
        config[name] = value
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    return config, None


def today():
    return datetime.date.today().strftime("%Y%m%d")


def is_item_file(name):
    return name.endswith(".json") and not name.startswith("_")


def read_meta(name):
    path = os.path.join(DATA_DIR, name, "_meta.json")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_items(body, folder_name):
    """Save each item in an Omeka items response to data/<folder_name>/<id>.json."""
    try:
        data = json.loads(body)
    except ValueError:
        return
    items = data if isinstance(data, list) else [data]
    folder = os.path.join(DATA_DIR, folder_name)
    os.makedirs(folder, exist_ok=True)
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("o:id"), int):
            with open(os.path.join(folder, f"{item['o:id']}.json"), "w", encoding="utf-8") as f:
                json.dump(item, f, ensure_ascii=False, indent=2)


def list_folders():
    if not os.path.isdir(DATA_DIR):
        return []
    folders = []
    for name in sorted(os.listdir(DATA_DIR), reverse=True):  # newest first
        path = os.path.join(DATA_DIR, name)
        if FOLDER_NAME.match(name) and os.path.isdir(path):
            count = sum(1 for f in os.listdir(path) if is_item_file(f))
            folders.append({"folder": name, "count": count, "meta": read_meta(name)})
    return folders


def item_files(name):
    """Item file names in a folder, sorted by Omeka ID."""
    path = os.path.join(DATA_DIR, name)
    files = [f for f in os.listdir(path) if is_item_file(f)]
    return sorted(files, key=lambda f: int(f[:-5]) if f[:-5].isdigit() else 0)


def read_item(name, file_name):
    with open(os.path.join(DATA_DIR, name, file_name), encoding="utf-8") as f:
        return json.load(f)


def load_page(name, page, per_page):
    files = item_files(name)
    start = (page - 1) * per_page
    items = [read_item(name, f) for f in files[start:start + per_page]]
    return {"total": len(files), "items": items}


PROPERTY_KEY = re.compile(r"^[a-z]+:[A-Za-z]+$")


def item_properties(item):
    """{term: "value; value"} for an item's metadata (same rules as app.js)."""
    props = {}
    for key, values in item.items():
        if not PROPERTY_KEY.match(key) or key.startswith("o:") or not isinstance(values, list):
            continue
        texts = []
        for v in values:
            if isinstance(v, dict):
                text = next((v[k] for k in ("@value", "o:label", "@id", "display_title") if v.get(k) not in (None, "")), "")
                if text != "":
                    texts.append(str(text))
        if texts:
            props[key] = "; ".join(texts)
    return props


def folder_csv(name):
    """CSV of every item in the folder: o:id, o:title, then all property terms."""
    terms, seen, rows = [], set(), []
    for f in item_files(name):
        item = read_item(name, f)
        props = item_properties(item)
        for term in props:
            if term not in seen:
                seen.add(term)
                terms.append(term)
        rows.append((item.get("o:id"), item.get("o:title"), props))
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["o:id", "o:title", *terms])
    for item_id, title, props in rows:
        writer.writerow([item_id, title or "", *(props.get(t, "") for t in terms)])
    return out.getvalue()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_csv(self, text, filename):
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/proxy":
            return self.proxy(parsed)
        if parsed.path == "/config":
            return self.send_json(load_config())
        if parsed.path == "/local":
            return self.send_json(list_folders())
        match = re.match(r"^/local/(\d{8})(/csv)?$", parsed.path)
        if match:
            name, want_csv = match.groups()
            if not os.path.isdir(os.path.join(DATA_DIR, name)):
                return self.send_error(404, "No such folder")
            if want_csv:
                return self.send_csv(folder_csv(name), f"omeka-items-{name}.csv")
            params = urllib.parse.parse_qs(parsed.query)
            page = max(1, int(params.get("page", ["1"])[0]))
            per_page = min(1000, max(1, int(params.get("per_page", ["100"])[0])))
            return self.send_json(load_page(name, page, per_page))
        return super().do_GET()  # serve index.html, app.js, etc.

    def do_POST(self):
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except ValueError:
            return self.send_error(400, "Invalid JSON")
        if self.path == "/config":
            if not isinstance(payload, dict):
                return self.send_json({"error": "Expected a JSON object"}, 400)
            config, error = update_config(payload)
            return self.send_json({"error": error} if error else config, 400 if error else 200)
        match = re.match(r"^/local/(\d{8})/meta$", self.path)
        if not match:
            return self.send_error(404)
        meta = payload
        folder = os.path.join(DATA_DIR, match.group(1))
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "_meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        self.send_json({"ok": True})

    def proxy(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        target = params.get("url", [""])[0]
        folder = params.get("folder", [today()])[0]
        if not target.startswith(("http://", "https://")):
            return self.send_error(400, "Missing or invalid ?url=")
        if not FOLDER_NAME.match(folder):
            return self.send_error(400, "Invalid folder")

        try:
            req = urllib.request.Request(target, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as res:
                status, body, headers = res.status, res.read(), res.headers
        except urllib.error.HTTPError as err:
            status, body, headers = err.code, err.read(), err.headers
        except Exception as err:
            return self.send_error(502, f"Could not reach {target}: {err}")

        if status == 200 and ITEMS_PATH.search(urllib.parse.urlparse(target).path):
            save_items(body, folder)

        self.send_response(status)
        self.send_header("Content-Type", headers.get("Content-Type", "application/json"))
        for name in PASS_HEADERS:
            if headers.get(name):
                self.send_header(name, headers.get(name))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    # Bind to localhost only, so the proxy isn't reachable from other machines.
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Omeka Library running at http://localhost:{PORT}")
    print(f"Saving fetched items to {DATA_DIR}")
    server.serve_forever()
