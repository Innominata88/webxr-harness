#include <jni.h>

#include <android/asset_manager.h>
#include <android/asset_manager_jni.h>
#include <android/native_window.h>
#include <android/native_window_jni.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "asset/glb_loader.h"
#include "core/benchmark_plan.h"
#include "render/vulkan_renderer.h"
#include "runtime/vulkan_probe.h"

namespace {

std::mutex windowMutex;
ANativeWindow* currentWindow = nullptr;
int surfaceWidth = 0;
int surfaceHeight = 0;
std::uint64_t surfaceGeneration = 0;
std::unique_ptr<native_benchmark::VulkanRenderer> currentRenderer;
std::string rendererError = "preview is not running";

jstring toJavaString(JNIEnv* environment, const std::string& value) {
    return environment->NewStringUTF(value.c_str());
}

std::string fromJavaString(JNIEnv* environment, jstring value) {
    if (value == nullptr) return {};
    const char* characters = environment->GetStringUTFChars(value, nullptr);
    if (characters == nullptr) throw std::runtime_error("could not read Java string");
    std::string result(characters);
    environment->ReleaseStringUTFChars(value, characters);
    return result;
}

std::string readAsset(
    JNIEnv* environment,
    jobject assetManagerObject,
    const std::string& path
) {
    AAssetManager* manager = AAssetManager_fromJava(environment, assetManagerObject);
    if (manager == nullptr) throw std::runtime_error("Android AssetManager is unavailable");
    AAsset* asset = AAssetManager_open(manager, path.c_str(), AASSET_MODE_BUFFER);
    if (asset == nullptr) throw std::runtime_error("asset not found: " + path);
    const std::int64_t length = AAsset_getLength64(asset);
    if (length < 0) {
        AAsset_close(asset);
        throw std::runtime_error("invalid asset length: " + path);
    }
    std::vector<char> bytes(static_cast<std::size_t>(length));
    std::size_t offset = 0;
    while (offset < bytes.size()) {
        const int count = AAsset_read(
            asset,
            bytes.data() + offset,
            bytes.size() - offset
        );
        if (count <= 0) {
            AAsset_close(asset);
            throw std::runtime_error("could not read complete asset: " + path);
        }
        offset += static_cast<std::size_t>(count);
    }
    AAsset_close(asset);
    return std::string(bytes.begin(), bytes.end());
}

}  // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeInitialize(
    JNIEnv*,
    jclass,
    jobject
) {}

extern "C" JNIEXPORT void JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeSetSurface(
    JNIEnv* environment,
    jclass,
    jobject surface
) {
    std::lock_guard lock(windowMutex);
    currentRenderer.reset();
    rendererError = "preview stopped because the Android surface changed";
    if (currentWindow != nullptr) {
        ANativeWindow_release(currentWindow);
        currentWindow = nullptr;
    }
    if (surface != nullptr) {
        currentWindow = ANativeWindow_fromSurface(environment, surface);
    }
    ++surfaceGeneration;
}

