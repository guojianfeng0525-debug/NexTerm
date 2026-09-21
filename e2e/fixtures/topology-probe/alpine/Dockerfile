FROM alpine:3.20

# Topology-probe fixture: BusyBox environment — busybox `find` lacks
# `-printf`, so the probe's fdmap section must fall back to `ls -l
# /proc/[0-9]*/fd`. Serves as the "db" side: socat listens on 6379 and holds
# each accepted connection open for 10 minutes (SYSTEM:"sleep 600").
RUN apk add --no-cache openssh socat iproute2 tini \
    && mkdir -p /var/run/sshd \
    && echo 'root:probepass' | chpasswd \
    && printf '\nPermitRootLogin yes\nPasswordAuthentication yes\n' >> /etc/ssh/sshd_config \
    && ssh-keygen -A

EXPOSE 22
ENTRYPOINT ["/sbin/tini", "--"]
# socat UDP-RECVFROM on 5353 exercises the UDP listener path: the probe must
# report it as a real (bound) UDP port while UDP client sockets — whose local
# port is ephemeral — must never surface.
CMD ["sh", "-c", "socat TCP-LISTEN:6379,fork,reuseaddr SYSTEM:'sleep 600' & socat UDP-RECVFROM:5353,fork SYSTEM:'cat >/dev/null' & exec /usr/sbin/sshd -D -e"]
