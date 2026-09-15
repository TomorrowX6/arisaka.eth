# Desktop Runtime Applications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Launch actual Minecraft 1.12.2 and Firefox in the Plasma desktop and deploy verified applications to Cloudflare.

**Architecture:** Serve pinned Eaglercraft assets on a separate Worker; embed the official Firefox Gecko/WISP application in an isolated temporary session. A small desktop module owns native app windows, compatibility checks, and runtime lifecycle. Existing CTF sessions and server verification remain authoritative.

**Tech Stack:** Browser JavaScript/CSS, Eaglercraft u3, Gecko WASM, Cloudflare Workers Static Assets, Node 22, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-desktop-runtime-apps-design.md`

## Global Constraints

- KDE Plasma 6 / Breeze Dark styling.
- Minecraft 1.12.2 u3; use the actual game client and actual Gecko engine.
- Each static asset is below 25 MiB.
- Firefox iframe storage is temporary; visibly disclose it and provide independent opening.
- No CTF credentials, files, or messages are exposed to runtime frames.
- Preserve the edition, entry token, private file hashes, and `public/midi/playlist.json`.
- No merge, blog deployment, or PR comment is needed.

### Task 1: Native application windows

**Files:** `public/runtime-apps.js`, `public/runtime-apps.css`, `public/applications.js`, `public/app.js`, `public/index.html`, `public/desktop.js`, new licensed icons, `test/runtime-apps.browser.test.mjs`, all under `workers/ctf-game/`.

**Interfaces:** `prepareRuntimeApps()` runs before `createDesktop()`; `createRuntimeApps({ windows })` attaches lifecycle handlers before session restoration. Fetch `/runtime-config.json` only on launch. It returns `{ minecraft: { url, source, version, build }, firefox: { url, source } }`. Minecraft iframe fragment contains `profile`, `channel`, `engine` (`auto`, `wasm`, `javascript`), and `parent` (desktop origin). Messages are `{ type: 'arisaka:runtime', app: 'minecraft', channel, phase, message? }`; require the exact source WindowProxy, origin, and channel. Firefox needs a credentialless iframe and cross-origin-isolation permission.

- [ ] Register the two apps and create accessible native windows, desktop shortcuts, source links, and launch controls.
- [ ] Add tests that hold the config response, close the window, and assert no late iframe is created; verify minimize/restoration retains the iframe and reopening does not duplicate it.
- [ ] Implement one cancellable launch generation per window; remove frames and clear timers on close. Keep placeholders useful for failures and unsupported browsers. Never report Firefox engine readiness from its iframe `load` event.
- [ ] Verify messages from a different source, origin, or old channel cannot affect current UI. Keep previews inert and free of runtime frames.

### Task 2: Reproducible Minecraft hosting and isolation

**Files:** `runtime/worker.ts`, `runtime/wrangler.jsonc`, `runtime/src/*`, `scripts/build-runtimes.mjs`, `test/runtimes.test.mjs`, `src/index.ts`, `test/index.test.ts`, `public/runtime-config.json`, `wrangler.jsonc`, and `package.json` under `workers/ctf-game/`.

**Interfaces:** Runtime base `/minecraft/1.12.2/`, assets served from its generated subdirectory. Desktop configuration uses `DESKTOP_APPS_ORIGIN` (production Worker origin; local `http://127.0.0.1:8789`). The runtime only trusts its configured `DESKTOP_ORIGIN` for status messages and framing. Hash-pinned archives live in ignored `.private/runtimes`; output lives in ignored `runtime/dist`.

- [ ] Write meaningful tests around extraction: no inline huge data URLs, decompressed compatibility code equals the pinned original, EPW/EPK bytes are intact, generated file sizes respect 25 MiB, and changed archive hashes reject before extraction.
- [ ] Extract the WASM bootstrap and EPW payload, gzip the original JavaScript engine without editing its program, and extract EPK payloads. Generate a version/hash manifest. Preserve third-party attribution and provide source links.
- [ ] Build a Breeze loading screen that selects the supported engine, reports real fetch errors, namespaces profile storage, and launches the actual engine. Do not retain the offline distribution's countdown or insulting social metadata.
- [ ] Serve with explicit content types, caching, COOP/COEP/CORP, a restrictive runtime CSP, frame ancestors, and a narrow asset allowlist. Add desktop headers and the dynamic public runtime configuration while preserving runner CSP restrictions.
- [ ] Run Node tests, Worker tests/typecheck, and dry-run both Workers.

### Task 3: Real browser verification and deployment

**Files:** `test/runtime-apps.browser.test.mjs`, `test/runtime-engines.browser.test.mjs`, `scripts/test-runtimes.mjs`, `scripts/deploy-runtimes.mjs`, `scripts/deploy.mjs`, `.github/workflows/ci.yml`, and project README.

- [ ] Exercise Minecraft's actual menus to create a world, render terrain, save and exit, restart, and reopen its stored world. Repeat startup using the JavaScript build and confirm 1.12.2.
- [ ] Start Firefox from the official Launch button; use its actual address bar to navigate to `https://example.com/`, confirm Gecko's document title, and inspect rendered pixels. Verify resize and retained state across minimize.
- [ ] Run all existing tests, including all 26 cases. Check all protected hashes and review the final diff.
- [ ] Deploy and health-check the runtime Worker before deploying the desktop. Push the feature branch, inspect CI on the exact commit, and run production browser checks through the existing entrance.
- [ ] Update PR 13's description with final behavior, validation, and the Firefox temporary-session/browser requirements; report the launch location and deployed entrance to the user.
