// Armoured GT under fire: a scripted scene for the glass lab.
//
// A 1960s grand tourer with armoured glazing sits in a limestone piazza while
// gunmen empty submachine guns into it. The windscreen is the engine's pane,
// mounted raked in the car; every round that reaches it is fired into the
// engine with its real obliquity, at the engine time it arrives, so the white
// craters, the spider webs and the driver's view all come from the physics.
// Rounds that miss the glass strike sparks off the bodywork or fly past.
//
// The barrage is deterministic from the pane's seed: Replay shows it again
// exactly, at any speed.

const RAKE = 50 * Math.PI / 180;      // windscreen rake from vertical
const COWL = [0, 0.96, 0.46];         // world point of the windscreen's bottom edge (front face)
const EYE = [-0.34, 1.1, -0.48];      // driver's eye (right-hand drive)
const MUZZLE_V = 400;                 // m/s (smg_9mm)
const GUNMEN = [[-6.5, 12.5], [-2.0, 16.0], [2.5, 11.5], [7.0, 14.0], [10.5, 7.5]];
const DURATION = 9.5;                 // s of shooting

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rnd) { return Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd()); }

// ---------- Sound: synthesized, no assets ----------
class SceneAudio {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = AC ? new AC() : null;
    if (!this.ctx) return;
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.55;
    const comp = this.ctx.createDynamicsCompressor();
    this.out.connect(comp).connect(this.ctx.destination);
    const n = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, n, n);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; ++i) d[i] = Math.random() * 2 - 1;
    this.muted = false;
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  burst(when, gain, decay, type, freq, q, pan) {
    const c = this.ctx, t = c.currentTime + when;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.0015);
    g.gain.exponentialRampToValueAtTime(1e-4, t + decay);
    const p = c.createStereoPanner ? c.createStereoPanner() : null;
    if (p) { p.pan.value = pan; src.connect(f).connect(g).connect(p).connect(this.out); } else src.connect(f).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + decay + 0.05);
  }
  tone(when, gain, f0, f1, dur) {
    const c = this.ctx, t = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    o.connect(g).connect(this.out);
    o.start(t); o.stop(t + dur + 0.02);
  }
  // A shot heard from the cabin: muffled by the armour, delayed by distance.
  gunshot(dist, pan) {
    if (!this.ctx || this.muted) return;
    const a = 1 / (1 + dist / 8), delay = dist / 343;
    this.burst(delay, 0.9 * a, 0.16, 'bandpass', 1400, 0.8, pan);
    this.burst(delay, 0.6 * a, 0.35, 'lowpass', 300, 0.7, pan);
    this.tone(delay, 0.5 * a, 110, 45, 0.12);
  }
  glass() {
    if (!this.ctx || this.muted) return;
    this.burst(0, 0.9, 0.05, 'highpass', 3000, 0.7, 0);
    this.burst(0.004, 0.7, 0.22, 'bandpass', 900, 1.2, 0);
    this.tone(0, 0.35, 180, 60, 0.09);
  }
  spark(pan) {
    if (!this.ctx || this.muted) return;
    this.burst(0, 0.35, 0.06, 'highpass', 4000, 0.5, pan);
    this.tone(0, 0.08, 2600 + 900 * Math.random(), 900, 0.3);
  }
}

