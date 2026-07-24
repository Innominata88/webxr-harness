cmake_minimum_required(VERSION 3.22.1)
project(native_benchmark LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(native-benchmark SHARED
    jni_bridge.cpp
    asset/glb_loader.cpp
    core/benchmark_plan.cpp
    core/condition_plan.cpp
    core/instance_layout.cpp
    core/simple_json.cpp
    core/stats.cpp
    render/vulkan_renderer.cpp
    runtime/vulkan_probe.cpp
)

target_include_directories(native-benchmark PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_definitions(native-benchmark PRIVATE VK_USE_PLATFORM_ANDROID_KHR)
target_compile_options(native-benchmark PRIVATE
    -Wall -Wextra -Wpedantic
    $<$<CONFIG:Release>:-Werror>
)

find_library(android-lib android REQUIRED)
find_library(jnigraphics-lib jnigraphics REQUIRED)
find_library(log-lib log REQUIRED)
find_library(vulkan-lib vulkan REQUIRED)

target_link_libraries(native-benchmark
    ${android-lib}
    ${jnigraphics-lib}
    ${log-lib}
    ${vulkan-lib}
)
