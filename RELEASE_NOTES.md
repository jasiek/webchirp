# Release Notes

## 2026-08-23
- Debug Output now starts folded into a compact footer row, expands on demand or automatically when an error occurs, and leaves app-wide progress visible.

## 2026-08-19
- Browsers that cannot run WebCHIRP fully now grey out the app behind an explanation panel instead of a small sidebar note: it says when no serial transport exists (radio programming needs Web Serial — Chrome, Edge or recent Firefox) and when WebAssembly stack switching is missing so radio drivers cannot load at all (old Firefox — update), shows both on Safari, and offers "Continue anyway" for file-based editing.

## 2026-08-17
- Added an adapter loopback test page (`serial-test.html`) with a transport-agnostic suite that bridges TX to RX and verifies every byte comes straight back, and fixed WebUSB chip ports silently delivering nothing when reopened after close (#56).
- The loopback test page can now file a pre-filled GitHub issue in one tap, carrying the adapter, platform, browser, app version and a failure-first trimmed report, so mobile testers no longer copy/paste results by hand (#58).
- The CH340 and PL2303 WebUSB drivers no longer silently drop bytes at 115200: bulk IN transfers are now kept queued so the chip's RX FIFO cannot overrun between reads, a loss that previously reported `status: "ok"` with no error anywhere (#59).
- The FTDI driver had the same overrun defect and got the same bulk IN transfer pipeline, taking the 16 KB loopback echo from 2 failures in 30 runs to 0 in 60 (#61).
- All three WebUSB drivers now select only bulk endpoints and fail with a clear diagnostic naming the claimed interface when a bulk pair is missing, instead of silently picking the wrong pipe on unusual layouts (#26, fixes #25).
- Pruned eight low-value analytics dimensions, merged the make/model pair into a single `radio` dimension, and dropped the `channel_edit` event outright (#62).

## 2026-08-07
- Clone attempts now report how they ended, not just that they were made: success carries the duration and channel count, failure carries the stage and a classified cause, which together give a per-driver success rate (#20).
- Uploads now report when CHIRP's own preflight blocked them and which column it rejected first, so a field users cannot get past shows up as a pattern rather than as scattered bug reports (#20).
- The boot, the browser's serial capability, radio selection, serial connect, file import/export, repeater queries, band-plan presets and the settings editor all report for the first time; previously only two events existed, both fired before anything ran (#20).
- Analytics now report only from codeplug.org, so dev servers and forks no longer land in the same property; off the production host nothing is requested from the vendor at all (#20).
- Added `npm run ga:dimensions`, which syncs the analytics property's custom dimensions from the app's own declarations, so a parameter added in code cannot silently collect nothing.
- Home-screen launches are now attributable and PWA installs are measured, and every hit carries the display mode the app was launched in (#53).
- Fixed the display mode never reaching analytics: it rode on a call GA4 does not carry custom parameters from (#54).
- The About page now reports to analytics; it never carried the tag, so its visits went uncounted (#53).

## 2026-08-02
- The app can now be installed to an Android or iOS home screen: a web app manifest, a generated 192/512/maskable/apple-touch icon set, and a theme-color status bar, so it launches standalone from the launcher (#52).
- Added a 🇬🇧 Query RSGB ETCC API action that turns a GPS fix into a list of nearby UK repeaters, nearest first; unlike the przemienniki.net and RepeaterBook imports it needs no CORS proxy, so it works on deployments where those two are disabled (#47).
- Binary `.img` files whose driver differs only by variant or alias now load: `Quansheng_UV-K5_egzumer.img` previously failed with `Unsupported model` because the matcher ignored `variant`, resolved to the wrong UV-K5 driver, and that wrong-but-resolved match suppressed the all-drivers fallback (#46).
- Deploys now run the full test suite and the Python syntax check before uploading, so a failing test leaves the live site up; the asset-retention step, which had been silently doing nothing since the move to codeplug.org, points at the right hostname again (#45).
- Asset retention is covered by tests driving the real script against a fake Pages site, so an unreachable host fails the deploy instead of retaining nothing while reporting success (#42).
- The channel view now shows its "No channels loaded" notice from first paint instead of only once the Pyodide runtime has finished booting.
- Dropped test stubs for DOM elements the page no longer has and pinned the remaining stubs to the selectors `web/js/ui/dom.js` declares; no user-visible change (#43).

## 2026-07-30
- Binary `.img` files that carry no CHIRP metadata trailer now load: when nothing identifies the driver up front, every driver is imported once per session so CHIRP's own byte-sniffing can detect the model — Yaesu FT-60/FT-817/VX-*, Baofeng UV-3R, Puxing, TYT TH-7800, Wouxun KG-UV8D and the Kenwood TK-* series all previously failed with `Unknown file format` (#28).
- Added an app-wide progress strip at the top of the Debug Output panel, so the ~20-second all-drivers load reports its progress instead of looking like a hang; the app now uses Arial throughout, keeping the debug log monospace (#41).
- Writing edited channels back to a radio or `.img` no longer corrupts power levels, duplex, or frequency precision — 113 of 248 upstream test images previously failed to re-export (#32, fixes #31).
- CSV export now matches desktop CHIRP's own export: a phantom channel 0 no longer appears on radios whose channels start at location 1, D-STAR channels are no longer dropped, and power is written in watts as CHIRP writes it (#36).
- Hovering a Power cell or the Power column header now shows what each driver power label is worth in watts, e.g. `Hi = 5.0W, L3 = 2.5W` (#37).
- The Quansheng TG-UV2+ now appears in the radio list and its images detect correctly; drivers that import pyserial at module scope no longer fail silently in the browser runtime (#38, fixes #29).
- The app now opens with an empty channel list and a "No channels loaded" notice instead of two example channels; the Load Sample button was removed (#40).

## 2026-07-28
- Added a native CH340/CH341 WebUSB driver, so the most common cheap programming cables now work on Android Chrome alongside the existing FTDI and PL2303 support (#24).
- The "Updated `<date>`" line under the title is now generated at build time from the newest heading in these release notes, instead of shipping a stale committed date (#23).

## 2026-07-27
- Dragging a CHIRP CSV or binary `.img` file anywhere onto the page now loads it, with the same replace-or-merge prompt as the Import CSV picker (#19).
- Virtualized the channel grid: insert/remove/move on a 500-channel codeplug now takes 2–9 ms instead of 2.0–3.7 s (#18).
- Fixed radio settings failing with `NameError` on drivers that call CHIRP's translation builtins, e.g. the Quansheng UV-K5 (#21).
- Capped the pre-filled "Report Bug" GitHub URL at the last 40 debug lines so GitHub no longer answers with HTTP 414 (#22).
- Split the 3,200-line `web/js/ui.js` into one module per UI area under `web/js/ui/`; no user-visible change (#16).

## 2026-07-24
- CSV import no longer silently destroys existing channels (#12, contributed by lanrat): importing a CSV while the editor holds real channels (a usable frequency or name — blank inserted rows don't count) now prompts with how many channels would be lost and how many the file contains, offering Replace (previous behavior), Merge (append the imported channels and renumber Locations), or Cancel. Escape or clicking outside cancels. Imports into an empty editor and the sample loader are unchanged. Internally `loadCsvText` split into a side-effect-free `parseCsvViaRuntime` plus `applyParsedCsv(mode)` so the promise-based prompt can sit between parsing and applying.
- The online repeater-query API base is now configurable per deployment (#14, contributed by lanrat). The przemienniki.net / repeaterbook.com actions fetch through a CORS proxy that was hardcoded to `api.codeplug.org`, whose allowlist only permits the `codeplug.org` origin — so forks hosted elsewhere hit 403 "Failed to fetch". The base now comes from a `<meta name="webchirp-repeater-api-base">` tag (defaulting to `api.codeplug.org`, so codeplug.org is unaffected); deployments with their own proxy point the tag at it, and setting `content=""` blanks the base and hides the two online-query menu items instead of offering actions that can only fail. Repeater-query tests are wired into `npm run test:channels`.
- Fixed unreadable, overlapping channel-table headers on desktop (#9, contributed by lanrat). `table-layout: fixed; width: 100%` compressed all 17 columns to fit the window, so each header spilled into its neighbor (e.g. "FrequenDuplex"). The table now keeps its natural width with no-wrap headers and scrolls horizontally at all viewport sizes, matching the existing mobile behavior; the media query keeps only the mobile-specific taller touch targets.
- Added a version-info line below the title showing the last-updated date and the pinned CHIRP revision. The "Updated `<date>`" text links to the release notes and the CHIRP SHA links to the pinned upstream commit.

## 2026-07-23
- Added channel copy, cut, and paste (#7, contributed by lanrat): available from the channel actions menu or via native Ctrl/Cmd+C/X/V. The clipboard format mirrors desktop CHIRP — tab-separated values with the canonical CSV header row — so channels round-trip with Google Sheets/Excel, other webchirp tabs, and desktop CHIRP itself. Selected channels can also be reordered with new Move Up/Down buttons (Alt+ArrowUp/ArrowDown). Two paste correctness fixes landed with it: values pasted into columns the radio marks read-only no longer silently reset to defaults (e.g. TStep on the UV-5R), and numeric enum columns now accept spreadsheet-normalized values ("5" for "5.00", "23" for "023"). New unit suites `scripts/test-clipboard.mjs` and `scripts/test-ui-channel-cut.mjs` run as part of `npm run test:channels`.
- Loading a binary `.img` codeplug now selects the radio make/model automatically from the image's own CHIRP metadata trailer (#15). Previously this failed with `Unsupported model` unless the matching driver happened to be imported already, because the browser runtime imports drivers lazily. The metadata (vendor/model/driver class) is parsed without importing any driver, matched against the static radio catalog (exact class name first, vendor/model fallback for unregistered base classes like `BaofengUV5R` → `BaofengUV5RGeneric`), and the matched driver is imported before CHIRP detection runs. CHIRP's `MODEL_COMPAT` renames are applied; unmatched images are logged to Debug Output.
- CSV and binary codeplug exports are now named `<brand>_<model>_<date>.<format>` instead of a generic filename.
- All tooltips now appear after a consistent 400ms hover delay.
- Added `npm run screenshots` to regenerate the repo screenshots (README, Open Graph, social preview) from the live app.
- Replaced the radio make/model search filter with an autocomplete suggestion dropdown.

## 2026-07-22
- Android now offers both connect paths when its native Web Serial is available (arriving for Bluetooth RFCOMM serial ports): "Connect via WebSerial" for Bluetooth serial ports and "Connect via WebUSB" for wired USB adapters, which Android's native Web Serial cannot drive. While connected, the two buttons collapse into a single Disconnect button matching the active transport. Desktop and WebUSB-only browsers keep their single-button behavior, and a serial-log hint explains the split when both paths are offered.
- Added WebUSB serial support for Android Chrome (#8): native chip drivers for FTDI (`web/js/ftdi-webusb.js`, FT231X/FT232R etc.) and Prolific PL2303 (`web/js/pl2303-webusb.js`, with per-generation chip detection from 01/HX/TA/TB through the HXN family), plus a CDC-ACM fallback via Google's lazily-imported `web-serial-polyfill`. A single WebUSB device chooser dispatches the chosen cable to the right driver, which exposes the Web Serial `SerialPort` surface so `BrowserSerialBridge` works identically over both transports. Hardware-verified on Android Chrome with FTDI and PL2303 cables completing real radio clone downloads; CH340/CP2102 are documented as unsupported.
- The UI now shows one connect button per platform: native Web Serial on desktop, WebUSB on Android (where `navigator.serial` exists but cannot drive FTDI/PL2303-class programming cables).
- Fixed a read-path deadlock in the WebUSB drivers: a `ReadableStream` `pull()` that resolved without enqueuing (status-only packet from an idle FTDI chip) was never re-invoked per the Streams spec, wedging all reads. Both drivers now poll inside `pull()` until real payload arrives and recover stalled bulk IN endpoints with `clearHalt`.
- Added `npm run test:serial` — 22 unit tests covering transport selection/fallback, FTDI baud-divisor vectors and init, status-byte stripping, the read-deadlock regression, PL2303 chip detection and init sequences, DTR/RTS transitions, and chooser dispatch.
- The site now deploys to GitHub Pages via a GitHub Actions workflow that builds `dist/` on push to master, with a custom domain (CNAME). Previous-generation hashed assets are retained across deploys so already-open tabs keep working after a release.

## 2026-07-21
- Radio make/model dropdowns now populate instantly from a prebuilt static catalog (`web/radio-catalog.json`) instead of booting Pyodide and importing every CHIRP driver on first load; live driver enumeration remains as a fallback.
- Added a `build:catalog` npm script (run automatically by `build:dist`) that regenerates the catalog from the local CHIRP submodule.
- Added a search box above the make/model dropdowns to filter radios by make or model.
- Fixed a pre-existing crash (`Duplicate radio driver id`) when selecting a radio: concurrent metadata/settings calls could re-execute a driver module while its lazy import was suspended fetching source. All Pyodide-backed runtime calls now run one at a time through a FIFO queue.
- The static radio catalog is only used when it was built from the exact CHIRP revision the runtime is pinned to; otherwise the app falls back to live driver enumeration. The pin is now a single shared constant and `build:catalog` fails on a submodule/pin mismatch.
- Typing in the radio search box no longer triggers a driver load per keystroke; the load is debounced until typing settles, skipped when the selection is unchanged, and stale responses can no longer overwrite a newer selection.
- Added a clone progress bar for radio download/upload (#10): CHIRP drivers' per-block `status_fn` reports are now forwarded through a new `serial_progress` global to a native `<progress>` bar in the Serial Bridge panel, showing the driver's phase message and a percentage (indeterminate when a driver reports no block counts), hidden when idle. Debug logging drops to one line per phase-message change instead of one per block.

## 2026-07-10
- Pinned the repo Node version back to 22.11.0 (from 25.2.1). Node 25 broke the `codex` CLI on startup (circular-dependency module warnings, then it failed to launch) whenever run in this directory. Verified the project still builds and passes checks on Node 22: `build:dist`, `test:channels` (8/8), `serialport` native addon load, and `runtime_bridge.py` compile all pass.

## 2026-07-03
- Added explicit relative favicon links to the app and About pages. Browsers only auto-discover `/favicon.ico` at the domain root, so deployments served from a sub-path (e.g. GitHub Pages project sites) showed no favicon; the explicit `./favicon.ico` reference works at any mount point.

## 2026-06-23
- Mobile-friendly UI pass (CSS only): the page now flows and scrolls vertically on phones (using `100dvh`) instead of being locked to the viewport, the toolbar wraps, primary controls have larger touch targets, the channel table is a bounded internal scroll area, the actions popup stays on-screen, and a new 560px breakpoint single-columns the serial actions and full-widths the view toggle. Desktop layout is unchanged.
- Mobile channel table: instead of compressing all 17 columns to fit the screen (unreadable, overlapping headers), the table now keeps its natural width with no-wrap headers and readable, tappable cells, and scrolls horizontally. The Location column stays compact.
- Made the Serial Bridge controls a collapsible `<details>` on mobile (a static heading on desktop) so the channel list isn't pushed down. The mobile channel view stays the horizontally-scrolling table (a card view was tried and reverted by preference). Desktop layout is unchanged.
- Added an automatic dark theme. All colors were tokenized into CSS custom properties and a dark palette is applied via `prefers-color-scheme: dark`, so the UI (including the About page) follows the operating-system light/dark setting. No JS and no markup changes — light and dark share one code path; light appearance is unchanged.

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