// ---------- Textures ----------
function canvasTex(THREE, w, h, draw, repeat) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); t.anisotropy = 4; }
  return t;
}
function flashTexture(THREE) {
  return canvasTex(THREE, 128, 128, (c, w) => {
    const h = w / 2;
    const g = c.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(0.2, 'rgba(255,220,140,0.9)');
    g.addColorStop(0.5, 'rgba(255,150,40,0.35)');
    g.addColorStop(1, 'rgba(255,120,20,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, w);
    c.strokeStyle = 'rgba(255,240,200,0.8)';
    for (let i = 0; i < 6; ++i) {
      const a = i * Math.PI / 3 + 0.3;
      c.lineWidth = 3;
      c.beginPath(); c.moveTo(h, h); c.lineTo(h + Math.cos(a) * h * 0.95, h + Math.sin(a) * h * 0.95); c.stroke();
    }
  });
}

// ---------- The car ----------
// Stations along the car (z forward, metres from the middle of the wheelbase):
// centre-line height of the body's top, half width, and the wheel arches.
const TOP = [[2.32, 0.57], [2.22, 0.67], [2.0, 0.74], [1.2, 0.83], [0.45, 0.95], [-0.3, 0.96], [-1.2, 0.95],
  [-1.75, 0.92], [-2.15, 0.83], [-2.3, 0.62]];
const HALF = [[2.32, 0.56], [2.12, 0.72], [1.33, 0.83], [0.6, 0.81], [-0.3, 0.8], [-1.27, 0.84], [-2.0, 0.78], [-2.3, 0.64]];
const AXLES = [1.33, -1.27];
function interp(tab, z) {
  if (z >= tab[0][0]) return tab[0][1];
  for (let i = 0; i + 1 < tab.length; ++i) {
    const [z0, y0] = tab[i], [z1, y1] = tab[i + 1];
    if (z <= z0 && z >= z1) { const u = (z - z0) / (z1 - z0); const w = u * u * (3 - 2 * u); return y0 + (y1 - y0) * w; }
  }
  return tab[tab.length - 1][1];
}
const topAt = (z) => interp(TOP, z);
const halfAt = (z) => interp(HALF, z);
function bottomAt(z) {
  let y = 0.26;
  for (const a of AXLES) {
    const d = z - a;
    if (Math.abs(d) < 0.42) y = Math.max(y, 0.33 + Math.sqrt(0.42 * 0.42 - d * d));
  }
  const nose = Math.max(0, z - 2.0) * 0.25, tail = Math.max(0, -2.0 - z) * 0.4;
  return y + nose + tail;
}
// The wings stand above the bonnet and boot over each wheel.
const wingAt = (z) => AXLES.reduce((a, w) => a + 0.07 * Math.exp(-(((z - w) / 0.5) ** 2)), 0);
const SE = 4.5;  // superellipse exponent: a rounded box section
function se(c) { return Math.sign(c) * Math.pow(Math.abs(c), 2 / SE); }
// A point on the body's section at station z, angle t (0 = right side, pi/2 = top).
function sectionPoint(z, t) {
  const hw = halfAt(z), top = topAt(z), bot = bottomAt(z);
  const xn = se(Math.cos(t)), yn = se(Math.sin(t));
  const mid = (top + bot) / 2, hh = (top - bot) / 2;
  let x = hw * xn, y = mid + hh * yn;
  if (yn > 0) { y += wingAt(z) * Math.pow(Math.abs(xn), 4) * yn; x *= 1 - 0.07 * yn; }
  return [x, y];
}
// Lofts closed rings through stations; caps the ends if asked. groupOf(j)
// picks the material of the faces between ring points j and j + 1.
function loft(THREE, zs, ring, capStart, capEnd, groupOf = null) {
  const pos = [], idx = [], idx1 = [];
  let n = 0;
  zs.forEach((z) => {
    const r = ring(z);
    n = r.length;
    for (const [x, y] of r) pos.push(x, y, z);
  });
  for (let i = 0; i + 1 < zs.length; ++i)
    for (let j = 0; j < n; ++j) {
      const a = i * n + j, b = i * n + (j + 1) % n, c = a + n, d = b + n;
      (groupOf && groupOf(j) ? idx1 : idx).push(a, c, b, b, c, d);
    }
  const cap = (i, flip) => {
    const z = zs[i], r = ring(z), base = pos.length / 3;
    let cx = 0, cy = 0;
    for (const [x, y] of r) { cx += x; cy += y; }
    pos.push(cx / r.length, cy / r.length, z);
    for (const [x, y] of r) pos.push(x, y, z);
    for (let j = 0; j < r.length; ++j) {
      const a = base + 1 + j, b = base + 1 + (j + 1) % r.length;
      if (flip) idx.push(base, b, a); else idx.push(base, a, b);
    }
  };
  if (capStart) cap(0, true);
  if (capEnd) cap(zs.length - 1, false);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx.concat(idx1));
  if (groupOf) { geo.addGroup(0, idx.length, 0); geo.addGroup(idx.length, idx1.length, 1); }
  geo.computeVertexNormals();
  return geo;
}
function stations(z0, z1, step) {
  const n = Math.max(2, Math.ceil(Math.abs(z1 - z0) / step));
  return Array.from({ length: n + 1 }, (_, i) => z0 + (z1 - z0) * i / n);
}
const RING = 44;
function closedRing(z) {
  return Array.from({ length: RING }, (_, j) => sectionPoint(z, -Math.PI / 2 + 2 * Math.PI * j / RING));
}
// The cabin's section: the outer skin up to the door tops, then down the
// inside to the floor and across: a tub open at the top.
function tubRing(z) {
  const r = [], tMax = 0.72, wall = 0.07, floor = 0.3;
  for (let j = 0; j <= 12; ++j) r.push(sectionPoint(z, -Math.PI / 2 + (tMax + Math.PI / 2) * j / 12));
  const [xr, yr] = r[r.length - 1];
  r.push([xr - wall, yr], [xr - wall, (yr + floor) / 2], [xr - wall, floor], [-(xr - wall), floor], [-(xr - wall), (yr + floor) / 2],
    [-(xr - wall), yr]);
  for (let j = 0; j <= 12; ++j) r.push(sectionPoint(z, Math.PI - tMax + (tMax + Math.PI / 2) * j / 12));
  r.pop();  // the bottom centre is the first point again
  return r;
}

