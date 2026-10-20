// São Paulo World · driving test track: the tuning garage.
// Every setting goes to the OpenRoad Dynamics core as a setup (JSON, setup-sheet units; see
// ord/setup.hpp in the engine). The physics is identical; only the parts change. Setups are
// stored per car and can be saved, loaded and shared as .json files.

const COMPOUNDS = [
  ['stock', 'Stock (road)'], ['off-road', 'Off-road'], ['all-season', 'All-season'], ['street', 'Street'],
  ['sport', 'Sport'], ['semi-slick', 'Semi-slick'], ['slick', 'Racing slick'], ['rain', 'Rain'],
];
// [key, label, min, max, step, unit, digits, help]
const AXLE = [
  ['Alignment'],
  ['camberDeg', 'Camber', -6, 3, 0.1, '°', 1, 'Negative = top of the wheel leans in. Best cornering grip with the tyre ~2° into the turn once the body rolls; costs braking.'],
  ['toeDeg', 'Toe', -1, 1, 0.05, '°', 2, '+ = toe-in (stable), − = toe-out (sharper turn-in).'],
  ['casterDeg', 'Caster', 0, 10, 0.5, '°', 1, 'Front only: steering adds negative camber to the outside wheel.'],
  ['camberGainDegPerCm', 'Camber gain', -1.5, 0.5, 0.05, '°/cm', 2, 'Camber change per cm of bump. Negative claws back the camber body roll takes away.'],
  ['Springs & dampers'],
  ['springNmm', 'Spring', 10, 300, 1, 'N/mm', 0, 'Wheel rate. Stiffer = less roll and pitch, less grip over bumps.'],
  ['rideHeightMm', 'Ride height', -60, 60, 1, 'mm', 0, 'From stock. Lower = lower centre of mass and more floor downforce, until the floor stalls or bottoms out.'],
  ['bumpSlow', 'Bump (slow)', 500, 30000, 50, 'N·s/m', 0, 'Damping below 0.1 m/s: body motion, roll and pitch.'],
  ['bumpFast', 'Bump (fast)', 0, 30000, 50, 'N·s/m', 0, 'Damping above 0.1 m/s: bumps and kerbs. 0 = same as slow.'],
  ['reboundSlow', 'Rebound (slow)', 500, 40000, 50, 'N·s/m', 0, ''],
  ['reboundFast', 'Rebound (fast)', 0, 40000, 50, 'N·s/m', 0, '0 = same as slow.'],
  ['arbNmm', 'Anti-roll bar', 0, 300, 1, 'N/mm', 0, 'Stiffer at the front = more understeer; at the rear = more oversteer.'],
  ['Tyres'],
  ['compound', 'Compound'],
  ['pressureBar', 'Pressure', 1.4, 3.2, 0.05, 'bar', 2, 'Peak grip at ~2.2 bar; higher = sharper response, smaller patch.'],
];
const CAR = [
  ['Brakes'],
  ['brakeBalance', 'Balance (front)', 0.3, 0.8, 0.01, '%', 0, 'Too far back and the rears lock first: the car swaps ends under braking (try with ABS off).', 100],
  ['brakePressure', 'Pressure', 0.5, 1.6, 0.01, '%', 0, 'Total brake torque vs stock.', 100],
  ['Drivetrain'],
  ['finalDrive', 'Final drive', 2.2, 5.5, 0.01, ':1', 2, 'Higher = quicker acceleration, lower top speed.'],
  ['Aero'],
  ['frontAeroScale', 'Splitter', 0, 3, 0.05, '%', 0, 'Front downforce vs stock.', 100],
  ['rearAeroScale', 'Rear body', 0, 3, 0.05, '%', 0, 'Rear body/diffuser downforce vs stock.', 100],
  ['rearWing', 'Rear wing'],
  ['wingAngleDeg', 'Wing angle', -4, 32, 0.5, '°', 1, 'More angle = more downforce and drag, until the wing stalls (~25° here) and loses it.'],
  ['Environment'],
  ['altitudeM', 'Altitude', 0, 4500, 10, 'm', 0, 'Thinner air: less drag and downforce, and less power unless turbocharged. São Paulo ~760 m.'],
  ['temperatureC', 'Air temperature', -10, 45, 1, '°C', 0, 'Air density, engine power and how fast tyres cool.'],
  ['turbocharged', 'Turbocharged (holds power at altitude)'],
];

