FROM debian:bookworm-slim

# Topology-probe fixture: GNU userland environment (findutils with -printf,
# iproute2, procps). Serves as the "web" side of the live probe tests —
# socat listens on 8080 and bridges into the alpine fixture's 6379, so one
# process both LISTENS and initiates a connection (the p1 attribution case).
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-server tini procps iproute2 socat \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd

RUN echo 'root:probepass' | chpasswd \
    && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config \
    && echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config

RUN ssh-keygen -A

EXPOSE 22
ENTRYPOINT ["/usr/bin/tini", "--"]
# DB_ADDR is substituted by the test harness (docker run -e).
CMD ["sh", "-c", "socat TCP-LISTEN:8080,fork,reuseaddr TCP:$DB_ADDR:6379 & exec /usr/sbin/sshd -D -e"]
