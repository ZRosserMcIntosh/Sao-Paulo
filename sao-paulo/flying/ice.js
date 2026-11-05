// São Paulo World · flight test bed: the ice on the airframe, drawn from the
// flight core's icing model (A.icing()): a bead along each lifting surface's
// leading edge (wing, horizontal tail, fin, in the order of def.surfaces),
// as thick as the ice the core has grown there (drawn thicker, so a few
// millimetres show from the chase camera), milky blue-white for rime and
// clear, glassy for glaze. Leading edges from the definition, as model.js
// and jetmodel.js lay them (body FLU from the datum).
import * as THREE from 'three';
import { flu } from './model.js';

const DEG = Math.PI / 180;

export function buildIce(def) {
  const root = new THREE.Group();
  root.name = 'ice';
  const surfaces = [];
  (def.surfaces || []).slice(0, 8).forEach((sf, si) => {
    const fin = si === 2 || /vertical/.test(sf.name || '');
    const mat = new THREE.MeshStandardMaterial({ color: 0xf4f8fb, roughness: 0.85, metalness: 0, transparent: true, opacity: 0.95 });
    const segs = [];
    for (const p of sf.panels || []) {
      if ((p.dihedral_deg || 0) > 45) continue;  // a winglet
      const qc = flu(p.root_quarter_chord_m), c0 = p.root_chord_m, c1 = p.tip_chord_m, span = p.span_m;
      const sw = (p.sweep_deg || 0) * DEG, dih = (p.dihedral_deg || 0) * DEG;
      for (const side of fin ? [0] : [1, -1]) {
        let a, b;
        if (fin) {
          a = new THREE.Vector3(qc.x + 0.25 * c0, 0, qc.z);
          b = new THREE.Vector3(qc.x + 0.25 * c1 - Math.tan(sw) * span, 0, qc.z + span);
        } else {
          const r = new THREE.Vector3(qc.x, side === 1 ? qc.y : -qc.y, qc.z);
          a = r.clone().add(new THREE.Vector3(0.25 * c0, 0, 0));
          b = r.clone().add(new THREE.Vector3(-span * Math.tan(sw) + 0.25 * c1, -side * span * Math.cos(dih), span * Math.sin(dih)));
        }
        const d = new THREE.Vector3().subVectors(b, a), len = d.length();
        const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, len, 10, 1, false), mat);
        m.position.copy(a).addScaledVector(d, 0.5);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
        m.visible = false;
        root.add(m);
        segs.push(m);
      }
    }
    surfaces.push({ mat, segs });
  });
  // ice: A.icing() (or null): each surface's mm and glaze share.
  function update(ice) {
    surfaces.forEach((sf, i) => {
      const s = ice?.surfaces?.[i], mm = s ? s.mm : 0;
      const show = mm > 0.15;
      // Radius: the ice's thickness, exaggerated 4x and at least 1.5 cm once there is any.
      const r = show ? Math.max(0.015, 4 * mm / 1000) : 0;
      for (const m of sf.segs) { m.visible = show; if (show) m.scale.set(r, 1, r); }
      if (show) {
        const g = Math.min(Math.max(s.glaze || 0, 0), 1);
        sf.mat.color.setRGB(0.82 - 0.2 * g, 0.88 - 0.12 * g, 0.95 - 0.05 * g);
        sf.mat.opacity = 0.95 - 0.5 * g;
        sf.mat.roughness = 0.85 - 0.75 * g;
      }
    });
  }
  return { root, update };
}