extern "C" JNIEXPORT void JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeSetSurfaceSize(
    JNIEnv*,
    jclass,
    jint width,
    jint height
) {
    std::lock_guard lock(windowMutex);
    surfaceWidth = width;
    surfaceHeight = height;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeValidatePlan(
    JNIEnv* environment,
    jclass,
    jobject assetManager,
    jstring assetPath
) {
    try {
        const std::string path = fromJavaString(environment, assetPath);
        const std::string source = readAsset(environment, assetManager, path);
        const native_benchmark::BenchmarkPlan plan =
            native_benchmark::parseBenchmarkPlan(source);
        return toJavaString(environment, plan.describe());
    } catch (const std::exception& error) {
        return toJavaString(environment, std::string("Plan rejected: ") + error.what());
    }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeInspectAsset(
    JNIEnv* environment,
    jclass,
    jobject assetManager,
    jstring assetPath
) {
    try {
        const std::string path = fromJavaString(environment, assetPath);
        const std::string source = readAsset(environment, assetManager, path);
        const auto* begin = reinterpret_cast<const std::uint8_t*>(source.data());
        const native_benchmark::GlbMesh mesh = native_benchmark::loadGlbMesh({
            begin,
            source.size(),
        });
        const native_benchmark::GlbMetadata& meta = mesh.meta;
        return toJavaString(
            environment,
            "GLB valid"
                "\nvertices=" + std::to_string(meta.vertexCount)
                + " indices=" + std::to_string(meta.indexCount)
                + " triangles=" + std::to_string(meta.triangleCount)
                + "\nprimitives=" + std::to_string(meta.primitiveCount)
                + " textured=" + std::to_string(meta.texturedPrimitiveCount)
                + " baseColorTextures=" + std::to_string(meta.materialTextureCount)
                + "\nnormScale=" + std::to_string(meta.normScale)
        );
    } catch (const std::exception& error) {
        return toJavaString(environment, std::string("GLB rejected: ") + error.what());
    }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeProbeVulkan(
    JNIEnv* environment,
    jclass
) {
    ANativeWindow* window = nullptr;
    {
        std::lock_guard lock(windowMutex);
        window = currentWindow;
        if (window != nullptr) ANativeWindow_acquire(window);
    }
    std::string result = native_benchmark::probeVulkan(window);
    if (window != nullptr) ANativeWindow_release(window);
    {
        std::lock_guard lock(windowMutex);
        if (!result.empty() && result.back() == '}') {
            result.pop_back();
            result += ",\"reported_surface_width\":" + std::to_string(surfaceWidth)
                + ",\"reported_surface_height\":" + std::to_string(surfaceHeight)
                + '}';
        }
    }
    return toJavaString(environment, result);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeStartPreview(
    JNIEnv* environment,
    jclass,
    jobject assetManagerObject,
    jstring planAssetPath,
    jint instanceCount
) {
    try {
        AAssetManager* assetManager =
            AAssetManager_fromJava(environment, assetManagerObject);
        if (assetManager == nullptr) {
            throw std::runtime_error("Android AssetManager is unavailable");
        }

        const std::string planPath = fromJavaString(environment, planAssetPath);
        const native_benchmark::BenchmarkPlan plan =
            native_benchmark::parseBenchmarkPlan(
                readAsset(environment, assetManagerObject, planPath)
            );
        const std::string modelSource =
            readAsset(environment, assetManagerObject, "benchmark/model.glb");
        const auto* modelBegin =
            reinterpret_cast<const std::uint8_t*>(modelSource.data());
        native_benchmark::GlbMesh mesh = native_benchmark::loadGlbMesh({
            modelBegin,
            modelSource.size(),
        });

        ANativeWindow* window = nullptr;
        std::uint64_t generation = 0;
        {
            std::lock_guard lock(windowMutex);
            currentRenderer.reset();
            if (currentWindow == nullptr) {
                throw std::runtime_error("Android surface is not ready");
            }
            window = currentWindow;
            ANativeWindow_acquire(window);
            generation = surfaceGeneration;
        }

        std::unique_ptr<native_benchmark::VulkanRenderer> renderer;
        try {
            renderer = native_benchmark::VulkanRenderer::create(
                window,
                assetManager,
                std::move(mesh),
                plan.surfaceMode,
                plan.renderScale,
                static_cast<int>(instanceCount),
                static_cast<float>(plan.spacing)
            );
        } catch (...) {
            ANativeWindow_release(window);
            throw;
        }
        ANativeWindow_release(window);

        const std::string description = renderer->describe();
        {
            std::lock_guard lock(windowMutex);
            if (generation != surfaceGeneration || currentWindow == nullptr) {
                throw std::runtime_error(
                    "Android surface changed while the preview was starting"
                );
            }
            currentRenderer = std::move(renderer);
            rendererError.clear();
        }
        return toJavaString(environment, description);
    } catch (const std::exception& error) {
        const std::string message = std::string("Preview rejected: ") + error.what();
        {
            std::lock_guard lock(windowMutex);
            rendererError = message;
        }
        return toJavaString(environment, message);
    }
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeRenderFrame(
    JNIEnv*,
    jclass,
    jlong frameTimeNanos
) {
    std::lock_guard lock(windowMutex);
    if (currentRenderer == nullptr) {
        if (rendererError.empty()) rendererError = "preview is not running";
        return JNI_FALSE;
    }
    if (!currentRenderer->draw(static_cast<std::uint64_t>(frameTimeNanos))) {
        rendererError = currentRenderer->lastError();
        currentRenderer.reset();
        return JNI_FALSE;
    }
    return JNI_TRUE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeRendererLastError(
    JNIEnv* environment,
    jclass
) {
    std::lock_guard lock(windowMutex);
    return toJavaString(
        environment,
        rendererError.empty() ? "preview is not running" : rendererError
    );
}

extern "C" JNIEXPORT void JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeStopPreview(
    JNIEnv*,
    jclass
) {
    std::lock_guard lock(windowMutex);
    currentRenderer.reset();
    rendererError = "preview stopped";
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeCoreVersion(
    JNIEnv* environment,
    jclass
) {
    return toJavaString(environment, "android-core/0.2.0-preview");
}

extern "C" JNIEXPORT void JNICALL
Java_com_innominata_nativebenchmark_BenchmarkActivity_nativeShutdown(
    JNIEnv*,
    jclass
) {
    std::lock_guard lock(windowMutex);
    currentRenderer.reset();
    rendererError = "native runtime shut down";
    if (currentWindow != nullptr) {
        ANativeWindow_release(currentWindow);
        currentWindow = nullptr;
    }
    surfaceWidth = 0;
    surfaceHeight = 0;
    ++surfaceGeneration;
}
