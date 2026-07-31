#!/usr/bin/env bash
# =============================================================================
# LocalNotes Manager - Offline Library Vendoring Script
# -----------------------------------------------------------------------------
# Downloads every third-party runtime dependency ONCE and copies it into ./lib/
# so that the application never makes a network call to a CDN in order to boot.
#
#   ./lib/idb-keyval.js            (ES module build - imported by app.js)
#   ./lib/alasql.js                (classic script - loaded by index.html)
#   ./lib/hugerte/hugerte.min.js   (+ full skins/themes/icons/plugins dist)
#
# Usage:
#   bash scripts/vendor-libs.sh                # vendor pinned versions
#   IDB_VERSION=6.2.2 bash scripts/vendor-libs.sh
#
# Requires: bash, curl OR wget, tar. `npm` is used when available for the
# HugeRTE distribution (npm pack), otherwise the registry tarball is fetched
# directly over https.
# =============================================================================

set -euo pipefail

# ----------------------------- configuration ---------------------------------
IDB_VERSION="${IDB_VERSION:-6.2.1}"
ALASQL_VERSION="${ALASQL_VERSION:-4.6.6}"
HUGERTE_VERSION="${HUGERTE_VERSION:-1.0.9}"

REGISTRY="https://registry.npmjs.org"
CDN="https://cdn.jsdelivr.net/npm"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LIB_DIR="${ROOT_DIR}/lib"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/localnotes-vendor.XXXXXX")"

trap 'rm -rf "${TMP_DIR}"' EXIT

# ------------------------------- helpers -------------------------------------
log()  { printf '\033[1;34m[vendor]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[vendor]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[vendor]\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

download() {
  # download <url> <destination>
  local url="$1" dest="$2"
  mkdir -p "$(dirname "${dest}")"
  if have curl; then
    curl -fsSL --retry 3 --retry-delay 1 "${url}" -o "${dest}"
  elif have wget; then
    wget -q --tries=3 -O "${dest}" "${url}"
  else
    die "Neither curl nor wget is available; cannot download ${url}"
  fi
  [ -s "${dest}" ] || die "Downloaded file is empty: ${url}"
}

# =============================================================================
# 1. idb-keyval  (ES module - app.js does: import { get, set } from './lib/idb-keyval.js')
# =============================================================================
vendor_idb_keyval() {
  log "Vendoring idb-keyval@${IDB_VERSION} (ESM) ..."
  local dest="${LIB_DIR}/idb-keyval.js"
  # dist/index.js in idb-keyval v6 is a dependency-free ES module.
  download "${CDN}/idb-keyval@${IDB_VERSION}/dist/index.js" "${dest}"
  if ! grep -q "export" "${dest}"; then
    warn "idb-keyval build does not look like an ES module; trying the ESM bundle."
    download "${CDN}/idb-keyval@${IDB_VERSION}/dist/index.min.js" "${dest}"
  fi
  log "  -> lib/idb-keyval.js ($(wc -c <"${dest}") bytes)"
}

# =============================================================================
# 2. AlaSQL  (classic browser script, exposes window.alasql)
# =============================================================================
vendor_alasql() {
  log "Vendoring alasql@${ALASQL_VERSION} ..."
  local dest="${LIB_DIR}/alasql.js"
  download "${CDN}/alasql@${ALASQL_VERSION}/dist/alasql.min.js" "${dest}"
  log "  -> lib/alasql.js ($(wc -c <"${dest}") bytes)"
}

# =============================================================================
# 3. HugeRTE  (full dist folder: core, themes, models, icons, skins, plugins)
# =============================================================================
vendor_hugerte() {
  log "Vendoring hugerte@${HUGERTE_VERSION} (full distribution) ..."
  local work="${TMP_DIR}/hugerte"
  mkdir -p "${work}"

  local tarball=""
  if have npm; then
    ( cd "${work}" && npm pack "hugerte@${HUGERTE_VERSION}" --silent >/dev/null 2>&1 ) || true
    tarball="$(find "${work}" -maxdepth 1 -name '*.tgz' -print -quit || true)"
  fi

  if [ -z "${tarball}" ]; then
    warn "npm pack unavailable/failed - falling back to the registry tarball."
    tarball="${work}/hugerte.tgz"
    download "${REGISTRY}/hugerte/-/hugerte-${HUGERTE_VERSION}.tgz" "${tarball}"
  fi

  tar -xzf "${tarball}" -C "${work}"
  local pkg="${work}/package"
  [ -d "${pkg}" ] || die "Unexpected tarball layout for hugerte"

  local src=""
  for candidate in "${pkg}" "${pkg}/dist" "${pkg}/hugerte"; do
    if [ -f "${candidate}/hugerte.min.js" ]; then src="${candidate}"; break; fi
  done
  [ -n "${src}" ] || die "Could not locate hugerte.min.js inside the package"

  rm -rf "${LIB_DIR}/hugerte"
  mkdir -p "${LIB_DIR}/hugerte"
  # Copy the whole runtime tree: skins/, icons/, themes/, models/, plugins/, langs/
  ( cd "${src}" && tar cf - . ) | ( cd "${LIB_DIR}/hugerte" && tar xf - )

  # Trim files that are useless at runtime to keep the repository lean.
  rm -f "${LIB_DIR}/hugerte/package.json" "${LIB_DIR}/hugerte/CHANGELOG.md" 2>/dev/null || true

  [ -f "${LIB_DIR}/hugerte/hugerte.min.js" ] || die "hugerte.min.js missing after copy"
  log "  -> lib/hugerte/ ($(find "${LIB_DIR}/hugerte" -type f | wc -l) files)"

  if [ ! -f "${LIB_DIR}/hugerte/skins/ui/oxide/skin.min.css" ]; then
    warn "Default 'oxide' skin not found. app.js will fall back to skin:false."
  fi
}

# =============================================================================
# main
# =============================================================================
main() {
  mkdir -p "${LIB_DIR}"
  log "Target directory: ${LIB_DIR}"

  vendor_idb_keyval
  vendor_alasql
  vendor_hugerte

  cat >"${LIB_DIR}/VENDORED.txt" <<EOF
LocalNotes Manager - vendored offline runtime libraries
Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

idb-keyval  ${IDB_VERSION}   (Apache-2.0)  -> lib/idb-keyval.js
alasql      ${ALASQL_VERSION}   (MIT)         -> lib/alasql.js
hugerte     ${HUGERTE_VERSION}   (MIT)         -> lib/hugerte/

Re-generate with:  bash scripts/vendor-libs.sh
These files are intentionally committed so the app boots with zero network access.
EOF

  log "Done. The application can now boot fully offline."
}

main "$@"
