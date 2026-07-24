#include "core/stats.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <numeric>
#include <stdexcept>

namespace native_benchmark {

double nearestTargetMs(double p50) {
    constexpr std::array<double, 4> targetHz = {120, 90, 72, 60};
    double best = 1000.0 / 60.0;
    double bestDifference = std::numeric_limits<double>::infinity();
    for (const double hz : targetHz) {
        const double period = 1000.0 / hz;
        const double difference = std::abs(p50 - period);
        if (difference < bestDifference) {
            bestDifference = difference;
            best = period;
        }
    }
    return best;
}

TrialStats computeTrialStats(const std::vector<double>& frameTimes, double durationMs) {
    if (!std::isfinite(durationMs) || durationMs < 0) {
        throw std::invalid_argument("duration must be finite and nonnegative");
    }
    TrialStats result;
    result.durationMs = durationMs;
    if (frameTimes.empty()) return result;
    if (std::any_of(frameTimes.begin(), frameTimes.end(), [](double value) {
        return !std::isfinite(value) || value < 0;
    })) {
        throw std::invalid_argument("frame times must be finite and nonnegative");
    }

    std::vector<double> sorted = frameTimes;
    std::sort(sorted.begin(), sorted.end());
    const std::size_t count = sorted.size();
    const auto percentile = [&sorted, count](double probability) {
        const std::size_t index = static_cast<std::size_t>(
            std::floor(probability * static_cast<double>(count - 1))
        );
        return sorted[index];
    };

    result.frames = static_cast<int>(count);
    result.meanMs = std::accumulate(frameTimes.begin(), frameTimes.end(), 0.0)
        / static_cast<double>(count);
    result.p50Ms = percentile(0.50);
    result.p95Ms = percentile(0.95);
    result.p99Ms = percentile(0.99);
    result.fpsEffective = durationMs > 0
        ? static_cast<double>(count) / (durationMs / 1000.0)
        : 0;
    result.fpsFromMean = result.meanMs > 0 ? 1000.0 / result.meanMs : 0;
    result.maxFrameMs = sorted.back();
    result.targetMs = nearestTargetMs(result.p50Ms);
    const double threshold1p5 = result.targetMs * 1.5;
    const double threshold2 = result.targetMs * 2;
    result.missed1p5x = static_cast<int>(std::count_if(
        frameTimes.begin(),
        frameTimes.end(),
        [threshold1p5](double value) { return value > threshold1p5; }
    ));
    result.missed2x = static_cast<int>(std::count_if(
        frameTimes.begin(),
        frameTimes.end(),
        [threshold2](double value) { return value > threshold2; }
    ));
    result.missed1p5xPct = static_cast<double>(result.missed1p5x)
        / static_cast<double>(count);
    result.jankP99OverP50 = result.p50Ms > 0 ? result.p99Ms / result.p50Ms : 0;
    return result;
}

}  // namespace native_benchmark
