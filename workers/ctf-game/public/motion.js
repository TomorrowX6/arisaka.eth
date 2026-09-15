// SPDX-FileCopyrightText: 2022 Vlad Zahorodnii <vlad.zahorodnii@kde.org>
// SPDX-License-Identifier: GPL-2.0-or-later
// The SpringMotion integration is adapted for browser Web Animations below.
// License: /licenses/kwin-GPL-2.0-or-later.txt
import { getSetting, preferenceEvents } from '/preferences.js';

// KWin v6.3.5: scale (200 ms, 0.8 scale, OutCubic/InCubic), squash
// (250 ms, window geometry to icon geometry), maximize (250 ms, OutCubic).
// https://invent.kde.org/plasma/kwin/-/tree/v6.3.5/src/plugins
const OUT_CUBIC = 'cubic-bezier(.333333,1,.666667,1)';
const IN_CUBIC = 'cubic-bezier(.333333,0,.666667,0)';
const OUT_QUART = 'linear(' + Array.from({ length: 33 }, (_, index) => 1 - (1 - index / 32) ** 4).join(',') + ')';
const SPRING_STEP = .01;
const SPRING_CONSTANT = 300; // KWin's default animationTimeFactor is 1.
const SPRING_DAMPING = 2 * Math.sqrt(SPRING_CONSTANT) * 1.1;
const SPRING_EPSILON = 1;
const surfaces = new WeakMap();
const moving = new Set();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export function motionEnabled() {
  return getSetting('animations') !== false && document.documentElement.dataset.motion !== 'off' && !reducedMotion.matches;
}

export function isSurfaceOpen(node) {
  return Boolean(node && !node.hidden && (surfaces.get(node)?.open ?? true));
}

function stateFor(node) {
  let state = surfaces.get(node);
  if (!state) { state = { open: !node.hidden, animation: null, spring: null, serial: 0 }; surfaces.set(node, state); }
  return state;
}

function stop(node, state) {
  const animation = state.animation;
  state.animation = null;
  state.spring = null;
  state.serial++;
  moving.delete(node);
  delete node.dataset.motionState;
  animation?.cancel();
}

function settle(node, state) {
  stop(node, state);
  node.hidden = !state.open;
  node.inert = !state.open;
}

export function cancelMotion(node) {
  if (node) settle(node, stateFor(node));
}

function frame(node) {
  const style = getComputedStyle(node);
  // Individual transforms compose with the surface's CSS transform (for
  // example a centered switcher) and leave its inline geometry untouched.
  return { opacity: style.opacity, scale: style.scale, translate: style.translate, transformOrigin: style.transformOrigin, clipPath: style.clipPath };
}

function play(node, state, frames, duration, easing, phase) {
  if (!motionEnabled() || !node.isConnected || typeof node.animate !== 'function') { settle(node, state); return; }
  const serial = state.serial;
  node.dataset.motionState = phase;
  try {
    const animation = node.animate(frames, { duration, easing, fill: 'both' });
    state.animation = animation;
    moving.add(node);
    const finish = () => {
      if (state.serial === serial && state.animation === animation) settle(node, state);
    };
    animation.onfinish = finish;
    animation.oncancel = finish;
  } catch { settle(node, state); }
}

// Match the numerical behavior of KWin v6.3.5 SpringMotion (Vlad
// Zahorodnii, 2022; source distributed under GPL-2.0-or-later):
// https://github.com/KDE/kwin/blob/v6.3.5/src/plugins/slide/springmotion.cpp
// Its RK4 evaluator uses the input velocity for every position
// slope, including the intermediate evaluations. Keep that version's behavior.
function springStep({ position, velocity }, anchor) {
  const acceleration = (dp, dv) => (anchor - position - dp) * SPRING_CONSTANT - (velocity + dv) * SPRING_DAMPING;
  const a = acceleration(0, 0);
  const b = acceleration(velocity * SPRING_STEP / 2, a * SPRING_STEP / 2);
  const c = acceleration(velocity * SPRING_STEP / 2, b * SPRING_STEP / 2);
  const d = acceleration(velocity * SPRING_STEP, c * SPRING_STEP);
  return { position: position + velocity * SPRING_STEP, velocity: velocity + (a + 2 * b + 2 * c + d) * SPRING_STEP / 6 };
}

function springMoving(axis, anchor) {
  return Math.abs(axis.position - anchor) > SPRING_EPSILON || Math.abs(axis.velocity) > SPRING_EPSILON;
}

function interpolateAxis(before, after, amount) {
  return { position: before.position * (1 - amount) + after.position * amount, velocity: before.velocity * (1 - amount) + after.velocity * amount };
}

function springVelocity(state) {
  if (!state?.spring || !state.animation) return { x: 0, y: 0 };
  const { samples, duration } = state.spring;
  const time = Math.max(0, Math.min(duration, Number(state.animation.currentTime) || 0));
  const index = Math.min(samples.length - 2, Math.floor(time / (SPRING_STEP * 1000)));
  const before = samples[index], after = samples[index + 1];
  const amount = (time - before.time) / (after.time - before.time);
  return { x: interpolateAxis(before.x, after.x, amount).velocity, y: interpolateAxis(before.y, after.y, amount).velocity };
}

