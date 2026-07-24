#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$project_dir/../.." && pwd)"

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NATIVE_APP_COMMIT="$(git -C "$repo_root" rev-parse --short HEAD)"
if [[ -z "$(git -C "$repo_root" status --porcelain)" ]]; then
  export NATIVE_WORKTREE_STATE="clean"
else
  export NATIVE_WORKTREE_STATE="dirty"
fi

"$project_dir/scripts/compile-shaders.sh"

cd "$project_dir"
./gradlew :app:assembleRelease --no-daemon

apk="$project_dir/app/build/outputs/apk/release/app-release.apk"
test -f "$apk"
shasum -a 256 "$apk"
printf 'Built %s\n' "$apk"
