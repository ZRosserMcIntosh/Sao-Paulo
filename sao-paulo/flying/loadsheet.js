// São Paulo World · flight test bed: weight and balance.
//
// The planned load (each payload station and fuel tank) for the next start,
// and its load sheet as the flight core computes it (avd_loadsheet): the same
// mass items the physics flies with. Placards and limits are shown, never
// enforced: an overloaded or out-of-balance airplane still flies, and flies
// like one. The load is saved per aircraft.

const LB = 2.20462;
const FLAG = { ramp: 1, takeoff: 2, landing: 4, zeroFuel: 8, cgFwd: 16, cgAft: 32, station: 64, group: 128 };
const kgLb = (kg) => `${Math.round(kg).toLocaleString()} kg · ${Math.round(kg * LB).toLocaleString()} lb`;

// el: container; A: the core; id: aircraft id (storage key); jet: arm in metres
// from the nose (jet) or inches aft of the datum (POH arms, the 172);
// onApply: restart with the planned load; store: { get, set }.
export function mountLoadSheet(el, { A, id, jet, onApply, store }) {
  const arm = (x) => (jet ? -x : -x / 0.0254);
  const armUnit = jet ? 'm' : 'in';
  const armFmt = (x) => (jet ? arm(x).toFixed(2) : arm(x).toFixed(1));

  // Restore the saved load for this aircraft (if it still fits the definition).
  let ls = A.loadsheet(true);
  const saved = store.get(`load:${id}`, null);
  if (saved && saved.s?.length === ls.stations.length && saved.t?.length === ls.tanks.length) {
    saved.s.forEach((kg, i) => A.avd_set_station(i, kg));
    saved.t.forEach((l, i) => A.avd_set_tank(i, l));
    ls = A.loadsheet(true);
  }
  const save = () => store.set(`load:${id}`, { s: ls.stations.map((s) => s.kg), t: ls.tanks.map((t) => t.litres) });

  el.innerHTML = '';
  const add = (html) => { const d = document.createElement('div'); d.innerHTML = html; el.appendChild(d.firstElementChild); return el.lastElementChild; };
  const rows = [];
  ls.stations.forEach((s, i) => {
    const row = add(`<label class="ctl"><span>${s.name}</span><input type="range" min="0" max="${Math.ceil(s.max * 1.6)}" step="1"><output></output></label>`);
    const inp = row.querySelector('input');
    inp.value = String(Math.round(s.kg));
    inp.addEventListener('input', () => { A.avd_set_station(i, +inp.value); update(); });
    rows.push({ kind: 's', i, row, inp });
  });
  ls.tanks.forEach((t, i) => {
    const row = add(`<label class="ctl"><span>${t.name}</span><input type="range" min="0" max="${Math.round(t.capacity)}" step="1"><output></output></label>`);
    const inp = row.querySelector('input');
    inp.value = String(Math.round(t.litres));
    inp.addEventListener('input', () => { A.avd_set_tank(i, +inp.value); update(); });
    rows.push({ kind: 't', i, row, inp });
  });
  const fuelRow = add('<div class="row" style="margin-top:8px"><button data-f="1">Full fuel</button><button data-f="0.5">Half</button><button data-f="0">Minimum</button></div>');
  fuelRow.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const f = +b.dataset.f;
    ls.tanks.forEach((t, i) => A.avd_set_tank(i, f ? f * t.capacity : t.unusable));
    rows.filter((r) => r.kind === 't').forEach((r) => { const t = ls.tanks[r.i]; r.inp.value = String(Math.round(f ? f * t.capacity : t.unusable)); });
    update();
    b.blur();
  }));
  const sheet = add('<div class="read sheet" style="margin-top:10px"></div>');
  const cv = add('<canvas class="envelope" width="560" height="320" aria-label="CG envelope: mass against CG position"></canvas>');
  const flags = add('<p class="note sheetFlags"></p>');
  const apply = add('<div class="row" style="margin-top:8px"><button class="primary">Fly with this load</button><span class="note" style="margin:0">applies at the next start</span></div>');
  apply.querySelector('button').addEventListener('click', (e) => { onApply(); e.currentTarget.blur(); });

  function update() {
    ls = A.loadsheet(true);
    save();
    for (const r of rows) {
      const out = r.row.querySelector('output');
      if (r.kind === 's') {
        const s = ls.stations[r.i];
        out.textContent = kgLb(s.kg);
        r.row.classList.toggle('over', s.kg > s.max + 1e-6);
        r.row.title = `placard ${Math.round(s.max)} kg (${Math.round(s.max * LB)} lb), arm ${armFmt(s.x)} ${armUnit}`;
      } else {
        const t = ls.tanks[r.i];
        out.textContent = `${Math.round(t.litres).toLocaleString()} L · ${kgLb(t.litres * ls.density)}`;
        r.row.title = `capacity ${Math.round(t.capacity)} L, unusable ${t.unusable.toFixed(1)} L`;
      }
    }
    const L = ls.limits, f = ls.flags;
    const lim = (v, max, bit) => (max > 0 ? `<b class="${f & bit ? 'bad' : ''}">${kgLb(v)}<small> / ${Math.round(max * LB).toLocaleString()} lb</small></b>` : `<b>${kgLb(v)}</b>`);
    const groups = ls.groups.map((g) => `<span>${g.name}</span><b class="${g.kg > g.max + 1e-6 ? 'bad' : ''}">${Math.round(g.kg)} / ${Math.round(g.max)} kg</b>`).join('');
    const cgOut = f & (FLAG.cgFwd | FLAG.cgAft);
    sheet.innerHTML =
      `<span>Basic empty</span><b>${kgLb(ls.basicEmpty)}</b>` +
      `<span>Payload</span><b>${kgLb(ls.payload)}</b>${groups}` +
      `<span>Zero fuel</span>${lim(ls.zeroFuel, L.zeroFuel, FLAG.zeroFuel)}` +
      `<span>Usable fuel</span><b>${kgLb(ls.fuelUsable)}</b>` +
      `<span>Ramp</span>${lim(ls.gross, L.ramp, FLAG.ramp)}` +
      `<span>Take-off</span>${lim(ls.gross, L.takeoff, FLAG.takeoff)}` +
      (L.landing > 0 && L.landing < L.takeoff ? `<span>Landing limit</span><b>${Math.round(L.landing * LB).toLocaleString()} lb</b>` : '') +
      `<span>CG</span><b class="${cgOut ? 'bad' : ''}">${armFmt(ls.cgX)} ${armUnit}<small> (${armFmt(ls.cgFwdLimit)}–${armFmt(ls.cgAftLimit)})</small></b>`;
    const msgs = [];
    if (f & FLAG.takeoff) msgs.push(`${Math.round((ls.gross - L.takeoff) * LB)} lb over the maximum take-off weight: longer roll, slower climb, higher stall speed`);
    else if (f & FLAG.ramp) msgs.push('over the maximum ramp weight');
    if (f & FLAG.zeroFuel) msgs.push('over the maximum zero-fuel weight (wing-root bending)');
    if (f & FLAG.cgFwd) msgs.push('CG forward of the limit: heavy nose, the elevator may not flare it');
    if (f & FLAG.cgAft) msgs.push('CG aft of the limit: light, unstable in pitch, hard to recover from a stall');
    if (f & FLAG.station) msgs.push(`over placard: ${ls.stations.filter((s) => s.kg > s.max + 1e-6).map((s) => s.name).join(', ')}`);
    if (f & FLAG.group) msgs.push(`over the combined limit: ${ls.groups.filter((g) => g.kg > g.max + 1e-6).map((g) => g.name).join(', ')}`);
    flags.textContent = msgs.length ? `Outside the limits: ${msgs.join('; ')}. It will still fly — like that.` : 'Within all published limits.';
    flags.classList.toggle('bad', msgs.length > 0);
    drawEnvelope();
  }

  // CG envelope: mass (up) against CG arm (aft to the right), the zero-fuel and
  // gross points joined by the fuel line.
  function drawEnvelope() {
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (!ls.fwd.length || !ls.aft.length) return;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink').trim() || '#e7ecf2', mute = css.getPropertyValue('--mute').trim() || '#93a0b2';
    const good = css.getPropertyValue('--good').trim() || '#36c483', bad = css.getPropertyValue('--bad').trim() || '#ef5d4f';
    const pts = [...ls.fwd.map(([m, x]) => [arm(x), m]), ...ls.aft.slice().reverse().map(([m, x]) => [arm(x), m])];
    const xs = [...pts.map((p) => p[0]), arm(ls.cgX), arm(ls.zeroFuelX)], ys = [...pts.map((p) => p[1]), ls.gross, ls.zeroFuel, ls.limits.takeoff];
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const padX = (x1 - x0) * 0.12 || 1, padY = (y1 - y0) * 0.1 || 1;
    const L = 64, R = 14, T = 14, B = 40;
    const px = (a) => L + (a - (x0 - padX)) / (x1 - x0 + 2 * padX) * (W - L - R);
    const py = (m) => H - B - (m - (y0 - padY)) / (y1 - y0 + 2 * padY) * (H - T - B);
    ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(54,196,131,0.12)'; ctx.strokeStyle = good;
    ctx.beginPath(); pts.forEach(([a, m], i) => (i ? ctx.lineTo(px(a), py(m)) : ctx.moveTo(px(a), py(m)))); ctx.closePath(); ctx.fill(); ctx.stroke();
    // Maximum take-off weight.
    ctx.strokeStyle = mute; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(L, py(ls.limits.takeoff)); ctx.lineTo(W - R, py(ls.limits.takeoff)); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '600 20px ui-monospace, monospace'; ctx.fillStyle = mute; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('MTOW', W - R - 4, py(ls.limits.takeoff) - 3);
    // Axes labels.
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(`CG ${armUnit} ${jet ? 'aft of nose' : 'aft of datum'} →`, (L + W - R) / 2, H - B + 12);
    ctx.save(); ctx.translate(18, (T + H - B) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('mass', 0, 0); ctx.restore();
    // Fuel line and the two points.
    const out = ls.flags & (FLAG.cgFwd | FLAG.cgAft | FLAG.takeoff);
    ctx.strokeStyle = ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px(arm(ls.zeroFuelX)), py(ls.zeroFuel)); ctx.lineTo(px(arm(ls.cgX)), py(ls.gross)); ctx.stroke();
    ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(px(arm(ls.zeroFuelX)), py(ls.zeroFuel), 6, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = out ? bad : good; ctx.beginPath(); ctx.arc(px(arm(ls.cgX)), py(ls.gross), 9, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('ZFW', px(arm(ls.zeroFuelX)) + 10, py(ls.zeroFuel));
    ctx.fillText('gross', px(arm(ls.cgX)) + 13, py(ls.gross));
  }

  update();
  return { refresh: update };
}
