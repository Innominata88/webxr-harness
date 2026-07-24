#version 450

layout(location = 0) in vec3 inPosition;
layout(location = 2) in vec3 inInstanceOffset;

layout(push_constant) uniform PushConstants {
    mat4 viewProjection;
    vec4 baseColorFactor;
} pushData;

void main() {
    gl_Position = pushData.viewProjection
        * vec4(inPosition + inInstanceOffset, 1.0);
}
