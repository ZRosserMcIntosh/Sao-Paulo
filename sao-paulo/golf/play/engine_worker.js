// São Paulo World · Golf: the Golf Dynamics core (WebAssembly) in a worker, so
// building the course and the computer golfer's thinking never stall a frame.
// Messages: { id, cmd, arg } -> { id, ok, result } or { id, ok: false, error }.
import createGolfModule from './golf.mjs';

let G = null;
const ready = createGolfModule().then((m) => { G = m; });

const commands = {
  async init({ courseUrl }) {
    const text = await (await fetch(courseUrl)).text();
    const t0 = performance.now();
    const info = G.loadCourse(text);
    info.buildMs = performance.now() - t0;
    const heights = G.heights(), surfaces = G.surfaces(), trees = G.trees();
    return { result: { info, heights, surfaces, trees }, transfer: [heights.buffer, surfaces.buffer, trees.buffer] };
  },
  newMatch: (cfg) => G.newMatch(cfg),
  loadMatch: (saved) => G.loadMatch(saved),
  state: () => G.state(),
  save: () => G.save(),
  pickUp: () => G.pickUp(),
  clubs: (golfer) => G.clubs(golfer),
  setStimp: (ft) => G.setStimp(ft),
  play(swing) {
    const r = G.play(swing);
    const path = G.path();
    r.path = path;
    return { result: r, transfer: [path.buffer] };
  },
  plan: () => G.plan(),
  preview(swing) {
    const r = G.preview(swing);
    const path = G.path();
    r.path = path;
    return { result: r, transfer: [path.buffer] };
  },
};

self.onmessage = async (e) => {
  const { id, cmd, arg } = e.data;
  try {
    await ready;
    const f = commands[cmd];
    if (!f) throw new Error('unknown command ' + cmd);
    const out = await f(arg);
    if (out && out.transfer) self.postMessage({ id, ok: true, result: out.result }, out.transfer);
    else self.postMessage({ id, ok: true, result: out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
