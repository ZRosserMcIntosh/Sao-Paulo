// Golf Ball Aerodynamics: checks of the physics against measured data and
// against conservation laws. Run: node sao-paulo/golf/validate.mjs
// Exits non-zero if a check fails.
import * as P from './physics.js';

const MPH = 0.44704, YD = 0.9144;
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };
const pct = (a, b) => `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%`;

// TrackMan PGA Tour averages: club mph, attack deg, ball mph, launch deg,
// spin rpm, apex yd, landing angle deg, carry yd.
const TM = [
  ['Driver', 113, -1.3, 167, 10.9, 2686, 32, 37, 275],
  ['3-wood', 107, -2.9, 158, 9.2, 3655, 30, 43, 243],
  ['5-iron', 94, -3.1, 132, 12.1, 5361, 31, 47, 194],
  ['6-iron', 92, -3.7, 127, 14.1, 6231, 30, 47, 183],
  ['7-iron', 90, -3.9, 120, 16.3, 7097, 32, 50, 172],
  ['8-iron', 87, -4.2, 115, 18.1, 7998, 31, 50, 160],
  ['9-iron', 85, -4.3, 109, 20.4, 8647, 30, 51, 148],
  ['PW', 83, -4.7, 102, 24.2, 9304, 29, 52, 136],
];

console.log('\n1. Flight: measured launch -> carry, apex, landing angle (sea level, 15 C, no wind)');
for (const [n, , , bs, la, sp, ap, land, carry] of TM) {
  const f = P.fly('dimpled', bs * MPH, la, sp);
  const c = f.carry / YD, a = f.apex / YD;
  console.log(`     ${n.padEnd(7)} carry ${c.toFixed(0)} vs ${carry} (${pct(c, carry)})  apex ${a.toFixed(0)} vs ${ap}  land ${f.landAngle.toFixed(0)}° vs ${land}°`);
  check(Math.abs(c / carry - 1) < 0.06, `${n} carry within 6%`);
  check(Math.abs(a - ap) <= 4, `${n} apex within 4 yd`);
  check(Math.abs(f.landAngle - land) <= 7, `${n} landing angle within 7°`);
}

console.log('\n2. Integrator: halving the time step changes carry by < 0.05 m');
for (const [n, , , bs, la, sp] of [TM[0], TM[7]]) {
  const a = P.fly('dimpled', bs * MPH, la, sp), b = P.fly('dimpled', bs * MPH, la, sp, { dt: 0.002 });
  check(Math.abs(a.carry - b.carry) < 0.05, `${n}: ${a.carry.toFixed(3)} vs ${b.carry.toFixed(3)} m`);
}

console.log('\n3. Impact: forward model from TrackMan club delivery (dynamic loft solved for the launch)');
const iron = P.CLUBS.iron7;
for (const [n, cs, att, bs, la, sp] of TM.slice(2)) {
  let loft = la + 6;
  for (let i = 0; i < 100; ++i) loft += (la - P.impact(iron, cs * MPH, att, loft).launch) * 0.7;
  const q = P.impact(iron, cs * MPH, att, loft);
  console.log(`     ${n.padEnd(7)} dyn loft ${loft.toFixed(1)}°  ball ${(q.speed / MPH).toFixed(0)} vs ${bs} mph  spin ${q.rpm.toFixed(0)} vs ${sp} (${pct(q.rpm, sp)})`);
  check(Math.abs(q.rpm / sp - 1) < 0.12, `${n} spin within 12% (one tangential restitution for all irons)`);
  check(Math.abs(q.speed / (bs * MPH) - 1) < 0.06, `${n} ball speed within 6%`);
}
{
  const d = P.CLUBS.driver;
  let loft = 12;
  for (let i = 0; i < 100; ++i) loft += (10.9 - P.impact(d, 113 * MPH, -1.3, loft).launch) * 0.7;
  const q = P.impact(d, 113 * MPH, -1.3, loft);
  console.log(`     Driver  dyn loft ${loft.toFixed(1)}°  ball ${(q.speed / MPH).toFixed(0)} vs 167 mph (${pct(q.speed / MPH, 167)})  spin ${q.rpm.toFixed(0)} vs 2686 (${pct(q.rpm, 2686)})  [known residual]`);
  check(q.rpm < 3600 && q.rpm > 2000, 'Driver spin in the right range (gear effect lowers it)');
}

