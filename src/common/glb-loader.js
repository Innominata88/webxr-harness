// src/common/glb-loader.js
// Minimal GLB (glTF 2.0 binary) loader for benchmarking.
// Default path: merges all mesh primitives into a single position/index buffer for the existing flat benchmark.
// Optional material path: preserves per-primitive UV/material state and decodes unlit base-color textures/factors.

const COMPONENT_TYPE_INFO = {
  5121: { array: Uint8Array, bytes: 1, read: (dv, off) => dv.getUint8(off) },
  5123: { array: Uint16Array, bytes: 2, read: (dv, off) => dv.getUint16(off, true) },
  5125: { array: Uint32Array, bytes: 4, read: (dv, off) => dv.getUint32(off, true) },
  5126: { array: Float32Array, bytes: 4, read: (dv, off) => dv.getFloat32(off, true) },
};

const TYPE_TO_NUM_COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
};

function readU32(dv, offset) {
  return dv.getUint32(offset, true);
}

function normalizeSurfaceMode(value) {
  return String(value || "flat").toLowerCase() === "basecolor" ? "basecolor" : "flat";
}

function normalizedIntegerToFloat(value, componentType) {
  switch (componentType) {
    case 5121: return value / 255.0; // UNSIGNED_BYTE
    case 5123: return value / 65535.0; // UNSIGNED_SHORT
    case 5125: return value / 4294967295.0; // UNSIGNED_INT
    default: return value;
  }
}

function getAccessorView(gltf, bin, accessorIndex, opts = {}) {
  const accessor = gltf.accessors[accessorIndex];
  if (!accessor || accessor.bufferView == null) {
    throw new Error(`Accessor ${accessorIndex} has no bufferView (sparse accessors unsupported).`);
  }
  if (accessor.sparse) {
    throw new Error(`Accessor ${accessorIndex} uses sparse data; not supported by this loader.`);
  }
  const view = gltf.bufferViews[accessor.bufferView];
  if (!view) throw new Error(`Missing bufferView ${accessor.bufferView} for accessor ${accessorIndex}`);

  const comp = COMPONENT_TYPE_INFO[accessor.componentType];
  if (!comp) throw new Error("Unsupported componentType: " + accessor.componentType);
  const ArrayType = comp.array;

  const numComps = TYPE_TO_NUM_COMPONENTS[accessor.type];
  if (!numComps) throw new Error("Unsupported accessor type: " + accessor.type);

  const viewByteOffset = view.byteOffset || 0;
  const viewByteLength = view.byteLength || 0;
  const accessorByteOffset = accessor.byteOffset || 0;
  const count = accessor.count;
  const packedElemBytes = comp.bytes * numComps;
  const byteStride = view.byteStride || packedElemBytes;
  if (byteStride < packedElemBytes) {
    throw new Error(`Invalid byteStride ${byteStride} for accessor ${accessorIndex} (needs at least ${packedElemBytes}).`);
  }

  const byteOffset = viewByteOffset + accessorByteOffset;
  const lastByteExclusive = byteOffset + Math.max(0, count - 1) * byteStride + packedElemBytes;
  const viewEnd = viewByteOffset + viewByteLength;
  if (lastByteExclusive > viewEnd) {
    throw new Error(`Accessor ${accessorIndex} exceeds bufferView bounds.`);
  }

  const totalComponents = count * numComps;
  const forceFloat = opts.forceFloat === true || accessor.normalized === true;

  if (byteStride === packedElemBytes && !forceFloat && !accessor.normalized) {
    const slice = bin.slice(byteOffset, byteOffset + totalComponents * comp.bytes);
    return new ArrayType(slice.buffer, slice.byteOffset, totalComponents);
  }

  const out = forceFloat ? new Float32Array(totalComponents) : new ArrayType(totalComponents);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < count; i++) {
    const srcBase = byteOffset + i * byteStride;
    const dstBase = i * numComps;
    for (let c = 0; c < numComps; c++) {
      let value = comp.read(dv, srcBase + c * comp.bytes);
      if (accessor.normalized) value = normalizedIntegerToFloat(value, accessor.componentType);
      out[dstBase + c] = value;
    }
  }
  return out;
}

