// São Paulo World · driving test track: the wind tunnel.
// The car on a rolling road: it really drives at the tunnel's speed (the physics holds its
// position every step, ord_tunnel, so it runs on the same patch of road), a cross wind sets the
// yaw angle, and a controller holds the speed and the heading. Every number on the panel is the
// physics' own (the same aero model the car drives with: body and floor downforce with its ride
// height and stall, the rear wing's polar, drag); the streamlines and the smoke are the airflow
// view (carflow.js) drawn through the field those forces imply. The world fades behind a studio
// backdrop, as wind tunnel photographs and CFD renders are shown.
// SPDX-License-Identifier: MIT
import { REC } from './telemetry.js';

const STUDIO = '#dde1e6';

export class WindTunnel {
  constructor({ THREE, scene, M, host, toast }) {
    Object.assign(this, { THREE, scene, M, toast });
    this.on = false;
    this.speed = 200 / 3.6; this.yaw = 0; this.flow = 'lines'; this.wandY = 0;
    // the belt: a dark rolling road under the car with stripes that run with the speed
    const c = document.createElement('canvas'); c.width = 64; c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = '#2b2f36'; x.fillRect(0, 0, 64, 256);
    x.fillStyle = '#4a515c'; for (let i = 0; i < 8; ++i) x.fillRect(0, i * 32, 64, 6);
    x.fillStyle = '#c9ced6'; x.fillRect(0, 0, 3, 256); x.fillRect(61, 0, 3, 256);   // the belt's edges
    this.tex = new THREE.CanvasTexture(c);
    this.tex.wrapS = this.tex.wrapT = THREE.RepeatWrapping;
    this.tex.repeat.set(1, 4);
    this.belt = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 12).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: this.tex, roughness: 0.85, metalness: 0.1 }));
    this.belt.visible = false; this.belt.receiveShadow = true;
    scene.add(this.belt);
    this.el = document.createElement('div');
    this.el.id = 'tunnel'; this.el.className = 'panel'; this.el.hidden = true;
    this.el.innerHTML = `<div class="lhead"><b>Wind tunnel</b><button class="tx" aria-label="Leave the wind tunnel">✕</button></div>
      <label>Air speed <b class="tv-speed"></b><input class="t-speed" type="range" min="40" max="330" step="5"></label>
      <label>Yaw <b class="tv-yaw"></b><input class="t-yaw" type="range" min="-20" max="20" step="1"></label>
      <div class="row tflow"><button data-flow="lines">Streamlines</button><button data-flow="smoke">Smoke</button><button data-flow="both">Both</button></div>
      <label class="t-wand">Smoke wand <b class="tv-wand"></b><input class="t-wandr" type="range" min="-110" max="110" step="5"></label>
      <div class="tread"></div>
      <small>The car is held on a rolling road at the tunnel's speed; a cross wind sets the yaw. Forces: the physics' aero model. Lines and smoke: a potential flow around an equivalent body that carries those forces (not CFD). Telemetry: P · slow motion: [ ]</small>`;
    host.append(this.el);
    const q = (s) => this.el.querySelector(s);
    q('.t-speed').value = String(Math.round(this.speed * 3.6));
    q('.t-yaw').value = '0';
    q('.t-wandr').value = '0';
    q('.t-speed').oninput = (e) => { this.speed = +e.target.value / 3.6; if (this.on) this.M._ord_tunnel(1, this.speed); this.applyWind(); this.label(); };
    q('.t-yaw').oninput = (e) => { this.yaw = +e.target.value * Math.PI / 180; this.applyWind(); this.label(); };
    q('.t-wandr').oninput = (e) => { this.wandY = +e.target.value / 100; this.label(); };
    this.el.querySelectorAll('[data-flow]').forEach((b) => (b.onclick = () => { this.flow = b.dataset.flow; this.label(); b.blur(); }));
    q('.tx').onclick = () => this.onExit?.();
    this.label();
    this.lastRead = 0;
  }

  label() {
    const q = (s) => this.el.querySelector(s);
    q('.tv-speed').textContent = `${Math.round(this.speed * 3.6)} km/h`;
    q('.tv-yaw').textContent = `${Math.round(this.yaw * 180 / Math.PI)}°`;
    q('.tv-wand').textContent = `${this.wandY.toFixed(2)} m`;
    q('.t-wand').hidden = this.flow === 'lines';
    this.el.querySelectorAll('[data-flow]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.flow === this.flow));
  }

  // heading: the car's yaw on the road (rad, world ISO). The air comes in at `yaw` off the nose:
  // a cross wind of V tan(yaw) across the road.
  applyWind() {
    if (!this.on) return;
    const side = this.speed * Math.tan(this.yaw);
    const h = this.heading;
    this.M._ord_set_wind(-Math.sin(h) * side, Math.cos(h) * side);
  }

  enter(heading, pos) {
    this.on = true; this.heading = heading;
    const s = this.scene;
    this.saved = { bg: s.background.clone(), fog: { c: s.fog.color.clone(), near: s.fog.near, far: s.fog.far } };
    this.el.hidden = false;
    this.belt.visible = true;
    this.anchor = pos;
    this.applyWind();
    this.backdrop();
  }
  backdrop() {
    const s = this.scene;
    s.background.set(STUDIO);
    s.fog.color.set(STUDIO); s.fog.near = 9; s.fog.far = 32;
  }
  exit() {
    if (!this.on) return;
    this.on = false;
    const s = this.scene;
    s.background.copy(this.saved.bg); s.fog.color.copy(this.saved.fog.c); s.fog.near = this.saved.fog.near; s.fog.far = this.saved.fog.far;
    this.el.hidden = true; this.belt.visible = false;
  }

  // The rolling road's driver: the physics holds the speed (ord_tunnel); this holds the heading,
  // off the throttle and the brakes. Returns the inputs.
  drive(simDt, S, carPos, groundY) {
    const v = S(7), yawRate = S(9);
    const qw = S(3), qx = S(4), qy = S(5), qz = S(6);
    const heading = Math.atan2(2 * (qx * qy + qw * qz), 1 - 2 * (qy * qy + qz * qz));
    let e = heading - this.heading; e = Math.atan2(Math.sin(e), Math.cos(e));
    const steer = Math.max(-0.4, Math.min(0.4, -2.5 * e - 0.6 * yawRate));
    // the belt runs under the car with the road speed
    this.belt.position.set(carPos.x, groundY + 0.006, carPos.z);
    this.belt.rotation.y = this.heading + Math.PI / 2;   // the belt's length along the car (ISO yaw = three's yaw about y)
    this.tex.offset.y = ((this.tex.offset.y || 0) + v * simDt / 9 * 4) % 1;
    this.backdrop();
    return { steer, throttle: 0, brake: 0, hand: 0, shiftUp: false, shiftDown: false };
  }

  // The panel's numbers (the physics' own), ~5 Hz.
  read(now, rec, rho = 1.225, hasFloor = false) {
    if (!rec || now - this.lastRead < 200) return;
    this.lastRead = now;
    const v = rec[REC.airspeed], q = 0.5 * rho * v * v;
    const f = rec[REC.dfF], r = rec[REC.dfR], wing = rec[REC.wing], tot = f + r, drag = rec[REC.drag];
    const g = 9.80665;
    this.el.querySelector('.tread').innerHTML =
      `<span>Air speed</span> <b>${(v * 3.6).toFixed(0)} km/h</b> · <span>yaw</span> ${(rec[REC.aeroYaw] * 180 / Math.PI).toFixed(1)}°<br>` +
      `<span>Downforce</span> <b>${tot.toFixed(0)} N</b> (${(tot / g).toFixed(0)} kg) · <span>ClA</span> ${q > 1 ? (tot / q).toFixed(2) : '—'} m²<br>` +
      `<span>front</span> ${f.toFixed(0)} N · <span>rear</span> ${r.toFixed(0)} N${wing ? ` (wing ${wing.toFixed(0)} N)` : ''} · <span>balance</span> <b>${Math.abs(tot) > 1 ? (100 * f / tot).toFixed(1) : '—'}% front</b><br>` +
      `<span>Drag</span> <b>${drag.toFixed(0)} N</b> · <span>CdA</span> ${q > 1 ? (drag / q).toFixed(3) : '—'} m² · ${(drag * v / 1000).toFixed(1)} kW · <span>L/D</span> ${drag > 1 ? (tot / drag).toFixed(2) : '—'}<br>` +
      (hasFloor ? `<span>Floor</span> F ${(rec[REC.clrF] * 1000).toFixed(0)} · R ${(rec[REC.clrR] * 1000).toFixed(0)} mm` : '<span>Floor</span> not ride-height sensitive on this car') +
      `${rec[REC.floorStall] ? ' · <b class="bad">floor stalled</b>' : ''}${rec[REC.wingStall] ? ' · <b class="bad">wing stalled</b>' : ''}`;
  }
}
