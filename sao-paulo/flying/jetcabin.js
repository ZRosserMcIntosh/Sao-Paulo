// São Paulo World · flight test bed: the Top G's flight deck from the left seat.
// Body FLU metres from the nose-tip datum. The instrument panel is one live
// texture (glass.js); yokes, thrust levers, flap and speedbrake levers, gear
// handle and pedals move with the simulation. A lining follows the fuselage
// with the windshield and side windows left open.
import * as THREE from 'three';
import { JET_PANEL_W, JET_PANEL_H, drawJetPanel } from './glass.js';

const DEG = Math.PI / 180;
const PX = -2.62, PZ0 = -0.33;            // panel face x, panel bottom z
const PTOP = PZ0 + JET_PANEL_H;

// scale: the type's fuselage diameter over the Top G's (the flight deck is
// laid out in the Top G's metres and scaled as one; the lining follows the
// type's own skin).
export function buildJetCabin({ mobile, maxAniso, skin, scale = 1 }) {
  const root = new THREE.Group();
  root.scale.setScalar(scale);
  const std = (color, rough = 0.85, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const M = {
    lining: std('#5d6168', 0.92), liningDark: std('#3f4248', 0.9), dark: std('#1f2125', 0.7), black: std('#0e0f11', 0.5),
    leather: std('#3a2f28', 0.75), carpet: std('#2a2a2c', 1), chrome: std('#cfd2d6', 0.3, 1), white: std('#e6e6e2', 0.6),
  };
  M.liningD = M.lining.clone(); M.liningD.side = THREE.DoubleSide;
  const add = (geo, mat, x, y, z, parent = root) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const box = (sx, sy, sz, mat, x, y, z, parent) => add(new THREE.BoxGeometry(sx, sy, sz), mat, x, y, z, parent);
  const rodX = (r, len, mat, x, y, z, parent) => { const m = add(new THREE.CylinderGeometry(r, r, len, 14), mat, x, y, z, parent); m.rotation.z = Math.PI / 2; return m; };

  // ---- Lining: the fuselage interior with the glazing cut out ----
  {
    const inWindshield = (x, a) => {
      const sa = Math.sin(a);
      return a > 16 * DEG && a < 164 * DEG && x <= -1.98 - 0.45 * (1 - sa) && x >= -2.98 - 0.25 * (1 - sa);
    };
    // Side windows: a large sliding-window-sized pane beside each seat.
    const inSide = (x, a) => x <= -3.06 && x >= -3.9 && ((a > 8 * DEG && a < 56 * DEG) || (a > 124 * DEG && a < 172 * DEG));
    const pos = [], idx = [];
    // From the windshield's forward edge aft (~2.5 cm cells keep the glazing edges clean).
    const nx = 145, na = 240, x0 = -1.98, x1 = -5.6;
    for (let i = 0; i <= nx; ++i)
      for (let j = 0; j <= na; ++j) {
        const p = skin((x0 + (x1 - x0) * i / nx) * scale, j / na * 2 * Math.PI, -0.05 * scale).divideScalar(scale);
        pos.push(p.x, p.y, p.z);
      }
    for (let i = 0; i < nx; ++i)
      for (let j = 0; j < na; ++j) {
        const xm = x0 + (x1 - x0) * (i + 0.5) / nx, am = (j + 0.5) / na * 2 * Math.PI;
        if (inWindshield(xm, am) || inSide(xm, am)) continue;
        const k = i * (na + 1) + j;
        idx.push(k, k + 1, k + na + 1, k + 1, k + na + 2, k + na + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, M.liningD); m.receiveShadow = true; root.add(m);
    // Bulkhead and door to the cabin behind the seats.
    const bh = new THREE.Mesh(new THREE.CircleGeometry(1.3, 32), M.liningD); bh.rotation.y = Math.PI / 2; bh.position.x = -5.5; root.add(bh);
    box(0.02, 0.62, 1.7, M.liningDark, -5.49, 0, 0.0);
  }
  box(3.1, 1.9, 0.03, M.carpet, -4.0, 0, -0.85);

  // ---- Panel, glareshield ----
  const W = mobile ? 1536 : 2304, H = Math.round(W * JET_PANEL_H / JET_PANEL_W);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
  const face = add(new THREE.PlaneGeometry(JET_PANEL_W, JET_PANEL_H),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.55 }), PX, 0, PZ0 + JET_PANEL_H / 2);
  face.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
  face.castShadow = false;
  box(0.1, JET_PANEL_W + 0.04, JET_PANEL_H + 0.04, M.dark, PX + 0.051, 0, PZ0 + JET_PANEL_H / 2);
  box(0.36, 2.0, 0.06, M.dark, PX + 0.12, 0, PTOP + 0.035);
  const lip = add(new THREE.CylinderGeometry(0.03, 0.03, 2.0, 12), M.dark, PX - 0.06, 0, PTOP + 0.03);
  void lip;
  // Guidance panel on the glareshield (dark strip with a lit row).
  box(0.1, 0.9, 0.05, M.black, PX - 0.02, 0, PTOP + 0.085);
  box(0.004, 0.86, 0.012, std('#3fd6e6', 0.4), PX - 0.071, 0, PTOP + 0.09).material.emissive = new THREE.Color('#123c40');

  // ---- Centre pedestal with thrust levers, speedbrake and flap levers ----
  box(1.05, 0.36, 0.42, M.dark, -3.15, 0, -0.62);
  const pedTop = -0.41;
  const throttles = [];
  for (const y of [0.06, -0.06]) {
    const g = new THREE.Group(); g.position.set(-3.0, y, pedTop); root.add(g);
    rodX(0.012, 0.01, M.chrome, 0, 0, 0, g);
    const arm = box(0.03, 0.025, 0.2, M.chrome, 0, 0, 0.1, g); void arm;
    box(0.07, 0.06, 0.05, M.black, 0, 0, 0.21, g);
    // An invisible grab volume around the lever (for the mouse).
    const grab = box(0.1, 0.11, 0.26, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), 0, 0, 0.12, g);
    grab.castShadow = grab.receiveShadow = false;
    throttles.push(g);
  }
  const spd = new THREE.Group(); spd.position.set(-3.0, 0.15, pedTop); root.add(spd);
  box(0.02, 0.02, 0.15, M.chrome, 0, 0, 0.075, spd); box(0.05, 0.035, 0.03, M.white, 0, 0, 0.16, spd);
  const flap = new THREE.Group(); flap.position.set(-3.0, -0.15, pedTop); root.add(flap);
  box(0.02, 0.02, 0.13, M.chrome, 0, 0, 0.065, flap); box(0.05, 0.06, 0.02, M.white, 0, 0, 0.14, flap);
  // Gear handle on the centre panel (a wheel-shaped knob that drops with the lever).
  const gearH = new THREE.Group(); gearH.position.set(PX - 0.02, -0.02, PZ0 + 0.08); root.add(gearH);
  rodX(0.008, 0.07, M.chrome, -0.035, 0, 0, gearH);
  const knob = add(new THREE.CylinderGeometry(0.03, 0.03, 0.018, 18), M.white, -0.075, 0, 0, gearH); knob.rotation.z = Math.PI / 2;

  // ---- Yokes and pedals ----
  const yokes = [];
  for (const y0 of [0.52, -0.52]) {
    const g = new THREE.Group(); g.position.set(PX - 0.22, y0, PZ0 + 0.12); root.add(g);
    rodX(0.016, 0.45, M.dark, 0.22, 0, 0, g);
    box(0.05, 0.08, 0.07, M.dark, -0.01, 0, 0, g);
    box(0.035, 0.3, 0.035, M.dark, -0.02, 0, 0.0, g);
    for (const s of [1, -1]) {
      const h = box(0.04, 0.04, 0.14, M.leather, -0.03, s * 0.16, 0.05, g); h.rotation.x = -s * 12 * DEG;
    }
    yokes.push(g);
  }
  const pedals = [];
  for (const y0 of [0.52, -0.52]) for (const s of [1, -1]) {
    const g = new THREE.Group(); g.position.set(-2.55, y0 + s * 0.1, -0.78); root.add(g);
    const p = box(0.025, 0.09, 0.17, M.black, 0, 0, 0.08, g); p.rotation.y = -28 * DEG;
    pedals.push({ g, side: s });
  }

  // ---- Seats, side consoles, overhead ----
  for (const y of [0.52, -0.52]) {
    box(0.55, 0.52, 0.14, M.leather, -3.95, y, -0.55);
    const back = box(0.14, 0.52, 0.8, M.leather, -4.3, y, -0.08); back.rotation.y = -14 * DEG;
    const head = box(0.12, 0.3, 0.2, M.leather, -4.4, y, 0.42); head.rotation.y = -14 * DEG;
    box(0.9, 0.14, 0.12, M.liningDark, -3.35, y * 1.72, -0.28);
  }
  const ov = box(0.75, 0.62, 0.08, M.dark, -3.2, 0, 1.08); ov.rotation.y = 18 * DEG;
  // Overhead: the first two rows are working switches (electrical and
  // lights), the rest the panel's other systems (not simulated: inert).
  const OVERHEAD = [
    ['electrical.battery', 'BATT'], ['electrical.alternator', 'GEN'], ['electrical.avionics', 'AVIONICS'], ['fuel.auxpump', 'FUEL PUMP'], ['electrical.load.pitot_heat', 'PITOT HEAT'],
    ['electrical.load.beacon', 'BEACON'], ['electrical.load.nav_lights', 'NAV LTS'], ['electrical.load.strobes', 'STROBES'], ['electrical.load.taxi_light', 'TAXI LT'], ['electrical.load.landing_light', 'LANDING LTS'],
    ['electrical.load.panel_lights', 'PANEL LTS'],
  ];
  const switches = [];
  for (let r = 0; r < 4; ++r) for (let k = 0; k < 9; ++k) {
    const n = r * 9 + k, live = OVERHEAD[n];
    const g = new THREE.Group(); g.position.set(-2.95 - r * 0.15, -0.24 + k * 0.06, 1.0 + r * 0.05); root.add(g);
    box(0.012, 0.025, 0.012, live ? M.white : M.liningDark, 0, 0, 0, g);
    if (live) switches.push({ g, id: live[0], label: live[1] });
  }
  // Engine fuel control switches (RUN / CUTOFF) aft of the thrust levers.
  const fuelSw = [];
  for (const [i, y] of [[0, 0.05], [1, -0.05]]) {
    const g = new THREE.Group(); g.position.set(-3.38, y, pedTop + 0.01); root.add(g);
    box(0.015, 0.015, 0.05, M.chrome, 0, 0, 0.025, g); box(0.03, 0.03, 0.025, std('#b8231c', 0.5), 0, 0, 0.055, g);
    fuelSw.push({ g, id: `engine${i + 1}.fuel` });
  }
  // Parking brake handle on the pedestal's left side.
  const park = new THREE.Group(); park.position.set(-3.45, 0.19, pedTop - 0.05); root.add(park);
  rodX(0.006, 0.08, M.chrome, 0.04, 0, 0, park); box(0.02, 0.06, 0.02, std('#b8231c', 0.5), 0, 0, 0, park);
  // Guidance-panel knobs on the glareshield: heading bug and barometric setting.
  const knobOn = (y) => { const k = add(new THREE.CylinderGeometry(0.018, 0.018, 0.025, 18), M.chrome, PX - 0.08, y, PTOP + 0.085); k.rotation.z = Math.PI / 2; return k; };
  const hdgKnob = knobOn(0.12), baroKnob = knobOn(0.36);

  function update(st) {
    for (const g of yokes) { g.position.x = PX - 0.22 - st.elev * 0.08; g.rotation.x = st.ail * 0.8; }
    for (const p of pedals) p.g.position.x = -2.55 + (p.side < 0 ? 1 : -1) * st.rud * 0.05;
    for (const t of throttles) t.rotation.y = (st.thr - 0.35) * 55 * DEG;
    spd.rotation.y = -st.spd * 40 * DEG;
    flap.rotation.y = -Math.min(st.flapLever / 3, 1) * 45 * DEG;
    gearH.position.z = PZ0 + (st.gearDown ? 0.04 : 0.12);
    const p = st.pos || {};
    for (const w of switches) w.g.rotation.y = (p[w.id] ? -1 : 1) * 25 * DEG;
    for (const w of fuelSw) w.g.position.z = pedTop + 0.01 + (p[w.id] ? 0.02 : 0);
    park.position.x = -3.45 - (p['brakes.parking'] ? 0.06 : 0);
  }
  function redraw(d) {
    drawJetPanel(ctx, W, H, d);
    tex.needsUpdate = true;
  }
  root.visible = false;
  const parts = { throttles, spd, flap, gear: gearH, switches, fuelSw, park, hdgKnob, baroKnob };
  return { root, update, redraw, parts };
}
