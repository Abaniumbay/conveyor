#!/bin/sh
# Installs a Conveyor release: downloads the archive for this platform, verifies its SHA-256
# checksum, installs it into <prefix>/versions/<version>, points <prefix>/current at it and links
# <bin-dir>/conveyor. It never touches the Conveyor home (configuration, credentials, state).
#
#   sh install.sh [--version vX.Y.Z] [--prefix <dir>] [--bin-dir <dir>]
#   sh install.sh --archive conveyor-vX.Y.Z-linux-x64.tar.gz --checksums checksums.txt   (offline)
#
# Defaults: the latest release; as root, --prefix /opt/conveyor and --bin-dir /usr/local/bin;
# otherwise ~/.local/share/conveyor and ~/.local/bin.
set -eu

REPOSITORY="${CONVEYOR_REPOSITORY:-Abaniumbay/conveyor}"
version=""
prefix=""
bin_dir=""
archive=""
checksums=""

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version needs a value"; version="$2"; shift 2 ;;
    --prefix) [ $# -ge 2 ] || fail "--prefix needs a value"; prefix="$2"; shift 2 ;;
    --bin-dir) [ $# -ge 2 ] || fail "--bin-dir needs a value"; bin_dir="$2"; shift 2 ;;
    --archive) [ $# -ge 2 ] || fail "--archive needs a value"; archive="$2"; shift 2 ;;
    --checksums) [ $# -ge 2 ] || fail "--checksums needs a value"; checksums="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "install.sh: unknown option $1" >&2; usage 2 ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || fail "Conveyor releases support Linux only (this is $(uname -s))"
case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac
if ldd --version 2>&1 | grep -qi musl; then
  fail "musl-based systems (such as Alpine) are not supported; the executable needs glibc"
fi

if [ "$(id -u)" = "0" ]; then
  prefix="${prefix:-/opt/conveyor}"
  bin_dir="${bin_dir:-/usr/local/bin}"
else
  prefix="${prefix:-$HOME/.local/share/conveyor}"
  bin_dir="${bin_dir:-$HOME/.local/bin}"
fi

download() {
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "sha256sum or shasum is required to verify the download"
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

if [ -n "$archive" ]; then
  [ -n "$checksums" ] || fail "--archive needs --checksums"
  [ -f "$archive" ] || fail "$archive does not exist"
  name="$(basename "$archive")"
  cp "$archive" "$work/$name"
  cp "$checksums" "$work/checksums.txt"
else
  if [ -z "$version" ]; then
    command -v curl >/dev/null 2>&1 || fail "pass --version when curl is not available"
    location="$(curl --proto '=https' -fsSI "https://github.com/$REPOSITORY/releases/latest" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p' | tail -n 1)"
    version="${location##*/}"
    case "$version" in v[0-9]*) ;; *) fail "cannot determine the latest release; pass --version" ;; esac
  fi
  case "$version" in v*) ;; *) version="v$version" ;; esac
  name="conveyor-$version-linux-$arch.tar.gz"
  base="https://github.com/$REPOSITORY/releases/download/$version"
  echo "Downloading Conveyor $version for linux-$arch..."
  download "$base/$name" "$work/$name" || fail "cannot download $base/$name (is $version released for linux-$arch?)"
  download "$base/checksums.txt" "$work/checksums.txt" || fail "cannot download $base/checksums.txt"
fi

expected="$(awk -v file="$name" '$2 == file { print $1 }' "$work/checksums.txt")"
[ -n "$expected" ] || fail "checksums.txt has no entry for $name"
actual="$(sha256 "$work/$name")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $name: expected $expected, got $actual"
echo "Verified $name ($actual)."

tar -C "$work" -xzf "$work/$name"
unpacked="$work/${name%.tar.gz}"
[ -x "$unpacked/conveyor" ] || fail "$name does not contain the conveyor executable"
number="$("$unpacked/conveyor" --version | awk '{ print $2 }')"
[ -n "$number" ] || fail "the downloaded executable does not run on this machine"

destination="$prefix/versions/$number"
mkdir -p "$prefix/versions" "$bin_dir"
rm -rf "$destination.partial"
mkdir "$destination.partial"
cp "$unpacked/conveyor" "$unpacked/LICENSE" "$unpacked/THIRD_PARTY_NOTICES.txt" "$destination.partial/"
chmod 0755 "$destination.partial/conveyor"
rm -rf "$destination"
mv "$destination.partial" "$destination"

# Switch atomically: a new link is renamed over the old one.
ln -sfn "versions/$number" "$prefix/current.new"
mv -T "$prefix/current.new" "$prefix/current"
ln -sfn "$prefix/current/conveyor" "$bin_dir/conveyor.new"
mv -T "$bin_dir/conveyor.new" "$bin_dir/conveyor"

echo "Installed Conveyor $number in $destination"
echo "  $bin_dir/conveyor -> $prefix/current/conveyor"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH to run conveyor by name." ;;
esac
echo "Next: conveyor init, then conveyor doctor."
