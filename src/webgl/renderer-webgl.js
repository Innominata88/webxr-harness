// src/webgl/renderer-webgl.js
import { mat4Mul } from "../common/mat4.js";

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
void main() {
  vec3 p = a_position + a_instanceOffset;
  gl_Position = u_viewProj * vec4(p, 1.0);
  v_dbg = abs(p);
}
`;

const FS = `#version 300 es
precision highp float;
in vec3 v_dbg;
out vec4 outColor;
void main() {
  // Simple color so you can see something without textures.
  outColor = vec4(v_dbg, 1.0);
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
    this.vao=gl.createVertexArray();
    this.vbo=null;
    this.ibo=null;
    this.instanceVBO=null;
    this.indexType=null;
    this.indexCount=0;
    this.vertexCount=0;
    this.instanceCount=1;
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
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 3 * 4096, gl.DYNAMIC_DRAW); // up to 4096 instances
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

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
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, offsets);
  }

  setInstances(n, spacing=0.25, opts={}) {
    const layout = (opts.layout || "line");
    const seed = (opts.seed ?? 12345) >>> 0;
    const offsets = genOffsets(n, spacing, layout, seed);
    this.setInstanceOffsets(offsets);
  }

  drawForView(viewProjMat /* Float32Array length 16 */) {
    const gl=this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uViewProj, false, viewProjMat);

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
