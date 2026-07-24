#pragma once

#include <android/asset_manager.h>
#include <android/native_window.h>

#include <cstdint>
#include <memory>
#include <string>

#include "asset/glb_loader.h"

namespace native_benchmark {

class VulkanRenderer {
public:
    static std::unique_ptr<VulkanRenderer> create(
        ANativeWindow* window,
        AAssetManager* assets,
        GlbMesh mesh,
        const std::string& surfaceMode,
        double renderScale,
        int instanceCount,
        float spacing
    );

    ~VulkanRenderer();
    VulkanRenderer(const VulkanRenderer&) = delete;
    VulkanRenderer& operator=(const VulkanRenderer&) = delete;

    bool draw(std::uint64_t frameTimeNanos);
    const std::string& lastError() const;
    std::string describe() const;

private:
    class Impl;
    explicit VulkanRenderer(std::unique_ptr<Impl> implementation);
    std::unique_ptr<Impl> implementation_;
};

}  // namespace native_benchmark
