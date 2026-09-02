FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        xrdp xorgxrdp openbox xterm xauth dbus-x11 fonts-dejavu-core \
        openssl procps tini \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash rdpuser \
    && echo 'rdpuser:rdppass' | chpasswd

# Session: openbox desktop with one xterm window (visible, high-contrast content).
RUN printf '#!/bin/sh\n(sleep 2 && xterm -geometry 100x32+120+80 -title "NexTerm-RDP-Verify" -fa "DejaVu Sans Mono" -fs 12) &\nexec openbox-session\n' \
        > /home/rdpuser/.xsession \
    && chmod 755 /home/rdpuser/.xsession \
    && chown -R rdpuser:rdpuser /home/rdpuser

# Self-signed TLS certificate (xrdp package normally generates one; be sure).
RUN test -f /etc/xrdp/cert.pem || openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout /etc/xrdp/key.pem -out /etc/xrdp/cert.pem -days 3650 -subj "/CN=nexterm-xrdp-test"

# NLA (hybrid) + TLS: the default security_protocol=negotiate already covers it.

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3389
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
