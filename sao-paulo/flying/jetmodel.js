// São Paulo World · flight test bed: the Top G, a low-poly twin-jet built from
// the aircraft definition the physics flies (top_g.json: swept wing panels,
// T-tail, engine positions, gear attach points and control-surface spans).
// No third-party model.
//
// Body FLU (x forward, y left, z up), metres from the structural datum = the
// nose tip; the definition's structural frame is x forward, y right, z down.
import * as THREE from 'three';
import { flu, panelGeometry, loft, cylinderBetween } from './model.js';

const DEG = Math.PI / 180;

// Fuselage stations [x, half-width, z top, z bottom] (FLU).
const STATIONS = [
  [0.0, 0.04, 0.02, -0.12], [-0.35, 0.42, 0.22, -0.5], [-1.0, 0.82, 0.55, -0.88], [-1.9, 1.08, 0.88, -1.12],
  [-3.0, 1.26, 1.2, -1.26], [-4.4, 1.32, 1.32, -1.3], [-19.5, 1.32, 1.32, -1.3], [-21.8, 1.22, 1.3, -1.02],
  [-24.2, 1.0, 1.24, -0.5], [-26.6, 0.72, 1.14, 0.06], [-28.9, 0.4, 0.98, 0.45], [-30.41, 0.1, 0.76, 0.62],
];
const SUPER = 2.1;

// Fuselage skin point at station x and angle a (0 = left side, 90 deg = top),
// pushed `off` metres outward.
// The stations in use: the Top G's, or a generated type's (visual block).
let ST = STATIONS;
export function skin(x, a, off = 0) { return skinOf(ST, x, a, off); }
function skinOf(st, x, a, off = 0) {
  let i = 0;
  while (i < st.length - 2 && x < st[i + 1][0]) ++i;
  const [x0, w0, t0, b0] = st[i], [x1, w1, t1, b1] = st[i + 1];
  const u = Math.min(Math.max((x - x0) / (x1 - x0), 0), 1);
  const hw = w0 + (w1 - w0) * u, zt = t0 + (t1 - t0) * u, zb = b0 + (b1 - b0) * u;
  const zc = (zt + zb) / 2, hh = (zt - zb) / 2;
  const c = Math.cos(a), s = Math.sin(a);
  const sx = Math.sign(c) * Math.abs(c) ** (2 / SUPER), sz = Math.sign(s) * Math.abs(s) ** (2 / SUPER);
  const p = new THREE.Vector3(x, hw * sx, zc + hh * sz);
  if (off) {
    const n = new THREE.Vector3(0, p.y / Math.max(hw, 0.01), (p.z - zc) / Math.max(hh, 0.01)).normalize();
    p.addScaledVector(n, off);
  }
  return p;
}

