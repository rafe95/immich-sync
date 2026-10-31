#!/bin/sh
# Runs a compose file with the container runtime of your choice.
#
#   sh scripts/compose.sh dev  up -d      development database (docker-compose.dev.yml)
#   sh scripts/compose.sh prod up -d --build   the full app (docker-compose.yml)
#
# Runtime: CONTAINER_RUNTIME=docker | podman | auto (default).
# Read from the environment first, then from .env. "auto" uses docker if installed, otherwise podman.
cd "$(dirname "$0")/.." || exit 1

stack="$1"
[ $# -gt 0 ] && shift
case "$stack" in
  dev) file="docker-compose.dev.yml" ;;
  prod) file="docker-compose.yml" ;;
  *) echo "Usage: sh scripts/compose.sh dev|prod <compose arguments>" >&2; exit 2 ;;
esac

runtime="${CONTAINER_RUNTIME:-}"
if [ -z "$runtime" ] && [ -f .env ]; then
  runtime=$(sed -n 's/^CONTAINER_RUNTIME=//p' .env | tail -n 1 | tr -d '"'"'"' \r')
fi
runtime="${runtime:-auto}"

if [ "$runtime" = "auto" ]; then
  if command -v docker >/dev/null 2>&1; then runtime=docker
  elif command -v podman >/dev/null 2>&1; then runtime=podman
  else
    echo "Neither docker nor podman was found. Install one, or point DATABASE_URL at your own PostgreSQL 17." >&2
    exit 1
  fi
fi

case "$runtime" in
  docker | podman) ;;
  *) echo "CONTAINER_RUNTIME must be docker, podman or auto (got: $runtime)." >&2; exit 2 ;;
esac
if ! command -v "$runtime" >/dev/null 2>&1; then
  echo "CONTAINER_RUNTIME=$runtime, but '$runtime' is not installed." >&2
  exit 1
fi

echo "[$runtime compose] $stack: $*" >&2
exec "$runtime" compose -f "$file" "$@"
