/**
 * ui.js
 * ------------------------------------------------------------------
 * DOM layer: screens, overlays, HUD, word list, level cards, toasts,
 * floating score text and result screens. The UI reacts to store
 * changes; it never owns game logic.
 *
 * DOM writes are batched per state change and only touch the nodes
 * whose values actually changed.
 */

import { gsap, $, $$, el, formatTime, formatNumber, prefersReducedMotion } from './utils.js';
import { LEVELS, THEMES, WORD_COLORS } from './levels.js';
import { Confetti2D } from './particles.js';

const FAIL_MESSAGES = [
  'So close! Every run makes you sharper.',
  'Great effort — the names are waiting for round two.',
  'Almost had it! Try scanning the diagonals.',
  'Deep breath. You know where some of them are now.',
];

const DIFFICULTY_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

export class UI {
  constructor({ store, audio }) {
    this.store = store;
    this.audio = audio;
    this.reduced = prefersReducedMotion();
    this.currentScreen = 'splash';
    this.openOverlays = new Set();

    this.screens = Object.fromEntries($$('[data-screen]').map((s) => [s.dataset.screen, s]));
    this.overlays = Object.fromEntries($$('[data-overlay]').map((o) => [o.dataset.overlay, o]));
    this.els = {
      loaderFill: $('#loader-fill'), loaderLabel: $('#loader-label'), loader: $('#loader'), start: $('#btn-start'),
      menuPlaySub: $('#menu-play-sub'), menuDailySub: $('#menu-daily-sub'), menuStats: $('#menu-stats'),
      levelGrid: $('#level-grid'), starsTotal: $('#stars-total span'),
      hudLevel: $('#hud-level'), hudScore: $('#hud-score'), hudCombo: $('#hud-combo'),
      hudTimer: $('#hud-timer'), hudTimerWrap: $('#hud-timer-wrap'), hudTimerBar: $('#hud-timer-bar'),
      hudFound: $('#hud-found'), hudHints: $('#hud-hints'),
      boardArea: $('#board-area'), preview: $('#selection-preview'),
      wordList: $('#word-list'), wordTheme: $('#word-theme'),
      banner: $('#level-banner'), bannerKicker: $('#banner-kicker'), bannerTitle: $('#banner-title'), bannerSub: $('#banner-sub'),
      toasts: $('#toasts'), floatLayer: $('#float-layer'),
      resultStars: $$('#result-stars .result-star'),
      resWords: $('#res-words'), resBonus: $('#res-bonus'), resTime: $('#res-time'), resTotal: $('#res-total'), resBest: $('#res-best'),
      completeKicker: $('#complete-kicker'), btnNext: $('#btn-next'),
      failedKicker: $('#failed-kicker'), failedMessage: $('#failed-message'), failedStats: $('#failed-stats'),
      resetBtn: $('#btn-reset'),
    };
    this.confetti = new Confetti2D($('#confetti'));
    this._scoreTween = { value: 0 };

    // Initial visibility for GSAP-managed screens/overlays
    Object.values(this.screens).forEach((s) => { if (!s.classList.contains('is-active')) gsap.set(s, { autoAlpha: 0 }); });
    Object.values(this.overlays).forEach((o) => gsap.set(o, { autoAlpha: 0 }));

    this._bindStore();
    this._bindHoverSounds();
  }

  get dur() { return this.reduced ? 0.01 : 1; }

  /* ================= Screens & overlays ================= */

