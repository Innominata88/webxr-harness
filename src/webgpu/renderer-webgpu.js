// src/webgpu/renderer-webgpu.js
import { mat4Mul } from "../common/mat4.js";

const DEBUG_COLOR_MODES = Object.freeze({
  flat: 0,
  abspos: 1,
  instance: 2,
});

function normalizeDebugColorMode(value) {
  const v = (typeof value === "string" ? value : "flat").toLowerCase();
  if (v === "abspos" || v === "instance" || v === "flat") return v;
  return "flat";
}

function normalizeSurfaceMode(value) {
  return String(value || "flat").toLowerCase() === "basecolor" ? "basecolor" : "flat";
}

function mapAddressMode(value) {
  switch (Number(value)) {
    case 33071: return "clamp-to-edge";
    case 33648: return "mirror-repeat";
    default: return "repeat";
  }
}

function mapMagFilter(value) {
  return Number(value) === 9728 ? "nearest" : "linear";
}

function mapMinFilter(value) {
  switch (Number(value)) {
    case 9728:
    case 9984:
    case 9986:
      return "nearest";
    default:
      return "linear";
  }
}

function mapMipmapFilter(value) {
  switch (Number(value)) {
    case 9984:
    case 9985:
      return "nearest";
    case 9986:
    case 9987:
      return "linear";
    default:
      return "linear";
  }
}

function buildZeroTexcoords(vertexCount) {
  return new Float32Array(vertexCount * 2);
}

function ensureExternalImageSource(decodedImage) {
  if (decodedImage?.kind === "imageBitmap") return decodedImage.source;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(decodedImage.width, decodedImage.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(decodedImage.source, 0, 0);
    return canvas;
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = decodedImage.width;
    canvas.height = decodedImage.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(decodedImage.source, 0, 0);
    return canvas;
  }
  return decodedImage.source;
}

