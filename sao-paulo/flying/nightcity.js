// São Paulo World · flight test bed: the city after dark, in the shaders of
// the ground and of the buildings (no lights in the scene, nothing per
// building on the page).
//
// The ground: where the map photo is, its streets glow. They are picked out
// of the photo once, on the GPU (the dark, colourless lines between the
// roofs), into a small one-channel texture with mipmaps, so from far away the
// street grid melts into a district's glow instead of vanishing. Beyond the
// photo, where the building tiles say there is city, a drawn street grid
// glows as brightly as the tiles are full.
//
// The buildings: each wall is already tiled in window bays (3 m by one 3.2 m
// floor, the facade texture's repeat), so a bay's number picks whether its
// window is lit, and how warm. Far away, where bays are smaller than a pixel,
// a wall takes the average glow of its lit windows (no sparkle, no flicker).
// The lower floors catch the street lamps' light.
//
// By day neither is in the shaders at all: the night's part is compiled in
// (a define, NIGHT_ON) only while the lights are on, so the day's programs
// are the ones the page always had. (A uniform test would not do: some GPUs,
// and every software renderer, run both sides of it.) The two variants of each
// material are compiled once, the first dusk; three.js keeps both.
import * as THREE from 'three';

// A hash of a cell's number, 0..1 (no sine: it keeps its bits far from the origin).
const HASH = 'float nightHash( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }';
// The look's numbers, as uniforms (shared by reference).
// win: x the share of far lights against the near windows', y a far light's brightness, z the street lamps' light on the lower floors, w the windows' brightness.
// gnd: x the glow's brightness, y the far lamps', z how much of the streets' mean glow stays under the far lamps, w the share of lamps that are white.
export const TUNE = { win: { value: new THREE.Vector4(0.5, 0.85, 0.36, 1.05) }, gnd: { value: new THREE.Vector4(0.62, 0.85, 0.22, 0.4) } };
const black = () => { const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); t.needsUpdate = true; return t; };

