#!/usr/bin/env bash
# =============================================================================
# scripts/ssh-fixture.sh — Docker OpenSSH fixture for NexTerm SSH integration
# tests.
#
# Purpose
#   Starts a disposable OpenSSH server container used by the ignored Rust
#   integration tests under src-tauri/src/ssh/tests.rs:
#     - docker_pty_survives_parallel_sftp_upload
#         connects to 127.0.0.1:22222 as user "test" / "testpass",
#         uploads to /home/test/nexterm-transfer-test.bin
#     - docker_ssh_reports_cwd_and_lists_sftp_directories
#         connects to $NEXTERM_TEST_SSH_HOST (default "nexterm-test-ssh") as
#         user "testuser" / "testpass" — needs a user-defined docker network
#         with that container name; the port-22222 fixture below only covers
#         the first test.
#
# Manual usage (local)
#   scripts/ssh-fixture.sh up       # build image + start container (port 22222)
#   scripts/ssh-fixture.sh status   # show container state
#   scripts/ssh-fixture.sh logs     # follow sshd logs
#   scripts/ssh-fixture.sh down     # stop & remove container (local image kept)
#   scripts/ssh-fixture.sh clean    # down + delete the local fixture image
#
#   Then run the regression tests:
#     cd src-tauri && cargo test docker_pty_survives_parallel_sftp_upload -- --ignored --nocapture
#
#   Requires a working `docker` CLI; the image only depends on the alpine base
#   image being pullable. No host OpenSSH server is needed.
#
# Environment overrides
#   NEXTERM_SSH_FIXTURE_PORT      host port mapped to sshd (default 22222)
#   NEXTERM_SSH_FIXTURE_USER      SSH user created in the fixture (default test)
#   NEXTERM_SSH_FIXTURE_PASSWORD  password for that user (default testpass)
#   NEXTERM_SSH_FIXTURE_CONTAINER container name (default nexterm-ssh-fixture)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_TAG="nexterm-ssh-fixture:local"

# -- overridable settings ------------------------------------------------------
HOST_PORT="${NEXTERM_SSH_FIXTURE_PORT:-22222}"
SSH_USER="${NEXTERM_SSH_FIXTURE_USER:-test}"
SSH_PASSWORD="${NEXTERM_SSH_FIXTURE_PASSWORD:-testpass}"
CONTAINER_NAME="${NEXTERM_SSH_FIXTURE_CONTAINER:-nexterm-ssh-fixture}"

usage() {
  sed -n '2,60p' "$SCRIPT_DIR/ssh-fixture.sh" | sed 's/^# \{0,1\}//' | sed -n '/^scripts\/ssh-fixture.sh/,$p'
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "error: 'docker' CLI not found. Install Docker (e.g. Docker Desktop on macOS) first." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "error: docker daemon is not running / not accessible." >&2
    exit 1
  fi
}

# Build the fixture image from an inline Dockerfile so the test server is
# deterministic: user with a real home dir (/home/<user>), password auth,
# SFTP subsystem and sshd on port 22222. This matches the expectations in
# src-tauri/src/ssh/tests.rs (user "test", password "testpass", port 22222).
build_image() {
  if docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    echo "fixture: image $IMAGE_TAG already present"
    return 0
  fi
  echo "fixture: building $IMAGE_TAG ..."
  docker build \
    --build-arg "SSH_USER=$SSH_USER" \
    --build-arg "SSH_PASSWORD=$SSH_PASSWORD" \
    --tag "$IMAGE_TAG" - <<'DOCKERFILE'
FROM alpine:3.20
ARG SSH_USER=test
ARG SSH_PASSWORD=testpass
# "testuser" is created unconditionally for the hostname-based test
# (docker_ssh_reports_cwd_and_lists_sftp_directories); "test" is the default
# user used by docker_pty_survives_parallel_sftp_upload.
RUN apk add --no-cache openssh \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh "${SSH_USER}" \
 && echo "${SSH_USER}:${SSH_PASSWORD}" | chpasswd \
 && adduser -D -s /bin/sh testuser \
 && echo "testuser:${SSH_PASSWORD}" | chpasswd \
 && mkdir -p /run/sshd \
 && sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
 && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config \
 && echo 'AllowTcpForwarding yes' >> /etc/ssh/sshd_config \
 && echo 'Subsystem sftp internal-sftp' >> /etc/ssh/sshd_config
EXPOSE 22222
CMD ["/usr/sbin/sshd", "-D", "-e", "-p", "22222"]
DOCKERFILE
}

up() {
  require_docker
  build_image

  if docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -q .; then
    echo "fixture: container '$CONTAINER_NAME' is already running"
    echo "fixture: SSH reachable at 127.0.0.1:${HOST_PORT} (user '$SSH_USER' / password '$SSH_PASSWORD')"
    return 0
  fi

  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker run -d \
    --name "$CONTAINER_NAME" \
    --hostname nexterm-test-ssh \
    -p "${HOST_PORT}:22222" \
    --restart unless-stopped \
    "$IMAGE_TAG" >/dev/null

  echo "fixture: container '$CONTAINER_NAME' started"
  echo "fixture: SSH reachable at 127.0.0.1:${HOST_PORT} (user '$SSH_USER' / password '$SSH_PASSWORD')"
  echo "fixture: user 'testuser' / '$SSH_PASSWORD' also exists (for the hostname-based test)"
}

down() {
  require_docker
  if docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "fixture: container '$CONTAINER_NAME' removed"
  else
    echo "fixture: no running container '$CONTAINER_NAME'"
  fi
}

clean() {
  down
  if docker image rm "$IMAGE_TAG" >/dev/null 2>&1; then
    echo "fixture: image $IMAGE_TAG removed"
  fi
}

case "${1:-help}" in
  up|start)     up ;;
  down|stop)    down ;;
  clean)        clean ;;
  status)       require_docker; docker ps --filter "name=^/${CONTAINER_NAME}$" ;;
  logs)         require_docker; exec docker logs -f "$CONTAINER_NAME" ;;
  help|-h|--help) usage ;;
  *)            echo "unknown action: $1" >&2; usage; exit 2 ;;
esac
