#include "core/benchmark_plan.h"
#include "asset/glb_loader.h"
#include "core/condition_plan.h"
#include "core/instance_layout.h"
#include "core/simple_json.h"
#include "core/stats.h"

#include <cmath>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

void requireNear(double actual, double expected, double tolerance, const std::string& message) {
    if (std::abs(actual - expected) > tolerance) {
        std::ostringstream output;
        output << message << ": expected " << expected << ", found " << actual;
        throw std::runtime_error(output.str());
    }
}

std::string readFile(const std::string& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("could not open " + path);
    return {
        std::istreambuf_iterator<char>(input),
        std::istreambuf_iterator<char>(),
    };
}

std::vector<std::uint8_t> readBinaryFile(const std::string& path) {
    const std::string source = readFile(path);
    return {source.begin(), source.end()};
}

void testAsset(const std::string& path) {
    const std::vector<std::uint8_t> bytes = readBinaryFile(path);
    const native_benchmark::GlbMesh mesh = native_benchmark::loadGlbMesh(bytes);
    require(mesh.meta.vertexCount == 167495, "GLB vertex count");
    require(mesh.meta.indexCount == 825420, "GLB index count");
    require(mesh.meta.triangleCount == 275140, "GLB triangle count");
    require(mesh.meta.primitiveCount == 15, "GLB primitive count");
    require(mesh.meta.texturedPrimitiveCount == 11, "GLB textured primitive count");
    require(mesh.meta.materialCount == 15, "GLB material count");
    require(mesh.meta.imageCount == 18, "GLB image count");
    require(mesh.meta.textureCount == 18, "GLB texture count");
    require(mesh.meta.materialTextureCount == 9, "GLB material texture count");
    requireNear(mesh.meta.normScale, 0.55215367, 1e-6, "GLB normalization scale");
    requireNear(mesh.meta.normCenter[0], 0, 1e-6, "GLB center x");
    requireNear(mesh.meta.normCenter[1], 0.903836, 1e-6, "GLB center y");
    requireNear(mesh.meta.normCenter[2], 0.01110858, 1e-6, "GLB center z");
}

void testPlans(int argumentCount, char** arguments) {
    require(argumentCount > 2, "expected asset and native plan paths");
    for (int index = 2; index < argumentCount; ++index) {
        const std::string path = arguments[index];
        const native_benchmark::BenchmarkPlan plan =
            native_benchmark::parseBenchmarkPlan(readFile(path));
        require(plan.api == "vulkan", "plan API must be Vulkan");
        require(plan.runtimeFamily == "native-android", "runtime family mismatch");
        const bool smoke = path.find("_smoke_") != std::string::npos;
        require(
            plan.runs.size() == (smoke ? 1 : 5),
            smoke ? "smoke plan must contain one run" : "full plan must contain five runs"
        );
        if (smoke) require(plan.conditionCount() == 1, "smoke plan must have one condition");
        require(plan.conditionCount() > 0, "plan must have conditions");
        if (plan.deviceGroup == "pixel8a") {
            requireNear(plan.renderScale, 0.5, 1e-9, "Pixel render scale");
        } else if (plan.deviceGroup == "samsung_fe5g") {
            requireNear(plan.renderScale, 0.75, 1e-9, "Samsung render scale");
        } else {
            throw std::runtime_error("unexpected Android device group");
        }
        const bool material = plan.cohortGroup.find("material") != std::string::npos;
        require(
            plan.surfaceMode == (material ? "basecolor" : "flat"),
            "flat/material plan mismatch"
        );
    }
}

void testConditionGolden() {
    const std::vector<std::pair<int, int>> expected = {
        {2, 1}, {4, 3}, {16, 5}, {16, 4}, {1, 1}, {1, 3},
        {1, 5}, {8, 1}, {2, 3}, {32, 1}, {4, 2}, {8, 5},
        {4, 5}, {2, 2}, {1, 4}, {4, 1}, {8, 4}, {8, 2},
        {16, 1}, {2, 5}, {32, 2}, {16, 2}, {8, 3}, {1, 2},
        {32, 4}, {32, 3}, {16, 3}, {4, 4}, {2, 4}, {32, 5},
    };
    const std::vector<native_benchmark::Condition> actual =
        native_benchmark::buildConditionPlan(
            {1, 2, 4, 8, 16, 32},
            5,
            true,
            12345
        );
    require(actual.size() == expected.size(), "condition count mismatch");
    for (std::size_t index = 0; index < expected.size(); ++index) {
        require(actual[index].instances == expected[index].first, "instance order mismatch");
        require(actual[index].trial == expected[index].second, "trial order mismatch");
        require(
            actual[index].conditionIndex == static_cast<int>(index),
            "condition index mismatch"
        );
    }
}

void testLayoutGolden() {
    const std::vector<native_benchmark::InstanceOffset> offsets =
        native_benchmark::xrwallOffsets(4, 0.35F);
    require(offsets.size() == 4, "xrwall offset count mismatch");
    requireNear(offsets[0].x, -0.35, 1e-6, "offset 0 x");
    requireNear(offsets[0].y, 0.175, 1e-6, "offset 0 y");
    requireNear(offsets[2].x, 0.35, 1e-6, "offset 2 x");
    requireNear(offsets[3].x, -0.35, 1e-6, "offset 3 x");
    requireNear(offsets[3].y, -0.175, 1e-6, "offset 3 y");
}

void testStatsGolden() {
    const native_benchmark::TrialStats stats = native_benchmark::computeTrialStats(
        {8, 8.5, 9, 16.5, 17, 18, 34, 40},
        8000
    );
    require(stats.frames == 8, "frame count mismatch");
    requireNear(stats.meanMs, 18.875, 1e-9, "mean");
    requireNear(stats.p50Ms, 16.5, 1e-9, "p50");
    requireNear(stats.p95Ms, 34, 1e-9, "p95");
    requireNear(stats.p99Ms, 34, 1e-9, "p99");
    requireNear(stats.fpsEffective, 1, 1e-9, "effective FPS");
    require(stats.missed1p5x == 2, "missed 1.5x count");
    require(stats.missed2x == 2, "missed 2x count");
}

void testStrictJson() {
    bool duplicateRejected = false;
    try {
        (void)native_benchmark::json::parse(R"({"value":1,"value":2})");
    } catch (const native_benchmark::json::Error&) {
        duplicateRejected = true;
    }
    require(duplicateRejected, "JSON parser must reject duplicate keys");

    bool trailingRejected = false;
    try {
        (void)native_benchmark::json::parse(R"({"value":1} trailing)");
    } catch (const native_benchmark::json::Error&) {
        trailingRejected = true;
    }
    require(trailingRejected, "JSON parser must reject trailing content");
}

}  // namespace

int main(int argumentCount, char** arguments) {
    try {
        testAsset(arguments[1]);
        testPlans(argumentCount, arguments);
        testConditionGolden();
        testLayoutGolden();
        testStatsGolden();
        testStrictJson();
        std::cout
            << "Android native core tests passed: GLB parity, plans, condition "
            << "order, xrwall layout, stats, strict JSON\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Android native core test failed: " << error.what() << '\n';
        return 1;
    }
}
