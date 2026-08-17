#!/usr/bin/env bash

set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
output_dir="$repository_root/images"
temporary_dir="$(mktemp -d)"
cache_key="${COMMIT_HISTORY_CACHE_KEY:-$(date -u +%Y-%m)}"
trap 'rm -rf "$temporary_dir"' EXIT

fetch_chart() {
  local theme="$1"
  local source_url="https://commit-history.com/embed/niharnm?metric=commits&v=$cache_key"
  local destination="$temporary_dir/commit-history-$theme.svg"
  local rendered_html
  local camo_url

  if [[ "$theme" == "dark" ]]; then
    source_url="https://commit-history.com/embed/niharnm?theme=dark&metric=commits&v=$cache_key"
  fi

  rendered_html="$(gh api --method POST markdown -f mode=gfm -f text="![commit history]($source_url)")"
  camo_url="$(printf '%s' "$rendered_html" | sed -n 's/.*<img src="\([^"]*\)".*/\1/p')"
  test -n "$camo_url"

  curl --fail --silent --show-error --location \
    --retry 3 \
    --retry-all-errors \
    "$camo_url" \
    --output "$destination"

  grep --quiet '^<svg ' "$destination"
  grep --quiet "niharnm&#39;s commits" "$destination"
  grep --quiet '<path d="M' "$destination"
}

recolor_light() {
  sed \
    -e 's/niharnm&#39;s commits/my commits/g' \
    -e 's/#ffffff/#f4f4f1/g' \
    -e 's/#363636/#111111/g' \
    -e 's/#6b7280/#686861/g' \
    -e 's/#e5e7eb/#d8d8d2/g' \
    -e 's/#16a34a/#111111/g' \
    -e 's/#ffd43b/#111111/g'
}

recolor_dark() {
  sed \
    -e 's/niharnm&#39;s commits/my commits/g' \
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

grep --quiet '>my commits</text>' "$output_dir/niharnm-commit-history-light.svg"
grep --quiet '>my commits</text>' "$output_dir/niharnm-commit-history-dark.svg"

if grep --quiet '#16a34a\|niharnm&#39;s commits' \
  "$output_dir/niharnm-commit-history-light.svg" \
  "$output_dir/niharnm-commit-history-dark.svg"; then
  echo "The upstream chart was not fully themed." >&2
  exit 1
fi
