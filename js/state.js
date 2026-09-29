/**
 * state.js
 * ------------------------------------------------------------------
 * Tiny pub/sub store. State is replaced immutably on every update so
 * subscribers can compare values; only changed keys trigger events.
 *
 *   store.subscribe('change:score', (score) => ...)
 *   store.onStateChange((state, changedKeys) => ...)
 *   store.emit('word:found', payload)   // free-form game events
 */

export const initialState = {
  currentScreen: 'splash',
  currentLevel: 1,
  score: 0,
  timeLeft: 0,
  timeLimit: 0,
  wordsFound: [],
  selectedTiles: [],
  hintsRemaining: 3,
  combo: 0,
  isPaused: false,
  soundEnabled: true,
  musicEnabled: true,
  vibrationEnabled: true,
  performanceMode: false,
  unlockedLevels: 1,
  levelStars: {},
  bestScores: {},
};

export function createStore(initial = initialState) {
  let state = { ...initial };
  const listeners = new Map();

  function subscribe(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }

  function emit(event, ...args) {
    listeners.get(event)?.forEach((fn) => {
      try { fn(...args); } catch (err) { console.error(`[store] listener for "${event}" failed`, err); }
    });
  }

  function setState(patch) {
    const changed = Object.keys(patch).filter((k) => state[k] !== patch[k]);
    if (!changed.length) return;
    state = { ...state, ...patch };
    changed.forEach((k) => emit(`change:${k}`, state[k], state));
    emit('change', state, changed);
  }

  return {
    getState: () => state,
    setState,
    subscribe,
    emit,
    onStateChange: (fn) => subscribe('change', fn),
  };
}
