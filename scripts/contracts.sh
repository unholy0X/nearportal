#!/usr/bin/env bash
# Test, lint and build the NEAR contracts inside the pinned cargo-near image.
#
# Usage: scripts/contracts.sh <test|lint|build>
#
#   test   cargo test --workspace --locked (common, escrow, usdc-escrow)
#   lint   cargo fmt --all --check and cargo clippy --all-targets -D warnings
#   build  cargo near build non-reproducible-wasm --locked for each contract
#          (the container_build_command of the reproducible-build metadata)
#          and print the sha256 and NEAR code hash (base58 of the sha256)
#
# Requires Docker. The repository is mounted at /home/near/code, the path
# cargo-near's reproducible build uses. Output goes to contracts/target
# (gitignored). The cargo registry and the toolchain are cached in named
# volumes. Containers run as the current user.
set -euo pipefail

IMAGE="sourcescan/cargo-near:0.20.3-rust-1.86.0@sha256:a84b7c401a856b6bbbe1975f235b6a8011540a24dfbde248531cccb4b2fdbadf"
REGISTRY_VOLUME="nearportal-cargo-registry"
RUSTUP_VOLUME="nearportal-rustup"
CONTRACTS=(escrow usdc-escrow)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# A new registry volume is owned by root; make it writable for the user.
# A new rustup volume is populated from the image on first use.
prepare_volumes() {
  docker volume create "$REGISTRY_VOLUME" >/dev/null
  docker run --rm --platform linux/amd64 --user 0 \
    -v "$REGISTRY_VOLUME:/registry" "$IMAGE" chmod 0777 /registry
}

# run_in <dir relative to contracts/> <shell command>
run_in() {
  local dir="$1"
  shift
  docker run --rm --platform linux/amd64 \
    --user "$(id -u):$(id -g)" \
    -v "$ROOT:/home/near/code" \
    -w "/home/near/code/contracts/$dir" \
    -e CARGO_TARGET_DIR=/home/near/code/contracts/target \
    -v "$REGISTRY_VOLUME:/home/near/.cargo/registry" \
    -v "$RUSTUP_VOLUME:/home/near/.rustup" \
    "$IMAGE" bash -euo pipefail -c "$*"
}

# Prints "sha256 <hex>  code_hash <base58>  <file>" for one WASM.
hash_wasm() {
  local f="$1" hex b58
  hex=$(shasum -a 256 "$f" | cut -d' ' -f1)
  b58=$(perl -MMath::BigInt -e '
    my @a = split //, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    my $h = $ARGV[0]; my $n = Math::BigInt->from_hex($h); my $s = "";
    while ($n > 0) { my ($q, $r) = $n->copy->bdiv(58); $s = $a[$r] . $s; $n = $q; }
    (my $z = $h) =~ s/^((?:00)*).*/$1/; print "1" x (length($z) / 2), $s;
  ' "$hex")
  echo "sha256 $hex  code_hash $b58  ${f#"$ROOT/"}"
}

[ $# -eq 1 ] || usage 1
case "$1" in
  test | lint | build) prepare_volumes ;;
esac
case "$1" in
  test)
    run_in . cargo test --workspace --locked
    ;;
  lint)
    run_in . "cargo fmt --all --check && echo 'cargo fmt: ok' &&
      cargo clippy --all-targets --locked -- -D warnings && echo 'cargo clippy: ok'"
    ;;
  build)
    for c in "${CONTRACTS[@]}"; do
      echo "== $c: cargo near build non-reproducible-wasm --locked"
      run_in "$c" cargo near build non-reproducible-wasm --locked
    done
    for f in "$ROOT"/contracts/target/near/*/*.wasm; do hash_wasm "$f"; done
    ;;
  -h | --help | help) usage 0 ;;
  *) usage 1 ;;
esac
