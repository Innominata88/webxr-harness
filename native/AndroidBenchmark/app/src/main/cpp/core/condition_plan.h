#pragma once

#include <cstdint>
#include <vector>

namespace native_benchmark {

struct Condition {
    int instances = 0;
    int trial = 0;
    int conditionIndex = 0;
};

std::vector<Condition> buildConditionPlan(
    const std::vector<int>& instances,
    int trialsPerInstance,
    bool shuffle,
    std::uint32_t seed
);

}  // namespace native_benchmark
