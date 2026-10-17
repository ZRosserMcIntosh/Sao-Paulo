// São Paulo World · flight test bed: a low-poly 172 built from the
// aircraft definition the physics flies (wing panels, tail, gear, propeller and
// control-surface spans from 172.json), so what you see is the geometry
// the strips, gear and hard points use. No third-party model.
//
// Geometry is built in body FLU (x forward, y left, z up, metres from the
// structural datum = the firewall). The definition's structural frame is
// x forward, y right, z down: FLU = (x, -y, -z).
import * as THREE from 'three';

const DEG = Math.PI / 180;
export const flu = ([x, y, z]) => new THREE.Vector3(x, -y, -z);

// Simple cambered section (fraction of chord from the leading edge, upper
// first then lower), scaled by chord and thickness ratio.
export function sectionPoints(chord, t) {
  const xs = [0, 0.03, 0.1, 0.25, 0.45, 0.7, 1.0];
  const up = xs.map((u) => [u, (t * 5 * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4) + 0.03 * Math.sin(Math.PI * u)) * chord]);
  const lo = xs.slice(1, -1).reverse().map((u) => [u, (-t * 5 * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4) + 0.03 * Math.sin(Math.PI * u)) * chord]);
  return up.map(([u, z]) => [u * chord, z]).concat(lo.map(([u, z]) => [u * chord, z]));
}