export function createGTScene(ctx) {
  const { THREE, scene, groupPane, camera, cam, applyCamera, FLOOR } = ctx;
  const S = {
    active: false, world: null, paneParts: [], schedule: null, lastT: 0, audio: null, view: 0,
    flashes: [], sparks: [], hud: null, saved: null, stats: { fired: 0, glass: 0 },
  };

  function mats() {
    const hi = ctx.tier >= 2;
    const paint = hi
      ? new THREE.MeshPhysicalMaterial({ color: 0xa9afb3, metalness: 0.65, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 })
      : new THREE.MeshStandardMaterial({ color: 0xa9afb3, metalness: 0.65, roughness: 0.3 });
    return {
      paint,
      chrome: new THREE.MeshStandardMaterial({ color: 0xe4e6e8, metalness: 1, roughness: 0.12 }),
      tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 }),
      leather: new THREE.MeshStandardMaterial({ color: 0x3a1d18, roughness: 0.7 }),
      black: new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 0.6 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x6b3a1c, roughness: 0.35, metalness: 0.05 }),
      glass: new THREE.MeshStandardMaterial({ color: 0xc7dde2, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.22,
        depthWrite: false, side: THREE.DoubleSide }),
      lamp: new THREE.MeshStandardMaterial({ color: 0xfff6dc, emissive: 0x6b6250, roughness: 0.1 }),
      red: new THREE.MeshStandardMaterial({ color: 0x7a0d0d, emissive: 0x220000, roughness: 0.3 }),
      suit: new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.85 }),
      skin: new THREE.MeshStandardMaterial({ color: 0x8a6a55, roughness: 0.8 }),
      gun: new THREE.MeshStandardMaterial({ color: 0x1e1f22, metalness: 0.6, roughness: 0.4 }),
    };
  }

  function box(m, w, h, d, x, y, z, parent) {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    o.castShadow = o.receiveShadow = ctx.tier >= 3;
    parent.add(o);
    return o;
  }

  function buildCar(M) {
    const car = new THREE.Group();
    const add = (o) => { o.castShadow = o.receiveShadow = ctx.tier >= 3; car.add(o); return o; };
    const topY = COWL[1] + 0.42 * Math.cos(RAKE), topZ = COWL[2] - 0.42 * Math.sin(RAKE);
    // Body: bonnet and wings, the open cabin tub, the tail.
    add(new THREE.Mesh(loft(THREE, stations(2.32, COWL[2] - 0.01, 0.05), closedRing, true, true), M.paint));
    // The tub's door tops, inner walls and floor are trimmed dark.
    add(new THREE.Mesh(loft(THREE, stations(COWL[2], -1.2, 0.05), tubRing, false, false, (j) => j >= 12 && j <= 18),
      [M.paint, M.leather]));
    add(new THREE.Mesh(loft(THREE, stations(-1.19, -2.3, 0.05), closedRing, true, true), M.paint));
    // A soft contact shadow (the sun's shadow map is only on high tiers).
    const shadowTex = canvasTex(THREE, 128, 128, (c, w) => {
      const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, 0, w, w);
    });
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 5.4), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.005;
    car.add(shadow);
    // Wheels: tyres, wire hubs, spinners.
    for (const z of AXLES) for (const s of [-1, 1]) {
      const x = s * (halfAt(z) - 0.1);
      const t = add(new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.2, 32), M.tyre));
      t.rotation.z = Math.PI / 2; t.position.set(x, 0.33, z);
      const h = add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.205, 24), M.chrome));
      h.rotation.z = Math.PI / 2; h.position.set(x, 0.33, z);
      const k = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 3), M.chrome));
      k.rotation.z = Math.PI / 2; k.position.set(x + s * 0.12, 0.33, z);
    }
    // Face: round lamps under the wings, the shield grille, bumpers; tail lamps.
    for (const s of [-1, 1]) {
      const l = add(new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.lamp));
      l.rotation.x = Math.PI / 2; l.position.set(s * 0.56, 0.66, 2.16);
      const r = add(new THREE.Mesh(new THREE.TorusGeometry(0.087, 0.01, 8, 24), M.chrome));
      r.position.set(s * 0.56, 0.66, 2.16);
      box(M.red, 0.12, 0.07, 0.03, s * 0.55, 0.72, -2.2, car);
    }
    const grille = add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.04, 6, 1), M.black));
    grille.rotation.x = Math.PI / 2; grille.scale.set(1.2, 1, 0.78); grille.position.set(0, 0.46, 2.31);
    const gr = add(new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.01, 6, 6), M.chrome));
    gr.scale.set(1.2, 0.78, 1); gr.position.set(0, 0.46, 2.33); gr.rotation.z = Math.PI / 6;
    for (const s of [-1, 1]) {
      box(M.chrome, 0.5, 0.045, 0.07, s * 0.42, 0.4, 2.3, car);
      box(M.chrome, 0.55, 0.045, 0.07, s * 0.36, 0.42, -2.28, car);
    }
    // Glasshouse: a crowned roof, the fastback screen, fixed side glass, sail panels.
    const roofZ0 = topZ - 0.01, roofZ1 = -0.88;
    const roofRing = (z) => {
      const u = (z - roofZ1) / (roofZ0 - roofZ1);
      const y0 = topY + 0.02 + 0.03 * Math.sin(Math.PI * u), hw = 0.72;
      const r = [];
      for (let j = 0; j <= 14; ++j) { const x = -hw + 2 * hw * j / 14; r.push([x, y0 + 0.05 * (1 - (x / hw) ** 2)]); }
      for (let j = 14; j >= 0; --j) { const x = -hw + 2 * hw * j / 14; r.push([x * 0.99, y0 + 0.05 * (1 - (x / hw) ** 2) - 0.025]); }
      return r;
    };
    add(new THREE.Mesh(loft(THREE, stations(roofZ0, roofZ1, 0.06), roofRing, true, true), M.paint));
    const deckZ = -1.72, deckY = topAt(deckZ) + 0.01, roofEndY = topY + 0.045;
    const rearLen = Math.hypot(roofZ1 - deckZ, roofEndY - deckY);
    const rear = box(M.glass, 1.4, 0.01, rearLen, 0, (roofEndY + deckY) / 2, (roofZ1 + deckZ) / 2, car);
    rear.rotation.x = Math.atan2(roofEndY - deckY, roofZ1 - deckZ);
    rear.renderOrder = 1;
    for (const s of [-1, 1]) {
      const side = (pts, m) => {
        const sh = new THREE.Shape();
        pts.forEach(([z, y], i) => (i ? sh.lineTo(z, y) : sh.moveTo(z, y)));
        const g = new THREE.ShapeGeometry(sh);
        g.rotateY(-Math.PI / 2);
        const o = new THREE.Mesh(g, m);
        o.position.x = s * (halfAt(-0.3) - 0.09);
        o.renderOrder = 1;
        return add(o);
      };
      const belt = topAt(-0.3) + 0.02;
      side([[COWL[2] - 0.03, belt], [topZ, topY], [roofZ1 + 0.05, topY + 0.02], [-1.12, belt]], M.glass).material.side = THREE.DoubleSide;
      side([[roofZ1 + 0.05, topY + 0.03], [deckZ, deckY], [-1.12, belt - 0.005]], M.paint).material.side = THREE.DoubleSide;
      box(M.chrome, 0.015, 0.012, Math.hypot(topZ - roofZ1, 0.02) + 0.05, s * (halfAt(-0.3) - 0.088), topY + 0.012, (topZ + roofZ1) / 2, car);
      box(M.leather, 0.03, 0.5, 1.5, s * (halfAt(-0.3) - 0.11), 0.68, -0.38, car);              // door cards
    }
    // Inside: dash with gauges, a wood-rimmed wheel, seats, mirror.
    box(M.wood, 1.42, 0.03, 0.3, 0, COWL[1] - 0.04, COWL[2] - 0.12, car);
    box(M.leather, 1.42, 0.24, 0.06, 0, COWL[1] - 0.17, COWL[2] - 0.27, car);
    const dashZ = COWL[2] - 0.305;
    for (const [x, r] of [[-0.56, 0.028], [-0.45, 0.04], [-0.23, 0.04], [-0.12, 0.028], [0.14, 0.025], [0.22, 0.025]]) {
      const d = add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.01, 24), M.black));
      d.rotation.x = Math.PI / 2; d.position.set(x, COWL[1] - 0.14, dashZ);
      const ring = add(new THREE.Mesh(new THREE.TorusGeometry(r, 0.004, 6, 24), M.chrome));
      ring.position.set(x, COWL[1] - 0.14, dashZ - 0.006);
    }
    const wheel = new THREE.Group();
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.011, 10, 48), M.wood));
    for (let i = 0; i < 3; ++i) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / 3;
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.01, 0.005), M.chrome);
      sp.rotation.z = a;
      sp.position.set(Math.cos(a) * 0.095, Math.sin(a) * 0.095, 0);
      wheel.add(sp);
    }
    wheel.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 16).rotateX(Math.PI / 2), M.chrome));
    wheel.position.set(EYE[0], 0.79, -0.08);
    wheel.rotation.x = -0.45;
    car.add(wheel);
    const col = add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.36, 10), M.black));
    col.position.set(EYE[0], 0.73, 0.07); col.rotation.x = Math.PI / 2 - 0.45;
    for (const x of [-0.34, 0.34]) {
      box(M.leather, 0.48, 0.12, 0.5, x, 0.42, -0.62, car);
      const b = box(M.leather, 0.48, 0.62, 0.1, x, 0.76, -0.93, car);
      b.rotation.x = -0.18;
    }
    box(M.leather, 0.18, 0.2, 0.6, 0, 0.4, -0.25, car);
    box(M.black, 0.17, 0.05, 0.012, 0.02, topY - 0.04, topZ - 0.04, car);                    // mirror
    return car;
  }

  function buildPiazza(M) {
    const g = new THREE.Group();
    const paving = canvasTex(THREE, 256, 256, (c, w) => {
      c.fillStyle = '#d8c8a4'; c.fillRect(0, 0, w, w);
      for (let j = 0; j < 4; ++j) for (let i = 0; i < 4; ++i) {
        const v = 200 + Math.floor(Math.random() * 30);
        c.fillStyle = `rgb(${v + 16},${v + 2},${v - 30})`;
        c.fillRect(i * 64 + (j % 2) * 32 + 1, j * 64 + 1, 62, 62);
      }
      c.strokeStyle = 'rgba(120,100,70,0.35)'; c.lineWidth = 2;
      for (let j = 0; j <= 4; ++j) { c.beginPath(); c.moveTo(0, j * 64); c.lineTo(w, j * 64); c.stroke(); }
    }, [90, 90]);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), new THREE.MeshStandardMaterial({ map: paving, roughness: 0.93 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = ctx.tier >= 3;
    g.add(ground);
    const facade = canvasTex(THREE, 256, 256, (c, w) => {
      c.fillStyle = '#d6c4a0'; c.fillRect(0, 0, w, w);
      for (let i = 0; i < 900; ++i) { c.fillStyle = `rgba(150,125,90,${0.08 * Math.random()})`; c.fillRect(Math.random() * w, Math.random() * w, 6, 3); }
      c.fillStyle = '#3b3029';
      c.fillRect(88, 60, 80, 120);
      c.fillStyle = '#c9b48c'; c.fillRect(80, 52, 96, 8); c.fillRect(80, 180, 96, 10);
    });
    const bm = new THREE.MeshStandardMaterial({ map: facade, roughness: 0.9 });
    const rnd = mulberry32(7);
    const place = (x, z, w, d, h, rot) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const uv = geo.attributes.uv, n = geo.attributes.normal;
      for (let i = 0; i < uv.count; ++i) {
        const sx = Math.abs(n.getX(i)) > 0.5 ? d : w;
        uv.setXY(i, uv.getX(i) * sx / 3.4, uv.getY(i) * h / 3.6);
      }
      facade.wrapS = facade.wrapT = THREE.RepeatWrapping;
      const m = new THREE.Mesh(geo, bm);
      m.position.set(x, h / 2, z);
      m.rotation.y = rot;
      m.receiveShadow = ctx.tier >= 3;
      g.add(m);
    };
    for (let i = -3; i <= 3; ++i) place(i * 10 + rnd() * 2, 38, 9.5, 10, 10 + rnd() * 9, 0);
    for (let i = -2; i <= 3; ++i) { place(-26, i * 10 + 6, 10, 9.5, 9 + rnd() * 7, 0); place(28, i * 10 + 4, 10, 9.5, 9 + rnd() * 8, 0); }
    for (const x of [-22, -12, 12, 22]) place(x, -16, 9.5, 10, 9 + rnd() * 5, 0);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), bm);
    dome.position.set(4, 22, 40);
    g.add(dome);
    // The gunmen, each facing the car.
    S.gunmen = GUNMEN.map(([x, z], gi) => {
      const m = new THREE.Group();
      const limb = (r, len, x0, y0, z0, rx = 0, mat = M.suit) => {
        const o = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), mat);
        o.position.set(x0, y0, z0); o.rotation.x = rx;
        o.castShadow = ctx.tier >= 3;
        m.add(o);
        return o;
      };
      const stance = gi % 2 ? 0.12 : -0.08;
      limb(0.075, 0.72, 0.11, 0.46, stance, -stance);
      limb(0.075, 0.72, -0.11, 0.46, -stance, stance);
      const torso = limb(0.19, 0.36, 0, 1.15, 0);
      torso.scale.set(1, 1, 0.7);
      limb(0.05, 0.08, 0, 1.47, 0, 0, M.skin);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 18, 14), M.skin);
      head.position.set(0, 1.6, 0.01); m.add(head);
      const hair = new THREE.Mesh(new THREE.SphereGeometry(0.108, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.suit);
      hair.position.set(0, 1.61, -0.005); m.add(hair);
      limb(0.05, 0.3, 0.17, 1.33, 0.2, Math.PI / 2 - 0.15);
      limb(0.05, 0.3, -0.12, 1.33, 0.25, Math.PI / 2 - 0.05);
      box(M.gun, 0.05, 0.09, 0.42, 0.04, 1.39, 0.38, m);
      box(M.gun, 0.03, 0.14, 0.04, 0.04, 1.3, 0.34, m);
      m.position.set(x, 0, z);
      m.lookAt(EYE[0], 0, EYE[2]);
      g.add(m);
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: S.flashTex, color: 0xffffff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false }));
      flash.position.copy(m.localToWorld(new THREE.Vector3(0.05, 1.41, 0.62)));
      flash.scale.setScalar(0.4);
      flash.visible = false;
      g.add(flash);
      return { group: m, flash, muzzle: flash.position.clone(), until: -1 };
    });
    return g;
  }

  // Pillars, header rail and cowl, mounted with the pane so they rake with it.
  function buildPaneParts(M, P) {
    const parts = [];
    const { W, H, T } = P;
    const add = (w, h, d, x, y, z) => { const o = box(M.paint, w, h, d, x, y, z, groupPane); parts.push(o); };
    add(0.08, H + 0.08, T + 0.04, -W / 2 - 0.04, FLOOR + H / 2, -T / 2);
    add(0.08, H + 0.08, T + 0.04, W / 2 + 0.04, FLOOR + H / 2, -T / 2);
    add(W + 0.16, 0.06, T + 0.04, 0, FLOOR + H + 0.03, -T / 2);
    add(W + 0.16, 0.05, T + 0.04, 0, FLOOR - 0.025, -T / 2);
    return parts;
  }

  // The barrage: bursts from each gunman at the driver, scattered, with the
  // muzzle climbing through each burst. Rounds that reach the windscreen
  // become engine shots; the rest spark off the body or fly past.
  function buildSchedule(P, seed, impactorIndex) {
    const rnd = mulberry32(seed ^ 0x5eed);
    groupPane.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(groupPane.matrixWorld).invert();
    const rot = new THREE.Matrix3().setFromMatrix4(inv);
    const shots = [], fx = [];
    const lead = Math.min(0.9, Math.max(0.25, 0.25 + 0.0015 * MUZZLE_V));
    S.gunmen.forEach((gm, gi) => {
      let t = 0.5 + 0.45 * gi + 0.3 * rnd();
      while (t < DURATION) {
        const n = 4 + Math.floor(rnd() * 6);
        const cx = 0.12 * gauss(rnd), cy = 0.08 * gauss(rnd) - 0.02;
        for (let k = 0; k < n && t < DURATION; ++k, t += 0.075) {
          const aim = new THREE.Vector3(EYE[0] + cx + 0.06 * gauss(rnd), EYE[1] + cy + 0.025 * k + 0.05 * gauss(rnd), EYE[2]);
          const M0 = gm.muzzle.clone();
          const d = aim.clone().sub(M0).normalize();
          fx.push({ t, kind: 0, gun: gi, dist: M0.distanceTo(new THREE.Vector3(...EYE)) });
          // Where it meets the windscreen's plane (the front face, local z = 0).
          const o = M0.clone().applyMatrix4(inv), dl = d.clone().applyMatrix3(rot);
          if (dl.z >= -1e-6) continue;
          const s = -o.z / dl.z;
          const hit = o.clone().addScaledVector(dl, s);
          const x = hit.x + P.W / 2, y = hit.y - FLOOR;
          const tHit = t + s / MUZZLE_V;
          if (x > 0.01 && y > 0.01 && x < P.W - 0.01 && y < P.H - 0.01) {
            const dp = [dl.x, dl.y, -dl.z];
            shots.push({ t: t + (s - lead) / MUZZLE_V, iIdx: impactorIndex, x, y, speed: MUZZLE_V,
              yaw: Math.atan2(dp[0], dp[2]) * 180 / Math.PI, pitch: Math.asin(Math.max(-1, Math.min(1, dp[1]))) * 180 / Math.PI,
              fromBack: false });
            fx.push({ t: tHit, kind: 1 });
          } else if (x > -0.15 && x < P.W + 0.15 && y > -0.7 && y < P.H + 0.3) {
            const w = M0.clone().addScaledVector(d, s);
            fx.push({ t: tHit, kind: 2, pos: w });
          }
        }
        t += 0.45 + 0.9 * rnd();
      }
    });
    shots.sort((a, b) => a.t - b.t);
    fx.sort((a, b) => a.t - b.t);
    return { shots, fx };
  }

  function hud() {
    if (S.hud) return S.hud;
    const d = document.createElement('div');
    d.id = 'gtHud';
    d.className = 'panel';
    d.setAttribute('role', 'status');
    d.style.cssText = 'position:fixed;left:50%;top:62px;transform:translateX(-50%);z-index:3;display:flex;gap:10px;align-items:center;' +
      'flex-wrap:wrap;justify-content:center;padding:7px 10px;max-width:calc(100% - 24px);font-size:13px';
    d.innerHTML = '<b style="font-family:var(--display,inherit);letter-spacing:.04em">ARMOURED GT · UNDER FIRE</b>' +
      '<span id="gtStats"></span><span id="gtView"></span>' +
      '<button id="gtCam" title="Driver, outside, gunman (C)">Driver</button>' +
      '<button id="gtMute" aria-pressed="false">Sound on</button>' +
      '<button id="gtExit" title="Back to the test frame">Leave</button>';
    document.body.appendChild(d);
    d.querySelector('#gtCam').onclick = () => { S.view = (S.view + 1) % 3; frame(); };
    d.querySelector('#gtMute').onclick = (e) => {
      if (!S.audio) return;
      S.audio.muted = !S.audio.muted;
      e.target.textContent = S.audio.muted ? 'Sound off' : 'Sound on';
      e.target.setAttribute('aria-pressed', String(S.audio.muted));
    };
    d.querySelector('#gtExit').onclick = () => ctx.leave();
    // Browsers start sound only after a gesture (the scene may open from a link).
    const unlock = () => { if (S.audio) S.audio.resume(); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    S.hud = d;
    return d;
  }

  // Cameras: the driver's seat, outside at three-quarters, behind a gunman.
  function frame() {
    const set = (eye, target) => {
      const v = new THREE.Vector3(...eye).sub(new THREE.Vector3(...target));
      cam.tx = target[0]; cam.ty = target[1]; cam.tz = target[2];
      cam.r = v.length(); cam.phi = Math.acos(v.y / cam.r); cam.theta = Math.atan2(v.x, v.z);
      applyCamera();
    };
    const names = ['Driver', 'Outside', 'Gunman'];
    if (S.hud) S.hud.querySelector('#gtCam').textContent = names[S.view];
    // Portrait screens keep about 50 degrees across.
    const across = (deg) => 2 * Math.atan(Math.tan(deg * Math.PI / 360) / Math.max(camera.aspect, 0.3)) * 180 / Math.PI;
    camera.fov = Math.min(95, Math.max(S.view === 0 ? 50 : 42, across(S.view === 0 ? 52 : 46)));
    camera.updateProjectionMatrix();
    if (S.view === 0) set(EYE, [EYE[0], EYE[1] - 0.006, EYE[2] + 0.25]);
    else if (S.view === 1) set([2.6, 1.5, 3.9], [0, 0.95, 0.1]);
    else {
      const g = GUNMEN[1];
      set([g[0] + 0.7, 1.75, g[1] + 1.8], [0, 1.0, 0.2]);
    }
  }

  S.enter = (P, seed, impactorIndex) => {
    S.active = true;
    const M = S.M || (S.M = mats());
    if (!S.flashTex) S.flashTex = flashTexture(THREE);
    groupPane.rotation.set(-RAKE, 0, 0);
    const base = new THREE.Vector3(0, FLOOR, 0).applyEuler(groupPane.rotation);
    groupPane.position.set(COWL[0] - base.x, COWL[1] - base.y, COWL[2] - base.z);
    groupPane.updateMatrixWorld(true);
    if (!S.world) {
      S.world = new THREE.Group();
      S.world.add(buildCar(M));
      S.world.add(buildPiazza(M));
      S.sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
      S.sun.position.set(-18, 26, 12);
      S.sun.castShadow = ctx.tier >= 3;
      S.sun.shadow.mapSize.set(2048, 2048);
      Object.assign(S.sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 80 });
      S.world.add(S.sun);
      S.world.add(new THREE.HemisphereLight(0xd8e6f4, 0xb9a47e, 1.1));
      S.sparkPool = Array.from({ length: 12 }, () => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: S.flashTex, color: 0xffc070, transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false }));
        s.visible = false; s.scale.setScalar(0.14); S.world.add(s);
        return { s, until: -1 };
      });
    }
    scene.add(S.world);
    S.saved = { bg: scene.background, fog: scene.fog, far: camera.far, near: camera.near, fov: camera.fov };
    scene.background = new THREE.Color(0xa7c7e6);
    scene.fog = new THREE.Fog(0xb9d2ea, 45, 170);
    camera.far = 400; camera.near = 0.02; camera.updateProjectionMatrix();
    for (const o of ctx.labObjects) o.visible = false;
    S.attach(P, seed, impactorIndex);
    hud();
    S.hud.style.display = 'flex';
    if (!S.audio) S.audio = new SceneAudio();
    S.audio.resume();
    S.view = 0;
    ctx.layout();
    frame();
  };

  // After every new pane (entering, Replay): mount it and script the barrage.
  S.attach = (P, seed, impactorIndex) => {
    if (!S.active) return;
    for (const m of P.meshes) if (m.userData.lab) m.visible = false;
    for (const o of S.paneParts) groupPane.remove(o);
    S.paneParts = buildPaneParts(S.M, P);
    S.schedule = buildSchedule(P, seed, impactorIndex);
    S.lastT = -1;
    S.cursor = 0;
    S.stats = { fired: 0, glass: 0 };
    return S.schedule.shots;
  };

  S.leave = () => {
    if (!S.active) return;
    S.active = false;
    scene.remove(S.world);
    for (const o of S.paneParts) groupPane.remove(o);
    S.paneParts = [];
    groupPane.rotation.set(0, 0, 0);
    groupPane.position.set(0, 0, 0);
    groupPane.updateMatrixWorld(true);
    scene.background = S.saved.bg; scene.fog = S.saved.fog;
    camera.far = S.saved.far; camera.near = S.saved.near; camera.fov = S.saved.fov; camera.updateProjectionMatrix();
    for (const o of ctx.labObjects) o.visible = true;
    if (S.hud) S.hud.style.display = 'none';
    ctx.layout();
  };

  S.frameCamera = frame;
  S.nextView = () => { S.view = (S.view + 1) % 3; frame(); };

  // Effects in engine time: muzzle flashes, sparks, sound; and the readout.
  S.update = (tEng, scale, state) => {
    if (!S.active || !S.schedule) return;
    const fx = S.schedule.fx;
    if (tEng < S.lastT) { S.cursor = 0; S.stats = { fired: 0, glass: 0 }; }
    const audible = scale >= 0.3 && S.audio;
    while (S.cursor < fx.length && fx[S.cursor].t <= tEng) {
      const e = fx[S.cursor++];
      if (e.kind === 0) {
        S.stats.fired++;
        const g = S.gunmen[e.gun];
        g.until = e.t + 0.03;
        g.flash.material.rotation = Math.random() * Math.PI;
        g.flash.scale.setScalar(0.3 + 0.25 * Math.random());
        if (audible && tEng - e.t < 0.1) S.audio.gunshot(e.dist, Math.max(-1, Math.min(1, (g.muzzle.x - EYE[0]) / 10)));
      } else if (e.kind === 1) {
        S.stats.glass++;
        if (audible && tEng - e.t < 0.1) S.audio.glass();
      } else {
        const sp = S.sparkPool.find((p) => p.until < tEng) || S.sparkPool[0];
        sp.s.position.copy(e.pos);
        sp.until = e.t + 0.04;
        sp.s.material.rotation = Math.random() * Math.PI;
        if (audible && tEng - e.t < 0.1) S.audio.spark(Math.max(-1, Math.min(1, e.pos.x)));
      }
    }
    S.lastT = tEng;
    // A flash stays up at least a couple of frames whatever the speed.
    const hold = Math.max(0.03, 0.035 * scale);
    for (const g of S.gunmen) g.flash.visible = tEng >= g.until - 0.03 && tEng < g.until - 0.03 + hold;
    for (const p of S.sparkPool) p.s.visible = tEng >= p.until - 0.04 && tEng < p.until - 0.04 + Math.max(0.04, 0.035 * scale);
    if (S.hud) {
      const vis = Math.round(100 * state[10]);
      S.hud.querySelector('#gtStats').textContent =
        `${S.stats.fired} rounds · ${S.stats.glass} on the glass · ${state[7] ? 'one got through' : 'none through'}`;
      S.hud.querySelector('#gtView').textContent = `driver's view ${vis}%`;
    }
  };

  return S;
}