function createWhiteTexture(device) {
  const texture = device.createTexture({
    size: [1, 1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 },
    { width: 1, height: 1, depthOrArrayLayers: 1 }
  );
  return texture;
}

function createTextureFromImage(device, decodedImage) {
  const width = Math.max(1, decodedImage.width | 0);
  const height = Math.max(1, decodedImage.height | 0);
  const texture = device.createTexture({
    size: [width, height, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const source = ensureExternalImageSource(decodedImage);
  device.queue.copyExternalImageToTexture(
    { source },
    { texture },
    { width, height, depthOrArrayLayers: 1 }
  );
  return texture;
}

export class WebGPUMeshRenderer {
  constructor(device, colorFormat, depthFormat = "depth24plus", opts = {}) {
    const CAMERA_SLOT_STRIDE = 256;
    const CAMERA_SLOT_COUNT = 2;
    const INITIAL_INSTANCE_CAPACITY = 4096;
    const INSTANCE_STRIDE_BYTES = 4 * 3;
    const MATERIAL_UNIFORM_BYTES = 32;

    this.device = device;
    this.colorFormat = colorFormat;
    this.depthFormat = depthFormat;
    this.cameraSlotStride = CAMERA_SLOT_STRIDE;
    this.cameraSlotCount = CAMERA_SLOT_COUNT;
    this.instanceStrideBytes = INSTANCE_STRIDE_BYTES;
    this.materialUniformBytes = MATERIAL_UNIFORM_BYTES;
    this.instanceCapacity = 0;
    this.debugColorModeName = normalizeDebugColorMode(opts.debugColor);
    this.debugColorMode = DEBUG_COLOR_MODES[this.debugColorModeName];
    this.surfaceMode = normalizeSurfaceMode(opts.surfaceMode);
    this.activeSurfaceMode = "flat";
    this.debugParamsScratch = new Float32Array(4);

    this.uniformBuffer = device.createBuffer({
      size: this.cameraSlotStride * this.cameraSlotCount,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.cameraBindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    });

    this.materialBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    this.flatPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.cameraBindGroupLayout] });
    this.materialPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.cameraBindGroupLayout, this.materialBindGroupLayout] });

    const flatShaderModule = device.createShaderModule({
      code: `
struct Camera {
  viewProj : mat4x4<f32>,
  debugParams : vec4<f32>,
}
@group(0) @binding(0) var<uniform> camera : Camera;

struct VSIn {
  @location(0) position : vec3<f32>,
  @location(1) instanceOffset : vec3<f32>,
  @builtin(instance_index) instanceIndex : u32,
}
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) dbg : vec3<f32>,
  @location(1) iid : f32,
}
@vertex
fn vsMain(input: VSIn) -> VSOut {
  var out : VSOut;
  let p = input.position + input.instanceOffset;
  out.pos = camera.viewProj * vec4<f32>(p, 1.0);
  out.dbg = abs(p);
  out.iid = f32(input.instanceIndex);
  return out;
}

fn hash01(x : f32) -> f32 {
  return fract(sin(x * 12.9898) * 43758.5453);
}
@fragment
fn fsMain(input: VSOut) -> @location(0) vec4<f32> {
  let mode = camera.debugParams.x;
  if (mode < 0.5) {
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
  }
  if (mode < 1.5) {
    return vec4<f32>(min(input.dbg, vec3<f32>(1.0, 1.0, 1.0)), 1.0);
  }
  let r = hash01(input.iid + 0.13);
  let g = hash01(input.iid + 1.17);
  let b = hash01(input.iid + 2.31);
  return vec4<f32>(r, g, b, 1.0);
}
      `,
    });

    const materialShaderModule = device.createShaderModule({
      code: `
struct Camera {
  viewProj : mat4x4<f32>,
  debugParams : vec4<f32>,
}
struct MaterialParams {
  baseColorFactor : vec4<f32>,
  useTexture : vec4<f32>,
}
@group(0) @binding(0) var<uniform> camera : Camera;
@group(1) @binding(0) var materialSampler : sampler;
@group(1) @binding(1) var materialTexture : texture_2d<f32>;
@group(1) @binding(2) var<uniform> material : MaterialParams;

struct VSIn {
  @location(0) position : vec3<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) instanceOffset : vec3<f32>,
}
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}
@vertex
fn vsMain(input: VSIn) -> VSOut {
  var out : VSOut;
  let p = input.position + input.instanceOffset;
  out.pos = camera.viewProj * vec4<f32>(p, 1.0);
  out.uv = input.uv;
  return out;
}
@fragment
fn fsMain(input: VSOut) -> @location(0) vec4<f32> {
  let sampled = textureSample(materialTexture, materialSampler, input.uv);
  let texel = sampled * material.useTexture.x + vec4<f32>(1.0, 1.0, 1.0, 1.0) * (1.0 - material.useTexture.x);
  let color = texel * material.baseColorFactor;
  if (color.a <= 0.001) {
    discard;
  }
  return color;
}
      `,
    });

    this.pipeline = device.createRenderPipeline({
      layout: this.flatPipelineLayout,
      vertex: {
        module: flatShaderModule,
        entryPoint: "vsMain",
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, format: "float32x3", offset: 0 }] },
          { arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 1, format: "float32x3", offset: 0 }] },
        ],
      },
      fragment: { module: flatShaderModule, entryPoint: "fsMain", targets: [{ format: colorFormat }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: depthFormat },
    });

    this.materialPipeline = device.createRenderPipeline({
      layout: this.materialPipelineLayout,
      vertex: {
        module: materialShaderModule,
        entryPoint: "vsMain",
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, format: "float32x3", offset: 0 }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 1, format: "float32x2", offset: 0 }] },
          { arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 2, format: "float32x3", offset: 0 }] },
        ],
      },
      fragment: {
        module: materialShaderModule,
        entryPoint: "fsMain",
        targets: [{
          format: colorFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: depthFormat },
    });

    this.bindGroups = [];
    for (let i = 0; i < this.cameraSlotCount; i++) {
      this.bindGroups.push(device.createBindGroup({
        layout: this.cameraBindGroupLayout,
        entries: [{
          binding: 0,
          resource: {
            buffer: this.uniformBuffer,
            offset: i * this.cameraSlotStride,
            size: 4 * 4 * 5,
          },
        }],
      }));
    }

    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.indexFormat = null;
    this.indexCount = 0;
    this.vertexCount = 0;

    this.instanceBuffer = null;
    this._ensureInstanceCapacity(INITIAL_INSTANCE_CAPACITY);
    this.instanceCount = 1;
    this.viewProjScratch = Array.from({ length: this.cameraSlotCount }, () => new Float32Array(16));

    this.whiteTexture = createWhiteTexture(device);
    this.whiteTextureView = this.whiteTexture.createView();
    this.defaultSampler = device.createSampler({
      addressModeU: "repeat",
      addressModeV: "repeat",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });
    this.materialPrimitives = [];
    this.textureCache = new Map();
    this.samplerCache = new Map();

    this.setDebugColor(this.debugColorModeName);
  }

  setDebugColor(modeName = "flat") {
    const normalized = normalizeDebugColorMode(modeName);
    this.debugColorModeName = normalized;
    this.debugColorMode = DEBUG_COLOR_MODES[normalized];
    for (let i = 0; i < this.cameraSlotCount; i++) {
      this.debugParamsScratch[0] = this.debugColorMode;
      this.debugParamsScratch[1] = 0;
      this.debugParamsScratch[2] = 0;
      this.debugParamsScratch[3] = 0;
      this.device.queue.writeBuffer(this.uniformBuffer, i * this.cameraSlotStride + (4 * 4 * 4), this.debugParamsScratch);
    }
    return normalized;
  }

  setSurfaceMode(modeName = "flat") {
    this.surfaceMode = normalizeSurfaceMode(modeName);
    return this.surfaceMode;
  }

  _ensureInstanceCapacity(instanceCount) {
    const required = Math.max(1, instanceCount | 0);
    if (required <= this.instanceCapacity) return;

    let next = Math.max(4096, this.instanceCapacity || 0);
    while (next < required) next *= 2;

    const maxBufferSize = Number(this.device.limits?.maxBufferSize || Number.MAX_SAFE_INTEGER);
    const maxInstances = Math.floor(maxBufferSize / this.instanceStrideBytes);
    if (required > maxInstances) {
      throw new Error(`Instance count ${required} exceeds device limit ${maxInstances}`);
    }
    if (next > maxInstances) next = maxInstances;

    this.instanceBuffer = this.device.createBuffer({
      size: next * this.instanceStrideBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.instanceCapacity = next;
  }

  _setFlatMesh({ positions, indices }) {
    this.activeSurfaceMode = "flat";
    this.materialPrimitives = [];
    this.textureCache = new Map();
    this.samplerCache = new Map();

    this.vertexBuffer = this.device.createBuffer({
      size: positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, positions);

    if (indices) {
      this.indexBuffer = this.device.createBuffer({
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.indexBuffer, 0, indices);
      this.indexCount = indices.length;
      this.indexFormat = (indices instanceof Uint16Array) ? "uint16" : "uint32";
    } else {
      this.vertexCount = positions.length / 3;
      this.indexBuffer = null;
      this.indexCount = 0;
      this.indexFormat = null;
    }
  }

  _getSampler(textureRecord, samplerByIndex) {
    const samplerIndex = Number.isInteger(textureRecord?.samplerIndex) ? textureRecord.samplerIndex : -1;
    if (this.samplerCache.has(samplerIndex)) return this.samplerCache.get(samplerIndex);
    const samplerRecord = samplerByIndex.get(samplerIndex) || null;
    const sampler = this.device.createSampler({
      addressModeU: mapAddressMode(samplerRecord?.wrapS),
      addressModeV: mapAddressMode(samplerRecord?.wrapT),
      magFilter: mapMagFilter(samplerRecord?.magFilter),
      minFilter: mapMinFilter(samplerRecord?.minFilter),
      mipmapFilter: mapMipmapFilter(samplerRecord?.minFilter),
    });
    this.samplerCache.set(samplerIndex, sampler);
    return sampler;
  }

  _getTextureView(textureIndex, materialScene, texcoordsAvailable) {
    if (!texcoordsAvailable || textureIndex < 0) {
      return { textureView: this.whiteTextureView, useTexture: 0, sampler: this.defaultSampler };
    }
    if (this.textureCache.has(textureIndex)) {
      return this.textureCache.get(textureIndex);
    }
    const textureRecord = (materialScene.textures || []).find((entry) => entry.textureIndex === textureIndex);
    if (!textureRecord?.image) {
      return { textureView: this.whiteTextureView, useTexture: 0, sampler: this.defaultSampler };
    }
    const texture = createTextureFromImage(this.device, textureRecord.image);
    const entry = { textureView: texture.createView(), texture, textureRecord };
    this.textureCache.set(textureIndex, entry);
    return entry;
  }

  _setMaterialMesh(materialScene) {
    this.activeSurfaceMode = "basecolor";
    this.materialPrimitives = [];
    this.textureCache = new Map();
    this.samplerCache = new Map();
    const samplerByIndex = new Map((materialScene.samplers || []).map((sampler) => [sampler.samplerIndex, sampler]));

    for (const primitive of materialScene.primitives || []) {
      const positionBuffer = this.device.createBuffer({
        size: primitive.positions.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(positionBuffer, 0, primitive.positions);

      const vertexCount = primitive.positions.length / 3;
      const uvData = primitive.texcoords || buildZeroTexcoords(vertexCount);
      const uvBuffer = this.device.createBuffer({
        size: uvData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(uvBuffer, 0, uvData);

      let indexBuffer = null;
      let indexCount = 0;
      let indexFormat = null;
      if (primitive.indices) {
        indexBuffer = this.device.createBuffer({
          size: primitive.indices.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(indexBuffer, 0, primitive.indices);
        indexCount = primitive.indices.length;
        indexFormat = primitive.indices instanceof Uint16Array ? "uint16" : "uint32";
      }

      const factor = new Float32Array(8);
      const baseColorFactor = primitive.material?.baseColorFactor || [1, 1, 1, 1];
      factor.set(baseColorFactor, 0);
      const textureEntry = this._getTextureView(
        primitive.material?.baseColorTextureIndex ?? -1,
        materialScene,
        !!primitive.texcoords
      );
      const sampler = textureEntry.textureRecord ? this._getSampler(textureEntry.textureRecord, samplerByIndex) : this.defaultSampler;
      factor[4] = textureEntry.textureRecord && primitive.texcoords ? 1 : 0;

      const materialUniform = this.device.createBuffer({
        size: this.materialUniformBytes,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(materialUniform, 0, factor);

      const materialBindGroup = this.device.createBindGroup({
        layout: this.materialBindGroupLayout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: textureEntry.textureView },
          { binding: 2, resource: { buffer: materialUniform } },
        ],
      });

      this.materialPrimitives.push({
        positionBuffer,
        uvBuffer,
        indexBuffer,
        indexCount,
        indexFormat,
        vertexCount: primitive.indices ? 0 : vertexCount,
        materialBindGroup,
      });
    }
  }

  setMesh(mesh) {
    if (this.surfaceMode === "basecolor" && mesh?.materialScene?.mode === "basecolor") {
      this._setMaterialMesh(mesh.materialScene);
      return;
    }
    this._setFlatMesh(mesh);
  }

  _mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  _genOffsets(n, spacing, layout, seed) {
    const offsets = new Float32Array(n * 3);
    const rng = this._mulberry32(seed >>> 0);

    if (layout === "grid") {
      const side = Math.ceil(Math.sqrt(n));
      const half = (side - 1) / 2;
      for (let i = 0; i < n; i++) {
        const gx = (i % side) - half;
        const gz = Math.floor(i / side) - half;
        offsets[i * 3 + 0] = gx * spacing;
        offsets[i * 3 + 1] = 0;
        offsets[i * 3 + 2] = -gz * spacing;
      }
      return offsets;
    }

    if (layout === "spiral") {
      for (let i = 0; i < n; i++) {
        const a = i * 0.55;
        const r = spacing * Math.sqrt(i);
        offsets[i * 3 + 0] = r * Math.cos(a);
        offsets[i * 3 + 1] = 0;
        offsets[i * 3 + 2] = -r * Math.sin(a);
      }
      return offsets;
    }

    if (layout === "random") {
      const span = spacing * Math.sqrt(n);
      for (let i = 0; i < n; i++) {
        offsets[i * 3 + 0] = (rng() - 0.5) * span;
        offsets[i * 3 + 1] = 0;
        offsets[i * 3 + 2] = -(rng() - 0.5) * span;
      }
      return offsets;
    }

    if (layout === "xrwall") {
      const targetAspect = 16 / 9;
      const cols = Math.max(1, Math.ceil(Math.sqrt(n * targetAspect)));
      const rows = Math.max(1, Math.ceil(n / cols));
      const xHalf = (cols - 1) / 2;
      const yHalf = (rows - 1) / 2;
      for (let i = 0; i < n; i++) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        offsets[i * 3 + 0] = (c - xHalf) * spacing;
        offsets[i * 3 + 1] = (yHalf - r) * spacing;
        offsets[i * 3 + 2] = 0;
      }
      return offsets;
    }

    for (let i = 0; i < n; i++) {
      offsets[i * 3 + 0] = 0;
      offsets[i * 3 + 1] = 0;
      offsets[i * 3 + 2] = -i * spacing;
    }
    return offsets;
  }

  setInstanceOffsets(offsets) {
    this.instanceCount = Math.floor(offsets.length / 3);
    this._ensureInstanceCapacity(this.instanceCount);
    this.device.queue.writeBuffer(this.instanceBuffer, 0, offsets);
  }

  setInstances(n, spacing = 0.25, opts = {}) {
    const layout = (opts.layout || "line");
    const seed = (opts.seed ?? 12345) >>> 0;
    const offsets = this._genOffsets(n, spacing, layout, seed);

    if (opts.isXR) {
      const frontMinZ = (Number.isFinite(opts.xrFrontMinZ) ? opts.xrFrontMinZ : -2.0);
      const yOffset = (Number.isFinite(opts.xrYOffset) ? opts.xrYOffset : 1.4);
      let maxZ = -Infinity;
      for (let i = 0; i < n; i++) maxZ = Math.max(maxZ, offsets[i * 3 + 2]);
      const shiftZ = frontMinZ - maxZ;
      for (let i = 0; i < n; i++) {
        offsets[i * 3 + 1] += yOffset;
        offsets[i * 3 + 2] += shiftZ;
      }
    }

    if (opts.isXR) {
      const anchorYaw = Number.isFinite(opts.xrAnchorYaw) ? opts.xrAnchorYaw : null;
      const anchorX = Number.isFinite(opts.xrAnchorX) ? opts.xrAnchorX : null;
      const anchorZ = Number.isFinite(opts.xrAnchorZ) ? opts.xrAnchorZ : null;
      if (anchorYaw != null && anchorX != null && anchorZ != null) {
        const c = Math.cos(anchorYaw);
        const s = Math.sin(anchorYaw);
        for (let i = 0; i < n; i++) {
          const lx = offsets[i * 3 + 0];
          const lz = offsets[i * 3 + 2];
          offsets[i * 3 + 0] = anchorX + (lx * c) + (lz * s);
          offsets[i * 3 + 2] = anchorZ + (-lx * s) + (lz * c);
        }
      }
    }

    this.setInstanceOffsets(offsets);
  }

  setCamera(projectionMat, viewMat, cameraSlot = 0) {
    if (cameraSlot < 0 || cameraSlot >= this.cameraSlotCount) {
      throw new Error(`Camera slot ${cameraSlot} out of range`);
    }
    const viewProj = this.viewProjScratch[cameraSlot];
    mat4Mul(viewProj, projectionMat, viewMat);
    this.device.queue.writeBuffer(this.uniformBuffer, cameraSlot * this.cameraSlotStride, viewProj);
  }

  draw(renderPass, cameraSlot = 0) {
    if (this.activeSurfaceMode === "basecolor") {
      renderPass.setPipeline(this.materialPipeline);
      renderPass.setBindGroup(0, this.bindGroups[cameraSlot] || this.bindGroups[0]);
      renderPass.setVertexBuffer(2, this.instanceBuffer);
      for (const primitive of this.materialPrimitives) {
        renderPass.setBindGroup(1, primitive.materialBindGroup);
        renderPass.setVertexBuffer(0, primitive.positionBuffer);
        renderPass.setVertexBuffer(1, primitive.uvBuffer);
        if (primitive.indexBuffer) {
          renderPass.setIndexBuffer(primitive.indexBuffer, primitive.indexFormat);
          renderPass.drawIndexed(primitive.indexCount, this.instanceCount);
        } else {
          renderPass.draw(primitive.vertexCount, this.instanceCount);
        }
      }
      return;
    }

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroups[cameraSlot] || this.bindGroups[0]);
    renderPass.setVertexBuffer(0, this.vertexBuffer);
    renderPass.setVertexBuffer(1, this.instanceBuffer);

    if (this.indexBuffer) {
      renderPass.setIndexBuffer(this.indexBuffer, this.indexFormat);
      renderPass.drawIndexed(this.indexCount, this.instanceCount);
    } else {
      renderPass.draw(this.vertexCount, this.instanceCount);
    }
  }
}
