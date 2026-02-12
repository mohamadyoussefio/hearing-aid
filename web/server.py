#!/usr/bin/env python3
"""
server.py — Local HTTP server for the HearingAid web interface.

Usage:
    python3 server.py [port]

Defaults to port 8080. Opens the browser automatically.
Serves the directory containing this script.
"""

import http.server
import os
import socketserver
import sys
import threading
import time
import webbrowser

# ── Configuration ────────────────────────────────────────────────────────────

DEFAULT_PORT = 8080
HOST = "localhost"

# ── Resolve the web directory (same folder as this script) ───────────────────

WEB_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Custom request handler ────────────────────────────────────────────────────


class HearingAidHandler(http.server.SimpleHTTPRequestHandler):
    """
    Serves files from WEB_DIR and adds headers that allow the
    Web Serial API to work (requires a secure context — localhost qualifies).
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    # Add COOP / COEP headers so SharedArrayBuffer (and Web Serial) work
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    # Silence the default per-request console spam
    def log_message(self, fmt, *args):
        # Only log errors (4xx / 5xx)
        code = args[1] if len(args) > 1 else "???"
        try:
            if int(code) >= 400:
                super().log_message(fmt, *args)
        except (ValueError, TypeError):
            pass


# ── Server bootstrap ──────────────────────────────────────────────────────────


def run(port: int = DEFAULT_PORT) -> None:
    # Allow the socket to be reused quickly after a restart
    socketserver.TCPServer.allow_reuse_address = True

    with socketserver.TCPServer((HOST, port), HearingAidHandler) as httpd:
        url = f"http://{HOST}:{port}"

        print()
        print("╔══════════════════════════════════════════════╗")
        print("║       HearingAid — Web Interface Server      ║")
        print("╠══════════════════════════════════════════════╣")
        print(f"║  URL  :  {url:<36}║")
        print(f"║  Dir  :  {WEB_DIR[:36]:<36}║")
        print("║  Stop :  Ctrl+C                              ║")
        print("╚══════════════════════════════════════════════╝")
        print()
        print("  ✓  Web Serial API requires Chrome or Edge 89+")
        print("  ✓  Connect your Teensy via USB before clicking Connect")
        print()

        # Open the browser after a short delay so the server is ready
        def _open_browser():
            time.sleep(0.8)
            webbrowser.open(url)

        t = threading.Thread(target=_open_browser, daemon=True)
        t.start()

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\n  Server stopped. Goodbye.\n")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
            if not (1024 <= port <= 65535):
                raise ValueError
        except ValueError:
            print(f"ERROR: invalid port '{sys.argv[1]}'. Must be 1024–65535.")
            sys.exit(1)

    run(port)
