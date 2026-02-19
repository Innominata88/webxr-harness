// src/webgpu/renderer-webgpu.js
import { mat4Mul } from "../common/mat4.js";
export class WebGPUMeshRenderer {
  constructor(device, colorFormat, depthFormat='depth24plus') {
    const CAMERA_SLOT_STRIDE = 256; // WebGPU dynamic offset alignment requirement
    const CAMERA_SLOT_COUNT = 2;    // immersive-vr without secondary views => up to 2 eyes
    const INITIAL_INSTANCE_CAPACITY = 4096;
    const INSTANCE_STRIDE_BYTES = 4 * 3;

    this.device=device;
    this.colorFormat=colorFormat;
    this.depthFormat=depthFormat;
    this.cameraSlotStride = CAMERA_SLOT_STRIDE;
    this.cameraSlotCount = CAMERA_SLOT_COUNT;
    this.instanceStrideBytes = INSTANCE_STRIDE_BYTES;
    this.instanceCapacity = 0;

    this.uniformBuffer = device.createBuffer({
      size: this.cameraSlotStride * this.cameraSlotCount,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding:0, visibility: GPUShaderStage.VERTEX, buffer: { type:"uniform" } }]
    });

    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

    const shaderModule = device.createShaderModule({
      code: `
struct Camera {
  viewProj : mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> camera : Camera;

struct VSIn {
  @location(0) position : vec3<f32>,
  @location(1) instanceOffset : vec3<f32>,
}
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) dbg : vec3<f32>,
}
@vertex
fn vsMain(input: VSIn) -> VSOut {
  var out : VSOut;
  let p = input.position + input.instanceOffset;
  out.pos = camera.viewProj * vec4<f32>(p, 1.0);
  out.dbg = abs(p);
  return out;
}
@fragment
fn fsMain(input: VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(input.dbg, 1.0);
}
      `
    });

    this.pipeline = device.createRenderPipeline({
      layout: this.pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vsMain",
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation:0, format:"float32x3", offset:0 }] },
          { arrayStride: 12, stepMode:"instance", attributes: [{ shaderLocation:1, format:"float32x3", offset:0 }] }
        ]
      },
      fragment: { module: shaderModule, entryPoint: "fsMain", targets: [{ format: colorFormat }] },
      primitive: { topology:"triangle-list", cullMode:"none" },
      depthStencil: { depthWriteEnabled: true, depthCompare:"less", format: depthFormat },
    });

    this.bindGroups = [];
    for (let i = 0; i < this.cameraSlotCount; i++) {
      this.bindGroups.push(device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [{
          binding: 0,
          resource: {
            buffer: this.uniformBuffer,
            offset: i * this.cameraSlotStride,
            size: 4 * 4 * 4,
          }
        }]
      }));
    }

    this.vertexBuffer=null;
    this.indexBuffer=null;
    this.indexFormat=null;
    this.indexCount=0;
    this.vertexCount=0;

    this.instanceBuffer = null;
    this._ensureInstanceCapacity(INITIAL_INSTANCE_CAPACITY);
    this.instanceCount=1;
    this.viewProjScratch = Array.from({ length: this.cameraSlotCount }, () => new Float32Array(16));
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

    const newBuffer = this.device.createBuffer({
      size: next * this.instanceStrideBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });

    this.instanceBuffer = newBuffer;
    this.instanceCapacity = next;
  }

  setMesh({positions, indices}) {
    // Vertex positions
    this.vertexBuffer = this.device.createBuffer({
      size: positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, positions);

    if (indices) {
      this.indexBuffer = this.device.createBuffer({
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(this.indexBuffer, 0, indices);
      this.indexCount = indices.length;
      this.indexFormat = (indices instanceof Uint16Array) ? "uint16" : "uint32";
    } else {
      this.vertexCount = positions.length/3;
      this.indexBuffer = null;
      this.indexCount = 0;
      this.indexFormat = null;
    }
  }

  // Deterministic PRNG (small, fast)
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
    const offsets = new Float32Array(n*3);
    const rng = this._mulberry32(seed >>> 0);

    if (layout === "grid") {
      const side = Math.ceil(Math.sqrt(n));
      const half = (side - 1) / 2;
      for (let i=0;i<n;i++) {
        const gx = (i % side) - half;
        const gz = Math.floor(i / side) - half;
        offsets[i*3+0] = gx * spacing;
        offsets[i*3+1] = 0;
        offsets[i*3+2] = -gz * spacing;
      }
      return offsets;
    }

    if (layout === "spiral") {
      for (let i=0;i<n;i++) {
        const a = i * 0.55;
        const r = spacing * Math.sqrt(i);
        offsets[i*3+0] = r * Math.cos(a);
        offsets[i*3+1] = 0;
        offsets[i*3+2] = -r * Math.sin(a);
      }
      return offsets;
    }

    if (layout === "random") {
      const span = spacing * Math.sqrt(n);
      for (let i=0;i<n;i++) {
        offsets[i*3+0] = (rng() - 0.5) * span;
        offsets[i*3+1] = 0;
        offsets[i*3+2] = -(rng() - 0.5) * span;
      }
      return offsets;
    }

    // default: line
    for (let i=0;i<n;i++) {
      offsets[i*3+0]=0;
      offsets[i*3+1]=0;
      offsets[i*3+2]=-i*spacing;
    }
    return offsets;
  }

  setInstanceOffsets(offsets /* Float32Array */) {
    this.instanceCount = Math.floor(offsets.length/3);
    this._ensureInstanceCapacity(this.instanceCount);
    this.device.queue.writeBuffer(this.instanceBuffer, 0, offsets);
  }

  setInstances(n, spacing=0.25, opts={}) {
    const layout = (opts.layout || "line");
    const seed = (opts.seed ?? 12345) >>> 0;
    const offsets = this._genOffsets(n, spacing, layout, seed);

    // XR placement: keep everything in front of the user and at eye height.
    if (opts.isXR) {
      const frontMinZ = (Number.isFinite(opts.xrFrontMinZ) ? opts.xrFrontMinZ : -2.0);
      const yOffset = (Number.isFinite(opts.xrYOffset) ? opts.xrYOffset : 1.4);
      let maxZ = -Infinity;
      for (let i=0;i<n;i++) maxZ = Math.max(maxZ, offsets[i*3+2]);
      const shiftZ = frontMinZ - maxZ;
      for (let i=0;i<n;i++) {
        offsets[i*3+1] += yOffset;
        offsets[i*3+2] += shiftZ;
      }
    }

    this.setInstanceOffsets(offsets);
  }

  setCamera(projectionMat, viewMat, cameraSlot=0) {
    if (cameraSlot < 0 || cameraSlot >= this.cameraSlotCount) {
      throw new Error(`Camera slot ${cameraSlot} out of range`);
    }
    const viewProj = this.viewProjScratch[cameraSlot];
    mat4Mul(viewProj, projectionMat, viewMat);
    this.device.queue.writeBuffer(this.uniformBuffer, cameraSlot * this.cameraSlotStride, viewProj);
  }

  draw(renderPass, cameraSlot=0) {
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
