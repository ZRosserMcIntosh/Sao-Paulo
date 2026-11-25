// OpenRoad Dynamics (gsp.wasm) bridge. The core works in ISO 8855 (x forward/east, y left/north,
// z up); the game works in three.js / Rapier space (Y up). Conversions live here only:
//   ISO (x, y, z)  <->  three (x, z, -y)        (a proper rotation, so vectors, axial vectors and
//   quaternion vector parts all map the same way)
import { paramsToArray, PARAM_COUNT, type VehicleParams } from '../vehicle/params';
import type { Q4, V3 } from '../math';

type Exports = Record<string, any> & { memory: WebAssembly.Memory };

export const STATE = {
  px: 0, qw: 3, speed: 7, lateral: 8, yawRate: 9, sideslip: 10, ax: 11, ay: 12, az: 13, rpm: 14, gear: 15,
  steerAngle: 16, throttle: 17, tcsCut: 18, countersteer: 19, escError: 20, time: 21, wheels: 22, faulted: 23,
  shifting: 24, clutch: 26, steerIn: 27, throttleIn: 28, brakeIn: 29, groundQueries: 30, engineTorque: 31,
  driftActive: 32, upright: 36, hullContacts: 37, hullForce: 38, syncPos: 39, syncAng: 40, gearCount: 41,
  limiter: 42, idle: 43, vx: 44, wx: 47,
} as const;
export const WHEEL = {
  hx: 0, hy: 1, cz: 2, radius: 3, steer: 4, omega: 5, load: 6, slipRatio: 7, slipAngle: 8, fx: 9, fy: 10,
  contact: 11, locked: 12, abs: 13, compression: 14, surface: 15, grip: 16, brakeTemp: 17,
} as const;

export interface BodyInfo {
  mass: number;
  inertia: [number, number, number]; // roll, pitch, yaw (ISO body axes x, y, z)
  front: number; rear: number; halfWidth: number; floor: number; roof: number; belt: number; roofRear: number; roofFront: number;
  hardpoints: V3[]; // ISO body frame
}

export class GspEngine {
  ex!: Exports;
  header = 50;
  perWheel = 18;
  stateSize = 122;
  private f64!: Float64Array;
  private f32!: Float32Array;
  private u8!: Uint8Array;

