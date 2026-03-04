// src/common/mat4.js
// Minimal mat4 helpers (column-major, as used by WebXR/glTF)

export function mat4Mul(out, a, b) {
  // out = a * b
  for (let j = 0; j < 4; j++) {        // column of out
    const bj0 = b[j*4 + 0];
    const bj1 = b[j*4 + 1];
    const bj2 = b[j*4 + 2];
    const bj3 = b[j*4 + 3];
    for (let i = 0; i < 4; i++) {      // row of out
      out[j*4 + i] =
        a[0*4 + i] * bj0 +
        a[1*4 + i] * bj1 +
        a[2*4 + i] * bj2 +
        a[3*4 + i] * bj3;
    }
  }
  return out;
}

export function mat4Identity(out) {
  out[0]=1;out[1]=0;out[2]=0;out[3]=0;
  out[4]=0;out[5]=1;out[6]=0;out[7]=0;
  out[8]=0;out[9]=0;out[10]=1;out[11]=0;
  out[12]=0;out[13]=0;out[14]=0;out[15]=1;
  return out;
}