// A patch of skin over (x, a) parameters: fn(u, v) -> [x, a].
function skinPatch(fn, nu, nv, off) {
  const pos = [], idx = [];
  for (let i = 0; i <= nu; ++i)
    for (let j = 0; j <= nv; ++j) {
      const [x, a] = fn(i / nu, j / nv);
      const p = skin(x, a, off);
      pos.push(p.x, p.y, p.z);
    }
  for (let i = 0; i < nu; ++i)
    for (let j = 0; j < nv; ++j) {
      const k = i * (nv + 1) + j;
      idx.push(k, k + nv + 1, k + 1, k + 1, k + nv + 1, k + nv + 2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function textTexture(text, w, h, font, color, bg) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  g.fillStyle = color; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export function buildJet(def) {
  // A generated type carries its shape and livery in def.visual (Aviation-
  // Dynamics tools/jetgen); the Top G's are the defaults.
  const vis = def.visual || {};
  const st = vis.fuselage_stations || STATIONS;
  ST = st;
  const ns = vis.nose_scale || 1;                       // the nose (windshield, cockpit) scales with the diameter
  const Lf = -st[st.length - 1][0], Rf = Math.max(...st.map((q) => q[1]));
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xf4f5f3, roughness: 0.32, metalness: 0.15 });
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xd9dcde, roughness: 0.42, metalness: 0.35 });
  const navy = new THREE.MeshStandardMaterial({ color: vis.colors?.primary || 0x0b2f6e, roughness: 0.38, metalness: 0.2 });
  const red = new THREE.MeshStandardMaterial({ color: vis.colors?.accent || 0xd22a1f, roughness: 0.45 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0e1822, roughness: 0.08, metalness: 0.8, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1f23, roughness: 0.7, metalness: 0.3 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.9 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95 });
  const add = (m, parent = root) => { m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };

  // ---- Fuselage, windshield, windows, livery ----
  add(new THREE.Mesh(loft(st, 40, SUPER), paint));
  // Four-pane windshield (front panes reach further forward at the top centre).
  add(new THREE.Mesh(skinPatch((u, v) => {
    const a = (20 + v * 140) * DEG, sa = Math.sin(a);
    const x0 = (-1.98 - 0.45 * (1 - sa)) * ns, x1 = (-2.98 - 0.25 * (1 - sa)) * ns;
    return [x0 + (x1 - x0) * u, a];
  }, 6, 24, 0.012), glassMat));
  for (const side of [0, 1]) {
    // Cockpit side windows.
    add(new THREE.Mesh(skinPatch((u, v) => [(-3.12 - u * 0.75) * ns, (side ? 180 - 52 : 14) * DEG + v * 38 * DEG], 3, 6, 0.012), glassMat));
    // Cabin windows: the Top G's eight large ovals a side, or the type's own row.
    const W = vis.windows || { count: 8, first: -6.7, pitch: 1.42, half_w: 0.36, half_h: 0.2 * 1.32 };
    for (let i = 0; i < W.count; ++i) {
      const xc = W.first - i * W.pitch, ac = side ? Math.PI - 0.12 : 0.12;
      const shape = [];
      for (let k = 0; k <= 24; ++k) {
        const t = (k / 24) * 2 * Math.PI;
        shape.push([xc + Math.cos(t) * W.half_w, ac + Math.sin(t) * W.half_h / Rf]);
      }
      const pos = [], idx = [];
      const centre = skin(xc, ac, 0.012); pos.push(centre.x, centre.y, centre.z);
      for (const [x, a] of shape) { const p = skin(x, a, 0.012); pos.push(p.x, p.y, p.z); }
      for (let k = 1; k <= 24; ++k) idx.push(0, k, k + 1, 0, k + 1, k);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      add(new THREE.Mesh(g, glassMat));
    }
    // Cheat line: navy band under the windows with a red pinstripe.
    const s0 = side ? Math.PI + 0.06 : -0.06;
    const dir = side ? 1 : -1;
    const cl = 0.78 * Lf - 3.4 * ns;  // the cheat line's length
    add(new THREE.Mesh(skinPatch((u, v) => [-3.4 * ns - u * cl, s0 + dir * (0.02 + v * 0.12)], 40, 2, 0.008), navy));
    add(new THREE.Mesh(skinPatch((u, v) => [-3.6 * ns - u * (cl - 0.6), s0 + dir * (0.16 + v * 0.025)], 40, 1, 0.009), red));
  }
  // Wing-to-body fairing.
  const fair = add(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), paint));
  {
    const w0 = def.surfaces[0].panels[0], kc = w0.root_chord_m / 6.9;
    fair.scale.set(6.2 * kc, 1.36 * ns, 0.62 * ns); fair.position.set(w0.root_quarter_chord_m[0] - 2.0 * kc, 0, -1.02 * ns);
  }

  // ---- Wing (right panels from the data, mirrored), flaps, ailerons, spoilers, winglets ----
  const wing = def.surfaces[0], wingT = wing.thickness_ratio || 0.11;
  const controls = { flaps: [], ailerons: [], elevator: [], rudder: null, spoilers: [] };
  let tipLe = null, tipChord = 1.6;
  // A steeply canted panel in the data is a winglet (drawn in the livery's navy).
  const isWinglet = (p) => (p.dihedral_deg || 0) > 45;
  const dataWinglets = wing.panels.some(isWinglet);
  for (const p of wing.panels) {
    const qc = flu(p.root_quarter_chord_m);
    const dih = (p.dihedral_deg || 0) * DEG, sw = (p.sweep_deg || 0) * DEG;
    const span = p.span_m, c0 = p.root_chord_m, c1 = p.tip_chord_m;
    for (const side of [1, -1]) {
      const root0 = new THREE.Vector3(qc.x, side === 1 ? qc.y : -qc.y, qc.z);
      const tipQc = root0.clone().add(new THREE.Vector3(-span * Math.tan(sw), -side * span, span * Math.tan(dih)));
      const le0 = root0.clone().add(new THREE.Vector3(0.25 * c0, 0, 0));
      const le1 = tipQc.clone().add(new THREE.Vector3(0.25 * c1, 0, 0));
      const up = new THREE.Vector3(0, side * Math.sin(dih), Math.cos(dih));
      add(new THREE.Mesh(panelGeometry(le0, c0 * 0.67, le1, c1 * 0.67, wingT / 0.67, up), isWinglet(p) ? navy : wingMat));
      if (side === 1 && !isWinglet(p)) { tipLe = le1.clone(); tipChord = c1; }
      const lerp = (u, w, t) => u.clone().lerp(w, t);
      for (const ctl of p.controls || []) {
        const f = ctl.chord_fraction || 0.25, a = ctl.span_start ?? 0, b = ctl.span_end ?? 1;
        const cA = c0 + (c1 - c0) * a, cB = c0 + (c1 - c0) * b;
        const leA = lerp(le0, le1, a), leB = lerp(le0, le1, b);
        const hingeA = leA.clone().add(new THREE.Vector3(-cA * (1 - f), 0, 0)), hingeB = leB.clone().add(new THREE.Vector3(-cB * (1 - f), 0, 0));
        const pivot = new THREE.Group(); pivot.position.copy(hingeA);
        const axis = new THREE.Vector3().subVectors(hingeB, hingeA).normalize();
        const mesh = new THREE.Mesh(panelGeometry(new THREE.Vector3(), cA * f, new THREE.Vector3().subVectors(hingeB, hingeA), cB * f, wingT * 0.5 / f, up), wingMat);
        mesh.castShadow = true; pivot.add(mesh); root.add(pivot);
        const entry = { pivot, axis, side, def: ctl };
        if (ctl.channel === 'flap') controls.flaps.push(entry); else if (ctl.channel === 'aileron') controls.ailerons.push(entry);
        // Spoilers ride on the upper surface ahead of the outboard flap.
        if (ctl.channel === 'flap' && a === 0) {
          for (let k = 0; k < 3; ++k) {
            const sa = a + (b - a) * (k / 3), sb = a + (b - a) * ((k + 1) / 3) - 0.01;
            const cs = c0 + (c1 - c0) * sa, ce = c0 + (c1 - c0) * sb;
            const hA = lerp(le0, le1, sa).add(new THREE.Vector3(-cs * 0.5, 0, 0)).addScaledVector(up, wingT * cs * 0.32);
            const hB = lerp(le0, le1, sb).add(new THREE.Vector3(-ce * 0.5, 0, 0)).addScaledVector(up, wingT * ce * 0.32);
            const sp = new THREE.Group(); sp.position.copy(hA);
            const m = new THREE.Mesh(panelGeometry(new THREE.Vector3(), cs * 0.16, new THREE.Vector3().subVectors(hB, hA), ce * 0.16, 0.06, up), wingMat);
            sp.add(m); root.add(sp);
            controls.spoilers.push({ pivot: sp, axis: new THREE.Vector3().subVectors(hB, hA).normalize(), side });
          }
        }
      }
    }
  }
  // Blended winglets, canted outboard (when the data has none of its own).
  for (const y of dataWinglets || vis.winglets === false || def.visual ? [] : [Math.abs(tipLe.y), -Math.abs(tipLe.y)]) {
    const out = Math.sign(y), h = 1.55, cant = 14 * DEG;
    const le = new THREE.Vector3(tipLe.x, y, tipLe.z);
    const le1 = le.clone().add(new THREE.Vector3(-h * Math.tan(38 * DEG), out * h * Math.sin(cant), h * Math.cos(cant)));
    add(new THREE.Mesh(panelGeometry(le, tipChord * 0.95, le1, 0.55, 0.09, new THREE.Vector3(0, out, 0)), navy));
  }

  // ---- T-tail: fin (navy, with the name), horizontal tail and elevator on top ----
  const vt = def.surfaces[2].panels[0];
  {
    const qc = flu(vt.root_quarter_chord_m), c0 = vt.root_chord_m, c1 = vt.tip_chord_m, sweep = (vt.sweep_deg || 0) * DEG;
    const f = vt.controls?.[0]?.chord_fraction || 0.32;
    const le0 = new THREE.Vector3(qc.x + 0.25 * c0, 0, qc.z - 0.3);
    const le1 = new THREE.Vector3(qc.x + 0.25 * c1 - Math.tan(sweep) * vt.span_m, 0, qc.z + vt.span_m);
    const side = new THREE.Vector3(0, 1, 0);
    add(new THREE.Mesh(panelGeometry(le0, c0 * (1 - f), le1, c1 * (1 - f), 0.11 / (1 - f), side), navy));
    const hA = le0.clone().add(new THREE.Vector3(-c0 * (1 - f), 0, 0)), hB = le1.clone().add(new THREE.Vector3(-c1 * (1 - f), 0, 0));
    const pivot = new THREE.Group(); pivot.position.copy(hA);
    const mesh = new THREE.Mesh(panelGeometry(new THREE.Vector3(), c0 * f, new THREE.Vector3().subVectors(hB, hA), c1 * f, 0.06 / f, side), navy);
    mesh.castShadow = true; pivot.add(mesh); root.add(pivot);
    controls.rudder = { pivot, axis: new THREE.Vector3().subVectors(hB, hA).normalize(), def: vt.controls?.[0] };
    // "TOP G" on both sides of the fin.
    const name = vis.short_name || 'TOP G', kf = c0 / 5.4;
    const tex = textTexture(name, 512 * Math.max(1, name.length / 5), 192, `italic 900 ${name.length > 6 ? 110 : 150}px "Big Shoulders Display", Impact, sans-serif`, '#ffffff');
    const mid = le0.clone().lerp(le1, 0.42).add(new THREE.Vector3(-c0 * 0.36, 0, 0));
    for (const out of [1, -1]) {
      // Text runs aft on the left side and forward on the right, reading upright from outside.
      const d = new THREE.Mesh(new THREE.PlaneGeometry(3.0 * kf * Math.max(1, name.length / 5) * 0.8, 1.1 * kf), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.4 }));
      d.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        new THREE.Vector3(-out, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, out, 0)));
      d.position.copy(mid).add(new THREE.Vector3(0, out * 0.27 * kf, 0));
      root.add(d);
    }
  }
  const ht = def.surfaces[1];
  for (const p of ht.panels) {
    const qc = flu(p.root_quarter_chord_m), c0 = p.root_chord_m, c1 = p.tip_chord_m;
    const sw = (p.sweep_deg || 0) * DEG, dih = (p.dihedral_deg || 0) * DEG;
    const f = p.controls?.[0]?.chord_fraction || 0.3;
    for (const side of [1, -1]) {
      const le0 = new THREE.Vector3(qc.x + 0.25 * c0, 0, qc.z);
      const le1 = new THREE.Vector3(qc.x - p.span_m * Math.tan(sw) + 0.25 * c1, -side * p.span_m, qc.z + p.span_m * Math.tan(dih));
      const up = new THREE.Vector3(0, 0, 1);
      add(new THREE.Mesh(panelGeometry(le0, c0 * (1 - f), le1, c1 * (1 - f), 0.1 / (1 - f), up), wingMat));
      const hA = le0.clone().add(new THREE.Vector3(-c0 * (1 - f), 0, 0)), hB = le1.clone().add(new THREE.Vector3(-c1 * (1 - f), 0, 0));
      const pivot = new THREE.Group(); pivot.position.copy(hA);
      const mesh = new THREE.Mesh(panelGeometry(new THREE.Vector3(), c0 * f, new THREE.Vector3().subVectors(hB, hA), c1 * f, 0.06 / f, up), wingMat);
      mesh.castShadow = true; pivot.add(mesh); root.add(pivot);
      controls.elevator.push({ pivot, axis: new THREE.Vector3().subVectors(hB, hA).normalize(), side, def: p.controls?.[0] });
    }
  }

  // ---- Engines: long-cowl turbofans on swept aft-fuselage pylons ----
  // Each nacelle is lathed from a profile along its axis (local x, 0 at the
  // inlet lip, negative aft): a rounded lip, the fan cowl swelling to its
  // widest a third of the way back and closing to the fan nozzle; behind it
  // the core cowl, its nozzle and a pointed exhaust plug. The fan cowl's aft
  // part is the thrust reverser's translating sleeve: deployed, it slides aft
  // and uncovers the cascades (where the fan flow leaves, turned forward).
  const fans = [], sleeves = [];
  const nacelleMat = paint.clone(); nacelleMat.side = THREE.DoubleSide;
  const inner = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.6, metalness: 0.5, side: THREE.BackSide });
  const coreMat = new THREE.MeshStandardMaterial({ color: 0xb7bcc2, roughness: 0.45, metalness: 0.7 });
  const cascadeTex = (() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 16;
    const g = c.getContext('2d'); g.fillStyle = '#16191c'; g.fillRect(0, 0, 64, 16);
    g.fillStyle = '#5a6066'; for (let i = 0; i < 64; i += 4) g.fillRect(i, 0, 1, 16); for (let j = 0; j < 16; j += 4) g.fillRect(0, j, 64, 1);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(12, 2); return t;
  })();
  const cascadeMat = new THREE.MeshStandardMaterial({ map: cascadeTex, roughness: 0.8, metalness: 0.4, side: THREE.DoubleSide });
  const lathe = (pts, mat, segs = 40) => {
    const m = new THREE.Mesh(new THREE.LatheGeometry(pts.map(([r, x]) => new THREE.Vector2(r, x)), segs), mat);
    m.rotation.z = -Math.PI / 2;  // lathe axis (y) -> local x
    return m;
  };
  for (const e of def.turbofans || []) {
    const noz = flu(e.position_m), rev = e.thrust_reverser;
    // The Top G's nacelle, scaled to the type's (the lathe profiles are in its metres).
    const L = 4.1, Rmax = 0.8, k = vis.nacelle ? vis.nacelle.radius / 0.79 : 1;
    const nac = new THREE.Group(); nac.position.set(noz.x + L * k, noz.y, noz.z); nac.scale.setScalar(k); root.add(nac);
    // Fan cowl, lip to the cascades (fixed) and the sleeve (moves).
    const xc = rev ? -(L - rev.cascade_forward_of_nozzle_m / k) : -2.6;  // cascade station (local x)
    const cowl = (x) => {  // outer radius along the cowl
      const u = Math.min(Math.max(-x / L, 0), 1);
      if (u < 0.33) return 0.69 + (Rmax - 0.69) * Math.sin(u / 0.33 * Math.PI / 2);
      return Rmax - (Rmax - 0.6) * ((u - 0.33) / 0.67) ** 1.6;
    };
    // Inner duct wall to the rounded lip (a half circle) and on along the cowl.
    const fwd = [[0.59, -0.3]];
    for (let k = 0; k <= 8; ++k) { const a = Math.PI * (1 - k / 8); fwd.push([0.64 + 0.05 * Math.cos(a), -0.05 + 0.05 * Math.sin(a)]); }
    for (let k = 1; k <= 12; ++k) { const x = -0.05 + (xc + 0.05) * k / 12; fwd.push([cowl(x), x]); }
    add(lathe(fwd, nacelleMat), nac);
    // Inlet duct (seen from the front) and the fan.
    add(lathe([[0.59, -0.05], [0.585, -0.3], [0.57, -0.6]], inner), nac);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.57, 40), dark);
    face.rotation.y = Math.PI / 2; face.position.x = -0.62; nac.add(face);
    const fan = new THREE.Group(); fan.position.x = -0.55; nac.add(fan);
    const bladeShape = new THREE.Shape(); bladeShape.moveTo(0, 0.13); bladeShape.lineTo(0.03, 0.55); bladeShape.lineTo(-0.1, 0.56); bladeShape.lineTo(-0.06, 0.13);
    const bladeGeo = new THREE.ShapeGeometry(bladeShape);
    for (let k = 0; k < 22; ++k) {
      const b = new THREE.Mesh(bladeGeo, metal);
      const holder = new THREE.Group(); holder.rotation.x = k / 22 * 2 * Math.PI; fan.add(holder);
      b.rotation.y = Math.PI / 2; b.rotation.z = 0; b.rotation.x = 0.6; holder.add(b);  // wide chord, twisted
    }
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.36, 24), paint);
    spinner.rotation.z = Math.PI / 2; spinner.position.x = -0.42; nac.add(spinner);
    // Cascades: a dark grid band under the sleeve, uncovered when deployed.
    const casc = add(lathe([[cowl(xc) - 0.04, xc + 0.02], [cowl(xc - 0.5) - 0.04, xc - 0.5]], cascadeMat), nac);
    casc.visible = !!rev;
    // Translating sleeve: the cowl from the cascades to the fan nozzle.
    const sleeve = new THREE.Group(); nac.add(sleeve);
    const aft = [];
    for (let k = 0; k <= 10; ++k) { const x = xc + (-L * 0.8 - xc) * k / 10; aft.push([cowl(x), x]); }
    aft.push([0.58, -L * 0.8 - 0.02]);
    add(lathe(aft, nacelleMat), sleeve);
    add(lathe([[0.58, -L * 0.8 - 0.01], [0.56, xc - 0.1]], inner), sleeve);  // bypass duct wall
    sleeves.push({ sleeve, travel: rev ? 0.5 : 0 });
    // Core cowl, core nozzle and the exhaust plug (aft of the fan nozzle).
    add(lathe([[0.44, -L * 0.62], [0.46, -L * 0.8], [0.4, -L - 0.25], [0.34, -L - 0.45]], coreMat), nac);
    add(lathe([[0.33, -L - 0.45], [0.32, -L - 0.2]], inner), nac);
    add(lathe([[0.001, -L - 1.05], [0.12, -L - 0.75], [0.22, -L - 0.4], [0.24, -L - 0.2]], dark), nac);
    const side = Math.sign(noz.y);
    if (vis.nacelle?.mount === 'wing') {
      // Pylon: a thin vertical blade from the nacelle's top up into the wing.
      const wr = def.surfaces[0].panels[0], zWing = -wr.root_quarter_chord_m[2] + Math.abs(noz.y) * Math.tan(3 * DEG) - 0.12;
      const le0 = new THREE.Vector3(noz.x + L * k - 0.7 * k, noz.y, noz.z + 0.62 * k), le1 = new THREE.Vector3(noz.x + L * k - 0.9 * k, noz.y, zWing);
      add(new THREE.Mesh(panelGeometry(le0, 3.0 * k, le1, 3.4 * k, 0.07, new THREE.Vector3(0, 1, 0)), paint));
    } else {
      // Pylon: a swept, thin wing from the fuselage to the nacelle's inboard side.
      const rootLe = new THREE.Vector3(noz.x + L * k - 0.9 * k, side * 0.8 * Rf, noz.z + 0.12 * k), tipLe2 = new THREE.Vector3(noz.x + L * k - 1.25 * k, side * (Math.abs(noz.y) - 0.62 * k), noz.z + 0.05 * k);
      add(new THREE.Mesh(panelGeometry(rootLe, 2.9 * k, tipLe2, 2.4 * k, 0.09 * k, new THREE.Vector3(0, 0, 1)), paint));
    }
    fans.push(fan);
  }

  // ---- Retractable landing gear ----
  const gears = [];
  for (const g of def.gear) {
    const a = flu(g.attach_m), nose = /nose/.test(g.name);
    const pivot = new THREE.Group(); pivot.position.copy(a); root.add(pivot);
    const len = g.length_m - g.wheel_radius_m * 0.3, r = g.wheel_radius_m;
    add(cylinderBetween(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -len), nose ? 0.07 : 0.11, metal), pivot);
    add(cylinderBetween(new THREE.Vector3(0, 0, -len * 0.25), new THREE.Vector3(nose ? 0.35 : -0.4, 0, -len * 0.62), 0.04, metal), pivot);
    for (const o of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, nose ? 0.2 : 0.26, 20), tyre);
      w.position.set(0, o * (nose ? 0.15 : 0.2), -len);
      add(w, pivot);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, nose ? 0.21 : 0.27, 12), metal);
      hub.position.copy(w.position); pivot.add(hub);
    }
    gears.push({ pivot, nose, side: Math.sign(a.y) });
  }

  // ---- Lights ----
  const lamp = (color, p, size = 0.09) => { const m = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), new THREE.MeshBasicMaterial({ color })); m.position.copy(p); root.add(m); return m; };
  const tipL = new THREE.Vector3(tipLe.x - tipChord * 0.4, Math.abs(tipLe.y) + 0.05, tipLe.z + 0.05);
  lamp(0xff2a2a, tipL); lamp(0x2aff5a, new THREE.Vector3(tipL.x, -tipL.y, tipL.z));
  lamp(0xffffff, new THREE.Vector3(-Lf - 0.04, 0, st[st.length - 1][2]));
  const beacons = [lamp(0xff1a1a, skin(-0.4 * Lf, Math.PI / 2, 0.06), 0.12), lamp(0xff1a1a, skin(-0.41 * Lf, -Math.PI / 2, 0.06), 0.12)];
  const strobes = [lamp(0xffffff, tipL.clone().add(new THREE.Vector3(-0.2, 0, 0)), 0.11), lamp(0xffffff, new THREE.Vector3(tipL.x - 0.2, -tipL.y, tipL.z), 0.11)];

  let fanAngle = 0, clockT = 0;
  // st: flapDeg, aileron, elevator, rudder (-1..1), n1 [%...], gear 0..1, speedbrake 0..1, lights bool,
  // reverser [0..1 per engine], slow (slow-motion factor)
  function update(st, dt) {
    clockT += dt;
    for (const f of controls.flaps) f.pivot.quaternion.setFromAxisAngle(f.axis, f.side * st.flapDeg * DEG);
    for (const a of controls.ailerons) {
      const upMax = a.def.max_negative_deg || 20, down = a.def.max_positive_deg || 15;
      const v = st.aileron * a.side;
      const deg = v > 0 ? -v * upMax : -v * down;
      a.pivot.quaternion.setFromAxisAngle(a.axis, a.side * deg * DEG);
    }
    for (const e of controls.elevator) {
      const upMax = e.def?.max_negative_deg || 30, down = e.def?.max_positive_deg || 20;
      const deg = st.elevator > 0 ? -st.elevator * upMax : -st.elevator * down;
      e.pivot.quaternion.setFromAxisAngle(e.axis, e.side * deg * DEG);
    }
    if (controls.rudder) controls.rudder.pivot.quaternion.setFromAxisAngle(controls.rudder.axis, -st.rudder * (controls.rudder.def?.max_positive_deg || 25) * DEG);
    // Spoilers: speedbrake symmetric, plus roll assistance on the up-going aileron side.
    for (const sp of controls.spoilers) {
      const roll = Math.max(0, -st.aileron * sp.side) * 0.35;
      sp.pivot.quaternion.setFromAxisAngle(sp.axis, -sp.side * Math.min(1, st.speedbrake + roll) * 45 * DEG);
    }
    const n1 = st.n1 || [];
    // Fan: about 8,000 rpm at 100 % N1. Real time shows a slowed, wheel-like
    // spin; in slow motion (st.slow) the true rate once the eye can follow it.
    const fanRate = (n1[0] || 0) / 100 * 838;
    fanAngle += Math.min(fanRate, (n1[0] || 0) / 100 * 40 * (st.slow || 1)) * dt;
    const rv = st.reverser || [];
    sleeves.forEach((s, i) => { s.sleeve.position.x = -s.travel * (rv[i] || 0); });
    fans.forEach((f, i) => { f.rotation.x = fanAngle * ((n1[i] || 0) / Math.max(n1[0] || 1, 1)); });
    for (const g of gears) {
      const up = 1 - st.gear;
      if (g.nose) g.pivot.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -up * 96 * DEG);
      else g.pivot.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -g.side * up * 86 * DEG);
      g.pivot.visible = st.gear > 0.03;
    }
    const lit = st.lights !== false;
    const flash = (period, on) => lit && (clockT % period) < on;
    beacons.forEach((b) => { b.visible = flash(1.1, 0.12); });
    strobes.forEach((b) => { b.visible = flash(1.3, 0.06) || (lit && (clockT % 1.3) > 0.16 && (clockT % 1.3) < 0.2); });
  }
  // The cabin lining follows this type's skin.
  const own = (x, a, off = 0) => skinOf(st, x, a, off);
  return { root, update, glass: glassMat, skin: own };
}
