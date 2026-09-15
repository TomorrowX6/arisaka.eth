# Application-Based Case Recovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the bounded recovery module and test task; integrate the application changes in this session. Steps use checkbox syntax for tracking.

**Goal:** Complete cases through application results, group all cases in one archive
folder, and remove the white window miniatures from the virtual desktop pager.

**Architecture:** Reuse native desktop applications and the existing Worker digest
check. A bounded recovery bridge connects successful application output and file
saves to progress, while notifications announce newly available case directories.

**Tech Stack:** Browser ES modules, IndexedDB, Web Workers, Cloudflare Workers, Node 22 and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-native-case-workflow-design.md`

## Global Constraints

- Preserve all 26 cases, the edition, entry token, build seed and signing secret.
- Keep the existing server answer API compatible; no client-side success shortcut.
- Preserve the user's uncommitted `public/midi/playlist.json`.
- Use existing application, file and notification services; add no dependency.
- Publish to the existing PR #13 branch and authorized Cloudflare Worker.

## Task 1: Bounded recovery bridge

**Files:** New `workers/ctf-game/public/recovery.js`, new
`workers/ctf-game/test/recovery.test.mjs`; update the Worker package test script.

**Interface:**

```js
parseRecovery(value) // object with code and optional receipt/letter, or null
createRecovery({ state, submit, accept, error }) // returns the methods below
// state() gives {started, player, edition, stage, outdated}.
// submit(stage, code) returns the existing /api/answer result.
// accept(result, payload, context) updates UI/state only for a current recovery.
// error(error, context) reports a current operation's validation/network failure.
recovery.capture(stage = state().stage) // player/edition/stage/reset generation
recovery.observe(value, context = recovery.capture()) // Promise, never an unhandled rejection
recovery.reset() // invalidate queued and in-flight UI callbacks
```

- [x] Write and run failing tests for normal text vs real payloads, 64 KiB limits,
  duplicate results, queued operations after advancement, profile switches,
  incorrect verification and retry after a transient error.
- [x] Implement strict parsing, bounded deduplication and serialized verification.
- [x] Run the focused Node tests and review the module against the spec.

## Task 2: Native application lifecycle and shell output

**Files:** `public/app.js`, `public/system.js`, `public/console.js`,
`public/index.html`, `public/widgets.js`, `public/filesystem.js`, `public/files.js`,
`public/style.css`, `public/native.css`, `test/browser.test.mjs`.

- [x] Add a failing browser regression showing `/#case-1` opens `#console-window`
  at the actual case path and that `#answer-form` does not exist. Assert that `pwd`
  and `ls` leave progress unchanged.
- [x] Route terminal, HTTP, artifact and audio cases to the existing applications.
  Keep specific decoders in the workbench with filename-based titles.
- [x] Remove generic answer, solved and next controls; connect specialized decoded
  results to `recovery.observe(value, recovery.capture(record.id))`.
- [x] Listen to committed filesystem write audit events; read only payload-sized
  documents and pass their contents with the captured recovery context.
- [x] Await worker execution completion in `system.run`, preserve stdout, and pass
  it through shell pipes/redirection. Use `node -e` and `python3 -c` semantics.
- [x] Observe successful script, command and HTTP outputs using operation contexts.
  Notify on accepted results, update folder availability, preserve input focus,
  and open the completion document only after the last recovery.
- [x] Add readable workspace help at `/usr/share/doc/recovery.txt` describing normal
  output/file workflows without puzzle answers or a special submit command.
- [x] Run focused browser tests for launch, editor save, unrelated input, script
  redirection, cancellation and progress persistence.

## Task 3: Grouped case folders and pager cleanup

**Files:** `public/filesystem.js`, `public/files.js`, `public/ui.js`,
`public/shell.js`, `public/shell.css`, `public/app.js`, `public/system.js`,
`test/browser.test.mjs`, `test/campaign.test.mjs`.

- [x] Move displayed case paths to `~/档案/01` through `~/档案/26`, preserving
  unlisted legacy aliases and read-only access enforcement.
- [x] Keep locked folders selectable and show a native “禁止访问” dialog when
  opening them from Dolphin or a file picker.
- [x] Remove pager window miniatures and their CSS while retaining numbered
  desktop buttons, active state and switching behavior.
- [x] Update application paths, help and campaign coverage. Check the folder and
  dialog in the browser at desktop and small-screen sizes.
- [x] Keep background metadata refresh separate from explicit folder navigation.
  Reproduce delayed boot and user requests in a browser test, preserve the browsed
  directory during initial loading, and let the requested folder open afterward.

## Task 4: Independent campaign verification and publication

**Files:** `test/campaign.test.mjs`, plan validation notes.

- [x] Replace code-form submission in the 26-case test with real application
  operations on independently recovered evidence. Save recovered documents through
  the editor or shell and exercise native HTTP/decoder paths where applicable.
- [x] Check every stage increment, final proof, reload and history navigation.
- [x] Run `pnpm check`, `pnpm test`, `pnpm build` and `pnpm test:e2e` using Node 22.
- [x] Inspect native terminal, HTTP, archive and access-denied screenshots on
  desktop and a small screen; review the final integrated diff.

Publication sequence, with execution results recorded in the task ledger and PR
checks: commit task files only, push the existing branch, deploy with
`pnpm ctf:deploy`, compare published asset hashes and confirm live application-based
progression. Confirm CI and preserved private inputs and playlist, then remove
temporary auth files and close task-owned dev servers/browser sessions.

## Verification record

- Node 22.23.2: type checking and production dry-run build passed; Node tests
  passed 43/43 and Worker Vitest tests passed 30/30.
- Initial full browser suite passed 51/51, including every case in the independent
  26-case campaign. No failures, cancellations or skipped tests.
- The follow-up delayed-navigation regression was observed failing before the
  refresh and initial-loading fixes, then passed with the real application and
  Worker responses. The complete 26-case campaign passed again afterward.
- Recovery unit coverage includes seven tests, with an explicit regression for
  unverified metadata in an `already-solved` response.
- Integrated review found no remaining important production issue after fixing
  stale session refreshes, background terminal focus, deferred write contexts,
  idempotent metadata handling and editor tab persistence.
- Follow-up review confirmed that metadata refresh preserves pending navigation,
  the active pane and surviving selections while discarding stale responses.
- Desktop and 720 × 480 screenshots confirm grouped cases, the access-denied
  dialog and the pager without window miniatures. Screenshots stay private.
