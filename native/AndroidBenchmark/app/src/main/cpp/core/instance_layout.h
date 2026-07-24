#pragma once

#include <vector>

namespace native_benchmark {

struct InstanceOffset {
    float x = 0;
    float y = 0;
    float z = 0;
};

std::vector<InstanceOffset> xrwallOffsets(int count, float spacing);

}  // namespace native_benchmark
