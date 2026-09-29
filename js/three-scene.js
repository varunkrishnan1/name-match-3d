/**
 * three-scene.js
 * ------------------------------------------------------------------
 * Everything rendered in WebGL: background, lights, the tile board,
 * word "bands", selection rings, particles and post-processing.
 *
 * The game never touches Three.js objects directly — it talks to the
 * SceneManager through a small API (buildBoard, setSelection,
 * markFound, reject, hint, celebrate, pickCell, cellToScreen ...).
 *
 * Tile visuals are driven by per-frame damping toward target values
 * derived from each tile's state (idle / hover / selected / found /
 * hint / error flash). Short one-off motions (wave, shake, drop-in)
 * are GSAP tweens on a separate `anim` offset object, so state and
 * transient animation never fight each other.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BurstParticles, AmbientParticles } from './particles.js';
import { gsap, damp, lerp, isTouchDevice } from './utils.js';

/* ---------------- Board metrics ---------------- */
export const SPACING = 1.1;
const TILE = 0.96;
const DEPTH = 0.42;
const FACE_Z = DEPTH / 2 + 0.006;
const BAND_RADIUS = 0.42;
const BASE_ELEVATION = -0.16; // camera looks slightly up at the board → depth

const ERROR_COLOR = new THREE.Color('#FF3B7B');
const HINT_COLOR = new THREE.Color('#F59E0B');
const BLACK = new THREE.Color('#000000');

