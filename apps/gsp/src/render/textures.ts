// Procedural textures (canvas): asphalt, concrete, grass detail, liveries, sign faces, billboards.
// Nothing is downloaded.
import * as THREE from 'three';

const cache = new Map<string, THREE.Texture>();

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!] as const;
}
function rand(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function noiseTexture(key: string, size: number, base: [number, number, number], spread: number, speck: number, seed = 1, repeat = 1): THREE.Texture {
  const k = `n:${key}`;
  if (cache.has(k)) return cache.get(k)!;
  const [c, g] = canvas(size, size);
  const img = g.createImageData(size, size), r = rand(seed);
  for (let i = 0; i < size * size; ++i) {
    const n = (r() - 0.5) * spread + (r() < speck ? (r() - 0.3) * spread * 3 : 0);
    img.data[4 * i] = Math.max(0, Math.min(255, base[0] + n));
    img.data[4 * i + 1] = Math.max(0, Math.min(255, base[1] + n));
    img.data[4 * i + 2] = Math.max(0, Math.min(255, base[2] + n));
    img.data[4 * i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // soft blotches
  for (let k2 = 0; k2 < size / 3; ++k2) {
    g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${0.008 + r() * 0.014})`;
    g.beginPath(); g.arc(r() * size, r() * size, 2 + r() * size * 0.05, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  cache.set(k, t);
  return t;
}

export const asphaltTexture = () => noiseTexture('asphalt', 512, [74, 74, 76], 26, 0.04, 3);
export const shoulderTexture = () => noiseTexture('shoulder', 512, [92, 90, 88], 30, 0.05, 5);
export const concreteTexture = () => noiseTexture('concrete', 512, [178, 174, 166], 18, 0.02, 7);
export const padTexture = () => noiseTexture('pad', 512, [64, 64, 67], 20, 0.03, 9);
export const detailTexture = () => noiseTexture('detail', 256, [128, 128, 128], 70, 0.08, 11);

// Test pad markings: skid pad circle, slalom gates, braking zone, the GSP crest.
export function padMarkings(): THREE.Texture {
  const k = 'padmarks';
  if (cache.has(k)) return cache.get(k)!;
  const W = 2048, H = 1352; // 340 m x 223 m
  const [c, g] = canvas(W, H);
  g.clearRect(0, 0, W, H);
  const sx = W / 340, sy = H / 223;
  const m = (a: number, b: number) => [(a + 170) * sx, (b - 32) * sy] as const;
  g.strokeStyle = 'rgba(240,240,235,0.85)';
  g.lineWidth = 0.2 * sx;
  // skid pad: two circles r 30
  for (const [a, b] of [[80, 165]]) for (const r of [28, 32]) { const [x, y] = m(a, b); g.beginPath(); g.ellipse(x, y, r * sx, r * sy, 0, 0, Math.PI * 2); g.stroke(); }
  // slalom line
  g.setLineDash([3 * sx, 3 * sx]);
  { const [x0, y] = m(-140, 70), [x1] = m(70, 70); g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); }
  g.setLineDash([]);
  // braking zone boxes
  g.strokeStyle = 'rgba(255,190,40,0.9)';
  for (let k2 = 0; k2 < 5; ++k2) { const [x, y] = m(-150 + k2 * 25, 110); g.strokeRect(x, y, 22 * sx, 12 * sy); }
  // text
  g.fillStyle = 'rgba(240,240,235,0.75)';
  g.font = `bold ${10 * sx}px sans-serif`;
  g.textAlign = 'center';
  { const [x, y] = m(-40, 220); g.fillText('GSP PROVING GROUND', x, y); }
  g.font = `bold ${5 * sx}px sans-serif`;
  { const [x, y] = m(-40, 232); g.fillText('AUTHORIZED VEHICLES ONLY · NO DONUTS (THIS MEANS YOU, EARL)', x, y); }
  { const [x, y] = m(-125, 102); g.fillText('BRAKE HERE', x, y); }
  { const [x, y] = m(80, 205); g.fillText('SKID PAD', x, y); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  cache.set(k, t);
  return t;
}

// Police livery for the body-side UVs: u along the car (rear 0 -> front 1 as seen on that side),
// v from the sill (0) to the roof (1). Left side occupies the top half of the texture, right the bottom.
export function policeLivery(unit: string): THREE.Texture {
  const k = 'livery:' + unit;
  if (cache.has(k)) return cache.get(k)!;
  const W = 2048, H = 1024;
  const [c, g] = canvas(W, H);
  const blue = '#173a7a', silver = '#c3c8ce', orange = '#f08a1c';
  for (const half of [0, 1]) {
    const y0 = half * 512;
    // blue body
    g.fillStyle = blue; g.fillRect(0, y0, W, 512);
    // silver door band (lower half of the side, between the wheels)
    g.fillStyle = silver;
    g.beginPath();
    g.moveTo(0.27 * W, y0 + 512 * 0.22);
    g.lineTo(0.76 * W, y0 + 512 * 0.22);
    g.quadraticCurveTo(0.8 * W, y0 + 512 * 0.42, 0.78 * W, y0 + 512 * 0.66);
    g.lineTo(0.25 * W, y0 + 512 * 0.66);
    g.quadraticCurveTo(0.23 * W, y0 + 512 * 0.42, 0.27 * W, y0 + 512 * 0.22);
    g.fill();
    // orange pinstripes
    g.fillStyle = orange;
    g.fillRect(0, y0 + 512 * 0.675, W, 512 * 0.018);
    g.fillRect(0.06 * W, y0 + 512 * 0.2, 0.9 * W, 512 * 0.01);
    // lettering (reads front-to-back correctly on each side: u already flipped per side)
    g.save();
    g.translate(0.505 * W, y0 + 512 * 0.47);
    g.scale(1, 1);
    g.fillStyle = orange;
    g.strokeStyle = '#0d1d3d';
    g.lineWidth = 7;
    g.font = '900 92px "Arial Black", Impact, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.strokeText('STATE PURSUIT', 0, 0);
    g.fillText('STATE PURSUIT', 0, 0);
    g.font = 'bold 34px Arial, sans-serif';
    g.fillStyle = '#0d1d3d';
    g.fillText('GEORGIA · PEACH STATE PATROL', 0, 78);
    g.restore();
    // peach crest on the front door
    const cx = 0.69 * W, cy = y0 + 512 * 0.43;
    g.fillStyle = '#f5a24a'; g.beginPath(); g.arc(cx, cy, 52, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffcf8a'; g.beginPath(); g.arc(cx - 14, cy - 14, 24, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#7a3d10'; g.lineWidth = 5; g.beginPath(); g.arc(cx, cy, 52, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#3b7a2c'; g.beginPath(); g.ellipse(cx + 18, cy - 58, 26, 11, -0.5, 0, Math.PI * 2); g.fill();
    // unit number on the rear quarter
    g.fillStyle = orange; g.font = '900 120px "Arial Black", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(unit, 0.13 * W, y0 + 512 * 0.45);
    // "DIAL *GSP" on the rear fender
    g.font = 'bold 30px Arial'; g.fillStyle = silver; g.fillText('DIAL *477', 0.13 * W, y0 + 512 * 0.62);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  cache.set(k, t);
  return t;
}

// Roof number (for the helicopter that never comes)
export function roofNumber(unit: string): THREE.Texture {
  const k = 'roof:' + unit;
  if (cache.has(k)) return cache.get(k)!;
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#c3c8ce'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#173a7a'; g.font = '900 150px Arial Black, Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(unit, 128, 136);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; cache.set(k, t); return t;
}

export type SignStyleName = 'speed' | 'warning' | 'guide' | 'info' | 'welcome' | 'marker';

export function signFace(style: SignStyleName, legend: string): THREE.Texture {
  const k = `sign:${style}:${legend}`;
  if (cache.has(k)) return cache.get(k)!;
  const lines = legend.split('|');
  const big = style === 'guide' || style === 'info' || style === 'welcome';
  const [c, g] = canvas(big ? 512 : 256, big ? 300 : style === 'marker' ? 512 : 320);
  const W = c.width, H = c.height;
  const bg = style === 'warning' ? '#f3c312' : style === 'guide' ? '#0f6b3a' : style === 'info' ? '#1d3f8f' : style === 'welcome' ? '#f6f1e3' : style === 'marker' ? '#0f6b3a' : '#f4f4f0';
  const fg = style === 'warning' || style === 'speed' ? '#111' : style === 'welcome' ? '#173a7a' : '#f4f4f0';
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.strokeStyle = fg; g.lineWidth = big ? 10 : 8; g.strokeRect(10, 10, W - 20, H - 20);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (style === 'speed') {
    g.font = 'bold 50px Arial'; g.fillText(lines[0].split(' ')[0] ?? '', W / 2, 62); g.fillText(lines[0].split(' ')[1] ?? '', W / 2, 116);
    g.font = 'bold 130px Arial'; g.fillText(lines[1] ?? '', W / 2, 225);
  } else if (style === 'warning') {
    g.font = 'bold 54px Arial'; g.fillText(lines[0], W / 2, H / 2 - 30);
    g.save(); g.translate(W / 2, H / 2 + 60); g.scale(lines[1] === 'LEFT' ? -1 : 1, 1);
    g.lineWidth = 16; g.beginPath(); g.moveTo(-40, 30); g.quadraticCurveTo(-40, -30, 30, -30); g.stroke();
    g.beginPath(); g.moveTo(20, -55); g.lineTo(55, -30); g.lineTo(20, -5); g.fill(); g.restore();
  } else if (style === 'marker') {
    g.font = 'bold 60px Arial'; g.fillText('MILE', W / 2, 120); g.font = 'bold 110px Arial'; g.fillText(lines[0], W / 2, 300);
  } else if (style === 'welcome') {
    g.fillStyle = '#f08a1c'; g.beginPath(); g.arc(W / 2, 92, 46, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3b7a2c'; g.beginPath(); g.ellipse(W / 2 + 18, 44, 22, 9, -0.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = fg; g.font = 'bold 40px Georgia, serif'; g.fillText(lines[0], W / 2, 178); g.font = 'bold 66px Georgia, serif'; g.fillText(lines[1] ?? '', W / 2, 236);
    g.font = 'italic 22px Georgia, serif'; g.fillText('We\'re so glad you\'re here (please slow down)', W / 2, 278);
  } else {
    g.font = `bold ${lines.length > 1 ? 64 : 80}px Arial`;
    lines.forEach((l, i) => g.fillText(l, W / 2, H / 2 + (i - (lines.length - 1) / 2) * 82));
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  cache.set(k, t);
  return t;
}

export function billboardFace(text: string, sub: string, color: string): THREE.Texture {
  const k = `bb:${text}`;
  if (cache.has(k)) return cache.get(k)!;
  const [c, g] = canvas(1024, 384);
  const grad = g.createLinearGradient(0, 0, 0, 384);
  grad.addColorStop(0, color); grad.addColorStop(1, '#111');
  g.fillStyle = grad; g.fillRect(0, 0, 1024, 384);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '900 96px "Arial Black", Impact, sans-serif'; g.fillText(text, 512, 150, 980);
  g.font = 'italic bold 52px Georgia, serif'; g.fillStyle = '#ffe3a6'; g.fillText(sub, 512, 272, 960);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; cache.set(k, t); return t;
}

// Overhead guide sign on the overpass
export function guideSign(): THREE.Texture {
  const k = 'guide-overhead';
  if (cache.has(k)) return cache.get(k)!;
  const [c, g] = canvas(1024, 400);
  g.fillStyle = '#0f6b3a'; g.fillRect(0, 0, 1024, 400);
  g.strokeStyle = '#f4f4f0'; g.lineWidth = 10; g.strokeRect(12, 12, 1000, 376);
  // interstate shield
  g.fillStyle = '#1d3f8f'; g.beginPath(); g.moveTo(60, 60); g.lineTo(200, 60); g.lineTo(200, 150); g.quadraticCurveTo(130, 220, 60, 150); g.fill();
  g.fillStyle = '#c0392b'; g.fillRect(60, 50, 140, 30);
  g.fillStyle = '#fff'; g.font = 'bold 26px Arial'; g.textAlign = 'center'; g.fillText('INTERSTATE', 130, 72);
  g.font = 'bold 56px Arial'; g.fillText('GSP', 130, 135);
  g.textAlign = 'left'; g.fillStyle = '#f4f4f0';
  g.font = 'bold 60px Arial'; g.fillText('Atlanta', 250, 110);
  g.font = 'bold 52px Arial'; g.fillText('Alabama  (Don\'t)', 250, 200);
  g.font = 'bold 40px Arial'; g.fillText('Waffle Shop  ·  1 MILE', 250, 290);
  g.textAlign = 'right'; g.font = 'bold 60px Arial'; g.fillText('69', 970, 110); g.fillText('∞', 970, 200);
  g.fillStyle = '#f3c312'; g.font = 'bold 34px Arial'; g.textAlign = 'center'; g.fillText('EXIT ONLY ↓', 512, 360);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; cache.set(k, t); return t;
}
