#include "asset/glb_loader.h"

#include "core/simple_json.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace native_benchmark {
namespace {

using json::Value;
using ByteSpan = std::span<const std::uint8_t>;

constexpr std::uint32_t kGlbMagic = 0x46546C67;
constexpr std::uint32_t kJsonChunk = 0x4E4F534A;
constexpr std::uint32_t kBinChunk = 0x004E4942;

struct RawPrimitive {
    std::vector<float> positions;
    std::vector<float> texcoords;
    std::vector<std::uint32_t> indices;
    int materialIndex = -1;
};

struct Normalization {
    float scale = 1;
    std::array<float, 3> center = {0, 0, 0};
    float maxDim = 0;
};

std::uint32_t readU32(ByteSpan bytes, std::size_t offset) {
    if (offset > bytes.size() || bytes.size() - offset < 4) {
        throw std::runtime_error("GLB buffer data is out of range");
    }
    return static_cast<std::uint32_t>(bytes[offset])
        | (static_cast<std::uint32_t>(bytes[offset + 1]) << 8U)
        | (static_cast<std::uint32_t>(bytes[offset + 2]) << 16U)
        | (static_cast<std::uint32_t>(bytes[offset + 3]) << 24U);
}

std::uint16_t readU16(ByteSpan bytes, std::size_t offset) {
    if (offset > bytes.size() || bytes.size() - offset < 2) {
        throw std::runtime_error("GLB buffer data is out of range");
    }
    return static_cast<std::uint16_t>(bytes[offset])
        | static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[offset + 1]) << 8U);
}

std::uint8_t readU8(ByteSpan bytes, std::size_t offset) {
    if (offset >= bytes.size()) throw std::runtime_error("GLB buffer data is out of range");
    return bytes[offset];
}

int asInteger(const Value& value, const std::string& label, int minimum = 0) {
    const double number = value.asNumber();
    if (!std::isfinite(number)
        || std::floor(number) != number
        || number < minimum
        || number > static_cast<double>(std::numeric_limits<int>::max())) {
        throw std::runtime_error(label + " must be an integer");
    }
    return static_cast<int>(number);
}

int requiredInteger(const Value& object, std::string_view key, int minimum = 0) {
    return asInteger(object.at(key), std::string(key), minimum);
}

int optionalInteger(
    const Value& object,
    std::string_view key,
    int fallback,
    int minimum = 0
) {
    const Value* value = object.find(key);
    return value == nullptr ? fallback : asInteger(*value, std::string(key), minimum);
}

std::size_t componentCount(const std::string& type) {
    if (type == "SCALAR") return 1;
    if (type == "VEC2") return 2;
    if (type == "VEC3") return 3;
    if (type == "VEC4") return 4;
    throw std::runtime_error("unsupported accessor type " + type);
}

std::size_t bytesPerComponent(int componentType) {
    switch (componentType) {
        case 5120:
        case 5121: return 1;
        case 5122:
        case 5123: return 2;
        case 5125:
        case 5126: return 4;
        default:
            throw std::runtime_error(
                "unsupported accessor component type " + std::to_string(componentType)
            );
    }
}

const Value& indexed(
    const Value::Array& values,
    int index,
    const std::string& label
) {
    if (index < 0 || static_cast<std::size_t>(index) >= values.size()) {
        throw std::runtime_error(label + " index is out of range");
    }
    return values[static_cast<std::size_t>(index)];
}

