# Plasma 6 Breeze Dark fidelity implementation plan

> **For agentic workers:** Use the parallel-agent workflow for the independent window-motion and shell tasks, then integrate and verify in the existing browser suite.

**Goal:** Bring the existing browser desktop closer to KDE Plasma 6 / Breeze Dark in appearance, window behavior, and animation, using official KDE sources as the reference.

**Architecture:** Keep the current desktop window registry, user settings, applications, and game APIs. Introduce a shared, cancellable Web Animations layer and inert window thumbnails; apply the same motion policy to windows, menus, and shell surfaces. Refine the existing Breeze styles instead of introducing another UI framework.

**Tech stack:** Browser ES modules, CSS, Web Animations API, Playwright, Cloudflare Workers.

## Constraints and acceptance

- The user selected KDE Plasma 6 / Breeze Dark. Preserve alternative themes and existing user preferences.
- Keep all 26 cases and existing saves, entrance, build seed, and signing secret compatible.
- Respect both the desktop animation setting and `prefers-reduced-motion`. Rapid close/reopen must not leave hidden, inert, or transparent windows.
- Keep focus and logical window state synchronous with user actions; outgoing animations must not accept input.
- Preserve keyboard navigation, Escape, Alt+Tab, dragging, resizing, tiling, four panel positions, and small screens.
- Preview content is inert, excludes duplicate DOM IDs, and does not trigger application actions.
- Keep the user's existing `public/midi/playlist.json` changes untouched.

## Task 1 — Window and surface motion

**Own:** `workers/ctf-game/public/desktop.js`, new `motion.js`, new `motion.css`.

Provide this shared interface:

```js
motionEnabled() // boolean
showSurface(node, { effect = 'popup', origin = 'bottom', anchor = null } = {}) // void
hideSurface(node, { effect = 'popup', origin = 'bottom', anchor = null } = {}) // void
isSurfaceOpen(node) // logical visibility, including during exit
animateGeometry(node, before) // animate from a DOMRect to the current geometry
cancelMotion(node) // cancel a transition without leaving stale callbacks/styles
```

- [x] Implement cancellable scale/fade opening, panel-directed minimization/restoration, maximize/restore/tile transitions, desktop switching, and switcher transitions.
- [x] Use short Plasma-style surface transitions and KWin-style window easing; record official timing references in the implementation notes.
- [x] Honor reduced motion immediately, including when changed mid-transition.
- [x] Preserve close cancellation, saved geometry, focus, and rapid reopen behavior.

## Task 2 — Shell fidelity and interactions

**Own:** `workers/ctf-game/public/shell.js`, `shell.css`.

Consume the motion interface above and `createWindowPreview(windowNode, {width, height})` from `previews.js`, which returns an inert HTMLElement.

- [x] Refine Kickoff's user/search header, category icons, favorites grid, application list, session actions, hover states, and keyboard navigation.
- [x] Add task hover previews with activate/close controls and a short pointer-intent delay; position them for each panel edge.
- [x] Refine panel indicators, tray, calendar/popups, overview, and lock-screen presentation using existing functional controls.
- [x] Animate shell surface entrance/exit and keep expanded states and focus correct.

## Task 3 — Shared Breeze details and thumbnails

**Own:** `previews.js`, `native.css`, `themes.css`, `ui.js`, `index.html`, static font/icon assets, and this plan.

- [x] Supply inert, bounded thumbnails from existing window content, retaining rendered layout and canvas content without duplicate IDs.
- [x] Refine decoration metrics, menus, focus/hover/pressed/disabled states, borders, shadows, and font consistency.
- [x] Add local font/icon assets only with their licenses and source attribution.
- [x] Wire the motion stylesheet and menu motion while preserving existing APIs.

## Task 4 — Verification and publication

**Own:** `test/browser.test.mjs` and integration fixes.

- [x] Add meaningful browser regressions for rapid minimize/restore and close/reopen, panel previews and activation, launcher keyboard behavior, and reduced motion. Use action/event conditions, not fixed sleeps.
- [x] Verify normal/maximized windows and shell surfaces at 1525×998 and 390×844, including browser screenshots and a motion recording/sample.
- [x] Run the complete desktop and 26-case browser suite on Node 22 and required project checks.
- [x] Review the integrated diff and resolve the independent review findings before publication.

Publication uses the existing PR #13 branch, `feat/plasma-expert-campaign`, and `pnpm ctf:deploy` for the authorized `arisaka-afterglow` Worker. Verify the published assets and UI against the same tested source and preserve the paired entrance files, build seed, and session secret.

Validation on 2026-09-15, Node 22.23.2: `pnpm check`, `pnpm test` (36 Node tests and 30 Worker tests), `pnpm build`, and `pnpm test:e2e` (43 tests, including all 26 cases) passed. The independent review's KRunner focus finding and the integration checks' preview decoration and panel restore findings are fixed and covered by browser regressions. Layout assertions sample one animation frame or wait for the transition to settle. Staged whitespace checks passed.

## Completed before this plan

- Discover container/list-item class collision fixed and committed as `70fdd00`; desktop and mobile layout, search, pinning, and launch behavior verified. Publication will be included with this desktop update.

## Implementation references and scope

- Colors and window decoration use [Breeze v6.3.5](https://github.com/KDE/breeze/tree/v6.3.5): `colors/BreezeDark.colors`, `kdecoration/breezedecoration.cpp`, and the grid calculation in [KDecoration](https://github.com/KDE/kdecoration/blob/v6.3.5/src/decorationsettings.cpp). Browser font metrics determine the actual decoration size; there is no fixed DPI assumption.
- [KWin v6.3.5 effects](https://github.com/KDE/kwin/tree/v6.3.5/src/plugins) provide the timing references: scale 200ms, squash/maximize 250ms, sliding popups 200ms, fading popups 150ms in / 600ms out. Slide uses 10ms spring integration with stiffness 300, damping ratio 1.1, and position/velocity rest thresholds of 1.
- At the reference 1525px viewport, desktop travel samples are 719.867913px at 100ms and 1445.677936px at 300ms. A reversal preserves both the visible position and current velocity. The committed browser regression checks these independent reference samples.
- Kickoff and the panel follow [Plasma Desktop v6.3.5](https://github.com/KDE/plasma-desktop/tree/v6.3.5), including the same-row user/search header, four-column favorites and 700ms task hover intent. Nuvole Dark is the official unmodified Breeze `Next` wallpaper; font, image and adapted-code licenses are recorded in the third-party notices.
- This implements a browser desktop for a single viewport. Multi-output composition, cross-grid desktop gestures, OS-rendered controls, and font rasterization are not covered by a claim of pixel identity. Existing profile appearance choices remain intact.