function translation(node, value) {
  const parts = value.split(/\s+/);
  const length = (part, size) => {
    const number = parseFloat(part) || 0;
    return part?.endsWith('%') ? number * size / 100 : number;
  };
  return { x: length(parts[0], node.offsetWidth), y: length(parts[1], node.offsetHeight) };
}

function playDesktop(node, state, from, to, velocity, phase) {
  const start = translation(node, from.translate), anchor = translation(node, to.translate);
  const samples = [{ time: 0, x: { position: start.x, velocity: velocity.x }, y: { position: start.y, velocity: velocity.y } }];
  const moving = (sample) => springMoving(sample.x, anchor.x) || springMoving(sample.y, anchor.y);
  if (!moving(samples[0])) { settle(node, state); return; }
  while (moving(samples.at(-1))) {
    const before = samples.at(-1);
    const next = {
      time: before.time + SPRING_STEP * 1000,
      x: springMoving(before.x, anchor.x) ? springStep(before.x, anchor.x) : before.x,
      y: springMoving(before.y, anchor.y) ? springStep(before.y, anchor.y) : before.y,
    };
    if (!moving(next)) {
      // SpringMotion linearly interpolates 10 ms samples at presentation time.
      // Find where all four rest conditions become true within the last sample.
      const atRest = (a, b, target) => Math.abs(a - target) <= SPRING_EPSILON ? 0 : (target + Math.sign(a - target) * SPRING_EPSILON - a) / (b - a);
      const amount = Math.max(atRest(before.x.position, next.x.position, anchor.x), atRest(before.x.velocity, next.x.velocity, 0), atRest(before.y.position, next.y.position, anchor.y), atRest(before.y.velocity, next.y.velocity, 0));
      samples.push({ time: before.time + amount * SPRING_STEP * 1000, x: interpolateAxis(before.x, next.x, amount), y: interpolateAxis(before.y, next.y, amount) });
      break;
    }
    samples.push(next);
  }
  const duration = samples.at(-1).time;
  const frames = samples.map((sample) => ({ offset: sample.time / duration, translate: sample.x.position + 'px ' + sample.y.position + 'px' }));
  Object.assign(frames[0], from, { translate: frames[0].translate });
  // KWin snaps to the desktop grid after reaching epsilon. Duplicate the final
  // offset so the subpixel correction doesn't change the preceding trajectory.
  frames.push({ ...to, offset: 1 });
  // A previous window/popup transition may have been interrupted. Let its
  // opacity/scale settle without stretching that transition over the spring.
  const appearance = { ...to, offset: Math.min(200, duration) / duration };
  delete appearance.translate;
  frames.push(appearance);
  frames.sort((a, b) => a.offset - b.offset);
  play(node, state, frames, duration, 'linear', phase);
  if (state.animation) state.spring = { samples, duration };
}

function rectOf(anchor) {
  const rect = typeof anchor?.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : anchor;
  return rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0 ? rect : null;
}

function originAt(origin, anchor, rect) {
  const target = rectOf(anchor);
  const x = target ? Math.max(0, Math.min(rect.width, target.left + target.width / 2 - rect.left)) + 'px' : '50%';
  const y = target ? Math.max(0, Math.min(rect.height, target.top + target.height / 2 - rect.top)) + 'px' : '50%';
  return ({ top: x + ' 0%', bottom: x + ' 100%', left: '0% ' + y, right: '100% ' + y })[origin] || '50% 50%';
}