/* ---------------- Shaders ---------------- */
const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, uStrength: { value: 0.55 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - smoothstep(0.3, 0.85, d) * uStrength;
      gl_FragColor = c;
    }
  `,
};

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uBottom;
  uniform vec3 uAccent;
  uniform float uTime;
  varying vec3 vDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    vec3 d = normalize(vDir);
    vec3 col = mix(uBottom, uTop, smoothstep(-0.35, 0.75, d.y));
    // soft accent glow behind the board
    float glow = pow(max(0.0, dot(d, normalize(vec3(0.0, 0.15, -1.0)))), 9.0);
    col += uAccent * glow * 0.09;
    // twinkling star field
    vec3 cell = floor(d * 260.0);
    float s = step(0.9975, hash(cell));
    col += s * (0.35 + 0.35 * sin(uTime * 2.0 + hash(cell + 1.0) * 30.0)) * vec3(0.8, 0.9, 1.0);
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ---------------- Geometry helpers ---------------- */
function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Rounded-rectangle outline (ring) geometry. */
function roundedRingGeometry(w, h, r, thickness) {
  const outer = roundedRectShape(w, h, r);
  const inner = roundedRectShape(w - thickness * 2, h - thickness * 2, Math.max(0.01, r - thickness));
  outer.holes.push(new THREE.Path(inner.getPoints(8).reverse()));
  return new THREE.ShapeGeometry(outer, 8);
}

/** Stadium (capsule) shape, `length` = distance between end-cap centres. */
function stadiumShape(length, radius) {
  const s = new THREE.Shape();
  const hl = length / 2;
  s.moveTo(-hl, -radius);
  s.lineTo(hl, -radius);
  s.absarc(hl, 0, radius, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-hl, radius);
  s.absarc(-hl, 0, radius, Math.PI / 2, Math.PI * 1.5, false);
  return s;
}

/* ==================================================================
 * SceneManager
 * ================================================================== */
export class SceneManager {
  constructor(canvas, { lowQuality = false, reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.low = lowQuality;
    this.reducedMotion = reducedMotion;
    this.touch = isTouchDevice();
    this.clock = new THREE.Clock();
    this.time = 0;
    this.running = false;
    this.paused = false;
    this.frameCallbacks = new Set();

    this.mode = 'showcase';        // 'showcase' | 'game'
    this.tiles = [];
    this.size = 0;
    this.boardRect = null;
    this.selected = [];
    this.bandCache = new Map();

    this.pointer = new THREE.Vector2();
    this.parallax = new THREE.Vector2();
    this.cam = { distScale: 1, orbit: 0, elev: BASE_ELEVATION, fitDist: 20 };

    this.raycaster = new THREE.Raycaster();
    this._v3 = new THREE.Vector3();
    this._plane = new THREE.Plane();

    this._loop = this._loop.bind(this);
  }

  /* ---------------- Initialisation ---------------- */

  async init(onProgress = () => {}) {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !this.low,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = !this.low;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2('#050816', 0.012);
    this.camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 250);
    this.camera.position.set(0, -3, 22);

    // Image-based lighting gives the glossy tiles believable reflections.
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    onProgress(0.25);

    this.colors = {
      tile: new THREE.Color('#161d44'),
      board: new THREE.Color('#0b1030'),
      accent: new THREE.Color('#00E5FF'),
      accent2: new THREE.Color('#FF3B7B'),
    };

    this._createBackground();
    this._createLights();
    onProgress(0.45);
    this._createLetterMaterials();
    onProgress(0.7);
    this._createSharedAssets();

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.bursts = new BurstParticles(this.low ? 220 : 700);
    this.scene.add(this.bursts.points);
    this.ambient = new AmbientParticles(this.low ? 90 : 260);
    this.scene.add(this.ambient.points);

    this._createComposer();
    this.resize();
    onProgress(0.9);

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('pointermove', (e) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else if (!this.paused) this.start();
    });

    // Warm up shaders so the first board doesn't hitch.
    renderer.compile(this.scene, this.camera);
    onProgress(1);
  }

  _createBackground() {
    this.skyUniforms = {
      uTop: { value: new THREE.Color('#1b0f3d') },
      uBottom: { value: new THREE.Color('#050816') },
      uAccent: { value: new THREE.Color('#00E5FF') },
      uTime: { value: 0 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(120, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
        side: THREE.BackSide, depthWrite: false, fog: false,
      }),
    );
    sky.renderOrder = -1;
    this.scene.add(sky);
  }

  _createLights() {
    const hemi = new THREE.HemisphereLight('#c7d6ff', '#0d1022', 0.35);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight('#ffffff', 1.3);
    key.position.set(-6, 9, 14);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -10; key.shadow.camera.right = 10;
    key.shadow.camera.top = 10; key.shadow.camera.bottom = -10;
    key.shadow.camera.near = 1; key.shadow.camera.far = 40;
    key.shadow.bias = -0.0008;
    key.shadow.radius = 4;
    this.scene.add(key);
    this.keyLight = key;

    // Rim light from behind/above gives tiles a premium edge highlight.
    this.rimLight = new THREE.DirectionalLight('#FF3B7B', 1.6);
    this.rimLight.position.set(0, 10, -12);
    this.scene.add(this.rimLight);

    // Theme-coloured accent point lights that slowly orbit the board.
    this.pointA = new THREE.PointLight('#00E5FF', 45, 40, 2);
    this.pointB = new THREE.PointLight('#FF3B7B', 35, 40, 2);
    this.scene.add(this.pointA, this.pointB);
  }

  /** 26 letters × (light, dark) canvas textures → shared materials. */
  _createLetterMaterials() {
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const make = (letter, fill, shadow) => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d');
      ctx.font = '800 92px "Exo 2", "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (shadow) {
        ctx.shadowColor = shadow;
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 3;
      }
      ctx.fillStyle = fill;
      ctx.fillText(letter, 64, 70);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;
      return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, toneMapped: false });
    };
    this.letterLight = {};
    this.letterDark = {};
    for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      this.letterLight[L] = make(L, '#ffffff', 'rgba(0,0,0,0.55)');
      this.letterDark[L] = make(L, '#050816', null);
    }
  }

  _createSharedAssets() {
    this.tileGeo = new RoundedBoxGeometry(TILE, TILE, DEPTH, this.low ? 2 : 4, 0.14);
    this.faceGeo = new THREE.PlaneGeometry(TILE * 0.9, TILE * 0.9);
    this.ringGeo = roundedRingGeometry(TILE * 1.14, TILE * 1.14, 0.22, 0.07);

    // Keyboard cursor (white) and tap-anchor (accent) rings — shape cues beyond colour.
    this.cursorRing = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, toneMapped: false }));
    this.anchorRing = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: this.colors.accent.clone().multiplyScalar(1.6), transparent: true, depthWrite: false, toneMapped: false }));
    [this.cursorRing, this.anchorRing].forEach((r) => { r.position.z = DEPTH / 2 + 0.03; r.visible = false; r.renderOrder = 5; });
  }

  _createComposer() {
    if (this.low) { this.composer = null; return; }
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.45, 1.0);
    composer.addPass(this.bloomPass);
    composer.addPass(new ShaderPass(VignetteShader));
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  /* ---------------- Quality ---------------- */

  setQuality(low) {
    if (low === this.low) return;
    this.low = low;
    this.renderer.shadowMap.enabled = !low;
    this.tiles.forEach((t) => { t.body.material.needsUpdate = true; });
    if (this.baseMesh) this.baseMesh.material.needsUpdate = true;
    if (low) { this.composer?.dispose?.(); this.composer = null; } else this._createComposer();
    this.resize();
  }

  /* ---------------- Theme ---------------- */

  _tweenColor(color, hex, duration, scale = 1) {
    const target = new THREE.Color(hex).multiplyScalar(scale);
    if (duration <= 0) { color.copy(target); return; }
    gsap.to(color, { r: target.r, g: target.g, b: target.b, duration, ease: 'power2.inOut', overwrite: true });
  }

  setTheme(theme, duration = 1.2) {
    if (!theme) return;
    this.theme = theme;
    const d = this.reducedMotion ? 0 : duration;
    this._tweenColor(this.skyUniforms.uTop.value, theme.bgTop, d);
    this._tweenColor(this.skyUniforms.uBottom.value, theme.bg, d);
    this._tweenColor(this.skyUniforms.uAccent.value, theme.accent, d);
    this._tweenColor(this.scene.fog.color, theme.fog, d);
    this._tweenColor(this.colors.tile, theme.tile, d);
    this._tweenColor(this.colors.board, theme.board, d);
    this._tweenColor(this.colors.accent, theme.accent, d);
    this._tweenColor(this.colors.accent2, theme.accent2, d);
    this._tweenColor(this.pointA.color, theme.accent, d);
    this._tweenColor(this.pointB.color, theme.accent2, d);
    this._tweenColor(this.rimLight.color, theme.accent2, d);
    this._tweenColor(this.ambient.color, theme.particle, d);
    this._tweenColor(this.anchorRing.material.color, theme.accent, d, 1.6);
    if (this.frameMesh) this._tweenColor(this.frameMesh.material.color, theme.accent, d, 3);
  }

  /* ---------------- Board ---------------- */

  cellPosition(row, col, n = this.size) {
    return { x: (col - (n - 1) / 2) * SPACING, y: ((n - 1) / 2 - row) * SPACING };
  }

  getTile(row, col) {
    return this.tiles[row * this.size + col] || null;
  }

  clearBoard() {
    if (!this.board) return;
    this.cursorRing.removeFromParent();
    this.anchorRing.removeFromParent();
    this.tiles.forEach((t) => gsap.killTweensOf(t.anim));
    // Dispose per-board resources; keep shared geometries/materials alive.
    const sharedGeo = new Set([this.tileGeo, this.faceGeo, this.ringGeo]);
    this.bandCache.forEach((b) => { sharedGeo.add(b.fill); sharedGeo.add(b.outline); });
    const sharedMat = new Set([
      ...Object.values(this.letterLight), ...Object.values(this.letterDark),
      this.cursorRing.material, this.anchorRing.material,
    ]);
    this.board.traverse((o) => {
      if (o.geometry && !sharedGeo.has(o.geometry)) o.geometry.dispose();
      if (o.material && !sharedMat.has(o.material)) o.material.dispose();
    });
    gsap.killTweensOf(this.board.rotation);
    this.root.remove(this.board);
    this.board = null;
    this.tiles = [];
    this.selected = [];
  }

  /**
   * Builds the 3D board for a grid.
   * @param {{size:number, cells:string[][]}} grid
   * @param {{mode?:'game'|'showcase', intro?:boolean}} options
   * @returns {Promise<void>} resolves when the intro animation ends
   */
  buildBoard(grid, { mode = 'game', intro = true } = {}) {
    this.clearBoard();
    this.mode = mode;
    const n = grid.size;
    this.size = n;
    const board = new THREE.Group();
    this.board = board;
    this.root.add(board);
    board.rotation.set(0, 0, 0);

    // Base slab + neon frame
    const span = n * SPACING;
    const baseMat = new THREE.MeshPhysicalMaterial({
      color: this.colors.board, roughness: 0.6, metalness: 0.3, clearcoat: 0.35, clearcoatRoughness: 0.4, envMapIntensity: 0.18,
    });
    const base = new THREE.Mesh(new RoundedBoxGeometry(span + 0.8, span + 0.8, 0.4, 3, 0.35), baseMat);
    base.position.z = -DEPTH / 2 - 0.22;
    base.receiveShadow = true;
    board.add(base);
    this.baseMesh = base;

    const frame = new THREE.Mesh(
      roundedRingGeometry(span + 0.9, span + 0.9, 0.45, 0.09),
      new THREE.MeshBasicMaterial({ color: this.colors.accent.clone().multiplyScalar(3), toneMapped: false }),
    );
    frame.position.z = -DEPTH / 2 - 0.01;
    board.add(frame);
    this.frameMesh = frame;

    // Tiles
    const tiles = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const letter = grid.cells[r][c];
        const { x, y } = this.cellPosition(r, c, n);
        const mat = this.low
          ? new THREE.MeshStandardMaterial({ color: this.colors.tile, roughness: 0.3, metalness: 0.25, envMapIntensity: 0.3 })
          : new THREE.MeshPhysicalMaterial({
            color: this.colors.tile, roughness: 0.28, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.3,
          });
        const body = new THREE.Mesh(this.tileGeo, mat);
        body.castShadow = true;
        const face = new THREE.Mesh(this.faceGeo, this.letterLight[letter]);
        face.position.z = FACE_Z;
        face.renderOrder = 2;
        const group = new THREE.Group();
        group.add(body, face);
        group.position.set(x, y, 0);
        board.add(group);

        tiles.push({
          row: r, col: c, letter, group, body, face, x, y,
          phase: Math.random() * Math.PI * 2,
          dark: false, hover: false, selected: false,
          foundColor: null, foundBody: null,
          hintUntil: 0, flash: 0,
          lift: 0, scale: 1, emissive: 0,
          anim: { lift: 0, scale: 1, shake: 0, flip: 0 },
        });
      }
    }
    this.tiles = tiles;

    // Band layer for found words and live selection
    this.bands = new THREE.Group();
    board.add(this.bands);
    this.selectionBand = this._makeBand(this.colors.accent, 0.3);
    this.selectionBand.group.visible = false;
    this.selectionBand.group.position.z = DEPTH / 2 + 0.4;
    this.bands.add(this.selectionBand.group);

    this.fitCamera();
    return this._playIntro(intro);
  }

  _playIntro(intro) {
    return new Promise((resolve) => {
      const reduced = this.reducedMotion;
      if (!intro || reduced) {
        this.cam.distScale = 1; this.cam.orbit = 0; this.cam.elev = BASE_ELEVATION;
        resolve();
        return;
      }
      const center = (this.size - 1) / 2;
      this.tiles.forEach((t) => {
        const dist = Math.hypot(t.row - center, t.col - center);
        t.anim.lift = 9 + Math.random() * 3;
        t.anim.scale = 0.2;
        gsap.to(t.anim, { lift: 0, scale: 1, duration: 0.9, delay: 0.25 + dist * 0.06 + Math.random() * 0.08, ease: 'back.out(1.3)' });
      });
      if (this.mode === 'game') {
        gsap.fromTo(this.cam,
          { distScale: 1.9, orbit: -0.8, elev: 0.5 },
          { distScale: 1, orbit: 0, elev: BASE_ELEVATION, duration: 1.9, ease: 'power3.out', onComplete: resolve });
      } else {
        gsap.fromTo(this.cam, { distScale: 1.4 }, { distScale: 1, duration: 2, ease: 'power2.out', onComplete: resolve });
      }
    });
  }

  /* ---------------- Bands (capsules marking words) ---------------- */

  _bandGeometry(length) {
    const key = length.toFixed(3);
    if (!this.bandCache.has(key)) {
      const shape = stadiumShape(length, BAND_RADIUS);
      const fill = new THREE.ShapeGeometry(shape, 12);
      const outline = new THREE.BufferGeometry().setFromPoints(shape.getPoints(24));
      this.bandCache.set(key, { fill, outline });
    }
    return this.bandCache.get(key);
  }

  _makeBand(color, opacity) {
    const group = new THREE.Group();
    const fill = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    const line = new THREE.LineLoop(undefined, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false,
    }));
    fill.renderOrder = 3; line.renderOrder = 4;
    group.add(fill, line);
    return { group, fill, line };
  }

  _placeBand(band, a, b) {
    const pa = this.cellPosition(a.row, a.col);
    const pb = this.cellPosition(b.row, b.col);
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const geo = this._bandGeometry(len);
    band.fill.geometry = geo.fill;
    band.line.geometry = geo.outline;
    band.group.position.x = (pa.x + pb.x) / 2;
    band.group.position.y = (pa.y + pb.y) / 2;
    band.group.rotation.z = Math.atan2(pb.y - pa.y, pb.x - pa.x);
  }

  /* ---------------- Interaction API ---------------- */

  /** Sets the live selection path (array of {row,col}). */
  setSelection(cells) {
    this.selected.forEach((t) => { t.selected = false; });
    this.selected = cells.map((c) => this.getTile(c.row, c.col)).filter(Boolean);
    this.selected.forEach((t, i) => {
      t.selected = true;
      if (!this.reducedMotion && i === this.selected.length - 1) {
        gsap.fromTo(t.anim, { scale: 1.18 }, { scale: 1, duration: 0.3, ease: 'back.out(3)', overwrite: 'auto' });
      }
    });
    if (this.selectionBand) {
      if (cells.length >= 2) {
        this._placeBand(this.selectionBand, cells[0], cells[cells.length - 1]);
        this.selectionBand.fill.material.color.copy(this.colors.accent);
        this.selectionBand.line.material.color.copy(this.colors.accent).multiplyScalar(1.6);
        this.selectionBand.group.visible = true;
      } else {
        this.selectionBand.group.visible = false;
      }
    }
  }

  setHover(cell) {
    this.tiles.forEach((t) => { t.hover = false; });
    const t = cell && this.getTile(cell.row, cell.col);
    if (t) t.hover = true;
  }

  _attachRing(ring, cell) {
    const t = cell && this.getTile(cell.row, cell.col);
    if (!t) { ring.visible = false; ring.removeFromParent(); return; }
    t.group.add(ring);
    ring.visible = true;
  }

  setCursor(cell) { this._attachRing(this.cursorRing, cell); }
  setAnchor(cell) { this._attachRing(this.anchorRing, cell); }

  /** Marks a found word: tile colours, capsule band, wave + particles. */
  markFound(cells, colorHex) {
    const color = new THREE.Color(colorHex);
    const band = this._makeBand(color.clone().multiplyScalar(0.8), 0.28);
    band.line.material.color.copy(color).multiplyScalar(1.5);
    band.group.position.z = DEPTH / 2 + 0.12;
    this._placeBand(band, cells[0], cells[cells.length - 1]);
    this.bands.add(band.group);
    if (!this.reducedMotion) {
      gsap.from(band.group.scale, { x: 0.05, y: 0.4, duration: 0.5, ease: 'back.out(1.6)' });
    }

    cells.forEach((c, i) => {
      const t = this.getTile(c.row, c.col);
      if (!t) return;
      t.foundColor = color;
      t.foundBody = this.colors.tile.clone().lerp(color, 0.7);
      const delay = i * 0.055;
      if (this.reducedMotion) {
        gsap.fromTo(t.anim, { lift: 0.25 }, { lift: 0, duration: 0.3, delay });
      } else {
        gsap.timeline({ delay })
          .to(t.anim, { lift: 0.7, scale: 1.15, duration: 0.18, ease: 'power2.out' })
          .to(t.anim, { flip: Math.PI * 2, duration: 0.5, ease: 'power2.inOut' }, 0)
          .to(t.anim, { lift: 0, scale: 1, duration: 0.45, ease: 'bounce.out' })
          .set(t.anim, { flip: 0 });
      }
      setTimeout(() => this.burstAtTile(t, color, 10), delay * 1000);
    });
  }

  /** Wrong word: red flash + shake. */
  reject(cells) {
    cells.forEach((c) => {
      const t = this.getTile(c.row, c.col);
      if (!t) return;
      t.flash = 1;
      if (!this.reducedMotion) {
        gsap.timeline()
          .to(t.anim, { shake: 0.12, duration: 0.05 })
          .to(t.anim, { shake: -0.1, duration: 0.07 })
          .to(t.anim, { shake: 0.07, duration: 0.07 })
          .to(t.anim, { shake: -0.04, duration: 0.07 })
          .to(t.anim, { shake: 0, duration: 0.08 });
      }
    });
  }

  /** Highlights a tile for a few seconds (hint). */
  hint(cell, seconds = 3.5) {
    const t = this.getTile(cell.row, cell.col);
    if (!t) return;
    t.hintUntil = this.time + seconds;
    this.burstAtTile(t, HINT_COLOR, 18);
  }

  burstAtTile(tile, color, count = 12) {
    const scale = this.low ? 0.4 : 1;
    tile.group.getWorldPosition(this._v3);
    this._v3.z += DEPTH;
    this.bursts.burst(this._v3, color, { count: Math.ceil(count * scale), speed: 3.2, size: 0.55 });
  }

  /** Level complete: ripple, spin and firework bursts. */
  celebrate() {
    const center = (this.size - 1) / 2;
    const reduced = this.reducedMotion;
    this.tiles.forEach((t) => {
      const d = Math.hypot(t.row - center, t.col - center);
      gsap.to(t.anim, {
        lift: reduced ? 0.3 : 1.3, duration: 0.35, delay: d * 0.06, yoyo: true, repeat: 1, ease: 'sine.inOut',
      });
    });
    if (!reduced && this.board) {
      gsap.to(this.board.rotation, {
        y: Math.PI * 2, duration: 1.8, delay: 0.3, ease: 'power2.inOut',
        onComplete: () => { if (this.board) this.board.rotation.y = 0; },
      });
      gsap.fromTo(this.cam, { distScale: 1 }, { distScale: 1.12, duration: 0.9, yoyo: true, repeat: 1, ease: 'sine.inOut' });
    }
    const palette = [this.theme?.accent, this.theme?.accent2, this.theme?.particle, '#ffffff'].filter(Boolean);
    const shots = this.low ? 4 : 10;
    for (let i = 0; i < shots; i++) {
      setTimeout(() => {
        const t = this.tiles[Math.floor(Math.random() * this.tiles.length)];
        if (t) this.burstAtTile(t, palette[i % palette.length], 34);
      }, 150 + i * 140);
    }
  }

  /* ---------------- Picking & projection ---------------- */

  /**
   * Converts a client point into a board cell.
   * Returns { row, col, inside, fr, fc } where fr/fc are fractional
   * (unclamped) coordinates — useful for drag direction snapping.
   */
  pickCell(clientX, clientY) {
    if (!this.board || this.mode !== 'game') return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    this.board.updateMatrixWorld();
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.board.getWorldQuaternion(new THREE.Quaternion()));
    const point = this.board.localToWorld(new THREE.Vector3(0, 0, DEPTH / 2));
    this._plane.setFromNormalAndCoplanarPoint(normal, point);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this._plane, hit)) return null;
    const local = this.board.worldToLocal(hit);
    const n = this.size;
    const fc = local.x / SPACING + (n - 1) / 2;
    const fr = (n - 1) / 2 - local.y / SPACING;
    const row = Math.round(fr);
    const col = Math.round(fc);
    const inside = row >= 0 && row < n && col >= 0 && col < n;
    return { row, col, fr, fc, inside };
  }

  /** Screen-space (client px) position of a cell's top face. */
  cellToScreen(row, col) {
    const t = this.getTile(row, col);
    if (!t) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    t.group.getWorldPosition(this._v3);
    this._v3.z += DEPTH;
    this._v3.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + ((this._v3.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - this._v3.y) / 2) * rect.height,
    };
  }

  /* ---------------- Camera ---------------- */

  /** DOM rect the board should fill (game mode). null = full screen. */
  setBoardRect(rect) {
    this.boardRect = rect;
    this.fitCamera();
  }

  fitCamera() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cam = this.camera;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const worldSize = Math.max(1, this.size) * SPACING + 0.9;
    const r = this.boardRect;

    if (r && r.width > 10 && r.height > 10) {
      const margin = this.mode === 'game' ? 0.9 : 0.72;
      const dH = (worldSize * H) / (r.height * margin * 2 * tanHalf);
      const dW = (worldSize * W) / (r.width * margin * 2 * tanHalf * cam.aspect);
      this.cam.fitDist = Math.max(dH, dW);
      const dx = r.left + r.width / 2 - W / 2;
      const dy = r.top + r.height / 2 - H / 2;
      cam.setViewOffset(W, H, -dx, -dy, W, H);
    } else {
      cam.clearViewOffset();
      const fitH = worldSize / (2 * tanHalf);
      const fitW = worldSize / (2 * tanHalf * cam.aspect);
      this.cam.fitDist = Math.max(fitH, fitW) * 1.55;
    }
    cam.updateProjectionMatrix();
  }

  _updateCamera(dt) {
    const allowParallax = !this.reducedMotion && !(this.touch && this.mode === 'game');
    const amt = allowParallax ? (this.mode === 'game' ? 0.035 : 0.12) : 0;
    const k = damp(3.5, dt);
    this.parallax.x = lerp(this.parallax.x, this.pointer.x * amt, k);
    this.parallax.y = lerp(this.parallax.y, this.pointer.y * amt, k);

    const drift = this.mode === 'showcase' && !this.reducedMotion ? Math.sin(this.time * 0.18) * 0.28 : 0;
    const orbit = this.cam.orbit + this.parallax.x + drift;
    const elev = this.cam.elev + this.parallax.y * 0.6;
    const d = this.cam.fitDist * this.cam.distScale;
    this.camera.position.set(
      d * Math.sin(orbit) * Math.cos(elev),
      d * Math.sin(elev),
      d * Math.cos(orbit) * Math.cos(elev),
    );
    this.camera.lookAt(0, 0, 0);
    this.scene.fog.density = 0.22 / Math.max(10, d);
  }

  /* ---------------- Per-frame tile update ---------------- */

  _updateTiles(dt) {
    const k = damp(14, dt);
    const t = this.time;
    const floatAmp = this.reducedMotion ? 0 : 0.035;
    const tmpColor = this._tmpColor || (this._tmpColor = new THREE.Color());
    const tmpEm = this._tmpEm || (this._tmpEm = new THREE.Color());

    for (const tile of this.tiles) {
      let lift = 0;
      let scale = 1;
      let emI = 0;
      let dark = false;
      tmpColor.copy(this.colors.tile);
      tmpEm.copy(BLACK);

      if (tile.foundColor) {
        tmpColor.copy(tile.foundBody);
        tmpEm.copy(tile.foundColor);
        emI = 0.28;
        dark = true;
        lift = -0.03;
      }
      if (tile.hover && !tile.selected) {
        lift += 0.12;
        if (!tile.foundColor) { tmpEm.copy(this.colors.accent); emI = 0.22; }
      }
      if (tile.hintUntil > t) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 9);
        tmpEm.copy(HINT_COLOR);
        emI = 0.5 + pulse * 1.3;
        lift += 0.15 * pulse;
      }
      if (tile.selected) {
        tmpColor.copy(this.colors.accent);
        tmpEm.copy(this.colors.accent);
        emI = 1.1;
        lift = 0.32;
        scale = 1.05;
        dark = true;
      }
      if (tile.flash > 0) {
        tile.flash = Math.max(0, tile.flash - dt * 2.2);
        tmpEm.lerp(ERROR_COLOR, Math.min(1, tile.flash * 1.5));
        emI = Math.max(emI, tile.flash * 1.6);
      }

      const m = tile.body.material;
      m.color.lerp(tmpColor, k);
      m.emissive.lerp(tmpEm, k);
      tile.emissive = lerp(tile.emissive, emI, k);
      m.emissiveIntensity = tile.emissive;
      tile.lift = lerp(tile.lift, lift, k);
      tile.scale = lerp(tile.scale, scale, k);

      if (dark !== tile.dark) {
        tile.dark = dark;
        tile.face.material = dark ? this.letterDark[tile.letter] : this.letterLight[tile.letter];
      }

      const float = Math.sin(t * 1.3 + tile.phase) * floatAmp;
      tile.group.position.set(tile.x + tile.anim.shake, tile.y, float + tile.lift + tile.anim.lift);
      tile.group.scale.setScalar(tile.scale * tile.anim.scale);
      tile.group.rotation.x = tile.anim.flip;
    }

    // Pulse the anchor ring so it reads as "waiting for second tap".
    if (this.anchorRing.visible) this.anchorRing.material.opacity = 0.6 + 0.4 * Math.sin(t * 6);
  }

  /* ---------------- Loop ---------------- */

  onFrame(fn) { this.frameCallbacks.add(fn); return () => this.frameCallbacks.delete(fn); }

  start() {
    if (this.running || document.hidden) return;
    this.running = true;
    this.clock.getDelta();
    this._raf = requestAnimationFrame(this._loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  /** Pausing freezes the frame (keeps the last image) and stops the loop. */
  setPaused(paused) {
    this.paused = paused;
    if (paused) { this._render(); this.stop(); } else this.start();
  }

  _loop() {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    this.frameCallbacks.forEach((fn) => fn(dt));

    this.skyUniforms.uTime.value = this.time;
    this.ambient.update(this.time);
    this.bursts.update(dt);

    // Accent lights orbit slowly for living reflections.
    const a = this.time * 0.35;
    this.pointA.position.set(Math.cos(a) * 9, Math.sin(a) * 6, 6);
    this.pointB.position.set(Math.cos(a + Math.PI) * 9, Math.sin(a + Math.PI) * 6, 5);

    if (this.board && this.mode === 'showcase' && !this.reducedMotion) {
      this.board.rotation.x = Math.sin(this.time * 0.4) * 0.08;
      this.board.rotation.z = Math.sin(this.time * 0.25) * 0.03;
    }

    this._updateCamera(dt);
    this._updateTiles(dt);
    this._render();
  }

  _render() {
    // A zero-sized viewport (hidden iframe, minimised window) would leave
    // the post-processing targets incomplete — skip until it has a size.
    if (!window.innerWidth || !window.innerHeight) return;
    if (this._needsResize) this.resize();
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    this._needsResize = !W || !H;
    if (this._needsResize) return;
    const pr = Math.min(window.devicePixelRatio, this.low ? 1 : 1.75);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(W, H, false);
    this.camera.aspect = W / H;
    this.composer?.setPixelRatio(pr);
    this.composer?.setSize(W, H);
    this.bursts?.setPixelRatio(pr);
    this.ambient?.setPixelRatio(pr);
    this.fitCamera();
    if (!this.running) this._render();
  }
}
