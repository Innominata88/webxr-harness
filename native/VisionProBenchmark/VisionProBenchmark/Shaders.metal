#include <metal_stdlib>
using namespace metal;

struct MaterialVertexIn {
    float3 position [[attribute(0)]];
    float2 texcoord [[attribute(1)]];
};

struct InstanceOffset {
    packed_float3 offset;
};

struct MaterialVertexOut {
    float4 position [[position]];
    float2 texcoord;
};

vertex MaterialVertexOut material_vertex(
    MaterialVertexIn in [[stage_in]],
    constant float4x4 &viewProjection [[buffer(1)]],
    const device InstanceOffset *instances [[buffer(2)]],
    uint instanceID [[instance_id]]
) {
    float3 worldPosition = in.position + float3(instances[instanceID].offset);
    MaterialVertexOut out;
    out.position = viewProjection * float4(worldPosition, 1.0);
    out.texcoord = in.texcoord;
    return out;
}

fragment float4 material_fragment(
    MaterialVertexOut in [[stage_in]],
    constant float4 &baseColorFactor [[buffer(0)]],
    texture2d<float> baseColorTexture [[texture(0)]],
    sampler baseColorSampler [[sampler(0)]]
) {
    float4 color = baseColorTexture.sample(baseColorSampler, in.texcoord)
        * baseColorFactor;
    if (color.a <= 0.001) {
        discard_fragment();
    }
    return color;
}
