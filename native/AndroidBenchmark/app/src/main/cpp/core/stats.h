#pragma once

#include <vector>

namespace native_benchmark {

struct TrialStats {
    int frames = 0;
    double durationMs = 0;
    double meanMs = 0;
    double p50Ms = 0;
    double p95Ms = 0;
    double p99Ms = 0;
    double fpsEffective = 0;
    double fpsFromMean = 0;
    double maxFrameMs = 0;
    double jankP99OverP50 = 0;
    int missed1p5x = 0;
    double missed1p5xPct = 0;
    int missed2x = 0;
    double targetMs = 0;
};

double nearestTargetMs(double p50);
TrialStats computeTrialStats(const std::vector<double>& frameTimes, double durationMs);

}  // namespace native_benchmark
