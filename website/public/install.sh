#!/bin/sh
# Installs Vibe Together's command line, `vibetogether`: one file, for Linux or macOS on x86_64 or
# arm64.
#
#   curl -fsSL https://vibetogether.potentialhedge.com/install.sh | sh
#
# It downloads the latest release's binary for this machine from GitHub, checks it against its
# sha256, and puts it into ~/.local/bin, or VIBETOGETHER_INSTALL_DIR. It says everything it does,
# needs no sudo, touches no shell configuration, and writes nothing else. To remove it, delete
# that one file. The sha256 only shows that the download is whole: `gh attestation verify`
# shows where it was built (https://vibetogether.potentialhedge.com/agents.md).
set -eu

say() { printf 'vibetogether: %s\n' "$*" >&2; }
die() {
  say "$*"
  exit 1
}

main() {
  case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "no binary for $(uname -s): install with Cargo, cargo install --git https://github.com/PotentialHedge/vibetogether vibetogether" ;;
  esac
  case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) die "no binary for $(uname -m): install with Cargo, cargo install --git https://github.com/PotentialHedge/vibetogether vibetogether" ;;
  esac
  name="vibetogether-$arch-$os"
  url="https://github.com/PotentialHedge/vibetogether/releases/latest/download/$name"
  dir="${VIBETOGETHER_INSTALL_DIR:-$HOME/.local/bin}"

  if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL -o "$2" "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO "$2" "$1"; }
  else
    die "needs curl or wget to download $url"
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    digest() { sha256sum "$1"; }
  elif command -v shasum >/dev/null 2>&1; then
    digest() { shasum -a 256 "$1"; }
  else
    die "needs sha256sum or shasum to check the download"
  fi

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  say "downloading $url"
  fetch "$url" "$tmp/$name" || die "could not download $url"
  fetch "$url.sha256" "$tmp/$name.sha256" || die "could not download $url.sha256"
  want="$(cut -d' ' -f1 <"$tmp/$name.sha256")"
  got="$(digest "$tmp/$name" | cut -d' ' -f1)"
  [ -n "$want" ] && [ "$want" = "$got" ] || die "the download does not match its sha256: nothing was installed"
  say "checked its sha256: $got"

  chmod 755 "$tmp/$name"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    say "made $dir"
  fi
  mv -f "$tmp/$name" "$dir/vibetogether"
  say "wrote $dir/vibetogether ($("$dir/vibetogether" --version))"

  case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "$dir is not on PATH: run it as $dir/vibetogether, or add export PATH=\"$dir:\$PATH\" to your shell's configuration" ;;
  esac
  say "next: vibetogether login, and vibetogether doctor to see that it works"
}

main "$@"
