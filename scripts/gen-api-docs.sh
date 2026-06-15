#!/usr/bin/env bash
#
# Generate API reference Markdown for the camera.ui Go SDK.
#
# This script:
#   1. Runs `gomarkdoc` once over the package, producing one big markdown
#      blob (`docs/api/_full.md`) that contains every public symbol.
#   2. Splits that blob into 7 per-module pages under `docs/api/`:
#      plugin.md, camera.md, sensor.md, storage.md, manager.md,
#      observable.md, types.md.
#
# The split logic is keyed on Go symbol *names* — each public symbol is
# routed to exactly one of the 7 buckets via the BUCKETS lookup below.
# Symbols that don't fit any bucket are skipped (private types, helpers
# we don't want to surface, NVR-only types we explicitly drop).
#
# Re-run this script after editing any doc comments in `sdk/go/*.go` to
# refresh the published API reference. Output is checked in.
#
# Requirements:
#   - go        (module's `go.mod` is loaded)
#   - gomarkdoc (`go install github.com/princjef/gomarkdoc/cmd/gomarkdoc@latest`)
#   - python3
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOCS_API_DIR="${SDK_DIR}/docs/api"
FULL_MD="${DOCS_API_DIR}/_full.md"

# Make sure gomarkdoc is on PATH (default install location).
export PATH="${PATH}:$(go env GOPATH)/bin"

if ! command -v gomarkdoc >/dev/null 2>&1; then
  echo "gomarkdoc not found. Install with:"
  echo "  go install github.com/princjef/gomarkdoc/cmd/gomarkdoc@latest"
  exit 1
fi

mkdir -p "${DOCS_API_DIR}"

echo "[1/2] Running gomarkdoc..."
( cd "${SDK_DIR}" && gomarkdoc --format plain --output "${FULL_MD}" . )

echo "[2/2] Splitting ${FULL_MD} into per-module pages..."
python3 "${SCRIPT_DIR}/split_api_docs.py" "${FULL_MD}" "${DOCS_API_DIR}"

echo
echo "API reference regenerated:"
ls -la "${DOCS_API_DIR}"/*.md | grep -v _full.md
