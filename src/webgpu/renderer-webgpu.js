// src/webgpu/renderer-webgpu.js
export class WebGPUMeshRenderer {
  constructor(device, colorFormat, depthFormat='depth24plus') {
    this.device=device;
    this.colorFormat=colorFormat;
    this.depthFormat=depthFormat;

    this.uniformBuffer = device.createBuffer({
      size: 4*4*4*2, // 2 mat4 = 32 floats
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding:0, visibility: GPUShaderStage.VERTEX, buffer: { type:"uniform" } }]
    });

    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

    const shaderModule = device.createShaderModule({
      code: `
struct Camera {
  projection : mat4x4<f32>,
  view : mat4x4<f32>,
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
  out.pos = camera.projection * camera.view * vec4<f32>(p, 1.0);
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
      primitive: { topology:"triangle-list", cullMode:"back" },
      depthStencil: { depthWriteEnabled: true, depthCompare:"less", format: depthFormat },
    });

    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding:0, resource: { buffer: this.uniformBuffer } }]
    });

    this.vertexBuffer=null;
    this.indexBuffer=null;
    this.indexFormat=null;
    this.indexCount=0;
    this.vertexCount=0;

    this.instanceBuffer = device.createBuffer({
      size: 4 * 3 * 4096,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.instanceCount=1;
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
    this.device.queue.writeBuffer(this.instanceBuffer, 0, offsets);
  }

  setInstances(n, spacing=0.25, opts={}) {
    const layout = (opts.layout || "line");
    const seed = (opts.seed ?? 12345) >>> 0;
    const offsets = this._genOffsets(n, spacing, layout, seed);
    this.setInstanceOffsets(offsets);
  }

  setCamera(projectionMat, viewMat) {
    const data=new Float32Array(32);
    data.set(projectionMat, 0);
    data.set(viewMat, 16);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  draw(renderPass) {
    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
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