function computeBounds(pos) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function normalizePositions(pos) {
  const b = computeBounds(pos);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const dx = b.maxX - b.minX;
  const dy = b.maxY - b.minY;
  const dz = b.maxZ - b.minZ;
  const maxDim = Math.max(dx, dy, dz) || 1;
  const s = 1.0 / maxDim;
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = (pos[i] - cx) * s;
    out[i + 1] = (pos[i + 1] - cy) * s;
    out[i + 2] = (pos[i + 2] - cz) * s;
  }
  return { positions: out, bounds: b, scale: s, center: [cx, cy, cz], maxDim };
}

function normalizePrimitivePositions(pos, center, scale) {
  const out = new Float32Array(pos.length);
  const [cx, cy, cz] = center;
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = (pos[i] - cx) * scale;
    out[i + 1] = (pos[i + 1] - cy) * scale;
    out[i + 2] = (pos[i + 2] - cz) * scale;
  }
  return out;
}

function parseGLB(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const magic = readU32(dv, 0);
  const version = readU32(dv, 4);
  const length = readU32(dv, 8);
  if (magic !== 0x46546C67) throw new Error("Not a GLB (bad magic)");
  if (version !== 2) throw new Error("Unsupported GLB version: " + version);

  let offset = 12;
  let jsonChunk = null;
  let binChunk = null;

  while (offset < length) {
    const chunkLen = readU32(dv, offset); offset += 4;
    const chunkType = readU32(dv, offset); offset += 4;
    const chunkData = arrayBuffer.slice(offset, offset + chunkLen);
    offset += chunkLen;

    if (chunkType === 0x4E4F534A) jsonChunk = chunkData;
    else if (chunkType === 0x004E4942) binChunk = chunkData;
  }

  if (!jsonChunk || !binChunk) throw new Error("Missing JSON or BIN chunk");
  const gltf = JSON.parse(new TextDecoder().decode(jsonChunk));
  const bin = new Uint8Array(binChunk);
  return { gltf, bin };
}

function collectAllMeshPrimitives(gltf, bin, opts = {}) {
  const includeTexcoords = opts.includeTexcoords === true;
  const meshes = gltf.meshes || [];
  if (!meshes.length) throw new Error("No meshes in glTF");

  const parts = [];
  let totalVerts = 0;
  let totalIndices = 0;
  let meshCountLoaded = 0;
  let primCountLoaded = 0;
  let hasAnyIndices = false;
  let texturedPrimitiveCount = 0;

  for (let m = 0; m < meshes.length; m++) {
    const mesh = meshes[m];
    const prims = mesh.primitives || [];
    if (!prims.length) continue;
    meshCountLoaded++;

    for (let p = 0; p < prims.length; p++) {
      const prim = prims[p];
      const posAcc = prim.attributes?.POSITION;
      if (posAcc == null) continue;

      const positions = getAccessorView(gltf, bin, posAcc, { forceFloat: true });
      const vertCount = positions.length / 3;
      let texcoords = null;
      if (includeTexcoords && prim.attributes?.TEXCOORD_0 != null) {
        texcoords = getAccessorView(gltf, bin, prim.attributes.TEXCOORD_0, { forceFloat: true });
      }

      let indices = null;
      if (prim.indices != null) {
        indices = getAccessorView(gltf, bin, prim.indices);
        hasAnyIndices = true;
        totalIndices += indices.length;
      } else {
        totalIndices += vertCount;
      }

      totalVerts += vertCount;
      primCountLoaded++;
      if (texcoords && texcoords.length) texturedPrimitiveCount++;
      parts.push({
        positions,
        indices,
        texcoords,
        materialIndex: Number.isInteger(prim.material) ? prim.material : -1,
        meshIndex: m,
        primitiveIndex: p,
      });
    }
  }

  if (!parts.length) throw new Error("No POSITION accessors found in meshes");

  return {
    parts,
    totals: {
      totalVerts,
      totalIndices,
      meshCountLoaded,
      primCountLoaded,
      hasAnyIndices,
      texturedPrimitiveCount,
    },
  };
}

function mergeCollectedPrimitives(parts) {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const part of parts) {
    const vertCount = part.positions.length / 3;
    totalVerts += vertCount;
    totalIndices += part.indices ? part.indices.length : vertCount;
  }

  const mergedPositions = new Float32Array(totalVerts * 3);
  const mergedIndices = new Uint32Array(totalIndices);
  let vBase = 0;
  let iBase = 0;

  for (const part of parts) {
    const pos = part.positions;
    const vertCount = pos.length / 3;
    mergedPositions.set(pos, vBase * 3);

    if (part.indices) {
      const idx = part.indices;
      for (let i = 0; i < idx.length; i++) {
        mergedIndices[iBase + i] = idx[i] + vBase;
      }
      iBase += idx.length;
    } else {
      for (let i = 0; i < vertCount; i++) {
        mergedIndices[iBase + i] = vBase + i;
      }
      iBase += vertCount;
    }
    vBase += vertCount;
  }

  return {
    positions: mergedPositions,
    indices: mergedIndices,
  };
}

