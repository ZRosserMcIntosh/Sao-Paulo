// Georgia State Pursuit: car glass broken by the Glass Dynamics engine (the site's Glass Lab
// engine and glazing library), in a worker. The game's damage model decides that a window gives
// way and where it was struck; this worker runs the glass engine's fracture of that pane:
//  - tempered side and rear glass (car_side_tempered): the pane dices; each piece's outline and its
//    pose 30 times a second come back for the renderer;
//  - the laminated windscreen (windscreen): it cracks and stays in its frame; the crack segments of
//    both glass plies come back for the cracked-glass texture.
// SPDX-License-Identifier: MIT
import createGlassModule from './glass.mjs';

let G = null, cat = null;
const ready = (async () => {
  G = await createGlassModule();
  const errs = G.load(await (await fetch(new URL('./glass_library.json', import.meta.url))).text());
  if (errs.length) throw new Error(errs[0]);
  cat = G.catalog();
})();

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
    const ii = cat.impactors.findIndex((g) => g.id === job.impactor);
    if (gi < 0 || ii < 0) throw new Error('glazing or impactor missing from the library');
    if (!G.gls_new_pane_sized(gi, job.tier, job.seed, job.W, job.H)) throw new Error('could not build the pane');
    G.gls_set_floor(-job.floor);
    G.gls_fire_as(ii, job.x, job.y, job.speed, 0, 0, 0, 0.0, job.mass, job.radius);
    const fps = 30, frames = [], shapes = [];
    let nShapes = 0;
    const t0 = performance.now();
    if (job.glazing === 'windscreen') {
      for (let f = 1; f <= 12; ++f) G.gls_advance(f / fps, 4e6);
      const segs = [];
      for (const ply of [0, 1]) { const c = G.cracks(ply, 0); for (let k = 0; k < c.length; k += 7) segs.push(c[k], c[k + 1], c[k + 2], c[k + 3]); }
      const out = new Float32Array(segs);
      self.postMessage({ id: job.id, kind: 'cracks', segs: out, ms: performance.now() - t0 }, [out.buffer]);
      return;
    }
    for (let f = 1; f <= Math.round(job.T * fps); ++f) {
      G.gls_advance(f / fps, 4e6);
      const n = G.state()[4];
      if (n > nShapes) {
        for (const sh of G.fragmentShapes(nShapes)) if (shapes.length < job.maxPieces) shapes.push({ index: sh.index, thickness: sh.thickness, outline: decimate(sh.outline, job.maxPts) });
        nShapes = n;
      }
      const p = G.fragmentPoses(n), out = new Float32Array(Math.min(n, job.maxPieces * 3) * 8);
      for (let k = 0; k < out.length / 8; ++k) {
        const o = 12 * k;
        out.set([p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], p[o + 5], p[o + 6], p[o + 10]], 8 * k);
      }
      frames.push(out);
    }
    self.postMessage({ id: job.id, kind: 'pieces', shapes, frames, fps, ms: performance.now() - t0 }, frames.map((f) => f.buffer));
  } catch (err) {
    self.postMessage({ id: job.id, error: String((err && err.message) || err) });
  }
};