  showScreen(name) {
    const next = this.screens[name];
    const prev = this.screens[this.currentScreen];
    if (!next || next === prev) return;
    this.currentScreen = name;
    this.store.setState({ currentScreen: name });
    document.body.dataset.screen = name;

    // overwrite: kill any in-flight transition on these screens, otherwise a
    // delayed fade-in can finish after a quick fade-out and leave the old
    // screen visible (and clickable) on top of the new one.
    if (prev) {
      prev.classList.remove('is-active');
      gsap.to(prev, { autoAlpha: 0, y: -16, duration: 0.3 * this.dur, ease: 'power2.in', overwrite: true });
    }
    next.classList.add('is-active');
    gsap.fromTo(next, { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.45 * this.dur, delay: 0.12 * this.dur, ease: 'power3.out', overwrite: true });

    // Stagger children for a premium feel
    const items = $$('.btn, .level-card, .toggle, .credits > *', next).slice(0, 16);
    if (items.length && !this.reduced) {
      gsap.fromTo(items, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, stagger: 0.035, delay: 0.18, ease: 'power2.out', clearProps: 'transform,opacity' });
    }
  }

  showOverlay(name) {
    const o = this.overlays[name];
    if (!o || this.openOverlays.has(name)) return;
    this.openOverlays.add(name);
    o.classList.add('is-active');
    const panel = $('.panel', o);
    gsap.to(o, { autoAlpha: 1, duration: 0.25 * this.dur, overwrite: true });
    gsap.fromTo(panel, { scale: 0.9, y: 24 }, { scale: 1, y: 0, duration: 0.45 * this.dur, ease: 'back.out(1.6)' });
    setTimeout(() => $('.btn--primary', o)?.focus({ preventScroll: true }), 60);
  }

  hideOverlay(name) {
    const o = this.overlays[name];
    if (!o || !this.openOverlays.has(name)) return;
    this.openOverlays.delete(name);
    o.classList.remove('is-active');
    gsap.to(o, { autoAlpha: 0, duration: 0.2 * this.dur, overwrite: true });
  }

  hideAllOverlays() { [...this.openOverlays].forEach((n) => this.hideOverlay(n)); }

  isOverlayOpen(name) { return name ? this.openOverlays.has(name) : this.openOverlays.size > 0; }

  /* ================= Splash ================= */

  setLoading(progress, label) {
    const pct = Math.round(progress * 100);
    this.els.loaderFill.style.transform = `scaleX(${progress})`;
    this.els.loader.setAttribute('aria-valuenow', String(pct));
    if (label) this.els.loaderLabel.textContent = `${label} ${pct}%`;
  }

  showStartButton() {
    this.els.loaderLabel.textContent = 'Ready';
    this.els.start.hidden = false;
    gsap.fromTo(this.els.start, { scale: 0.6, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.6, ease: 'back.out(2)' });
    this.els.start.focus({ preventScroll: true });
  }

  showLoadError(message) {
    this.els.loaderLabel.textContent = message;
    this.els.loader.classList.add('is-error');
  }

  /* ================= Theme ================= */

  applyTheme(theme) {
    const root = document.documentElement.style;
    root.setProperty('--theme-accent', theme.accent);
    root.setProperty('--theme-accent-2', theme.accent2);
  }

  /* ================= Menu & level select ================= */

  updateMenu(save, { dailyBest = 0 } = {}) {
    const next = Math.min(save.lastPlayedLevel || 1, save.unlockedLevels);
    this.els.menuPlaySub.textContent = `Level ${next}`;
    const stars = Object.values(save.levelStars).reduce((a, b) => a + b, 0);
    const done = Object.keys(save.levelStars).length;
    this.els.menuStats.innerHTML = '';
    this.els.menuStats.append(
      el('span', '', `★ ${stars}/${LEVELS.length * 3}`),
      el('span', '', `${done}/${LEVELS.length} cleared`),
    );
    this.els.menuDailySub.textContent = dailyBest ? `Best ${formatNumber(dailyBest)}` : 'New';
  }

  renderLevelSelect(save, { onPreview } = {}) {
    const grid = this.els.levelGrid;
    grid.innerHTML = '';
    let totalStars = 0;

    LEVELS.forEach((level) => {
      const theme = THEMES[level.theme];
      const locked = level.id > save.unlockedLevels;
      const stars = save.levelStars[level.id] || 0;
      totalStars += stars;

      const card = el('button', `level-card${locked ? ' is-locked' : ''}`);
      card.type = 'button';
      card.dataset.action = 'select-level';
      card.dataset.level = String(level.id);
      card.setAttribute('role', 'listitem');
      card.disabled = locked;
      card.setAttribute('aria-label', `${level.title}, ${theme.name}, ${DIFFICULTY_LABEL[level.difficulty]}${locked ? ', locked' : `, ${stars} of 3 stars`}`);
      card.style.setProperty('--card-a', theme.accent);
      card.style.setProperty('--card-b', theme.accent2);
      card.style.setProperty('--card-bg', theme.bgTop);

      card.innerHTML = `
        <span class="level-card__preview" aria-hidden="true">
          <span class="level-card__num">${level.id}</span>
          ${locked ? '<svg class="icon level-card__lock"><use href="#i-lock"/></svg>' : ''}
        </span>
        <span class="level-card__body">
          <span class="level-card__theme">${theme.name}</span>
          <span class="level-card__meta">
            <span class="pill pill--${level.difficulty}">${DIFFICULTY_LABEL[level.difficulty]}</span>
            <span class="level-card__grid">${level.gridSize}×${level.gridSize}</span>
          </span>
          <span class="level-card__stars" aria-hidden="true">
            ${[0, 1, 2].map((i) => `<svg class="icon${i < stars ? ' is-earned' : ''}"><use href="#i-star"/></svg>`).join('')}
          </span>
          <span class="level-card__best">${save.bestScores[level.id] ? `Best ${formatNumber(save.bestScores[level.id])}` : locked ? 'Locked' : 'Not played'}</span>
        </span>`;

      if (onPreview && !locked) {
        card.addEventListener('pointerenter', () => onPreview(theme));
        card.addEventListener('focus', () => onPreview(theme));
      }
      grid.append(card);
    });

    this.els.starsTotal.textContent = `${totalStars}/${LEVELS.length * 3}`;
  }

  /* ================= Game HUD ================= */

  prepareGame(level) {
    this.applyTheme(level.themeData);
    this.els.hudLevel.textContent = level.id === 'daily' ? 'Daily' : String(level.id);
    this.els.wordTheme.textContent = `· ${level.themeData.name}`;
    this._scoreTween.value = 0;
    this.els.hudScore.textContent = '0';
    this.els.hudCombo.textContent = '';
    this.els.hudTimerWrap.classList.remove('is-warning');
    this.els.hudTimerBar.style.transform = 'scaleX(1)';
    this.clearPreview(true);

    const list = this.els.wordList;
    list.innerHTML = '';
    level.names.forEach((name, i) => {
      const li = el('li', 'word-chip');
      li.dataset.name = name;
      li.style.setProperty('--word-color', WORD_COLORS[i % WORD_COLORS.length]);
      li.innerHTML = `
        <span class="word-chip__check" aria-hidden="true"><svg class="icon"><use href="#i-check"/></svg></span>
        <span class="word-chip__text">${name}</span>`;
      li.setAttribute('aria-label', `${name}, not found`);
      list.append(li);
    });
    this.els.hudFound.textContent = `0/${level.names.length}`;
    this._wordTotal = level.names.length;
  }

  /** Board area rect in viewport px, ignoring CSS transforms (screen transitions). */
  getBoardRect() { return this.rectOf(this.els.boardArea); }

  /** Menu slot the showcase board is fitted into. */
  getStageRect() { return this.rectOf($('#menu-stage')); }

  rectOf(node) {
    let left = 0;
    let top = 0;
    let n = node;
    while (n) { left += n.offsetLeft; top += n.offsetTop; n = n.offsetParent; }
    return { left, top, width: node.offsetWidth, height: node.offsetHeight };
  }

  _bindStore() {
    const s = this.store;

    s.subscribe('change:score', (score) => {
      gsap.to(this._scoreTween, {
        value: score, duration: this.reduced ? 0 : 0.6, ease: 'power2.out', overwrite: true,
        onUpdate: () => { this.els.hudScore.textContent = formatNumber(this._scoreTween.value); },
      });
    });

    s.subscribe('change:timeLeft', (t, state) => {
      this.els.hudTimer.textContent = state.timeLimit ? formatTime(t) : '∞';
      const ratio = state.timeLimit ? t / state.timeLimit : 1;
      this.els.hudTimerBar.style.transform = `scaleX(${Math.max(0, ratio)})`;
      this.els.hudTimerWrap.classList.toggle('is-warning', state.timeLimit > 0 && t <= 15);
    });

    s.subscribe('change:wordsFound', (words) => {
      this.els.hudFound.textContent = `${words.length}/${this._wordTotal || 10}`;
    });

    s.subscribe('change:hintsRemaining', (h) => {
      this.els.hudHints.textContent = String(h);
      this.els.hudHints.parentElement.classList.toggle('is-empty', h <= 0);
    });

    s.subscribe('change:combo', (combo) => {
      const c = this.els.hudCombo;
      if (combo >= 2) {
        c.textContent = `Combo ×${combo}`;
        if (!this.reduced) gsap.fromTo(c, { scale: 1.5 }, { scale: 1, duration: 0.4, ease: 'back.out(3)' });
      } else c.textContent = '';
    });

    s.subscribe('selection', ({ text }) => this.setPreview(text));
  }

  /* ================= Selection preview ================= */

  setPreview(text) {
    const p = this.els.preview;
    gsap.killTweensOf(p);
    p.classList.remove('is-correct', 'is-wrong');
    if (!text) { this.clearPreview(); return; }
    p.textContent = text;
    p.classList.add('is-visible');
    gsap.set(p, { autoAlpha: 1, x: 0 });
  }

  clearPreview(instant = false) {
    const p = this.els.preview;
    if (instant) { p.textContent = ''; p.classList.remove('is-visible'); gsap.set(p, { autoAlpha: 0 }); return; }
    gsap.to(p, { autoAlpha: 0, duration: 0.25, onComplete: () => p.classList.remove('is-visible') });
  }

  flashPreview(text, kind) {
    const p = this.els.preview;
    gsap.killTweensOf(p);
    p.textContent = text;
    p.classList.remove('is-correct', 'is-wrong');
    p.classList.add('is-visible', kind === 'correct' ? 'is-correct' : 'is-wrong');
    gsap.set(p, { autoAlpha: 1, x: 0 });
    const tl = gsap.timeline({ onComplete: () => p.classList.remove('is-visible', 'is-correct', 'is-wrong') });
    if (kind === 'wrong' && !this.reduced) {
      tl.to(p, { keyframes: { x: [-10, 9, -6, 4, 0] }, duration: 0.35 });
    } else if (!this.reduced) {
      tl.fromTo(p, { scale: 1.25 }, { scale: 1, duration: 0.35, ease: 'back.out(3)' });
    }
    tl.to(p, { autoAlpha: 0, duration: 0.3, delay: 0.5 });
  }

  /* ================= Words ================= */

  markWordFound(name) {
    const chip = $(`.word-chip[data-name="${name}"]`, this.els.wordList);
    if (!chip) return;
    chip.classList.add('is-found');
    chip.setAttribute('aria-label', `${name}, found`);
    if (!this.reduced) gsap.fromTo(chip, { scale: 1.12 }, { scale: 1, duration: 0.5, ease: 'elastic.out(1, 0.5)' });
  }

  pulseWord(name) {
    const chip = $(`.word-chip[data-name="${name}"]`, this.els.wordList);
    if (!chip) return;
    chip.classList.remove('is-hinted');
    void chip.offsetWidth; // restart CSS animation
    chip.classList.add('is-hinted');
    chip.scrollIntoView({ block: 'nearest', behavior: this.reduced ? 'auto' : 'smooth' });
  }

  /* ================= Banner / toasts / floating text ================= */

  showLevelBanner(level) {
    const { banner, bannerKicker, bannerTitle, bannerSub } = this.els;
    bannerKicker.textContent = level.id === 'daily'
      ? `Daily Challenge · ${level.dateKey}`
      : `${level.title} · ${DIFFICULTY_LABEL[level.difficulty]}`;
    bannerTitle.textContent = level.themeData.name;
    bannerSub.textContent = `Find all ${level.names.length} names${level.timeLimit ? ` in ${formatTime(level.timeLimit)}` : ''}`;
    return new Promise((resolve) => {
      if (this.reduced) {
        gsap.timeline({ onComplete: resolve }).set(banner, { autoAlpha: 1 }).to(banner, { autoAlpha: 0, duration: 0.2, delay: 1.1 });
        return;
      }
      gsap.timeline({ onComplete: resolve })
        .fromTo(banner, { autoAlpha: 0, scale: 0.85, y: 20 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.55, ease: 'back.out(1.8)', delay: 0.3 })
        .fromTo(bannerTitle, { letterSpacing: '0.5em' }, { letterSpacing: '0.08em', duration: 0.9, ease: 'power3.out' }, '<')
        .to(banner, { autoAlpha: 0, y: -24, duration: 0.4, ease: 'power2.in', delay: 0.75 });
    });
  }

  toast(message, type = 'info') {
    const t = el('div', `toast toast--${type}`, message);
    this.els.toasts.append(t);
    while (this.els.toasts.children.length > 3) this.els.toasts.firstElementChild.remove();
    gsap.timeline({ onComplete: () => t.remove() })
      .fromTo(t, { y: -16, autoAlpha: 0, scale: 0.95 }, { y: 0, autoAlpha: 1, scale: 1, duration: 0.3 * this.dur, ease: 'back.out(2)' })
      .to(t, { autoAlpha: 0, y: -10, duration: 0.3, delay: 1.5 });
  }

  floatText(x, y, text, color = '#fff') {
    const f = el('div', 'float-text', text);
    f.style.left = `${x}px`;
    f.style.top = `${y}px`;
    f.style.setProperty('--float-color', color);
    this.els.floatLayer.append(f);
    gsap.timeline({ onComplete: () => f.remove() })
      .fromTo(f, { autoAlpha: 0, y: 0, scale: 0.6 }, { autoAlpha: 1, y: -30, scale: 1.1, duration: 0.35, ease: 'back.out(2)' })
      .to(f, { autoAlpha: 0, y: -80, duration: 0.7, ease: 'power1.in' });
  }

  /* ================= Result screens ================= */

  showComplete({ level, wordScore, timeBonus, total, stars, timeTaken, newBest, best, hasNext }) {
    const e = this.els;
    e.completeKicker.textContent = level.id === 'daily' ? `Daily · ${level.dateKey}` : `${level.title} · ${level.themeData.name}`;
    e.resWords.textContent = formatNumber(wordScore);
    e.resBonus.textContent = `+${formatNumber(timeBonus)}`;
    e.resTime.textContent = formatTime(timeTaken);
    e.resBest.textContent = newBest ? '★ New best score!' : `Best: ${formatNumber(best)}`;
    e.resBest.classList.toggle('is-new', newBest);
    e.btnNext.hidden = !hasNext;
    e.resultStars.forEach((s) => s.classList.remove('is-earned'));
    e.resTotal.textContent = '0';

    this.showOverlay('complete');

    // Count up the total, then pop stars one by one.
    const counter = { v: 0 };
    gsap.to(counter, {
      v: total, duration: this.reduced ? 0 : 1.1, delay: 0.3, ease: 'power2.out',
      onUpdate: () => { e.resTotal.textContent = formatNumber(counter.v); },
    });
    e.resultStars.forEach((star, i) => {
      if (i >= stars) { gsap.set(star, { scale: 1, rotate: 0 }); return; }
      gsap.fromTo(star, { scale: 0, rotate: -120 }, {
        scale: 1, rotate: 0, duration: 0.6, delay: 0.6 + i * 0.35, ease: 'back.out(2.6)',
        onStart: () => { star.classList.add('is-earned'); this.audio.play('star', { index: i }); },
      });
    });

    this.confetti.launch({ count: this.reduced ? 40 : 180, colors: [level.themeData.accent, level.themeData.accent2, '#22C55E', '#F59E0B', '#ffffff'] });
    this._lastResult = { level, total, stars };
  }

  showFailed({ level, found, total }) {
    this.els.failedKicker.textContent = level.id === 'daily' ? 'Daily Challenge' : `${level.title} · ${level.themeData.name}`;
    this.els.failedMessage.textContent = FAIL_MESSAGES[Math.floor(Math.random() * FAIL_MESSAGES.length)];
    this.els.failedStats.textContent = `You found ${found} of ${total} names.`;
    this.showOverlay('failed');
  }

  get lastResult() { return this._lastResult; }

  /* ================= Settings ================= */

  syncSettings(settings) {
    $$('[data-setting]').forEach((t) => {
      const key = t.dataset.setting;
      const on = key === 'performance' ? settings.performanceMode : settings[key];
      t.setAttribute('aria-checked', String(!!on));
    });
  }

  confirmReset() {
    const b = this.els.resetBtn;
    if (b.dataset.confirm === '1') {
      b.dataset.confirm = '';
      b.textContent = 'Reset progress';
      return true;
    }
    b.dataset.confirm = '1';
    b.textContent = 'Tap again to confirm';
    clearTimeout(this._resetTimer);
    this._resetTimer = setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Reset progress'; }, 3000);
    return false;
  }

  /* ================= Hover sounds ================= */

  _bindHoverSounds() {
    let last = null;
    document.addEventListener('pointerover', (e) => {
      if (e.pointerType !== 'mouse') return;
      const b = e.target.closest('.btn, .level-card:not(.is-locked), .toggle');
      if (b && b !== last) this.audio.play('hover');
      last = b;
    });
  }
}
