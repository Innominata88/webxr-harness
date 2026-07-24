#include "render/vulkan_renderer.h"

#include <android/bitmap.h>
#include <android/imagedecoder.h>
#include <vulkan/vulkan.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "core/instance_layout.h"

namespace native_benchmark {
namespace {

// The visual gate uses one shared scaled render target. Keep one frame in
// flight until collection adds per-frame timing resources.
constexpr std::size_t kFramesInFlight = 1;

void check(VkResult result, const char* operation) {
    if (result != VK_SUCCESS) {
        throw std::runtime_error(
            std::string(operation) + " failed with VkResult=" + std::to_string(result)
        );
    }
}

struct Buffer {
    VkBuffer handle = VK_NULL_HANDLE;
    VkDeviceMemory memory = VK_NULL_HANDLE;
    VkDeviceSize size = 0;
};

struct Texture {
    VkImage image = VK_NULL_HANDLE;
    VkDeviceMemory memory = VK_NULL_HANDLE;
    VkImageView view = VK_NULL_HANDLE;
    VkSampler sampler = VK_NULL_HANDLE;
    std::uint32_t mipLevels = 1;
};

struct GpuPrimitive {
    Buffer positions;
    Buffer texcoords;
    Buffer indices;
    std::uint32_t indexCount = 0;
    std::array<float, 4> baseColorFactor = {1, 1, 1, 1};
    VkDescriptorSet descriptorSet = VK_NULL_HANDLE;
};

struct DecodedImage {
    std::vector<std::uint8_t> pixels;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

struct PushConstants {
    std::array<float, 16> viewProjection{};
    std::array<float, 4> baseColorFactor = {1, 1, 1, 1};
};

std::string readAsset(AAssetManager* manager, const std::string& path) {
    if (manager == nullptr) throw std::runtime_error("Android AssetManager is unavailable");
    AAsset* asset = AAssetManager_open(manager, path.c_str(), AASSET_MODE_BUFFER);
    if (asset == nullptr) throw std::runtime_error("asset not found: " + path);
    const std::int64_t length = AAsset_getLength64(asset);
    if (length < 1) {
        AAsset_close(asset);
        throw std::runtime_error("asset is empty: " + path);
    }
    std::string bytes(static_cast<std::size_t>(length), '\0');
    std::size_t offset = 0;
    while (offset < bytes.size()) {
        const int count = AAsset_read(
            asset,
            bytes.data() + offset,
            bytes.size() - offset
        );
        if (count <= 0) {
            AAsset_close(asset);
            throw std::runtime_error("could not read asset: " + path);
        }
        offset += static_cast<std::size_t>(count);
    }
    AAsset_close(asset);
    return bytes;
}

DecodedImage decodeImage(const GlbTexture& texture) {
    AImageDecoder* decoder = nullptr;
    const int createResult = AImageDecoder_createFromBuffer(
        texture.encodedData.data(),
        texture.encodedData.size(),
        &decoder
    );
    if (createResult != ANDROID_IMAGE_DECODER_SUCCESS || decoder == nullptr) {
        throw std::runtime_error(
            "AImageDecoder_createFromBuffer failed with code "
            + std::to_string(createResult)
        );
    }

    const AImageDecoderHeaderInfo* header = AImageDecoder_getHeaderInfo(decoder);
    const int32_t width = AImageDecoderHeaderInfo_getWidth(header);
    const int32_t height = AImageDecoderHeaderInfo_getHeight(header);
    if (width < 1 || height < 1) {
        AImageDecoder_delete(decoder);
        throw std::runtime_error("decoded image has invalid dimensions");
    }
    const int formatResult = AImageDecoder_setAndroidBitmapFormat(
        decoder,
        ANDROID_BITMAP_FORMAT_RGBA_8888
    );
    if (formatResult != ANDROID_IMAGE_DECODER_SUCCESS) {
        AImageDecoder_delete(decoder);
        throw std::runtime_error("could not request RGBA_8888 image output");
    }
    const int unpremultipliedResult = AImageDecoder_setUnpremultipliedRequired(
        decoder,
        true
    );
    if (unpremultipliedResult != ANDROID_IMAGE_DECODER_SUCCESS) {
        AImageDecoder_delete(decoder);
        throw std::runtime_error("could not request unpremultiplied image output");
    }

    const std::size_t rowStride = static_cast<std::size_t>(width) * 4;
    DecodedImage output;
    output.width = static_cast<std::uint32_t>(width);
    output.height = static_cast<std::uint32_t>(height);
    output.pixels.resize(rowStride * static_cast<std::size_t>(height));
    const int decodeResult = AImageDecoder_decodeImage(
        decoder,
        output.pixels.data(),
        rowStride,
        output.pixels.size()
    );
    AImageDecoder_delete(decoder);
    if (decodeResult != ANDROID_IMAGE_DECODER_SUCCESS) {
        throw std::runtime_error(
            "AImageDecoder_decodeImage failed with code "
            + std::to_string(decodeResult)
        );
    }
    return output;
}

VkFilter filterForMag(int filter) {
    return filter == 9728 ? VK_FILTER_NEAREST : VK_FILTER_LINEAR;
}

VkFilter filterForMin(int filter) {
    return filter == 9728 || filter == 9984 || filter == 9986
        ? VK_FILTER_NEAREST
        : VK_FILTER_LINEAR;
}

VkSamplerMipmapMode mipmapMode(int filter) {
    return filter == 9986 || filter == 9987
        ? VK_SAMPLER_MIPMAP_MODE_LINEAR
        : VK_SAMPLER_MIPMAP_MODE_NEAREST;
}

bool usesMipmaps(int filter) {
    return filter >= 9984 && filter <= 9987;
}

VkSamplerAddressMode addressMode(int wrap) {
    switch (wrap) {
        case 33071: return VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
        case 33648: return VK_SAMPLER_ADDRESS_MODE_MIRRORED_REPEAT;
        default: return VK_SAMPLER_ADDRESS_MODE_REPEAT;
    }
}

std::array<float, 16> multiply(
    const std::array<float, 16>& left,
    const std::array<float, 16>& right
) {
    std::array<float, 16> result{};
    for (int column = 0; column < 4; ++column) {
        for (int row = 0; row < 4; ++row) {
            float value = 0;
            for (int inner = 0; inner < 4; ++inner) {
                value += left[inner * 4 + row] * right[column * 4 + inner];
            }
            result[column * 4 + row] = value;
        }
    }
    return result;
}

std::array<float, 16> viewProjection(float aspect) {
    constexpr float pi = 3.14159265358979323846F;
    constexpr float fieldOfView = 60.0F * pi / 180.0F;
    constexpr float nearPlane = 0.1F;
    constexpr float farPlane = 100.0F;
    const float focal = 1.0F / std::tan(fieldOfView / 2.0F);

    std::array<float, 16> projection{};
    projection[0] = focal / aspect;
    projection[5] = -focal;
    projection[10] = farPlane / (nearPlane - farPlane);
    projection[11] = -1;
    projection[14] = nearPlane * farPlane / (nearPlane - farPlane);

    std::array<float, 16> view{};
    view[0] = 1;
    view[5] = 1;
    view[10] = 1;
    view[15] = 1;
    view[14] = -2;
    return multiply(projection, view);
}

}  // namespace

class VulkanRenderer::Impl {
public:
    Impl(
        ANativeWindow* window,
        AAssetManager* assets,
        GlbMesh mesh,
        std::string surfaceMode,
        double renderScale,
        int instanceCount,
        float spacing
    )
        : window_(window),
          assets_(assets),
          mesh_(std::move(mesh)),
          surfaceMode_(std::move(surfaceMode)),
          renderScale_(renderScale),
          instanceCount_(instanceCount),
          spacing_(spacing) {
        if (window_ == nullptr) throw std::runtime_error("Android surface is unavailable");
        if (assets_ == nullptr) throw std::runtime_error("Android AssetManager is unavailable");
        if (surfaceMode_ != "flat" && surfaceMode_ != "basecolor") {
            throw std::runtime_error("surface mode must be flat or basecolor");
        }
        if (renderScale_ <= 0 || renderScale_ > 1) {
            throw std::runtime_error("render scale must be greater than zero and at most one");
        }
        if (instanceCount_ < 1 || instanceCount_ > 4096) {
            throw std::runtime_error("preview instance count must be between 1 and 4096");
        }
        ANativeWindow_acquire(window_);
        try {
            initialize();
        } catch (...) {
            cleanup();
            throw;
        }
    }

    ~Impl() {
        cleanup();
    }

    bool draw(std::uint64_t frameTimeNanos) {
        (void)frameTimeNanos;
        try {
            drawFrame();
            return true;
        } catch (const std::exception& error) {
            lastError_ = error.what();
            return false;
        }
    }

    const std::string& lastError() const {
        return lastError_;
    }

    std::string describe() const {
        std::ostringstream output;
        output
            << "Preview ready"
            << "\nrenderer=vulkan-" << surfaceMode_
            << " instances=" << instanceCount_
            << " scale=" << renderScale_
            << "\nGPU=" << physicalProperties_.deviceName
            << " Vulkan="
            << VK_VERSION_MAJOR(physicalProperties_.apiVersion) << '.'
            << VK_VERSION_MINOR(physicalProperties_.apiVersion) << '.'
            << VK_VERSION_PATCH(physicalProperties_.apiVersion)
            << "\nswapchain=" << swapchainExtent_.width << 'x' << swapchainExtent_.height
            << " renderTarget=" << renderExtent_.width << 'x' << renderExtent_.height;
        return output.str();
    }

private:
    void initialize();
    void createInstance();
    void selectPhysicalDevice();
    void createDevice();
    void createSwapchain();
    void createCommandResources();
    void createRenderTargets();
    void createDescriptors();
    void createPipelines();
    void uploadScene();
    void createSyncObjects();
    void drawFrame();
    void recordCommands(VkCommandBuffer commandBuffer, std::uint32_t imageIndex);
    void cleanup();