export class Garage {
  constructor(M, { store, toast, isBike, carIndex, startYaw }) {
    Object.assign(this, { M, store, toast, isBike, carIndex, startYaw });
    this.setup = null; this.stock = null; this.wind = { speed: 0, from: 90 }; this.warmers = store.get('warmers', false);
    this.dec = new TextDecoder(); this.enc = new TextEncoder();
    this.buildPanel();
    this.buildHud();
    this.gs = () => new Float64Array(M.HEAPF64.buffer, M._ord_garage_state(), M._ord_garage_state_size());
  }

  text() { const p = this.M._ord_text(); return this.dec.decode(this.M.HEAPU8.slice(p, p + this.M._ord_text_length())); }
  send(json) {
    const b = this.enc.encode(json);
    this.M.HEAPU8.set(b, this.M._ord_text_buffer(b.length));
    return this.M._ord_apply_setup() ? '' : this.text() || 'rejected';
  }
  read(stock) { this.M._ord_setup_json(stock ? 1 : 0); return JSON.parse(this.text()); }

  // After the car is (re)created: restore this car's saved setup, tyre warmers and wind.
  afterCreate() {
    if (this.isBike()) { this.panel.hidden = true; this.hud.style.display = 'none'; return; }
    this.hud.style.display = '';
    this.stock = this.read(true);
    const saved = this.store.get('setup' + this.carIndex(), null);
    if (saved && !this.send(JSON.stringify(saved))) this.setup = this.read(false); else this.setup = structuredClone(this.stock);
    this.M._ord_set_tyre_warmers(this.warmers ? (this.setup.front.compound.includes('slick') ? 90 : 75) : -1);
    this.applyWind();
    this.fill();
  }

  apply(note) {
    const err = this.send(JSON.stringify(this.setup));
    if (err) { this.toast('Setup rejected: ' + err); this.setup = this.read(false); this.fill(); return; }
    this.setup = this.read(false);
    this.store.set('setup' + this.carIndex(), this.setup);
    this.fill();
    this.updateDiff();
    if (note) this.toast(note);
  }

  applyWind() {
    // `from` is relative to the start line heading; the air moves the opposite way
    const a = this.startYaw() + (this.wind.from + 180) * Math.PI / 180;
    this.M._ord_set_wind(this.wind.speed * Math.cos(a), this.wind.speed * Math.sin(a));
  }

