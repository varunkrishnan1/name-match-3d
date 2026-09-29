/**
 * utils.js
 * ------------------------------------------------------------------
 * Small, dependency-free helpers shared across modules.
 */

/** GSAP is loaded as a classic script (see index.html) and re-exported here. */
export const gsap = window.gsap;

/* ---------------- Math ---------------- */
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (min, max) => min + Math.random() * (max - min);
export const randInt = (min, max) => Math.floor(rand(min, max + 1));

/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Seeded PRNG (mulberry32). Returns a function producing [0, 1). */
export function createRng(seed = Date.now()) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit string hash (FNV-1a). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fisher–Yates shuffle, returns a new array. */
export function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------------- DOM ---------------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/* ---------------- Formatting ---------------- */
export function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export const formatNumber = (n) => Math.round(n).toLocaleString('en-US');

/* ---------------- Device / environment ---------------- */
export const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export const isTouchDevice = () =>
  'ontouchstart' in window || navigator.maxTouchPoints > 0;

/** Heuristic for weak devices — used when performance mode is "auto". */
export function detectLowPerformance() {
  const cores = navigator.hardwareConcurrency || 8;
  const memory = navigator.deviceMemory || 8;
  const smallScreen = Math.min(window.screen.width, window.screen.height) < 500;
  return cores <= 4 || memory <= 3 || (isTouchDevice() && smallScreen && cores <= 6);
}

/** Vibrate if supported and enabled. */
export function vibrate(pattern, enabled = true) {
  if (!enabled || !navigator.vibrate) return;
  try { navigator.vibrate(pattern); } catch { /* ignore */ }
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ensures web fonts are ready before drawing text into canvases. */
export async function loadFonts(fonts) {
  if (!document.fonts?.load) return;
  try {
    await Promise.race([
      Promise.all(fonts.map((f) => document.fonts.load(f))),
      wait(2500), // never block the game on a slow font CDN
    ]);
  } catch { /* fall back to system fonts */ }
}
