#!/usr/bin/env bash
# Launch Beta Build V6 of Vibe Blender — "the animation build".
# Opens straight into the keyed donut fly-through (drop ?scene= for a clean boot).
cd "$(dirname "$0")"
PORT=5360
if ! curl -s -o /dev/null "http://localhost:$PORT"; then
  (python3 -m http.server "$PORT" >/dev/null 2>&1 &)
  sleep 1
fi
firefox "http://localhost:$PORT/?scene=donut-flythrough.vibe.json" &
echo "Beta Build V6 running at http://localhost:$PORT/ (fly-through: ?scene=donut-flythrough.vibe.json)"
