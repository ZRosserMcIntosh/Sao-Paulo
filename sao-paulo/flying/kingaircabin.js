// São Paulo World · flight test bed: the King Air 350's flight deck, two crew,
// built in its own metres (body FLU from the nose tip) round the pilot's eye
// of its definition (visual.camera.eye, about x -2.55, y 0.42, z 0.38). An
// original layout after the type's arrangement, not a copy of anyone's art:
// a wide glass panel (pilot PFD, map, engines, copilot PFD) under a sloping
// glareshield with the flight-guidance strip, the switch rows on the left
// subpanel and the gear handle by the centre, a pedestal between the seats
// with the power (black), propeller (blue) and condition (red) levers and the
// flap lever, two ram's-horn yokes, the pedals and the seats. The lining
// follows the fuselage with the windshield and side windows cut out where
// the outside model glazes them (jetmodel.js KA_GLAZING), so inside and out agree.
import * as THREE from 'three';
import { drawPFD, drawND, drawEICAS, casMessages, C } from './glass.js';
import { KA_GLAZING } from './jetmodel.js';

const DEG = Math.PI / 180;
const SANS = '"Public Sans",system-ui,sans-serif', MONO = '"JetBrains Mono",ui-monospace,monospace';
// The panel face: its foot (x, z), width and height, its top leaning forward
// (so it faces up toward the eyes above it).
const PX = -1.88, PW = 1.24, PZ0 = -0.36, PH = 0.58, LEAN = 8 * DEG;
const PTOP = PZ0 + PH * Math.cos(LEAN), PXT = PX + PH * Math.sin(LEAN);
// Panel coordinates (m from its top-left corner, seen from the seats; `out` toward the seats) to body FLU.
const onPanel = (u, v, out = 0) => new THREE.Vector3(PX + (PH - v) * Math.sin(LEAN) - out * Math.cos(LEAN), PW / 2 - u, PZ0 + (PH - v) * Math.cos(LEAN) + out * Math.sin(LEAN));

// The working switches on the left subpanel (id, placard), two rows; ice
// protection (anti_ice.*) joins them when the aircraft has it.
const SUBPANEL = [
  ['electrical.battery', 'BATT'], ['electrical.generator1', 'GEN 1'], ['electrical.generator2', 'GEN 2'], ['electrical.avionics', 'AVIONICS'],
  ['engine1.starter', 'START 1'], ['engine2.starter', 'START 2'], ['propeller.autofeather', 'AUTOFEATHER'], ['fuel.auxpump', 'STBY PUMP'],
  ['electrical.load.pitot_heat', 'PROBE HEAT'], ['electrical.load.beacon', 'BEACON'], ['electrical.load.nav_lights', 'NAV'], ['electrical.load.strobes', 'STROBE'],
  ['electrical.load.taxi_light', 'TAXI'], ['electrical.load.landing_light', 'LDG'], ['electrical.load.panel_lights', 'PANEL'],
];

