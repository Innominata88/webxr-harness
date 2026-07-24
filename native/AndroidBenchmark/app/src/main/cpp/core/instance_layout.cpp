#include "core/instance_layout.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace native_benchmark {

std::vector<InstanceOffset> xrwallOffsets(int count, float spacing) {
    if (count < 1 || !std::isfinite(spacing) || spacing <= 0) {
        throw std::invalid_argument("xrwall requires positive count and spacing");
    }
    constexpr double targetAspect = 16.0 / 9.0;
    const int columns = std::max(
        1,
        static_cast<int>(std::ceil(std::sqrt(static_cast<double>(count) * targetAspect)))
    );
    const int rows = std::max(
        1,
        static_cast<int>(std::ceil(static_cast<double>(count) / columns))
    );
    const float xHalf = static_cast<float>(columns - 1) / 2.0F;
    const float yHalf = static_cast<float>(rows - 1) / 2.0F;

    std::vector<InstanceOffset> offsets;
    offsets.reserve(static_cast<std::size_t>(count));
    for (int index = 0; index < count; ++index) {
        const int column = index % columns;
        const int row = index / columns;
        offsets.push_back({
            (static_cast<float>(column) - xHalf) * spacing,
            (yHalf - static_cast<float>(row)) * spacing,
            0,
        });
    }
    return offsets;
}

}  // namespace native_benchmark
