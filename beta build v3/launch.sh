#!/usr/bin/env bash
# Launch Beta Build V3 of Vibe Blender for filming/screenshots.
# (Serves over http because ES modules don't load from file:// URLs.)
cd "$(dirname "$0")"
PORT=5330
if ! curl -s -o /dev/null "http://localhost:$PORT"; then
  (python3 -m http.server "$PORT" >/dev/null 2>&1 &)
  sleep 1
fi
firefox "http://localhost:$PORT/" &
echo "Beta Build V3 running at http://localhost:$PORT/"