// `ground`: ground.js's object (its material draped with the map photo).
// `uniforms`: daynight's ({ uNight, uLate }). `map`: the photo's extent [e0, n0, e1, n1].
// update(): call once a frame; it builds what the night needs the first time it is needed.
export function nightGround({ ground, uniforms, renderer, map, base = './buildings/' }) {
  const material = ground.material;
  if (!renderer.capabilities.isWebGL2) return { update() {}, uniforms: {}, tune: TUNE };  // (WebGL 1: the ground stays as it is; the runway lights still come on)
  const U = {
    uNight: uniforms.uNight, uGnd: TUNE.gnd, nightMap: { value: black() }, cityMap: { value: black() },
    cityBox: { value: new THREE.Vector4(0, 0, 1, 1) },  // scene x0, z0, 1 / width, 1 / depth of the tiles' grid
  };
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    prev.call(material, sh, r);
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
#ifdef NIGHT_ON
uniform float uNight;
uniform vec4 uGnd;
uniform sampler2D nightMap;
uniform sampler2D cityMap;
uniform vec4 cityBox;
${HASH}
// A lamp in about a third of the cells of side s (m), somewhere in its cell (no rows show): a round dot; x its brightness 0..1, y its own number 0..1.
vec2 nightLamps( vec2 p, float s ) { vec2 c = p / s; float h = nightHash( floor( c ) ), k = fract( h * 37.0 ); vec2 f = fract( c ) - 0.3 - 0.4 * vec2( k, fract( h * 113.0 ) ); return vec2( step( 0.66, h ) * max( 0.0, 1.0 - 11.0 * dot( f, f ) ), k ); }
#endif`)
      .replace('#include <color_fragment>', `#include <color_fragment>
#if defined( USE_MAP ) && defined( NIGHT_ON )
{
	float inMap = step( mapBox.x, vGroundXZ.x ) * step( vGroundXZ.x, mapBox.z ) * step( mapBox.y, vGroundXZ.y ) * step( vGroundXZ.y, mapBox.w );
	vec2 w2 = fwidth( vGroundXZ );
	float mpp = max( w2.x, w2.y );  // metres across a pixel
	float streets = texture2D( nightMap, vMapUv ).r;
	// Beyond the photo: blocks of about 90 m (a grid turned 27° off north), as full as the tiles there.
	vec2 q = mat2( 0.0098, 0.005, -0.005, 0.0098 ) * vGroundXZ;
	vec2 fw = 0.011 * w2, g = abs( fract( q ) - 0.5 );
	vec2 ln = smoothstep( 0.46 - fw, 0.46 + fw, g );
	float grid = mix( max( ln.x, ln.y ), 0.15, clamp( 2.0 * max( fw.x, fw.y ), 0.0, 1.0 ) );
	float city = texture2D( cityMap, ( vGroundXZ - cityBox.xy ) * cityBox.zw ).r;
	// Close by, the lit streets themselves. From afar a street is thinner than a pixel: there the ground
	// shows separate lamps, as many as the streets' share of it (cells two to four pixels across, two sizes
	// blended as the distance grows), and only a little of the streets' mean glow under them.
	float lit = mix( 0.5 * grid * city, streets, inMap );
	float far = clamp( ( mpp - 2.5 ) / 5.0, 0.0, 1.0 );
	float lvl = log2( max( 2.6 * mpp, 6.0 ) ), l0 = floor( lvl ), s0 = exp2( l0 );
	vec2 la = nightLamps( vGroundXZ, s0 ), lb = nightLamps( vGroundXZ, 2.0 * s0 );
	float lamps = mix( la.x, lb.x, lvl - l0 );
	// Sodium orange and the newer white lamps: by district under the streets, lamp by lamp from afar.
	vec3 lamp = mix( vec3( 1.0, 0.56, 0.2 ), vec3( 1.0, 0.82, 0.58 ), 0.5 + 0.5 * sin( dot( vGroundXZ, vec2( 0.0013, 0.0019 ) ) ) );
	vec3 one = mix( lamp, vec3( 0.95, 0.97, 1.0 ), step( 1.0 - uGnd.w, mix( la.y, lb.y, step( 0.5, lvl - l0 ) ) ) );
	totalEmissiveRadiance += uNight * uGnd.x * ( lit * ( 1.0 - ( 1.0 - uGnd.z ) * far ) * lamp + uGnd.y * far * min( 1.0, 6.0 * lit ) * lamps * one );
}
#endif`);
  };
  material.customProgramCacheKey = () => 'night-ground';
  material.needsUpdate = true;

  let lit = false, cityAsked = false;
  // The streets of the photo: dark and colourless (roofs are lighter, trees greener), each texel the mean of
  // four of the photo's. Then what is dark and colourless for a hundred metres around (an apron, a car park,
  // a lake) is taken out again: streets are thin.
  function bakeStreets(src) {
    const img = src.image, w = Math.max(1, Math.round(img.width / 2)), h = Math.max(1, Math.round(img.height / 2));
    const target = () => new THREE.WebGLRenderTarget(w, h, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    const pass = (uniforms, body, rt) => {
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms, depthTest: false, depthWrite: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `uniform sampler2D src; uniform vec2 texel; uniform float lod; varying vec2 vUv;\n${body}`,
      }));
      const scene = new THREE.Scene(); scene.add(quad);
      const keep = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
      renderer.setRenderTarget(keep);
      quad.geometry.dispose(); quad.material.dispose();
    };
    const raw = target(), out = target();
    pass({ src: { value: src }, texel: { value: new THREE.Vector2(0.5 / img.width, 0.5 / img.height) }, lod: { value: 0 } }, `
      float street( vec2 uv ) {
        vec3 c = texture2D( src, uv ).rgb;
        float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), sat = max( c.r, max( c.g, c.b ) ) - min( c.r, min( c.g, c.b ) );
        float green = smoothstep( 0.0, 0.012, c.g - max( c.r, c.b ) );
        return ( 1.0 - smoothstep( 0.07, 0.115, lum ) ) * smoothstep( 0.012, 0.03, lum ) * ( 1.0 - green ) * ( 1.0 - smoothstep( 0.02, 0.05, sat ) );
      }
      void main(){ gl_FragColor = vec4( 0.25 * ( street( vUv + texel * vec2( -1.0, -1.0 ) ) + street( vUv + texel * vec2( 1.0, -1.0 ) ) + street( vUv + texel * vec2( -1.0, 1.0 ) ) + street( vUv + texel ) ), 0.0, 0.0, 1.0 ); }`, raw);
    // (The mean over about 120 m: that level of the first pass's mipmaps.)
    pass({ src: { value: raw.texture }, texel: { value: new THREE.Vector2() }, lod: { value: Math.max(0, Math.log2(120 / ((map[2] - map[0]) / w))) } },
      'void main(){ gl_FragColor = vec4( texture2D( src, vUv ).r * ( 1.0 - smoothstep( 0.34, 0.6, textureLod( src, vUv, lod ).r ) ), 0.0, 0.0, 1.0 ); }', out);
    raw.dispose();
    out.texture.anisotropy = Math.min(4, src.anisotropy);  // (a glow: it need not be as sharp as the photo at a glancing angle)
    U.nightMap.value.dispose();
    U.nightMap.value = out.texture;
  }
  // How full each 1 km building tile is (index.json: "i,j": [buildings, ...]), as a texture over the tiles' grid.
  function loadCity() {
    fetch(new URL(base + 'index.json', location.href)).then((r) => r.json()).then((ix) => {
      const keys = Object.keys(ix.tiles || {});
      if (!keys.length) return;
      let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
      const ts = keys.map((k) => { const [i, j] = k.split(',').map(Number); i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); return [i, j, ix.tiles[k][0] || 0]; });
      i0 -= 1; j0 -= 1; i1 += 1; j1 += 1;  // an empty rim: the glow fades out at the edge
      const w = i1 - i0 + 1, h = j1 - j0 + 1, d = new Uint8Array(w * h), T = ix.tile_m || 1000;
      // Row 0 is the northernmost (scene z grows southward).
      for (const [i, j, n] of ts) d[(j1 - j) * w + (i - i0)] = Math.round(255 * Math.min(1, Math.pow(n / 3500, 0.6)));
      const t = new THREE.DataTexture(d, w, h, THREE.RedFormat, THREE.UnsignedByteType);
      t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
      U.cityMap.value.dispose();
      U.cityMap.value = t;
      U.cityBox.value.set(i0 * T, -(j1 + 1) * T, 1 / (w * T), 1 / (h * T));
    }).catch(() => { /* no tiles: no glow beyond the photo */ });
  }
  let on = false;
  function update() {
    const want = uniforms.uNight.value > 0;
    if (want !== on) { on = want; setNight(material, on); }
    if (!on) return;
    if (!cityAsked) { cityAsked = true; loadCity(); }
    if (!lit && material.map && material.map.image) { lit = true; bakeStreets(material.map); }
  }
  return { update, uniforms: U, tune: TUNE };
}
// The night's part of a material's shader in (or out): its other compiled variant.
function setNight(material, on) {
  if (on) material.defines = { ...material.defines, NIGHT_ON: 1 };
  else if (material.defines) delete material.defines.NIGHT_ON;
  material.needsUpdate = true;
}

