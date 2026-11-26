#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
    printf 'Usage: bash pentagi.sh DEPLOYMENT_DIRECTORY COMPOSE_COMMAND [ARGS...]\n' >&2
    exit 2
fi

deployment=$(realpath -- "$1")
shift
fork_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
token_file=${CODEX_BRIDGE_TOKEN_FILE:-"$fork_root/.state/codex-bridge/token"}

if [[ ! -f "$deployment/.env" || ! -f "$deployment/docker-compose.yml" ]]; then
    printf 'The deployment directory must contain .env and docker-compose.yml.\n' >&2
    exit 2
fi
if [[ -z "${CODEX_BRIDGE_KEY:-}" ]]; then
    if [[ ! -f "$token_file" ]]; then
        printf 'Start the bridge first, or set CODEX_BRIDGE_KEY.\n' >&2
        exit 2
    fi
    CODEX_BRIDGE_KEY=$(tr -d '\r\n' < "$token_file")
fi
export CODEX_BRIDGE_KEY
export CODEX_BRIDGE_PROVIDER_CONFIG="$fork_root/examples/configs/codex-subscription.provider.yml"

exec docker compose --project-directory "$deployment" --env-file "$deployment/.env" \
    -f "$deployment/docker-compose.yml" -f "$fork_root/docker-compose.codex.yml" "$@"