function makeDataUriBlob(uri) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(uri || "");
  if (!match) throw new Error("Unsupported data URI image source");
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = !!match[2];
  const payload = match[3] || "";
  let bytes;
  if (isBase64) {
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    const decoded = decodeURIComponent(payload);
    bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

async function decodeImageBlob(blob) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, kind: "imageBitmap" };
  }
  if (typeof Image === "undefined") {
    throw new Error("Image decoding is unavailable in this environment.");
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    if (typeof image.decode === "function") {
      await image.decode();
    } else {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });
    }
    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      kind: "htmlImage",
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeGLTFImage(gltf, bin, modelUrl, imageIndex) {
  const image = gltf.images?.[imageIndex];
  if (!image) throw new Error(`Missing glTF image ${imageIndex}`);

  let blob;
  if (image.bufferView != null) {
    const view = gltf.bufferViews?.[image.bufferView];
    if (!view) throw new Error(`Missing bufferView ${image.bufferView} for image ${imageIndex}`);
    const offset = view.byteOffset || 0;
    const length = view.byteLength || 0;
    const mimeType = image.mimeType || "application/octet-stream";
    blob = new Blob([bin.slice(offset, offset + length)], { type: mimeType });
  } else if (typeof image.uri === "string" && image.uri.startsWith("data:")) {
    blob = makeDataUriBlob(image.uri);
  } else if (typeof image.uri === "string") {
    const resolved = new URL(image.uri, modelUrl).toString();
    const resp = await fetch(resolved);
    if (!resp.ok) throw new Error(`Failed to fetch glTF image ${resolved}: ${resp.status}`);
    blob = await resp.blob();
  } else {
    throw new Error(`Unsupported glTF image source for image ${imageIndex}`);
  }

  return decodeImageBlob(blob);
}

function buildMaterialRecords(gltf) {
  const materials = gltf.materials || [];
  return materials.map((material, materialIndex) => {
    const pbr = material?.pbrMetallicRoughness || {};
    const baseColorFactor = Array.isArray(pbr.baseColorFactor) && pbr.baseColorFactor.length === 4
      ? pbr.baseColorFactor.map((v) => Number(v))
      : [1, 1, 1, 1];
    const textureIndex = Number.isInteger(pbr.baseColorTexture?.index) ? pbr.baseColorTexture.index : -1;
    const texCoord = Number.isInteger(pbr.baseColorTexture?.texCoord) ? pbr.baseColorTexture.texCoord : 0;
    return {
      materialIndex,
      name: material?.name || `material_${materialIndex}`,
      baseColorFactor,
      baseColorTextureIndex: textureIndex,
      baseColorTexCoord: texCoord,
      alphaMode: material?.alphaMode || "OPAQUE",
      alphaCutoff: Number.isFinite(material?.alphaCutoff) ? Number(material.alphaCutoff) : 0.5,
      doubleSided: material?.doubleSided === true,
      unlit: !!material?.extensions?.KHR_materials_unlit,
    };
  });
}

function buildSamplerRecords(gltf) {
  const samplers = gltf.samplers || [];
  return samplers.map((sampler, samplerIndex) => ({
    samplerIndex,
    magFilter: sampler?.magFilter ?? null,
    minFilter: sampler?.minFilter ?? null,
    wrapS: sampler?.wrapS ?? 10497,
    wrapT: sampler?.wrapT ?? 10497,
  }));
}

