# stella-2026

An in-browser 3D project built around Stella, a rigged character in a candle-lit manor. Early and evolving fast — where it's heading isn't fixed. Three.js, plain ES modules, bundled by Vite. No framework, no TypeScript, no build step beyond Vite.

## Commands

- `npm run dev` — Vite dev server on port 5173
- `npm run build` / `npm run preview` — production bundle and local preview
- `npm run prepare-assets` — regenerate the manor textures (see Assets)

There are no tests and no linter yet. Verify changes by running `npm run dev` and watching the scene.

## Layout

- `src/main.js` — character controller and the render loop: input, movement, collision against the level, camera, and the animation state machine. Owns the character's position; animation root motion is stripped so clips never fight the controller.
- `src/manor.js` — builds the level from an ASCII floor plan. The `PLAN` array **is** the level — one character per square metre; edit it to change the manor. Also exports the collision helpers (`resolveCollisions`, `isBlocked`).
- `src/ghost.js` — a self-navigating NPC that BFS-paths across a grid derived from the level colliders; also the thing the player fights.
- `src/axe.js` — a pickup weapon: rests in the manor, then rides a hand bone as a world-space socket (not parented, to dodge the rig's non-uniform bone scale) once collected.
- `scripts/prepare-manor-textures.mjs` — offline texture downscaler (Node).

Three.js addons (`GLTFLoader`, `OBJLoader`, etc.) are imported straight from `three/examples/jsm/`.

## Assets

Assets live in `assets/` and are served at the `/assets/...` URL path directly — `vite.config.js` sets `publicDir: false`, so nothing is copied through the bundler.

Characters are rigged glTF: one base `-Walking-` file carries the skeleton, and every other clip is lifted from its own `.glb` and rebound by joint name. All files share the same 24-joint skeleton.

Manor textures: the raw pack under `assets/manor/assets/` is gitignored and large; the downscaled `assets/manor/derived/` **is** committed and is what the level loads, so a fresh clone runs without the raw pack. Regenerate `derived/` with `npm run prepare-assets` after changing source textures — note the script shells out to `sips`, which is macOS-only.

## Debugging

`window.stella` (set at the bottom of `main.js`) exposes the scene, camera, controller state, and `step(dt)` for stepping the loop by a fixed delta.

## Conventions

Match the surrounding code: comments explain the non-obvious *why* (tuned constants, coordinate quirks, workarounds), not the mechanics. Tunable constants sit in `UPPER_SNAKE_CASE` at the top of each file — adjust those rather than scattering magic numbers.
