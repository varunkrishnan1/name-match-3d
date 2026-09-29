/**
 * game.js
 * ------------------------------------------------------------------
 * GameController — owns the rules of a running level:
 *   - pointer / touch / keyboard selection (straight lines only)
 *   - word validation, scoring, combos, hints
 *   - timer, completion and failure
 *
 * It coordinates the scene (visuals), audio and UI, and publishes
 * state through the store so the HUD updates reactively.
 */

import { generateGrid } from './grid.js';
import { WORD_COLORS } from './levels.js';
import { createRng, vibrate } from './utils.js';

/* ---------------- Scoring constants ---------------- */
export const SCORING = {
  basePerWord: 100,
  comboWindow: 10,      // seconds between finds to keep the combo alive
  comboStep: 50,        // +50 per combo level beyond the first
  hintCost: 50,
  timeBonusPerSecond: 10,
};

const sameCell = (a, b) => a && b && a.row === b.row && a.col === b.col;

export class GameController {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./state.js').createStore>} deps.store
   * @param {import('./three-scene.js').SceneManager} deps.scene
   * @param {import('./audio.js').AudioManager} deps.audio
   * @param {import('./ui.js').UI} deps.ui
   * @param {(level, result) => {newBest:boolean, best:number}} deps.onLevelComplete
   */
  constructor({ store, scene, audio, ui, onLevelComplete }) {
    this.store = store;
    this.scene = scene;
    this.audio = audio;
    this.ui = ui;
    this.onLevelComplete = onLevelComplete;

    this.level = null;
    this.grid = null;
    this.active = false;      // accepting input & ticking the timer
    this.inLevel = false;     // a level is loaded (even if paused / intro)
    this.session = 0;         // invalidates stale async work on restart/exit

    this.selection = [];
    this.dragging = false;
    this.dragStart = null;
    this.anchor = null;       // first tap in tap-tap mode / keyboard
    this.cursor = null;       // keyboard cursor

    scene.onFrame((dt) => this.update(dt));
  }

  /* ================= Level lifecycle ================= */

  async startLevel(level) {
    const session = ++this.session;
    this.level = level;
    const rng = level.seed ? createRng(level.seed) : Math.random;
    this.grid = generateGrid(level, rng);

    this.found = new Set();
    this.score = 0;
    this.elapsed = 0;
    this.timeLeft = level.timeLimit || 0;
    this.hintsUsed = 0;
    this.hintsRemaining = level.hints ?? 3;
    this.combo = 0;
    this.maxCombo = 0;
    this.lastFoundAt = null;
    this.lastSecond = null;
    this.active = false;
    this.inLevel = true;
    this._clearSelection();
    this.anchor = null;
    this.cursor = null;

    this.store.setState({
      currentLevel: level.id,
      score: 0,
      timeLimit: level.timeLimit || 0,
      timeLeft: level.timeLimit || 0,
      wordsFound: [],
      selectedTiles: [],
      hintsRemaining: this.hintsRemaining,
      combo: 0,
      isPaused: false,
    });

    this.audio.setTheme(level.themeData);
    this.audio.setIntensity(0);
    this.scene.setTheme(level.themeData);
    this.ui.prepareGame(level);
    this.scene.mode = 'game';
    this.scene.setBoardRect(this.ui.getBoardRect());
    this.scene.setAnchor(null);
    this.scene.setCursor(null);

    const intro = this.scene.buildBoard(this.grid, { mode: 'game', intro: true });
    this.audio.play('levelStart');
    await Promise.all([intro, this.ui.showLevelBanner(level)]);
    if (session !== this.session) return; // restarted or exited meanwhile
    this.active = true;
  }

  restart() {
    if (this.level) this.startLevel(this.level);
  }

  exit() {
    this.session++;
    this.active = false;
    this.inLevel = false;
    this.dragging = false;
    this._clearSelection();
    this.audio.setIntensity(0);
  }

  /* ================= Pause ================= */

  get isPaused() { return this.store.getState().isPaused; }

