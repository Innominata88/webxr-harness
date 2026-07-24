#version 450

layout(location = 0) in vec3 inPosition;
layout(location = 1) in vec2 inTexcoord;
layout(location = 2) in vec3 inInstanceOffset;

layout(location = 0) out vec2 outTexcoord;

layout(push_constant) uniform PushConstants {
    mat4 viewProjection;
    vec4 baseColorFactor;
} pushData;

void main() {
    outTexcoord = inTexcoord;
    gl_Position = pushData.viewProjection
        * vec4(inPosition + inInstanceOffset, 1.0);
}
