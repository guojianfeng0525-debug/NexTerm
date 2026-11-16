FROM debian:bookworm-slim

# Real-OpenSSH fixture for keepalive and shell-integration live tests.
#
# Three users cover the shell matrix (login shells drive the OSC 7 cwd
# reporting that the file browser follows):
#   - testuser  /bin/bash
#   - zshuser   /usr/bin/zsh
#   - fishuser  /usr/bin/fish
#
# The sshd default config here has NO ClientAlive settings; aggressive
# idle-kill variants are produced at runtime by passing -o options on the
# command line (see the keepalive_live.rs test header).
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-server zsh fish socat procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /srv/release\ files/子目录 \
    && printf 'report 1.txt content' > '/srv/release files/子目录/report 1.txt' \
    && useradd -m -s /bin/bash testuser \
    && echo 'testuser:testpass123' | chpasswd \
    && useradd -m -s /usr/bin/zsh zshuser \
    && echo 'zshuser:zshpass123' | chpasswd \
    && useradd -m -s /usr/bin/fish fishuser \
    && echo 'fishuser:fishpass123' | chpasswd \
    && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config \
    && echo 'UsePAM no' >> /etc/ssh/sshd_config

# Host keys generated at build so the fingerprint is stable per image.
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
