"""Local dev server for Omeka Library.

Serves the app's files and forwards API requests to Omeka, so the browser
never makes a cross-origin request (no CORS needed).

Run:   python3 server.py
Open:  http://localhost:8000
"""

import http.server
import urllib.error
import urllib.parse
import urllib.request

PORT = 8000

# Omeka response headers the app needs (total count, pagination links).
PASS_HEADERS = ("Omeka-S-Total-Results", "Link")


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/proxy":
            return super().do_GET()  # serve index.html, app.js, etc.

        target = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
        if not target.startswith(("http://", "https://")):
            return self.send_error(400, "Missing or invalid ?url=")

        try:
            req = urllib.request.Request(target, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as res:
                status, body, headers = res.status, res.read(), res.headers
        except urllib.error.HTTPError as err:
            status, body, headers = err.code, err.read(), err.headers
        except Exception as err:
            return self.send_error(502, f"Could not reach {target}: {err}")

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
    server.serve_forever()
