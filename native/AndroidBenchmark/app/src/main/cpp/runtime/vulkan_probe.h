#pragma once

#include <android/native_window.h>

#include <string>

namespace native_benchmark {

std::string probeVulkan(ANativeWindow* window);

}  // namespace native_benchmark
