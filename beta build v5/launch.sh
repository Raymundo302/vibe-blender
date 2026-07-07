#!/usr/bin/env bash
# Launch Beta Build V5 of Vibe Blender for filming/screenshots.
# Opens straight into the donut scene (drop the ?scene= part for a clean boot).
cd "$(dirname "$0")"
PORT=5350
if ! curl -s -o /dev/null "http://localhost:$PORT"; then
  (python3 -m http.server "$PORT" >/dev/null 2>&1 &)
  sleep 1
fi
firefox "http://localhost:$PORT/?scene=donut-uv.vibe.json" &
echo "Beta Build V5 running at http://localhost:$PORT/ (donut: ?scene=donut-uv.vibe.json)"
