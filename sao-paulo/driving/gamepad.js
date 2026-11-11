// São Paulo World · driving test track: game controllers (Xbox, PlayStation and others).
// Reads the browser's Gamepad API once a frame: the controller in use (the last one touched, so a
// second pad or a duplicate entry from a driver tool does not steal the input), its sticks with a
// radial dead zone and a steering curve, the triggers, and which buttons went down or up this
// frame and for how long they have been held. Button names follow the browser's "standard"
// layout (Xbox names; a PlayStation pad's Cross, Circle, Square and Triangle sit in the same
// places), and the labels shown on the page match the controller that is connected. Rumble uses
// the pad's dual motors where the browser supports it (Chrome and Edge do for Xbox and PlayStation).
// SPDX-License-Identifier: MIT

export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16 };

const LABELS = {
  xbox: { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT', VIEW: 'View', MENU: 'Menu', L3: 'LS click', R3: 'RS click', LS: 'Left stick', RS: 'Right stick', DPAD: 'D-pad' },
  ps: { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', VIEW: 'Create / Share', MENU: 'Options', L3: 'L3', R3: 'R3', LS: 'Left stick', RS: 'Right stick', DPAD: 'D-pad' },
};
LABELS.generic = LABELS.xbox;

// What the controller is, from the id the browser reports (vendor ids: 045e Microsoft, 054c Sony).
export function padKind(id = '') {
  if (/054c|sony|playstation|dualsense|dualshock|^wireless controller/i.test(id)) return 'ps';
  if (/045e|xbox|xinput|microsoft/i.test(id)) return 'xbox';
  return 'generic';
}
export function padName(kind) { return kind === 'ps' ? 'PlayStation controller' : kind === 'xbox' ? 'Xbox controller' : 'Controller'; }

export class GamePad {
  constructor({ store, onConnect, onDisconnect, onLayoutWarning } = {}) {
    this.store = store;
    this.index = -1;              // navigator.getGamepads() slot in use
    this.kind = 'generic';
    this.id = '';
    this.standard = true;
    this.down = [];               // pressed this frame
    this.prev = [];               // pressed last frame
    this.heldT = [];              // seconds held
    this.lx = 0; this.ly = 0; this.rx = 0; this.ry = 0; this.lt = 0; this.rt = 0;
    this.active = false;          // a controller is connected and in use
    this.lastRumble = 0;
    this.warned = new Set();
    this.deadzone = store?.get('padDead', 0.1) ?? 0.1;
    this.curve = store?.get('padCurve', 1.3) ?? 1.3;   // 1 = linear; higher = finer near centre
    this.vibrate = store?.get('padRumble', true) ?? true;
    Object.assign(this, { onConnect, onDisconnect, onLayoutWarning });
    addEventListener('gamepadconnected', (e) => { this.adopt(e.gamepad); });
    addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index !== this.index) return;
      this.index = -1; this.active = false; this.reset();
      this.onDisconnect?.(this.kind);
    });
  }

  setDeadzone(v) { this.deadzone = v; this.store?.set('padDead', v); }
  setCurve(v) { this.curve = v; this.store?.set('padCurve', v); }
  setVibrate(on) { this.vibrate = on; this.store?.set('padRumble', on); }
  label(name) { return (LABELS[this.kind] || LABELS.generic)[name] ?? name; }

  reset() { this.down = []; this.prev = []; this.heldT = []; this.lx = this.ly = this.rx = this.ry = this.lt = this.rt = 0; }

  adopt(gp) {
    if (!gp) return;
    const changed = gp.index !== this.index;
    this.index = gp.index; this.id = gp.id; this.kind = padKind(gp.id); this.standard = gp.mapping === 'standard';
    this.active = true;
    if (changed) {
      this.reset();
      // the buttons held while it was adopted count as already down (no phantom presses)
      this.prev = gp.buttons.map((b) => b.pressed);
      this.onConnect?.(this.kind, gp.id);
      if (!this.standard && !this.warned.has(gp.id)) { this.warned.add(gp.id); this.onLayoutWarning?.(this.kind, gp.id); }
    }
  }

  // Once a frame. dt: wall-clock seconds.
  poll(dt) {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((g) => g && g.connected) : [];
    if (!pads.length) { if (this.active) { this.active = false; this.reset(); } return false; }
    // the one in use: the current pad, unless another one is being touched
    let cur = pads.find((g) => g.index === this.index);
    const touched = pads.find((g) => g.index !== this.index && g.buttons.some((b) => b.pressed || b.value > 0.3));
    if (!cur || touched) { this.adopt(touched || cur || pads[0]); cur = pads.find((g) => g.index === this.index); }
    if (!cur) return false;
    this.active = true;
    this.prev = this.down;
    this.down = cur.buttons.map((b) => b.pressed);
    for (let i = 0; i < this.down.length; ++i) this.heldT[i] = this.down[i] ? (this.prev[i] ? (this.heldT[i] || 0) + dt : 0) : 0;
    const ax = (i) => cur.axes[i] ?? 0;
    [this.lx, this.ly] = this.stick(ax(0), ax(1));
    [this.rx, this.ry] = this.stick(ax(2), ax(3));
    const val = (i) => cur.buttons[i]?.value ?? 0;
    this.lt = val(BTN.LT); this.rt = val(BTN.RT);
    return true;
  }

  // Radial dead zone, rescaled so the stick still reaches 1 at full deflection.
  stick(x, y) {
    const m = Math.hypot(x, y), d = this.deadzone;
    if (m <= d) return [0, 0];
    const k = Math.min(1, (m - d) / (1 - d)) / m;
    return [x * k, y * k];
  }
  // Steering from the left stick (+ = left, as the physics wants): the curve gives finer control
  // near the centre and the full lock at full deflection.
  steer() { const x = this.lx; return -Math.sign(x) * Math.pow(Math.abs(x), this.curve); }

  pressed(b) { return !!this.down[b]; }
  edge(b) { return !!this.down[b] && !this.prev[b]; }
  released(b) { return !this.down[b] && !!this.prev[b]; }
  held(b) { return this.heldT[b] || 0; }
  // Edge plus auto-repeat while held (menus): first after 0.35 s, then every 0.09 s.
  repeat(b, dt) {
    if (this.edge(b)) return true;
    const t = this.heldT[b] || 0;
    return t > 0.35 && Math.floor((t - 0.35) / 0.09) !== Math.floor((t - dt - 0.35) / 0.09);
  }
  any() { return this.down.some(Boolean) || Math.abs(this.lx) + Math.abs(this.rx) + this.lt + this.rt > 0.2; }

  // strong: the low-frequency motor (hits); weak: the high-frequency one (slip, ABS). 0..1.
  rumble(strong, weak, ms = 100) {
    if (!this.vibrate || !this.active) return;
    const gp = navigator.getGamepads?.()[this.index];
    const act = gp?.vibrationActuator;
    if (!act?.playEffect) return;
    const now = performance.now();
    // continuous effects are re-sent at ~12 Hz; a hit always goes through
    if (strong < 0.3 && now - this.lastRumble < 80) return;
    this.lastRumble = now;
    act.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }).catch(() => {});
  }
}

