/**
 * particles.js
 * ------------------------------------------------------------------
 *  - BurstParticles   : pooled GPU points for sparkles / match bursts
 *  - AmbientParticles : shader-animated floating dust (no CPU cost)
 *  - Confetti2D       : lightweight canvas confetti for celebrations
 */

import * as THREE from 'three';

/* Soft round sprite shared by both point systems */
const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float core = smoothstep(0.5, 0.0, d);
    float glow = pow(core, 2.2);
    if (glow < 0.01) discard;
    gl_FragColor = vec4(vColor * (0.6 + glow * 1.6), glow * vAlpha);
  }
`;

/* ==================================================================
 * Burst particles — fixed-size pool, CPU integrated, one draw call.
 * ================================================================== */
export class BurstParticles {
  constructor(max = 600) {
    this.max = max;
    this.cursor = 0;
    this.positions = new Float32Array(max * 3);
    this.colors = new Float32Array(max * 3);
    this.sizes = new Float32Array(max);
    this.alphas = new Float32Array(max);
    this.velocities = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.gravity = new Float32Array(max);
    this.activeCount = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        attribute vec3 color;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatio * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  /**
   * Emits `count` particles from a world position.
   * @param {THREE.Vector3} origin
   * @param {THREE.Color|string} color
   */
  burst(origin, color, { count = 24, speed = 3, size = 0.5, life = 0.9, gravity = -2.5, spread = 0.2, up = 1.2 } = {}) {
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    const white = new THREE.Color('#ffffff');
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const i3 = i * 3;
      this.positions[i3] = origin.x + (Math.random() - 0.5) * spread;
      this.positions[i3 + 1] = origin.y + (Math.random() - 0.5) * spread;
      this.positions[i3 + 2] = origin.z + (Math.random() - 0.5) * spread;
      // random direction biased toward the camera (+z)
      const theta = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.velocities[i3] = Math.cos(theta) * s;
      this.velocities[i3 + 1] = Math.sin(theta) * s;
      this.velocities[i3 + 2] = (0.4 + Math.random()) * up;
      const mix = Math.random() * 0.45;
      const col = c.clone().lerp(white, mix);
      this.colors[i3] = col.r; this.colors[i3 + 1] = col.g; this.colors[i3 + 2] = col.b;
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.6);
      this.baseSize[i] = size * (0.5 + Math.random());
      this.gravity[i] = gravity;
    }
    this.activeCount = this.max;
  }

  update(dt) {
    if (!this.activeCount) return;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alphas[i] = 0; this.sizes[i] = 0; continue; }
      alive++;
      this.life[i] -= dt;
      const i3 = i * 3;
      const drag = 1 - 2.2 * dt;
      this.velocities[i3] *= drag;
      this.velocities[i3 + 1] = this.velocities[i3 + 1] * drag + this.gravity[i] * dt;
      this.velocities[i3 + 2] *= drag;
      this.positions[i3] += this.velocities[i3] * dt;
      this.positions[i3 + 1] += this.velocities[i3 + 1] * dt;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alphas[i] = t;
      this.sizes[i] = this.baseSize[i] * (0.4 + t * 0.6);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    if (!alive) this.activeCount = 0;
  }

  setPixelRatio(pr) { this.points.material.uniforms.uPixelRatio.value = pr; }
}

/* ==================================================================
 * Ambient particles — drift entirely on the GPU via a time uniform.
 * ================================================================== */
export class AmbientParticles {
  constructor(count = 260, color = '#00E5FF') {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 44;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 30;
      pos[i * 3 + 2] = -14 + Math.random() * 20;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(color) },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: /* glsl */ `
        attribute float seed;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform vec3 uColor;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec3 p = position;
          float t = uTime * (0.15 + seed * 0.25);
          p.y = mod(p.y + t * 2.0 + 15.0, 30.0) - 15.0;
          p.x += sin(t * 2.0 + seed * 20.0) * 0.8;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (1.5 + seed * 3.5) * uPixelRatio * (60.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
          vColor = uColor;
          vAlpha = (0.25 + 0.5 * seed) * (0.6 + 0.4 * sin(uTime * 2.0 + seed * 40.0));
        }
      `,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  update(time) { this.material.uniforms.uTime.value = time; }
  get color() { return this.material.uniforms.uColor.value; }
  setPixelRatio(pr) { this.material.uniforms.uPixelRatio.value = pr; }
}

/* ==================================================================
 * Confetti2D — DOM canvas overlay. Runs its own RAF loop only while
 * pieces are alive, so it costs nothing when idle.
 * ================================================================== */
export class Confetti2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pieces = [];
    this.running = false;
    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  launch({ count = 160, colors = ['#00E5FF', '#8B5CF6', '#22C55E', '#F59E0B', '#FF3B7B'] } = {}) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = 0; i < count; i++) {
      const fromLeft = i % 2 === 0;
      this.pieces.push({
        x: fromLeft ? -10 : w + 10,
        y: h * (0.55 + Math.random() * 0.3),
        vx: (fromLeft ? 1 : -1) * (250 + Math.random() * 520),
        vy: -(520 + Math.random() * 620),
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 14,
        w: 6 + Math.random() * 8,
        h: 8 + Math.random() * 10,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 2.6 + Math.random() * 1.6,
        wobble: Math.random() * 10,
      });
    }
    if (!this.running) {
      this.running = true;
      this.last = performance.now();
      requestAnimationFrame((t) => this.tick(t));
    }
  }

  tick(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const { ctx } = this;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    this.pieces = this.pieces.filter((p) => p.life > 0 && p.y < window.innerHeight + 40);
    for (const p of this.pieces) {
      p.life -= dt;
      p.vy += 900 * dt;
      p.vx *= 1 - 1.2 * dt;
      p.x += p.vx * dt + Math.sin(p.wobble + p.life * 6) * 0.6;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.cos(p.rot * 2));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (this.pieces.length) requestAnimationFrame((t) => this.tick(t));
    else { this.running = false; ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); }
  }
}
