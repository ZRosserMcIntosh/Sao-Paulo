// The block texture atlas, a port of TextureAtlas.java: 16x16-pixel tiles painted in code, so
// there are no image files. The painters are deterministic hash noise.
export const TILE = 16, GRID = 16, SIZE = TILE * GRID;

export const T = {
  GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3, SAND: 4, WATER: 5, LOG_SIDE: 6, LOG_TOP: 7, LEAVES: 8, COBBLE: 9,
  BEDROCK: 10, GRAVEL: 11, PLANKS: 12, GLASS: 13, COAL_ORE: 14, IRON_ORE: 15, SNOW: 16, ASPHALT: 17, PAINT_WHITE: 18,
  PAINT_YELLOW: 19, CICLOVIA: 20, SIDEWALK: 21, GRANITE: 22, PORTUGUESE: 23, CURB: 24, CONCRETE: 25, MASP_RED: 26,
  WINDOW: 27, FACADE_WHITE: 28, FACADE_GRAY: 29, FACADE_DARK: 30, BRICK: 31, STUCCO_CREAM: 32, STUCCO_OCHRE: 33,
  STUCCO_PEACH: 34, ROOF: 35, FLOOR: 36, STEEL: 37, FENCE: 38, POLE: 39, LAMP: 40, SIGN_BLUE: 41, ORELHAO_BLUE: 42,
  ORELHAO_YELLOW: 43, BIN_ORANGE: 44, TACTILE: 45, RED_TILE: 46, PAVER: 47, PARK_FLOOR: 48, PARK_FLOOR_SIDE: 49,
  PATH: 50, BELVEDERE: 51, CLAY_ROOF: 52, PLAIN: 53,
};

export const u0 = (tile) => (tile % GRID) / GRID;
export const v0 = (tile) => Math.floor(tile / GRID) / GRID;

/** Integer hash noise in [0, 1), the same as the Java version. */
function h(x, y, seed) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n & 0x7fffffff) / 0x7fffffff;
}
const mod = (a, b) => ((a % b) + b) % b;
function vn(x, y, cell, seed) {
  const cells = TILE / cell, fx = x / cell, fy = y / cell;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  let tx = fx - x0, ty = fy - y0;
  tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
  const a = h(mod(x0, cells), mod(y0, cells), seed), b = h(mod(x0 + 1, cells), mod(y0, cells), seed);
  const c = h(mod(x0, cells), mod(y0 + 1, cells), seed), d = h(mod(x0 + 1, cells), mod(y0 + 1, cells), seed);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

export class Atlas {
  constructor() {
    this.px = new Uint8ClampedArray(SIZE * SIZE * 4);
    paintAll(this);
  }
  set(t, x, y, r, g, b, a = 255) {
    const i = ((Math.floor(t / GRID) * TILE + y) * SIZE + (t % GRID) * TILE + x) * 4;
    this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; this.px[i + 3] = a;
  }
  setK(t, x, y, rgb, k) { this.set(t, x, y, rgb[0] * k, rgb[1] * k, rgb[2] * k, 255); }
  get(t, x, y) {
    const i = ((Math.floor(t / GRID) * TILE + y) * SIZE + (t % GRID) * TILE + x) * 4;
    return [this.px[i], this.px[i + 1], this.px[i + 2], this.px[i + 3]];
  }
  averageColor(t) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const c = this.get(t, x, y);
      if (c[3] < 40) continue;
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
    return n ? [r / n / 255, g / n / 255, b / n / 255] : [1, 1, 1];
  }
  /** Uploads as a WebGL2 texture with nearest filtering and limited mipmaps. */
  upload(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(this.px.buffer));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 3); // 16 px tiles: 2 px is the last level that does not bleed
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    return tex;
  }
  /** A tile as a data URL, for the hotbar icons. */
  tileURL(t, scale = 3) {
    const c = document.createElement('canvas');
    c.width = c.height = TILE * scale;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const img = new ImageData(TILE, TILE);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const p = this.get(t, x, y), i = (y * TILE + x) * 4;
      img.data[i] = p[0]; img.data[i + 1] = p[1]; img.data[i + 2] = p[2]; img.data[i + 3] = p[3];
    }
    const s = document.createElement('canvas'); s.width = s.height = TILE;
    s.getContext('2d').putImageData(img, 0, 0);
    g.drawImage(s, 0, 0, TILE * scale, TILE * scale);
    return c.toDataURL();
  }
}

