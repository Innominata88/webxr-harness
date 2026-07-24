#!/usr/bin/env bash
set -euo pipefail

adb_bin="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
destination="${1:-$PWD/android-native-capabilities}"
serial="${2:-}"

adb_args=()
if [[ -n "$serial" ]]; then
  adb_args=(-s "$serial")
fi

mkdir -p "$destination"
"$adb_bin" "${adb_args[@]}" pull \
  /sdcard/Android/data/com.innominata.nativebenchmark/files/capabilities \
  "$destination"
find "$destination" -type f -name 'vulkan-capability__*.json' -print | sort
