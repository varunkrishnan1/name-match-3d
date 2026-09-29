/**
 * levels.js
 * ------------------------------------------------------------------
 * Level data, visual themes and direction definitions.
 * Difficulty ramps up through grid size, allowed directions
 * (reversed/diagonal words appear later) and time pressure.
 */

import { createRng, hashString, shuffle } from './utils.js';

/* ------------------------------------------------------------------
 * Directions: [rowDelta, colDelta]
 * ------------------------------------------------------------------ */
export const DIRECTIONS = {
  E: [0, 1],   // left → right
  W: [0, -1],  // right → left (reversed)
  S: [1, 0],   // top → bottom
  N: [-1, 0],  // bottom → top (reversed)
  SE: [1, 1],  // diagonal down-right
  NW: [-1, -1],// diagonal up-left (reversed)
  NE: [-1, 1], // diagonal up-right
  SW: [1, -1], // diagonal down-left (reversed)
};

const DIRS_EASY_1 = ['E', 'S'];
const DIRS_EASY_2 = ['E', 'S', 'SE'];
const DIRS_MED_1 = ['E', 'S', 'SE', 'NE'];
const DIRS_MED_2 = ['E', 'S', 'SE', 'NE', 'W'];
const DIRS_MED_3 = ['E', 'S', 'SE', 'NE', 'W', 'N'];
const DIRS_ALL = Object.keys(DIRECTIONS);

/* ------------------------------------------------------------------
 * Visual themes — every colour used by the 3D scene, particles and
 * the music key (root note, MIDI) lives here.
 * ------------------------------------------------------------------ */
export const THEMES = {
  neonCity: {
    name: 'Neon City', bg: '#050816', bgTop: '#1b0f3d', fog: '#0a0b24',
    tile: '#161d44', board: '#0b1030', accent: '#00E5FF', accent2: '#FF3B7B',
    particle: '#00E5FF', rootNote: 57, pitch: 0,
  },
  crystalCave: {
    name: 'Crystal Cave', bg: '#03111a', bgTop: '#0f3b4a', fog: '#06202a',
    tile: '#113440', board: '#08202a', accent: '#5EEAD4', accent2: '#A78BFA',
    particle: '#A5F3FC', rootNote: 59, pitch: 1,
  },
  spaceStation: {
    name: 'Space Station', bg: '#02030a', bgTop: '#101d3f', fog: '#050814',
    tile: '#1b2440', board: '#0c1226', accent: '#60A5FA', accent2: '#F472B6',
    particle: '#E0E7FF', rootNote: 55, pitch: -1,
  },
  candyWorld: {
    name: 'Candy World', bg: '#1a0620', bgTop: '#4d1553', fog: '#2a0a30',
    tile: '#3c1644', board: '#260b2c', accent: '#FF7AC6', accent2: '#FFD166',
    particle: '#FFB3E0', rootNote: 60, pitch: 2,
  },
  cyberGrid: {
    name: 'Cyber Grid', bg: '#020b08', bgTop: '#07301f', fog: '#041a12',
    tile: '#0d2c22', board: '#061a14', accent: '#39FF88', accent2: '#00E5FF',
    particle: '#39FF88', rootNote: 57, pitch: 0,
  },
  oceanDepths: {
    name: 'Ocean Depths', bg: '#010a18', bgTop: '#03304f', fog: '#021628',
    tile: '#0b2c48', board: '#061a2e', accent: '#38BDF8', accent2: '#2DD4BF',
    particle: '#7DD3FC', rootNote: 53, pitch: -2,
  },
  sunsetDesert: {
    name: 'Sunset Desert', bg: '#1a0805', bgTop: '#5c2213', fog: '#2a0f08',
    tile: '#3f1c14', board: '#28100a', accent: '#FF8A3D', accent2: '#FFD166',
    particle: '#FFC48A', rootNote: 58, pitch: 1,
  },
  frozenPeaks: {
    name: 'Frozen Peaks', bg: '#06101f', bgTop: '#2a4566', fog: '#0c1a2e',
    tile: '#203552', board: '#12213a', accent: '#BAE6FD', accent2: '#A5B4FC',
    particle: '#FFFFFF', rootNote: 62, pitch: 3,
  },
  magicForest: {
    name: 'Magic Forest', bg: '#040f08', bgTop: '#1c3d1e', fog: '#081a0d',
    tile: '#17321e', board: '#0c1f12', accent: '#A3E635', accent2: '#E879F9',
    particle: '#D9F99D', rootNote: 56, pitch: -1,
  },
  goldenVault: {
    name: 'Golden Vault', bg: '#0f0a02', bgTop: '#3d2c07', fog: '#1c1404',
    tile: '#30240c', board: '#1e1606', accent: '#FACC15', accent2: '#FB923C',
    particle: '#FDE68A', rootNote: 61, pitch: 2,
  },
};

/** Distinct highlight colours used for found words (colour-blind friendly-ish order). */
export const WORD_COLORS = [
  '#22C55E', '#F59E0B', '#8B5CF6', '#00E5FF', '#FF3B7B',
  '#38BDF8', '#A3E635', '#F472B6', '#FACC15', '#2DD4BF',
];

/* ------------------------------------------------------------------
 * The 10 campaign levels
 * ------------------------------------------------------------------ */
