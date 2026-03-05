// src/webgl/renderer-webgl.js
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

function compile(gl, type, src) {
  const sh=gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || "Shader compile failed");
  }
  return sh;
}

function link(gl, vsSrc, fsSrc) {
  const vs=compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs=compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog=gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || "Program link failed");
  }
  return prog;
}

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_position;
layout(location=1) in vec3 a_instanceOffset;
uniform mat4 u_viewProj;
out vec3 v_dbg;
out float v_iid;
void main() {
  vec3 p = a_position + a_instanceOffset;
  gl_Position = u_viewProj * vec4(p, 1.0);
  v_dbg = abs(p);
  v_iid = float(gl_InstanceID);
}
`;

const FS = `#version 300 es
precision highp float;
in vec3 v_dbg;
in float v_iid;
uniform int u_debugColorMode;
out vec4 outColor;

float hash11(float p) {
  return fract(sin(p * 12.9898) * 43758.5453);
}

void main() {
  if (u_debugColorMode == 0) {
    outColor = vec4(1.0, 1.0, 1.0, 1.0);
    return;
  }
  if (u_debugColorMode == 1) {
    outColor = vec4(min(v_dbg, vec3(1.0)), 1.0);
    return;
  }
  outColor = vec4(
    hash11(v_iid + 0.13),
    hash11(v_iid + 1.17),
    hash11(v_iid + 2.31),
    1.0
  );
}
`;

// Deterministic PRNG (small, fast)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genOffsets(n, spacing, layout, seed) {
  const offsets = new Float32Array(n*3);
  const rng = mulberry32(seed >>> 0);

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

  if (layout === "xrwall") {
    // Flat wall (z=0) laid out mostly wide so everything is visible straight ahead in XR.
    const targetAspect = 16 / 9;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * targetAspect)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const xHalf = (cols - 1) / 2;
    const yHalf = (rows - 1) / 2;
    for (let i=0;i<n;i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      offsets[i*3+0] = (c - xHalf) * spacing;
      offsets[i*3+1] = (yHalf - r) * spacing;
      offsets[i*3+2] = 0;
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

export class WebGLMeshRenderer {
  constructor(gl) {
    this.gl=gl;
    this.prog=link(gl, VS, FS);
    this.uViewProj=gl.getUniformLocation(this.prog, "u_viewProj");
    this.uDebugColorMode=gl.getUniformLocation(this.prog, "u_debugColorMode");
    this.vao=gl.createVertexArray();
    this.vbo=null;
    this.ibo=null;
    this.instanceVBO=null;
    this.indexType=null;
    this.indexCount=0;
    this.vertexCount=0;
    this.instanceCount=1;
    this.instanceCapacity=0;
    this.instanceStrideBytes=4*3;
    this.debugColorModeName="flat";
    this.debugColorMode=DEBUG_COLOR_MODES.flat;
    // Compatibility cache used by setCamera/draw fallback API.
    this._compatViewProj = new Float32Array(16);
  }

  setDebugColor(modeName="flat") {
    const normalized = normalizeDebugColorMode(modeName);
    this.debugColorModeName = normalized;
    this.debugColorMode = DEBUG_COLOR_MODES[normalized];
    return normalized;
  }

  _ensureInstanceCapacity(instanceCount) {
    const gl=this.gl;
    const required = Math.max(1, instanceCount | 0);
    if (required <= this.instanceCapacity) return;

    let next = Math.max(4096, this.instanceCapacity || 0);
    while (next < required) next *= 2;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, next * this.instanceStrideBytes, gl.DYNAMIC_DRAW);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      throw new Error(`Failed to allocate instance buffer for ${next} instances (gl error ${err})`);
    }
    this.instanceCapacity = next;
  }

  setMesh({positions, indices}) {
    const gl=this.gl;
    gl.bindVertexArray(this.vao);

    // Vertex positions
    this.vbo=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    // Instance offsets buffer (filled in setInstances / setInstanceOffsets)
    this.instanceVBO=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    this._ensureInstanceCapacity(4096);

    // Indices optional
    if (indices) {
      this.ibo=gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      this.indexCount=indices.length;
      if (indices instanceof Uint16Array) this.indexType=gl.UNSIGNED_SHORT;
      else if (indices instanceof Uint32Array) this.indexType=gl.UNSIGNED_INT;
      else throw new Error("Unsupported index array type");
    } else {
      this.vertexCount=positions.length/3;
    }

    gl.bindVertexArray(null);
  }

  setInstanceOffsets(offsets /* Float32Array n*3 */) {
    const gl=this.gl;
    this.instanceCount = Math.floor(offsets.length/3);
    this._ensureInstanceCapacity(this.instanceCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, offsets);
  }

  setInstances(n, spacing=0.25, opts={}) {
    const layout = (opts.layout || "line");
    const seed = (opts.seed ?? 12345) >>> 0;
    const offsets = genOffsets(n, spacing, layout, seed);
    // In XR, shift the whole instance cloud in front of the viewer and up to eye height
    // so the user looks straight ahead (prevents half the grid spawning behind).
    if (opts.isXR) {
      const frontMinZ = (Number.isFinite(opts.xrFrontMinZ) ? opts.xrFrontMinZ : -2.0);
      const yOffset = (Number.isFinite(opts.xrYOffset) ? opts.xrYOffset : 1.4);
      // Find current max Z and shift so maxZ becomes frontMinZ (negative)
      let maxZ = -Infinity;
      for (let i=0;i<n;i++) maxZ = Math.max(maxZ, offsets[i*3+2]);
      const shiftZ = frontMinZ - maxZ;
      for (let i=0;i<n;i++) {
        offsets[i*3+1] += yOffset;
        offsets[i*3+2] += shiftZ;
      }
    }

    // Optional XR anchoring: place the cloud relative to the first viewer pose yaw/position.
    if (opts.isXR) {
      const anchorYaw = Number.isFinite(opts.xrAnchorYaw) ? opts.xrAnchorYaw : null;
      const anchorX = Number.isFinite(opts.xrAnchorX) ? opts.xrAnchorX : null;
      const anchorZ = Number.isFinite(opts.xrAnchorZ) ? opts.xrAnchorZ : null;
      if (anchorYaw != null && anchorX != null && anchorZ != null) {
        const c = Math.cos(anchorYaw);
        const s = Math.sin(anchorYaw);
        for (let i=0;i<n;i++) {
          const lx = offsets[i*3+0];
          const lz = offsets[i*3+2];
          offsets[i*3+0] = anchorX + (lx * c) + (lz * s);
          offsets[i*3+2] = anchorZ + (-lx * s) + (lz * c);
        }
      }
    }

    this.setInstanceOffsets(offsets);
  }

  // Backward-compatible API used by older app wiring.
  setCamera(projectionMat, viewMat) {
    if (!projectionMat || !viewMat) return;
    computeViewProj(this._compatViewProj, projectionMat, viewMat);
  }

  // Backward-compatible API used by older app wiring.
  draw() {
    this.drawForView(this._compatViewProj);
  }

  drawForView(viewProjMat /* Float32Array length 16 */) {
    const gl=this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uViewProj, false, viewProjMat);
    if (this.uDebugColorMode !== null) gl.uniform1i(this.uDebugColorMode, this.debugColorMode);

    gl.bindVertexArray(this.vao);
    if (this.ibo) {
      gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, this.indexType, 0, this.instanceCount);
    } else {
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.vertexCount, this.instanceCount);
    }
    gl.bindVertexArray(null);
  }
}

// Helper to compute viewProj = projection * view
export function computeViewProj(out, projection, view) {
  return mat4Mul(out, projection, view);
}
