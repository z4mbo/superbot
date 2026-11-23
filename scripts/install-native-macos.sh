#!/bin/bash
set -euo pipefail

if [[ $(uname -s) != Darwin ]]; then
    echo "Run this installer on the Mac that will use Superbot." >&2
    exit 1
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

target=$(rustc -vV | sed -n 's/^host: //p')
case "$target" in
    aarch64-apple-darwin|x86_64-apple-darwin) ;;
    *) echo "Install the macOS Rust toolchain before building Superbot." >&2; exit 1 ;;
esac

target_dir="$root/target"
cargo build --locked --release --target "$target" --target-dir "$target_dir" \
    -p superbot-desktop -p superbot-cli -p superbot-plugin-kit
build="$target_dir/$target/release"
version=$(cargo pkgid --locked -p superbot-desktop)
version=${version##*#}
version=${version##*@}

stage=$(mktemp -d "${TMPDIR:-/tmp}/superbot-install.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
bundle="$stage/Superbot.app/Contents"
mkdir -p "$bundle/MacOS" "$bundle/Helpers" "$bundle/Resources/licenses"
install -m 755 "$build/superbot-desktop" "$bundle/MacOS/Superbot"
for cli in superbot superbot-plugin; do
    install -m 755 "$build/$cli" "$bundle/Helpers/$cli"
done

plist="$bundle/Info.plist"
install -m 644 native/desktop/macos/Info.plist "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $version" "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $version" "$plist"
plutil -lint "$plist"

iconset="$stage/Superbot.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" native/desktop/macos/icon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
    retina=$((size * 2))
    sips -z "$retina" "$retina" native/desktop/macos/icon.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$bundle/Resources/Superbot.icns"

install -m 644 LICENSE NOTICE "$bundle/Resources"
install -m 644 native/desktop/assets/fonts/OFL.txt "$bundle/Resources/licenses/Geist-OFL.txt"
install -m 644 native/workspace-panel/assets/icons/LICENSE-LUCIDE "$bundle/Resources/licenses/Lucide-ISC.txt"
install -m 644 superbot-site/NOTICE.txt "$bundle/Resources/licenses/Design-NOTICE.txt"
install -m 644 superbot-site/licenses/Apache-2.0.txt "$bundle/Resources/licenses/Apache-2.0.txt"

app="$HOME/Applications/Superbot.app"
bin="$HOME/.local/bin"
for cli in superbot superbot-plugin; do
    if [[ -e "$bin/$cli" || -L "$bin/$cli" ]]; then
        case $(readlink "$bin/$cli" || true) in
            "$app/Contents/Helpers/$cli"|"$app/Contents/MacOS/$cli") ;;
            *) echo "Move the existing $bin/$cli before installing." >&2; exit 1 ;;
        esac
    fi
done
mkdir -p "$HOME/Applications" "$bin"
ditto "$stage/Superbot.app" "$app"
for cli in superbot superbot-plugin; do
    if [[ $(readlink "$bin/$cli" || true) != "$app/Contents/Helpers/$cli" ]]; then
        ln -sfn "$app/Contents/Helpers/$cli" "$bin/$cli"
    fi
done

printf 'App installed to %s\nCommands installed to %s\n' "$app" "$bin"
