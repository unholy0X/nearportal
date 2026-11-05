#!/usr/bin/env bash
# Sourced by deployment/backup commands; .env.deploy contains local paths and project settings.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ -f .env.deploy ]]; then
  set -a
  source .env.deploy
  set +a
fi
export NEARPORTAL_PROJECT="${NEARPORTAL_PROJECT:-nearportal-v2}"
case "$NEARPORTAL_PROJECT" in nearportal-*) ;; *) echo 'Use a dedicated nearportal Compose project' >&2; exit 1;; esac
: "${NEARPORTAL_ENV_FILE:?Set the private environment file path}"
: "${NEARPORTAL_KEYS_PATH:?Set the directory containing only the three worker keys}"
[[ -r "$NEARPORTAL_ENV_FILE" && -d "$NEARPORTAL_KEYS_PATH" ]] || { echo 'Private environment or worker key directory is missing' >&2; exit 1; }
export NEARPORTAL_IMAGE="nearportal:$(git rev-parse HEAD)"
compose=(docker compose --project-name "$NEARPORTAL_PROJECT" -f deploy/compose.vps.yaml)
