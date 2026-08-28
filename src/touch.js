/**
 * Touch controls: a thumbstick on the left for moving, action buttons on the
 * right. They only exist on touch devices, and never interfere with the mouse.
 *
 * The stick is fixed in the lower-left corner and always visible, the way a
 * mobile game's is. The thumb can land anywhere in the surrounding zone; the
 * knob then tracks it, measured from the circle's own centre.
 */

const STICK_RADIUS = 56; // px of travel before the stick reads as fully pushed
const DEAD_ZONE = 0.12; // ignore the wobble of a resting thumb

/** True when this is a touch device (or ?touch=1 is set, for testing). */
export function isTouchDevice() {
  const forced = new URLSearchParams(location.search).get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

/**
 * Wires up the on-screen controls.
 *
 * `onJump` and `onAttack` fire once per press; movement is polled off the
 * returned `move` vector, whose length is how far the stick is pushed.
 */
export function setupTouchControls({ onJump, onAttack }) {
  const root = document.getElementById('touch');
  const zone = document.getElementById('stick-zone');
  const base = document.getElementById('stick-base');
  const knob = document.getElementById('stick-knob');
  if (!root || !zone || !base || !knob) return null;

  document.body.classList.add('touch');

  const move = { x: 0, y: 0 };
  let stickPointer = null;
  let originX = 0;
  let originY = 0;

  zone.addEventListener('pointerdown', (e) => {
    if (stickPointer !== null) return;
    stickPointer = e.pointerId;

    // Travel is measured from the circle's centre, wherever the thumb landed.
    const rect = base.getBoundingClientRect();
    originX = rect.left + rect.width / 2;
    originY = rect.top + rect.height / 2;

    base.classList.add('active');
    // Capture keeps the stick tracking a thumb that slides outside the zone.
    // It throws if the pointer is already gone, which must not kill the press.
    try {
      zone.setPointerCapture(e.pointerId);
    } catch {}
    update(e.clientX, e.clientY);
    e.preventDefault();
  });

  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickPointer) return;
    update(e.clientX, e.clientY);
    e.preventDefault();
  });

  function update(clientX, clientY) {
    let dx = clientX - originX;
    let dy = clientY - originY;
    const dist = Math.hypot(dx, dy);
    if (dist > STICK_RADIUS) {
      dx = (dx / dist) * STICK_RADIUS;
      dy = (dy / dist) * STICK_RADIUS;
    }

    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    const nx = dx / STICK_RADIUS;
    const ny = dy / STICK_RADIUS;
    // Screen y grows downward; forward is up, so it flips here.
    move.x = Math.abs(nx) < DEAD_ZONE ? 0 : nx;
    move.y = Math.abs(ny) < DEAD_ZONE ? 0 : -ny;
  }

  const release = (e) => {
    if (e.pointerId !== stickPointer) return;
    stickPointer = null;
    move.x = 0;
    move.y = 0;
    base.classList.remove('active');
    knob.style.transform = 'translate(-50%, -50%)';
  };
  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', release);

  // Action buttons. `held` keeps jump usable as a hold, matching the keyboard.
  const button = (id, onPress) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('pressed');
      onPress();
    });
    const up = () => el.classList.remove('pressed');
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  };

  button('btn-jump', onJump);
  button('btn-attack', onAttack);

  root.hidden = false;
  return { move };
}