// A tapered panel between two sections. `le0`/`le1`: leading-edge points (FLU);
// chords along -x; `up`: the section's thickness direction (unit, FLU).
export function panelGeometry(le0, c0, le1, c1, t, up) {
  const s0 = sectionPoints(c0, t), s1 = sectionPoints(c1, t), n = s0.length;
  const pos = [], idx = [];
  const put = (le, s) => { for (const [u, z] of s) pos.push(le.x - u, le.y + up.y * z, le.z + up.z * z); };
  put(le0, s0);
  put(le1, s1);
  for (let i = 0; i < n; ++i) {
    const j = (i + 1) % n;
    idx.push(i, j, n + i, j, n + j, n + i);
  }
  // End caps (fan).
  for (let i = 1; i < n - 1; ++i) { idx.push(0, i + 1, i); idx.push(n, n + i, n + i + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Lofted fuselage through rounded-rectangle stations [x, halfWidth, zTop, zBottom];
// `e` is the superellipse exponent (2 = ellipse, higher = boxier).
export function loft(stations, segs = 20, e = 2.6) {
  const pos = [], idx = [];
  for (const [x, hw, zt, zb] of stations) {
    const zc = (zt + zb) / 2, hh = Math.max((zt - zb) / 2, 1e-3);
    for (let k = 0; k < segs; ++k) {
      const a = (k / segs) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
      const sx = Math.sign(c) * Math.abs(c) ** (2 / e), sz = Math.sign(s) * Math.abs(s) ** (2 / e);
      pos.push(x, hw * sx, zc + hh * sz);
    }
  }
  for (let i = 0; i < stations.length - 1; ++i)
    for (let k = 0; k < segs; ++k) {
      const a = i * segs + k, b = i * segs + ((k + 1) % segs), c = a + segs, d = b + segs;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function cylinderBetween(a, b, r, mat) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

export function buildAircraft(def) {
  const root = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xf3f4f1, roughness: 0.45, metalness: 0.1 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x1d57c2, roughness: 0.5, metalness: 0.1 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xec4a3c, roughness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1a2733, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.88 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.8 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.95 });
  const add = (m) => { m.castShadow = true; m.receiveShadow = true; root.add(m); return m; };

  // Fuselage (FLU stations: x, half-width, top, bottom).
  add(new THREE.Mesh(loft([
    [1.02, 0.06, 0.06, -0.06], [0.95, 0.2, 0.22, -0.22], [0.75, 0.42, 0.38, -0.46], [0.0, 0.52, 0.5, -0.56],
    [-0.4, 0.55, 0.66, -0.56], [-0.95, 0.56, 1.05, -0.55], [-2.3, 0.53, 1.03, -0.46], [-3.2, 0.34, 0.62, -0.2],
    [-5.0, 0.16, 0.42, 0.02], [-6.25, 0.06, 0.34, 0.16],
  ]), body));
  // Windshield and side windows (thin dark panels just outside the skin).
  {
    // Windshield: a quad from the top of the cowl to the cabin roof.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.36, 0.5, 0.68, -0.36, -0.5, 0.68, -0.93, -0.53, 1.07, -0.93, 0.53, 1.07], 3));
    g.setIndex([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]);
    g.computeVertexNormals();
    add(new THREE.Mesh(g, glassMat));
  }
  for (const s of [1, -1]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 0.42), glassMat);
    w.position.set(-1.55, s * 0.565, 0.72); w.rotation.x = s * Math.PI / 2; add(w);
    const st = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.02, 0.08), trim);
    st.position.set(-2.6, s * 0.48, 0.1); add(st);
  }
  // Wing panels (right side from the data, mirrored for the left).
  const wing = def.surfaces[0], wingT = wing.thickness_ratio || 0.12;
  const controls = { flaps: [], ailerons: [], elevator: [], rudder: null };
  for (const p of wing.panels) {
    const qc = flu(p.root_quarter_chord_m);
    const dih = (p.dihedral_deg || 0) * DEG;
    const span = p.span_m, c0 = p.root_chord_m, c1 = p.tip_chord_m;
    for (const side of [1, -1]) {
      const dir = new THREE.Vector3(0, -side * Math.cos(dih), Math.sin(dih));  // FLU: right = -y
      const root0 = new THREE.Vector3(qc.x, side === 1 ? qc.y : -qc.y, qc.z);
      const le0 = root0.clone().add(new THREE.Vector3(0.25 * c0, 0, 0));
      const tipQc = root0.clone().addScaledVector(dir, span);
      const le1 = tipQc.clone().add(new THREE.Vector3(0.25 * c1, 0, 0));
      const up = new THREE.Vector3(0, side * Math.sin(dih), Math.cos(dih));
      // Fixed part: LE to 70 % chord; control surfaces fill the rest.
      add(new THREE.Mesh(panelGeometry(le0, c0 * 0.7, le1, c1 * 0.7, wingT / 0.7, up), body));
      for (const ctl of p.controls || []) {
        const f = ctl.chord_fraction || 0.25, a = ctl.span_start ?? 0, b = ctl.span_end ?? 1;
        const lerp = (u, v, s) => u.clone().lerp(v, s);
        const cA = c0 + (c1 - c0) * a, cB = c0 + (c1 - c0) * b;
        const leA = lerp(le0, le1, a), leB = lerp(le0, le1, b);
        const hingeA = leA.clone().add(new THREE.Vector3(-cA * (1 - f), 0, 0)), hingeB = leB.clone().add(new THREE.Vector3(-cB * (1 - f), 0, 0));
        const pivot = new THREE.Group(); pivot.position.copy(hingeA);
        const axis = new THREE.Vector3().subVectors(hingeB, hingeA).normalize();
        const g = panelGeometry(new THREE.Vector3(0, 0, 0), cA * f, new THREE.Vector3().subVectors(hingeB, hingeA), cB * f, wingT * 0.6 / f, up);
        const mesh = new THREE.Mesh(g, ctl.channel === 'aileron' ? trim : body);
        mesh.castShadow = true; pivot.add(mesh); root.add(pivot);
        const entry = { pivot, axis, side, def: ctl };
        if (ctl.channel === 'flap') controls.flaps.push(entry); else if (ctl.channel === 'aileron') controls.ailerons.push(entry);
      }
    }
  }
  // Wing struts.
  for (const s of [1, -1]) add(cylinderBetween(new THREE.Vector3(-1.2, s * 0.55, -0.3), new THREE.Vector3(-1.25, s * 2.55, 0.98), 0.035, body));
  // Horizontal tail with elevator.
  const ht = def.surfaces[1];
  for (const p of ht.panels) {
    const qc = flu(p.root_quarter_chord_m), c0 = p.root_chord_m, c1 = p.tip_chord_m;
    for (const side of [1, -1]) {
      const le0 = new THREE.Vector3(qc.x + 0.25 * c0, 0, qc.z), le1 = new THREE.Vector3(qc.x + 0.25 * c1 - 0.25, -side * p.span_m, qc.z);
      const f = (p.controls?.[0]?.chord_fraction) || 0.4;
      add(new THREE.Mesh(panelGeometry(le0, c0 * (1 - f), le1, c1 * (1 - f), 0.1 / (1 - f), new THREE.Vector3(0, 0, 1)), body));
      const hA = le0.clone().add(new THREE.Vector3(-c0 * (1 - f), 0, 0)), hB = le1.clone().add(new THREE.Vector3(-c1 * (1 - f), 0, 0));
      const pivot = new THREE.Group(); pivot.position.copy(hA);
      const mesh = new THREE.Mesh(panelGeometry(new THREE.Vector3(), c0 * f, new THREE.Vector3().subVectors(hB, hA), c1 * f, 0.06 / f, new THREE.Vector3(0, 0, 1)), trim);
      mesh.castShadow = true; pivot.add(mesh); root.add(pivot);
      controls.elevator.push({ pivot, axis: new THREE.Vector3().subVectors(hB, hA).normalize(), side, def: p.controls?.[0] });
    }
  }
  // Vertical tail with rudder (swept).
  const vt = def.surfaces[2].panels[0];
  {
    const qc = flu(vt.root_quarter_chord_m), c0 = vt.root_chord_m, c1 = vt.tip_chord_m, sweep = (vt.sweep_deg || 0) * DEG;
    const f = vt.controls?.[0]?.chord_fraction || 0.38;
    const le0 = new THREE.Vector3(qc.x + 0.25 * c0, 0, qc.z);
    const le1 = new THREE.Vector3(qc.x + 0.25 * c1 - Math.tan(sweep) * vt.span_m, 0, qc.z + vt.span_m);
    const side = new THREE.Vector3(0, 1, 0);
    add(new THREE.Mesh(panelGeometry(le0, c0 * (1 - f), le1, c1 * (1 - f), 0.1 / (1 - f), side), body));
    const hA = le0.clone().add(new THREE.Vector3(-c0 * (1 - f), 0, 0)), hB = le1.clone().add(new THREE.Vector3(-c1 * (1 - f), 0, 0));
    const pivot = new THREE.Group(); pivot.position.copy(hA);
    const mesh = new THREE.Mesh(panelGeometry(new THREE.Vector3(), c0 * f, new THREE.Vector3().subVectors(hB, hA), c1 * f, 0.06 / f, side), accent);
    mesh.castShadow = true; pivot.add(mesh); root.add(pivot);
    controls.rudder = { pivot, axis: new THREE.Vector3().subVectors(hB, hA).normalize(), def: vt.controls?.[0] };
  }
  // Landing gear: legs from the attach points, wheels at the leg ends.
  for (const g of def.gear) {
    const a = flu(g.attach_m), end = a.clone().add(new THREE.Vector3(0, 0, -g.length_m + g.wheel_radius_m * 0.6));
    const isNose = /nose/.test(g.name);
    const top = isNose ? a : new THREE.Vector3(a.x + 0.05, Math.sign(a.y) * 0.45, a.z + 0.05);
    add(cylinderBetween(top, end, isNose ? 0.04 : 0.03, isNose ? body : dark));
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(g.wheel_radius_m, g.wheel_radius_m, 0.14, 16), tyre);
    wheel.position.copy(end); wheel.position.z -= g.wheel_radius_m * 0.15;
    add(wheel);  // cylinder axis = y (lateral)
    const pant = new THREE.Mesh(new THREE.SphereGeometry(g.wheel_radius_m * 1.25, 12, 8), body);
    pant.scale.set(1.7, 0.6, 1.0); pant.position.copy(wheel.position); pant.position.z += 0.03; add(pant);
  }
  // Propeller: spinner, two blades, and a translucent disc at speed.
  const eng = def.engines[0], R = eng.propeller.diameter_m / 2;
  const hub = flu(eng.position_m || [0.95, 0, 0]);
  const prop = new THREE.Group(); prop.position.copy(hub).add(new THREE.Vector3(0.08, 0, 0)); root.add(prop);
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.32, 16), body);
  spinner.rotation.z = -Math.PI / 2; spinner.position.x = 0.12; prop.add(spinner);
  const blades = new THREE.Group(); prop.add(blades);
  for (const s of [1, -1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.11, R * 0.95), dark);
    b.position.z = s * R * 0.5; b.rotation.z = s * 0.35; blades.add(b);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.031, 0.111, 0.12), accent);
    tip.position.z = s * (R - 0.06); blades.add(tip);
  }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 40), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  disc.rotation.y = Math.PI / 2; prop.add(disc);
  // Navigation lights.
  const light = (color, p) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color })); m.position.copy(p); root.add(m); };
  light(0xff2222, new THREE.Vector3(-1.04, 5.55, 1.15)); light(0x22ff44, new THREE.Vector3(-1.04, -5.55, 1.15));
  light(0xffffff, new THREE.Vector3(-6.3, 0, 0.34));

  let propAngle = 0;
  const q = new THREE.Quaternion();
  // st: { flapDeg, aileron, elevator, rudder (-1..1 control positions), rpm }, dt s
  function update(st, dt) {
    for (const f of controls.flaps) f.pivot.quaternion.setFromAxisAngle(f.axis, f.side * st.flapDeg * DEG);
    for (const a of controls.ailerons) {
      // Positive aileron rolls right: the right aileron rises, the left one drops.
      const up = a.def.max_negative_deg || 20, down = a.def.max_positive_deg || 15;
      const v = st.aileron * a.side;  // side +1 = right wing
      const deg = v > 0 ? -v * up : -v * down;
      a.pivot.quaternion.setFromAxisAngle(a.axis, a.side * deg * DEG);
    }
    for (const e of controls.elevator) {
      const up = e.def?.max_negative_deg || 28, down = e.def?.max_positive_deg || 23;
      const deg = st.elevator > 0 ? -st.elevator * up : -st.elevator * down;  // pull: trailing edge up
      e.pivot.quaternion.setFromAxisAngle(e.axis, e.side * deg * DEG);
    }
    if (controls.rudder) controls.rudder.pivot.quaternion.setFromAxisAngle(controls.rudder.axis, -st.rudder * (controls.rudder.def?.max_positive_deg || 17.7) * DEG);
    const omega = st.rpm / 60 * 2 * Math.PI;
    propAngle = (propAngle + omega * dt) % (2 * Math.PI);
    // Above ~600 rpm the eye sees a disc, not blades (frame-rate aliasing).
    const fast = st.rpm > 600;
    blades.visible = !fast || st.rpm < 900;
    blades.quaternion.copy(q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), fast ? propAngle * 0.02 + Math.random() * 6.28 : propAngle));
    disc.material.opacity = Math.min(0.35, Math.max(0, (st.rpm - 500) / 1500) * 0.35) * (st.disc ?? 1);
  }
  return { root, update, glass: glassMat };
}
