#!/usr/bin/env bash
# install-images.sh --update: refuses a folder with no install, keeps .env, pulls before it
# recreates, and names the commit it moved from and to. A tag chosen for the first install is
# kept in .env. Stubbed docker, curl and openssl; no daemon, registry or network.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
unset RAKAZO_IMAGE_TAG RAKAZO_COMPUTER_IMAGE_TAG RAKAZO_DOWNLOAD_SKIP_EXISTING RAKAZO_PULL_NEVER

tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-images-update.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
# The running API reports the old commit until `up` runs, then the new one (or the old one
# again when STUB_SAME is set, as when nothing newer was published).
cat >"$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"${STUB_LOG:?}"
case "${1:-}" in
  inspect) [[ -f "$STUB_STATE" ]] && echo sha256:new-image || echo sha256:old-image; exit 0 ;;
  image)
    if [[ "${2:-}" == inspect ]]; then
      if [[ " $* " == *" sha256:new-image "* && -z "${STUB_SAME:-}" ]]; then
        echo 2222222222222222222222222222222222222222
      else
        echo 1111111111111111111111111111111111111111
      fi
    fi
    exit 0
    ;;
  compose) ;;
  *) exit 0 ;;
esac
[[ " $* " != *" --help "* ]] || { echo "--pull --wait --wait-timeout"; exit 0; }
for a in "$@"; do
  case "$a" in
    config)
      [[ " $* " != *" --images "* ]] || exit 0
      cat >/dev/null
      grep -E '^[A-Z_]+=' .env
      exit 0
      ;;
    ps) echo container-api; exit 0 ;;
    up) : >"$STUB_STATE"; exit 0 ;;
  esac
done
exit 0
STUB
printf '#!/usr/bin/env bash\nexit 1\n' >"$tmp/bin/curl"
cat >"$tmp/bin/openssl" <<'STUB'
#!/usr/bin/env bash
# openssl rand -hex N
head -c "$3" /dev/urandom | od -An -tx1 | tr -d ' \n'
STUB
chmod +x "$tmp/bin/docker" "$tmp/bin/curl" "$tmp/bin/openssl"

# $1 work folder; remaining args go to the installer.
run() {
  local work="$1"
  shift
  (
    cd "$work"
    export PATH="$tmp/bin:$PATH" STUB_LOG="$work/docker.log" STUB_STATE="$work/up-ran"
    bash "$src" "$@" 2>&1
  )
}

# No install here: refuse before pulling or starting anything.
mkdir -p "$tmp/empty"
out="$(run "$tmp/empty" --update)" && fail "--update ran without an install: $out"
[[ "$out" == *"--update needs an existing install"* ]] || fail "unclear refusal: $out"
[[ ! -e "$tmp/empty/.env" ]] || fail "--update created a .env"
! grep -q 'compose' "$tmp/empty/docker.log" 2>/dev/null || fail "--update ran Compose without an install"

# A first install with a shell tag keeps that tag, for the app and computer images, in .env.
mkdir -p "$tmp/edge"
cp "$root/docker-compose.images.yml" "$root/.env.images.example" "$tmp/edge/"
out="$(RAKAZO_IMAGE_TAG=edge run "$tmp/edge" --local --prepare-only)" || fail "edge prepare failed: $out"
grep -qx 'RAKAZO_IMAGE_TAG=edge' "$tmp/edge/.env" || fail "app tag not kept in .env"
grep -qx 'RAKAZO_COMPUTER_IMAGE_TAG=edge' "$tmp/edge/.env" || fail "computer tag not kept in .env"
mkdir -p "$tmp/default"
cp "$root/docker-compose.images.yml" "$root/.env.images.example" "$tmp/default/"
out="$(run "$tmp/default" --local --prepare-only)" || fail "default prepare failed: $out"
grep -qx 'RAKAZO_IMAGE_TAG=latest' "$tmp/default/.env" || fail "default tag changed without a shell tag"
mkdir -p "$tmp/bad-tag"
cp "$root/docker-compose.images.yml" "$root/.env.images.example" "$tmp/bad-tag/"
out="$(RAKAZO_IMAGE_TAG='edge x' run "$tmp/bad-tag" --local --prepare-only)" && fail "accepted a bad tag: $out"
[[ ! -e "$tmp/bad-tag/.env" ]] || fail "wrote .env with a bad tag"

# --update cannot be a dry run.
out="$(run "$tmp/edge" --update --prepare-only)" && fail "--update --prepare-only ran: $out"

# An update on the existing install keeps .env byte for byte, pulls, then recreates.
printf 'SANDBOX_COMPUTER_EGRESS=open\n' >>"$tmp/edge/.env"
before="$(cksum <"$tmp/edge/.env")"
: >"$tmp/edge/docker.log"
out="$(run "$tmp/edge" --update --local)" || fail "update failed: $out"
[[ "$(cksum <"$tmp/edge/.env")" == "$before" ]] || fail "--update changed .env"
[[ "$out" == *"Keeping existing .env."* ]] || fail "did not keep .env: $out"
[[ "$out" == *"Updated Superbot from commit 111111111111 to commit 222222222222."* ]] ||
  fail "did not report the versions: $out"
pull_at="$(grep -n ' pull$' "$tmp/edge/docker.log" | head -1 | cut -d: -f1)"
up_at="$(grep -n ' up -d ' "$tmp/edge/docker.log" | head -1 | cut -d: -f1)"
[[ -n "$pull_at" && -n "$up_at" && "$pull_at" -lt "$up_at" ]] || fail "did not pull before up"
grep -q ' up -d .*--wait' "$tmp/edge/docker.log" || fail "did not wait for healthy services"

# Nothing newer: say so instead of claiming an update.
rm -f "$tmp/edge/up-ran"
out="$(STUB_SAME=1 run "$tmp/edge" --update --local)" || fail "no-op update failed: $out"
[[ "$out" == *"Superbot is already up to date (commit 111111111111)."* ]] || fail "no-op not reported: $out"

echo "ok"
