#!/usr/bin/env bash

set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
output_dir="$repository_root/images"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

fetch_chart() {
  local theme="$1"
  local destination="$temporary_dir/commit-history-$theme.svg"

  curl --fail --silent --show-error --location \
    --retry 3 \
    --retry-all-errors \
    "https://commit-history.com/embed/niharnm?theme=$theme&metric=commits" \
    --output "$destination"

  grep --quiet '^<svg ' "$destination"
  grep --quiet "niharnm&#39;s commits" "$destination"
  grep --quiet '<path d="M' "$destination"
}

recolor_light() {
  sed \
    -e 's/#ffffff/#f4f4f1/g' \
    -e 's/#363636/#111111/g' \
    -e 's/#6b7280/#686861/g' \
    -e 's/#e5e7eb/#d8d8d2/g' \
    -e 's/#16a34a/#111111/g' \
    -e 's/#ffd43b/#111111/g'
}

recolor_dark() {
  sed \
    -e 's/#0d1117/#080808/g' \
    -e 's/#c9d1d9/#f4f4f1/g' \
    -e 's/#8b949e/#a7a7a1/g' \
    -e 's/#30363d/#2c2c2a/g' \
    -e 's/#16a34a/#f4f4f1/g' \
    -e 's/#ffd43b/#d8d8d2/g'
}

fetch_chart light
fetch_chart dark

recolor_light \
  < "$temporary_dir/commit-history-light.svg" \
  > "$output_dir/niharnm-commit-history-light.svg"

recolor_dark \
  < "$temporary_dir/commit-history-dark.svg" \
  > "$output_dir/niharnm-commit-history-dark.svg"

grep --quiet '#f4f4f1' "$output_dir/niharnm-commit-history-light.svg"
grep --quiet '#111111' "$output_dir/niharnm-commit-history-light.svg"
grep --quiet '#080808' "$output_dir/niharnm-commit-history-dark.svg"
grep --quiet '#f4f4f1' "$output_dir/niharnm-commit-history-dark.svg"

if grep --quiet '#16a34a' \
  "$output_dir/niharnm-commit-history-light.svg" \
  "$output_dir/niharnm-commit-history-dark.svg"; then
  echo "The upstream accent color was not replaced." >&2
  exit 1
fi
