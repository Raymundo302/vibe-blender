#!/usr/bin/env bash
# Launch Beta Build V9 of Vibe Blender — "the NURBS build".
# One day, one architect + 11 verified Opus workers: NURBS surfaces as a first-
# class object kind (exact rational primitives, control-net edit mode, degree/
# span/knot ops, spans+adaptive tessellation), curvature combs, G0-G3 curve
# alignment, isoparms, curves-on-surface, projection, trimmed tessellation
# with edge snapping, and IGES 5.3 import/export. Frozen 2026-07-16.
cd "$(dirname "$0")"
PORT=5390
if ! curl -s -o /dev/null "http://localhost:$PORT"; then
  (python3 -m http.server "$PORT" >/dev/null 2>&1 &)
  sleep 1
fi
google-chrome-stable --app="http://localhost:$PORT/" &
echo "Beta Build V9 (the NURBS build) running at http://localhost:$PORT/"