float readFloatComponent(
    ByteSpan bytes,
    std::size_t offset,
    int componentType,
    bool normalized
) {
    switch (componentType) {
        case 5126: {
            const std::uint32_t bits = readU32(bytes, offset);
            float value = 0;
            static_assert(sizeof(value) == sizeof(bits));
            std::memcpy(&value, &bits, sizeof(value));
            return value;
        }
        case 5121: {
            const std::uint8_t value = readU8(bytes, offset);
            return normalized
                ? static_cast<float>(value) / 255.0F
                : static_cast<float>(value);
        }
        case 5123: {
            const std::uint16_t value = readU16(bytes, offset);
            return normalized
                ? static_cast<float>(value) / 65535.0F
                : static_cast<float>(value);
        }
        case 5120: {
            const auto value = static_cast<std::int8_t>(readU8(bytes, offset));
            return normalized
                ? std::max(static_cast<float>(value) / 127.0F, -1.0F)
                : static_cast<float>(value);
        }
        case 5122: {
            const auto value = static_cast<std::int16_t>(readU16(bytes, offset));
            return normalized
                ? std::max(static_cast<float>(value) / 32767.0F, -1.0F)
                : static_cast<float>(value);
        }
        default:
            throw std::runtime_error("unsupported float accessor component");
    }
}

std::uint32_t readIndexComponent(
    ByteSpan bytes,
    std::size_t offset,
    int componentType
) {
    switch (componentType) {
        case 5125: return readU32(bytes, offset);
        case 5123: return readU16(bytes, offset);
        case 5121: return readU8(bytes, offset);
        default: throw std::runtime_error("unsupported index accessor component");
    }
}

struct AccessorView {
    const Value& accessor;
    const Value& bufferView;
    std::size_t count;
    std::size_t components;
    int componentType;
    std::size_t componentBytes;
    std::size_t byteOffset;
    std::size_t byteStride;
    bool normalized;
};

AccessorView accessorView(
    const Value::Array& accessors,
    const Value::Array& bufferViews,
    int accessorIndex
) {
    const Value& accessor = indexed(accessors, accessorIndex, "accessor");
    const int viewIndex = requiredInteger(accessor, "bufferView");
    const Value& view = indexed(bufferViews, viewIndex, "bufferView");
    const std::size_t count = static_cast<std::size_t>(
        requiredInteger(accessor, "count", 1)
    );
    const std::string& type = accessor.at("type").asString();
    const std::size_t components = componentCount(type);
    const int componentType = requiredInteger(accessor, "componentType");
    const std::size_t componentBytes = bytesPerComponent(componentType);
    const std::size_t viewOffset = static_cast<std::size_t>(
        optionalInteger(view, "byteOffset", 0)
    );
    const std::size_t accessorOffset = static_cast<std::size_t>(
        optionalInteger(accessor, "byteOffset", 0)
    );
    const std::size_t packedStride = componentBytes * components;
    const std::size_t stride = static_cast<std::size_t>(
        optionalInteger(view, "byteStride", static_cast<int>(packedStride), 1)
    );
    if (stride < packedStride) throw std::runtime_error("accessor byteStride is too small");
    const Value* normalizedValue = accessor.find("normalized");
    const bool normalized = normalizedValue != nullptr && normalizedValue->asBool();
    return {
        accessor,
        view,
        count,
        components,
        componentType,
        componentBytes,
        viewOffset + accessorOffset,
        stride,
        normalized,
    };
}

std::vector<float> readAccessorFloats(
    const Value::Array& accessors,
    const Value::Array& bufferViews,
    ByteSpan bin,
    int accessorIndex
) {
    const AccessorView view = accessorView(accessors, bufferViews, accessorIndex);
    std::vector<float> output;
    output.reserve(view.count * view.components);
    for (std::size_t element = 0; element < view.count; ++element) {
        const std::size_t elementOffset = view.byteOffset + element * view.byteStride;
        for (std::size_t component = 0; component < view.components; ++component) {
            output.push_back(readFloatComponent(
                bin,
                elementOffset + component * view.componentBytes,
                view.componentType,
                view.normalized
            ));
        }
    }
    return output;
}

