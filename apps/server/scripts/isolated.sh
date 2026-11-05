#!/bin/sh
# Runs a command without the caller's environment: no .env file (ENV_FILE=/dev/null), no GitHub
# CLI token (GITHUB_USE_CLI=0), an empty NEAR credentials directory and a fresh data directory,
# all under a temporary directory removed afterwards. HOME is that directory too, unless
# ISOLATED_HOME is set (the browser demo needs the real one for the Playwright browser cache).
# Callers preload test/loopback-only.mjs, which refuses every non-loopback fetch.
set -eu
root=$(mktemp -d "${TMPDIR:-/tmp}/nearportal-isolated.XXXXXX")
trap 'rm -rf "$root"' EXIT
mkdir "$root/home" "$root/data" "$root/near-credentials"
status=0
env -i PATH="$PATH" HOME="${ISOLATED_HOME:-$root/home}" ENV_FILE=/dev/null GITHUB_USE_CLI=0 \
  DATA_DIR="$root/data" NEAR_CREDENTIALS_DIR="$root/near-credentials" "$@" || status=$?
exit "$status"
