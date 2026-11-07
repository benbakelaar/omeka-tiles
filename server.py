"""Local dev server for Omeka Library.

- Serves the app's files.
- /proxy?url=...   Forwards API requests to Omeka, so the browser never makes
                   a cross-origin request (no CORS needed). Every item it
                   fetches is also saved to data/YYYYMMDD/<o:id>.json.
- /local           Lists the dated folders in data/ with item counts.
- /local/YYYYMMDD  Returns all items stored in that folder, sorted by ID.

Run:   python3 server.py
Open:  http://localhost:8000
"""

import datetime
import http.server
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

PORT = 8000
APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, "data")

# Omeka response headers the app needs (total count, pagination links).
PASS_HEADERS = ("Omeka-S-Total-Results", "Link")

# Matches .../items and .../items/<id>
ITEMS_PATH = re.compile(r"/items(/\d+)?/?$")
FOLDER_NAME = re.compile(r"^\d{8}$")


def save_items(body):
    """Save each item in an Omeka items response to data/YYYYMMDD/<id>.json."""
    try:
        data = json.loads(body)
    except ValueError:
        return
    items = data if isinstance(data, list) else [data]
    folder = os.path.join(DATA_DIR, datetime.date.today().strftime("%Y%m%d"))
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
            count = sum(1 for f in os.listdir(path) if f.endswith(".json"))
            folders.append({"folder": name, "count": count})
    return folders


def load_folder(name):
    path = os.path.join(DATA_DIR, name)
    files = [f for f in os.listdir(path) if f.endswith(".json")]
    items = []
    for f in sorted(files, key=lambda f: int(f[:-5]) if f[:-5].isdigit() else 0):
        with open(os.path.join(path, f), encoding="utf-8") as fh:
            items.append(json.load(fh))
    return items


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

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/proxy":
            return self.proxy(parsed)
        if parsed.path == "/local":
            return self.send_json(list_folders())
        if parsed.path.startswith("/local/"):
            name = parsed.path[len("/local/"):]
            if not FOLDER_NAME.match(name) or not os.path.isdir(os.path.join(DATA_DIR, name)):
                return self.send_error(404, "No such folder")
            return self.send_json(load_folder(name))
        return super().do_GET()  # serve index.html, app.js, etc.

    def proxy(self, parsed):
        target = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
        if not target.startswith(("http://", "https://")):
            return self.send_error(400, "Missing or invalid ?url=")

        try:
            req = urllib.request.Request(target, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as res:
                status, body, headers = res.status, res.read(), res.headers
        except urllib.error.HTTPError as err:
            status, body, headers = err.code, err.read(), err.headers
        except Exception as err:
            return self.send_error(502, f"Could not reach {target}: {err}")

        if status == 200 and ITEMS_PATH.search(urllib.parse.urlparse(target).path):
            save_items(body)

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