  // ---------- panel ----------
  buildPanel() {
    const p = document.createElement('aside');
    p.id = 'garage'; p.className = 'panel'; p.hidden = true; p.setAttribute('aria-label', 'Garage');
    p.innerHTML = `<div class="ghead"><h2>Garage</h2><button id="gClose" aria-label="Close garage">✕</button></div>
      <p class="note" style="margin-top:0">Changes apply instantly to the car you're driving: same physics, different parts. Saved per car.</p>
      <div class="gtabs" role="tablist"></div><div class="gbody"></div>
      <div class="row gfoot">
        <button id="gStock" title="Back to the car as it comes">Stock</button>
        <button id="gSave">Save .json</button><button id="gLoad">Load .json</button>
        <button id="gCopy">Copy</button><input id="gFile" type="file" accept=".json,application/json" hidden>
      </div>
      <p class="note" id="gDiff"></p>`;
    document.body.append(p);
    this.panel = p;
    const css = document.createElement('style');
    css.textContent = `#garage{position:fixed;left:12px;top:66px;width:340px;max-height:calc(100% - 78px);overflow:auto;z-index:4}
#garage[hidden]{display:none}
#garage .ghead{display:flex;justify-content:space-between;align-items:center}
#garage h2{font:800 15px/1 var(--display);text-transform:uppercase;letter-spacing:.03em;margin:0}
#garage h3{font:600 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin:14px 0 6px}
#garage .gtabs{display:flex;gap:4px;margin-top:10px;flex-wrap:wrap}
#garage .gf{display:grid;grid-template-columns:96px 1fr 62px;gap:6px;align-items:center;font-size:12px;margin:5px 0}
#garage .gf input[type=range]{width:100%}
#garage .gf output{font:500 11px var(--mono);text-align:right;color:var(--ink)}
#garage .gf output.chg{color:var(--hot)}
#garage .gf label{color:var(--mute)}
#garage .gfoot{margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}
#hTyres{font:500 10.5px/1.35 var(--mono);color:var(--mute);min-width:150px}
#hTyres .tg{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 12px}
#hTyres b{font-weight:600}
#hTyres .aero{margin-top:6px;padding-top:5px;border-top:1px solid var(--line)}
@media (max-width:640px){#garage{left:8px;right:8px;width:auto}}
@media (pointer:coarse){#garage{touch-action:pan-y}#hTyres{display:none}}`;
    document.head.append(css);
    const tabs = [['front', 'Front'], ['rear', 'Rear'], ['car', 'Brakes · drive · aero'], ['env', 'Weather']];
    this.tab = 'front';
    for (const [id, label] of tabs) {
      const b = document.createElement('button'); b.textContent = label; b.dataset.tab = id;
      b.onclick = () => { this.tab = id; this.fill(); };
      p.querySelector('.gtabs').append(b);
    }
    p.querySelector('#gClose').onclick = () => this.toggle(false);
    p.querySelector('#gStock').onclick = () => { this.setup = structuredClone(this.stock); this.apply('Stock setup'); };
    p.querySelector('#gSave').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(this.setup, null, 2)], { type: 'application/json' }));
      a.download = `setup-car${this.carIndex()}.json`; a.click(); URL.revokeObjectURL(a.href);
    };
    p.querySelector('#gCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(this.setup, null, 2)); this.toast('Setup copied as JSON'); } catch { this.toast('Clipboard unavailable: use Save .json'); }
    };
    const file = p.querySelector('#gFile');
    p.querySelector('#gLoad').onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files[0]; file.value = ''; if (!f) return;
      try { Object.assign(this.setup, JSON.parse(await f.text())); this.apply('Loaded ' + f.name); } catch (e) { this.toast('Not a setup file: ' + e.message); }
    };
    // buttons give focus back so the driving keys keep working (sliders and
    // selects keep it: the page ignores keys aimed at form fields)
    p.addEventListener('click', (e) => { if (e.target instanceof HTMLButtonElement) e.target.blur(); });
  }

  toggle(on = this.panel.hidden) {
    if (this.isBike()) { this.toast('The garage is for cars (two-wheelers have no setup yet)'); return; }
    this.panel.hidden = !on;
    if (on) this.fill();
  }

  field(parent, obj, stockObj, spec, onApply = () => this.apply()) {
    const [key, label, min, max, step, unit, digits, help, scale = 1] = spec;
    const row = document.createElement('div'); row.className = 'gf';
    if (help) row.title = help;
    if (key === 'compound') {
      row.innerHTML = `<label>${label}</label><select style="grid-column:span 2"></select>`;
      const s = row.querySelector('select');
      for (const [v, n] of COMPOUNDS) s.append(new Option(n, v));
      s.value = obj[key];
      s.onchange = () => { obj[key] = s.value; onApply(); };
    } else if (typeof obj[key] === 'boolean') {
      row.innerHTML = `<label style="grid-column:span 3;display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox"> ${label}</label>`;
      const c = row.querySelector('input'); c.checked = obj[key];
      c.onchange = () => { obj[key] = c.checked; onApply(); };
    } else {
      row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" aria-label="${label}"><output></output>`;
      const r = row.querySelector('input'), o = row.querySelector('output');
      const show = (v) => { o.textContent = (v * scale).toFixed(digits) + (unit === '%' ? '%' : ' ' + unit); o.classList.toggle('chg', Math.abs(v - stockObj[key]) > step / 2); };
      r.value = obj[key]; show(obj[key]);
      r.oninput = () => show(+r.value);
      r.onchange = () => { obj[key] = +r.value; onApply(); };
    }
    parent.append(row);
  }

  fill() {
    if (!this.setup || this.panel.hidden) return;
    this.panel.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tab === this.tab));
    const body = this.panel.querySelector('.gbody'); body.textContent = '';
    const section = (t) => { const h = document.createElement('h3'); h.textContent = t; body.append(h); };
    if (this.tab === 'front' || this.tab === 'rear') {
      const o = this.setup[this.tab], st = this.stock[this.tab];
      for (const spec of AXLE) {
        if (spec.length === 1) { section(spec[0]); continue; }
        if (spec[0] === 'casterDeg' && this.tab === 'rear') continue;
        this.field(body, o, st, spec);
      }
      if (this.tab === 'front') {
        const w = document.createElement('label'); w.className = 'note'; w.style.cssText = 'display:flex;gap:8px;align-items:center';
        w.innerHTML = `<input type="checkbox" ${this.warmers ? 'checked' : ''}> Tyre warmers (start the tyres at working temperature)`;
        w.querySelector('input').onchange = (e) => { this.warmers = e.target.checked; this.store.set('warmers', this.warmers); this.afterCreate(); };
        body.append(w);
      }
    } else {
      const env = this.tab === 'env';
      let inEnv = false;
      for (const spec of CAR) {
        if (spec.length === 1) { inEnv = spec[0] === 'Environment'; if (inEnv === env) section(spec[0]); continue; }
        if (inEnv !== env) continue;
        if (spec[0] === 'wingAngleDeg' && !this.setup.rearWing) continue;
        this.field(body, this.setup, this.stock, spec);
      }
      if (env) {
        const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '6px';
        for (const [n, alt] of [['Sea level', 0], ['São Paulo', 760], ['Mexico City', 2240], ['Pikes Peak', 4300]]) {
          const b = document.createElement('button'); b.textContent = n;
          b.onclick = () => { this.setup.altitudeM = alt; this.apply(`${n}: ${alt} m`); };
          row.append(b);
        }
        body.append(row);
        section('Wind');
        // wind is not part of the setup (it is the weather, not the car)
        const wind = () => this.applyWind();
        this.field(body, this.wind, { speed: 0, from: 90 }, ['speed', 'Wind speed', 0, 25, 0.5, 'm/s', 1, 'A steady wind: changes drag and downforce, and pushes the car sideways.'], wind);
        this.field(body, this.wind, { speed: 0, from: 90 }, ['from', 'From', 0, 355, 5, '°', 0, 'Direction the wind blows from, relative to the start line heading: 0 = head-on, 90 = from the left, 180 = tailwind.'], wind);
      }
    }
    this.updateDiff();
  }

  updateDiff() {
    const el = this.panel.querySelector('#gDiff'); if (!this.setup || !this.stock) return;
    const n = (a, b) => Object.keys(a).filter((k) => typeof a[k] !== 'object' && JSON.stringify(a[k]) !== JSON.stringify(b[k])).length;
    const c = n(this.setup.front, this.stock.front) + n(this.setup.rear, this.stock.rear) + n(this.setup, this.stock);
    el.textContent = c ? `${c} setting${c > 1 ? 's' : ''} changed from stock (highlighted).` : 'Stock setup.';
  }

  // ---------- HUD: tyre temperature and camber, aero ----------
  buildHud() {
    const d = document.createElement('div');
    d.className = 'panel'; d.id = 'hTyres';
    d.title = 'Tyre tread temperature and camber (negative = top in); colour = how far from the working window. Aero: downforce and drag from the physics. Roll centres: front / rear height above the ground from the suspension linkage (cars with wishbones or struts); lowering the car drops them.';
    d.innerHTML = `<div class="tg">${['FL', 'FR', 'RL', 'RR'].map((n) => `<div>${n} <b data-t></b><br><span data-c></span></div>`).join('')}</div><div class="aero"></div>`;
    document.getElementById('hud').append(d);
    this.hud = d;
    this.tEls = [...d.querySelectorAll('[data-t]')]; this.cEls = [...d.querySelectorAll('[data-c]')];
    this.aeroEl = d.querySelector('.aero');
    this.hudTick = 0;
  }
  updateHud() {
    if (this.isBike() || ++this.hudTick % 6) return; // ~10 Hz is plenty to read
    const g = this.gs();
    for (let w = 0; w < 4; ++w) {
      const cam = g[14 + 4 * w] * 57.2958, t = g[15 + 4 * w], opt = g[16 + 4 * w], grip = g[17 + 4 * w];
      const off = t - opt;
      this.tEls[w].textContent = `${t.toFixed(0)}°C`;
      this.tEls[w].style.color = grip > 0.98 ? 'var(--good)' : off < 0 ? '#7cc4ff' : grip > 0.9 ? 'var(--warn)' : 'var(--bad)';
      this.tEls[w].parentElement.title = `${t.toFixed(0)} °C (window centred at ${opt.toFixed(0)} °C): ${(grip * 100).toFixed(0)}% grip`;
      this.cEls[w].textContent = `${cam >= 0 ? '+' : '−'}${Math.abs(cam).toFixed(1)}°`;
    }
    const down = (g[2] + g[3]) / 1000, drag = g[4] / 1000;
    let a = `Down ${down.toFixed(2)} kN · drag ${drag.toFixed(2)} kN`;
    if (Math.abs(g[12]) > 1e-6 || Math.abs(g[13]) > 1e-6) a += ` · roll centres ${(g[12] * 1000).toFixed(0)} / ${(g[13] * 1000).toFixed(0)} mm`;
    if (g[5] > 20) a += `<br>Wing ${(g[5] / 1000).toFixed(2)} kN${g[8] ? ' <b style="color:var(--bad)">STALLED</b>' : ''}`;
    if (g[9]) a += ' <b style="color:var(--bad)">FLOOR STALL</b>';
    if (Math.abs(g[1]) > 0.03 && g[0] > 5) a += `<br>Airflow yaw ${(g[1] * 57.3).toFixed(0)}°`;
    this.aeroEl.innerHTML = a;
  }
}
