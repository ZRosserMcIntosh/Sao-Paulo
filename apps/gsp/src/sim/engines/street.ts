// Street Dynamics (Destruction-Dynamics native/street-dynamics, the site's Street Lab engine):
// sign posts that bend, fold, snap at a breakaway base and shed their panels when a car hits
// them. Cars are handed to it as oriented boxes each step; the impulses the posts put back on a
// car go to its Rapier body. Street Dynamics works in ENU (x east, y north, z up), which is the
// core's ISO world frame: three (x, y, z) -> ENU (x, -z, y).
import type { SignSpot } from '../world/layout';

const runtimeImport = (u: string): Promise<any> => new Function('u', 'return import(u)')(u);

// US-style signs on breakaway slip bases (the library's sign families, Georgia sizes).
function gspTypes() {
  const post = (d: number, t: number) => ({ kind: 'round_tube', d, t });
  const slip = (release: number) => ({ kind: 'slip_base', release });
  return {
    gsp_speed: { name: 'Speed limit (R2-1)', family: 'sign', height: 2.75, segments: 7, section: post(0.0635, 0.00265), material: 'steel_tube_galv', base: slip(9000),
      panels: [{ shape: 'rect', width: 0.61, height: 0.76, thickness: 0.002, density: 2700, centre: 2.25, offset: 0.045, clamp: 3500, legend: 'SPEED LIMIT 70' }] },
    gsp_warning: { name: 'Curve warning (W1-2)', family: 'sign', height: 2.8, segments: 7, section: post(0.0635, 0.00265), material: 'steel_tube_galv', base: slip(9000),
      panels: [{ shape: 'diamond', width: 0.76, thickness: 0.002, density: 2700, centre: 2.35, offset: 0.045, clamp: 3500, legend: 'CURVE' }] },
    gsp_marker: { name: 'Mile marker', family: 'sign', height: 1.5, segments: 4, section: post(0.0508, 0.002), material: 'steel_tube_galv', base: slip(5000),
      panels: [{ shape: 'rect', width: 0.3, height: 0.6, thickness: 0.002, density: 2700, centre: 1.15, offset: 0.03, clamp: 2000, legend: 'MILE' }] },
    gsp_guide: { name: 'Guide sign', family: 'sign', height: 3.2, segments: 8, section: post(0.0889, 0.0035), material: 'steel_tube_galv', base: slip(14000),
      panels: [{ shape: 'rect', width: 1.8, height: 1.05, thickness: 0.0025, density: 2700, centre: 2.55, offset: 0.06, clamp: 6000, legend: 'GUIDE' }] },
    gsp_welcome: { name: 'Welcome sign', family: 'sign', height: 3.3, segments: 8, section: post(0.1016, 0.004), material: 'steel_tube_galv', base: slip(18000),
      panels: [{ shape: 'rect', width: 2.4, height: 1.3, thickness: 0.003, density: 2700, centre: 2.55, offset: 0.07, clamp: 8000, legend: 'WELCOME' }] },
  };
}

export interface StreetEvent { name: string; object: number; at: [number, number, number]; value: number }
export interface Part { kind: number; index: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; hx: number; hy: number; hz: number; loose: boolean }

export class StreetEngine {
  private S: any;
  w: any;
  ids: number[] = [];
  spots: SignSpot[] = [];
  states = new Map<number, string>();

  static async load(base: string, seed: number): Promise<StreetEngine> {
    const e = new StreetEngine();
    const mod = await runtimeImport(base + 'street.mjs');
    const bytes = await (await fetch(base + 'street.wasm')).arrayBuffer();
    e.S = await mod.default(bytes);
    const lib = await (await fetch(base + 'street_library.json')).json();
    const json = JSON.stringify({ about: 'GSP signs', materials: lib.materials, types: { ...lib.types, ...gspTypes() } });
    e.w = e.S.world(seed >>> 0);
    if (e.w.loadLibrary(json) < 0) throw new Error('street library: ' + e.w.error());
    return e;
  }

  // ENU heading in degrees: the panel faces +x of its local frame rotated by heading
  addSigns(spots: SignSpot[]) {
    this.spots = spots;
    for (const s of spots) {
      // Street Dynamics headings are compass-style (clockwise, degrees) and a panel's face normal is
      // the object's local +y: heading psi faces (sin psi, cos psi) in ENU (the Street Lab uses 270
      // to face -x). Our face direction is three yaw h, (cos h, sin h) in ENU, so psi = 90 - h. In
      // three.js that face is the panel box's -z side.
      const id = this.w.add(s.type, s.x, -s.z, ((Math.PI / 2 - s.heading) * 180) / Math.PI, s.y);
      this.ids.push(id);
      this.states.set(id, 'INTACT');
    }
  }

  setWetness(v: number) { this.w.setWetness(v); }

  // bodies: three.js boxes; returns nothing, impulses read with impulse(id)
  setBodies(list: { id: number; c: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number }; half: [number, number, number]; v: { x: number; y: number; z: number }; w: { x: number; y: number; z: number } }[]) {
    this.w.setBodies(list.map((b) => ({
      id: b.id,
      centre: [b.c.x, -b.c.z, b.c.y],
      orientation: [b.q.w, b.q.x, -b.q.z, b.q.y],
      half: [b.half[0], b.half[2], b.half[1]],
      velocity: [b.v.x, -b.v.z, b.v.y],
      angularVelocity: [b.w.x, -b.w.z, b.w.y],
    })));
  }
  step(dt: number) { this.w.step(dt); }
  impulse(id: number) { const j = this.w.bodyImpulse(id); return { x: j[0], y: j[2], z: -j[1] }; }
  events(): StreetEvent[] {
    const ev = this.w.events() as StreetEvent[];
    for (const e of ev) if (e.name === 'POST_DOWN' || e.name === 'POST_BROKEN' || e.name === 'POST_BENT' || e.name === 'BASE_RELEASED') this.states.set(e.object, e.name);
    return ev;
  }
  // parts of one object in three.js space
  parts(id: number, out: Part[]): Part[] {
    const f: Float32Array = this.w.parts(id);
    out.length = 0;
    for (let k = 0; k + 13 <= f.length; k += 13) {
      out.push({
        kind: f[k], index: f[k + 1], x: f[k + 2], y: f[k + 4], z: -f[k + 3],
        qw: f[k + 5], qx: f[k + 6], qy: f[k + 8], qz: -f[k + 7],
        hx: f[k + 9], hy: f[k + 11], hz: f[k + 10], loose: f[k + 12] > 0.5,
      });
    }
    return out;
  }
  repairAll() { for (const id of this.ids) { this.w.repair(id); this.states.set(id, 'INTACT'); } }
  stats() { return this.w.stats(); }
}