async function buildBaseColorScene(gltf, bin, modelUrl, parts, norm) {
  const materials = buildMaterialRecords(gltf);
  const samplers = buildSamplerRecords(gltf);
  const textures = gltf.textures || [];

  const neededTextureIndices = new Set();
  for (const material of materials) {
    if (material.baseColorTextureIndex >= 0) neededTextureIndices.add(material.baseColorTextureIndex);
  }

  const decodedImages = new Map();
  const materialTextures = new Map();
  for (const textureIndex of neededTextureIndices) {
    const texture = textures[textureIndex];
    if (!texture || !Number.isInteger(texture.source)) continue;
    if (!decodedImages.has(texture.source)) {
      decodedImages.set(texture.source, await decodeGLTFImage(gltf, bin, modelUrl, texture.source));
    }
    materialTextures.set(textureIndex, {
      textureIndex,
      imageIndex: texture.source,
      samplerIndex: Number.isInteger(texture.sampler) ? texture.sampler : -1,
      image: decodedImages.get(texture.source),
    });
  }

  const primitives = parts.map((part, partIndex) => {
    const vertCount = part.positions.length / 3;
    const normalizedPositions = normalizePrimitivePositions(part.positions, norm.center, norm.scale);
    const indices = part.indices
      ? (part.indices instanceof Uint32Array ? part.indices : new Uint32Array(part.indices))
      : (() => {
          const generated = new Uint32Array(vertCount);
          for (let i = 0; i < vertCount; i++) generated[i] = i;
          return generated;
        })();
    const texcoords = part.texcoords && part.texcoords.length === vertCount * 2
      ? (part.texcoords instanceof Float32Array ? part.texcoords : new Float32Array(part.texcoords))
      : null;
    const material = part.materialIndex >= 0 && part.materialIndex < materials.length
      ? materials[part.materialIndex]
      : null;
    return {
      primitiveIndex: partIndex,
      meshIndex: part.meshIndex,
      sourcePrimitiveIndex: part.primitiveIndex,
      positions: normalizedPositions,
      indices,
      texcoords,
      materialIndex: material?.materialIndex ?? -1,
      material: material || {
        materialIndex: -1,
        name: "default_white",
        baseColorFactor: [1, 1, 1, 1],
        baseColorTextureIndex: -1,
        baseColorTexCoord: 0,
        alphaMode: "OPAQUE",
        alphaCutoff: 0.5,
        doubleSided: true,
        unlit: true,
      },
    };
  });

  return {
    mode: "basecolor",
    primitives,
    materials,
    textures: Array.from(materialTextures.values()),
    samplers,
  };
}

export async function loadGLBMesh(url, opts = {}) {
  const surfaceMode = normalizeSurfaceMode(opts.surfaceMode);
  const t0 = performance.now();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const tFetch = performance.now();
  const buf = await resp.arrayBuffer();

  const tParseStart = performance.now();
  const { gltf, bin } = parseGLB(buf);
  const collected = collectAllMeshPrimitives(gltf, bin, { includeTexcoords: surfaceMode === "basecolor" });
  const merged = mergeCollectedPrimitives(collected.parts);
  const norm = normalizePositions(merged.positions);
  const materialScene = surfaceMode === "basecolor"
    ? await buildBaseColorScene(gltf, bin, url, collected.parts, norm)
    : null;
  const tParseEnd = performance.now();

  const meshesTotal = (gltf.meshes || []).length;
  const nodesTotal = (gltf.nodes || []).length;
  const skinsTotal = (gltf.skins || []).length;
  const materialsTotal = (gltf.materials || []).length;
  const imagesTotal = (gltf.images || []).length;
  const texturesTotal = (gltf.textures || []).length;

  const indexCount = merged.indices ? merged.indices.length : 0;
  const triCount = merged.indices
    ? Math.floor(indexCount / 3)
    : Math.floor((norm.positions.length / 3) / 3);

  return {
    gltf,
    positions: norm.positions,
    indices: merged.indices,
    materialScene,
    timing: {
      fetch_ms: tFetch - t0,
      parse_ms: tParseEnd - tParseStart,
      total_ms: tParseEnd - t0,
    },
    meta: {
      surface_mode: surfaceMode,
      vertex_count: norm.positions.length / 3,
      index_count: indexCount,
      triangle_count: triCount,
      has_indices: true,
      bounds_raw: norm.bounds,
      norm_scale: norm.scale,
      norm_center: norm.center,
      norm_max_dim: norm.maxDim,
      meshes_total: meshesTotal,
      meshes_loaded: collected.totals.meshCountLoaded,
      primitives_loaded: collected.totals.primCountLoaded,
      textured_primitives_loaded: collected.totals.texturedPrimitiveCount,
      nodes_total: nodesTotal,
      skins_total: skinsTotal,
      materials_total: materialsTotal,
      images_total: imagesTotal,
      textures_total: texturesTotal,
      material_scene_primitives: materialScene?.primitives?.length || 0,
      material_scene_textures: materialScene?.textures?.length || 0,
    },
  };
}