  pause() {
    if (!this.inLevel || this.isPaused || this.ui.isOverlayOpen()) return;
    this.dragging = false;
    this._clearSelection();
    this.store.setState({ isPaused: true });
    this.scene.setPaused(true);
    this.audio.duck(true);
    this.audio.play('pauseOpen');
    this.ui.showOverlay('pause');
  }

  resume() {
    if (!this.isPaused) return;
    this.store.setState({ isPaused: false });
    this.ui.hideOverlay('pause');
    this.scene.setPaused(false);
    this.audio.duck(false);
    this.audio.play('pauseClose');
  }

  togglePause() { this.isPaused ? this.resume() : this.pause(); }

  /* ================= Timer ================= */

  update(dt) {
    if (!this.active || this.isPaused) return;
    this.elapsed += dt;
    const limit = this.level.timeLimit;
    if (!limit) return;

    this.timeLeft = Math.max(0, limit - this.elapsed);
    const sec = Math.ceil(this.timeLeft);
    if (sec !== this.lastSecond) {
      this.lastSecond = sec;
      this.store.setState({ timeLeft: sec });
      if (sec <= 10 && sec > 0) this.audio.play('warn');
      const ratio = this.timeLeft / limit;
      this.audio.setIntensity(ratio < 0.5 ? (0.5 - ratio) * 2 : 0);
    }
    if (this.timeLeft <= 0) this._fail();
  }

  /* ================= Input: pointer ================= */