std::vector<std::uint32_t> readAccessorIndices(
    const Value::Array& accessors,
    const Value::Array& bufferViews,
    ByteSpan bin,
    int accessorIndex
) {
    const AccessorView view = accessorView(accessors, bufferViews, accessorIndex);
    if (view.components != 1) throw std::runtime_error("index accessor must be SCALAR");
    std::vector<std::uint32_t> output;
    output.reserve(view.count);
    for (std::size_t element = 0; element < view.count; ++element) {
        output.push_back(readIndexComponent(
            bin,
            view.byteOffset + element * view.byteStride,
            view.componentType
        ));
    }
    return output;
}

std::vector<RawPrimitive> collectPrimitives(const Value& root, ByteSpan bin) {
    const Value::Array& meshes = root.at("meshes").asArray();
    const Value::Array& accessors = root.at("accessors").asArray();
    const Value::Array& bufferViews = root.at("bufferViews").asArray();
    std::vector<RawPrimitive> output;

    for (const Value& mesh : meshes) {
        for (const Value& primitive : mesh.at("primitives").asArray()) {
            const int mode = optionalInteger(primitive, "mode", 4);
            if (mode != 4) throw std::runtime_error("benchmark GLB requires triangle primitives");
            const Value& attributes = primitive.at("attributes");
            const Value* positionValue = attributes.find("POSITION");
            if (positionValue == nullptr) continue;
            const int positionAccessor = asInteger(*positionValue, "POSITION accessor");
            std::vector<float> positions = readAccessorFloats(
                accessors,
                bufferViews,
                bin,
                positionAccessor
            );
            if (positions.size() % 3 != 0 || positions.empty()) {
                throw std::runtime_error("POSITION accessor must be nonempty VEC3 data");
            }
            const std::size_t vertexCount = positions.size() / 3;

            std::vector<float> texcoords;
            if (const Value* texcoordValue = attributes.find("TEXCOORD_0")) {
                texcoords = readAccessorFloats(
                    accessors,
                    bufferViews,
                    bin,
                    asInteger(*texcoordValue, "TEXCOORD_0 accessor")
                );
            }
            if (texcoords.size() != vertexCount * 2) {
                texcoords.assign(vertexCount * 2, 0);
            }

            std::vector<std::uint32_t> indices;
            if (const Value* indexValue = primitive.find("indices")) {
                indices = readAccessorIndices(
                    accessors,
                    bufferViews,
                    bin,
                    asInteger(*indexValue, "indices accessor")
                );
            } else {
                indices.reserve(vertexCount);
                for (std::size_t index = 0; index < vertexCount; ++index) {
                    indices.push_back(static_cast<std::uint32_t>(index));
                }
            }
            output.push_back({
                std::move(positions),
                std::move(texcoords),
                std::move(indices),
                optionalInteger(primitive, "material", -1, -1),
            });
        }
    }
    return output;
}

Normalization calculateNormalization(const std::vector<float>& positions) {
    std::array<float, 3> minimum = {
        std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::infinity(),
    };
    std::array<float, 3> maximum = {
        -std::numeric_limits<float>::infinity(),
        -std::numeric_limits<float>::infinity(),
        -std::numeric_limits<float>::infinity(),
    };
    for (std::size_t index = 0; index < positions.size(); index += 3) {
        for (std::size_t component = 0; component < 3; ++component) {
            minimum[component] = std::min(minimum[component], positions[index + component]);
            maximum[component] = std::max(maximum[component], positions[index + component]);
        }
    }
    Normalization result;
    std::array<float, 3> dimensions{};
    for (std::size_t component = 0; component < 3; ++component) {
        result.center[component] = (minimum[component] + maximum[component]) / 2;
        dimensions[component] = maximum[component] - minimum[component];
    }
    result.maxDim = std::max({dimensions[0], dimensions[1], dimensions[2]});
    result.scale = result.maxDim > 0 ? 1.0F / result.maxDim : 1;
    return result;
}

std::vector<float> normalize(
    const std::vector<float>& positions,
    const Normalization& normalization
) {
    std::vector<float> output(positions.size());
    for (std::size_t index = 0; index < positions.size(); index += 3) {
        for (std::size_t component = 0; component < 3; ++component) {
            output[index + component] =
                (positions[index + component] - normalization.center[component])
                * normalization.scale;
        }
    }
    return output;
}