console.log('\n4. Impact: conservation and limits');
for (const k of Object.keys(P.CLUBS)) {
  const cl = P.CLUBS[k], q = P.impact(cl);
  // Linear momentum of ball + head is conserved.
  const p0 = [cl.M * q.club0[0], cl.M * q.club0[1]];
  const p1 = [cl.M * q.club1[0] + P.MASS * q.ball[0], cl.M * q.club1[1] + P.MASS * q.ball[1]];
  check(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 1e-9, `${cl.name}: momentum conserved`);
  // Energy does not increase.
  const e0 = 0.5 * cl.M * (q.club0[0] ** 2 + q.club0[1] ** 2);
  const e1 = 0.5 * cl.M * (q.club1[0] ** 2 + q.club1[1] ** 2) + 0.5 * P.MASS * q.speed ** 2 + 0.5 * P.IB * q.w ** 2 + 0.5 * cl.Ic * q.dOmega ** 2;
  check(e1 <= e0 * (1 + 1e-9), `${cl.name}: kinetic energy ${(e1 / e0 * 100).toFixed(1)}% of the club's (no energy created)`);
  check(!q.sliding, `${cl.name}: friction does not saturate (|Jt| < mu Jn)`);
  check(Math.abs(P.impulseFraction(q, q.tau) - 1) < 1e-12 && Math.abs(P.deflection(q, q.tc) - q.dmax) < 1e-12, `${cl.name}: impulse and deflection histories close`);
  console.log(`     ${cl.name}: contact ${(q.tau * 1e3).toFixed(2)} ms, peak compression ${(q.dmax * 1e3).toFixed(1)} mm, head turns ${q.dOmega.toFixed(0)} rad/s`);
}
// Rolling limit: et = 0, no gear effect -> Penner's closed form.
{
  const c = { ...P.CLUBS.iron7, et: 0, h: 0, b: 0 };
  const q = P.impact(c, 40, 0, 30);
  const vt = ((2 / 7) * 40 * Math.sin(Math.PI / 6)) / (1 + (2 * P.MASS) / (7 * c.M));
  check(Math.abs(q.w - (5 * vt) / (2 * P.R)) < 1e-6, 'rolling limit reproduces Penner (2003): w = 5 v_t / 2r');
}
// The inverse solve reproduces the presets' launch.
for (const [club, V, ang, rpm] of [['driver', 74.7, 10.9, 2686], ['iron7', 53.6, 16.3, 7097], ['wedge', 45.6, 24.2, 9304], ['driver', 74.7, 10.9, 0]]) {
  const q = P.solveImpact(P.CLUBS[club], V, ang, rpm);
  check(Math.abs(q.speed - V) < 0.05 && Math.abs(q.launch - ang) < 0.05 && Math.abs(q.rpm - rpm) < 5,
    `${club} delivery solved for ${V} m/s, ${ang}°, ${rpm} rpm: club ${q.V.toFixed(1)} m/s, attack ${q.attack.toFixed(1)}°, loft ${q.loft.toFixed(1)}°`);
}

console.log('\n5. Aerodynamic coefficients');
check(Math.abs(P.cdFromCp('dimpled', P.reynolds(70)) - P.cd0('dimpled', P.reynolds(70))) < 0.01, 'dimpled: surface-pressure integral matches Cd0');
check(Math.abs(P.cdFromCp('smooth', P.reynolds(70)) - P.cd0('smooth', P.reynolds(70))) < 0.03, 'smooth: surface-pressure integral matches Cd0');
check(Math.abs(P.cl('dimpled', 0.1) - 0.18) < 0.01 && Math.abs(P.cl('dimpled', 0.3) - 0.284) < 0.01, 'lift within the wind-tunnel band at S = 0.1 and 0.3');
check(P.cd0('dimpled', P.reynolds(10)) > 0.38 && P.cd0('dimpled', P.reynolds(25)) < 0.24, `golf ball drag crisis between 10 and 25 m/s (Cd0 ${P.cd0('dimpled', P.reynolds(10)).toFixed(2)} -> ${P.cd0('dimpled', P.reynolds(25)).toFixed(2)})`);
check(P.cd0('smooth', P.reynolds(70)) > 0.45, 'smooth sphere still subcritical at golf speeds');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