function effectFrames(node, effect, origin, anchor) {
  const rect = node.getBoundingClientRect();
  const normal = frame(node);
  const center = '50% 50%';
  // KWin fadingpopups: 150 ms Linear in; 4 * 150 ms OutQuart out.
  if (effect === 'menu' || effect === 'fade') return {
    duration: 150, exitDuration: 600, enterEasing: 'linear', exitEasing: OUT_QUART,
    normal, collapsed: { ...normal, opacity: 0 },
  };
  if (effect === 'minimize') {
    const target = rectOf(anchor) || {
      left: origin === 'left' ? 0 : origin === 'right' ? innerWidth - 24 : rect.left + rect.width / 2 - 12,
      top: origin === 'top' ? 0 : origin === 'bottom' ? innerHeight - 24 : rect.top + rect.height / 2 - 12,
      width: 24, height: 24,
    };
    const x = target.left + target.width / 2 - rect.left - rect.width / 2;
    const y = target.top + target.height / 2 - rect.top - rect.height / 2;
    return { duration: 250, normal: { ...normal, transformOrigin: center }, collapsed: {
      opacity: 0, scale: Math.max(.001, target.width / Math.max(1, rect.width)) + ' ' + Math.max(.001, target.height / Math.max(1, rect.height)),
      translate: x + 'px ' + y + 'px', transformOrigin: center,
    } };
  }
  if (effect === 'window') return { duration: 200, normal: { ...normal, transformOrigin: center }, collapsed: { ...normal, opacity: 0, scale: '.8', transformOrigin: center } };
  if (effect === 'lock') return { duration: 250, normal, collapsed: { ...normal, opacity: 0 } };
  if (effect === 'desktop') {
    const x = origin === 'left' ? -innerWidth : origin === 'right' ? innerWidth : 0;
    const y = origin === 'top' ? -innerHeight : origin === 'bottom' ? innerHeight : 0;
    return { normal, collapsed: { ...normal, translate: x + 'px ' + y + 'px' } };
  }
  // KWin slidingpopups: 200 ms OutCubic in either direction, clipped at
  // the source edge, with travel bounded by eight font heights.
  if (origin === 'center') return { duration: 200, normal, collapsed: { ...normal, opacity: 0 } };
  const style = getComputedStyle(node);
  const fontHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 18;
  const distance = Math.min(origin === 'top' || origin === 'bottom' ? rect.height : rect.width, fontHeight * 8);
  const transformOrigin = originAt(origin, anchor, rect);
  const translate = ({ top: '0px -' + distance + 'px', bottom: '0px ' + distance + 'px', left: '-' + distance + 'px 0px', right: distance + 'px 0px' })[origin] || '0px 0px';
  const target = rectOf(anchor);
  const gap = target ? Math.max(0, Math.min(40, ({ top: rect.top - target.bottom, bottom: target.top - rect.bottom, left: rect.left - target.right, right: target.left - rect.right })[origin] || 0)) : 0;
  const clip = (travel) => 'inset(' + ['top', 'right', 'bottom', 'left'].map((edge) => (edge === origin ? travel - gap : -40) + 'px').join(' ') + ')';
  return { duration: 200, normal: { ...normal, transformOrigin, clipPath: clip(0) }, collapsed: { ...normal, opacity: 0, translate, transformOrigin, clipPath: clip(distance) } };
}

export function showSurface(node, { effect = 'popup', origin = 'bottom', anchor = null } = {}) {
  if (!node) return;
  const previous = surfaces.get(node);
  if (previous?.open && !node.hidden) {
    if (!motionEnabled()) settle(node, previous);
    return;
  }
  const interrupted = previous?.animation && !node.hidden ? frame(node) : null;
  const velocity = springVelocity(previous);
  const state = stateFor(node);
  stop(node, state);
  state.open = true;
  node.hidden = false;
  node.inert = false;
  if (!motionEnabled()) { settle(node, state); return; }
  const { normal, collapsed, duration, enterEasing = OUT_CUBIC } = effectFrames(node, effect, origin, anchor);
  if (effect === 'desktop') { playDesktop(node, state, interrupted || collapsed, normal, velocity, 'enter'); return; }
  play(node, state, [interrupted || collapsed, normal], duration, enterEasing, 'enter');
}

export function hideSurface(node, { effect = 'popup', origin = 'bottom', anchor = null } = {}) {
  if (!node) return;
  const state = stateFor(node);
  if (!state.open || node.hidden) {
    state.open = false;
    node.inert = true;
    if (!state.animation || !motionEnabled() || node.hidden) settle(node, state);
    return;
  }
  const interrupted = state.animation ? frame(node) : null;
  const velocity = springVelocity(state);
  stop(node, state);
  state.open = false;
  node.inert = true;
  if (!motionEnabled()) { settle(node, state); return; }
  const { normal, collapsed, duration, exitDuration = duration, exitEasing = effect === 'window' || effect === 'minimize' ? IN_CUBIC : OUT_CUBIC } = effectFrames(node, effect, origin, anchor);
  if (effect === 'desktop') { playDesktop(node, state, interrupted || normal, collapsed, velocity, 'exit'); return; }
  play(node, state, [interrupted || normal, collapsed], exitDuration, exitEasing, 'exit');
}

export function animateGeometry(node, before) {
  if (!node) return;
  const state = stateFor(node);
  stop(node, state);
  if (!state.open || node.hidden || !motionEnabled() || !rectOf(before)) { settle(node, state); return; }
  const after = rectOf(node);
  if (!after) return;
  const x = before.left + before.width / 2 - after.left - after.width / 2;
  const y = before.top + before.height / 2 - after.top - after.height / 2;
  if (Math.abs(x) < .5 && Math.abs(y) < .5 && Math.abs(before.width - after.width) < .5 && Math.abs(before.height - after.height) < .5) return;
  const normal = { ...frame(node), transformOrigin: '50% 50%' };
  play(node, state, [{ ...normal, translate: x + 'px ' + y + 'px', scale: before.width / after.width + ' ' + before.height / after.height }, normal], 250, OUT_CUBIC, 'geometry');
}

function settleReducedMotion() {
  if (!motionEnabled()) for (const node of [...moving]) settle(node, stateFor(node));
}
preferenceEvents.addEventListener('appearance', settleReducedMotion);
reducedMotion.addEventListener('change', settleReducedMotion);
// Keep direct appearance previews and preference changes equivalent.
new MutationObserver(settleReducedMotion).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
