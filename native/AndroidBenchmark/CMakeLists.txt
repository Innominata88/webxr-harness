cmake_minimum_required(VERSION 3.22.1)
project(native_benchmark_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CORE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/app/src/main/cpp/core")

add_library(native_benchmark_core
    "${CORE_DIR}/../asset/glb_loader.cpp"
    "${CORE_DIR}/benchmark_plan.cpp"
    "${CORE_DIR}/condition_plan.cpp"
    "${CORE_DIR}/instance_layout.cpp"
    "${CORE_DIR}/simple_json.cpp"
    "${CORE_DIR}/stats.cpp"
)
target_include_directories(native_benchmark_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/app/src/main/cpp"
)
target_compile_options(native_benchmark_core PRIVATE
    -Wall -Wextra -Wpedantic -Werror
)

add_executable(native_core_tests
    host-tests/core_tests.cpp
)
target_link_libraries(native_core_tests PRIVATE native_benchmark_core)
target_compile_options(native_core_tests PRIVATE
    -Wall -Wextra -Wpedantic -Werror
)

enable_testing()
add_test(
    NAME native_core_tests
    COMMAND native_core_tests
        "${CMAKE_CURRENT_SOURCE_DIR}/../../assets/spiderman_2002_movie_version_sam_raimi_0.glb"
        "${CMAKE_CURRENT_SOURCE_DIR}/../plans/pixel8a_native_canvas_material_complexity_regular_5sets.json"
        "${CMAKE_CURRENT_SOURCE_DIR}/../plans/pixel8a_native_canvas_material_complexity_regular_smoke_1sets.json"
        "${CMAKE_CURRENT_SOURCE_DIR}/../plans/pixel8a_native_canvas_primary_regular_5sets.json"
        "${CMAKE_CURRENT_SOURCE_DIR}/../plans/pixel8a_native_canvas_primary_regular_smoke_1sets.json"
        "${CMAKE_CURRENT_SOURCE_DIR}/../plans/samsung_fe5g_native_canvas_material_complexity_regular_5sets.json"
        "${CMAKE_CURRENT_SOURCE_DIR}/../plans/samsung_fe5g_native_canvas_material_complexity_regular_smoke_1sets.json"
        "${CMAKE_CURRENT_SOURCE_DIR}/../plans/samsung_fe5g_native_canvas_primary_regular_5sets.json"
        "${CMAKE_CURRENT_SOURCE_DIR}/../plans/samsung_fe5g_native_canvas_primary_regular_smoke_1sets.json"
)
