# Name Match 3D

A 3D name-finding puzzle game for the browser. Drag across glossy neon tiles to find
10 hidden names in each of 10 themed worlds. It is built with Three.js, GSAP and the
Web Audio API, with no backend and no binary assets.

## Run locally

The game uses ES modules, and browsers block those on `file://`. **Double-clicking
`index.html` will not work.** Serve the folder over HTTP with any static server:

```bash
python -m http.server 5173
```

or

```bash
npx http-server . -p 5173 -c-1
```

Then open <http://localhost:5173>. You need an internet connection because
Three.js, GSAP and the fonts load from CDNs.

### Editing styles

`styles/main.css` is compiled from the SCSS sources and is committed, so the game runs
without a build step. After you change any `.scss` file, rebuild it:

```bash
npm install
```

```bash
npm run build:css
```

`npm run watch:css` rebuilds automatically while you edit.

## Project structure

```
name-match-3d/
├── index.html              All screens and overlays, SVG icon sprite, import map
├── package.json            Sass build scripts
├── styles/
│   ├── main.scss           Entry point (imports the partials below)
│   ├── main.css            Compiled output (loaded by index.html)
│   ├── _variables.scss     Colours, spacing, radii, shadows, fonts, z-index
│   ├── _mixins.scss        Breakpoints, glass panel, neon glow, reduced motion
│   ├── _ui.scss            Buttons, panels, menu, level cards, toggles, overlays, toasts
│   ├── _game.scss          HUD, board area, word list, selection preview, banner
│   └── _responsive.scss    Tablet/desktop layouts, short screens, reduced motion
├── js/
│   ├── main.js             Bootstrap, navigation, settings, keyboard, share
│   ├── state.js            Pub/sub store (subscribe / emit / onStateChange)
│   ├── game.js             GameController: input, validation, scoring, timer, hints
│   ├── grid.js             Word grid generator and validator
│   ├── levels.js           10 levels, 10 themes, directions, daily challenge
│   ├── three-scene.js      SceneManager: board, lights, camera, bloom, picking
│   ├── particles.js        GPU burst/ambient particles and 2D confetti
│   ├── audio.js            Procedural SFX and generative music (Web Audio)
│   ├── ui.js               DOM layer: screens, HUD, toasts, result screens
│   ├── storage.js          localStorage save/load ("nameMatch3D_saveData")
│   └── utils.js            Maths, seeded RNG, DOM and device helpers
└── assets/                 fonts/ sounds/ textures/ (empty: everything is procedural)
```

## Architecture

```
            ┌──────────── store (state.js) ────────────┐
            │  setState() → "change:<key>" events       │
            └───────┬──────────────┬───────────────┬────┘
                    │              │               │
   main.js ──► GameController ──► SceneManager    UI (reacts to store)
   (navigation)  (rules, input)   (Three.js)      (DOM only)
                    │
                    └──► AudioManager (Web Audio)      storage.js (persistence)
```

- **One-way data flow.** `GameController` owns the rules and writes to the store. `UI`
  subscribes to individual keys, so the DOM only updates when a value changes.
- **Scene isolation.** Game code never touches Three.js objects. It calls a small API
  on the scene: `buildBoard`, `setSelection`, `markFound`, `reject`, `hint`,
  `celebrate`, `pickCell` and `cellToScreen`.
- **Tile animation.** Each frame, every tile eases toward the target for its current
  state (idle, hover, selected, found, hint or error). One-off motions such as the
  drop-in, wave and shake are GSAP tweens on a separate offset, so the two systems
  never fight.
- **No globals.** Everything lives inside the `createApp()` closure.

## Gameplay

| Input    | Action                                                               |
|----------|----------------------------------------------------------------------|
| Mouse    | Click and drag in a straight line, then release to submit            |
| Touch    | Drag, or tap the first letter and then the last letter               |
| Keyboard | Arrow keys move the cursor, Enter sets the start/end, Esc pauses, H uses a hint |

- A selection snaps to the nearest of 8 directions. It cannot skip tiles or zig-zag.
- Words read in either direction count. For example, dragging `DIVAD` finds DAVID.
- **Scoring:** each word is worth 100 points. Quick consecutive finds (within 10 s)
  build a combo worth +50 per step. At the end, each second left on the clock adds
  10 points. All of this is multiplied by the level multiplier. A hint costs 50 points.
- **Stars:** 1 star for finishing the level. 2 stars for finishing with ≥18% of the time
  left. 3 stars for finishing with ≥40% of the time left and at most 1 hint used.

### Levels

| #  | Theme         | Difficulty | Grid  | Time | Directions                   |
|----|---------------|------------|-------|------|------------------------------|
| 1  | Neon City     | Easy       | 9×9   | 3:00 | → ↓                          |
| 2  | Crystal Cave  | Easy       | 9×9   | 2:55 | → ↓ ↘                        |
| 3  | Space Station | Easy       | 10×10 | 2:50 | → ↓ ↘                        |
| 4  | Candy World   | Medium     | 10×10 | 3:10 | → ↓ ↘ ↗                      |
| 5  | Cyber Grid    | Medium     | 11×11 | 3:10 | + reversed ←                 |
| 6  | Ocean Depths  | Medium     | 11×11 | 3:05 | + reversed ↑                 |
| 7  | Sunset Desert | Hard       | 12×12 | 3:10 | all 8                        |
| 8  | Frozen Peaks  | Hard       | 12×12 | 3:00 | all 8                        |
| 9  | Magic Forest  | Hard       | 12×12 | 2:50 | all 8                        |
| 10 | Golden Vault  | Hard       | 12×12 | 2:40 | all 8                        |

The **Daily Challenge** builds a seeded board from the date, so every player gets the
same puzzle on the same day.

## Performance and accessibility

- Geometries and letter materials are shared across tiles, particle counts are capped,
  and rendering pauses when the game is paused or the tab is hidden.
- **Performance mode** turns off bloom and shadows, caps the pixel ratio at 1 and
  cuts burst particles.
  It switches on automatically for weak devices, or if gameplay drops below about
  38 FPS. You can also toggle it in Settings.
- With `prefers-reduced-motion`, the camera intro, parallax, tile flips and screen
  slides are turned off.
- Found words get a coloured capsule, a checkmark and dark letters, so the feedback
  does not rely on colour alone. The tap anchor and keyboard cursor use ring outlines.

## Debugging

Open `index.html?debug` to expose `window.__nm3d` (`store`, `game`, `scene`, `ui`,
`audio`, `getSave()`). For example, `__nm3d.game.grid.placements` lists every
word's position.
