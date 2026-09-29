/**
 * storage.js
 * ------------------------------------------------------------------
 * LocalStorage persistence for progress and settings. All access is
 * wrapped in try/catch so private browsing / blocked storage never
 * breaks the game — it simply won't remember progress.
 */

import { TOTAL_LEVELS } from './levels.js';

export const SAVE_KEY = 'nameMatch3D_saveData';

const DEFAULT_SAVE = {
  version: 1,
  unlockedLevels: 1,
  levelStars: {},
  bestScores: {},
  lastPlayedLevel: 1,
  daily: {}, // { 'YYYY-MM-DD': bestScore }
  settings: {
    sound: true,
    music: true,
    vibration: true,
    performance: 'auto', // 'auto' | 'on' | 'off'
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return clone(DEFAULT_SAVE);
    const parsed = JSON.parse(raw);
    return {
      ...clone(DEFAULT_SAVE),
      ...parsed,
      settings: { ...DEFAULT_SAVE.settings, ...(parsed.settings || {}) },
    };
  } catch {
    return clone(DEFAULT_SAVE);
  }
}

export function writeSave(save) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch { /* storage unavailable — ignore */ }
}

export function resetSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
  return clone(DEFAULT_SAVE);
}

/**
 * Merges a finished level into the save. Returns the new save and
 * whether this was a new best score.
 */
export function recordLevelResult(save, levelId, { score, stars }) {
  const next = clone(save);
  const prevBest = next.bestScores[levelId] || 0;
  const newBest = score > prevBest;
  next.bestScores[levelId] = Math.max(prevBest, score);
  next.levelStars[levelId] = Math.max(next.levelStars[levelId] || 0, stars);
  next.unlockedLevels = Math.min(TOTAL_LEVELS, Math.max(next.unlockedLevels, levelId + 1));
  next.lastPlayedLevel = Math.min(TOTAL_LEVELS, levelId + 1);
  writeSave(next);
  return { save: next, newBest, prevBest };
}

export function recordDailyResult(save, dateKey, score) {
  const next = clone(save);
  const prevBest = next.daily[dateKey] || 0;
  next.daily = { [dateKey]: Math.max(prevBest, score) }; // only keep today
  writeSave(next);
  return { save: next, newBest: score > prevBest, prevBest };
}

export function updateSettings(save, patch) {
  const next = clone(save);
  next.settings = { ...next.settings, ...patch };
  writeSave(next);
  return next;
}