export function buildKingAirCabin({ mobile, maxAniso, skin, ids = [] }) {
  const root = new THREE.Group();
  const lamps = [];  // master warning / caution on the glareshield
  // (The sky's reflection, scene.environment, dimmed: the deck is lit through its windows.)
  const std = (color, rough = 0.85, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMapIntensity: 0.3 });
  const M = {
    lining: std('#a9a39a', 0.9), liningDark: std('#6f6a62', 0.9), panel: std('#2b2e33', 0.75), dark: std('#1d1f23', 0.7), black: std('#0e0f11', 0.5),
    leather: std('#4a3a2c', 0.72), carpet: std('#34363a', 1), chrome: std('#c9ccd0', 0.3, 1), white: std('#e8e8e3', 0.6),
    blue: std('#2f5fae', 0.45), red: std('#b8231c', 0.5), grey: std('#9aa0a6', 0.5, 0.4),
  };
  M.liningD = M.lining.clone(); M.liningD.side = THREE.DoubleSide;
  const add = (geo, mat, x, y, z, parent = root) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const box = (sx, sy, sz, mat, x, y, z, parent) => add(new THREE.BoxGeometry(sx, sy, sz), mat, x, y, z, parent);
  const rod = (r, len, mat, x, y, z, parent, axis = 'x') => {
    const m = add(new THREE.CylinderGeometry(r, r, len, 14), mat, x, y, z, parent);
    if (axis === 'x') m.rotation.z = Math.PI / 2; else if (axis === 'y') { /* the cylinder's own axis */ } else m.rotation.x = Math.PI / 2;
    return m;
  };
  // A grab volume round a control for the mouse (invisible).
  const grabMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const grab = (sx, sy, sz, x, y, z, parent) => { const g = box(sx, sy, sz, grabMat, x, y, z, parent); g.castShadow = g.receiveShadow = false; return g; };

  // ---- Lining: the fuselage inside, the glazing cut out ----
  {
    // Point in polygon, in (x, a) with a scaled to metres round the skin (r 0.75 m).
    const R = 0.75, polys = KA_GLAZING.map((o) => o.map(([x, a]) => [x, a * R]));
    const inside = (x, a) => polys.some((P) => {
      let c = false;
      for (let i = 0, k = P.length - 1; i < P.length; k = i++) {
        const [xi, yi] = P[i], [xk, yk] = P[k];
        if ((yi > a * R) !== (yk > a * R) && x < (xk - xi) * (a * R - yi) / (yk - yi) + xi) c = !c;
      }
      return c;
    });
    // From just ahead of the windshield aft to the bulkhead; every line of
    // sight through the glass leaves the fuselage, so the nose is lined too.
    const nx = 150, na = 240, x0 = -0.9, x1 = -3.62, dx = (x0 - x1) / nx, da = 2 * Math.PI / na;
    // Vertices within half a cell of a pane's outline move onto it: the openings' edges come out smooth.
    const snap = (x, a) => {
      let best = null, bd = 0.6 * Math.min(dx, da * R);
      for (const P of polys) for (let i = 0; i < P.length; ++i) {
        const [px, py] = P[i], [qx, qy] = P[(i + 1) % P.length], ex = qx - px, ey = qy - py;
        const t = Math.max(0, Math.min(1, ((x - px) * ex + (a * R - py) * ey) / (ex * ex + ey * ey || 1)));
        const sx = px + t * ex, sy = py + t * ey, d = Math.hypot(x - sx, a * R - sy);
        if (d < bd) { bd = d; best = [sx, sy / R]; }
      }
      return best || [x, a];
    };
    // Two-tone: the trim's light grey above the window line, a darker wainscot below it.
    const pos = [], idx = [], col = [], hi = new THREE.Color('#aaa49b'), lo = new THREE.Color('#5a5751'), cc = new THREE.Color();
    for (let i = 0; i <= nx; ++i)
      for (let j = 0; j <= na; ++j) {
        const [x, a] = snap(x0 + (x1 - x0) * i / nx, j * da);
        const p = skin(x, a, -0.045);
        pos.push(p.x, p.y, p.z);
        cc.copy(lo).lerp(hi, Math.min(1, Math.max(0, (p.z - 0.08) / 0.06)));
        col.push(cc.r, cc.g, cc.b);
      }
    for (let i = 0; i < nx; ++i)
      for (let j = 0; j < na; ++j) {
        const xm = x0 + (x1 - x0) * (i + 0.5) / nx, am = (j + 0.5) * da;
        if (inside(xm, am)) continue;
        const k = i * (na + 1) + j;
        idx.push(k, k + 1, k + na + 1, k + 1, k + na + 2, k + na + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const lm = M.liningD.clone(); lm.vertexColors = true; lm.color.set('#ffffff');
    const m = new THREE.Mesh(g, lm); m.receiveShadow = true; root.add(m);
    // The bulkhead behind the seats, a doorway to the cabin in it (a curtain drawn).
    const ring = new THREE.Shape();
    for (let k = 0; k <= 48; ++k) { const p = skin(-3.6, k / 48 * 2 * Math.PI, -0.04); if (k) ring.lineTo(p.y, p.z); else ring.moveTo(p.y, p.z); }
    const door = new THREE.Path(); door.moveTo(-0.27, -0.72); door.lineTo(0.27, -0.72); door.lineTo(0.27, 0.5); door.absarc(0, 0.5, 0.27, 0, Math.PI, false); door.lineTo(-0.27, -0.72);
    ring.holes.push(door);
    const bh = add(new THREE.ShapeGeometry(ring, 24), M.liningD, -3.6, 0, 0);
    bh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));
    const cur = box(0.02, 0.6, 1.5, std('#3d3f45', 1), -3.72, 0, -0.06); void cur;
  }
  // The floor, flat where it meets the walls' curve.
  box(2.4, 1.12, 0.03, M.carpet, -2.4, 0, -0.62);
  // The footwell's forward wall under the panel, the pedals before it.
  box(0.03, 1.3, 0.4, M.panel, -1.45, 0, -0.55);

  // ---- Panel: one live texture, the displays and placards; its frame ----
  const W = mobile ? 1280 : 2048, H = Math.round(W * PH / PW);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.5 }));
  face.position.copy(onPanel(PW / 2, PH / 2));
  face.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(Math.sin(LEAN), 0, Math.cos(LEAN)), new THREE.Vector3(-Math.cos(LEAN), 0, Math.sin(LEAN))));
  face.receiveShadow = true; root.add(face);
  {
    // The panel's body behind its face, and the knee cut-outs under it.
    const back = box(0.12, PW + 0.04, PH + 0.03, M.panel, 0, 0, 0);
    back.position.copy(onPanel(PW / 2, PH / 2, -0.065)); back.rotation.y = LEAN;
    // Glareshield: a hood over the displays sloping down toward the
    // windshield (under the line over the nose), with a padded lip. Its
    // profile in (x forward, z up), extruded across the deck.
    const sh = new THREE.Shape();
    sh.moveTo(PXT - 0.03, PTOP - 0.03); sh.lineTo(PXT - 0.03, PTOP + 0.035); sh.lineTo(PXT + 0.6, PTOP - 0.075); sh.lineTo(PXT + 0.6, PTOP - 0.12); sh.lineTo(PXT - 0.03, PTOP - 0.03);
    const hood = new THREE.ExtrudeGeometry(sh, { depth: PW + 0.08, bevelEnabled: false });
    hood.translate(0, 0, -(PW + 0.08) / 2);
    const gs = add(hood, M.dark, 0, 0, 0); gs.rotation.x = Math.PI / 2;  // (shape y up, the extrusion across)
    rod(0.026, PW + 0.08, M.black, PXT - 0.035, 0, PTOP + 0.01, root, 'y');
    // The flight-guidance strip on the glareshield, centred: dark, a lit mode row.
    const fg = box(0.12, 0.5, 0.025, M.black, PXT + 0.03, 0, PTOP + 0.03); fg.rotation.y = 10 * DEG;
    const lit = box(0.03, 0.42, 0.004, std('#3fd6e6', 0.4), PXT + 0.0, 0, PTOP + 0.045); lit.material.emissive = new THREE.Color('#103a40'); lit.rotation.y = 10 * DEG;
    // Master warning / caution lamps in front of each pilot.
    for (const y of [0.5, -0.5]) {
      const w = box(0.03, 0.045, 0.02, std('#4a1210', 0.4), PXT + 0.01, y + 0.028, PTOP + 0.035);
      const c = box(0.03, 0.045, 0.02, std('#4a3810', 0.4), PXT + 0.01, y - 0.028, PTOP + 0.035);
      lamps.push({ w, c });
    }
    // The lower panel either side of the pedestal, round the knees.
    box(0.06, 0.4, 0.22, M.panel, PX + 0.02, 0.4, PZ0 - 0.1);
    box(0.06, 0.4, 0.22, M.panel, PX + 0.02, -0.4, PZ0 - 0.1);
  }
  // ---- Pedestal: power, propeller and condition levers, flap lever, trim ----
  const pedX0 = PX - 0.05, pedX1 = -2.78, pedTop = -0.3;
  box(pedX0 - pedX1, 0.3, 0.42, M.dark, (pedX0 + pedX1) / 2, 0, -0.53);
  const quad = box(0.5, 0.3, 0.04, M.panel, -2.25, 0, pedTop); quad.rotation.y = -6 * DEG;
  // Slots for the levers.
  for (const y of [0.1, 0.065, 0.02, -0.015, -0.06, -0.095]) box(0.36, 0.008, 0.005, M.black, -2.24, y, pedTop + 0.022);
  const lever = (y, knob) => {
    const g = new THREE.Group(); g.position.set(-2.24, y, pedTop + 0.02); root.add(g);
    box(0.012, 0.008, 0.2, M.chrome, 0, 0, 0.1, g);
    knob(g);
    grab(0.07, 0.03, 0.26, 0, 0, 0.12, g);  // (narrower than the levers' spacing)
    return g;
  };
  // Power levers: wide black T-handles, inboard of each other's shoulder.
  const throttles = [0.1, 0.065].map((y, i) => lever(y, (g) => { box(0.035, 0.05, 0.03, M.black, 0, i ? -0.012 : 0.012, 0.21, g); }));
  // Propeller levers: blue, ridged.
  const props = [0.02, -0.015].map((y) => lever(y, (g) => { const k = rod(0.017, 0.03, M.blue, 0, 0, 0.21, g, 'y'); for (const dz of [-0.008, 0, 0.008]) box(0.036, 0.032, 0.003, M.blue, 0, 0, 0.21 + dz, g); void k; }));
  // Condition levers: red, with a gate to pull through.
  const conds = [-0.06, -0.095].map((y) => lever(y, (g) => { box(0.03, 0.026, 0.026, M.red, 0, 0, 0.21, g); }));
  const conditions = conds.map((g, i) => ({ g, id: `engine${i + 1}.condition` }));
  // The flap lever on the right of the quadrant: a little airfoil.
  const flap = new THREE.Group(); flap.position.set(-2.42, -0.135, pedTop + 0.02); root.add(flap);
  box(0.012, 0.008, 0.13, M.chrome, 0, 0, 0.065, flap);
  const fk = box(0.05, 0.02, 0.014, M.white, 0, 0, 0.135, flap); fk.rotation.y = 8 * DEG;
  grab(0.07, 0.04, 0.17, 0, 0, 0.08, flap);
  // Elevator trim wheel on the pedestal's left side; rudder trim knob aft.
  const trim = rod(0.09, 0.025, M.black, -2.55, 0.16, -0.48, root, 'y'); void trim;
  const rt = rod(0.025, 0.02, M.grey, -2.68, 0, pedTop - 0.06, root, 'z'); void rt;
  // ---- The gear handle, on the subpanel right of the pilot's knees ----
  const gearH = new THREE.Group(); gearH.position.copy(onPanel(PW / 2 - 0.1, PH - 0.12, 0)); root.add(gearH);
  rod(0.007, 0.08, M.chrome, -0.04, 0, 0, gearH);
  const wheel = rod(0.028, 0.016, M.white, -0.085, 0, 0, gearH); void wheel;
  grab(0.12, 0.08, 0.08, -0.06, 0, 0, gearH);
  // ---- Switches: two rows on the left subpanel, under the pilot's display ----
  const switches = [];
  const list = [...SUBPANEL.filter(([id]) => !ids.length || ids.includes(id)),
    ...ids.filter((id) => id.startsWith('anti_ice.')).map((id) => [id, `${id.split('.')[1].toUpperCase()} ICE`])];
  list.forEach(([id, label], k) => {
    const row = k < 9 ? 0 : 1, col = row ? k - 9 : k;
    const g = new THREE.Group(); g.position.copy(onPanel(0.04 + col * 0.045, PH - 0.11 + row * 0.07, 0.004)); root.add(g);
    box(0.012, 0.009, 0.026, M.chrome, -0.006, 0, 0.008, g);
    box(0.016, 0.014, 0.012, M.white, -0.013, 0, 0.022, g);
    grab(0.04, 0.035, 0.05, -0.01, 0, 0.01, g);
    switches.push({ g, id, label });
  });
  // The parking brake: a T-handle under the left subpanel.
  const park = new THREE.Group(); park.position.set(PX - 0.02, 0.5, PZ0 - 0.04); root.add(park);
  rod(0.006, 0.07, M.chrome, -0.035, 0, 0, park); box(0.018, 0.07, 0.018, M.red, -0.07, 0, 0, park);
  grab(0.1, 0.09, 0.05, -0.05, 0, 0, park);
  // The flight-guidance knobs: heading and the barometric setting.
  const knobOn = (y) => rod(0.014, 0.02, M.chrome, PXT - 0.04, y, PTOP + 0.04, root, 'x');
  const hdgKnob = knobOn(0.14), baroKnob = knobOn(0.32);

  // ---- Yokes: ram's horns on columns out of the panel; the pedals ----
  const yokes = [];
  for (const y0 of [0.42, -0.42]) {
    const g = new THREE.Group(); g.position.set(-2.2, y0, -0.12); root.add(g);
    rod(0.018, 0.4, M.dark, 0.2, 0, -0.02, g);
    box(0.05, 0.1, 0.06, M.dark, -0.005, 0, -0.02, g);
    box(0.03, 0.28, 0.035, M.dark, -0.015, 0, -0.03, g);
    for (const sd of [1, -1]) {
      const h = box(0.036, 0.036, 0.15, M.leather, -0.02, sd * 0.15, 0.04, g); h.rotation.x = -sd * 16 * DEG;
      box(0.02, 0.03, 0.02, M.black, -0.02, sd * 0.17, 0.115, g);
    }
    yokes.push(g);
  }
  const pedals = [];
  for (const y0 of [0.42, -0.42]) for (const sd of [1, -1]) {
    const g = new THREE.Group(); g.position.set(-1.72, y0 + sd * 0.09, -0.58); root.add(g);
    const p = box(0.022, 0.08, 0.16, M.black, 0, 0, 0.08, g); p.rotation.y = -30 * DEG;
    pedals.push({ g, side: sd });
  }

  // ---- Seats, armrests, side ledges, the small overhead ----
  for (const y of [0.42, -0.42]) {
    box(0.5, 0.5, 0.12, M.leather, -2.66, y, -0.43);
    box(0.4, 0.36, 0.14, M.dark, -2.68, y, -0.55);
    const backr = box(0.13, 0.5, 0.78, M.leather, -2.98, y, -0.03); backr.rotation.y = -12 * DEG;
    const head = box(0.11, 0.26, 0.2, M.leather, -3.06, y, 0.47); head.rotation.y = -12 * DEG;
    for (const sd of [1, -1]) box(0.36, 0.05, 0.06, M.leather, -2.72, y + sd * 0.27, -0.24);
    // The side console along the wall: a dark ledge with a map pocket under it.
    box(1.0, 0.13, 0.06, M.panel, -2.4, y * 1.55, -0.16);
    box(0.9, 0.04, 0.3, M.liningDark, -2.4, y * 1.6, -0.34);
  }
  const ov = box(0.4, 0.42, 0.05, M.panel, -2.35, 0, 0.78); ov.rotation.y = 12 * DEG;

  // ---- The panel texture: four displays, their bezels, placards, gear lights ----
  function redraw(d) {
    const P = W / PW, X = (m) => m * P;
    const on = d.volts === undefined || d.volts > 18;
    ctx.fillStyle = '#2b2e33'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#25282c'; ctx.fillRect(0, X(0.33), W, H - X(0.33));
    // A shadow line under the glareshield.
    const gr = ctx.createLinearGradient(0, 0, 0, X(0.05)); gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, X(0.05));
    const dw = 0.27, dh = 0.21, top = 0.06, xs = [0.035, 0.335, 0.635, 0.935];
    for (const x0 of xs) {
      // Bezels: rounded, with the softkey row under each display.
      ctx.fillStyle = '#121315'; roundRect(ctx, X(x0 - 0.012), X(top - 0.012), X(dw + 0.024), X(dh + 0.04), X(0.012)); ctx.fill();
      ctx.fillStyle = '#3a3d43';
      for (let k = 0; k < 6; ++k) ctx.fillRect(X(x0 + 0.01 + k * 0.044), X(top + dh + 0.008), X(0.03), X(0.012));
    }
    const show = (fn, x0) => { if (on) fn(ctx, X(x0), X(top), X(dw), X(dh), d); else { ctx.fillStyle = '#050607'; ctx.fillRect(X(x0), X(top), X(dw), X(dh)); } };
    show(drawPFD, xs[0]); show(drawND, xs[1]); show(drawEICAS, xs[2]); show(drawPFD, xs[3]);
    // Placards: the type, the switch rows' names.
    txt(ctx, 'KING AIR 350', X(0.62), X(0.345), X(0.014), '#c9ccd1', SANS, 800);
    list.forEach(([, label], k) => {
      const row = k < 9 ? 0 : 1, col = row ? k - 9 : k;
      txt(ctx, label, X(0.04 + col * 0.045), X(PH - 0.11 + row * 0.07 - 0.03), X(0.0065), '#d6d8db', SANS, 700);
    });
    // Gear position lights by the handle (green down, red in transit), the flap indicator.
    const gx = PW / 2 - 0.1, gy = PH - 0.2;
    txt(ctx, 'LANDING GEAR', X(gx), X(gy - 0.03), X(0.007), '#c9ccd1', SANS, 700);
    for (const [k, dxm] of [[0, -0.025], [1, 0], [2, 0.025]]) {
      const down = d.gear > 0.999, up = d.gear < 0.001, c = !on ? '#202225' : down ? C.green : up ? '#202225' : C.red;
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(X(gx + dxm), X(gy - (k === 1 ? 0.012 : 0)), X(0.008), 0, 2 * Math.PI); ctx.fill();
    }
    txt(ctx, `FLAPS ${Math.round(d.flaps)}°`, X(gx + 0.13), X(gy - 0.012), X(0.009), on ? C.white : '#55595f', MONO, 700);
    // Master warning / caution (the lamps on the glareshield too).
    const cas = on ? casMessages(d) : [], warn = cas.some((m) => m[1] === 3), caut = cas.some((m) => m[1] === 2);
    const flash = (performance.now() % 1000) < 600;
    for (const l of lamps) {
      l.w.material.emissive.set(warn && flash ? '#ff2a1a' : '#000000');
      l.c.material.emissive.set(caut ? '#f2a31a' : '#000000');
    }
    tex.needsUpdate = true;
  }

  function update(st) {
    for (const g of yokes) { g.position.x = -2.2 - st.elev * 0.07; g.rotation.x = st.ail * 0.8; }
    for (const p of pedals) p.g.position.x = -1.72 + (p.side < 0 ? 1 : -1) * st.rud * 0.05;
    // The power levers each on its engine; the propeller levers together (back past the detent: feathered).
    throttles.forEach((t, i) => { t.rotation.y = ((st.levers?.[i] ?? st.thr) - 0.4) * 50 * DEG; });
    const pos = st.pos || {};
    props.forEach((t, i) => { t.rotation.y = (pos[`engine${i + 1}.feather`] ? -32 : ((st.prop ?? 1) - 0.4) * 50) * DEG; });
    conds.forEach((t, i) => { t.rotation.y = ([-28, 0, 22][pos[`engine${i + 1}.condition`] ?? 1]) * DEG; });
    flap.rotation.y = -Math.min(st.flapLever / 2, 1) * 40 * DEG;
    gearH.position.z = onPanel(0, PH - 0.12).z + (st.gearDown ? -0.03 : 0.03);
    for (const w of switches) w.g.rotation.y = (pos[w.id] ? -1 : 1) * 25 * DEG;
    park.position.x = PX - 0.02 - (pos['brakes.parking'] ? 0.05 : 0);
  }
  root.visible = false;
  const parts = { throttles, props, conditions, flap, gear: gearH, switches, park, hdgKnob, baroKnob };
  return { root, update, redraw, parts };
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function txt(ctx, s, x, y, size, color, font, weight) {
  ctx.font = `${weight} ${size}px ${font}`; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y);
}
