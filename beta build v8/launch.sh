#!/usr/bin/env bash
# Launch Beta Build V8 of Vibe Blender — "the second AO fix attempt".
# GTAO-lite + Interleaved Gradient Noise + ray-relative coplanarity gate: the
# state after TWO Opus fix rounds that both passed rig verification while Ray
# still saw artifacts on his real GPU. Frozen for the video's AO saga
# (V7 = the original banded SSAO on port 5370; this = attempt 2).
cd "$(dirname "$0")"
PORT=5380
if ! curl -s -o /dev/null "http://localhost:$PORT"; then
  (python3 -m http.server "$PORT" >/dev/null 2>&1 &)
  sleep 1
fi
google-chrome-stable --app="http://localhost:$PORT/" &
echo "Beta Build V8 (AO attempt 2) running at http://localhost:$PORT/"