    std::uint32_t findMemoryType(
        std::uint32_t typeBits,
        VkMemoryPropertyFlags properties
    ) const;
    Buffer createBuffer(
        VkDeviceSize size,
        VkBufferUsageFlags usage,
        VkMemoryPropertyFlags properties
    );
    void destroyBuffer(Buffer& buffer);
    Buffer uploadDeviceBuffer(
        const void* data,
        VkDeviceSize size,
        VkBufferUsageFlags usage
    );
    VkCommandBuffer beginOneTimeCommands();
    void endOneTimeCommands(VkCommandBuffer commandBuffer);
    void createImage(
        std::uint32_t width,
        std::uint32_t height,
        std::uint32_t mipLevels,
        VkFormat format,
        VkImageUsageFlags usage,
        VkImage& image,
        VkDeviceMemory& memory
    );
    VkImageView createImageView(
        VkImage image,
        VkFormat format,
        VkImageAspectFlags aspect,
        std::uint32_t mipLevels
    );
    Texture uploadTexture(const DecodedImage& image, const GlbSampler& sampler);
    Texture createWhiteTexture();
    void destroyTexture(Texture& texture);
    VkShaderModule loadShader(const std::string& path);
    VkFormat selectDepthFormat() const;
    VkSurfaceFormatKHR selectSurfaceFormat(
        const std::vector<VkSurfaceFormatKHR>& formats
    ) const;
    VkCompositeAlphaFlagBitsKHR selectCompositeAlpha(
        VkCompositeAlphaFlagsKHR supported
    ) const;

    ANativeWindow* window_ = nullptr;
    AAssetManager* assets_ = nullptr;
    GlbMesh mesh_;
    std::string surfaceMode_;
    double renderScale_ = 1;
    int instanceCount_ = 1;
    float spacing_ = 0.35F;
    std::string lastError_;

    VkInstance instance_ = VK_NULL_HANDLE;
    VkSurfaceKHR surface_ = VK_NULL_HANDLE;
    VkPhysicalDevice physicalDevice_ = VK_NULL_HANDLE;
    VkPhysicalDeviceProperties physicalProperties_{};
    std::uint32_t queueFamily_ = 0;
    VkDevice device_ = VK_NULL_HANDLE;
    VkQueue queue_ = VK_NULL_HANDLE;

    VkSwapchainKHR swapchain_ = VK_NULL_HANDLE;
    VkFormat colorFormat_ = VK_FORMAT_UNDEFINED;
    VkColorSpaceKHR colorSpace_ = VK_COLOR_SPACE_SRGB_NONLINEAR_KHR;
    VkExtent2D swapchainExtent_{};
    VkExtent2D renderExtent_{};
    std::vector<VkImage> swapchainImages_;

    VkCommandPool commandPool_ = VK_NULL_HANDLE;
    std::array<VkCommandBuffer, kFramesInFlight> commandBuffers_{};

    VkImage colorImage_ = VK_NULL_HANDLE;
    VkDeviceMemory colorMemory_ = VK_NULL_HANDLE;
    VkImageView colorView_ = VK_NULL_HANDLE;
    VkFormat depthFormat_ = VK_FORMAT_UNDEFINED;
    VkImage depthImage_ = VK_NULL_HANDLE;
    VkDeviceMemory depthMemory_ = VK_NULL_HANDLE;
    VkImageView depthView_ = VK_NULL_HANDLE;
    VkRenderPass renderPass_ = VK_NULL_HANDLE;
    VkFramebuffer framebuffer_ = VK_NULL_HANDLE;

    VkDescriptorSetLayout descriptorSetLayout_ = VK_NULL_HANDLE;
    VkDescriptorPool descriptorPool_ = VK_NULL_HANDLE;
    VkPipelineLayout pipelineLayout_ = VK_NULL_HANDLE;
    VkPipeline flatPipeline_ = VK_NULL_HANDLE;
    VkPipeline materialPipeline_ = VK_NULL_HANDLE;

    Buffer flatPositions_;
    Buffer flatIndices_;
    Buffer instanceOffsets_;
    std::uint32_t flatIndexCount_ = 0;
    std::vector<GpuPrimitive> primitives_;
    std::map<int, Texture> textures_;
    Texture whiteTexture_;

