# Application-based case recovery

The user wants the Plasma desktop to behave like its applications. The separate
case terminal and universal passcode form currently require users to leave their
work to submit a code. Replace that interaction with ordinary application output
and durable document saves.

## Application behavior

- Opening case 01 launches the existing Konsole in the case directory. Its real
  workspace files, shell history, pipelines and script runners are available.
- Opening case 02 launches the existing HTTP client with `/api/echo` selected.
- Artifact cases open their directory in Dolphin; file associations launch the
  existing editors, packet analyzer, archive manager and other tools.
- The audio case opens its WAV in the existing media player. The MIDI, QR,
  comparison and sealed-document tools keep their operation-specific controls.
- Remove the universal answer form, solved footer and next-case button from the
  workbench markup and code. Specialized tools show filenames and their actual
  results. They can save a result as a document, with no extra validation step.
- Recoveries unlock the next existing directory and produce a Plasma notification.
  Do not switch away from the user's working application between cases. The final
  recovery opens the existing completion document.

## Case folders and virtual desktops

- Keep the KDE Plasma 6 / Breeze Dark appearance. The virtual desktop pager keeps
  its numbered buttons, current-desktop indicator and switching animation; remove
  the white window miniatures inside those buttons.
- Put all 26 case directories under `~/档案`. Show one archive folder in the home
  directory and keep every case visible inside it, including locked cases.
- A locked directory remains selectable. Double-clicking it opens a native
  “禁止访问” dialog and leaves the current directory unchanged. File pickers use
  the same access check and message.
- Retain the old `~/01/...` paths as unlisted compatibility aliases for saved
  scripts and editor tabs. Both path forms remain read-only and enforce the same
  server-backed access rules.

## Recovery bridge

A small DOM-independent module recognizes an actual recovered payload: a bounded
JSON object with a valid `code`, a standalone recovered token, or the existing
ASCII archive envelope. It does not search arbitrary source code, ciphertext,
unrelated command text or binary data for candidate substrings. Payloads are
limited to 64 KiB. Receipt and letter fields are bounded and validated separately.

Observe the result of a completed shell command or script, a successful HTTP
response, a specialized decoder, and a successfully persisted document. Never
observe editor keystrokes, command input or failed writes. Ordinary output must
not make answer requests.

Capture player, edition and stage when an operation starts. Deduplicate identical
results, serialize requests, ignore results after the player changes or the stage
has moved on, and allow a retry after a network failure. Progress still depends
on the existing Worker digest check. An incorrect result does not unlock anything.
Valid receipts are recorded automatically after a successful recovery.

The server's `already-solved` response reconciles progress only: it does not verify
the submitted digest, so it must not accept receipt metadata or remember that code
as verified. Delayed session refreshes cannot roll back the current stage or
overwrite a different player or edition.

## Shell execution

Await actual script completion before continuing a pipeline or writing redirected
stdout. Preserve streaming output for normal commands. Support the customary
`node -e` and `python3 -c` invocations. Interruption must settle the pending command
and must not turn incomplete output into a recovery.

Copies, touches and redirected writes preserve the originating recovery context.
A background command must not steal focus from another application when it ends.
Successful editor saves immediately persist tab state, including a final flush on
page hide, and edits made while saving stay marked as unsaved.

## Constraints

- Preserve all 26 cases, the edition, entry token, build seed and signing secret.
- Keep the existing server answer API compatible; no client-side success shortcut.
- Preserve the user's uncommitted `public/midi/playlist.json`.
- Use existing application, file and notification services; add no dependency.
- Publish to the existing PR #13 branch and authorized Cloudflare Worker.

## Verification

Unit tests cover payload recognition, concurrency, stale operations, incorrect
results and retries. Browser tests exercise the real Konsole, script redirection,
an actual editor save and the HTTP client. The full campaign continues to recover
every result independently from served evidence, then uses application operations
to complete it. Verify native launch behavior, unchanged progress after unrelated
operations, completion and reload persistence. Inspect desktop and small-screen
screenshots and run the existing Worker and desktop suites before publication.
Check the single archive folder, locked-directory dialog, legacy paths and the
absence of pager window miniatures after opening applications.
