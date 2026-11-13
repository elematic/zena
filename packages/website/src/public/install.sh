#!/bin/sh
# Standalone installer for the Zena CLI (https://zena-lang.dev).
#
# Usage:
#   curl -fsSL https://zena-lang.dev/install.sh | sh
#   curl -fsSL https://zena-lang.dev/install.sh | ZENA_VERSION=v0.0.1-preview.1 sh
#   curl -fsSL https://zena-lang.dev/install.sh | sh -s -- --version v0.0.1-preview.1

set -eu

REPO="${ZENA_GITHUB_REPO:-elematic/zena}"
API_BASE="${ZENA_GITHUB_API_URL:-https://api.github.com/repos/${REPO}}"
RELEASE_BASE="${ZENA_RELEASE_BASE_URL:-https://github.com/${REPO}/releases/download}"

VERSION="${ZENA_VERSION:-}"
PREVIEW="${ZENA_PREVIEW:-0}"
INSTALL_DIR="${ZENA_INSTALL:-${HOME}/.zena}"
NO_MODIFY_PATH="${ZENA_NO_MODIFY_PATH:-0}"

usage() {
  cat <<'EOF'
Install the Zena CLI

Usage:
  install.sh [options]

Options:
  -v, --version <tag>       Install a specific version (for example: v0.0.1-preview.1)
      --preview             Install the newest release, including preview releases
      --install-dir <dir>   Installation prefix (default: ~/.zena)
      --no-modify-path      Do not edit shell profile files
  -h, --help                Print help

Environment variables:
  ZENA_VERSION              Version to install (same as --version)
  ZENA_PREVIEW              Set to 1 to prefer the newest release including previews
  ZENA_INSTALL              Installation prefix (default: ~/.zena)
  ZENA_NO_MODIFY_PATH       Set to 1 to skip editing shell profile files
EOF
}

err() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '%s\n' "$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -v|--version)
      [ $# -ge 2 ] || err "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    --preview)
      PREVIEW="1"
      shift
      ;;
    --install-dir)
      [ $# -ge 2 ] || err "--install-dir requires a value"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --install-dir=*)
      INSTALL_DIR="${1#*=}"
      shift
      ;;
    --no-modify-path)
      NO_MODIFY_PATH="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "unknown option: $1 (run with --help for usage)"
      ;;
  esac
done

detect_target() {
  os="${ZENA_OS:-$(uname -s)}"
  arch="${ZENA_ARCH:-$(uname -m)}"

  case "$os" in
    Darwin)
      case "$arch" in
        arm64|aarch64)
          printf 'aarch64-apple-darwin'
          ;;
        x86_64)
          if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
            printf 'aarch64-apple-darwin'
          else
            err "prebuilt Intel macOS binaries (x86_64-apple-darwin) are not published; build from source instead: https://zena-lang.dev/guide/getting-started/"
          fi
          ;;
        *)
          err "unsupported macOS architecture: ${arch}"
          ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64|amd64)
          printf 'x86_64-unknown-linux-gnu'
          ;;
        aarch64|arm64)
          printf 'aarch64-unknown-linux-gnu'
          ;;
        *)
          err "unsupported Linux architecture: ${arch}"
          ;;
      esac
      ;;
    *)
      err "unsupported operating system: ${os} (on Windows, run: irm https://zena-lang.dev/install.ps1 | iex)"
      ;;
  esac
}

fetch_to_file() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    err "either 'curl' or 'wget' is required to download Zena"
  fi
}

extract_first_tag_name() {
  tr ',' '\n' < "$1" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

resolve_tag() {
  if [ -n "$VERSION" ]; then
    case "$VERSION" in
      v*) printf '%s' "$VERSION" ;;
      *) printf 'v%s' "$VERSION" ;;
    esac
    return
  fi

  json_file="$1/releases.json"
  tag=""

  if [ "$PREVIEW" != "1" ]; then
    if fetch_to_file "${API_BASE}/releases/latest" "$json_file" 2>/dev/null; then
      tag="$(extract_first_tag_name "$json_file")"
    fi
  fi

  if [ -z "$tag" ]; then
    if ! fetch_to_file "${API_BASE}/releases?per_page=1" "$json_file"; then
      err "failed to query releases from ${API_BASE}/releases"
    fi
    tag="$(extract_first_tag_name "$json_file")"
  fi

  if [ -z "$tag" ]; then
    err "no published Zena releases were found at https://github.com/${REPO}/releases"
  fi

  printf '%s' "$tag"
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    err "no SHA-256 tool found (expected sha256sum, shasum, or openssl)"
  fi
}

