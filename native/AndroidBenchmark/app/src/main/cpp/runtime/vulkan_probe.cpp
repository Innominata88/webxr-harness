#include "runtime/vulkan_probe.h"

#include <vulkan/vulkan.h>

#include <algorithm>
#include <cstdint>
#include <iomanip>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace native_benchmark {
namespace {

void check(VkResult result, const char* operation) {
    if (result != VK_SUCCESS) {
        throw std::runtime_error(
            std::string(operation) + " failed with VkResult=" + std::to_string(result)
        );
    }
}

std::set<std::string> instanceExtensions() {
    std::uint32_t count = 0;
    check(vkEnumerateInstanceExtensionProperties(nullptr, &count, nullptr),
          "vkEnumerateInstanceExtensionProperties(count)");
    std::vector<VkExtensionProperties> properties(count);
    check(vkEnumerateInstanceExtensionProperties(nullptr, &count, properties.data()),
          "vkEnumerateInstanceExtensionProperties(values)");
    std::set<std::string> names;
    for (const VkExtensionProperties& property : properties) {
        names.emplace(property.extensionName);
    }
    return names;
}

bool hasDeviceExtension(VkPhysicalDevice device, const char* required) {
    std::uint32_t count = 0;
    if (vkEnumerateDeviceExtensionProperties(device, nullptr, &count, nullptr) != VK_SUCCESS) {
        return false;
    }
    std::vector<VkExtensionProperties> properties(count);
    if (vkEnumerateDeviceExtensionProperties(
            device,
            nullptr,
            &count,
            properties.data()
        ) != VK_SUCCESS) {
        return false;
    }
    return std::any_of(
        properties.begin(),
        properties.end(),
        [required](const VkExtensionProperties& property) {
            return std::string(property.extensionName) == required;
        }
    );
}

std::string version(std::uint32_t value) {
    std::ostringstream output;
    output
        << VK_VERSION_MAJOR(value) << '.'
        << VK_VERSION_MINOR(value) << '.'
        << VK_VERSION_PATCH(value);
    return output.str();
}

std::string jsonEscape(const std::string& value) {
    std::ostringstream output;
    for (const unsigned char character : value) {
        switch (character) {
            case '"': output << "\\\""; break;
            case '\\': output << "\\\\"; break;
            case '\b': output << "\\b"; break;
            case '\f': output << "\\f"; break;
            case '\n': output << "\\n"; break;
            case '\r': output << "\\r"; break;
            case '\t': output << "\\t"; break;
            default:
                if (character < 0x20) {
                    output
                        << "\\u"
                        << std::hex << std::setw(4) << std::setfill('0')
                        << static_cast<int>(character)
                        << std::dec << std::setfill(' ');
                } else {
                    output << static_cast<char>(character);
                }
        }
    }
    return output.str();
}

}  // namespace