// Menu navigation with the controller: the D-pad moves between the controls of a panel, left and
// right adjust a slider or a list, A presses, B goes back.
export class PadMenu {
  constructor() { this.scope = null; this.i = 0; this.el = null; }
  items() {
    if (!this.scope) return [];
    return [...this.scope.querySelectorAll('button, input, select, summary, a[href]')]
      .filter((e) => !e.disabled && e.offsetParent !== null && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  }
  open(scope) { this.scope = scope; this.i = 0; this.focus(0); }
  close() { this.blur(); this.scope = null; }
  get on() { return !!this.scope; }
  blur() { this.el?.classList.remove('padfocus'); this.el = null; }
  focus(i) {
    const list = this.items();
    if (!list.length) return;
    this.i = (i + list.length) % list.length;
    this.blur();
    this.el = list[this.i];
    this.el.classList.add('padfocus');
    try { this.el.focus({ preventScroll: true }); } catch { /* not focusable */ }
    this.el.scrollIntoView({ block: 'nearest' });
  }
  move(d) {
    const list = this.items();
    const cur = this.el ? list.indexOf(this.el) : -1;
    this.focus((cur < 0 ? this.i : cur) + d);
  }
  // left / right: a slider steps, a list changes; anything else moves to the next control
  adjust(d) {
    const e = this.el;
    if (e instanceof HTMLInputElement && e.type === 'range') {
      if (d > 0) e.stepUp(); else e.stepDown();
      e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (e instanceof HTMLSelectElement) {
      const n = e.options.length; if (!n) return;
      e.selectedIndex = Math.max(0, Math.min(n - 1, e.selectedIndex + d));
      e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    this.move(d);
  }
  press() {
    const e = this.el; if (!e) return;
    if (e instanceof HTMLSelectElement) { this.adjust(e.selectedIndex >= e.options.length - 1 ? -(e.options.length - 1) : 1); return; }
    e.click();
    // a click may rebuild the panel (tabs, the garage) or hide the control: keep a valid focus
    requestAnimationFrame(() => { if (!this.scope) return; if (!this.el?.isConnected || this.el.offsetParent === null) this.focus(this.i); else this.el.classList.add('padfocus'); });
  }
}