  static async load(url: string): Promise<GspEngine> {
    const bytes = await (await fetch(url)).arrayBuffer();
    const e = new GspEngine();
    let memory: WebAssembly.Memory | null = null;
    const ENOSYS = 52;
    const wasi = new Proxy(
      {
        proc_exit: (c: number) => { throw new Error('gsp.wasm exited with code ' + c); },
        fd_write: (fd: number, iovs: number, n: number, nwritten: number) => {
          const v = new DataView(memory!.buffer);
          let s = '', total = 0;
          for (let i = 0; i < n; ++i) {
            const p = v.getUint32(iovs + i * 8, true), l = v.getUint32(iovs + i * 8 + 4, true);
            s += new TextDecoder().decode(new Uint8Array(memory!.buffer, p, l));
            total += l;
          }
          v.setUint32(nwritten, total, true);
          if (s.trim()) (fd === 2 ? console.warn : console.info)(s.trimEnd());
          return 0;
        },
        environ_sizes_get: (c: number, s: number) => { const v = new DataView(memory!.buffer); v.setUint32(c, 0, true); v.setUint32(s, 0, true); return 0; },
        environ_get: () => 0,
        clock_time_get: (_id: number, _p: bigint, out: number) => { new DataView(memory!.buffer).setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
        random_get: (p: number, n: number) => { crypto.getRandomValues(new Uint8Array(memory!.buffer, p, n)); return 0; },
      } as Record<string, any>,
      { get: (t, k: string) => t[k] ?? (() => ENOSYS) },
    );
    const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
    e.ex = instance.exports as Exports;
    memory = e.ex.memory;
    e.ex._initialize?.();
    e.header = e.ex.gsp_state_header();
    e.perWheel = e.ex.gsp_state_per_wheel();
    e.stateSize = e.ex.gsp_state_size();
    if (e.ex.gsp_param_count() !== PARAM_COUNT) throw new Error('gsp.wasm parameter block mismatch');
    e.views();
    return e;
  }

  private views() {
    if (!this.f64 || this.f64.buffer !== this.ex.memory.buffer) {
      this.f64 = new Float64Array(this.ex.memory.buffer);
      this.f32 = new Float32Array(this.ex.memory.buffer);
      this.u8 = new Uint8Array(this.ex.memory.buffer);
    }
  }
  heap() { this.views(); return this.f64; }

  // ---- ground ----
  // heights / classes over three.js X in [minX, minX + (nx-1) cell], Z in [minZ, minZ + (nz-1) cell],
  // row-major by Z. Uploaded flipped so that ISO rows run north (-Z).
  uploadGround(nx: number, nz: number, minX: number, minZ: number, cell: number, heights: Float32Array, classes: Uint8Array) {
    const maxZ = minZ + (nz - 1) * cell;
    const hp = this.ex.gsp_ground_alloc(nx, nz, minX, -maxZ, cell) >> 2;
    const cp = this.ex.gsp_ground_classes();
    this.views();
    for (let j = 0; j < nz; ++j) {
      const iz = nz - 1 - j;
      this.f32.set(heights.subarray(iz * nx, iz * nx + nx), hp + j * nx);
      this.u8.set(classes.subarray(iz * nx, iz * nx + nx), cp + j * nx);
    }
  }
  setSurface(cls: number, s: { friction: number; rolling: number; roughness: number; looseness: number; texAmp: number; texWave: number; wetLoss: number; paved: boolean }) {
    this.ex.gsp_set_surface(cls, s.friction, s.rolling, s.roughness, s.looseness, s.texAmp, s.texWave, s.wetLoss, s.paved ? 1 : 0);
  }
  // deck: centre (three X, Z), top Y, half length along heading `yaw` (three yaw about +Y), half width
  addDeck(x: number, z: number, y: number, halfLength: number, halfWidth: number, yaw: number, cls: number) {
    // three yaw about +Y == ISO yaw about +z (same physical axis)
    this.ex.gsp_add_deck(x, -z, y, halfLength, halfWidth, yaw, 0, cls);
  }
  groundHeight(x: number, z: number, yMax = 1e9) { return this.ex.gsp_ground_height(x, -z, yMax) as number; }
  groundClass(x: number, z: number, yMax = 1e9) { return this.ex.gsp_ground_class(x, -z, yMax) as number; }
  setWeather(rain: number, puddles: number) { this.ex.gsp_set_weather(rain, puddles); }
  puddles(x: number, z: number, r: number): { x: number; z: number; r: number; depth: number }[] {
    const n = this.ex.gsp_puddles(x, -z, r);
    if (!n) return [];
    const p = this.ex.gsp_puddle_buffer() >> 3, H = this.heap(), out = [];
    for (let k = 0; k < n; ++k) out.push({ x: H[p + 4 * k], z: -H[p + 4 * k + 1], r: H[p + 4 * k + 2], depth: H[p + 4 * k + 3] });
    return out;
  }

  // ---- vehicles ----
  writeParams(p: VehicleParams) {
    const ptr = this.ex.gsp_params() >> 3;
    this.views();
    paramsToArray(p, this.f64, ptr);
  }
  // pos: three.js position under which to place the car (y = search hint); yaw about +Y.
  create(p: VehicleParams, x: number, yHint: number, z: number, yaw: number, speed: number, fidelity: number): number {
    this.writeParams(p);
    return this.ex.gsp_create(x, -z, yHint, yaw, speed, fidelity) as number;
  }
  place(h: number, x: number, yHint: number, z: number, yaw: number, speed: number) { this.ex.gsp_place(h, x, -z, yHint, yaw, speed); }
  rebuild(h: number, p: VehicleParams): boolean { this.writeParams(p); return this.ex.gsp_rebuild(h) === 1; }
  remove(h: number) { this.ex.gsp_remove(h); }
  removeAll() { this.ex.gsp_remove_all(); }
  setPreset(h: number, preset: number) { this.ex.gsp_set_preset(h, preset); }
  setAids(h: number, abs: boolean, tcs: number, esc: number, automatic: boolean) { this.ex.gsp_set_aids(h, abs ? 1 : 0, tcs, esc, automatic ? 1 : 0); }
  setSteering(h: number, mode: number, exponent: number, rate: number, returnRate: number, targetSlip: number, countersteer: number, drift: number) {
    this.ex.gsp_set_steering(h, mode, exponent, rate, returnRate, targetSlip, countersteer, drift);
  }
  // steer: + = left (ISO convention)
  setInput(h: number, steer: number, throttle: number, brake: number, handbrake: number, up: boolean, down: boolean) {
    this.ex.gsp_set_input(h, steer, throttle, brake, handbrake, up ? 1 : 0, down ? 1 : 0);
  }
  // body pose / velocities in three.js space
  setBody(h: number, p: V3, q: Q4, v: V3, w: V3) {
    this.ex.gsp_set_body(h, p.x, -p.z, p.y, q.w, q.x, -q.z, q.y, v.x, -v.z, v.y, w.x, -w.z, w.y);
  }
  step(h: number, dt: number, substeps: number): boolean { return this.ex.gsp_step(h, dt, substeps) === 1; }
  // force and torque (about the CoM) in three.js space
  forces(h: number, f: V3, t: V3) {
    const p = this.ex.gsp_forces(h) >> 3, H = this.heap();
    f.x = H[p]; f.y = H[p + 2]; f.z = -H[p + 1];
    t.x = H[p + 3]; t.y = H[p + 5]; t.z = -H[p + 4];
  }
  stateOffset(h: number) { return this.ex.gsp_state(h) >> 3; }
  // pose from the state buffer, three.js space
  pose(h: number, p: V3, q: Q4, v?: V3, w?: V3) {
    const o = this.stateOffset(h), H = this.heap();
    p.x = H[o]; p.y = H[o + 2]; p.z = -H[o + 1];
    q.w = H[o + 3]; q.x = H[o + 4]; q.y = H[o + 6]; q.z = -H[o + 5];
    if (v) { v.x = H[o + 44]; v.y = H[o + 46]; v.z = -H[o + 45]; }
    if (w) { w.x = H[o + 47]; w.y = H[o + 49]; w.z = -H[o + 48]; }
  }
  clearFault(h: number) { this.ex.gsp_clear_fault(h); }
  bodyInfo(h: number): BodyInfo {
    const p = this.ex.gsp_body_info(h) >> 3, H = this.heap();
    const hp: V3[] = [];
    for (let w = 0; w < 4; ++w) hp.push({ x: H[p + 15 + 3 * w], y: H[p + 16 + 3 * w], z: H[p + 17 + 3 * w] });
    return {
      mass: H[p], inertia: [H[p + 4], H[p + 5], H[p + 6]],
      front: H[p + 7], rear: H[p + 8], halfWidth: H[p + 9], floor: H[p + 10], roof: H[p + 11], belt: H[p + 12], roofRear: H[p + 13], roofFront: H[p + 14],
      hardpoints: hp,
    };
  }
  setTyreTemperature(h: number, c: number) { this.ex.gsp_set_tyre_temperature(h, c); }
  setWind(wx: number, wz: number) { this.ex.gsp_set_wind(wx, -wz); }
}