std::vector<GlbMaterialPrimitive> buildMaterialPrimitives(
    const std::vector<RawPrimitive>& rawPrimitives,
    const Value::Array& materials,
    const Normalization& normalization
) {
    std::vector<GlbMaterialPrimitive> output;
    output.reserve(rawPrimitives.size());
    for (const RawPrimitive& raw : rawPrimitives) {
        GlbMaterialPrimitive primitive;
        primitive.positions = normalize(raw.positions, normalization);
        primitive.texcoords = raw.texcoords;
        primitive.indices = raw.indices;
        if (raw.materialIndex >= 0
            && static_cast<std::size_t>(raw.materialIndex) < materials.size()) {
            const Value& material = materials[static_cast<std::size_t>(raw.materialIndex)];
            if (const Value* pbr = material.find("pbrMetallicRoughness")) {
                if (const Value* factor = pbr->find("baseColorFactor")) {
                    const Value::Array& values = factor->asArray();
                    for (std::size_t component = 0;
                         component < primitive.baseColorFactor.size() && component < values.size();
                         ++component) {
                        primitive.baseColorFactor[component] =
                            static_cast<float>(values[component].asNumber());
                    }
                }
                if (const Value* texture = pbr->find("baseColorTexture")) {
                    primitive.baseColorTextureIndex =
                        requiredInteger(*texture, "index");
                }
            }
        }
        output.push_back(std::move(primitive));
    }
    return output;
}

std::map<int, GlbTexture> loadTextures(
    const std::set<int>& requiredTextureIndices,
    const Value& root,
    ByteSpan bin
) {
    const Value::Array& textures = root.at("textures").asArray();
    const Value::Array& images = root.at("images").asArray();
    const Value::Array& bufferViews = root.at("bufferViews").asArray();
    const Value* samplersValue = root.find("samplers");
    const Value::Array emptySamplers;
    const Value::Array& samplers = samplersValue == nullptr
        ? emptySamplers
        : samplersValue->asArray();
    std::map<int, GlbTexture> output;

    for (const int textureIndex : requiredTextureIndices) {
        const Value& texture = indexed(textures, textureIndex, "texture");
        const int sourceIndex = requiredInteger(texture, "source");
        const Value& image = indexed(images, sourceIndex, "image");
        const int viewIndex = requiredInteger(image, "bufferView");
        const Value& view = indexed(bufferViews, viewIndex, "image bufferView");
        const std::size_t offset = static_cast<std::size_t>(
            optionalInteger(view, "byteOffset", 0)
        );
        const std::size_t length = static_cast<std::size_t>(
            requiredInteger(view, "byteLength", 1)
        );
        if (offset > bin.size() || length > bin.size() - offset) {
            throw std::runtime_error("GLB image is out of range");
        }

        GlbTexture loaded;
        loaded.encodedData.assign(bin.begin() + offset, bin.begin() + offset + length);
        if (const Value* mimeType = image.find("mimeType")) {
            loaded.mimeType = mimeType->asString();
        }
        const int samplerIndex = optionalInteger(texture, "sampler", -1, -1);
        if (samplerIndex >= 0) {
            const Value& sampler = indexed(samplers, samplerIndex, "sampler");
            loaded.sampler.magFilter = optionalInteger(sampler, "magFilter", 0);
            loaded.sampler.minFilter = optionalInteger(sampler, "minFilter", 0);
            loaded.sampler.wrapS = optionalInteger(sampler, "wrapS", 10497);
            loaded.sampler.wrapT = optionalInteger(sampler, "wrapT", 10497);
        }
        output.emplace(textureIndex, std::move(loaded));
    }
    return output;
}

}  // namespace

