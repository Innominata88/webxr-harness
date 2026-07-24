#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <span>
#include <string>
#include <vector>

namespace native_benchmark {

struct GlbSampler {
    int magFilter = 0;
    int minFilter = 0;
    int wrapS = 10497;
    int wrapT = 10497;
};

struct GlbTexture {
    std::vector<std::uint8_t> encodedData;
    std::string mimeType;
    GlbSampler sampler;
};

struct GlbMaterialPrimitive {
    std::vector<float> positions;
    std::vector<float> texcoords;
    std::vector<std::uint32_t> indices;
    std::array<float, 4> baseColorFactor = {1, 1, 1, 1};
    int baseColorTextureIndex = -1;
};

struct GlbMetadata {
    std::size_t vertexCount = 0;
    std::size_t indexCount = 0;
    std::size_t triangleCount = 0;
    std::size_t primitiveCount = 0;
    std::size_t texturedPrimitiveCount = 0;
    std::size_t materialCount = 0;
    std::size_t imageCount = 0;
    std::size_t textureCount = 0;
    std::size_t materialTextureCount = 0;
    float normScale = 1;
    std::array<float, 3> normCenter = {0, 0, 0};
    float normMaxDim = 0;
};

struct GlbMesh {
    std::vector<float> positions;
    std::vector<std::uint32_t> indices;
    std::vector<GlbMaterialPrimitive> materialPrimitives;
    std::map<int, GlbTexture> textures;
    GlbMetadata meta;
};

GlbMesh loadGlbMesh(std::span<const std::uint8_t> bytes);

}  // namespace native_benchmark
