// Glass Lab · odds of breaking: the same shot into many panes, each with its
// own flaws (seed), across a range of speeds. Runs its own copy of the engine.
import createGlassModule from './glass.mjs';

let G = null;
async function engine() {
  if (G) return G;
  G = await createGlassModule(await (await fetch('glass.wasm', { cache: 'no-cache' })).arrayBuffer());
  const errs = G.load(await (await fetch('library.json', { cache: 'no-cache' })).text());
  if (errs.length) throw new Error(errs.join('; '));
  return G;
}

onmessage = async (e) => {
  const { glazing, impactor, speeds, seeds, tier, width, height, id } = e.data;
  try {
    const G = await engine();
    let done = 0;
    for (const v of speeds) {
      let broke = 0, through = 0;
      for (const seed of seeds) {
        const ok = width > 0 ? G.gls_new_pane_sized(glazing, tier, seed, width, height) : G.gls_new_pane(glazing, tier, seed);
        if (!ok) throw new Error('could not build the pane');
        const s0 = G.state();
        G.gls_fire(impactor, s0[14] / 2, s0[15] / 2, v, 0, 0, 0, 0.02);
        // Until the shot is decided (an outcome) or 80 ms have passed.
        for (let t = 0.002; t <= 0.08; t += 0.002) {
          G.gls_advance(t, 2000000);
          if (G.report(0).outcome) break;
        }
        const s = G.state();
        broke += s[6] ? 1 : 0;
        through += s[7] ? 1 : 0;
        postMessage({ id, progress: ++done / (speeds.length * seeds.length) });
      }
      postMessage({ id, point: { v, broke: broke / seeds.length, through: through / seeds.length } });
    }
    postMessage({ id, done: true });
  } catch (err) {
    postMessage({ id, error: String(err && err.message || err) });
  }
};
