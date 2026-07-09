#!/usr/bin/env bash
# Launch Beta Build V7 of Vibe Blender — "the banded AO build".
# Frozen BEFORE the GTAO rewrite: this build has the v1 scattered-sample SSAO
# with its banding artifacts, kept for the video's before/after comparison
# (see research/ao-v1-artifacts.png and research/AO-RESEARCH.md in the repo).
# Turn AO on via the viewport-header shading dropdown ▸ Ambient Occlusion.
cd "$(dirname "$0")"
PORT=5370
if ! curl -s -o /dev/null "http://localhost:$PORT"; then
  (python3 -m http.server "$PORT" >/dev/null 2>&1 &)
  sleep 1
fi
google-chrome-stable --app="http://localhost:$PORT/" &
echo "Beta Build V7 (banded AO) running at http://localhost:$PORT/"
