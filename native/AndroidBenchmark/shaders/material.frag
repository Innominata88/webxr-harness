#version 450

layout(set = 0, binding = 0) uniform sampler2D baseColorTexture;

layout(location = 0) in vec2 inTexcoord;
layout(location = 0) out vec4 outColor;

layout(push_constant) uniform PushConstants {
    mat4 viewProjection;
    vec4 baseColorFactor;
} pushData;

void main() {
    vec4 color = texture(baseColorTexture, inTexcoord)
        * pushData.baseColorFactor;
    if (color.a <= 0.001) {
        discard;
    }
    outColor = color;
}
