#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Linux ]]; then
    echo "Run this installer on the Linux machine that will use Superbot." >&2
    exit 1
fi

cli_only=false
build_dir=
while (( $# )); do
    case "$1" in
        --cli-only) cli_only=true; shift ;;
        --build-dir) build_dir=${2:?Missing build directory}; shift 2 ;;
        *) echo "Usage: $0 [--cli-only] [--build-dir DIRECTORY]" >&2; exit 2 ;;
    esac
done

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
data_dir=${XDG_DATA_HOME:-"$HOME/.local/share"}
[[ $data_dir = /* ]] || data_dir="$HOME/.local/share"
bin_dir="$HOME/.local/bin"
app_dir="$data_dir/superbot/app"
programs=(superbot superbot-plugin)
packages=(-p superbot-cli -p superbot-plugin-kit)
if ! $cli_only; then
    programs+=(superbot-desktop)
    packages+=(-p superbot-desktop)
fi

for program in "${programs[@]}"; do
    entry="$bin_dir/$program"
    if [[ -e $entry || -L $entry ]] && [[ $(readlink "$entry" || true) != "$app_dir/$program" ]]; then
        echo "An existing command occupies $entry. The installation has been left as it was." >&2
        exit 1
    fi
done
if [[ -z $build_dir ]]; then
    (cd "$root" && cargo build --locked --release --target-dir "$root/target" "${packages[@]}")
    build_dir="$root/target/release"
fi
for program in "${programs[@]}"; do
    [[ -x "$build_dir/$program" ]] || { echo "Missing executable: $build_dir/$program" >&2; exit 1; }
done

mkdir -p "$app_dir" "$bin_dir"
stage=$(mktemp -d "$app_dir/.install.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
for program in "${programs[@]}"; do
    install -m 755 "$build_dir/$program" "$stage/$program"
done
install -m 644 "$root/LICENSE" "$root/NOTICE" "$app_dir/"
if ! $cli_only; then
    mkdir -p "$app_dir/licenses" "$data_dir/applications" "$data_dir/icons/hicolor/scalable/apps"
    install -m 644 "$root/native/desktop/assets/fonts/OFL.txt" "$app_dir/licenses/Geist-OFL.txt"
    install -m 644 "$root/native/workspace-panel/assets/icons/LICENSE-LUCIDE" "$app_dir/licenses/Lucide-ISC.txt"
    install -m 644 "$root/superbot-site/NOTICE.txt" "$app_dir/licenses/Design-NOTICE.txt"
    install -m 644 "$root/superbot-site/licenses/Apache-2.0.txt" "$app_dir/licenses/Apache-2.0.txt"
    install -m 644 "$root/superbot-site/assets/logo.svg" "$data_dir/icons/hicolor/scalable/apps/superbot.svg"
    # Desktop Entry applies string escaping before Exec's argument quoting and expands % field codes.
    # GIO checks the first argument before expanding percent codes. Use env as
    # the executable so paths containing a literal percent can be expanded.
    exec_path=$(printf '%s' "$app_dir/superbot-desktop" | sed 's/[\\"$`]/\\&/g; s/\\/\\\\/g; s/%/%%/g')
    cat >"$stage/superbot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Superbot
Exec=env -- "$exec_path"
Icon=superbot
Terminal=false
Categories=Network;Chat;
EOF
    install -m 644 "$stage/superbot.desktop" "$data_dir/applications/superbot.desktop"
fi
for program in "${programs[@]}"; do
    mv -f -- "$stage/$program" "$app_dir/$program"
    if [[ ! -L "$bin_dir/$program" ]]; then ln -s "$app_dir/$program" "$bin_dir/$program"; fi
done
printf 'Installed %s in %s\n' "${programs[*]}" "$bin_dir"