GlbMesh loadGlbMesh(std::span<const std::uint8_t> bytes) {
    if (bytes.size() < 12 || readU32(bytes, 0) != kGlbMagic) {
        throw std::runtime_error("selected asset is not a valid GLB");
    }
    if (readU32(bytes, 4) != 2) throw std::runtime_error("only GLB version 2 is supported");
    const std::size_t declaredLength = readU32(bytes, 8);
    if (declaredLength > bytes.size()) throw std::runtime_error("GLB length is out of range");

    std::string jsonSource;
    ByteSpan bin;
    std::size_t offset = 12;
    while (offset + 8 <= declaredLength) {
        const std::size_t chunkLength = readU32(bytes, offset);
        const std::uint32_t chunkType = readU32(bytes, offset + 4);
        offset += 8;
        if (offset > declaredLength || chunkLength > declaredLength - offset) {
            throw std::runtime_error("GLB chunk is out of range");
        }
        const ByteSpan chunk = bytes.subspan(offset, chunkLength);
        offset += chunkLength;
        if (chunkType == kJsonChunk) {
            jsonSource.assign(
                reinterpret_cast<const char*>(chunk.data()),
                chunk.size()
            );
        } else if (chunkType == kBinChunk) {
            bin = chunk;
        }
    }
    if (jsonSource.empty()) throw std::runtime_error("GLB JSON chunk is missing");
    if (bin.empty()) throw std::runtime_error("GLB BIN chunk is missing");
    const Value root = json::parse(jsonSource);

    const std::vector<RawPrimitive> rawPrimitives = collectPrimitives(root, bin);
    if (rawPrimitives.empty()) throw std::runtime_error("GLB contains no benchmark geometry");

    std::vector<float> rawMergedPositions;
    std::vector<std::uint32_t> mergedIndices;
    std::uint32_t baseVertex = 0;
    for (const RawPrimitive& primitive : rawPrimitives) {
        rawMergedPositions.insert(
            rawMergedPositions.end(),
            primitive.positions.begin(),
            primitive.positions.end()
        );
        for (const std::uint32_t index : primitive.indices) {
            mergedIndices.push_back(index + baseVertex);
        }
        baseVertex += static_cast<std::uint32_t>(primitive.positions.size() / 3);
    }

    const Normalization normalization = calculateNormalization(rawMergedPositions);
    const Value::Array& materials = root.at("materials").asArray();
    std::vector<GlbMaterialPrimitive> materialPrimitives =
        buildMaterialPrimitives(rawPrimitives, materials, normalization);
    std::set<int> requiredTextures;
    for (const GlbMaterialPrimitive& primitive : materialPrimitives) {
        if (primitive.baseColorTextureIndex >= 0) {
            requiredTextures.insert(primitive.baseColorTextureIndex);
        }
    }
    std::map<int, GlbTexture> textures = loadTextures(requiredTextures, root, bin);

    GlbMetadata meta;
    meta.vertexCount = rawMergedPositions.size() / 3;
    meta.indexCount = mergedIndices.size();
    meta.triangleCount = mergedIndices.size() / 3;
    meta.primitiveCount = materialPrimitives.size();
    meta.materialCount = materials.size();
    meta.imageCount = root.at("images").asArray().size();
    meta.textureCount = root.at("textures").asArray().size();
    meta.materialTextureCount = textures.size();
    meta.normScale = normalization.scale;
    meta.normCenter = normalization.center;
    meta.normMaxDim = normalization.maxDim;
    meta.texturedPrimitiveCount = static_cast<std::size_t>(std::count_if(
        materialPrimitives.begin(),
        materialPrimitives.end(),
        [&textures](const GlbMaterialPrimitive& primitive) {
            return primitive.baseColorTextureIndex >= 0
                && textures.contains(primitive.baseColorTextureIndex);
        }
    ));

    return {
        normalize(rawMergedPositions, normalization),
        std::move(mergedIndices),
        std::move(materialPrimitives),
        std::move(textures),
        meta,
    };
}

}  // namespace native_benchmark