std::string probeVulkan(ANativeWindow* window) {
    if (window == nullptr) {
        return R"({"ok":false,"error":"Android surface is not ready"})";
    }

    VkInstance instance = VK_NULL_HANDLE;
    VkSurfaceKHR surface = VK_NULL_HANDLE;
    try {
        const std::set<std::string> extensions = instanceExtensions();
        for (const char* required : {
            VK_KHR_SURFACE_EXTENSION_NAME,
            VK_KHR_ANDROID_SURFACE_EXTENSION_NAME,
        }) {
            if (!extensions.contains(required)) {
                throw std::runtime_error(std::string("missing instance extension ") + required);
            }
        }

        const char* enabledExtensions[] = {
            VK_KHR_SURFACE_EXTENSION_NAME,
            VK_KHR_ANDROID_SURFACE_EXTENSION_NAME,
        };
        const VkApplicationInfo applicationInfo{
            .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
            .pNext = nullptr,
            .pApplicationName = "NativeBenchmark",
            .applicationVersion = VK_MAKE_VERSION(0, 1, 0),
            .pEngineName = "NativeBenchmark",
            .engineVersion = VK_MAKE_VERSION(0, 1, 0),
            .apiVersion = VK_API_VERSION_1_1,
        };
        const VkInstanceCreateInfo createInfo{
            .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
            .pNext = nullptr,
            .flags = 0,
            .pApplicationInfo = &applicationInfo,
            .enabledLayerCount = 0,
            .ppEnabledLayerNames = nullptr,
            .enabledExtensionCount = 2,
            .ppEnabledExtensionNames = enabledExtensions,
        };
        check(vkCreateInstance(&createInfo, nullptr, &instance), "vkCreateInstance");

        const VkAndroidSurfaceCreateInfoKHR surfaceInfo{
            .sType = VK_STRUCTURE_TYPE_ANDROID_SURFACE_CREATE_INFO_KHR,
            .pNext = nullptr,
            .flags = 0,
            .window = window,
        };
        check(vkCreateAndroidSurfaceKHR(instance, &surfaceInfo, nullptr, &surface),
              "vkCreateAndroidSurfaceKHR");

        std::uint32_t deviceCount = 0;
        check(vkEnumeratePhysicalDevices(instance, &deviceCount, nullptr),
              "vkEnumeratePhysicalDevices(count)");
        if (deviceCount == 0) throw std::runtime_error("no Vulkan physical device");
        std::vector<VkPhysicalDevice> devices(deviceCount);
        check(vkEnumeratePhysicalDevices(instance, &deviceCount, devices.data()),
              "vkEnumeratePhysicalDevices(values)");

        VkPhysicalDevice selected = VK_NULL_HANDLE;
        std::uint32_t selectedQueue = 0;
        for (VkPhysicalDevice device : devices) {
            if (!hasDeviceExtension(device, VK_KHR_SWAPCHAIN_EXTENSION_NAME)) continue;
            std::uint32_t queueCount = 0;
            vkGetPhysicalDeviceQueueFamilyProperties(device, &queueCount, nullptr);
            std::vector<VkQueueFamilyProperties> queues(queueCount);
            vkGetPhysicalDeviceQueueFamilyProperties(device, &queueCount, queues.data());
            for (std::uint32_t index = 0; index < queueCount; ++index) {
                VkBool32 present = VK_FALSE;
                check(vkGetPhysicalDeviceSurfaceSupportKHR(device, index, surface, &present),
                      "vkGetPhysicalDeviceSurfaceSupportKHR");
                if ((queues[index].queueFlags & VK_QUEUE_GRAPHICS_BIT) != 0
                    && present == VK_TRUE) {
                    selected = device;
                    selectedQueue = index;
                    break;
                }
            }
            if (selected != VK_NULL_HANDLE) break;
        }
        if (selected == VK_NULL_HANDLE) {
            throw std::runtime_error("no graphics+present queue with VK_KHR_swapchain");
        }

        VkPhysicalDeviceProperties properties{};
        vkGetPhysicalDeviceProperties(selected, &properties);
        std::uint32_t formatCount = 0;
        check(vkGetPhysicalDeviceSurfaceFormatsKHR(selected, surface, &formatCount, nullptr),
              "vkGetPhysicalDeviceSurfaceFormatsKHR");
        std::uint32_t presentModeCount = 0;
        check(vkGetPhysicalDeviceSurfacePresentModesKHR(
            selected,
            surface,
            &presentModeCount,
            nullptr
        ), "vkGetPhysicalDeviceSurfacePresentModesKHR");
        VkSurfaceCapabilitiesKHR capabilities{};
        check(vkGetPhysicalDeviceSurfaceCapabilitiesKHR(selected, surface, &capabilities),
              "vkGetPhysicalDeviceSurfaceCapabilitiesKHR");

        std::ostringstream output;
        output
            << R"({"ok":true)"
            << R"(,"gpu_renderer":")" << jsonEscape(properties.deviceName) << '"'
            << R"(,"vulkan_api_version":")" << version(properties.apiVersion) << '"'
            << R"(,"driver_version_raw":)" << properties.driverVersion
            << R"(,"vendor_id":)" << properties.vendorID
            << R"(,"device_id":)" << properties.deviceID
            << R"(,"queue_family":)" << selectedQueue
            << R"(,"surface_format_count":)" << formatCount
            << R"(,"present_mode_count":)" << presentModeCount
            << R"(,"surface_width":)" << capabilities.currentExtent.width
            << R"(,"surface_height":)" << capabilities.currentExtent.height
            << R"(,"min_image_count":)" << capabilities.minImageCount
            << R"(,"max_image_count":)" << capabilities.maxImageCount
            << '}';

        vkDestroySurfaceKHR(instance, surface, nullptr);
        vkDestroyInstance(instance, nullptr);
        return output.str();
    } catch (const std::exception& error) {
        if (surface != VK_NULL_HANDLE && instance != VK_NULL_HANDLE) {
            vkDestroySurfaceKHR(instance, surface, nullptr);
        }
        if (instance != VK_NULL_HANDLE) vkDestroyInstance(instance, nullptr);
        return std::string(R"({"ok":false,"error":")")
            + jsonEscape(error.what())
            + R"("})";
    }
}

}  // namespace native_benchmark
