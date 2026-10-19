// São Paulo World · flight test bed: the 172's cabin, seen from the left seat.
// Geometry is in body FLU metres from the firewall datum (x forward, y left, z up),
// so it rides inside the airframe group. The panel face is one texture drawn from
// the simulated instruments (panel.js); the controls move with the simulation's
// control positions and the pilot's levers.
import * as THREE from 'three';
import { PANEL_W, PANEL_H, drawCockpitPanel, drawCompassCard } from './panel.js';

const PX = -0.58;           // panel face
const PZ0 = 0.04;           // panel bottom; top is PZ0 + PANEL_H = 0.60
const PTOP = PZ0 + PANEL_H;
const DEG = Math.PI / 180;
// Panel-texture coordinates (u right from the pilot's edge, v down from the top) → body y, z.
const py = (u) => PANEL_W / 2 - u, pz = (v) => PTOP - v;

export function buildCabin({ mobile, maxAniso }) {
  const root = new THREE.Group();
  const std = (color, rough = 0.85, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const M = {
    trim: std('#77726a', 0.9), trim2: std('#5d5953', 0.9), dark: std('#1c1d1f', 0.75), black: std('#0f0f10', 0.55),
    seat: std('#3c3934', 1), carpet: std('#2a2825', 1), chrome: std('#cfd2d6', 0.28, 1), red: std('#a3271f', 0.5),
    cream: std('#d9d3c3', 0.7), yoke: std('#2b2c2f', 0.6),
  };
  M.trimD = M.trim.clone(); M.trimD.side = THREE.DoubleSide;
  const add = (geo, mat, x, y, z, parent = root) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const box = (sx, sy, sz, mat, x, y, z, parent) => add(new THREE.BoxGeometry(sx, sy, sz), mat, x, y, z, parent);
  // Cylinder along body x (three's cylinders run along their local y).
  const rodX = (r, len, mat, x, y, z, parent, seg = 16) => { const m = add(new THREE.CylinderGeometry(r, r, len, seg), mat, x, y, z, parent); m.rotation.z = Math.PI / 2; return m; };
  const rodY = (r, len, mat, x, y, z, parent, seg = 16) => add(new THREE.CylinderGeometry(r, r, len, seg), mat, x, y, z, parent);
  const between = (r, a, b, mat) => {
    const d = new THREE.Vector3().subVectors(b, a), m = add(new THREE.CylinderGeometry(r, r, d.length(), 12), mat, 0, 0, 0);
    m.position.copy(a).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); return m;
  };

  // ---- Instrument panel: one live texture --------------------------------
  const W = mobile ? 1024 : 1536, H = Math.round(W * PANEL_H / PANEL_W);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
  const panelMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.65, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.32 });
  const face = add(new THREE.PlaneGeometry(PANEL_W, PANEL_H), panelMat, PX, 0, PZ0 + PANEL_H / 2);
  face.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
  face.castShadow = false;
  // Panel shell and the padded glareshield with its rounded lip.
  box(0.08, PANEL_W + 0.02, PANEL_H + 0.02, M.dark, PX + 0.041, 0, PZ0 + PANEL_H / 2);
  box(0.28, 1.06, 0.05, M.dark, -0.51, 0, PTOP + 0.03);
  rodY(0.022, 1.06, M.dark, -0.645, 0, PTOP + 0.028);
  // Below the panel: firewall lining and kick panels.
  box(0.02, 1.04, 0.38, M.trim2, -0.14, 0, -0.14);

  // ---- Windshield frame, headliner, visors, vents, compass ---------------
  for (const s of [1, -1]) between(0.024, new THREE.Vector3(-0.38, s * 0.5, 0.66), new THREE.Vector3(-0.95, s * 0.52, 1.04), M.trim);
  box(0.07, 1.06, 0.05, M.trim, -0.97, 0, 1.03);
  box(1.6, 1.06, 0.03, M.trim, -1.76, 0, 1.045);
  for (const s of [1, -1]) {
    const v = box(0.15, 0.32, 0.01, M.cream, -1.06, s * 0.26, 1.02); v.rotation.y = -4 * DEG;
    rodX(0.014, 0.02, M.trim2, -1.1, s * 0.46, 1.022);
  }
  const compassCv = document.createElement('canvas'); compassCv.width = 256; compassCv.height = 96;
  const compassTex = new THREE.CanvasTexture(compassCv); compassTex.colorSpace = THREE.SRGBColorSpace;
  box(0.045, 0.075, 0.045, M.black, -0.94, 0, 0.985);
  rodX(0.005, 0.04, M.black, -0.95, 0, 1.012);
  const card = add(new THREE.PlaneGeometry(0.058, 0.022), new THREE.MeshBasicMaterial({ map: compassTex }), -0.968, 0, 0.985);
  card.quaternion.copy(face.quaternion); card.castShadow = false;

  // ---- Side walls with the door and rear windows cut out -----------------
  {
    const sh = new THREE.Shape([[-0.40, -0.33], [-0.40, 0.655], [-0.95, 1.04], [-2.56, 1.04], [-2.56, -0.33]].map(([x, z]) => new THREE.Vector2(x, z)));
    const hole = (pts) => sh.holes.push(new THREE.Path(pts.map(([x, z]) => new THREE.Vector2(x, z))));
    hole([[-0.6, 0.47], [-1.95, 0.47], [-1.95, 0.975], [-0.96, 0.975], [-0.6, 0.735]]);
    hole([[-2.06, 0.52], [-2.48, 0.56], [-2.48, 0.95], [-2.06, 0.95]]);
    const g = new THREE.ShapeGeometry(sh); g.rotateX(Math.PI / 2);
    for (const s of [1, -1]) {
      add(g, M.trimD, 0, s * 0.52, 0);
      box(0.7, 0.06, 0.05, M.trim2, -1.45, s * 0.49, 0.32);             // armrest
      box(0.04, 0.03, 0.02, M.chrome, -1.15, s * 0.5, 0.4);            // door handle
      box(1.35, 0.02, 0.03, M.trim2, -1.275, s * 0.51, 0.455);         // window sill
    }
  }
  // Floor, centre console, seats, rear bench.
  box(2.45, 1.04, 0.02, M.carpet, -1.33, 0, -0.33);
  box(0.62, 0.14, 0.26, M.trim2, -0.95, 0, -0.19);
  const seat = (y) => {
    box(0.46, 0.42, 0.12, M.seat, -1.6, y, -0.1);
    const back = box(0.1, 0.42, 0.66, M.seat, -1.9, y, 0.27); back.rotation.y = -12 * DEG;
    const head = box(0.08, 0.26, 0.16, M.seat, -1.98, y, 0.68); head.rotation.y = -12 * DEG;
    rodX(0.012, 0.5, M.chrome, -1.6, y + 0.15, -0.2); rodX(0.012, 0.5, M.chrome, -1.6, y - 0.15, -0.2);
  };
  seat(0.27); seat(-0.27);
  box(0.4, 0.98, 0.14, M.seat, -2.3, 0, -0.08);
  const rb = box(0.1, 0.98, 0.55, M.seat, -2.52, 0, 0.25); rb.rotation.y = -10 * DEG;

  // ---- Flight controls ----------------------------------------------------
  // Yokes: the column slides fore/aft with the elevator and turns with the ailerons.
  const yokes = [];
  for (const y0 of [0.27, -0.27]) {
    const g = new THREE.Group(); g.position.set(PX - 0.2, y0, pz(0.32)); root.add(g);
    rodX(0.013, 0.42, M.chrome, 0.2, 0, 0, g);
    box(0.05, 0.07, 0.06, M.yoke, -0.01, 0, 0, g);
    box(0.03, 0.27, 0.032, M.yoke, -0.02, 0, -0.005, g);
    for (const s of [1, -1]) {
      const h = box(0.035, 0.036, 0.13, M.black, -0.025, s * 0.142, 0.045, g); h.rotation.x = -s * 10 * DEG;
      box(0.012, 0.03, 0.012, M.red, -0.045, s * 0.14, 0.105, g);
    }
    box(0.006, 0.05, 0.03, M.cream, -0.04, 0, 0.0, g);
    yokes.push(g);
  }
  // Rudder pedals: pairs pivoting from the floor.
  const pedals = [];
  for (const y0 of [0.27, -0.27]) for (const s of [1, -1]) {
    const g = new THREE.Group(); g.position.set(-0.3, y0 + s * 0.085, -0.29); root.add(g);
    const p = box(0.02, 0.075, 0.14, M.black, 0, 0, 0.06, g); p.rotation.y = -30 * DEG;
    rodX(0.008, 0.16, M.chrome, 0.07, 0, 0.0, g);
    pedals.push({ g, side: s });
  }
  // Push-pull engine controls under the radio stack.
  const knob = (u, mat, ribbed) => {
    const g = new THREE.Group(); g.position.set(PX, py(u), pz(0.5)); root.add(g);
    rodX(0.004, 0.1, M.chrome, 0.05, 0, 0, g);
    rodX(0.016, 0.028, mat, -0.0, 0, 0, g, ribbed ? 24 : 20);
    return g;
  };
  const throttle = knob(0.52, M.black), mixture = knob(0.61, M.red, true), carb = knob(0.45, M.trim2);
  for (const k of [throttle, mixture]) {  // invisible grab volumes (for the mouse)
    const grab = box(0.05, 0.045, 0.045, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), -0.005, 0, 0, k);
    grab.castShadow = grab.receiveShadow = false;
  }
  carb.position.x = PX - 0.02;
  // Flap lever with its wing-shaped knob, riding in a slot beside the indicator.
  box(0.004, 0.012, 0.09, M.black, PX - 0.002, py(0.672), pz(0.368));
  const flap = new THREE.Group(); root.add(flap);
  rodX(0.004, 0.035, M.chrome, 0.0175, 0, 0, flap);
  box(0.014, 0.04, 0.012, M.cream, 0, 0, 0, flap);
  // Trim wheel half sunk in the console, and the fuel selector behind it.
  const trimWheel = new THREE.Group(); trimWheel.position.set(-0.88, 0, -0.07); root.add(trimWheel);
  rodY(0.085, 0.022, M.black, 0, 0, 0, trimWheel, 40);
  for (let i = 0; i < 12; ++i) {
    const a = i / 12 * 2 * Math.PI, n = box(0.012, 0.026, 0.012, i ? M.dark : M.cream, Math.cos(a) * 0.085, 0, Math.sin(a) * 0.085, trimWheel);
    n.rotation.y = -a;
  }
  box(0.2, 0.025, 0.01, M.black, -0.88, 0, -0.058);  // slot in the console top
  const fuelSel = new THREE.Group(); fuelSel.position.set(-1.16, 0, -0.055); root.add(fuelSel);
  rodY(0.05, 0.008, M.dark, 0, 0, 0, fuelSel, 28).rotation.x = Math.PI / 2;
  box(0.09, 0.02, 0.03, M.cream, 0, 0, 0.018, fuelSel);
  // Fuel shutoff valve: the red push-pull knob at the foot of the console.
  const shutoff = new THREE.Group(); shutoff.position.set(-1.28, 0, -0.03); root.add(shutoff);
  rodY(0.006, 0.05, M.chrome, 0, 0, 0.02, shutoff).rotation.x = 0;
  add(new THREE.CylinderGeometry(0.018, 0.018, 0.02, 20), M.red, 0, 0, 0.05, shutoff);
  // Parking brake: a T-handle under the panel on the pilot's left.
  const park = new THREE.Group(); park.position.set(PX - 0.03, py(0.08), PZ0 - 0.05); root.add(park);
  rodX(0.005, 0.06, M.chrome, 0.03, 0, 0, park);
  box(0.016, 0.06, 0.016, M.red, 0, 0, 0, park);

  let compassHdg = NaN;
  // st: elev, ail, rud (−1..1), trim, thr, mix (0..1), flapLever (0..3), fuelSel (0..2), dt
  function update(st) {
    for (const g of yokes) { g.position.x = PX - 0.2 - st.elev * 0.07; g.rotation.x = st.ail * 0.75; }
    for (const p of pedals) p.g.position.x = -0.3 + (p.side < 0 ? 1 : -1) * st.rud * 0.05;
    throttle.position.x = PX - 0.014 - (1 - st.thr) * 0.075;
    mixture.position.x = PX - 0.014 - (1 - st.mix) * 0.075;
    const fv = 0.33 + Math.min(Math.max(st.flapLever / 3, 0), 1) * 0.075;
    flap.position.set(PX - 0.03, py(0.672), pz(fv));
    trimWheel.rotation.y = -st.trim * 6;
    fuelSel.rotation.z = (st.fuelSel - 1) * 0.8;
    shutoff.position.z = -0.03 + (st.shutoff ? 0 : 0.03);          // pulled out: OFF
    park.position.x = PX - 0.03 - (st.park ? 0.05 : 0);             // pulled: SET
  }
  // Hover ring on the panel face (a clickable place), in panel metres.
  let hover = null;
  function setHover(r) { hover = r; }
  function redraw(c, m, sw, s, compass) {
    drawCockpitPanel(ctx, W, H, c, m, sw, s);
    if (hover) {
      const k = W / PANEL_W;
      ctx.strokeStyle = 'rgba(80,200,255,.95)'; ctx.lineWidth = Math.max(2, k * 0.002);
      ctx.strokeRect((hover.u - 0.004) * k, (hover.v - 0.004) * k, (hover.w + 0.008) * k, (hover.h + 0.008) * k);
    }
    tex.needsUpdate = true;
    if (!(Math.abs(compass - compassHdg) <= 0.05)) {
      compassHdg = compass;
      drawCompassCard(compassCv.getContext('2d'), compassCv.width, compassCv.height, ((compass % 360) + 360) % 360);
      compassTex.needsUpdate = true;
    }
  }
  root.visible = false;
  // For the cockpit's mouse interaction: the panel face (its clickable places
  // are PANEL_SPOTS in panel.js) and the movable controls.
  const parts = { face, size: [PANEL_W, PANEL_H], throttle, mixture, flap, trimWheel, fuelSel, shutoff, park, yoke: yokes[0] };
  return { root, update, redraw, setHover, parts };
}