    std::array<VkSemaphore, kFramesInFlight> imageAvailable_{};
    std::array<VkSemaphore, kFramesInFlight> renderFinished_{};
    std::array<VkFence, kFramesInFlight> inFlight_{};
    std::size_t frameIndex_ = 0;
    PushConstants pushConstants_{};
};

void VulkanRenderer::Impl::initialize() {
    createInstance();
    selectPhysicalDevice();
    createDevice();
    createSwapchain();
    createCommandResources();
    createRenderTargets();
    createDescriptors();
    createPipelines();
    uploadScene();
    createSyncObjects();
    pushConstants_.viewProjection = viewProjection(
        static_cast<float>(renderExtent_.width)
            / static_cast<float>(renderExtent_.height)
    );
}

void VulkanRenderer::Impl::createInstance() {
    const VkApplicationInfo applicationInfo{
        .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pNext = nullptr,
        .pApplicationName = "NativeBenchmark",
        .applicationVersion = VK_MAKE_VERSION(0, 2, 0),
        .pEngineName = "NativeBenchmark",
        .engineVersion = VK_MAKE_VERSION(0, 2, 0),
        .apiVersion = VK_API_VERSION_1_1,
    };
    const char* extensions[] = {
        VK_KHR_SURFACE_EXTENSION_NAME,
        VK_KHR_ANDROID_SURFACE_EXTENSION_NAME,
    };
    const VkInstanceCreateInfo createInfo{
        .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .pApplicationInfo = &applicationInfo,
        .enabledLayerCount = 0,
        .ppEnabledLayerNames = nullptr,
        .enabledExtensionCount = 2,
        .ppEnabledExtensionNames = extensions,
    };
    check(vkCreateInstance(&createInfo, nullptr, &instance_), "vkCreateInstance");

    const VkAndroidSurfaceCreateInfoKHR surfaceInfo{
        .sType = VK_STRUCTURE_TYPE_ANDROID_SURFACE_CREATE_INFO_KHR,
        .pNext = nullptr,
        .flags = 0,
        .window = window_,
    };
    check(
        vkCreateAndroidSurfaceKHR(instance_, &surfaceInfo, nullptr, &surface_),
        "vkCreateAndroidSurfaceKHR"
    );
}

void VulkanRenderer::Impl::selectPhysicalDevice() {
    std::uint32_t deviceCount = 0;
    check(
        vkEnumeratePhysicalDevices(instance_, &deviceCount, nullptr),
        "vkEnumeratePhysicalDevices(count)"
    );
    if (deviceCount == 0) throw std::runtime_error("no Vulkan physical device");
    std::vector<VkPhysicalDevice> devices(deviceCount);
    check(
        vkEnumeratePhysicalDevices(instance_, &deviceCount, devices.data()),
        "vkEnumeratePhysicalDevices(values)"
    );

    for (const VkPhysicalDevice candidate : devices) {
        std::uint32_t extensionCount = 0;
        if (vkEnumerateDeviceExtensionProperties(
                candidate,
                nullptr,
                &extensionCount,
                nullptr
            ) != VK_SUCCESS) {
            continue;
        }
        std::vector<VkExtensionProperties> extensions(extensionCount);
        if (vkEnumerateDeviceExtensionProperties(
                candidate,
                nullptr,
                &extensionCount,
                extensions.data()
            ) != VK_SUCCESS) {
            continue;
        }
        const bool hasSwapchain = std::any_of(
            extensions.begin(),
            extensions.end(),
            [](const VkExtensionProperties& extension) {
                return std::string(extension.extensionName)
                    == VK_KHR_SWAPCHAIN_EXTENSION_NAME;
            }
        );
        if (!hasSwapchain) continue;

        std::uint32_t queueCount = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(candidate, &queueCount, nullptr);
        std::vector<VkQueueFamilyProperties> queues(queueCount);
        vkGetPhysicalDeviceQueueFamilyProperties(candidate, &queueCount, queues.data());
        for (std::uint32_t index = 0; index < queueCount; ++index) {
            VkBool32 presentSupported = VK_FALSE;
            if (vkGetPhysicalDeviceSurfaceSupportKHR(
                    candidate,
                    index,
                    surface_,
                    &presentSupported
                ) != VK_SUCCESS) {
                continue;
            }
            if ((queues[index].queueFlags & VK_QUEUE_GRAPHICS_BIT) != 0
                && presentSupported == VK_TRUE) {
                physicalDevice_ = candidate;
                queueFamily_ = index;
                vkGetPhysicalDeviceProperties(physicalDevice_, &physicalProperties_);
                return;
            }
        }
    }
    throw std::runtime_error("no Vulkan graphics+present queue with swapchain support");
}

void VulkanRenderer::Impl::createDevice() {
    constexpr float priority = 1;
    const VkDeviceQueueCreateInfo queueInfo{
        .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .queueFamilyIndex = queueFamily_,
        .queueCount = 1,
        .pQueuePriorities = &priority,
    };
    const char* extensions[] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
    const VkPhysicalDeviceFeatures features{};
    const VkDeviceCreateInfo createInfo{
        .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .queueCreateInfoCount = 1,
        .pQueueCreateInfos = &queueInfo,
        .enabledLayerCount = 0,
        .ppEnabledLayerNames = nullptr,
        .enabledExtensionCount = 1,
        .ppEnabledExtensionNames = extensions,
        .pEnabledFeatures = &features,
    };
    check(vkCreateDevice(physicalDevice_, &createInfo, nullptr, &device_), "vkCreateDevice");
    vkGetDeviceQueue(device_, queueFamily_, 0, &queue_);
}

VkSurfaceFormatKHR VulkanRenderer::Impl::selectSurfaceFormat(
    const std::vector<VkSurfaceFormatKHR>& formats
) const {
    for (const VkFormat preferred : {
        VK_FORMAT_R8G8B8A8_UNORM,
        VK_FORMAT_B8G8R8A8_UNORM,
    }) {
        const auto found = std::find_if(
            formats.begin(),
            formats.end(),
            [preferred](const VkSurfaceFormatKHR& format) {
                return format.format == preferred
                    && format.colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR;
            }
        );
        if (found != formats.end()) return *found;
    }
    if (formats.empty()) throw std::runtime_error("surface has no supported formats");
    return formats.front();
}

VkCompositeAlphaFlagBitsKHR VulkanRenderer::Impl::selectCompositeAlpha(
    VkCompositeAlphaFlagsKHR supported
) const {
    for (const VkCompositeAlphaFlagBitsKHR candidate : {
        VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR,
        VK_COMPOSITE_ALPHA_INHERIT_BIT_KHR,
        VK_COMPOSITE_ALPHA_PRE_MULTIPLIED_BIT_KHR,
        VK_COMPOSITE_ALPHA_POST_MULTIPLIED_BIT_KHR,
    }) {
        if ((supported & candidate) != 0) return candidate;
    }
    throw std::runtime_error("surface has no supported composite alpha mode");
}

void VulkanRenderer::Impl::createSwapchain() {
    VkSurfaceCapabilitiesKHR capabilities{};
    check(
        vkGetPhysicalDeviceSurfaceCapabilitiesKHR(
            physicalDevice_,
            surface_,
            &capabilities
        ),
        "vkGetPhysicalDeviceSurfaceCapabilitiesKHR"
    );
    if ((capabilities.supportedUsageFlags & VK_IMAGE_USAGE_TRANSFER_DST_BIT) == 0) {
        throw std::runtime_error("swapchain does not support scaled transfer destination");
    }

    std::uint32_t formatCount = 0;
    check(
        vkGetPhysicalDeviceSurfaceFormatsKHR(
            physicalDevice_,
            surface_,
            &formatCount,
            nullptr
        ),
        "vkGetPhysicalDeviceSurfaceFormatsKHR(count)"
    );
    std::vector<VkSurfaceFormatKHR> formats(formatCount);
    check(
        vkGetPhysicalDeviceSurfaceFormatsKHR(
            physicalDevice_,
            surface_,
            &formatCount,
            formats.data()
        ),
        "vkGetPhysicalDeviceSurfaceFormatsKHR(values)"
    );
    const VkSurfaceFormatKHR surfaceFormat = selectSurfaceFormat(formats);
    colorFormat_ = surfaceFormat.format;
    colorSpace_ = surfaceFormat.colorSpace;
    VkFormatProperties colorProperties{};
    vkGetPhysicalDeviceFormatProperties(
        physicalDevice_,
        colorFormat_,
        &colorProperties
    );
    constexpr VkFormatFeatureFlags requiredBlitFeatures =
        VK_FORMAT_FEATURE_BLIT_SRC_BIT
        | VK_FORMAT_FEATURE_BLIT_DST_BIT
        | VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT;
    if ((colorProperties.optimalTilingFeatures & requiredBlitFeatures)
        != requiredBlitFeatures) {
        throw std::runtime_error(
            "surface format cannot linearly blit the scaled render target"
        );
    }

    if (capabilities.currentExtent.width != std::numeric_limits<std::uint32_t>::max()) {
        swapchainExtent_ = capabilities.currentExtent;
    } else {
        const std::uint32_t windowWidth = static_cast<std::uint32_t>(
            std::max(1, ANativeWindow_getWidth(window_))
        );
        const std::uint32_t windowHeight = static_cast<std::uint32_t>(
            std::max(1, ANativeWindow_getHeight(window_))
        );
        swapchainExtent_.width = std::clamp(
            windowWidth,
            capabilities.minImageExtent.width,
            capabilities.maxImageExtent.width
        );
        swapchainExtent_.height = std::clamp(
            windowHeight,
            capabilities.minImageExtent.height,
            capabilities.maxImageExtent.height
        );
    }
    renderExtent_.width = std::max(
        1U,
        static_cast<std::uint32_t>(
            std::lround(static_cast<double>(swapchainExtent_.width) * renderScale_)
        )
    );
    renderExtent_.height = std::max(
        1U,
        static_cast<std::uint32_t>(
            std::lround(static_cast<double>(swapchainExtent_.height) * renderScale_)
        )
    );

    std::uint32_t imageCount = capabilities.minImageCount + 1;
    if (capabilities.maxImageCount > 0) {
        imageCount = std::min(imageCount, capabilities.maxImageCount);
    }
    const VkSwapchainCreateInfoKHR createInfo{
        .sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR,
        .pNext = nullptr,
        .flags = 0,
        .surface = surface_,
        .minImageCount = imageCount,
        .imageFormat = colorFormat_,
        .imageColorSpace = colorSpace_,
        .imageExtent = swapchainExtent_,
        .imageArrayLayers = 1,
        .imageUsage = VK_IMAGE_USAGE_TRANSFER_DST_BIT,
        .imageSharingMode = VK_SHARING_MODE_EXCLUSIVE,
        .queueFamilyIndexCount = 0,
        .pQueueFamilyIndices = nullptr,
        .preTransform = capabilities.currentTransform,
        .compositeAlpha = selectCompositeAlpha(capabilities.supportedCompositeAlpha),
        .presentMode = VK_PRESENT_MODE_FIFO_KHR,
        .clipped = VK_TRUE,
        .oldSwapchain = VK_NULL_HANDLE,
    };
    check(
        vkCreateSwapchainKHR(device_, &createInfo, nullptr, &swapchain_),
        "vkCreateSwapchainKHR"
    );
    check(
        vkGetSwapchainImagesKHR(device_, swapchain_, &imageCount, nullptr),
        "vkGetSwapchainImagesKHR(count)"
    );
    swapchainImages_.resize(imageCount);
    check(
        vkGetSwapchainImagesKHR(
            device_,
            swapchain_,
            &imageCount,
            swapchainImages_.data()
        ),
        "vkGetSwapchainImagesKHR(values)"
    );
}

void VulkanRenderer::Impl::createCommandResources() {
    const VkCommandPoolCreateInfo poolInfo{
        .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
        .pNext = nullptr,
        .flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT,
        .queueFamilyIndex = queueFamily_,
    };
    check(
        vkCreateCommandPool(device_, &poolInfo, nullptr, &commandPool_),
        "vkCreateCommandPool"
    );
    const VkCommandBufferAllocateInfo allocateInfo{
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .pNext = nullptr,
        .commandPool = commandPool_,
        .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
        .commandBufferCount = static_cast<std::uint32_t>(commandBuffers_.size()),
    };
    check(
        vkAllocateCommandBuffers(device_, &allocateInfo, commandBuffers_.data()),
        "vkAllocateCommandBuffers"
    );
}

std::uint32_t VulkanRenderer::Impl::findMemoryType(
    std::uint32_t typeBits,
    VkMemoryPropertyFlags properties
) const {
    VkPhysicalDeviceMemoryProperties memoryProperties{};
    vkGetPhysicalDeviceMemoryProperties(physicalDevice_, &memoryProperties);
    for (std::uint32_t index = 0; index < memoryProperties.memoryTypeCount; ++index) {
        const bool supported = (typeBits & (1U << index)) != 0;
        const bool matches =
            (memoryProperties.memoryTypes[index].propertyFlags & properties) == properties;
        if (supported && matches) return index;
    }
    throw std::runtime_error("no compatible Vulkan memory type");
}

Buffer VulkanRenderer::Impl::createBuffer(
    VkDeviceSize size,
    VkBufferUsageFlags usage,
    VkMemoryPropertyFlags properties
) {
    Buffer output;
    output.size = size;
    const VkBufferCreateInfo bufferInfo{
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .size = size,
        .usage = usage,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
        .queueFamilyIndexCount = 0,
        .pQueueFamilyIndices = nullptr,
    };
    check(vkCreateBuffer(device_, &bufferInfo, nullptr, &output.handle), "vkCreateBuffer");
    VkMemoryRequirements requirements{};
    vkGetBufferMemoryRequirements(device_, output.handle, &requirements);
    const VkMemoryAllocateInfo allocationInfo{
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .pNext = nullptr,
        .allocationSize = requirements.size,
        .memoryTypeIndex = findMemoryType(requirements.memoryTypeBits, properties),
    };
    try {
        check(
            vkAllocateMemory(device_, &allocationInfo, nullptr, &output.memory),
            "vkAllocateMemory(buffer)"
        );
        check(
            vkBindBufferMemory(device_, output.handle, output.memory, 0),
            "vkBindBufferMemory"
        );
    } catch (...) {
        if (output.memory != VK_NULL_HANDLE) vkFreeMemory(device_, output.memory, nullptr);
        if (output.handle != VK_NULL_HANDLE) vkDestroyBuffer(device_, output.handle, nullptr);
        throw;
    }
    return output;
}

void VulkanRenderer::Impl::destroyBuffer(Buffer& buffer) {
    if (buffer.handle != VK_NULL_HANDLE) vkDestroyBuffer(device_, buffer.handle, nullptr);
    if (buffer.memory != VK_NULL_HANDLE) vkFreeMemory(device_, buffer.memory, nullptr);
    buffer = {};
}

VkCommandBuffer VulkanRenderer::Impl::beginOneTimeCommands() {
    const VkCommandBufferAllocateInfo allocateInfo{
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .pNext = nullptr,
        .commandPool = commandPool_,
        .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
        .commandBufferCount = 1,
    };
    VkCommandBuffer commandBuffer = VK_NULL_HANDLE;
    check(
        vkAllocateCommandBuffers(device_, &allocateInfo, &commandBuffer),
        "vkAllocateCommandBuffers(one-time)"
    );
    const VkCommandBufferBeginInfo beginInfo{
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .pNext = nullptr,
        .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT,
        .pInheritanceInfo = nullptr,
    };
    check(vkBeginCommandBuffer(commandBuffer, &beginInfo), "vkBeginCommandBuffer(one-time)");
    return commandBuffer;
}

void VulkanRenderer::Impl::endOneTimeCommands(VkCommandBuffer commandBuffer) {
    check(vkEndCommandBuffer(commandBuffer), "vkEndCommandBuffer(one-time)");
    const VkSubmitInfo submitInfo{
        .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
        .pNext = nullptr,
        .waitSemaphoreCount = 0,
        .pWaitSemaphores = nullptr,
        .pWaitDstStageMask = nullptr,
        .commandBufferCount = 1,
        .pCommandBuffers = &commandBuffer,
        .signalSemaphoreCount = 0,
        .pSignalSemaphores = nullptr,
    };
    check(vkQueueSubmit(queue_, 1, &submitInfo, VK_NULL_HANDLE), "vkQueueSubmit(one-time)");
    check(vkQueueWaitIdle(queue_), "vkQueueWaitIdle(one-time)");
    vkFreeCommandBuffers(device_, commandPool_, 1, &commandBuffer);
}

Buffer VulkanRenderer::Impl::uploadDeviceBuffer(
    const void* data,
    VkDeviceSize size,
    VkBufferUsageFlags usage
) {
    if (data == nullptr || size == 0) throw std::runtime_error("cannot upload empty buffer");
    Buffer staging = createBuffer(
        size,
        VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
        VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT
    );
    void* mapped = nullptr;
    check(vkMapMemory(device_, staging.memory, 0, size, 0, &mapped), "vkMapMemory");
    std::memcpy(mapped, data, static_cast<std::size_t>(size));
    vkUnmapMemory(device_, staging.memory);

    Buffer destination;
    try {
        destination = createBuffer(
            size,
            VK_BUFFER_USAGE_TRANSFER_DST_BIT | usage,
            VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT
        );
        VkCommandBuffer commandBuffer = beginOneTimeCommands();
        const VkBufferCopy copy{.srcOffset = 0, .dstOffset = 0, .size = size};
        vkCmdCopyBuffer(commandBuffer, staging.handle, destination.handle, 1, &copy);
        endOneTimeCommands(commandBuffer);
    } catch (...) {
        destroyBuffer(staging);
        destroyBuffer(destination);
        throw;
    }
    destroyBuffer(staging);
    return destination;
}

void VulkanRenderer::Impl::createImage(
    std::uint32_t width,
    std::uint32_t height,
    std::uint32_t mipLevels,
    VkFormat format,
    VkImageUsageFlags usage,
    VkImage& image,
    VkDeviceMemory& memory
) {
    const VkImageCreateInfo imageInfo{
        .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .imageType = VK_IMAGE_TYPE_2D,
        .format = format,
        .extent = {width, height, 1},
        .mipLevels = mipLevels,
        .arrayLayers = 1,
        .samples = VK_SAMPLE_COUNT_1_BIT,
        .tiling = VK_IMAGE_TILING_OPTIMAL,
        .usage = usage,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
        .queueFamilyIndexCount = 0,
        .pQueueFamilyIndices = nullptr,
        .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
    };
    check(vkCreateImage(device_, &imageInfo, nullptr, &image), "vkCreateImage");
    VkMemoryRequirements requirements{};
    vkGetImageMemoryRequirements(device_, image, &requirements);
    const VkMemoryAllocateInfo allocationInfo{
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .pNext = nullptr,
        .allocationSize = requirements.size,
        .memoryTypeIndex = findMemoryType(
            requirements.memoryTypeBits,
            VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT
        ),
    };
    try {
        check(
            vkAllocateMemory(device_, &allocationInfo, nullptr, &memory),
            "vkAllocateMemory(image)"
        );
        check(vkBindImageMemory(device_, image, memory, 0), "vkBindImageMemory");
    } catch (...) {
        if (memory != VK_NULL_HANDLE) vkFreeMemory(device_, memory, nullptr);
        if (image != VK_NULL_HANDLE) vkDestroyImage(device_, image, nullptr);
        image = VK_NULL_HANDLE;
        memory = VK_NULL_HANDLE;
        throw;
    }
}

VkImageView VulkanRenderer::Impl::createImageView(
    VkImage image,
    VkFormat format,
    VkImageAspectFlags aspect,
    std::uint32_t mipLevels
) {
    const VkImageViewCreateInfo viewInfo{
        .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .image = image,
        .viewType = VK_IMAGE_VIEW_TYPE_2D,
        .format = format,
        .components = {
            VK_COMPONENT_SWIZZLE_IDENTITY,
            VK_COMPONENT_SWIZZLE_IDENTITY,
            VK_COMPONENT_SWIZZLE_IDENTITY,
            VK_COMPONENT_SWIZZLE_IDENTITY,
        },
        .subresourceRange = {
            .aspectMask = aspect,
            .baseMipLevel = 0,
            .levelCount = mipLevels,
            .baseArrayLayer = 0,
            .layerCount = 1,
        },
    };
    VkImageView view = VK_NULL_HANDLE;
    check(vkCreateImageView(device_, &viewInfo, nullptr, &view), "vkCreateImageView");
    return view;
}

VkFormat VulkanRenderer::Impl::selectDepthFormat() const {
    for (const VkFormat format : {
        VK_FORMAT_D32_SFLOAT,
        VK_FORMAT_D24_UNORM_S8_UINT,
        VK_FORMAT_D16_UNORM,
    }) {
        VkFormatProperties properties{};
        vkGetPhysicalDeviceFormatProperties(physicalDevice_, format, &properties);
        if ((properties.optimalTilingFeatures
             & VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT) != 0) {
            return format;
        }
    }
    throw std::runtime_error("no supported Vulkan depth format");
}

void VulkanRenderer::Impl::createRenderTargets() {
    createImage(
        renderExtent_.width,
        renderExtent_.height,
        1,
        colorFormat_,
        VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
        colorImage_,
        colorMemory_
    );
    colorView_ = createImageView(
        colorImage_,
        colorFormat_,
        VK_IMAGE_ASPECT_COLOR_BIT,
        1
    );

    depthFormat_ = selectDepthFormat();
    createImage(
        renderExtent_.width,
        renderExtent_.height,
        1,
        depthFormat_,
        VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT,
        depthImage_,
        depthMemory_
    );
    depthView_ = createImageView(
        depthImage_,
        depthFormat_,
        VK_IMAGE_ASPECT_DEPTH_BIT,
        1
    );

    const std::array<VkAttachmentDescription, 2> attachments = {{
        {
            .flags = 0,
            .format = colorFormat_,
            .samples = VK_SAMPLE_COUNT_1_BIT,
            .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
            .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
            .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
            .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE,
            .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
            .finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
        },
        {
            .flags = 0,
            .format = depthFormat_,
            .samples = VK_SAMPLE_COUNT_1_BIT,
            .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
            .storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE,
            .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
            .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE,
            .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
            .finalLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL,
        },
    }};
    const VkAttachmentReference colorReference{
        .attachment = 0,
        .layout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
    };
    const VkAttachmentReference depthReference{
        .attachment = 1,
        .layout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL,
    };
    const VkSubpassDescription subpass{
        .flags = 0,
        .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
        .inputAttachmentCount = 0,
        .pInputAttachments = nullptr,
        .colorAttachmentCount = 1,
        .pColorAttachments = &colorReference,
        .pResolveAttachments = nullptr,
        .pDepthStencilAttachment = &depthReference,
        .preserveAttachmentCount = 0,
        .pPreserveAttachments = nullptr,
    };
    const VkSubpassDependency dependency{
        .srcSubpass = VK_SUBPASS_EXTERNAL,
        .dstSubpass = 0,
        .srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT
            | VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT,
        .dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT
            | VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT,
        .srcAccessMask = 0,
        .dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT
            | VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT,
        .dependencyFlags = 0,
    };
    const VkRenderPassCreateInfo renderPassInfo{
        .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .attachmentCount = static_cast<std::uint32_t>(attachments.size()),
        .pAttachments = attachments.data(),
        .subpassCount = 1,
        .pSubpasses = &subpass,
        .dependencyCount = 1,
        .pDependencies = &dependency,
    };
    check(
        vkCreateRenderPass(device_, &renderPassInfo, nullptr, &renderPass_),
        "vkCreateRenderPass"
    );

    const std::array<VkImageView, 2> views = {colorView_, depthView_};
    const VkFramebufferCreateInfo framebufferInfo{
        .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .renderPass = renderPass_,
        .attachmentCount = static_cast<std::uint32_t>(views.size()),
        .pAttachments = views.data(),
        .width = renderExtent_.width,
        .height = renderExtent_.height,
        .layers = 1,
    };
    check(
        vkCreateFramebuffer(device_, &framebufferInfo, nullptr, &framebuffer_),
        "vkCreateFramebuffer"
    );
}

void VulkanRenderer::Impl::createDescriptors() {
    const VkDescriptorSetLayoutBinding binding{
        .binding = 0,
        .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
        .descriptorCount = 1,
        .stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT,
        .pImmutableSamplers = nullptr,
    };
    const VkDescriptorSetLayoutCreateInfo layoutInfo{
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .bindingCount = 1,
        .pBindings = &binding,
    };
    check(
        vkCreateDescriptorSetLayout(
            device_,
            &layoutInfo,
            nullptr,
            &descriptorSetLayout_
        ),
        "vkCreateDescriptorSetLayout"
    );

    const std::uint32_t descriptorCount = static_cast<std::uint32_t>(
        std::max<std::size_t>(1, mesh_.materialPrimitives.size())
    );
    const VkDescriptorPoolSize poolSize{
        .type = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
        .descriptorCount = descriptorCount,
    };
    const VkDescriptorPoolCreateInfo poolInfo{
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .maxSets = descriptorCount,
        .poolSizeCount = 1,
        .pPoolSizes = &poolSize,
    };
    check(
        vkCreateDescriptorPool(device_, &poolInfo, nullptr, &descriptorPool_),
        "vkCreateDescriptorPool"
    );
}

VkShaderModule VulkanRenderer::Impl::loadShader(const std::string& path) {
    const std::string bytes = readAsset(assets_, path);
    if (bytes.empty() || bytes.size() % sizeof(std::uint32_t) != 0) {
        throw std::runtime_error("invalid SPIR-V asset: " + path);
    }
    std::vector<std::uint32_t> words(bytes.size() / sizeof(std::uint32_t));
    std::memcpy(words.data(), bytes.data(), bytes.size());
    const VkShaderModuleCreateInfo createInfo{
        .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .codeSize = bytes.size(),
        .pCode = words.data(),
    };
    VkShaderModule module = VK_NULL_HANDLE;
    check(
        vkCreateShaderModule(device_, &createInfo, nullptr, &module),
        "vkCreateShaderModule"
    );
    return module;
}

void VulkanRenderer::Impl::createPipelines() {
    const VkPushConstantRange pushRange{
        .stageFlags = VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
        .offset = 0,
        .size = sizeof(PushConstants),
    };
    const VkPipelineLayoutCreateInfo layoutInfo{
        .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
        .setLayoutCount = 1,
        .pSetLayouts = &descriptorSetLayout_,
        .pushConstantRangeCount = 1,
        .pPushConstantRanges = &pushRange,
    };
    check(
        vkCreatePipelineLayout(device_, &layoutInfo, nullptr, &pipelineLayout_),
        "vkCreatePipelineLayout"
    );

    const auto createPipeline = [this](
        const std::string& vertexPath,
        const std::string& fragmentPath,
        const std::vector<VkVertexInputBindingDescription>& bindings,
        const std::vector<VkVertexInputAttributeDescription>& attributes,
        bool blending
    ) {
        VkShaderModule vertexShader = loadShader(vertexPath);
        VkShaderModule fragmentShader = VK_NULL_HANDLE;
        try {
            fragmentShader = loadShader(fragmentPath);
            const std::array<VkPipelineShaderStageCreateInfo, 2> stages = {{
                {
                    .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                    .pNext = nullptr,
                    .flags = 0,
                    .stage = VK_SHADER_STAGE_VERTEX_BIT,
                    .module = vertexShader,
                    .pName = "main",
                    .pSpecializationInfo = nullptr,
                },
                {
                    .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                    .pNext = nullptr,
                    .flags = 0,
                    .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
                    .module = fragmentShader,
                    .pName = "main",
                    .pSpecializationInfo = nullptr,
                },
            }};
            const VkPipelineVertexInputStateCreateInfo vertexInput{
                .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
                .pNext = nullptr,
                .flags = 0,
                .vertexBindingDescriptionCount =
                    static_cast<std::uint32_t>(bindings.size()),
                .pVertexBindingDescriptions = bindings.data(),
                .vertexAttributeDescriptionCount =
                    static_cast<std::uint32_t>(attributes.size()),
                .pVertexAttributeDescriptions = attributes.data(),
            };
            const VkPipelineInputAssemblyStateCreateInfo inputAssembly{
                .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
                .pNext = nullptr,
                .flags = 0,
                .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST,
                .primitiveRestartEnable = VK_FALSE,
            };
            const VkPipelineViewportStateCreateInfo viewportState{
                .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
                .pNext = nullptr,
                .flags = 0,
                .viewportCount = 1,
                .pViewports = nullptr,
                .scissorCount = 1,
                .pScissors = nullptr,
            };
            const VkPipelineRasterizationStateCreateInfo rasterization{
                .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
                .pNext = nullptr,
                .flags = 0,
                .depthClampEnable = VK_FALSE,
                .rasterizerDiscardEnable = VK_FALSE,
                .polygonMode = VK_POLYGON_MODE_FILL,
                .cullMode = VK_CULL_MODE_NONE,
                .frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE,
                .depthBiasEnable = VK_FALSE,
                .depthBiasConstantFactor = 0,
                .depthBiasClamp = 0,
                .depthBiasSlopeFactor = 0,
                .lineWidth = 1,
            };
            const VkPipelineMultisampleStateCreateInfo multisample{
                .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
                .pNext = nullptr,
                .flags = 0,
                .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT,
                .sampleShadingEnable = VK_FALSE,
                .minSampleShading = 0,
                .pSampleMask = nullptr,
                .alphaToCoverageEnable = VK_FALSE,
                .alphaToOneEnable = VK_FALSE,
            };
            const VkPipelineDepthStencilStateCreateInfo depthStencil{
                .sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO,
                .pNext = nullptr,
                .flags = 0,
                .depthTestEnable = VK_TRUE,
                .depthWriteEnable = VK_TRUE,
                .depthCompareOp = VK_COMPARE_OP_LESS,
                .depthBoundsTestEnable = VK_FALSE,
                .stencilTestEnable = VK_FALSE,
                .front = {},
                .back = {},
                .minDepthBounds = 0,
                .maxDepthBounds = 1,
            };
            const VkPipelineColorBlendAttachmentState blendAttachment{
                .blendEnable = blending ? VK_TRUE : VK_FALSE,
                .srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA,
                .dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA,
                .colorBlendOp = VK_BLEND_OP_ADD,
                .srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE,
                .dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA,
                .alphaBlendOp = VK_BLEND_OP_ADD,
                .colorWriteMask = VK_COLOR_COMPONENT_R_BIT
                    | VK_COLOR_COMPONENT_G_BIT
                    | VK_COLOR_COMPONENT_B_BIT
                    | VK_COLOR_COMPONENT_A_BIT,
            };
            const VkPipelineColorBlendStateCreateInfo colorBlend{
                .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
                .pNext = nullptr,
                .flags = 0,
                .logicOpEnable = VK_FALSE,
                .logicOp = VK_LOGIC_OP_COPY,
                .attachmentCount = 1,
                .pAttachments = &blendAttachment,
                .blendConstants = {0, 0, 0, 0},
            };
            const std::array<VkDynamicState, 2> dynamicStates = {
                VK_DYNAMIC_STATE_VIEWPORT,
                VK_DYNAMIC_STATE_SCISSOR,
            };
            const VkPipelineDynamicStateCreateInfo dynamicState{
                .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
                .pNext = nullptr,
                .flags = 0,
                .dynamicStateCount = static_cast<std::uint32_t>(dynamicStates.size()),
                .pDynamicStates = dynamicStates.data(),
            };
            const VkGraphicsPipelineCreateInfo pipelineInfo{
                .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO,
                .pNext = nullptr,
                .flags = 0,
                .stageCount = static_cast<std::uint32_t>(stages.size()),
                .pStages = stages.data(),
                .pVertexInputState = &vertexInput,
                .pInputAssemblyState = &inputAssembly,
                .pTessellationState = nullptr,
                .pViewportState = &viewportState,
                .pRasterizationState = &rasterization,
                .pMultisampleState = &multisample,
                .pDepthStencilState = &depthStencil,
                .pColorBlendState = &colorBlend,
                .pDynamicState = &dynamicState,
                .layout = pipelineLayout_,
                .renderPass = renderPass_,
                .subpass = 0,
                .basePipelineHandle = VK_NULL_HANDLE,
                .basePipelineIndex = -1,
            };
            VkPipeline pipeline = VK_NULL_HANDLE;
            check(
                vkCreateGraphicsPipelines(
                    device_,
                    VK_NULL_HANDLE,
                    1,
                    &pipelineInfo,
                    nullptr,
                    &pipeline
                ),
                "vkCreateGraphicsPipelines"
            );
            vkDestroyShaderModule(device_, fragmentShader, nullptr);
            vkDestroyShaderModule(device_, vertexShader, nullptr);
            return pipeline;
        } catch (...) {
            if (fragmentShader != VK_NULL_HANDLE) {
                vkDestroyShaderModule(device_, fragmentShader, nullptr);
            }
            vkDestroyShaderModule(device_, vertexShader, nullptr);
            throw;
        }
    };

    const std::vector<VkVertexInputBindingDescription> flatBindings = {
        {
            .binding = 0,
            .stride = sizeof(float) * 3,
            .inputRate = VK_VERTEX_INPUT_RATE_VERTEX,
        },
        {
            .binding = 2,
            .stride = sizeof(InstanceOffset),
            .inputRate = VK_VERTEX_INPUT_RATE_INSTANCE,
        },
    };
    const std::vector<VkVertexInputAttributeDescription> flatAttributes = {
        {
            .location = 0,
            .binding = 0,
            .format = VK_FORMAT_R32G32B32_SFLOAT,
            .offset = 0,
        },
        {
            .location = 2,
            .binding = 2,
            .format = VK_FORMAT_R32G32B32_SFLOAT,
            .offset = 0,
        },
    };
    flatPipeline_ = createPipeline(
        "benchmark/shaders/flat.vert.spv",
        "benchmark/shaders/flat.frag.spv",
        flatBindings,
        flatAttributes,
        false
    );

    const std::vector<VkVertexInputBindingDescription> materialBindings = {
        flatBindings[0],
        {
            .binding = 1,
            .stride = sizeof(float) * 2,
            .inputRate = VK_VERTEX_INPUT_RATE_VERTEX,
        },
        flatBindings[1],
    };
    const std::vector<VkVertexInputAttributeDescription> materialAttributes = {
        flatAttributes[0],
        {
            .location = 1,
            .binding = 1,
            .format = VK_FORMAT_R32G32_SFLOAT,
            .offset = 0,
        },
        flatAttributes[1],
    };
    materialPipeline_ = createPipeline(
        "benchmark/shaders/material.vert.spv",
        "benchmark/shaders/material.frag.spv",
        materialBindings,
        materialAttributes,
        true
    );
}

Texture VulkanRenderer::Impl::uploadTexture(
    const DecodedImage& decoded,
    const GlbSampler& sourceSampler
) {
    if (decoded.pixels.empty() || decoded.width == 0 || decoded.height == 0) {
        throw std::runtime_error("cannot upload empty texture");
    }
    const VkDeviceSize byteCount = decoded.pixels.size();
    Buffer staging = createBuffer(
        byteCount,
        VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
        VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT
    );
    void* mapped = nullptr;
    check(
        vkMapMemory(device_, staging.memory, 0, byteCount, 0, &mapped),
        "vkMapMemory(texture)"
    );
    std::memcpy(mapped, decoded.pixels.data(), decoded.pixels.size());
    vkUnmapMemory(device_, staging.memory);

    Texture output;
    const bool requestedMipmaps = usesMipmaps(sourceSampler.minFilter);
    VkFormatProperties formatProperties{};
    vkGetPhysicalDeviceFormatProperties(
        physicalDevice_,
        VK_FORMAT_R8G8B8A8_UNORM,
        &formatProperties
    );
    const bool supportsLinearBlit =
        (formatProperties.optimalTilingFeatures
         & VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT) != 0;
    output.mipLevels = requestedMipmaps && supportsLinearBlit
        ? static_cast<std::uint32_t>(
            std::floor(std::log2(std::max(decoded.width, decoded.height)))
        ) + 1
        : 1;

    try {
        createImage(
            decoded.width,
            decoded.height,
            output.mipLevels,
            VK_FORMAT_R8G8B8A8_UNORM,
            VK_IMAGE_USAGE_TRANSFER_SRC_BIT
                | VK_IMAGE_USAGE_TRANSFER_DST_BIT
                | VK_IMAGE_USAGE_SAMPLED_BIT,
            output.image,
            output.memory
        );
        VkCommandBuffer commandBuffer = beginOneTimeCommands();

        VkImageMemoryBarrier toTransfer{
            .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
            .pNext = nullptr,
            .srcAccessMask = 0,
            .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
            .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED,
            .newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
            .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
            .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
            .image = output.image,
            .subresourceRange = {
                .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
                .baseMipLevel = 0,
                .levelCount = output.mipLevels,
                .baseArrayLayer = 0,
                .layerCount = 1,
            },
        };
        vkCmdPipelineBarrier(
            commandBuffer,
            VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
            VK_PIPELINE_STAGE_TRANSFER_BIT,
            0,
            0,
            nullptr,
            0,
            nullptr,
            1,
            &toTransfer
        );

        const VkBufferImageCopy copy{
            .bufferOffset = 0,
            .bufferRowLength = 0,
            .bufferImageHeight = 0,
            .imageSubresource = {
                .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
                .mipLevel = 0,
                .baseArrayLayer = 0,
                .layerCount = 1,
            },
            .imageOffset = {0, 0, 0},
            .imageExtent = {decoded.width, decoded.height, 1},
        };
        vkCmdCopyBufferToImage(
            commandBuffer,
            staging.handle,
            output.image,
            VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
            1,
            &copy
        );

        std::int32_t mipWidth = static_cast<std::int32_t>(decoded.width);
        std::int32_t mipHeight = static_cast<std::int32_t>(decoded.height);
        for (std::uint32_t level = 1; level < output.mipLevels; ++level) {
            VkImageMemoryBarrier toSource{
                .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                .pNext = nullptr,
                .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
                .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
                .oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                .newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
                .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
                .image = output.image,
                .subresourceRange = {
                    .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
                    .baseMipLevel = level - 1,
                    .levelCount = 1,
                    .baseArrayLayer = 0,
                    .layerCount = 1,
                },
            };
            vkCmdPipelineBarrier(
                commandBuffer,
                VK_PIPELINE_STAGE_TRANSFER_BIT,
                VK_PIPELINE_STAGE_TRANSFER_BIT,
                0,
                0,
                nullptr,
                0,
                nullptr,
                1,
                &toSource
            );
            const std::int32_t nextWidth = std::max(1, mipWidth / 2);
            const std::int32_t nextHeight = std::max(1, mipHeight / 2);
            const VkImageBlit blit{
                .srcSubresource = {
                    .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
                    .mipLevel = level - 1,
                    .baseArrayLayer = 0,
                    .layerCount = 1,
                },
                .srcOffsets = {{0, 0, 0}, {mipWidth, mipHeight, 1}},
                .dstSubresource = {
                    .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
                    .mipLevel = level,
                    .baseArrayLayer = 0,
                    .layerCount = 1,
                },
                .dstOffsets = {{0, 0, 0}, {nextWidth, nextHeight, 1}},
            };
            vkCmdBlitImage(
                commandBuffer,
                output.image,
                VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                output.image,
                VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                1,
                &blit,
                VK_FILTER_LINEAR
            );
            mipWidth = nextWidth;
            mipHeight = nextHeight;
        }

        if (output.mipLevels > 1) {
            VkImageMemoryBarrier generatedLevels{
                .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
                .pNext = nullptr,
                .srcAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
                .dstAccessMask = VK_ACCESS_SHADER_READ_BIT,
                .oldLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                .newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
                .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
                .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
                .image = output.image,
                .subresourceRange = {
                    .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
                    .baseMipLevel = 0,
                    .levelCount = output.mipLevels - 1,
                    .baseArrayLayer = 0,
                    .layerCount = 1,
                },
            };
            vkCmdPipelineBarrier(
                commandBuffer,
                VK_PIPELINE_STAGE_TRANSFER_BIT,
                VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,
                0,
                0,
                nullptr,
                0,
                nullptr,
                1,
                &generatedLevels
            );
        }
        VkImageMemoryBarrier lastLevel{
            .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
            .pNext = nullptr,
            .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
            .dstAccessMask = VK_ACCESS_SHADER_READ_BIT,
            .oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
            .newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
            .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
            .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
            .image = output.image,
            .subresourceRange = {
                .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
                .baseMipLevel = output.mipLevels - 1,
                .levelCount = 1,
                .baseArrayLayer = 0,
                .layerCount = 1,
            },
        };
        vkCmdPipelineBarrier(
            commandBuffer,
            VK_PIPELINE_STAGE_TRANSFER_BIT,
            VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,
            0,
            0,
            nullptr,
            0,
            nullptr,
            1,
            &lastLevel
        );
        endOneTimeCommands(commandBuffer);

        output.view = createImageView(
            output.image,
            VK_FORMAT_R8G8B8A8_UNORM,
            VK_IMAGE_ASPECT_COLOR_BIT,
            output.mipLevels
        );
        const VkSamplerCreateInfo samplerInfo{
            .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO,
            .pNext = nullptr,
            .flags = 0,
            .magFilter = filterForMag(sourceSampler.magFilter),
            .minFilter = filterForMin(sourceSampler.minFilter),
            .mipmapMode = mipmapMode(sourceSampler.minFilter),
            .addressModeU = addressMode(sourceSampler.wrapS),
            .addressModeV = addressMode(sourceSampler.wrapT),
            .addressModeW = VK_SAMPLER_ADDRESS_MODE_REPEAT,
            .mipLodBias = 0,
            .anisotropyEnable = VK_FALSE,
            .maxAnisotropy = 1,
            .compareEnable = VK_FALSE,
            .compareOp = VK_COMPARE_OP_ALWAYS,
            .minLod = 0,
            .maxLod = static_cast<float>(output.mipLevels - 1),
            .borderColor = VK_BORDER_COLOR_INT_OPAQUE_BLACK,
            .unnormalizedCoordinates = VK_FALSE,
        };
        check(
            vkCreateSampler(device_, &samplerInfo, nullptr, &output.sampler),
            "vkCreateSampler"
        );
    } catch (...) {
        destroyBuffer(staging);
        destroyTexture(output);
        throw;
    }
    destroyBuffer(staging);
    return output;
}

Texture VulkanRenderer::Impl::createWhiteTexture() {
    DecodedImage white;
    white.width = 1;
    white.height = 1;
    white.pixels = {255, 255, 255, 255};
    return uploadTexture(white, {});
}

void VulkanRenderer::Impl::destroyTexture(Texture& texture) {
    if (texture.sampler != VK_NULL_HANDLE) {
        vkDestroySampler(device_, texture.sampler, nullptr);
    }
    if (texture.view != VK_NULL_HANDLE) vkDestroyImageView(device_, texture.view, nullptr);
    if (texture.image != VK_NULL_HANDLE) vkDestroyImage(device_, texture.image, nullptr);
    if (texture.memory != VK_NULL_HANDLE) vkFreeMemory(device_, texture.memory, nullptr);
    texture = {};
}

void VulkanRenderer::Impl::uploadScene() {
    flatPositions_ = uploadDeviceBuffer(
        mesh_.positions.data(),
        mesh_.positions.size() * sizeof(float),
        VK_BUFFER_USAGE_VERTEX_BUFFER_BIT
    );
    flatIndices_ = uploadDeviceBuffer(
        mesh_.indices.data(),
        mesh_.indices.size() * sizeof(std::uint32_t),
        VK_BUFFER_USAGE_INDEX_BUFFER_BIT
    );
    flatIndexCount_ = static_cast<std::uint32_t>(mesh_.indices.size());

    const std::vector<InstanceOffset> offsets = xrwallOffsets(instanceCount_, spacing_);
    instanceOffsets_ = uploadDeviceBuffer(
        offsets.data(),
        offsets.size() * sizeof(InstanceOffset),
        VK_BUFFER_USAGE_VERTEX_BUFFER_BIT
    );

    if (surfaceMode_ != "basecolor") return;

    whiteTexture_ = createWhiteTexture();
    for (const auto& [textureIndex, source] : mesh_.textures) {
        textures_.emplace(textureIndex, uploadTexture(decodeImage(source), source.sampler));
    }

    primitives_.reserve(mesh_.materialPrimitives.size());
    for (const GlbMaterialPrimitive& source : mesh_.materialPrimitives) {
        GpuPrimitive primitive;
        primitive.positions = uploadDeviceBuffer(
            source.positions.data(),
            source.positions.size() * sizeof(float),
            VK_BUFFER_USAGE_VERTEX_BUFFER_BIT
        );
        primitive.texcoords = uploadDeviceBuffer(
            source.texcoords.data(),
            source.texcoords.size() * sizeof(float),
            VK_BUFFER_USAGE_VERTEX_BUFFER_BIT
        );
        primitive.indices = uploadDeviceBuffer(
            source.indices.data(),
            source.indices.size() * sizeof(std::uint32_t),
            VK_BUFFER_USAGE_INDEX_BUFFER_BIT
        );
        primitive.indexCount = static_cast<std::uint32_t>(source.indices.size());
        primitive.baseColorFactor = source.baseColorFactor;
        primitives_.push_back(std::move(primitive));
    }

    std::vector<VkDescriptorSetLayout> layouts(
        primitives_.size(),
        descriptorSetLayout_
    );
    std::vector<VkDescriptorSet> descriptorSets(primitives_.size());
    const VkDescriptorSetAllocateInfo allocateInfo{
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .pNext = nullptr,
        .descriptorPool = descriptorPool_,
        .descriptorSetCount = static_cast<std::uint32_t>(layouts.size()),
        .pSetLayouts = layouts.data(),
    };
    check(
        vkAllocateDescriptorSets(device_, &allocateInfo, descriptorSets.data()),
        "vkAllocateDescriptorSets"
    );
    for (std::size_t index = 0; index < primitives_.size(); ++index) {
        GpuPrimitive& primitive = primitives_[index];
        primitive.descriptorSet = descriptorSets[index];
        const int textureIndex = mesh_.materialPrimitives[index].baseColorTextureIndex;
        const auto found = textures_.find(textureIndex);
        const Texture& texture = found == textures_.end()
            ? whiteTexture_
            : found->second;
        const VkDescriptorImageInfo imageInfo{
            .sampler = texture.sampler,
            .imageView = texture.view,
            .imageLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
        };
        const VkWriteDescriptorSet write{
            .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
            .pNext = nullptr,
            .dstSet = primitive.descriptorSet,
            .dstBinding = 0,
            .dstArrayElement = 0,
            .descriptorCount = 1,
            .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
            .pImageInfo = &imageInfo,
            .pBufferInfo = nullptr,
            .pTexelBufferView = nullptr,
        };
        vkUpdateDescriptorSets(device_, 1, &write, 0, nullptr);
    }
}

void VulkanRenderer::Impl::createSyncObjects() {
    const VkSemaphoreCreateInfo semaphoreInfo{
        .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO,
        .pNext = nullptr,
        .flags = 0,
    };
    const VkFenceCreateInfo fenceInfo{
        .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO,
        .pNext = nullptr,
        .flags = VK_FENCE_CREATE_SIGNALED_BIT,
    };
    for (std::size_t index = 0; index < kFramesInFlight; ++index) {
        check(
            vkCreateSemaphore(
                device_,
                &semaphoreInfo,
                nullptr,
                &imageAvailable_[index]
            ),
            "vkCreateSemaphore(image available)"
        );
        check(
            vkCreateSemaphore(
                device_,
                &semaphoreInfo,
                nullptr,
                &renderFinished_[index]
            ),
            "vkCreateSemaphore(render finished)"
        );
        check(
            vkCreateFence(device_, &fenceInfo, nullptr, &inFlight_[index]),
            "vkCreateFence"
        );
    }
}

void VulkanRenderer::Impl::recordCommands(
    VkCommandBuffer commandBuffer,
    std::uint32_t imageIndex
) {
    const VkCommandBufferBeginInfo beginInfo{
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .pNext = nullptr,
        .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT,
        .pInheritanceInfo = nullptr,
    };
    check(vkBeginCommandBuffer(commandBuffer, &beginInfo), "vkBeginCommandBuffer(frame)");

    const std::array<VkClearValue, 2> clearValues = {{
        {.color = {{0.02F, 0.03F, 0.035F, 1.0F}}},
        {.depthStencil = {1.0F, 0}},
    }};
    const VkRenderPassBeginInfo renderPassInfo{
        .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO,
        .pNext = nullptr,
        .renderPass = renderPass_,
        .framebuffer = framebuffer_,
        .renderArea = {
            .offset = {0, 0},
            .extent = renderExtent_,
        },
        .clearValueCount = static_cast<std::uint32_t>(clearValues.size()),
        .pClearValues = clearValues.data(),
    };
    vkCmdBeginRenderPass(
        commandBuffer,
        &renderPassInfo,
        VK_SUBPASS_CONTENTS_INLINE
    );

    const VkViewport viewport{
        .x = 0,
        .y = 0,
        .width = static_cast<float>(renderExtent_.width),
        .height = static_cast<float>(renderExtent_.height),
        .minDepth = 0,
        .maxDepth = 1,
    };
    const VkRect2D scissor{
        .offset = {0, 0},
        .extent = renderExtent_,
    };
    vkCmdSetViewport(commandBuffer, 0, 1, &viewport);
    vkCmdSetScissor(commandBuffer, 0, 1, &scissor);

    const VkDeviceSize offset = 0;
    if (surfaceMode_ == "flat") {
        vkCmdBindPipeline(
            commandBuffer,
            VK_PIPELINE_BIND_POINT_GRAPHICS,
            flatPipeline_
        );
        pushConstants_.baseColorFactor = {1, 1, 1, 1};
        vkCmdPushConstants(
            commandBuffer,
            pipelineLayout_,
            VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
            0,
            sizeof(PushConstants),
            &pushConstants_
        );
        vkCmdBindVertexBuffers(
            commandBuffer,
            0,
            1,
            &flatPositions_.handle,
            &offset
        );
        vkCmdBindVertexBuffers(
            commandBuffer,
            2,
            1,
            &instanceOffsets_.handle,
            &offset
        );
        vkCmdBindIndexBuffer(
            commandBuffer,
            flatIndices_.handle,
            0,
            VK_INDEX_TYPE_UINT32
        );
        vkCmdDrawIndexed(
            commandBuffer,
            flatIndexCount_,
            static_cast<std::uint32_t>(instanceCount_),
            0,
            0,
            0
        );
    } else {
        vkCmdBindPipeline(
            commandBuffer,
            VK_PIPELINE_BIND_POINT_GRAPHICS,
            materialPipeline_
        );
        for (const GpuPrimitive& primitive : primitives_) {
            pushConstants_.baseColorFactor = primitive.baseColorFactor;
            vkCmdPushConstants(
                commandBuffer,
                pipelineLayout_,
                VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
                0,
                sizeof(PushConstants),
                &pushConstants_
            );
            vkCmdBindDescriptorSets(
                commandBuffer,
                VK_PIPELINE_BIND_POINT_GRAPHICS,
                pipelineLayout_,
                0,
                1,
                &primitive.descriptorSet,
                0,
                nullptr
            );
            const std::array<VkBuffer, 3> vertexBuffers = {
                primitive.positions.handle,
                primitive.texcoords.handle,
                instanceOffsets_.handle,
            };
            const std::array<VkDeviceSize, 3> offsets = {0, 0, 0};
            vkCmdBindVertexBuffers(
                commandBuffer,
                0,
                static_cast<std::uint32_t>(vertexBuffers.size()),
                vertexBuffers.data(),
                offsets.data()
            );
            vkCmdBindIndexBuffer(
                commandBuffer,
                primitive.indices.handle,
                0,
                VK_INDEX_TYPE_UINT32
            );
            vkCmdDrawIndexed(
                commandBuffer,
                primitive.indexCount,
                static_cast<std::uint32_t>(instanceCount_),
                0,
                0,
                0
            );
        }
    }
    vkCmdEndRenderPass(commandBuffer);

    VkImageMemoryBarrier colorReady{
        .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
        .pNext = nullptr,
        .srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
        .oldLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
        .newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
        .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .image = colorImage_,
        .subresourceRange = {
            .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
            .baseMipLevel = 0,
            .levelCount = 1,
            .baseArrayLayer = 0,
            .layerCount = 1,
        },
    };
    VkImageMemoryBarrier swapReady{
        .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
        .pNext = nullptr,
        .srcAccessMask = 0,
        .dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
        .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED,
        .newLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
        .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .image = swapchainImages_.at(imageIndex),
        .subresourceRange = {
            .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
            .baseMipLevel = 0,
            .levelCount = 1,
            .baseArrayLayer = 0,
            .layerCount = 1,
        },
    };
    const std::array<VkImageMemoryBarrier, 2> beforeBlit = {
        colorReady,
        swapReady,
    };
    vkCmdPipelineBarrier(
        commandBuffer,
        VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
        VK_PIPELINE_STAGE_TRANSFER_BIT,
        0,
        0,
        nullptr,
        0,
        nullptr,
        static_cast<std::uint32_t>(beforeBlit.size()),
        beforeBlit.data()
    );

    const VkImageBlit blit{
        .srcSubresource = {
            .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
            .mipLevel = 0,
            .baseArrayLayer = 0,
            .layerCount = 1,
        },
        .srcOffsets = {
            {0, 0, 0},
            {
                static_cast<std::int32_t>(renderExtent_.width),
                static_cast<std::int32_t>(renderExtent_.height),
                1,
            },
        },
        .dstSubresource = {
            .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
            .mipLevel = 0,
            .baseArrayLayer = 0,
            .layerCount = 1,
        },
        .dstOffsets = {
            {0, 0, 0},
            {
                static_cast<std::int32_t>(swapchainExtent_.width),
                static_cast<std::int32_t>(swapchainExtent_.height),
                1,
            },
        },
    };
    vkCmdBlitImage(
        commandBuffer,
        colorImage_,
        VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
        swapchainImages_.at(imageIndex),
        VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
        1,
        &blit,
        VK_FILTER_LINEAR
    );

    VkImageMemoryBarrier readyToPresent{
        .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
        .pNext = nullptr,
        .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
        .dstAccessMask = 0,
        .oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
        .newLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR,
        .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .image = swapchainImages_.at(imageIndex),
        .subresourceRange = {
            .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
            .baseMipLevel = 0,
            .levelCount = 1,
            .baseArrayLayer = 0,
            .layerCount = 1,
        },
    };
    vkCmdPipelineBarrier(
        commandBuffer,
        VK_PIPELINE_STAGE_TRANSFER_BIT,
        VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,
        0,
        0,
        nullptr,
        0,
        nullptr,
        1,
        &readyToPresent
    );
    check(vkEndCommandBuffer(commandBuffer), "vkEndCommandBuffer(frame)");
}

void VulkanRenderer::Impl::drawFrame() {
    const std::size_t index = frameIndex_;
    check(
        vkWaitForFences(
            device_,
            1,
            &inFlight_[index],
            VK_TRUE,
            std::numeric_limits<std::uint64_t>::max()
        ),
        "vkWaitForFences"
    );

    std::uint32_t imageIndex = 0;
    const VkResult acquire = vkAcquireNextImageKHR(
        device_,
        swapchain_,
        std::numeric_limits<std::uint64_t>::max(),
        imageAvailable_[index],
        VK_NULL_HANDLE,
        &imageIndex
    );
    if (acquire == VK_ERROR_OUT_OF_DATE_KHR) {
        throw std::runtime_error("surface changed; stop and restart the preview");
    }
    if (acquire != VK_SUCCESS && acquire != VK_SUBOPTIMAL_KHR) {
        check(acquire, "vkAcquireNextImageKHR");
    }

    check(vkResetFences(device_, 1, &inFlight_[index]), "vkResetFences");
    check(
        vkResetCommandBuffer(commandBuffers_[index], 0),
        "vkResetCommandBuffer"
    );
    recordCommands(commandBuffers_[index], imageIndex);

    constexpr VkPipelineStageFlags waitStage = VK_PIPELINE_STAGE_TRANSFER_BIT;
    const VkSubmitInfo submitInfo{
        .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
        .pNext = nullptr,
        .waitSemaphoreCount = 1,
        .pWaitSemaphores = &imageAvailable_[index],
        .pWaitDstStageMask = &waitStage,
        .commandBufferCount = 1,
        .pCommandBuffers = &commandBuffers_[index],
        .signalSemaphoreCount = 1,
        .pSignalSemaphores = &renderFinished_[index],
    };
    check(
        vkQueueSubmit(queue_, 1, &submitInfo, inFlight_[index]),
        "vkQueueSubmit(frame)"
    );

    const VkPresentInfoKHR presentInfo{
        .sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR,
        .pNext = nullptr,
        .waitSemaphoreCount = 1,
        .pWaitSemaphores = &renderFinished_[index],
        .swapchainCount = 1,
        .pSwapchains = &swapchain_,
        .pImageIndices = &imageIndex,
        .pResults = nullptr,
    };
    const VkResult present = vkQueuePresentKHR(queue_, &presentInfo);
    if (present == VK_ERROR_OUT_OF_DATE_KHR) {
        throw std::runtime_error("surface changed; stop and restart the preview");
    }
    if (present != VK_SUCCESS && present != VK_SUBOPTIMAL_KHR) {
        check(present, "vkQueuePresentKHR");
    }
    frameIndex_ = (frameIndex_ + 1) % kFramesInFlight;
}

void VulkanRenderer::Impl::cleanup() {
    if (device_ != VK_NULL_HANDLE) vkDeviceWaitIdle(device_);

    if (device_ != VK_NULL_HANDLE) {
        for (std::size_t index = 0; index < kFramesInFlight; ++index) {
            if (inFlight_[index] != VK_NULL_HANDLE) {
                vkDestroyFence(device_, inFlight_[index], nullptr);
            }
            if (renderFinished_[index] != VK_NULL_HANDLE) {
                vkDestroySemaphore(device_, renderFinished_[index], nullptr);
            }
            if (imageAvailable_[index] != VK_NULL_HANDLE) {
                vkDestroySemaphore(device_, imageAvailable_[index], nullptr);
            }
        }

        for (GpuPrimitive& primitive : primitives_) {
            destroyBuffer(primitive.positions);
            destroyBuffer(primitive.texcoords);
            destroyBuffer(primitive.indices);
        }
        primitives_.clear();
        for (auto& [index, texture] : textures_) {
            (void)index;
            destroyTexture(texture);
        }
        textures_.clear();
        destroyTexture(whiteTexture_);
        destroyBuffer(instanceOffsets_);
        destroyBuffer(flatIndices_);
        destroyBuffer(flatPositions_);

        if (materialPipeline_ != VK_NULL_HANDLE) {
            vkDestroyPipeline(device_, materialPipeline_, nullptr);
        }
        if (flatPipeline_ != VK_NULL_HANDLE) {
            vkDestroyPipeline(device_, flatPipeline_, nullptr);
        }
        if (pipelineLayout_ != VK_NULL_HANDLE) {
            vkDestroyPipelineLayout(device_, pipelineLayout_, nullptr);
        }
        if (descriptorPool_ != VK_NULL_HANDLE) {
            vkDestroyDescriptorPool(device_, descriptorPool_, nullptr);
        }
        if (descriptorSetLayout_ != VK_NULL_HANDLE) {
            vkDestroyDescriptorSetLayout(device_, descriptorSetLayout_, nullptr);
        }
        if (framebuffer_ != VK_NULL_HANDLE) {
            vkDestroyFramebuffer(device_, framebuffer_, nullptr);
        }
        if (renderPass_ != VK_NULL_HANDLE) {
            vkDestroyRenderPass(device_, renderPass_, nullptr);
        }
        if (depthView_ != VK_NULL_HANDLE) {
            vkDestroyImageView(device_, depthView_, nullptr);
        }
        if (depthImage_ != VK_NULL_HANDLE) {
            vkDestroyImage(device_, depthImage_, nullptr);
        }
        if (depthMemory_ != VK_NULL_HANDLE) {
            vkFreeMemory(device_, depthMemory_, nullptr);
        }
        if (colorView_ != VK_NULL_HANDLE) {
            vkDestroyImageView(device_, colorView_, nullptr);
        }
        if (colorImage_ != VK_NULL_HANDLE) {
            vkDestroyImage(device_, colorImage_, nullptr);
        }
        if (colorMemory_ != VK_NULL_HANDLE) {
            vkFreeMemory(device_, colorMemory_, nullptr);
        }
        if (commandPool_ != VK_NULL_HANDLE) {
            vkDestroyCommandPool(device_, commandPool_, nullptr);
        }
        if (swapchain_ != VK_NULL_HANDLE) {
            vkDestroySwapchainKHR(device_, swapchain_, nullptr);
        }
        vkDestroyDevice(device_, nullptr);
        device_ = VK_NULL_HANDLE;
    }
    if (surface_ != VK_NULL_HANDLE && instance_ != VK_NULL_HANDLE) {
        vkDestroySurfaceKHR(instance_, surface_, nullptr);
        surface_ = VK_NULL_HANDLE;
    }
    if (instance_ != VK_NULL_HANDLE) {
        vkDestroyInstance(instance_, nullptr);
        instance_ = VK_NULL_HANDLE;
    }
    if (window_ != nullptr) {
        ANativeWindow_release(window_);
        window_ = nullptr;
    }
}

std::unique_ptr<VulkanRenderer> VulkanRenderer::create(
    ANativeWindow* window,
    AAssetManager* assets,
    GlbMesh mesh,
    const std::string& surfaceMode,
    double renderScale,
    int instanceCount,
    float spacing
) {
    return std::unique_ptr<VulkanRenderer>(
        new VulkanRenderer(std::make_unique<Impl>(
            window,
            assets,
            std::move(mesh),
            surfaceMode,
            renderScale,
            instanceCount,
            spacing
        ))
    );
}

VulkanRenderer::VulkanRenderer(std::unique_ptr<Impl> implementation)
    : implementation_(std::move(implementation)) {}

VulkanRenderer::~VulkanRenderer() = default;

bool VulkanRenderer::draw(std::uint64_t frameTimeNanos) {
    return implementation_->draw(frameTimeNanos);
}

const std::string& VulkanRenderer::lastError() const {
    return implementation_->lastError();
}

std::string VulkanRenderer::describe() const {
    return implementation_->describe();
}

}  // namespace native_benchmark
