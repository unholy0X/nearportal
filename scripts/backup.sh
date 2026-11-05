#!/usr/bin/env bash
# Snapshot only this project's database, then copy the private backup out of its volume.
set -euo pipefail
umask 077
source "$(dirname "${BASH_SOURCE[0]}")/deploy-config.sh"
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
out="${NEARPORTAL_BACKUP_DIR:-$PWD/backups}/$stamp"
mkdir -p "$out"
inside="/var/lib/nearportal/backups/$stamp"
"${compose[@]}" exec -T nearportal node --import tsx scripts/backup.ts "$inside"
"${compose[@]}" cp "nearportal:$inside/." "$out/"
chmod -R go-rwx "$out"
printf 'Private backup copied to %s; preserve the encryption key separately.\n' "$out"
