#!/usr/bin/env bash
# serve.sh — Start a local HTTP server for the HearingAid web interface
# Usage: bash serve.sh [port]

PORT=${1:-8080}
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================"
echo "  HearingAid Web Interface"
echo "  Serving: $DIR"
echo "  URL:     http://localhost:$PORT"
echo "  Stop:    Ctrl+C"
echo "============================================"
echo ""

# Open the browser after a short delay (gives the server time to start)
(sleep 1 && open "http://localhost:$PORT") &

# Try Python 3 first, then Node.js
if command -v python3 &>/dev/null; then
    python3 -m http.server "$PORT" --directory "$DIR"
elif command -v node &>/dev/null; then
    npx --yes serve "$DIR" --listen "$PORT"
else
    echo "ERROR: Neither python3 nor node is installed."
    echo "Please install one of them and try again."
    exit 1
fi
