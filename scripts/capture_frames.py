"""Receive files from the browser and write them to disk: the hero video and its poster, and
canvas frames for stills.

    python scripts/capture_frames.py --out runs/hero

The cinema tool (web/src/tools/cinema.ts) POSTs each file to /save/<name>. Listens on 127.0.0.1
only. Requests are "simple" (text/plain), so the browser sends them without a CORS preflight,
which local-network protections may block.
"""

from __future__ import annotations

import argparse
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def serve(out: Path, port: int) -> None:
    out.mkdir(parents=True, exist_ok=True)

    class Handler(BaseHTTPRequestHandler):
        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_POST(self) -> None:
            m = re.fullmatch(r"/save/([A-Za-z0-9_.-]{1,80})", self.path)
            if not m or not m.group(1).endswith((".png", ".jpg", ".mp4")):
                self.send_response(400)
                self._cors()
                self.end_headers()
                return
            n = int(self.headers.get("Content-Length", "0"))
            (out / m.group(1)).write_bytes(self.rfile.read(n))
            self.send_response(200)
            self._cors()
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *args: object) -> None:
            pass

    print(f"saving frames to {out} on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="runs/hero")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    serve(Path(a.out), a.port)
