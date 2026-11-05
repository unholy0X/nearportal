#!/usr/bin/env bash
# Run on the VPS after pulling the reviewed source. Changes only this Compose project.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deploy-config.sh"
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || { echo 'Commit or review the working-tree changes before deployment' >&2; exit 1; }
SOURCE_COMMIT="$(git rev-parse HEAD)"
"${compose[@]}" config --quiet
"${compose[@]}" build nearportal
# Never down, prune, remove volumes or operate on a different Compose project.
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 nearportal
printf 'Healthy NearPortal source %s on loopback port %s\n' "$SOURCE_COMMIT" "${NEARPORTAL_PORT:-3211}"
