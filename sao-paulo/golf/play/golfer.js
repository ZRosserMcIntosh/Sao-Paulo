// São Paulo World · Golf: the golfer, low-poly, swinging in the swing plane.
// The arms and club turn about an axis square to the swing plane (tilted 50°
// from the vertical, about a right-hander's plane with an iron), the shoulders
// turn about the spine; a putt is a pendulum from the shoulders.
import * as THREE from 'three';

export function makeGolfer() {
  const root = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ color: '#c99a76' });
  const shirt = new THREE.MeshLambertMaterial({ color: '#ffd36b' });
  const trousers = new THREE.MeshLambertMaterial({ color: '#2b3441' });
  const capMat = new THREE.MeshLambertMaterial({ color: '#f4f4f0' });
  const shaftMat = new THREE.MeshLambertMaterial({ color: '#b8bcc2' });
  const headMat = new THREE.MeshLambertMaterial({ color: '#30343a' });
  const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  const cyl = (r0, r1, h, m) => { const g = new THREE.CylinderGeometry(r0, r1, h, 8); g.translate(0, -h / 2, 0); return new THREE.Mesh(g, m); };
  // Local frame: +x toward the target, +z toward the ball (the golfer faces +z), y up.
  const legs = new THREE.Group();
  for (const s of [-1, 1]) {
    const l = cyl(0.075, 0.06, 0.88, trousers);
    l.position.set(s * 0.17, 0.88, 0);
    l.rotation.z = s * 0.06;
    legs.add(l);
    const shoe = box(0.11, 0.07, 0.27, capMat);
    shoe.position.set(s * 0.2, 0.035, 0.05);
    legs.add(shoe);
  }
  root.add(legs);
  // The spine: bent forward at the hips.
  const spine = new THREE.Group();
  spine.position.set(0, 0.92, 0);
  spine.rotation.x = 0.55;  // forward tilt toward the ball
  root.add(spine);
  const hips = box(0.36, 0.16, 0.2, trousers);
  hips.position.y = 0.04;
  spine.add(hips);
  const torsoTurn = new THREE.Group();
  spine.add(torsoTurn);
  const torso = box(0.42, 0.5, 0.22, shirt);
  torso.position.y = 0.36;
  torsoTurn.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 12, 10), skin);
  head.position.set(0, 0.74, 0.04);
  torsoTurn.add(head);
  const cap = cyl(0.11, 0.11, 0.07, capMat);
  cap.position.set(0, 0.86, 0.04);
  torsoTurn.add(cap);
  const brim = box(0.2, 0.015, 0.12, capMat);
  brim.position.set(0, 0.8, 0.14);
  torsoTurn.add(brim);
  // The swing: arms and club about the shoulders' centre.
  const swing = new THREE.Group();
  swing.position.set(0, 0.56, 0.06);
  torsoTurn.add(swing);
  const arms = new THREE.Group();
  swing.add(arms);
  for (const s of [-1, 1]) {
    const a = cyl(0.045, 0.04, 0.62, shirt);
    a.position.set(s * 0.17, 0, 0);
    a.rotation.z = -s * 0.27;
    arms.add(a);
  }
  const hands = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), skin);
  hands.position.set(0, -0.6, 0);
  arms.add(hands);
  const club = new THREE.Group();
  club.position.set(0, -0.6, 0);
  arms.add(club);
  const shaft = cyl(0.008, 0.006, 1, shaftMat);
  club.add(shaft);
  const clubHead = box(0.1, 0.045, 0.06, headMat);
  club.add(clubHead);
  root.userData = { spine, torsoTurn, swing, arms, club, shaft, clubHead, shirt };

  // Pose: phase in [-1, 1.2]: 0 address/impact, -1 the top of a full backswing,
  // +1 the finish. putt: a pendulum.
  root.userData.setClub = (lengthM, putter) => {
    shaft.scale.set(1, lengthM - 0.25, 1);
    clubHead.position.set(0.02, -(lengthM - 0.25), 0.02);
    clubHead.scale.set(putter ? 1.3 : 1, 1, putter ? 0.7 : 1);
    root.userData.putter = putter;
  };
  root.userData.setPose = (phase) => {
    const putter = root.userData.putter;
    if (putter) {
      swing.rotation.set(0, 0, 0);
      swing.rotateZ(-phase * 0.45);
      torsoTurn.rotation.y = 0;
      return;
    }
    // Arms and club about the plane's normal: tilted toward the ball.
    const a = phase < 0 ? phase * 4.4 : phase * 4.6;   // radians round the plane
    swing.rotation.set(0, 0, 0);
    swing.rotateX(-0.9);  // the swing plane leans over the ball
    swing.rotateZ(a);
    swing.rotateX(0.9);
    torsoTurn.rotation.y = phase < 0 ? phase * 1.5 : phase * 1.3;
  };
  root.userData.setColor = (c) => shirt.color.set(c);
  root.userData.setClub(0.95, false);
  root.userData.setPose(0);
  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return root;
}

// Stand the golfer at a ball, square to the aim line (a right-hander stands on
// the left of the line, facing it).
export function placeGolfer(g, ballPos, aim, groundAt, clubLength, leftHanded = false) {
  const dx = Math.cos(aim), dz = Math.sin(aim);
  // Right of the target line is (-dz, dx); a right-hander stands on the left.
  const side = leftHanded ? 1 : -1;
  const back = 0.55 + 0.42 * clubLength;
  const x = ballPos[0] + side * -dz * back, z = ballPos[2] + side * dx * back;
  g.position.set(x, groundAt(x, z), z);
  // Local +z (facing) toward the ball, local +x toward the target.
  g.lookAt(ballPos[0], g.position.y, ballPos[2]);
  if (leftHanded) g.scale.set(-1, 1, 1); else g.scale.set(1, 1, 1);
}
