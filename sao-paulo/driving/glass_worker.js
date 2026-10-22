// São Paulo World · driving test track: the Glass Dynamics engine (../glass/) in a worker.
// A car about to go through the storefront: the page asks for the break ahead of time, this
// worker runs the glass engine's fracture of that pane (the same engine and glazing library as
// the Glass Lab: Hertzian cone, radial and ring cracks, pieces with their own flight), and sends
// back each piece's outline and its pose 30 times a second for the next few seconds.
// SPDX-License-Identifier: MIT
import createGlassModule from '../glass/glass.mjs';

let G = null, cat = null;
const ready = (async () => {
  G = await createGlassModule();
  const errs = G.load(await (await fetch(new URL('../glass/library.json', import.meta.url))).text());
  if (errs.length) throw new Error(errs[0]);
  cat = G.catalog();
})();

// Fewer outline points: every k-th, so a piece keeps its shape at a fraction of the vertices.
function decimate(outline, maxPts) {
  const n = outline.length / 2;
  if (n <= maxPts) return outline;
  const out = [];
  for (let i = 0; i < maxPts; ++i) { const j = Math.floor((i * n) / maxPts); out.push(outline[2 * j], outline[2 * j + 1]); }
  return out;
}

self.onmessage = async (e) => {
  const job = e.data;
  try {
    await ready;
    const gi = cat.glazings.findIndex((g) => g.id === job.glazing);
    const ii = cat.impactors.findIndex((g) => g.id === 'body_bag');
    if (gi < 0 || ii < 0) throw new Error('glazing or impactor missing from the library');
    if (!G.gls_new_pane_sized(gi, job.tier, job.seed, job.W, job.H)) throw new Error('could not build the pane');
    G.gls_set_floor(-job.floor);
    // the car's nose: a blunt, heavy impactor at the bumper's height, at the car's speed
    G.gls_fire_as(ii, job.x, job.y, job.speed, job.yaw, 0, 0, 0.0, job.mass, job.radius);
    const fps = 30, frames = [], counts = [];
    const shapes = [];
    let nShapes = 0;
    const t0 = performance.now();
    for (let f = 1; f <= Math.round(job.T * fps); ++f) {
      G.gls_advance(f / fps, 4e6);
      const s = G.state(), n = s[4];
      if (n > nShapes) {
        for (const sh of G.fragmentShapes(nShapes)) shapes.push({ index: sh.index, chip: sh.chip, thickness: sh.thickness, outline: decimate(sh.outline, job.maxPts) });
        nShapes = n;
      }
      const p = G.fragmentPoses(n), out = new Float32Array(n * 8);
      for (let k = 0; k < n; ++k) {
        const o = 12 * k;
        out.set([p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], p[o + 5], p[o + 6], p[o + 10]], 8 * k);
      }
      frames.push(out); counts.push(n);
    }
    const events = G.events(0).slice(0, 6);
    self.postMessage({ id: job.id, shapes, frames, fps, ms: performance.now() - t0, events }, frames.map((f) => f.buffer));
  } catch (err) {
    self.postMessage({ id: job.id, error: String(err && err.message || err) });
  }
};
