/**
 * main.js
 * ------------------------------------------------------------------
 * Application bootstrap & navigation.
 *
 *   store (state.js) ─┬─> UI (ui.js)            DOM, HUD, screens
 *                     ├─> GameController         rules, input, scoring
 *                     ├─> SceneManager           Three.js rendering
 *                     └─> AudioManager           procedural sound
 *   storage.js        persistence (localStorage)
 *
 * Everything lives inside the App closure — nothing leaks to window.
 */

import { createStore, initialState } from './state.js';
import { loadSave, resetSave, recordLevelResult, recordDailyResult, updateSettings } from './storage.js';
import { THEMES, getLevel, createDailyLevel, todayKey, TOTAL_LEVELS, WORD_COLORS } from './levels.js';
import { AudioManager } from './audio.js';
import { SceneManager } from './three-scene.js';
import { UI } from './ui.js';
import { GameController } from './game.js';
import { $, loadFonts, detectLowPerformance, prefersReducedMotion, formatNumber } from './utils.js';

function createApp() {
  /* ---------------- State & persistence ---------------- */
  let save = loadSave();
  const autoLow = detectLowPerformance();
  const performanceMode = save.settings.performance === 'auto' ? autoLow : save.settings.performance === 'on';

  const store = createStore({
    ...initialState,
    soundEnabled: save.settings.sound,
    musicEnabled: save.settings.music,
    vibrationEnabled: save.settings.vibration,
    performanceMode,
    unlockedLevels: save.unlockedLevels,
    levelStars: save.levelStars,
    bestScores: save.bestScores,
  });

  /* ---------------- Modules ---------------- */
  const reducedMotion = prefersReducedMotion();
  const audio = new AudioManager();
  const ui = new UI({ store, audio });
  const scene = new SceneManager($('#scene'), { lowQuality: performanceMode, reducedMotion });
  let game = null;

  const settingsView = () => {
    const s = store.getState();
    return { sound: s.soundEnabled, music: s.musicEnabled, vibration: s.vibrationEnabled, performanceMode: s.performanceMode };
  };

  const menuTheme = () => THEMES[getLevel(Math.min(save.lastPlayedLevel || 1, save.unlockedLevels))?.theme || 'neonCity'];

  /* ---------------- Showcase board (menus) ---------------- */
  function buildShowcase() {
    const n = 7;
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const cells = Array.from({ length: n }, () => Array.from({ length: n }, () => letters[Math.floor(Math.random() * 26)]));
    'NAME'.split('').forEach((ch, i) => { cells[2][i + 1] = ch; });
    'MATCH'.split('').forEach((ch, i) => { cells[4][i + 1] = ch; });
    scene.buildBoard({ size: n, cells }, { mode: 'showcase', intro: true }).then(() => {
      if (scene.mode !== 'showcase') return;
      scene.markFound([{ row: 2, col: 1 }, { row: 2, col: 4 }], WORD_COLORS[3]);
      setTimeout(() => {
        if (scene.mode === 'showcase') scene.markFound([{ row: 4, col: 1 }, { row: 4, col: 5 }], WORD_COLORS[4]);
      }, 350);
    });
  }

  /* ---------------- Navigation ---------------- */
  function goMenu() {
    game.exit();
    ui.hideAllOverlays();
    scene.setPaused(false);
    audio.duck(false);
    store.setState({ isPaused: false });
    const theme = menuTheme();
    scene.setTheme(theme);
    audio.setTheme(theme);
    ui.applyTheme(theme);
    if (scene.mode !== 'showcase' || !scene.board) buildShowcase();
    ui.updateMenu(save, { dailyBest: save.daily[todayKey()] || 0 });
    ui.showScreen('menu');
    scene.setBoardRect(ui.getStageRect());
  }

  function openLevelSelect() {
    ui.renderLevelSelect(save, { onPreview: (theme) => scene.setTheme(theme, 0.7) });
    ui.showScreen('levels');
  }

  function startLevel(levelOrId) {
    const level = typeof levelOrId === 'object' ? levelOrId : getLevel(levelOrId);
    if (!level) return;
    if (level.id !== 'daily' && level.id > save.unlockedLevels) return;
    ui.hideAllOverlays();
    scene.setPaused(false);
    audio.duck(false);
    ui.showScreen('game');
    measureFps();
    game.startLevel(level).catch((err) => {
      console.error(err);
      ui.toast('Could not build this level — please retry', 'warning');
    });
  }

  /* ---------------- Progress ---------------- */
  function onLevelComplete(level, { score, stars }) {
    if (level.id === 'daily') {
      const r = recordDailyResult(save, level.dateKey, score);
      save = r.save;
      return { newBest: r.newBest, best: Math.max(score, r.prevBest), hasNext: false };
    }
    const wasUnlocked = save.unlockedLevels;
    const r = recordLevelResult(save, level.id, { score, stars });
    save = r.save;
    store.setState({ unlockedLevels: save.unlockedLevels, levelStars: save.levelStars, bestScores: save.bestScores });
    if (save.unlockedLevels > wasUnlocked) {
      setTimeout(() => ui.toast(`Level ${save.unlockedLevels} unlocked!`, 'success'), 2600);
    }
    return { newBest: r.newBest, best: Math.max(score, r.prevBest), hasNext: level.id < TOTAL_LEVELS };
  }

  /* ---------------- Settings ---------------- */
  function toggleSetting(key) {
    const s = store.getState();
    if (key === 'sound') {
      store.setState({ soundEnabled: !s.soundEnabled });
      audio.setSfxEnabled(!s.soundEnabled);
      save = updateSettings(save, { sound: !s.soundEnabled });
    } else if (key === 'music') {
      store.setState({ musicEnabled: !s.musicEnabled });
      audio.setMusicEnabled(!s.musicEnabled);
      if (s.isPaused && !s.musicEnabled) audio.duck(true);
      save = updateSettings(save, { music: !s.musicEnabled });
    } else if (key === 'vibration') {
      store.setState({ vibrationEnabled: !s.vibrationEnabled });
      save = updateSettings(save, { vibration: !s.vibrationEnabled });
      if (!s.vibrationEnabled) navigator.vibrate?.(30);
    } else if (key === 'performance') {
      const on = !s.performanceMode;
      store.setState({ performanceMode: on });
      scene.setQuality(on);
      save = updateSettings(save, { performance: on ? 'on' : 'off' });
    }
    ui.syncSettings(settingsView());
  }

  function resetProgress() {
    if (!ui.confirmReset()) return;
    const settings = save.settings;
    save = resetSave();
    save = updateSettings(save, settings);
    store.setState({ unlockedLevels: 1, levelStars: {}, bestScores: {} });
    ui.toast('Progress reset', 'info');
    audio.play('back');
  }

  /* ---------------- Share ---------------- */
  async function shareResult() {
    const r = ui.lastResult;
    if (!r) return;
    const label = r.level.id === 'daily' ? `the Daily Challenge (${r.level.dateKey})` : `${r.level.title} – ${r.level.themeData.name}`;
    const text = `I scored ${formatNumber(r.total)} ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)} on ${label} in Name Match 3D!`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Name Match 3D', text }); return; }
      await navigator.clipboard.writeText(text);
      ui.toast('Result copied to clipboard', 'success');
    } catch { /* user cancelled */ }
  }

  /* ---------------- Auto performance fallback ---------------- */
  // If "auto" mode is on and the first seconds of gameplay run slowly,
  // switch to performance mode automatically.
  let fpsProbe = null;
  function measureFps() {
    if (save.settings.performance !== 'auto' || store.getState().performanceMode || fpsProbe) return;
    let frames = 0;
    let time = 0;
    fpsProbe = scene.onFrame((dt) => {
      frames++;
      time += dt;
      if (time < 4) return;
      fpsProbe(); // unsubscribe
      if (frames / time < 38) {
        store.setState({ performanceMode: true });
        scene.setQuality(true);
        ui.syncSettings(settingsView());
        ui.toast('Performance mode enabled for smoother play', 'info');
      }
    });
  }

  /* ---------------- Actions (click delegation) ---------------- */
  const BACK_SOUND = new Set(['back', 'exit', 'menu']);
  const actions = {
    start: () => {
      // Never block navigation on audio: resume() can stay pending in some browsers.
      audio.unlock();
      if (store.getState().musicEnabled) audio.startMusic();
      goMenu();
    },
    play: () => startLevel(Math.min(save.lastPlayedLevel || 1, save.unlockedLevels)),
    levels: openLevelSelect,
    daily: () => startLevel(createDailyLevel()),
    settings: () => { ui.syncSettings(settingsView()); ui.showScreen('settings'); },
    credits: () => ui.showScreen('credits'),
    back: goMenu,
    'select-level': (t) => startLevel(Number(t.dataset.level)),
    pause: () => game.pause(),
    resume: () => game.resume(),
    restart: () => { ui.hideOverlay('pause'); scene.setPaused(false); audio.duck(false); store.setState({ isPaused: false }); game.restart(); },
    exit: goMenu,
    hint: () => game.useHint(),
    next: () => { const cur = store.getState().currentLevel; if (typeof cur === 'number') startLevel(cur + 1); },
    replay: () => { ui.hideAllOverlays(); game.restart(); },
    menu: goMenu,
    share: shareResult,
    'reset-progress': resetProgress,
  };

  function bindEvents() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action], [data-setting]');
      if (!target || target.disabled) return;
      if (target.dataset.setting) {
        toggleSetting(target.dataset.setting);
        audio.play('click');
        return;
      }
      const name = target.dataset.action;
      if (name !== 'start') audio.play(BACK_SOUND.has(name) ? 'back' : 'click');
      actions[name]?.(target);
    });

    // Keyboard: Esc = pause/back, arrows + Enter = tile selection, H = hint
    document.addEventListener('keydown', (e) => {
      const screen = ui.currentScreen;
      if (e.key === 'Escape') {
        if (ui.isOverlayOpen('pause')) game.resume();
        else if (screen === 'game' && !ui.isOverlayOpen()) { if (!game.cancelAnchor()) game.pause(); }
        else if (['levels', 'settings', 'credits'].includes(screen)) { audio.play('back'); goMenu(); }
        return;
      }
      if (screen !== 'game' || ui.isOverlayOpen()) return;
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (moves[e.key]) { e.preventDefault(); game.moveCursor(...moves[e.key]); return; }
      if (e.key === 'Enter' || e.key === ' ') {
        if (document.activeElement?.closest?.('button')) return; // let focused buttons work
        e.preventDefault();
        game.confirmCursor();
        return;
      }
      if (e.key === 'h' || e.key === 'H') game.useHint();
      if (e.key === 'p' || e.key === 'P') game.pause();
    });

    // Tab hidden → pause the game and silence audio.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (game.active) game.pause();
        audio.suspend();
      } else {
        audio.resume();
      }
    });

    // Keep the board fitted to its layout slot.
    const refit = () => {
      if (scene.mode === 'game') scene.setBoardRect(ui.getBoardRect());
      else if (ui.currentScreen === 'menu') scene.setBoardRect(ui.getStageRect());
    };
    new ResizeObserver(refit).observe($('#board-area'));
    new ResizeObserver(refit).observe($('#menu-stage'));
    window.addEventListener('resize', refit);

    // Stop iOS rubber-band scrolling while playing.
    document.addEventListener('touchmove', (e) => {
      if (ui.currentScreen === 'game' && !e.target.closest('.word-panel')) e.preventDefault();
    }, { passive: false });
  }

  /* ---------------- Boot ---------------- */
  async function boot() {
    ui.syncSettings(settingsView());
    audio.setSfxEnabled(save.settings.sound);
    audio.musicEnabled = save.settings.music;
    const theme = menuTheme();
    ui.applyTheme(theme);

    const step = (from, to, label) => (p) => ui.setLoading(from + (to - from) * p, label);
    try {
      ui.setLoading(0.02, 'Loading fonts…');
      await loadFonts(['800 64px "Exo 2"', '900 32px "Orbitron"']);
      ui.setLoading(0.2, 'Building 3D scene…');
      await scene.init(step(0.2, 0.8, 'Building 3D scene…'));
      await audio.init(step(0.8, 0.95, 'Synthesising sounds…'));
    } catch (err) {
      console.error(err);
      ui.showLoadError('Could not start WebGL. Please use a modern browser with hardware acceleration enabled.');
      return;
    }

    game = new GameController({ store, scene, audio, ui, onLevelComplete });
    game.attachInput($('#scene'));
    bindEvents();

    scene.setTheme(theme, 0);
    audio.setTheme(theme);
    buildShowcase();
    scene.start();
    ui.setLoading(1, 'Ready');
    ui.showStartButton();

    // Opt-in dev hook (index.html?debug) for testing; nothing leaks otherwise.
    if (new URLSearchParams(location.search).has('debug')) {
      window.__nm3d = { store, game, scene, ui, audio, getSave: () => save };
    }
  }

  return { boot };
}

createApp().boot();