  attachInput(canvas) {
    canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e, canvas));
    canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    canvas.addEventListener('pointercancel', () => this._cancelDrag());
    canvas.addEventListener('pointerleave', () => { if (!this.dragging) this.scene.setHover(null); });
    canvas.addEventListener('contextmenu', (e) => { if (this.inLevel) e.preventDefault(); });
  }

  get canInteract() { return this.active && !this.isPaused && !this.ui.isOverlayOpen(); }

  _onPointerDown(e, canvas) {
    if (!this.canInteract || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const hit = this.scene.pickCell(e.clientX, e.clientY);
    if (!hit || !hit.inside) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const cell = { row: hit.row, col: hit.col };
    this.scene.setCursor(null);

    // Tap-tap mode: second tap on a different tile submits the line.
    if (this.anchor && !sameCell(this.anchor, cell)) {
      const line = this._lineFrom(this.anchor, hit);
      this._setAnchor(null);
      this._setSelection(line);
      this._submit();
      return;
    }

    this.dragging = true;
    this.dragStart = cell;
    this._setSelection([cell]);
    this.audio.play('select');
    vibrate(8, this.store.getState().vibrationEnabled);
  }

  _onPointerMove(e) {
    if (!this.dragging) {
      if (e.pointerType === 'mouse' && this.canInteract) {
        const hit = this.scene.pickCell(e.clientX, e.clientY);
        this.scene.setHover(hit && hit.inside ? hit : null);
      }
      return;
    }
    const hit = this.scene.pickCell(e.clientX, e.clientY);
    if (!hit) return;
    const line = this._lineFrom(this.dragStart, hit);
    const last = this.selection[this.selection.length - 1];
    if (line.length !== this.selection.length || !sameCell(line[line.length - 1], last)) {
      this._setSelection(line);
      this.audio.play('tick', { step: line.length });
    }
  }

  _onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.selection.length <= 1) {
      // A tap: toggle the anchor for tap-tap selection.
      const cell = this.selection[0];
      this._setAnchor(this.anchor && sameCell(this.anchor, cell) ? null : cell, true);
      this._setSelection([]);
      return;
    }
    this._setAnchor(null);
    this._submit();
  }

  _cancelDrag() {
    this.dragging = false;
    this._clearSelection();
  }

  /**
   * Builds a straight line of cells from `start` toward the pointer.
   * The direction snaps to the nearest of 8 directions (45° steps) and
   * the line is clipped to the grid — no skipping, no zig-zags.
   */
  _lineFrom(start, hit) {
    const dr = hit.fr - start.row;
    const dc = hit.fc - start.col;
    if (Math.abs(dr) < 0.5 && Math.abs(dc) < 0.5) return [start];
    const k = Math.round(Math.atan2(dr, dc) / (Math.PI / 4));
    const ur = Math.round(Math.sin((k * Math.PI) / 4));
    const uc = Math.round(Math.cos((k * Math.PI) / 4));
    // Project the drag vector onto the snapped direction.
    let steps = Math.round((dr * ur + dc * uc) / (ur * ur + uc * uc));
    const n = this.grid.size;
    const inBounds = (s) => {
      const r = start.row + ur * s;
      const c = start.col + uc * s;
      return r >= 0 && r < n && c >= 0 && c < n;
    };
    steps = Math.max(0, steps);
    while (steps > 0 && !inBounds(steps)) steps--;
    const cells = [];
    for (let i = 0; i <= steps; i++) cells.push({ row: start.row + ur * i, col: start.col + uc * i });
    return cells;
  }

  _textOf(cells) {
    return cells.map((c) => this.grid.cells[c.row][c.col]).join('');
  }

  _setSelection(cells) {
    this.selection = cells;
    this.scene.setSelection(cells);
    this.store.setState({ selectedTiles: cells });
    this.store.emit('selection', { text: this._textOf(cells) });
  }

  _clearSelection() {
    this.selection = [];
    this.scene.setSelection([]);
    this.store.setState({ selectedTiles: [] });
    this.store.emit('selection', { text: '' });
  }

  _setAnchor(cell, silent = false) {
    this.anchor = cell || null;
    this.scene.setAnchor(this.anchor);
    if (cell && !silent) this.audio.play('select');
  }

  /* ================= Input: keyboard ================= */

  moveCursor(dr, dc) {
    if (!this.canInteract) return;
    const n = this.grid.size;
    const c = this.cursor || { row: Math.floor(n / 2), col: Math.floor(n / 2) };
    this.cursor = this.cursor
      ? { row: Math.min(n - 1, Math.max(0, c.row + dr)), col: Math.min(n - 1, Math.max(0, c.col + dc)) }
      : c;
    this.scene.setCursor(this.cursor);
    this.audio.play('tick', { step: 0 });
    // With an anchor set, preview the line from the anchor to the cursor.
    if (this.anchor) this._setSelection(this._lineFrom(this.anchor, { fr: this.cursor.row, fc: this.cursor.col }));
  }

  confirmCursor() {
    if (!this.canInteract || !this.cursor) return;
    if (!this.anchor) { this._setAnchor(this.cursor); this._setSelection([this.cursor]); return; }
    if (sameCell(this.anchor, this.cursor)) { this.cancelAnchor(); return; }
    const line = this._lineFrom(this.anchor, { fr: this.cursor.row, fc: this.cursor.col });
    this._setAnchor(null);
    this._setSelection(line);
    this._submit();
  }

  /** Returns true if there was something to cancel. */
  cancelAnchor() {
    if (!this.anchor) return false;
    this._setAnchor(null);
    this._clearSelection();
    this.audio.play('back');
    return true;
  }

  /* ================= Word checking ================= */

  _submit() {
    const cells = this.selection;
    const word = this._textOf(cells);
    this._clearSelection();
    if (cells.length < 2) return;

    const reversed = [...word].reverse().join('');
    const match = this.level.names.find((n) => !this.found.has(n) && (n === word || n === reversed));
    if (match) this._onCorrect(match, cells);
    else if (this.found.has(word) || this.found.has(reversed)) {
      this.audio.play('already');
      this.ui.flashPreview(word, 'wrong');
      this.ui.toast(`${this.found.has(word) ? word : reversed} is already found`, 'info');
    } else this._onWrong(cells, word);
  }

  _onCorrect(name, cells) {
    this.found.add(name);
    const index = this.level.names.indexOf(name);
    const color = WORD_COLORS[index % WORD_COLORS.length];

    // Combo: quick consecutive finds stack a bonus.
    const quick = this.lastFoundAt !== null && this.elapsed - this.lastFoundAt <= SCORING.comboWindow;
    this.combo = quick ? this.combo + 1 : 1;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.lastFoundAt = this.elapsed;
    const comboBonus = (this.combo - 1) * SCORING.comboStep;
    const points = Math.round((SCORING.basePerWord + comboBonus) * (this.level.multiplier || 1));
    this.score += points;

    this.scene.markFound(cells, color);
    this.audio.play('correct');
    this.audio.play('wordComplete');
    vibrate(30, this.store.getState().vibrationEnabled);

    this.store.setState({ score: this.score, wordsFound: [...this.found], combo: this.combo });

    const mid = cells[Math.floor(cells.length / 2)];
    const pos = this.scene.cellToScreen(mid.row, mid.col);
    this.ui.flashPreview(name, 'correct');
    this.ui.markWordFound(name);
    this.ui.floatText(pos.x, pos.y, `+${points}`, color);
    this.ui.toast(this.combo >= 2 ? `${name}! Combo ×${this.combo}` : `Found ${name}!`, 'success');

    if (this.found.size === this.level.names.length) {
      this.active = false;
      const session = this.session;
      setTimeout(() => { if (session === this.session) this._complete(); }, 650);
    }
  }

  _onWrong(cells, word) {
    this.scene.reject(cells);
    this.audio.play('error');
    vibrate([18, 40, 18], this.store.getState().vibrationEnabled);
    this.ui.flashPreview(word, 'wrong');
    if (this.combo) { this.combo = 0; this.store.setState({ combo: 0 }); }
  }

  /* ================= Hints ================= */

  useHint() {
    if (!this.canInteract) return;
    if (this.hintsRemaining <= 0) {
      this.audio.play('error');
      this.ui.toast('No hints left', 'warning');
      return;
    }
    const remaining = this.level.names.filter((n) => !this.found.has(n));
    if (!remaining.length) return;
    const name = remaining[Math.floor(Math.random() * remaining.length)];
    const placement = this.grid.placements.find((p) => p.word === name);
    this.hintsRemaining--;
    this.hintsUsed++;
    this.score = Math.max(0, this.score - SCORING.hintCost);
    this.scene.hint({ row: placement.row, col: placement.col });
    this.audio.play('hint');
    this.ui.pulseWord(name);
    this.ui.toast(`${name} starts at the glowing tile (−${SCORING.hintCost})`, 'warning');
    this.store.setState({ hintsRemaining: this.hintsRemaining, score: this.score });
  }

  /* ================= End of level ================= */

  _stars(timeRatio) {
    if (timeRatio >= 0.4 && this.hintsUsed <= 1) return 3;
    if (timeRatio >= 0.18) return 2;
    return 1;
  }

  _complete() {
    this.active = false;
    this.inLevel = false;
    const limit = this.level.timeLimit || 0;
    const timeBonus = Math.round(this.timeLeft * SCORING.timeBonusPerSecond * (this.level.multiplier || 1));
    const wordScore = this.score;
    const total = wordScore + timeBonus;
    const stars = this._stars(limit ? this.timeLeft / limit : 1);

    this.scene.celebrate();
    this.audio.setIntensity(0);
    this.audio.play('levelComplete');
    setTimeout(() => this.audio.play('confetti'), 500);
    vibrate([40, 60, 40, 60, 80], this.store.getState().vibrationEnabled);

    this.score = total;
    this.store.setState({ score: total });
    const { newBest, best, hasNext } = this.onLevelComplete(this.level, { score: total, stars });

    const session = this.session;
    setTimeout(() => {
      if (session !== this.session) return;
      this.ui.showComplete({
        level: this.level, wordScore, timeBonus, total, stars,
        timeTaken: this.elapsed, newBest, best, hasNext,
      });
    }, 1300);
  }

  _fail() {
    this.active = false;
    this.inLevel = false;
    this._clearSelection();
    this._setAnchor(null);
    this.audio.setIntensity(0);
    this.audio.play('levelFailed');
    vibrate([80, 60, 120], this.store.getState().vibrationEnabled);
    this.ui.showFailed({ level: this.level, found: this.found.size, total: this.level.names.length });
  }
}
