FROM alpine:3.20

# VNC test server: Xvfb virtual display + x11vnc (VNC-Auth) + openbox + xterm.
# The xterm window titled "NexTerm-VNC-Verify" gives deterministic,
# high-contrast content for live-frame visual verification.
RUN apk add --no-cache \
        x11vnc xvfb-run xvfb openbox xterm font-dejavu tini

# VNC-Auth password store (password: vncpass).
RUN x11vnc -storepasswd vncpass /etc/x11vnc-passwd \
        && chmod 644 /etc/x11vnc-passwd

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5900
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
