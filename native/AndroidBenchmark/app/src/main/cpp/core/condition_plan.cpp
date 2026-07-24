#include "core/condition_plan.h"

#include <algorithm>
#include <cstddef>
#include <stdexcept>

namespace native_benchmark {
namespace {

class Mulberry32 {
public:
    explicit Mulberry32(std::uint32_t seed) : state_(seed) {}

    double next() {
        state_ += 0x6D2B79F5U;
        std::uint32_t value = (state_ ^ (state_ >> 15U)) * (1U | state_);
        value = (value + ((value ^ (value >> 7U)) * (61U | value))) ^ value;
        return static_cast<double>(value ^ (value >> 14U)) / 4294967296.0;
    }

private:
    std::uint32_t state_;
};

}  // namespace

std::vector<Condition> buildConditionPlan(
    const std::vector<int>& instances,
    int trialsPerInstance,
    bool shuffle,
    std::uint32_t seed
) {
    if (instances.empty() || trialsPerInstance < 1) {
        throw std::invalid_argument("condition plan requires instances and positive trials");
    }
    std::vector<Condition> conditions;
    conditions.reserve(instances.size() * static_cast<std::size_t>(trialsPerInstance));
    for (const int instanceCount : instances) {
        if (instanceCount < 1) throw std::invalid_argument("instance count must be positive");
        for (int trial = 1; trial <= trialsPerInstance; ++trial) {
            conditions.push_back({instanceCount, trial, 0});
        }
    }

    if (shuffle) {
        Mulberry32 random(seed);
        std::size_t remaining = conditions.size();
        while (remaining > 1) {
            const std::size_t selected = static_cast<std::size_t>(
                random.next() * static_cast<double>(remaining)
            );
            --remaining;
            std::swap(conditions[remaining], conditions[selected]);
        }
    }
    for (std::size_t index = 0; index < conditions.size(); ++index) {
        conditions[index].conditionIndex = static_cast<int>(index);
    }
    return conditions;
}

}  // namespace native_benchmark
