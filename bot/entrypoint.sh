#!/bin/bash
# PID-1 entrypoint (ticket 5.2, D67 — Vexa's fix). A bash script that is PID
# 1 neither dies on SIGTERM by default nor forwards it to children; without
# this trap, `docker stop` (and the orchestrator's graceful-stop grace
# period) escalates straight to SIGKILL mid-capture and the graceful leave
# in lifecycle.ts never runs. Everything below just brings up the virtual
# display/audio sink the bot needs and then gets out of the way.
set -uo pipefail

Xvfb :99 -screen 0 1280x800x24 >/var/log/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY=:99

# One null sink, "meet_out" — Chromium's audio output lands here (no real
# device exists in the container); ffmpeg reads meet_out.monitor.
pulseaudio --start --exit-idle-time=-1 --disallow-exit --log-target=stderr
pactl load-module module-null-sink sink_name=meet_out sink_properties=device.description=meet_out
pactl set-default-sink meet_out

# Never started in prod compose — 5.6's debugging pass wants to watch the
# bot live over VNC.
if [ "${BOT_DEBUG_VNC:-0}" = "1" ]; then
  x11vnc -display :99 -forever -shared -rfbport 5900 -bg -nopw -q
  websockify --web=/usr/share/novnc 6080 localhost:5900 >/var/log/websockify.log 2>&1 &
fi

node dist/main.js &
BOT_PID=$!

term_handler() {
  echo "entrypoint: forwarding signal to bot (pid $BOT_PID)"
  kill -TERM "$BOT_PID" 2>/dev/null || true
}
trap term_handler SIGTERM SIGINT

wait "$BOT_PID"
EXIT_CODE=$?
kill "$XVFB_PID" 2>/dev/null || true
exit "$EXIT_CODE"
