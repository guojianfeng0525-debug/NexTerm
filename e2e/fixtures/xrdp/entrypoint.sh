#!/bin/sh
set -x

# Runtime dirs (fresh container may lack them).
mkdir -p /run/xrdp /run/xrdp/sockdir /var/run/xrdp
chown -R xrdp:xrdp /run/xrdp 2>/dev/null || true

# Stale pid files from image build would block startup.
rm -f /run/xrdp/xrdp-sesman.pid /run/xrdp/xrdp.pid /var/run/xrdp-sesman.pid /var/run/xrdp.pid

xrdp-sesman
exec xrdp --nodaemon
