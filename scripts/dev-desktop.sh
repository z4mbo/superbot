#!/bin/sh

usage() {
    printf 'Usage: %s [--server URL] [--reset-session (macOS only, requires --server)]\n' "$0"
}

parse_args() {
    case "$#:$1" in
        1:--help|1:-h) usage; exit 0 ;;
    esac
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --server)
                [ -z "$server_arg" ] || return 1
                case "${2:-}" in ''|-*) return 1 ;; esac
                server_arg=$2
                shift
                ;;
            --reset-session) reset_session=true ;;
            *) return 1 ;;
        esac
        shift
    done
}

# Match the account stored by native/client, including URL normalization and the final slash.
keychain_account() {
    node - "$1" <<'JS'
try {
    const url = new URL(process.argv[2].trim());
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
        /^127(?:\.\d+){3}$/.test(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.username || url.password || url.href !== `${url.origin}/`) {
        process.exit(1);
    }
    console.log(url.href);
} catch {
    process.exit(1);
}
JS
}

clear_keychain_session() {
    security delete-generic-password -s com.superbot.rakazo.session -a "$account" >/dev/null 2>&1
    case $? in
        0) printf '[dev] cleared the keychain session for %s\n' "$account" ;;
        44) printf '[dev] no keychain session for %s\n' "$account" ;;
        *) printf '[dev] could not clear the keychain session for %s\n' "$account" >&2 ;;
    esac
}

snapshot_sources() {
    find native ./Cargo.* -type f -print >"$1" && LC_ALL=C sort -o "$1" "$1"
}

sources_changed() {
    snapshot_sources "$launch_dir/current-files" || return 1
    if ! cmp -s "$launch_dir/files" "$launch_dir/current-files"; then
        return 0
    fi
    newer=$(find native ./Cargo.* -type f -newer "$launch_dir/stamp" -print) || return 1
    [ -n "$newer" ]
}

stop_child() {
    if [ -n "$1" ]; then
        # The desktop may have been closed manually and its PID reused.
        parent=$(ps -o ppid= -p "$1")
        if [ "${parent:-0}" -eq "$$" ]; then
            kill "$1" 2>/dev/null || :
        fi
        wait "$1" 2>/dev/null || :
    fi
}

cleanup() {
    stop_child "$build_pid"
    stop_child "$app_pid"
    rm -rf "$launch_dir"
}

rebuild() {
    # Changes during compilation will be picked up on the next scan.
    touch "$launch_dir/stamp" && snapshot_sources "$launch_dir/files" || return
    printf '\n[dev] building...\n'
    cargo build --locked -p superbot-desktop &
    build_pid=$!
    wait "$build_pid"
    build_status=$?
    build_pid=
    if [ "$build_status" -ne 0 ]; then
        printf '[dev] build failed; the last good build keeps running\n' >&2
        return
    fi

    if ! cp "$CARGO_TARGET_DIR/debug/superbot-desktop" "$launch_dir/next" ||
        ! mv -f "$launch_dir/next" "$launch_dir/superbot-desktop"; then
        printf '[dev] could not copy the build; the last good build keeps running\n' >&2
        return
    fi
    stop_child "$app_pid"
    if [ -n "$account" ]; then
        clear_keychain_session
    fi
    "$launch_dir/superbot-desktop" &
    app_pid=$!
    printf '[dev] launched desktop (PID %s)\n' "$app_pid"
}

server_arg=
reset_session=false
parse_args "$@" || { usage >&2; exit 2; }
if [ -n "$server_arg" ]; then
    export SUPERBOT_SERVER="$server_arg"
fi
account=
if [ "$reset_session" = true ]; then
    if [ -z "$server_arg" ]; then
        printf '[dev] --reset-session requires an explicit --server URL\n' >&2
        exit 2
    fi
    if [ "$(uname -s)" != Darwin ]; then
        printf '[dev] --reset-session is available on macOS only\n' >&2
        exit 2
    fi
    account=$(keychain_account "$server_arg") || {
        printf '[dev] --server must be an HTTPS origin or a loopback HTTP origin\n' >&2
        exit 2
    }
    printf '[dev] will remove the saved keychain session for %s before each successful launch\n' "$account"
fi

root=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd) || exit 1
cd "$root" || exit 1
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/target}"
launch_dir=$(mktemp -d "${TMPDIR:-/tmp}/superbot-dev.XXXXXX") || exit 1
app_pid=
build_pid=
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

rebuild
printf '[dev] watching native/ and Cargo.* (Ctrl+C to stop)\n'
while sleep 1; do
    if sources_changed; then
        rebuild
    fi
done
