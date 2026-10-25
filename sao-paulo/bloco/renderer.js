// WebGL2 rendering, a port of MasterRenderer / BoxRenderer / Shaders.java: sky, opaque and
// alpha-tested terrain, coloured boxes (vehicles, shards), translucent terrain and boxes back to
// front, and the block highlight.
import { m4, viewMatrix, frustumPlanes, boxVisible } from './math.js';
import { CS, CH } from './world.js';
import { buildMesh } from './mesher.js';

const WORLD_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; layout(location=2) in float aLight;
uniform mat4 projection, view; uniform vec3 cameraPos;
out vec2 vUV; out float vLight; out float vDist;
void main(){ gl_Position = projection * view * vec4(aPos,1.0); vUV=aUV; vLight=aLight; vDist=length(aPos-cameraPos); }`;
const WORLD_FS = `#version 300 es
precision highp float;
in vec2 vUV; in float vLight; in float vDist;
uniform sampler2D atlas; uniform float alphaCutoff; uniform vec3 fogColor; uniform float fogStart, fogEnd;
out vec4 frag;
void main(){
  vec4 t = texture(atlas, vUV);
  if (t.a < alphaCutoff) discard;
  float l = vLight > 1.5 ? 1.25 : vLight;
  float f = clamp((vDist-fogStart)/(fogEnd-fogStart),0.0,1.0); f = f*f*(3.0-2.0*f);
  frag = vec4(mix(t.rgb*l, fogColor, f), t.a);
}`;
const SKY_VS = `#version 300 es
layout(location=0) in vec2 aPos; out vec2 ndc;
void main(){ gl_Position = vec4(aPos, 0.9999, 1.0); ndc = aPos; }`;
const SKY_FS = `#version 300 es
precision highp float;
in vec2 ndc; uniform mat4 invViewProj; uniform vec3 topColor, horizonColor, fogColor, sunDir;
out vec4 frag;
void main(){
  vec4 a = invViewProj * vec4(ndc,1.0,1.0), b = invViewProj * vec4(ndc,-1.0,1.0);
  vec3 dir = normalize(a.xyz/a.w - b.xyz/b.w);
  float up = dir.y;
  vec3 c = mix(horizonColor, topColor, smoothstep(0.0,0.55,up));
  c = mix(fogColor, c, smoothstep(-0.08,0.06,up));
  float s = max(dot(dir,sunDir),0.0);
  c += vec3(1.0,0.9,0.7)*(pow(s,600.0)*2.0 + pow(s,12.0)*0.18);
  if (up > 0.02) {
    vec2 p = dir.xz/up*3.0;
    float k = sin(p.x*0.9+sin(p.y*0.7))*sin(p.y*1.1+sin(p.x*0.5)*1.3);
    k = smoothstep(0.35,0.9,k)*smoothstep(0.02,0.25,up);
    c = mix(c, vec3(1.0), k*0.55);
  }
  frag = vec4(c,1.0);
}`;
const BOX_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNormal;
uniform mat4 projection, view, model; uniform vec3 cameraPos;
out vec3 vN; out float vDist;
void main(){ vec4 w = model*vec4(aPos,1.0); gl_Position = projection*view*w; vN = normalize(mat3(model)*aNormal); vDist = length(w.xyz-cameraPos); }`;
const BOX_FS = `#version 300 es
precision highp float;
in vec3 vN; in float vDist;
uniform vec4 color; uniform vec3 lightDir, fogColor; uniform float fogStart, fogEnd;
out vec4 frag;
void main(){
  vec3 n = normalize(vN);
  float l = 0.5 + 0.5*max(dot(n, lightDir),0.0);
  vec3 c = color.rgb*l + pow(1.0-abs(n.y),3.0)*0.08;
  float f = clamp((vDist-fogStart)/(fogEnd-fogStart),0.0,1.0);
  frag = vec4(mix(c, fogColor, f*f), color.a);
}`;
const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 projection, view; uniform vec3 blockPos;
void main(){ gl_Position = projection*view*vec4(aPos*1.004+blockPos-vec3(0.002),1.0); }`;
const LINE_FS = `#version 300 es
precision mediump float; out vec4 frag; void main(){ frag = vec4(0.0,0.0,0.0,0.45); }`;

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

export class Renderer {
  constructor(canvas, atlas) {
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('This browser has no WebGL2.');
    this.gl = gl;
    this.canvas = canvas;
    this.atlasTex = atlas.upload(gl);
    this.world = program(gl, WORLD_VS, WORLD_FS);
    this.sky = program(gl, SKY_VS, SKY_FS);
    this.box = program(gl, BOX_VS, BOX_FS);
    this.line = program(gl, LINE_VS, LINE_FS);
    const l = [0.45, 0.75, 0.35], ll = Math.hypot(...l);
    this.lightDir = l.map((v) => v / ll);
    this.fog = [0.74, 0.83, 0.93];
    this.viewDist = 160;
    this.meshBudgetMs = 6;

    this.skyVao = this.vao([[-1, -1, 3, -1, -1, 3], 2]);
    // unit cube centred on the origin, with normals
    const N = [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [-1, 0, 0], [1, 0, 0]];
    const Q = [
      [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]],
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
      [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]];
    const cube = [];
    for (let f = 0; f < 6; f++) for (const i of [0, 1, 2, 0, 2, 3]) cube.push(...Q[f][i].map((v) => v * 0.5), ...N[f]);
    this.cubeVao = gl.createVertexArray();
    gl.bindVertexArray(this.cubeVao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cube), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const E = [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1,
      1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1];
    this.lineVao = this.vao([E, 3]);
    gl.bindVertexArray(null);
    this.translucentBoxes = [];
  }

  vao([data, size]) {
    const gl = this.gl, v = gl.createVertexArray();
    gl.bindVertexArray(v);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, size, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return v;
  }

  upload(chunk, mesh) {
    const gl = this.gl;
    this.dispose(chunk);
    const part = (arr) => {
      if (!arr.length) return null;
      const vao = gl.createVertexArray(), buf = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
      gl.bindVertexArray(null);
      return { vao, buf, count: arr.length / 6 };
    };
    chunk.mesh = { opaque: part(mesh.opaque), translucent: part(mesh.translucent) };
  }

  dispose(chunk) {
    const gl = this.gl;
    if (!chunk.mesh) return;
    for (const p of [chunk.mesh.opaque, chunk.mesh.translucent]) if (p) { gl.deleteBuffer(p.buf); gl.deleteVertexArray(p.vao); }
    chunk.mesh = null;
  }

  /** Meshes dirty chunks nearest the camera, within the time budget. Returns how many are left. */
  remesh(world, cam) {
    const dirty = [];
    for (const c of world.chunks.values()) if (c.dirty) dirty.push(c);
    const d2 = (c) => (c.cx * CS + 8 - cam.x) ** 2 + (c.cz * CS + 8 - cam.z) ** 2;
    dirty.sort((a, b) => d2(a) - d2(b));
    const t0 = performance.now();
    let left = dirty.length;
    for (const c of dirty) {
      if (performance.now() - t0 > this.meshBudgetMs) break;
      const from = c.mod;
      const mesh = buildMesh(world, c);
      if (!mesh) continue;
      this.upload(c, mesh);
      c.meshedMod = from;
      left--;
    }
    return left;
  }

  render(world, cam, highlight, drawEntities) {
    const gl = this.gl, cv = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(cv.clientWidth * dpr), h = Math.floor(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(...this.fog, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const proj = m4.perspective(cam.fov * Math.PI / 180, w / h, 0.08, 1500);
    const view = viewMatrix(cam);
    const vp = m4.mul(proj, view);
    this.proj = proj; this.view = view; this.cam = cam;
    const planes = frustumPlanes(vp);

    // sky
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.useProgram(this.sky.p);
    gl.uniformMatrix4fv(this.sky.u.invViewProj, false, m4.invert(vp));
    gl.uniform3f(this.sky.u.topColor, 0.30, 0.52, 0.92);
    gl.uniform3f(this.sky.u.horizonColor, 0.72, 0.84, 0.98);
    gl.uniform3fv(this.sky.u.fogColor, this.fog);
    gl.uniform3fv(this.sky.u.sunDir, this.lightDir);
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true); gl.enable(gl.DEPTH_TEST);

    const fogEnd = this.viewDist, fogStart = fogEnd * 0.55;
    this.fogStart = fogStart; this.fogEnd = fogEnd;
    const visible = [];
    for (const c of world.chunks.values()) {
      if (!c.mesh) continue;
      const x0 = c.cx * CS, z0 = c.cz * CS;
      const dx = x0 + 8 - cam.x, dz = z0 + 8 - cam.z;
      if (dx * dx + dz * dz > (fogEnd + 24) ** 2) continue;
      if (!boxVisible(planes, x0, 0, z0, x0 + CS, c.top + 1, z0 + CS)) continue;
      visible.push(c);
    }
    this.drawn = visible.length;

    gl.enable(gl.CULL_FACE); gl.disable(gl.BLEND);
    this.bindWorld(cam, 0.5);
    for (const c of visible) if (c.mesh.opaque) { gl.bindVertexArray(c.mesh.opaque.vao); gl.drawArrays(gl.TRIANGLES, 0, c.mesh.opaque.count); }

    this.bindBox();
    drawEntities(this);

    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false); gl.disable(gl.CULL_FACE);
    const d2 = (c) => (c.cx * CS + 8 - cam.x) ** 2 + (c.cz * CS + 8 - cam.z) ** 2;
    visible.sort((a, b) => d2(b) - d2(a));
    this.bindWorld(cam, 0.01);
    for (const c of visible) if (c.mesh.translucent) { gl.bindVertexArray(c.mesh.translucent.vao); gl.drawArrays(gl.TRIANGLES, 0, c.mesh.translucent.count); }
    // translucent boxes, far to near
    if (this.translucentBoxes.length) {
      this.translucentBoxes.sort((a, b) => b.d - a.d);
      this.bindBox();
      for (const t of this.translucentBoxes) this.drawBox(t.m, t.r, t.g, t.b, t.a, true);
      this.translucentBoxes.length = 0;
    }
    gl.depthMask(true); gl.enable(gl.CULL_FACE);

    if (highlight) {
      gl.useProgram(this.line.p);
      gl.uniformMatrix4fv(this.line.u.projection, false, proj);
      gl.uniformMatrix4fv(this.line.u.view, false, view);
      gl.uniform3f(this.line.u.blockPos, highlight.x, highlight.y, highlight.z);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, 24);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  bindWorld(cam, cutoff) {
    const gl = this.gl, u = this.world.u;
    gl.useProgram(this.world.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(u.atlas, 0);
    gl.uniformMatrix4fv(u.projection, false, this.proj);
    gl.uniformMatrix4fv(u.view, false, this.view);
    gl.uniform3f(u.cameraPos, cam.x, cam.y, cam.z);
    gl.uniform3fv(u.fogColor, this.fog);
    gl.uniform1f(u.fogStart, this.fogStart);
    gl.uniform1f(u.fogEnd, this.fogEnd);
    gl.uniform1f(u.alphaCutoff, cutoff);
  }

  bindBox() {
    const gl = this.gl, u = this.box.u;
    gl.useProgram(this.box.p);
    gl.uniformMatrix4fv(u.projection, false, this.proj);
    gl.uniformMatrix4fv(u.view, false, this.view);
    gl.uniform3f(u.cameraPos, this.cam.x, this.cam.y, this.cam.z);
    gl.uniform3fv(u.lightDir, this.lightDir);
    gl.uniform3fv(u.fogColor, this.fog);
    gl.uniform1f(u.fogStart, this.fogStart);
    gl.uniform1f(u.fogEnd, this.fogEnd);
    gl.bindVertexArray(this.cubeVao);
  }

  /** A box: the unit cube transformed by model (its scale is the size). Translucent ones queue. */
  drawBox(m, r, g, b, a = 1, now = false) {
    if (a < 0.999 && !now) {
      const dx = m[12] - this.cam.x, dy = m[13] - this.cam.y, dz = m[14] - this.cam.z;
      this.translucentBoxes.push({ m, r, g, b, a, d: dx * dx + dy * dy + dz * dz });
      return;
    }
    const gl = this.gl, u = this.box.u;
    gl.uniformMatrix4fv(u.model, false, m);
    gl.uniform4f(u.color, r, g, b, a);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
  }

  /** A box in frame `base`: centre, size, colour 0xRRGGBB. */
  part(base, cx, cy, cz, sx, sy, sz, rgb, alpha = 1) {
    const m = m4.mul(m4.mul(base, m4.translation(cx, cy, cz)), m4.scaling(sx, sy, sz));
    this.drawBox(m, ((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255, alpha);
  }
}
