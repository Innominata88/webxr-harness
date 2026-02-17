// src/common/metrics.js
export class RunStats {
  constructor() {
    this.frameTimes = [];
    this.startWall = 0;
    this.endWall = 0;
    this.meta = {};
    this.stages = {};
  }
  markStart() { this.startWall = performance.now(); }
  markEnd() { this.endWall = performance.now(); }
  addFrame(dt) { this.frameTimes.push(dt); }
  summarize() {
    const a=[...this.frameTimes].sort((x,y)=>x-y);
    const n=a.length || 1;
    const q=(p)=>a[Math.min(n-1, Math.floor(p*(n-1)))];
    const mean=this.frameTimes.reduce((s,v)=>s+v,0)/n;
    return {
      frames: this.frameTimes.length,
      duration_ms: this.endWall - this.startWall,
      mean_ms: mean,
      p50_ms: q(0.50),
      p95_ms: q(0.95),
      p99_ms: q(0.99),
    };
  }
}

export function downloadJSON(obj, filename="results.json") {
  const blob=new Blob([JSON.stringify(obj,null,2)], {type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