export const LEVELS = [
  {
    id: 1, title: 'Level 1', theme: 'neonCity', difficulty: 'easy',
    gridSize: 9, timeLimit: 180, multiplier: 1, hints: 3, directions: DIRS_EASY_1,
    names: ['ALICE', 'BRIAN', 'CLARA', 'DAVID', 'EMMA', 'FRANK', 'GRACE', 'HENRY', 'IRENE', 'JACK'],
  },
  {
    id: 2, title: 'Level 2', theme: 'crystalCave', difficulty: 'easy',
    gridSize: 9, timeLimit: 175, multiplier: 1.1, hints: 3, directions: DIRS_EASY_2,
    names: ['LUCAS', 'MIA', 'NOAH', 'OLIVIA', 'PETER', 'QUINN', 'RUBY', 'SAM', 'TINA', 'VICTOR'],
  },
  {
    id: 3, title: 'Level 3', theme: 'spaceStation', difficulty: 'easy',
    gridSize: 10, timeLimit: 170, multiplier: 1.2, hints: 3, directions: DIRS_EASY_2,
    names: ['ADAM', 'BELLA', 'CHLOE', 'DYLAN', 'ETHAN', 'FIONA', 'GEORGE', 'HAZEL', 'ISAAC', 'KEVIN'],
  },
  {
    id: 4, title: 'Level 4', theme: 'candyWorld', difficulty: 'medium',
    gridSize: 10, timeLimit: 190, multiplier: 1.4, hints: 3, directions: DIRS_MED_1,
    names: ['LAURA', 'MARTIN', 'NATALIE', 'OSCAR', 'PENNY', 'RACHEL', 'SOPHIA', 'THOMAS', 'URSULA', 'VIOLET'],
  },
  {
    id: 5, title: 'Level 5', theme: 'cyberGrid', difficulty: 'medium',
    gridSize: 11, timeLimit: 190, multiplier: 1.6, hints: 3, directions: DIRS_MED_2,
    names: ['WILLIAM', 'XAVIER', 'YVONNE', 'ZACHARY', 'AMELIA', 'BENJAMIN', 'CAROLINE', 'DANIEL', 'ELEANOR', 'FELIX'],
  },
  {
    id: 6, title: 'Level 6', theme: 'oceanDepths', difficulty: 'medium',
    gridSize: 11, timeLimit: 185, multiplier: 1.8, hints: 2, directions: DIRS_MED_3,
    names: ['GABRIEL', 'HARRIET', 'ISABELLA', 'JONATHAN', 'KATHERINE', 'LEONARD', 'MADELINE', 'NATHANIEL', 'OLIVER', 'PATRICIA'],
  },
  {
    id: 7, title: 'Level 7', theme: 'sunsetDesert', difficulty: 'hard',
    gridSize: 12, timeLimit: 190, multiplier: 2, hints: 2, directions: DIRS_ALL,
    names: ['QUENTIN', 'ROSALIND', 'SEBASTIAN', 'THEODORE', 'VALENTINA', 'WINIFRED', 'ALEXANDER', 'BEATRICE', 'CORNELIUS', 'DOMINIC'],
  },
  {
    id: 8, title: 'Level 8', theme: 'frozenPeaks', difficulty: 'hard',
    gridSize: 12, timeLimit: 180, multiplier: 2.2, hints: 2, directions: DIRS_ALL,
    names: ['EVANGELINE', 'FREDERICK', 'GWENDOLYN', 'HARRISON', 'IMOGEN', 'JOSEPHINE', 'KIMBERLY', 'LAWRENCE', 'MAXIMILIAN', 'NICHOLAS'],
  },
  {
    id: 9, title: 'Level 9', theme: 'magicForest', difficulty: 'hard',
    gridSize: 12, timeLimit: 170, multiplier: 2.5, hints: 1, directions: DIRS_ALL,
    names: ['OCTAVIA', 'PENELOPE', 'RAPHAEL', 'SAMANTHA', 'TIMOTHY', 'VERONICA', 'WESLEY', 'ANASTASIA', 'BARTHOLOMEW', 'CASSANDRA'],
  },
  {
    id: 10, title: 'Level 10', theme: 'goldenVault', difficulty: 'hard',
    gridSize: 12, timeLimit: 160, multiplier: 3, hints: 1, directions: DIRS_ALL,
    names: ['DESMOND', 'ELIZABETH', 'FLORENCE', 'GENEVIEVE', 'HUMPHREY', 'JACQUELINE', 'LEOPOLD', 'MARGARET', 'NAPOLEON', 'OPHELIA'],
  },
];

export const TOTAL_LEVELS = LEVELS.length;

/** Returns a level definition by id, with its theme object resolved. */
export function getLevel(id) {
  const level = LEVELS.find((l) => l.id === id);
  if (!level) return null;
  return { ...level, themeData: THEMES[level.theme] };
}

/** Today's date as YYYY-MM-DD in local time. */
export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Daily challenge: a deterministic level built from the date, so every
 * player sees the same board on the same day.
 */
export function createDailyLevel(dateKey = todayKey()) {
  const seed = hashString(`nm3d-${dateKey}`);
  const rng = createRng(seed);
  const pool = [...new Set(LEVELS.flatMap((l) => l.names))].filter((n) => n.length >= 4 && n.length <= 10);
  const names = [];
  for (const name of shuffle(pool, rng)) {
    // Avoid names that contain each other (e.g. SAM / SAMANTHA) to keep matching unambiguous.
    if (names.some((n) => n.includes(name) || name.includes(n))) continue;
    names.push(name);
    if (names.length === 10) break;
  }
  const themeKeys = Object.keys(THEMES);
  const theme = themeKeys[Math.floor(rng() * themeKeys.length)];
  return {
    id: 'daily', title: 'Daily Challenge', theme, difficulty: 'hard',
    gridSize: 12, timeLimit: 200, multiplier: 2, hints: 2, directions: DIRS_ALL,
    names, seed, dateKey, themeData: THEMES[theme],
  };
}
