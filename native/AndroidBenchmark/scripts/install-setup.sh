#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
adb_bin="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
apk="$project_dir/app/build/outputs/apk/release/app-release.apk"

test -x "$adb_bin"
test -f "$apk"

adb_args=()
if [[ $# -gt 0 ]]; then
  adb_args=(-s "$1")
fi

"$adb_bin" "${adb_args[@]}" get-state >/dev/null
"$adb_bin" "${adb_args[@]}" install -r "$apk"
"$adb_bin" "${adb_args[@]}" shell am force-stop com.innominata.nativebenchmark
"$adb_bin" "${adb_args[@]}" shell am start \
  -n com.innominata.nativebenchmark/.BenchmarkActivity
