FROM debian:bookworm-slim

# Minimal OpenSSH server used as a jump host (bastion) in desktop-protocol
# live tests: the RDP/VNC client authenticates here, then a direct-tcpip
# channel is opened to the real target (another fixture container, or the
# host via host.docker.internal).
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-server tini procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd

RUN useradd -m -s /bin/bash jumpuser \
    && echo 'jumpuser:jumppass' | chpasswd \
    && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config \
    && echo 'PermitTunnel yes' >> /etc/ssh/sshd_config \
    && echo 'AllowTcpForwarding yes' >> /etc/ssh/sshd_config

# Host keys (generated at build so the fingerprint is stable per image).
RUN ssh-keygen -A

EXPOSE 22
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/sbin/sshd", "-D", "-e"]