append_line_if_missing() {
  rc_file="$1"
  marker="$2"
  line="$3"

  if [ -f "$rc_file" ] && grep -Fq "$marker" "$rc_file"; then
    return 1
  fi
  rc_dir="$(dirname "$rc_file")"
  mkdir -p "$rc_dir"
  if [ -f "$rc_file" ] && [ -s "$rc_file" ]; then
    printf '\n# Zena\n%s\n' "$line" >> "$rc_file"
  else
    printf '# Zena\n%s\n' "$line" >> "$rc_file"
  fi
  return 0
}

configure_path() {
  bin_dir="$1"

  case ":${PATH}:" in
    *":${bin_dir}:"*)
      return 0
      ;;
  esac

  if [ "$NO_MODIFY_PATH" = "1" ]; then
    info ""
    info "Add ${bin_dir} to your PATH:"
    info "  export PATH=\"${bin_dir}:\$PATH\""
    return 0
  fi

  case "$bin_dir" in
    "${HOME}/"*)
      rel_bin="\$HOME/${bin_dir#"${HOME}/"}"
      ;;
    *)
      rel_bin="$bin_dir"
      ;;
  esac

  shell_name="$(basename "${SHELL:-}")"
  updated_rc=""

  case "$shell_name" in
    zsh)
      rc="${ZDOTDIR:-$HOME}/.zshrc"
      if append_line_if_missing "$rc" "$bin_dir" "export PATH=\"${rel_bin}:\$PATH\"" || [ -f "$rc" ]; then
        updated_rc="$rc"
      fi
      ;;
    bash)
      if [ "$(uname -s)" = "Darwin" ] && [ -f "${HOME}/.bash_profile" ] && [ ! -f "${HOME}/.bashrc" ]; then
        rc="${HOME}/.bash_profile"
      else
        rc="${HOME}/.bashrc"
      fi
      if append_line_if_missing "$rc" "$bin_dir" "export PATH=\"${rel_bin}:\$PATH\"" || [ -f "$rc" ]; then
        updated_rc="$rc"
      fi
      ;;
    fish)
      rc="${XDG_CONFIG_HOME:-${HOME}/.config}/fish/config.fish"
      if append_line_if_missing "$rc" "$bin_dir" "fish_add_path \"${bin_dir}\"" || [ -f "$rc" ]; then
        updated_rc="$rc"
      fi
      ;;
    *)
      rc="${HOME}/.profile"
      if append_line_if_missing "$rc" "$bin_dir" "export PATH=\"${rel_bin}:\$PATH\"" || [ -f "$rc" ]; then
        updated_rc="$rc"
      fi
      ;;
  esac

  info ""
  if [ -n "$updated_rc" ]; then
    info "Configured PATH in ${updated_rc}."
  fi
  info "To use zena in your current shell, run:"
  info "  export PATH=\"${bin_dir}:\$PATH\""
}

TARGET="$(detect_target)"
TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t 'zena-install')"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

TAG="$(resolve_tag "$TMP_DIR")"
ARCHIVE="zena-${TAG}-${TARGET}.tar.gz"
ARCHIVE_URL="${RELEASE_BASE}/${TAG}/${ARCHIVE}"
SUMS_URL="${RELEASE_BASE}/${TAG}/SHA256SUMS"

info "Downloading Zena ${TAG} (${TARGET})..."
if ! fetch_to_file "$ARCHIVE_URL" "${TMP_DIR}/${ARCHIVE}"; then
  err "failed to download ${ARCHIVE_URL}"
fi
if ! fetch_to_file "$SUMS_URL" "${TMP_DIR}/SHA256SUMS"; then
  err "failed to download ${SUMS_URL}"
fi

EXPECTED_HASH="$(awk -v file="$ARCHIVE" '$2 == file { print $1; exit }' "${TMP_DIR}/SHA256SUMS")"
if [ -z "$EXPECTED_HASH" ]; then
  err "checksum entry for ${ARCHIVE} was missing from SHA256SUMS"
fi

ACTUAL_HASH="$(sha256_file "${TMP_DIR}/${ARCHIVE}")"
if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
  err "SHA-256 checksum mismatch for ${ARCHIVE}: expected ${EXPECTED_HASH}, got ${ACTUAL_HASH}"
fi

mkdir -p "${TMP_DIR}/extract"
tar -xzf "${TMP_DIR}/${ARCHIVE}" -C "${TMP_DIR}/extract"

if [ ! -f "${TMP_DIR}/extract/zena" ]; then
  err "downloaded archive ${ARCHIVE} did not contain 'zena'"
fi

BIN_DIR="${INSTALL_DIR}/bin"
mkdir -p "$BIN_DIR"
cp "${TMP_DIR}/extract/zena" "${BIN_DIR}/zena"
chmod 755 "${BIN_DIR}/zena"

if [ -f "${TMP_DIR}/extract/zb" ]; then
  cp "${TMP_DIR}/extract/zb" "${BIN_DIR}/zb"
  chmod 755 "${BIN_DIR}/zb"
fi

info "Installed zena ${TAG} to ${BIN_DIR}/zena"
configure_path "$BIN_DIR"
