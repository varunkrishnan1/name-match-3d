/**
 * grid.js
 * ------------------------------------------------------------------
 * Word grid generator.
 *
 * Strategy:
 *   1. Fast greedy pass — each word (longest first) tries random
 *      positions/directions via placeWord().
 *   2. If greedy fails, a randomized backtracking solver enumerates
 *      every legal placement, so dense boards still resolve.
 *   3. Empty cells are filled with letters, then validateGrid()
 *      confirms every word is readable and (ideally) appears once.
 *
 * Overlaps are limited to a single shared letter per word, which
 * avoids confusing layouts where one name hides inside another.
 */

import { DIRECTIONS } from './levels.js';
import { shuffle } from './utils.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_OVERLAP = 1;

const createEmptyGrid = (size) => Array.from({ length: size }, () => Array(size).fill(null));

/** Random cell coordinate inside the grid. */
export function getRandomPosition(size, rng = Math.random) {
  return { row: Math.floor(rng() * size), col: Math.floor(rng() * size) };
}

/**
 * Checks whether `word` fits at (row, col) going `direction`.
 * Returns the number of overlapping (shared) letters, or -1 if illegal.
 */
export function checkPlacement(word, row, col, direction, grid) {
  const [dr, dc] = DIRECTIONS[direction];
  const size = grid.length;
  const endR = row + dr * (word.length - 1);
  const endC = col + dc * (word.length - 1);
  if (endR < 0 || endR >= size || endC < 0 || endC >= size) return -1;

  let overlap = 0;
  for (let i = 0; i < word.length; i++) {
    const cell = grid[row + dr * i][col + dc * i];
    if (cell === null) continue;
    if (cell !== word[i]) return -1;
    overlap++;
  }
  return overlap <= MAX_OVERLAP ? overlap : -1;
}

/** Writes a word; returns the list of cells that were newly written (for undo). */
function writeWord(grid, word, { row, col, direction }) {
  const [dr, dc] = DIRECTIONS[direction];
  const written = [];
  for (let i = 0; i < word.length; i++) {
    const r = row + dr * i;
    const c = col + dc * i;
    if (grid[r][c] === null) {
      grid[r][c] = word[i];
      written.push([r, c]);
    }
  }
  return written;
}

/**
 * Greedy placement: tries random positions and directions.
 * Returns the placement or null. Mutates the grid on success.
 */
export function placeWord(word, grid, directions, rng = Math.random, attempts = 250) {
  for (let i = 0; i < attempts; i++) {
    const { row, col } = getRandomPosition(grid.length, rng);
    const direction = directions[Math.floor(rng() * directions.length)];
    if (checkPlacement(word, row, col, direction, grid) >= 0) {
      writeWord(grid, word, { row, col, direction });
      return { word, row, col, direction };
    }
  }
  return null;
}

/** Every legal placement for a word, shuffled, overlaps slightly preferred. */
function allCandidates(word, grid, directions, rng) {
  const out = [];
  const size = grid.length;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      for (const direction of directions) {
        const ov = checkPlacement(word, row, col, direction, grid);
        if (ov >= 0) out.push({ row, col, direction, ov });
      }
    }
  }
  // Shuffle, then pull overlapping placements to the front (stable sort keeps
  // the random order within each group) — keeps dense boards solvable.
  const shuffled = shuffle(out, rng).sort((a, b) => b.ov - a.ov);
  return shuffled.slice(0, 40);
}

/** Randomized depth-first backtracking solver. */
function solve(words, index, grid, directions, placements, rng, budget) {
  if (index === words.length) return true;
  if (++budget.steps > 6000) return false;
  const word = words[index];
  for (const cand of allCandidates(word, grid, directions, rng)) {
    const written = writeWord(grid, word, cand);
    placements.push({ word, row: cand.row, col: cand.col, direction: cand.direction });
    if (solve(words, index + 1, grid, directions, placements, rng, budget)) return true;
    placements.pop();
    written.forEach(([r, c]) => { grid[r][c] = null; });
  }
  return false;
}

/**
 * Fills empty cells with letters. The pool is biased toward letters
 * used in the level's names so decoys look plausible.
 * Returns the filled coordinates so they can be re-rolled.
 */
export function fillEmptyCells(grid, names, rng = Math.random, filled = null) {
  const pool = ALPHABET + ALPHABET + names.join('');
  const cells = filled || [];
  if (!filled) {
    grid.forEach((row, r) => row.forEach((v, c) => { if (v === null) cells.push([r, c]); }));
  }
  cells.forEach(([r, c]) => { grid[r][c] = pool[Math.floor(rng() * pool.length)]; });
  return cells;
}

/** Reads the letters along a placement. */
function readPlacement(grid, { word, row, col, direction }) {
  const [dr, dc] = DIRECTIONS[direction];
  let s = '';
  for (let i = 0; i < word.length; i++) s += grid[row + dr * i]?.[col + dc * i] ?? '';
  return s;
}

/** Counts how many times a word appears in the grid in any direction. */
export function countOccurrences(grid, word) {
  const size = grid.length;
  let count = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] !== word[0]) continue;
      for (const dir of Object.keys(DIRECTIONS)) {
        if (readPlacement(grid, { word, row: r, col: c, direction: dir }) === word) count++;
      }
    }
  }
  return count;
}

/**
 * Validates a generated grid.
 *  - valid: every cell is A–Z and every word reads correctly at its placement
 *  - unique: every word appears exactly once (no accidental duplicates)
 */
export function validateGrid(grid, placements, names) {
  const lettersOk = grid.every((row) => row.every((v) => typeof v === 'string' && /^[A-Z]$/.test(v)));
  const placedOk = names.every((n) => placements.some((p) => p.word === n && readPlacement(grid, p) === n));
  const valid = lettersOk && placedOk && placements.length === names.length;
  const unique = valid && names.every((n) => countOccurrences(grid, n) === 1);
  return { valid, unique };
}

/**
 * Generates a complete, validated grid for a level.
 * @returns {{ size:number, cells:string[][], placements:Array }}
 */
export function generateGrid(level, rng = Math.random) {
  const size = level.gridSize;
  const names = level.names.map((n) => n.toUpperCase());
  const ordered = [...names].sort((a, b) => b.length - a.length);
  if (ordered[0].length > size) throw new Error(`"${ordered[0]}" does not fit a ${size}x${size} grid`);

  let fallback = null;

  for (let attempt = 0; attempt < 40; attempt++) {
    let grid = createEmptyGrid(size);
    let placements = [];

    // 1) greedy
    for (const word of ordered) {
      const p = placeWord(word, grid, level.directions, rng);
      if (!p) { placements = null; break; }
      placements.push(p);
    }

    // 2) backtracking fallback
    if (!placements) {
      grid = createEmptyGrid(size);
      placements = [];
      if (!solve(ordered, 0, grid, level.directions, placements, rng, { steps: 0 })) continue;
    }

    // 3) fill + validate (re-roll filler letters to remove accidental duplicates)
    const fillerCells = fillEmptyCells(grid, names, rng);
    for (let f = 0; f < 25; f++) {
      const { valid, unique } = validateGrid(grid, placements, names);
      if (!valid) break;
      if (unique) return { size, cells: grid, placements };
      fallback = fallback || { size, cells: grid.map((r) => [...r]), placements: [...placements] };
      fillEmptyCells(grid, names, rng, fillerCells);
    }
  }

  // Duplicates are harmless (any straight line spelling a name counts),
  // so a valid-but-not-unique grid is an acceptable last resort.
  if (fallback) return fallback;
  throw new Error(`Unable to generate grid for level ${level.id}`);
}