// `materials`: buildings.js's three facade materials (a house's, a block's, a tower's curtain wall).
export function nightBuildings({ materials, uniforms, renderer }) {
  if (!renderer.capabilities.isWebGL2) return { update() {} };
  // Per facade: the window's box in a bay (u0, v0, u1, v1), and [share of windows lit in the evening, their brightness,
  // the brightness of a light that stands for several windows (from afar), the share of them that are warm rather than white].
  const FACADES = [
    { box: [0.31, 0.31, 0.69, 0.66], lit: [0.42, 0.85, 0.3, 0.85] },
    { box: [0.125, 0.22, 0.875, 0.75], lit: [0.34, 0.8, 0.5, 0.7] },
    { box: [0.047, 0.125, 0.953, 0.875], lit: [0.2, 0.7, 0.6, 0.25] },
  ];
  materials.forEach((m, k) => {
    const f = FACADES[Math.min(k, FACADES.length - 1)];
    const U = { uNight: uniforms.uNight, uLate: uniforms.uLate, uWin: TUNE.win, winBox: { value: new THREE.Vector4(...f.box) }, winLit: { value: new THREE.Vector4(...f.lit) } };
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev.call(m, sh, r);
      Object.assign(sh.uniforms, U);
      // Walls stand upright (their normals level); roofs take no windows.
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n#ifdef NIGHT_ON\nvarying float vWall;\n#endif')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n#ifdef NIGHT_ON\nvWall = 1.0 - step( 0.5, abs( objectNormal.y ) );\n#endif');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
#ifdef NIGHT_ON
varying float vWall;
uniform float uNight;
uniform float uLate;
uniform vec4 uWin;
uniform vec4 winBox;
uniform vec4 winLit;
${HASH}
#endif`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#if defined( USE_MAP ) && defined( NIGHT_ON )
{
	// One bay to a cell close by: its window, lit or dark. From afar, where bays (or floors) are under a
	// pixel, 2, 4, 8... of them to a cell (each way by itself, two or three pixels across) and a round light
	// in some: a far wall shows a few separate lights, not an even glow.
	vec2 fw = fwidth( vMapUv ), lv = floor( log2( max( 2.0 * fw, 1.0 ) ) ), c = vMapUv / exp2( lv ), f = fract( c ), d = f - 0.5;
	float h = nightHash( floor( c ) ), h2 = fract( h * 61.7 );
	float bays = ( 1.0 - min( lv.x, 1.0 ) ) * ( 1.0 - min( lv.y, 1.0 ) );
	vec2 a = smoothstep( winBox.xy - fw, winBox.xy + fw, f ) * ( 1.0 - smoothstep( winBox.zw - fw, winBox.zw + fw, f ) );
	float shape = mix( max( 0.0, 1.0 - 4.5 * dot( d, d ) ), a.x * a.y, bays );
	float w = step( 1.0 - winLit.x * uLate * mix( uWin.x, 1.0, bays ), h ) * shape * mix( winLit.z * uWin.y, 0.55 + 0.45 * h2, bays );
	vec3 lampCol = mix( vec3( 0.86, 0.93, 1.0 ), vec3( 1.0, 0.78, 0.46 ), step( h2, winLit.w ) );
	// The street lamps on the lower floors.
	vec3 street = uWin.z * exp( -0.35 * max( vMapUv.y, 0.0 ) ) * diffuseColor.rgb * vec3( 1.0, 0.66, 0.36 );
	totalEmissiveRadiance += uNight * vWall * ( uWin.w * winLit.y * w * lampCol + street );
	diffuseColor.rgb *= 1.0 - 0.4 * uNight;  // pale walls and roofs take the moonlight no brighter than the ground's photo
}
#endif`);
    };
    m.customProgramCacheKey = () => 'night-buildings';
    m.needsUpdate = true;
  });
  let on = false;
  // Call once a frame: the windows' shader goes in with the dusk and out with the dawn.
  return { update() { const want = uniforms.uNight.value > 0; if (want !== on) { on = want; for (const m of materials) setNight(m, on); } } };
}
