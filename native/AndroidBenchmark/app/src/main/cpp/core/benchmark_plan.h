#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace native_benchmark {

struct PlanRun {
    int runNumber = 0;
    std::string runId;
    std::string suiteId;
};

struct BenchmarkPlan {
    std::string schema;
    std::string planId;
    std::string sourceManifest;
    std::string sourceHarnessCommit;
    std::string sourceHarnessVersion;
    std::string assetRevision;
    std::string deviceGroup;
    std::string cohortGroup;
    std::string runtimeFamily;
    std::string api;
    std::string mode;
    std::string surfaceMode;
    std::string layout;
    double renderScale = 0;
    double spacing = 0;
    std::vector<int> instances;
    int trialsPerInstance = 0;
    double durationMs = 0;
    double warmupMs = 0;
    double cooldownMs = 0;
    double betweenInstancesMs = 0;
    double betweenRunsMs = 0;
    int minFrames = 0;
    std::uint32_t seed = 0;
    bool shuffle = false;
    std::vector<PlanRun> runs;

    std::size_t conditionCount() const;
    std::string describe() const;
};

BenchmarkPlan parseBenchmarkPlan(std::string_view source);

}  // namespace native_benchmark
