#include "core/benchmark_plan.h"

#include "core/simple_json.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <set>
#include <sstream>
#include <stdexcept>

namespace native_benchmark {
namespace {

using json::Value;

const std::string& requiredString(const Value& root, std::string_view key) {
    const std::string& value = root.at(key).asString();
    if (value.empty()) throw json::Error("field `" + std::string(key) + "` must not be empty");
    return value;
}

double requiredNumber(const Value& root, std::string_view key, double minimum) {
    const double value = root.at(key).asNumber();
    if (!std::isfinite(value) || value < minimum) {
        throw json::Error("field `" + std::string(key) + "` is out of range");
    }
    return value;
}

int requiredInteger(const Value& root, std::string_view key, int minimum) {
    const double value = requiredNumber(root, key, static_cast<double>(minimum));
    if (std::floor(value) != value
        || value > static_cast<double>(std::numeric_limits<int>::max())) {
        throw json::Error("field `" + std::string(key) + "` must be an integer");
    }
    return static_cast<int>(value);
}

bool containsMaterial(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
        return static_cast<char>(std::toupper(character));
    });
    return value.find("MATERIAL") != std::string::npos;
}

}  // namespace

std::size_t BenchmarkPlan::conditionCount() const {
    return instances.size() * static_cast<std::size_t>(trialsPerInstance);
}

std::string BenchmarkPlan::describe() const {
    std::ostringstream output;
    output
        << "Plan valid: " << planId
        << "\ndevice=" << deviceGroup
        << " mode=" << mode
        << " surface=" << surfaceMode
        << " renderScale=" << renderScale
        << "\nruns=" << runs.size()
        << " conditions/run=" << conditionCount()
        << " total records=" << runs.size() * conditionCount();
    return output.str();
}

BenchmarkPlan parseBenchmarkPlan(std::string_view source) {
    const Value root = json::parse(source);
    root.asObject();

    BenchmarkPlan plan;
    plan.schema = requiredString(root, "schema");
    if (plan.schema != "native-benchmark-manifest/v1") {
        throw json::Error("unsupported native plan schema `" + plan.schema + "`");
    }
    plan.planId = requiredString(root, "plan_id");
    plan.sourceManifest = requiredString(root, "source_manifest");
    plan.sourceHarnessCommit = requiredString(root, "source_harness_commit");
    plan.sourceHarnessVersion = requiredString(root, "source_harness_version");
    plan.assetRevision = requiredString(root, "asset_revision");
    plan.deviceGroup = requiredString(root, "device_group");
    plan.cohortGroup = requiredString(root, "cohort_group");
    plan.runtimeFamily = requiredString(root, "runtime_family");
    plan.api = requiredString(root, "api");
    plan.mode = requiredString(root, "mode");
    plan.surfaceMode = requiredString(root, "surface_mode");
    plan.layout = requiredString(root, "layout");

    if (plan.runtimeFamily != "native-android") {
        throw json::Error("Android build requires runtime_family=native-android");
    }
    if (plan.api != "vulkan") {
        throw json::Error("Android build requires api=vulkan");
    }
    if (plan.mode != "canvas") {
        throw json::Error("phoneWindow build requires mode=canvas");
    }
    if (plan.surfaceMode != "flat" && plan.surfaceMode != "basecolor") {
        throw json::Error("surface_mode must be flat or basecolor");
    }

    plan.renderScale = requiredNumber(root, "render_scale", std::numeric_limits<double>::min());
    if (plan.renderScale > 1) throw json::Error("render_scale must be at most 1");
    plan.spacing = requiredNumber(root, "spacing", std::numeric_limits<double>::min());
    plan.trialsPerInstance = requiredInteger(root, "trials_per_instance", 1);
    plan.durationMs = requiredNumber(root, "duration_ms", std::numeric_limits<double>::min());
    plan.warmupMs = requiredNumber(root, "warmup_ms", 0);
    plan.cooldownMs = requiredNumber(root, "cooldown_ms", 0);
    plan.betweenInstancesMs = requiredNumber(root, "between_instances_ms", 0);
    plan.betweenRunsMs = requiredNumber(root, "between_runs_ms", 0);
    plan.minFrames = requiredInteger(root, "min_frames", 1);
    const int seed = requiredInteger(root, "seed", 0);
    plan.seed = static_cast<std::uint32_t>(seed);
    plan.shuffle = root.at("shuffle").asBool();

    std::set<int> instanceSet;
    for (const Value& value : root.at("instances").asArray()) {
        const double instanceValue = value.asNumber();
        if (!std::isfinite(instanceValue)
            || instanceValue < 1
            || std::floor(instanceValue) != instanceValue
            || instanceValue > static_cast<double>(std::numeric_limits<int>::max())) {
            throw json::Error("instances must contain positive integers");
        }
        const int instances = static_cast<int>(instanceValue);
        if (!instanceSet.insert(instances).second) {
            throw json::Error("instances must not contain duplicates");
        }
        plan.instances.push_back(instances);
    }
    if (plan.instances.empty()) throw json::Error("instances must not be empty");

    const int declaredRunCount = requiredInteger(root, "run_count", 1);
    std::set<std::string> runIds;
    for (const Value& value : root.at("runs").asArray()) {
        const int runNumber = requiredInteger(value, "run_number", 1);
        const std::string runId = requiredString(value, "run_id");
        const std::string suiteId = requiredString(value, "suite_id");
        if (!runIds.insert(runId).second) {
            throw json::Error("duplicate run_id `" + runId + "`");
        }
        const bool materialSuite = containsMaterial(suiteId);
        if (materialSuite && plan.surfaceMode != "basecolor") {
            throw json::Error("MATERIAL suite requires surface_mode=basecolor");
        }
        if (!materialSuite && plan.surfaceMode == "basecolor") {
            throw json::Error("basecolor requires a MATERIAL suite ID");
        }
        plan.runs.push_back({runNumber, runId, suiteId});
    }
    if (static_cast<int>(plan.runs.size()) != declaredRunCount) {
        throw json::Error("run_count does not match runs array");
    }
    std::sort(plan.runs.begin(), plan.runs.end(), [](const PlanRun& left, const PlanRun& right) {
        return left.runNumber < right.runNumber;
    });
    for (std::size_t index = 0; index < plan.runs.size(); ++index) {
        if (plan.runs[index].runNumber != static_cast<int>(index + 1)) {
            throw json::Error("run_number values must be contiguous from 1");
        }
    }
    return plan;
}

}  // namespace native_benchmark
