'use client';
// The R3F scene: drives the simulation from the render loop (fixed steps inside sim.frame), then
// draws the world, cars, props, signs, glass and effects, and places the camera.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette, SMAA } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Simulation } from '../sim/Simulation';
import { buildBarriersAndRails, buildBillboardsAndPoles, buildCountyRoadAndPad, buildOverpass, buildRoads, buildTerrain, buildTrees, QUALITY } from './worldMeshes';
import { CarsView, PropsView, SignsView, GlassView } from './views';
import { Effects } from './effects';
import { CameraRig } from './camera';
import type { QualityName } from '../state/store';

function SimLoop({ sim, onVersion, onFrame }: { sim: Simulation; onVersion: (v: number) => void; onFrame?: (dt: number) => void }) {
  const last = useRef(-1);
  useFrame((_, dt) => {
    sim.frame(dt);
    onFrame?.(dt);
    if (sim.version !== last.current) { last.current = sim.version; onVersion(sim.version); }
  }, -1);
  return null;
}

function sunDirection(el: number, az: number) {
  return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
}

function Atmosphere({ sim, quality }: { sim: Simulation; quality: QualityName }) {
  const { scene, gl } = useThree();
  const q = QUALITY[quality];
  const w = sim.weather;
  const sun = useMemo(() => sunDirection(w.sunElevation, w.sunAzimuth), [w.sunElevation, w.sunAzimuth]);
  const light = useRef<THREE.DirectionalLight>(null);
  const overcast = w.overcast;
  const fogColor = useMemo(() => new THREE.Color(overcast > 0.5 ? '#8d969e' : '#c4d3e0'), [overcast]);
  useEffect(() => {
    scene.fog = new THREE.FogExp2(fogColor, w.fog);
    scene.background = overcast > 0.5 ? new THREE.Color('#7f8a94') : null;
    // a simple environment for reflections: sky gradient over a ground tone
    const pm = new THREE.PMREMGenerator(gl);
    const envScene = new THREE.Scene();
    const skyGeo = new THREE.SphereGeometry(100, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { top: { value: new THREE.Color(overcast > 0.5 ? '#9aa3ab' : '#5d8fd6') }, mid: { value: new THREE.Color(overcast > 0.5 ? '#b8bec2' : '#dce9f5') }, bottom: { value: new THREE.Color('#4b4a34') } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : mix(mid, bottom, pow(-h, 0.4)); gl_FragColor = vec4(c, 1.0); }',
    });
    envScene.add(new THREE.Mesh(skyGeo, skyMat));
    const sunBlob = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(overcast > 0.5 ? '#ddd' : '#fff6e0').multiplyScalar(overcast > 0.5 ? 1.5 : 12) }));
    sunBlob.position.copy(sun).multiplyScalar(80);
    envScene.add(sunBlob);
    const rt = pm.fromScene(envScene, 0.02);
    scene.environment = rt.texture;
    scene.environmentIntensity = overcast > 0.5 ? 0.7 : 0.9;
    return () => { rt.dispose(); pm.dispose(); scene.environment = null; };
  }, [scene, gl, w.fog, fogColor, overcast, sun]);
  useFrame(() => {
    const l = light.current, p = sim.player;
    if (!l || !p) return;
    const c = new THREE.Vector3(p.p.x, p.p.y, p.p.z);
    l.position.copy(c).addScaledVector(sun, 180);
    l.target.position.copy(c);
    l.target.updateMatrixWorld();
  });
  return (
    <>
      {overcast < 0.5 && <Sky distance={4500} sunPosition={sun.clone().multiplyScalar(100).toArray()} turbidity={2.2} rayleigh={0.55} mieCoefficient={0.0035} mieDirectionalG={0.86} />}
      <hemisphereLight args={[overcast > 0.5 ? '#b9c2ca' : '#cfe2ff', '#5b4a2c', overcast > 0.5 ? 1.25 : 0.65]} />
      <directionalLight
        ref={light}
        color={overcast > 0.5 ? '#dfe5ea' : '#fff1d8'}
        intensity={overcast > 0.5 ? 0.9 : 3.1}
        castShadow
        shadow-mapSize={[q.shadows, q.shadows]}
        shadow-camera-left={-70} shadow-camera-right={70} shadow-camera-top={70} shadow-camera-bottom={-70}
        shadow-camera-near={10} shadow-camera-far={400}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
      />
    </>
  );
}

function StaticWorld({ sim, quality, version }: { sim: Simulation; quality: QualityName; version: number }) {
  const q = QUALITY[quality];
  const terrain = useMemo(() => buildTerrain(sim, q), [sim, q]);
  const roads = useMemo(() => buildRoads(sim), [sim]);
  const county = useMemo(() => buildCountyRoadAndPad(sim), [sim]);
  const overpass = useMemo(() => buildOverpass(sim), [sim]);
  const rails = useMemo(() => buildBarriersAndRails(sim), [sim]);
  const trees = useMemo(() => buildTrees(sim, q), [sim, q]);
  const boards = useMemo(() => buildBillboardsAndPoles(sim), [sim]);
  useEffect(() => { rails.update(); }, [rails, version]);
  useEffect(() => () => { terrain.geometry.dispose(); }, [terrain]);
  return (
    <>
      <primitive object={terrain} />
      <primitive object={roads} />
      <primitive object={county} />
      <primitive object={overpass} />
      <primitive object={rails.group} />
      <primitive object={trees} />
      <primitive object={boards} />
    </>
  );
}

export function GameScene({ sim, quality, onFrame }: { sim: Simulation; quality: QualityName; onFrame?: (dt: number) => void }) {
  const q = QUALITY[quality];
  const [version, setVersion] = useState(0);
  return (
    <Canvas
      shadows="soft"
      dpr={[1, Math.min(q.pixelRatio, typeof window !== 'undefined' ? window.devicePixelRatio : 1)]}
      gl={{ antialias: !q.post, powerPreference: 'high-performance', stencil: false }}
      camera={{ fov: 60, near: 0.15, far: 5000, position: [0, 20, 20] }}
      onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 0.82; }}
    >
      <SimLoop sim={sim} onVersion={setVersion} onFrame={onFrame} />
      <Atmosphere sim={sim} quality={quality} />
      <StaticWorld sim={sim} quality={quality} version={version} />
      <CarsView sim={sim} version={version} />
      <PropsView sim={sim} version={version} />
      <SignsView sim={sim} />
      <GlassView sim={sim} />
      <Effects sim={sim} rainCount={q.rain} version={version} />
      <CameraRig sim={sim} />
      {q.post && (
        <EffectComposer multisampling={0}>
          <SMAA />
          <Bloom intensity={0.9} luminanceThreshold={0.85} luminanceSmoothing={0.2} mipmapBlur />
          <Vignette offset={0.25} darkness={0.55} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
