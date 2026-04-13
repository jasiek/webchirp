# Release Notes

## 2026-04-13
- Added loading placeholders while CHIRP radio drivers initialize.

## 2026-04-01
- Added Google Analytics tracking for radio download and upload attempts.

## 2026-03-27
- Added social preview metadata and card imagery for shared links.
- Fixed social metadata to match the deployed root path.
- Removed the extra top-level `index.html`.
- Added Google Analytics support.

## 2026-03-26
- Switched repeater query country selection to full country names with flags.
- Hid the sidebar debug panel while preserving warning panel ordering.
- Added a new link in the UI/docs.

## 2026-03-24
- Added a RepeaterBook repeater query action.

## 2026-03-18
- Added FRS and GMRS channel preset actions, including region labels and bandwidth/power mapping.
- Defaulted generated FRS channels to low power.
- Widened the channel actions menu.

## 2026-03-16
- Preserved selected and edited power levels during upload, export, and direct radio writes.
- Extracted a shared radio test harness.
- Returned CSV text from codeplug reads.
- Added binary codeplug methods to the test harness and exposed an agent-facing radio codeplug CLI.

## 2026-03-14
- Added a radio settings editor and CHIRP settings RPC support.
- Added CLI repro tooling and test sweeps for radio settings failures across registered drivers.
- Gated radio settings on cached backing state and greyed out settings until a cached image exists.
- Skipped immutable radio settings during upload validation.
- Added an experimental warning panel in the sidebar and adjusted its messaging.
- Replaced the embedded GitHub star button with a local widget.
- Kept bug reporting available and allowed prefilled generic reports.
- Marked live-mode radios in the model dropdown and disabled unsupported serial actions for them.
- Handled missing CHIRP float max values during settings serialization.
- Removed a stale ignore entry for `webchirp-hw`.

## 2026-03-03
- Hardened CLI radio test retries, serial path handling, timeouts, and reboot waits.
- Removed the earlier real-radio CLI test infrastructure and replaced it with a hardware read/write roundtrip harness.
- Refactored Pyodide integration to support pluggable Python source providers.
- Replaced RPC `if` chains with named dispatch maps.
- Switched the UI/runtime boundary to direct method calls.
- Replaced polling serial reads with event-driven waiters and fixed partial-buffer starvation.
- Updated README runtime documentation and refreshed agent/repo ignore guidance.

## 2026-02-28
- Removed the Web Worker runtime path and ran Pyodide on the main thread instead.
- Added a COOP/COEP development server for `SharedArrayBuffer` support.
- Set the development server root to `web/`.
- Avoided loading GitHub `buttons.js` under COEP isolation.

## 2026-02-27
- Added a sidebar warning when Web Serial is unsupported.

## 2026-02-26
- Disambiguated duplicate radio model options in the dropdown.

## 2026-02-24
- Fixed the Przemienniki modal label-association warning in DevTools.
- Disabled autocomplete for the country field.
- Unified serial connect and disconnect into a single stateful toggle button.

## 2026-02-23
- Added a Przemienniki.net actions modal with XML parsing and channel insertion.
- Loaded Przemienniki filters from the meta endpoint and refined query flags, mode selection, country handling, and band filtering.
- Added a geolocation shortcut for Przemienniki queries.
- Extracted channel data sources into a dedicated module.
- Updated the dist build to include data source assets and rewrite sibling imports to hashed asset names.
- Refreshed `AGENTS.md`.

## 2026-02-22
- Moved the channel add/remove toolbar outside the table scroll area.
- Added a channel actions menu with PMR446 insertion.
- Handled empty `Offset` values in CHIRP CSV paths.
- Added a CLI Pyodide suite for channel-list parseability and codeplug apply workflows.
- Added upload preflight invalid-cell highlighting using CHIRP validation.
- Added binary codeplug export/import with model preselection.
- Improved the About page styling and added a toolbar link.
- Simplified deploy packaging to copy `web/` directly into `dist`, then restored hashed assets for cache busting.
- Re-added the CHIRP submodule for convenience.

## 2026-02-21
- Changed the dist build to deploy web content at the root with cache-busted assets.
- Kept sidebar controls disabled until initialization completed and made disabled states more visibly muted.
- Added channel row multi-selection, toolbar insertion above the table, and removal of selected channels.
- Skipped empty CHIRP memories on download and erased omitted memory slots during upload.
- Exposed `currentRows` on `globalThis` for console inspection.
- Propagated upload exceptions with full tracebacks.
- Allowed CSV export when CHIRP reports no channels.
- Normalized CSV power handling, including parseable labels, radio defaults, and CHIRP-derived power strings.
- Persisted and restored the selected radio with a cookie, including startup preservation behavior.
- Added Node-based serial hardware test flows for UV-5R with backup/restore timing hardening.
- Updated README content, diagrams, live-link details, and screenshots.
- Refreshed `AGENTS.md`.

## 2026-02-20
- Switched to the CHIRP directory registry for a complete radio catalog.
- Ignored optional CHIRP source checkouts used by the AI agent.
- Improved layout behavior so the editor panel scrolls internally while the app shell stays constrained to the viewport.
- Hid DV-only columns for non-DV radios.
- Centralized the CHIRP revision in one worker constant and corrected it to the current version at the time.
- Removed the Session panel and routed status messages to debug output only.
- Added hashed dist builds for cache-busting deployments.

## 2026-02-19
- Added a radio bug issue form with environment and CHIRP revision fields.
- Added one-click GitHub issue reporting from debug errors.
- Switched the bug form USB device field to vendor/product IDs.
- Recreated `package.json` from lockfile metadata and added `package-lock.json`.
- Added a `build:dist` script to produce a deployable dist bundle.
- Removed the CHIRP submodule for a period before it was later restored.

## 2026-02-13
- Added purpose comments documenting worker, app, and runtime bridge functions.
- Added a Python import hook for lazy CHIRP module loading.
- Split `app.js` into serial, UI, and worker RPC modules.
- Moved Python TX/RX controls into the collapsed debug panel.
- Restored bottom debug output and moved debug tools into the sidebar.
- Added a commit-message rule to `AGENTS.md`.
- Removed the baud-rate UI and derived baud from the selected driver on connect.

## 2026-02-12
- Bootstrapped the project with a BF-888 browser prototype and the CHIRP submodule.
- Fixed `JsProxy` serialization in serial bridge responses.
- Added a bottom debug panel with centralized runtime logs and routed radio read logs there.
- Added CHIRP-sourced make/model selectors and generic selected-radio actions.
- Moved Pyodide runtime Python into a separate versioned module and generalized the runtime bridge beyond BF-888-specific endpoints.
- Sent full runtime errors to the debug panel while shortening status text.
- Cached downloaded clone images for upload reuse and prepared serial sessions before clone operations to reduce reconnect issues.
- Fixed upload row parsing and suppressed an undefined ident log.
- Added repository guidance in `AGENTS.md` and ignored Python/web development artifacts.
- Used CHIRP-sourced column metadata for constrained editors.
- Loaded selected CHIRP driver modules and dependencies on demand.
- Added PySerial buffer reset compatibility for more CHIRP drivers.
- Added a root index redirect to `/web`.
- Loaded CHIRP sources from the jsDelivr master branch.
- Added a toolbar link to the CHIRP GitHub project and clarified link text.