const c = (r, g, b) => [r, g, b];

function paintAll(A) {
  const noisy = (t, rgb, fine, coarse, seed) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      A.setK(t, x, y, rgb, 1 + (h(x, y, seed) - 0.5) * fine + (vn(x, y, 8, seed + 1) - 0.5) * coarse);
    }
  };
  const slabs = (t, col, size, seed) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const joint = x % size === size - 1 || y % size === size - 1;
      const slab = (h(Math.floor(x / size), Math.floor(y / size), seed) - 0.5) * 0.1;
      A.setK(t, x, y, col, joint ? 0.78 : 0.94 + slab + h(x, y, seed + 1) * 0.08);
    }
  };
  const wall = (t, col, seed) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const joint = y === 15 || x === 15;
      A.setK(t, x, y, col, joint ? 0.85 : 0.95 + h(x, y, seed) * 0.07 + (vn(x, y, 8, seed + 1) - 0.5) * 0.06);
    }
  };
  const shiny = (t, col, seed) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) A.setK(t, x, y, col, 0.9 + h(x, y, seed) * 0.08 + (x > 3 && x < 6 ? 0.25 : 0));
  };
  const paint = (t, col, seed) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      if (h(x, y, seed) < 0.08) A.setK(t, x, y, c(70, 70, 72), 1);
      else A.setK(t, x, y, col, 0.92 + h(x, y, seed + 1) * 0.1);
    }
  };
  const copy = (from, to) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) { const p = A.get(from, x, y); A.set(to, x, y, p[0], p[1], p[2], p[3]); }
  };
  const ore = (t, col, seed) => {
    for (let i = 0; i < 5; i++) {
      const cx = 2 + Math.floor(h(i, 0, seed) * 12), cy = 2 + Math.floor(h(i, 1, seed) * 12);
      for (let k = 0; k < 4; k++) {
        const x = cx + Math.floor(h(i, k, seed + 1) * 3) - 1, y = cy + Math.floor(h(k, i, seed + 2) * 3) - 1;
        A.setK(t, Math.max(0, Math.min(15, x)), Math.max(0, Math.min(15, y)), col, 0.85 + h(x, y, seed) * 0.3);
      }
    }
  };
  const cells = (t, stone, mortar, seed) => {
    const sx = [], sy = [];
    for (let i = 0; i < 7; i++) for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      sx.push(h(i, 0, seed) * 16 + ox * 16); sy.push(h(i, 1, seed) * 16 + oy * 16);
    }
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let k = 0; k < sx.length; k++) {
        const d = Math.hypot(x + 0.5 - sx[k], y + 0.5 - sy[k]);
        if (d < d1) { d2 = d1; d1 = d; best = Math.floor(k / 9); } else if (d < d2) d2 = d;
      }
      if (d2 - d1 < 1.2) A.setK(t, x, y, mortar, 0.9 + h(x, y, seed + 1) * 0.2);
      else A.setK(t, x, y, stone, 0.82 + h(best, 2, seed) * 0.3 + (h(x, y, seed + 2) - 0.5) * 0.1);
    }
  };

  const dirt = c(134, 96, 67), grass = c(98, 160, 58), stone = c(126, 126, 128);
  noisy(T.DIRT, dirt, 0.35, 0.25, 1);
  for (let i = 0; i < 10; i++) A.setK(T.DIRT, Math.floor(h(i, 0, 2) * 16), Math.floor(h(i, 1, 2) * 16), c(96, 70, 50), 1);
  noisy(T.GRASS_TOP, grass, 0.3, 0.25, 3);
  for (let i = 0; i < 18; i++) A.setK(T.GRASS_TOP, Math.floor(h(i, 0, 4) * 16), Math.floor(h(i, 1, 4) * 16), h(i, 2, 4) < 0.5 ? c(70, 128, 40) : c(130, 190, 80), 1);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const edge = 3 + Math.floor(h(x, 0, 5) * 3);
    if (y < edge) A.setK(T.GRASS_SIDE, x, y, grass, 0.85 + h(x, y, 6) * 0.3);
    else A.setK(T.GRASS_SIDE, x, y, dirt, 0.85 + h(x, y, 7) * 0.3);
  }
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    let k = 0.85 + h(x, y, 8) * 0.2 + (vn(x, y, 4, 9) - 0.5) * 0.25;
    if (vn(x, y, 8, 10) > 0.72) k *= 0.82;
    A.setK(T.STONE, x, y, stone, k);
  }
  copy(T.STONE, T.COAL_ORE); copy(T.STONE, T.IRON_ORE);
  ore(T.COAL_ORE, c(35, 35, 38), 11); ore(T.IRON_ORE, c(214, 170, 130), 12);
  noisy(T.SAND, c(219, 207, 160), 0.18, 0.1, 13);
  noisy(T.SNOW, c(242, 246, 250), 0.08, 0.05, 14);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const v = h(x >> 1, y >> 1, 16);
    const col = v < 0.3 ? c(96, 92, 90) : v < 0.6 ? c(150, 143, 138) : v < 0.85 ? c(120, 116, 112) : c(170, 160, 150);
    A.setK(T.GRAVEL, x, y, col, 0.9 + h(x, y, 17) * 0.2);
    const w = h(x, y, 18);
    A.setK(T.BEDROCK, x, y, w < 0.4 ? c(40, 40, 42) : w < 0.8 ? c(85, 85, 88) : c(130, 130, 132), 1);
    const wv = Math.sin((x + y * 0.5) * 0.8 + vn(x, y, 4, 19) * 4);
    A.set(T.WATER, x, y, 50 + wv * 12, 100 + wv * 16, 205 + wv * 10, 170);
    const stripe = (x % 4 === 0 || (x + Math.floor(h(Math.floor(y / 3), x, 20) * 2)) % 5 === 0) ? 0.72 : 1;
    A.setK(T.LOG_SIDE, x, y, c(106, 82, 50), stripe * (0.9 + h(x, y, 21) * 0.18));
    const r = Math.hypot(x - 7.5, y - 7.5);
    if (r > 6.6) A.setK(T.LOG_TOP, x, y, c(106, 82, 50), 0.85 + h(x, y, 22) * 0.2);
    else A.setK(T.LOG_TOP, x, y, c(176, 142, 90), (Math.floor(r) % 2 === 0 ? 0.85 : 1.0) * (0.95 + h(x, y, 23) * 0.1));
    if (h(x, y, 24) < 0.18) A.set(T.LEAVES, x, y, 0, 0, 0, 0);
    else A.setK(T.LEAVES, x, y, c(62, 128, 40), 0.7 + vn(x, y, 4, 25) * 0.45 + (h(x, y, 26) - 0.5) * 0.25);
    const row = y >> 2;
    const seam = y % 4 === 3 || ((x + row * 7) % 16 === 0);
    A.setK(T.PLANKS, x, y, c(176, 138, 82), seam ? 0.66 : 0.9 + h(Math.floor(x / 3), y, 28) * 0.1 + (h(row, 0, 29) - 0.5) * 0.12);
    const frame = x === 0 || y === 0 || x === 15 || y === 15;
    const glint = (x - y === 3 || x - y === 4) && x > 4 && x < 13 || (x - y === -5 && x > 2 && x < 7);
    if (frame) A.set(T.GLASS, x, y, 220, 236, 240, 230);
    else if (glint) A.set(T.GLASS, x, y, 255, 255, 255, 150);
    else A.set(T.GLASS, x, y, 200, 230, 240, 38);
    if (frame) A.set(T.WINDOW, x, y, 38, 40, 44, 255);
    else {
      const refl = (x + y > 9 && x + y < 13) || (x + y > 19 && x + y < 21) ? 50 : 0, sky = (15 - y) * 2.5;
      A.set(T.WINDOW, x, y, 55 + refl + sky * 0.5, 80 + refl + sky, 98 + refl + sky * 1.3, 195);
    }
  }
  cells(T.COBBLE, c(128, 128, 128), c(70, 70, 72), 27);

  // ---- São Paulo ----
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const v = h(x, y, 30);
    A.setK(T.ASPHALT, x, y, v > 0.93 ? c(120, 120, 118) : v < 0.07 ? c(38, 38, 40) : c(62, 62, 65), 0.92 + vn(x, y, 8, 31) * 0.16);
  }
  paint(T.PAINT_WHITE, c(236, 236, 230), 32);
  paint(T.PAINT_YELLOW, c(232, 190, 42), 33);
  noisy(T.CICLOVIA, c(172, 52, 44), 0.18, 0.12, 34);
  slabs(T.SIDEWALK, c(188, 183, 172), 8, 35);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const v = h(x, y, 36);
    const col = v < 0.12 ? c(60, 60, 64) : v < 0.2 ? c(205, 200, 196) : v < 0.25 ? c(170, 140, 130) : c(152, 152, 150);
    A.setK(T.GRANITE, x, y, col, x === 15 || y === 15 ? 0.7 : 0.95 + h(x, y, 37) * 0.1);
    // Portuguese stone: the black-and-white wave mosaic in 2 px tesserae
    const tx = x >> 1, ty = y >> 1;
    const black = Math.sin(tx * 0.9 + Math.sin(ty * 0.7) * 1.8) > 0.25;
    A.setK(T.PORTUGUESE, x, y, black ? c(42, 42, 44) : c(228, 226, 220), x % 2 === 1 && y % 2 === 1 ? 0.75 : 0.92 + h(tx, ty, 38) * 0.12);
    A.setK(T.CURB, x, y, c(150, 150, 143), (y < 2 ? 1.15 : 0.95) + h(x, y, 39) * 0.1);
    let k = 0.92 + h(x, y, 40) * 0.12 + (vn(x, y, 4, 41) - 0.5) * 0.12;
    if (y % 8 === 7) k *= 0.85;
    if ((x === 3 || x === 12) && (y === 3 || y === 11)) k *= 0.6;
    A.setK(T.CONCRETE, x, y, c(146, 143, 137), k);
    let mk = 0.93 + h(x, y, 42) * 0.1;
    if (x === 0 || y === 0) mk = 1.15;
    if (x === 15 || y === 15) mk = 0.78;
    A.setK(T.MASP_RED, x, y, c(200, 22, 32), mk);
  }
  wall(T.FACADE_WHITE, c(222, 218, 208), 43);
  wall(T.FACADE_GRAY, c(152, 152, 152), 44);
  wall(T.FACADE_DARK, c(78, 80, 86), 45);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const row = y >> 2, mortar = y % 4 === 3 || (x + (row % 2) * 4) % 8 === 7;
    A.setK(T.BRICK, x, y, mortar ? c(190, 182, 170) : c(156, 82, 62), mortar ? 1 : 0.88 + h(x >> 1, y, 46) * 0.2);
  }
  noisy(T.STUCCO_CREAM, c(212, 196, 162), 0.1, 0.12, 47);
  noisy(T.STUCCO_OCHRE, c(196, 160, 104), 0.1, 0.12, 48);
  noisy(T.STUCCO_PEACH, c(222, 176, 150), 0.1, 0.12, 49);
  slabs(T.FLOOR, c(176, 172, 164), 8, 51);
  slabs(T.RED_TILE, c(156, 78, 58), 8, 59);
  slabs(T.BELVEDERE, c(188, 180, 166), 16, 67);
  shiny(T.ORELHAO_BLUE, c(42, 96, 176), 55);
  shiny(T.ORELHAO_YELLOW, c(232, 192, 34), 56);
  noisy(T.PATH, c(170, 152, 120), 0.25, 0.15, 66);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    A.setK(T.ROOF, x, y, c(104, 104, 106), 0.8 + h(x, y, 50) * 0.35);
    let sk = 0.9 + h(0, y, 52) * 0.12;
    if ((x === 2 || x === 13) && (y === 2 || y === 13)) sk = 1.4;
    A.setK(T.STEEL, x, y, c(64, 66, 70), sk);
    const bar = x % 4 === 1, rail = y === 1 || y === 2 || y === 13;
    if (bar || rail) A.setK(T.FENCE, x, y, c(40, 42, 46), bar ? 1.1 : 0.9); else A.set(T.FENCE, x, y, 0, 0, 0, 0);
    A.setK(T.POLE, x, y, c(156, 152, 144), 0.88 + h(x, y >> 2, 53) * 0.18);
    A.set(T.LAMP, x, y, 255, 246, 210 + Math.hypot(x - 7.5, y - 7.5) * 3);
    const border = x === 1 || x === 14 || y === 3 || y === 12, text = y > 5 && y < 10 && x > 3 && x < 12 && h(x, y, 54) > 0.45;
    if (y < 3 || y > 12) A.setK(T.SIGN_BLUE, x, y, c(160, 165, 170), 0.9);
    else A.setK(T.SIGN_BLUE, x, y, border || text ? c(235, 235, 235) : c(30, 80, 158), 1);
    const slot = y % 5 === 2 && x > 2 && x < 13;
    A.setK(T.BIN_ORANGE, x, y, slot ? c(80, 40, 20) : c(226, 104, 30), 0.92 + h(x, y, 57) * 0.12);
    A.setK(T.TACTILE, x, y, c(218, 180, 42), x % 4 === 1 && y % 4 === 1 ? 1.2 : 0.92 + h(x, y, 58) * 0.08);
    const bx = (x + (y >> 3) * 4) % 8, by = y % 8;
    const joint = bx === 0 || (by === 0 && bx < 4) || (by === 4 && bx >= 4);
    A.setK(T.PAVER, x, y, c(146, 132, 120), joint ? 0.7 : 0.92 + h(x >> 2, y >> 2, 60) * 0.15);
    const pv = h(x, y, 61);
    const pcol = pv < 0.2 ? c(96, 120, 50) : pv < 0.35 ? c(120, 86, 46) : c(76, 70, 46);
    A.setK(T.PARK_FLOOR, x, y, pcol, 0.85 + h(x, y, 62) * 0.3);
    if (y < 2 + Math.floor(h(x, 0, 63) * 2)) A.setK(T.PARK_FLOOR_SIDE, x, y, pcol, 0.85 + h(x, y, 64) * 0.3);
    else A.setK(T.PARK_FLOOR_SIDE, x, y, dirt, 0.85 + h(x, y, 65) * 0.3);
    const wave = Math.abs(Math.sin((x + (y >> 2) * 2) * Math.PI / 4));
    A.setK(T.CLAY_ROOF, x, y, c(186, 92, 54), (y % 4 === 3 ? 0.65 : 0.75 + wave * 0.35) * (0.94 + h(x, y, 68) * 0.1));
    A.set(T.PLAIN, x, y, 255, 255, 255);
  }
}
