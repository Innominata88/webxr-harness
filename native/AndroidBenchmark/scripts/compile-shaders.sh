#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
android_home="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
glslc="$android_home/ndk/25.1.8937393/shader-tools/darwin-x86_64/glslc"
output_dir="$project_dir/app/src/main/assets/benchmark/shaders"

test -x "$glslc"
mkdir -p "$output_dir"

for source in "$project_dir"/shaders/*.{vert,frag}; do
  output="$output_dir/$(basename "$source").spv"
  "$glslc" --target-env=vulkan1.1 -O "$source" -o "$output"
done

find "$output_dir" -type f -name '*.spv' -print | sort
