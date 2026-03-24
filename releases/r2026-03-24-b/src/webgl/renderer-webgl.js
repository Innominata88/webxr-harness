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

function normalizeSurfaceMode(value) {
  return String(value || "flat").toLowerCase() === "basecolor" ? "basecolor" : "flat";
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || "Shader compile failed");
  }
  return sh;
}

function link(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || "Program link failed");
  }
  return prog;
}

const FLAT_VS = `#version 300 es
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

const FLAT_FS = `#version 300 es
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

const MATERIAL_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_position;
layout(location=1) in vec2 a_uv;
layout(location=2) in vec3 a_instanceOffset;
uniform mat4 u_viewProj;
out vec2 v_uv;
void main() {
  vec3 p = a_position + a_instanceOffset;
  gl_Position = u_viewProj * vec4(p, 1.0);
  v_uv = a_uv;
}
`;

const MATERIAL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_baseColorTex;
uniform vec4 u_baseColorFactor;
uniform float u_useTexture;
out vec4 outColor;
void main() {
  vec4 sampled = (u_useTexture > 0.5) ? texture(u_baseColorTex, v_uv) : vec4(1.0);
  vec4 color = sampled * u_baseColorFactor;
  if (color.a <= 0.001) discard;
  outColor = color;
}
`;

function mapWrapMode(gl, value) {
  switch (Number(value)) {
    case 33071: return gl.CLAMP_TO_EDGE;
    case 33648: return gl.MIRRORED_REPEAT;
    default: return gl.REPEAT;
  }
}

function mapMagFilter(gl, value) {
  return Number(value) === 9728 ? gl.NEAREST : gl.LINEAR;
}

function mapMinFilter(gl, value) {
  switch (Number(value)) {
    case 9728: return gl.NEAREST;
    case 9729: return gl.LINEAR;
    case 9984: return gl.NEAREST_MIPMAP_NEAREST;
    case 9985: return gl.LINEAR_MIPMAP_NEAREST;
    case 9986: return gl.NEAREST_MIPMAP_LINEAR;
    case 9987: return gl.LINEAR_MIPMAP_LINEAR;
    default: return gl.LINEAR;
  }
}

function needsMipmaps(value) {
  const v = Number(value);
  return v === 9984 || v === 9985 || v === 9986 || v === 9987;
}

function createWhiteTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const pixel = new Uint8Array([255, 255, 255, 255]);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function createTextureFromImage(gl, decodedImage, samplerRecord) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, decodedImage.source);
  const minFilter = mapMinFilter(gl, samplerRecord?.minFilter);
  const magFilter = mapMagFilter(gl, samplerRecord?.magFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, mapWrapMode(gl, samplerRecord?.wrapS));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mapWrapMode(gl, samplerRecord?.wrapT));
  if (needsMipmaps(samplerRecord?.minFilter)) {
    gl.generateMipmap(gl.TEXTURE_2D);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function buildZeroTexcoords(vertexCount) {
  return new Float32Array(vertexCount * 2);
}

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
  const offsets = new Float32Array(n * 3);
  const rng = mulberry32(seed >>> 0);

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

export class WebGLMeshRenderer {
  constructor(gl, opts = {}) {
    this.gl = gl;
    this.flatProg = link(gl, FLAT_VS, FLAT_FS);
    this.materialProg = link(gl, MATERIAL_VS, MATERIAL_FS);

    this.uViewProj = gl.getUniformLocation(this.flatProg, "u_viewProj");
    this.uDebugColorMode = gl.getUniformLocation(this.flatProg, "u_debugColorMode");

    this.uMaterialViewProj = gl.getUniformLocation(this.materialProg, "u_viewProj");
    this.uMaterialBaseColorTex = gl.getUniformLocation(this.materialProg, "u_baseColorTex");
    this.uMaterialBaseColorFactor = gl.getUniformLocation(this.materialProg, "u_baseColorFactor");
    this.uMaterialUseTexture = gl.getUniformLocation(this.materialProg, "u_useTexture");

    this.flatVao = gl.createVertexArray();
    this.vao = this.flatVao;
    this.flatVbo = null;
    this.ibo = null;
    this.instanceVBO = gl.createBuffer();
    this.materialPrimitives = [];
    this.materialTextureCache = new Map();
    this.whiteTexture = createWhiteTexture(gl);

    this.indexType = null;
    this.indexCount = 0;
    this.vertexCount = 0;
    this.instanceCount = 1;
    this.instanceCapacity = 0;
    this.instanceStrideBytes = 4 * 3;

    this.debugColorModeName = "flat";
    this.debugColorMode = DEBUG_COLOR_MODES.flat;
    this.surfaceMode = normalizeSurfaceMode(opts.surfaceMode);
    this.activeSurfaceMode = "flat";
    this._compatViewProj = new Float32Array(16);
  }

  setDebugColor(modeName = "flat") {
    const normalized = normalizeDebugColorMode(modeName);
    this.debugColorModeName = normalized;
    this.debugColorMode = DEBUG_COLOR_MODES[normalized];
    return normalized;
  }

  setSurfaceMode(modeName = "flat") {
    this.surfaceMode = normalizeSurfaceMode(modeName);
    return this.surfaceMode;
  }

  _ensureInstanceCapacity(instanceCount) {
    const gl = this.gl;
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

  _bindSharedInstanceAttrib(vao, location, size) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, 1);
  }

  _setFlatMesh({ positions, indices }) {
    const gl = this.gl;
    this.activeSurfaceMode = "flat";
    this.materialPrimitives = [];
    this.materialTextureCache = new Map();

    gl.bindVertexArray(this.flatVao);

    this.flatVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatVbo);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    this._bindSharedInstanceAttrib(this.flatVao, 1, 3);
    this._ensureInstanceCapacity(4096);

    if (indices) {
      this.ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      this.indexCount = indices.length;
      if (indices instanceof Uint16Array) this.indexType = gl.UNSIGNED_SHORT;
      else if (indices instanceof Uint32Array) this.indexType = gl.UNSIGNED_INT;
      else throw new Error("Unsupported index array type");
    } else {
      this.vertexCount = positions.length / 3;
      this.ibo = null;
      this.indexCount = 0;
      this.indexType = null;
    }

    gl.bindVertexArray(null);
  }

  _resolveMaterialTexture(textureIndex, materialScene, samplerByIndex, texcoordsAvailable) {
    if (!texcoordsAvailable || textureIndex < 0) {
      return { texture: this.whiteTexture, useTexture: 0 };
    }
    if (this.materialTextureCache.has(textureIndex)) {
      return { texture: this.materialTextureCache.get(textureIndex), useTexture: 1 };
    }
    const textureRecord = (materialScene.textures || []).find((entry) => entry.textureIndex === textureIndex);
    if (!textureRecord?.image?.source) {
      return { texture: this.whiteTexture, useTexture: 0 };
    }
    const samplerRecord = samplerByIndex.get(textureRecord.samplerIndex) || null;
    const texture = createTextureFromImage(this.gl, textureRecord.image, samplerRecord);
    this.materialTextureCache.set(textureIndex, texture);
    return { texture, useTexture: 1 };
  }

  _setMaterialMesh(materialScene) {
    const gl = this.gl;
    this.activeSurfaceMode = "basecolor";
    this.materialPrimitives = [];
    this.materialTextureCache = new Map();
    const samplerByIndex = new Map((materialScene.samplers || []).map((s) => [s.samplerIndex, s]));
    this._ensureInstanceCapacity(4096);

    for (const primitive of materialScene.primitives || []) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, primitive.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

      const vertexCount = primitive.positions.length / 3;
      const uvData = primitive.texcoords || buildZeroTexcoords(vertexCount);
      const uvBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, uvData, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

      this._bindSharedInstanceAttrib(vao, 2, 3);

      let indexBuffer = null;
      let indexType = null;
      let indexCount = 0;
      let primitiveVertexCount = 0;
      if (primitive.indices) {
        indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, primitive.indices, gl.STATIC_DRAW);
        indexCount = primitive.indices.length;
        indexType = primitive.indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
      } else {
        primitiveVertexCount = vertexCount;
      }

      const factor = new Float32Array(primitive.material?.baseColorFactor || [1, 1, 1, 1]);
      const resolvedTexture = this._resolveMaterialTexture(
        primitive.material?.baseColorTextureIndex ?? -1,
        materialScene,
        samplerByIndex,
        !!primitive.texcoords
      );

      this.materialPrimitives.push({
        vao,
        positionBuffer,
        uvBuffer,
        indexBuffer,
        indexType,
        indexCount,
        vertexCount: primitiveVertexCount,
        baseColorFactor: factor,
        texture: resolvedTexture.texture,
        useTexture: resolvedTexture.useTexture,
      });
    }

    gl.bindVertexArray(null);
  }

  setMesh(mesh) {
    if (this.surfaceMode === "basecolor" && mesh?.materialScene?.mode === "basecolor") {
      this._setMaterialMesh(mesh.materialScene);
      return;
    }
    this._setFlatMesh(mesh);
  }

  setInstanceOffsets(offsets) {
    const gl = this.gl;
    this.instanceCount = Math.floor(offsets.length / 3);
    this._ensureInstanceCapacity(this.instanceCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, offsets);
  }

  setInstances(n, spacing = 0.25, opts = {}) {
    const layout = (opts.layout || "line");
    const seed = (opts.seed ?? 12345) >>> 0;
    const offsets = genOffsets(n, spacing, layout, seed);

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

  setCamera(projectionMat, viewMat) {
    if (!projectionMat || !viewMat) return;
    computeViewProj(this._compatViewProj, projectionMat, viewMat);
  }

  draw() {
    this.drawForView(this._compatViewProj);
  }

  _drawFlat(viewProjMat) {
    const gl = this.gl;
    gl.useProgram(this.flatProg);
    gl.uniformMatrix4fv(this.uViewProj, false, viewProjMat);
    if (this.uDebugColorMode !== null) gl.uniform1i(this.uDebugColorMode, this.debugColorMode);

    gl.bindVertexArray(this.flatVao);
    if (this.ibo) {
      gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, this.indexType, 0, this.instanceCount);
    } else {
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.vertexCount, this.instanceCount);
    }
    gl.bindVertexArray(null);
  }

  _drawMaterial(viewProjMat) {
    const gl = this.gl;
    gl.useProgram(this.materialProg);
    gl.uniformMatrix4fv(this.uMaterialViewProj, false, viewProjMat);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.uMaterialBaseColorTex, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    for (const primitive of this.materialPrimitives) {
      gl.bindTexture(gl.TEXTURE_2D, primitive.texture || this.whiteTexture);
      gl.uniform4fv(this.uMaterialBaseColorFactor, primitive.baseColorFactor);
      gl.uniform1f(this.uMaterialUseTexture, primitive.useTexture);
      gl.bindVertexArray(primitive.vao);
      if (primitive.indexBuffer) {
        gl.drawElementsInstanced(gl.TRIANGLES, primitive.indexCount, primitive.indexType, 0, this.instanceCount);
      } else {
        gl.drawArraysInstanced(gl.TRIANGLES, 0, primitive.vertexCount, this.instanceCount);
      }
    }

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  drawForView(viewProjMat) {
    if (this.activeSurfaceMode === "basecolor") {
      this._drawMaterial(viewProjMat);
      return;
    }
    this._drawFlat(viewProjMat);
  }
}

export function computeViewProj(out, projection, view) {
  return mat4Mul(out, projection, view);
}
