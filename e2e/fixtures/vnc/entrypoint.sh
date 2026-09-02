#!/bin/sh
set -x

# Xvfb display :99 at the fixed geometry the live test asserts against.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!
sleep 2

DISPLAY=:99 openbox-session &
OPENBOX_PID=$!
sleep 1

# One xterm window: deterministic, high-contrast content for verification.
DISPLAY=:99 xterm -geometry 100x32+120+80 \
        -title "NexTerm-VNC-Verify" \
        -fa "DejaVu Sans Mono" -fs 12 &
sleep 1

# x11vnc with VNC-Auth (password: vncpass) — the auth path the client's
# DES challenge-response exercises in live tests.
exec x11vnc -display :99 \
        -forever -shared -noxdamage \
        -rfbauth /etc/x11vnc-passwd \
        -rfbport 5900
