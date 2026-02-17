// src/common/glb-loader.js
// Minimal GLB (glTF 2.0 binary) loader for benchmarking.
// Loads *all* mesh primitives (by default) and merges them into a single position/index buffer.
// This avoids "only part of the mesh shows" for multi-mesh assets (e.g., Spider-Man).
// Normalizes merged geometry into a roughly unit-sized centered model to keep camera consistent.

const COMPONENT_TYPE_TO_ARRAY = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};

const TYPE_TO_NUM_COMPONENTS = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4,
};

function readU32(dv, offset) { return dv.getUint32(offset, true); }

function getAccessorView(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  const view = gltf.bufferViews[accessor.bufferView];

  const ArrayType = COMPONENT_TYPE_TO_ARRAY[accessor.componentType];
  if (!ArrayType) throw new Error("Unsupported componentType: " + accessor.componentType);

  const numComps = TYPE_TO_NUM_COMPONENTS[accessor.type];
  if (!numComps) throw new Error("Unsupported accessor type: " + accessor.type);

  const byteOffset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const count = accessor.count * numComps;

  // NOTE: We intentionally ignore bufferView.byteStride and assume tightly packed.
  // Most glTF exports for POSITION/indices are tightly packed; this keeps the loader simple.
  const slice = bin.slice(byteOffset, byteOffset + count * ArrayType.BYTES_PER_ELEMENT);
  return new ArrayType(slice.buffer, slice.byteOffset, count);
}

function computeBounds(pos) {
  let minX=Infinity,minY=Infinity,minZ=Infinity;
  let maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  for (let i=0;i<pos.length;i+=3) {
    const x=pos[i], y=pos[i+1], z=pos[i+2];
    if (x<minX) minX=x; if (y<minY) minY=y; if (z<minZ) minZ=z;
    if (x>maxX) maxX=x; if (y>maxY) maxY=y; if (z>maxZ) maxZ=z;
  }
  return {minX,minY,minZ,maxX,maxY,maxZ};
}

function normalizePositions(pos) {
  const b=computeBounds(pos);
  const cx=(b.minX+b.maxX)/2, cy=(b.minY+b.maxY)/2, cz=(b.minZ+b.maxZ)/2;
  const dx=b.maxX-b.minX, dy=b.maxY-b.minY, dz=b.maxZ-b.minZ;
  const maxDim=Math.max(dx,dy,dz) || 1;
  const s=1.0/maxDim;
  const out=new Float32Array(pos.length);
  for (let i=0;i<pos.length;i+=3) {
    out[i]=(pos[i]-cx)*s;
    out[i+1]=(pos[i+1]-cy)*s;
    out[i+2]=(pos[i+2]-cz)*s;
  }
  return {positions: out, bounds: b, scale: s, center: [cx,cy,cz], maxDim};
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

    // 'JSON' = 0x4E4F534A, 'BIN\0' = 0x004E4942
    if (chunkType === 0x4E4F534A) jsonChunk = chunkData;
    else if (chunkType === 0x004E4942) binChunk = chunkData;
  }

  if (!jsonChunk || !binChunk) throw new Error("Missing JSON or BIN chunk");
  const gltf = JSON.parse(new TextDecoder().decode(jsonChunk));
  const bin = new Uint8Array(binChunk);
  return {gltf, bin};
}

function mergeAllMeshPrimitives(gltf, bin) {
  const meshes = gltf.meshes || [];
  if (!meshes.length) throw new Error("No meshes in glTF");

  // First pass: collect primitive buffers + totals
  const parts = [];
  let totalVerts = 0;
  let totalIndices = 0;
  let meshCountLoaded = 0;
  let primCountLoaded = 0;
  let hasAnyIndices = false;

  for (let m=0; m<meshes.length; m++) {
    const mesh = meshes[m];
    const prims = mesh.primitives || [];
    if (!prims.length) continue;
    meshCountLoaded++;

    for (let p=0; p<prims.length; p++) {
      const prim = prims[p];
      const posAcc = prim.attributes?.POSITION;
      if (posAcc == null) continue;

      const positions = getAccessorView(gltf, bin, posAcc); // Float32Array expected
      const vertCount = positions.length / 3;

      let indices = null;
      if (prim.indices != null) {
        indices = getAccessorView(gltf, bin, prim.indices);
        hasAnyIndices = true;
        totalIndices += indices.length;
      } else {
        // No indices: treat as non-indexed triangles/vertices
        totalIndices += vertCount;
      }

      totalVerts += vertCount;
      primCountLoaded++;
      parts.push({positions, indices});
    }
  }

  if (!parts.length) throw new Error("No POSITION accessors found in meshes");

  // Second pass: allocate merged buffers
  const mergedPositions = new Float32Array(totalVerts * 3);
  // Use uint32 to safely offset/merge everything
  const mergedIndices = new Uint32Array(totalIndices);

  let vBase = 0;
  let iBase = 0;

  for (const part of parts) {
    const pos = part.positions;
    const vertCount = pos.length / 3;

    mergedPositions.set(pos, vBase * 3);

    if (part.indices) {
      const idx = part.indices;
      for (let i=0; i<idx.length; i++) {
        mergedIndices[iBase + i] = idx[i] + vBase;
      }
      iBase += idx.length;
    } else {
      for (let i=0; i<vertCount; i++) {
        mergedIndices[iBase + i] = vBase + i;
      }
      iBase += vertCount;
    }

    vBase += vertCount;
  }

  return {
    positions: mergedPositions,
    indices: mergedIndices,
    meshCountLoaded,
    primCountLoaded,
    hasAnyIndices
  };
}

export async function loadGLBMesh(url) {
  const t0 = performance.now();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const tFetch = performance.now();
  const buf = await resp.arrayBuffer();

  const tParseStart = performance.now();
  const {gltf, bin} = parseGLB(buf);

  // Merge all mesh primitives so multi-mesh assets render fully
  const merged = mergeAllMeshPrimitives(gltf, bin);

  // Normalize merged geometry to unit cube
  const norm = normalizePositions(merged.positions);

  const tParseEnd = performance.now();

  const meshesTotal = (gltf.meshes || []).length;
  const nodesTotal = (gltf.nodes || []).length;
  const skinsTotal = (gltf.skins || []).length;
  const materialsTotal = (gltf.materials || []).length;
  const imagesTotal = (gltf.images || []).length;
  const texturesTotal = (gltf.textures || []).length;

  const indexCount = merged.indices ? merged.indices.length : 0;
  const triCount = merged.indices ? Math.floor(indexCount / 3) : Math.floor((norm.positions.length/3) / 3);

  return {
    gltf,
    positions: norm.positions,
    indices: merged.indices, // Uint32Array
    timing: {
      fetch_ms: tFetch - t0,
      parse_ms: tParseEnd - tParseStart,
      total_ms: tParseEnd - t0
    },
    meta: {
      vertex_count: norm.positions.length/3,
      index_count: indexCount,
      triangle_count: triCount,
      has_indices: true,
      bounds_raw: norm.bounds,
      norm_scale: norm.scale,
      norm_center: norm.center,
      norm_max_dim: norm.maxDim,

      meshes_total: meshesTotal,
      meshes_loaded: merged.meshCountLoaded,
      primitives_loaded: merged.primCountLoaded,
      nodes_total: nodesTotal,
      skins_total: skinsTotal,
      materials_total: materialsTotal,
      images_total: imagesTotal,
      textures_total: texturesTotal
    }
  };
}
