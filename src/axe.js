import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { isBlocked } from './manor.js';
import { asset } from './assets.js';

/**
 * The axe: lies in the manor until the player walks into it, then rides in the
 * character's right hand and turns a punch into a killing blow.
 */

const URL = asset('assets/weapons/axe.glb');

// Source is 0.81 x 1.90 x 0.26 with the head at +Y and the pivot at its centre.
const AXE_LENGTH = 1.9;
const HELD_LENGTH = 0.85; // how long the axe should read in world metres
const GRIP_ALONG_HANDLE = 0.34; // where on the shaft the hand closes, 0 = centre

// Where the axe should point once held, in world terms: straight up, head
// skyward. The grip rotation is solved from this against the rig's bind pose
// rather than guessed as Euler angles, because the hand bone's local axes are
// whatever the exporter decided they were.
const HELD_DIRECTION = new THREE.Vector3(0, 1, 0);
const BLADE_ROLL = Math.PI / 2; // spin about the shaft so the blade faces out
const HAND_OFFSET = new THREE.Vector3(0, 0.02, 0);

const PICKUP_RANGE = 1.3;
const REST_HEIGHT = 0.55;

export async function spawnAxe({ scene, level, position }) {
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();

  const gltf = await new GLTFLoader().loadAsync(URL);

  const mesh = gltf.scene;
  mesh.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;
  });

  // Wrap it so the grip sits at the wrapper's origin: attaching the wrapper to
  // a hand then puts the shaft in the palm rather than the axe's centre point.
  const held = new THREE.Group();
  // Shift the mesh UP so the point of the shaft that lands on the group origin
  // is below centre -- that is the bit the hand closes around. Pushing it down
  // instead puts the grip up by the head, with the shaft dangling across her.
  mesh.position.y = AXE_LENGTH * GRIP_ALONG_HANDLE;
  held.add(mesh);

  // While it waits to be found, it hovers and turns under its own light.
  const pickup = new THREE.Group();
  pickup.add(held);
  pickup.position.copy(position);
  pickup.scale.setScalar(HELD_LENGTH / AXE_LENGTH);

  const glow = new THREE.PointLight(0xffc48a, 6, 4.5, 2);
  glow.position.y = 0.4;
  pickup.add(glow);

  scene.add(pickup);

  let equipped = false;
  let bob = 0;
  let socket = null;
  const grip = new THREE.Quaternion();

  function update(dt) {
    if (equipped) {
      follow();
      return;
    }
    bob += dt;
    pickup.rotation.y += dt * 1.1;
    pickup.position.y = REST_HEIGHT + Math.sin(bob * 1.8) * 0.08;
    glow.intensity = 5 + Math.sin(bob * 3) * 1.5;
  }

  function isNear(point) {
    if (equipped) return false;
    return Math.hypot(point.x - pickup.position.x, point.z - pickup.position.z) < PICKUP_RANGE;
  }

  /**
   * Takes the axe out of the world and hands it to `bone`.
   *
   * It is *not* parented to the bone. The rig's hand carries a non-uniform
   * world scale (0.354, 0.224, 0.354), which squashed the axe to half length
   * when it was a child. Instead the axe stays a scene object and copies the
   * hand's world position and rotation every frame -- a socket, immune to
   * whatever scale the skeleton is carrying.
   *
   * `restQuat` is the hand's orientation in the rig's rest pose, captured
   * before any clip plays. Solving the grip against a live pose would square
   * the axe up only for the frame it was picked up on.
   */
  function attachTo(bone, restQuat) {
    if (equipped) return false;
    equipped = true;

    socket = bone;
    grip.copy(restQuat).invert().multiply(targetOrientation());

    pickup.remove(held);
    glow.removeFromParent();
    pickup.removeFromParent();

    held.scale.setScalar(HELD_LENGTH / AXE_LENGTH);
    scene.add(held);
    follow();
    return true;
  }

  function targetOrientation() {
    const dir = HELD_DIRECTION.clone().normalize();
    const upright = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const roll = new THREE.Quaternion().setFromAxisAngle(dir, BLADE_ROLL);
    return roll.multiply(upright);
  }

  // Snaps the axe onto the hand for this frame.
  function follow() {
    if (!socket) return;
    socket.updateWorldMatrix(true, false);
    socket.matrixWorld.decompose(_pos, _quat, _scale);

    held.quaternion.copy(_quat).multiply(grip);
    held.position.copy(HAND_OFFSET).applyQuaternion(held.quaternion).add(_pos);
  }

  return {
    pickup,
    held,
    update,
    isNear,
    attachTo,
    get equipped() { return equipped; },
  };
}

/**
 * Picks a random clear spot for the axe, kept well away from `away` (the
 * player's spawn) so it has to be hunted for rather than tripped over.
 */
export function randomRestingPlace(level, { away = null, minGap = 6, clearance = 0.6 } = {}) {
  const spanX = level.bounds.x - 1.5;
  const spanZ = level.bounds.z - 1.5;

  for (let attempt = 0; attempt < 400; attempt++) {
    const x = (Math.random() * 2 - 1) * spanX;
    const z = (Math.random() * 2 - 1) * spanZ;
    if (isBlocked(x, z, level.colliders, clearance)) continue;
    // Relax the distance requirement rather than fail if the level is tight.
    const gap = away ? Math.hypot(x - away.x, z - away.z) : Infinity;
    if (gap < minGap * (attempt < 200 ? 1 : 0.5)) continue;
    return new THREE.Vector3(x, 0, z);
  }

  // Nothing random worked out; fall back to a known-good spot.
  return restingPlace(level, new THREE.Vector3(0, 0, 5.5));
}

/** Finds a clear spot for the axe to rest, near `preferred` if possible. */
export function restingPlace(level, preferred) {
  if (!isBlocked(preferred.x, preferred.z, level.colliders, 0.5)) return preferred;
  for (let r = 0.5; r < 6; r += 0.5) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      const x = preferred.x + Math.cos(a) * r;
      const z = preferred.z + Math.sin(a) * r;
      if (!isBlocked(x, z, level.colliders, 0.5)) return new THREE.Vector3(x, 0, z);
    }
  }
  return preferred;
}
