This repository hosts a browser-based CHIRP interface (`web/`) that executes CHIRP Python code in Pyodide and communicates with radios via Web Serial, WebUSB or Web Bluetooth. It is served at https://webchirp.org/ and wrapped as an Android app (`android/`).

## Core Architecture
- `web/app.ts`: Browser entry point: wires the UI, the runtime RPC client and
  the browser serial bridge together.
- `web/js/runtime-rpc.ts`: Main-thread runtime RPC layer and Pyodide bootstrap.
- Serial layer: `web/js/serial-transport.ts` declares the port contract every
  transport satisfies (Web Serial's surface plus `transport`, `capabilities` --
  framing, signals, reopen-or-update reconfigure -- `usbDevice` and
  `onDisconnect`, which reports `{transport, port}` once per loss);
  `assertSerialTransport()` checks it at open. Implementations: the four WebUSB
  chip drivers on `web/js/webusb-transport.ts`, the CDC polyfill wrapper in
  `web/js/webusb-serial.ts`, `web/js/native-serial-port.ts` (wraps, never
  patches, native Web Serial), `web/js/webbluetooth-serial.ts`, and
  `tests/support/node-serial-port.mjs` for node-serialport. One `SerialBridge`
  (`web/js/serial-bridge.ts`, no DOM or navigator) owns buffering, clone
  preparation, re-rating and reconfigure for both environments, given a
  transport factory: `web/js/serial.ts` adds the browser chooser,
  `tests/support/radio-harness.mjs` the tty. `web/js/serial-globals.ts`
  installs the `serial_*` globals Python imports (declared in
  `web/python/typings/js.pyi`) for both. A transport that cannot do something
  declares it in `capabilities`; the bridge never probes.
  `tests/webusb/serial-transport-conformance.mjs` runs one set of cases against
  every implementation -- a new transport joins its table.
- `web/js/ui.ts`: Composes the UI modules and exposes `createUiController()`.
- `web/js/ui/`: One module per UI area — `channel-table` (with its
  `channel-bulk-edit` and `channel-extra` modals), `settings-panel` (with
  `setting-fields` and `setting-values`), `radio-catalog`, `radio-session`,
  `repeater-query` (with `query-fields` and `repeater-sources`),
  `repeater-map` and `static-map-view` (the static OSM maps), `codeplug-io`,
  `serial-actions`, `install-button` and `connectivity`, plus the shared `dom`,
  `state`, `debug-log`, `progress`, `notice-modal`, `issue-report`, `format`,
  `analytics`, `metrics` and `channel-values` helpers. `radio-session` owns the
  runtime session handle behind the selected radio: selecting a radio opens a
  session, changing it closes the old one and opens the next, an image load
  hands over the session the runtime opened for the image's driver, and every
  radio-bound runtime call carries the session's id. A load's response is
  applied only while its handle is still `state.radioSession` -- identity, not
  a counter, is what discards a stale load. The grid applies no column rules
  of its own: every value written into a row -- a committed cell, a paste, a
  bulk edit, a row builder's write -- goes to the `normalize_and_validate_rows`
  RPC, one call per batch, which stores it by the radio's rules and runs the
  driver's per-row check (`submitRowEdits`, `previewRowEdits` and `buildRows`
  in `channel-table`). A committed cell shows the typed value marked
  `is-pending` until the answer arrives, and an answer is applied only while
  the row is at the version it was sent at and its session is still
  `state.radioSession`. `repeater-query` is one modal shell for every
  repeater directory: its form is assembled per source from the field
  components in `query-fields.ts` (which build their own DOM), driven by the
  `RepeaterDirectoryAdapter`s registered in `createRepeaterAdapters`
  (`repeater-sources.ts`). Every directory normalizes into one
  `RepeaterRecord` (`web/js/repeater-record.ts`: integer-Hz output and
  input, modes from a closed list, CTCSS/DCS tone per direction, position)
  before anything else sees it; one parser per wire format feeds it (RXF:
  `parseRxfRecords` in `web/js/rxf.ts`, also behind the hover map's callsign
  lookup; RSGB JSON: `rsgbToRepeaterRecord` in `web/js/rsgb.ts`), and one
  builder, `buildRepeaterRows` (`web/js/repeater-rows.ts`), makes every
  directory's rows. **Adding a directory is writing a parser into
  `RepeaterRecord` and registering an adapter** (its fields and a
  `query(values, purpose)` returning records) -- never a row builder, and
  never a second record shape; `tests/channels/repeater-adapters.mjs` holds
  each adapter to the record invariants, so give the new one a fixture there.
- `web/python/runtime_bridge.py`: Entry point of the Python runtime. It is executed (not
  imported) into Pyodide's globals and binds exactly one name there, `rpc_dispatch`
  (`web/python/webchirp_bridge/rpc.py`): the single callable JS uses, taking a method
  name, one JSON object of named parameters and an optional callback. It never raises
  an `Exception` back: it returns a JSON envelope, `{"ok": true, "result": ...}` or
  `{"ok": false, "error": {type, bases, module, message, traceback, js}}` built by
  `rpc_error_envelope`. `web/js/rpc-dispatch.ts` is the JS side of that contract and
  the only place that calls it; it throws a failed envelope as a `RuntimeCallError`
  (`web/js/runtime-errors.ts`) named after the Python class, with the message alone as
  its message. Classify runtime failures by type with `isPythonError(error, "ClassName")`
  (which also matches subclasses), never by searching error text; print
  `errorDetails()` (`web/js/ui/format.ts`) to the debug panel, which carries the traceback.
- `web/python/webchirp_bridge/`: The runtime logic, one module per concern —
  `chirp_loader` (driver imports from the mounted CHIRP tree, driver enumeration), `serial_pipe`
  (pyserial stand-in over Web Serial), `session` (the `RadioSession` dataclass
  and registry: the radio the user is working on, with its clone image and
  the image's origin, the class detection resolved to and the channels that
  would not decode; `open_session`/`close_session` are RPC methods, every
  radio-bound RPC method takes a `session_id` and resolves it once at its
  entry point, and every helper below takes the `RadioSession`, which is
  also the only thing that builds a radio instance from its state --
  `radio_instance()`, `describing_instance()`, `features()` -- and records
  one back with `record_radio()`), `clone` (download/upload over the serial
  port), `radio_files` (the file detour CHIRP needs to parse or serialize an
  image, and the blank constructor), `channel_rows`, `power_levels`,
  `row_normalization` (the one implementation of the grid's column rules,
  `normalize_cell`), `row_validation` (the upload preflight and the per-edit
  `normalize_and_validate_rows`, which share the per-row `_row_findings`),
  `radio_memories`, `radio_settings`, `channel_extra` (a driver's per-channel
  settings behind the grid's Extra column), `column_metadata`,
  `images`, plus `jsbridge` (JS-boundary helpers), `runtime_errors` and `rpc`
  (the `RPC_METHODS` table and `rpc_dispatch`), and the `workarounds`
  package (see Rules for Agents). `__init__.py` only installs
  the shims CHIRP needs before import.
- Offline use: the service worker (`web/sw.ts`, logic in
  `web/js/offline-cache.ts`, registered by `web/js/offline.ts` on the built
  site only) caches each deploy whole from `asset-manifest.json`'s `offline`
  section. A file the app fetches at runtime under a fixed name must be added
  to `OFFLINE_DATA_FILES` (`scripts/build-dist.ts`): anything missing from
  that section breaks only offline, which no online page load reveals.
- `chirp/`: Upstream CHIRP source as a git submodule. The runtime never reads it
  file by file: `npm run build:chirp` (`scripts/build-chirp-bundle.ts`, run by `dev`
  and `build:dist`) zips the pinned package into the ignored
  `web/chirp/chirp-<pin>.zip` with a `chirp-<pin>.json` manifest, which
  `seedPyodideRuntime()` (`web/js/python-sources.ts`) mounts; the driver list
  everywhere comes from the manifest. The Node harness
  (`tests/support/chirp-bundle-source.mjs`) builds the same archive in-process.
- `tests/`: The node:test suite, one directory per suite — `channels` and
  `settings` boot Pyodide, `webusb` and `build` do not. `manual` holds the two tests npm test never
  runs (`rsgb-live` needs the network, `hw-radio` needs a radio on a serial
  port). `support` holds shared fixtures and the two harnesses, not tests.
- `scripts/`: Build, coverage and CLI tooling only. No tests live here.
- `scripts/build-dist.ts` (`npm run build:dist`) builds the Pages tree with
  esbuild (its header comment describes the output). A change to how outputs
  are named also changes `scripts/retain-deployed-assets.ts`, which knows both
  hashed name shapes.
- The browser code and the tooling are TypeScript; `tests/` stays `.mjs` and
  imports the `.ts` modules. Nothing compiles them: Node strips the types, the
  dev server strips each `.ts` request with esbuild, and `scripts/build-dist.ts`
  bundles them. Pages load their `.ts` entries by name.
- `tsconfig.json` (browser code, no Node types) and `scripts/tsconfig.json`
  (tooling, with `@types/node`) are the two projects `npm run check:js` runs,
  both `strict`. A value that can be null is checked before use rather than
  cast; read a caught value's fields through `errorFields()`
  (`web/js/error-details.ts`).
  `web/js/types/browser-globals.d.ts` declares the
  browser APIs lib.dom lacks (Web Serial, WebUSB, Web Bluetooth, JSPI, gtag);
  `web/js/types/ui-context.d.ts` names every member of the UI `ctx`.

### Test conventions
- `tests/e2e` is the browser suite: Playwright (`playwright.config.mjs`),
  Chromium only, against `dist/` built by `npm run build:dist` and served by
  `scripts/dev-server.ts` in its Pages mode (`WEB_ROOT=dist SERVE_AS=pages`).
  Run it with `npm run test:e2e` after a one-time
  `npx playwright install chromium`; `npm test` leaves it out. Drive the app with the page-side
  steps in `scripts/app-driver.ts`, which `scripts/update-screenshots.ts` uses
  too, and route any third-party API to a fixture with `page.route()`.
- Shared fakes belong in `tests/support/`; import from there before writing
  a new one.
- A file in a suite directory is executed by the runner, so a helper with no
  tests in it goes in `tests/support/`, not beside its callers.
- UI tests run on the real page: `installIndexPage()`
  (`tests/support/index-page.mjs`) loads `web/index.html` into jsdom once per
  test file and resets it between tests, and installs `window`, `document`,
  `navigator` and the DOM constructors as globals; options add window,
  navigator or global stubs, a `url` (`?radio=`), or another page under
  `web/`. Drive it like a user with `tests/support/ui-interactions.mjs`
  (`dispatch`/`emit`, which also await async listeners, `selectRadioBySearch`,
  `importSampleCsv`, `clickLocationButton`, `setLayout`, `setInputFiles`...).
  Dispatch at the element a user would touch and let it bubble. A module
  handed a partial `ctx.dom` gets index.html's elements through
  `pageElement(name)`; an element the page lacks is created
  explicitly by the test, with a comment saying why. jsdom does no layout, so
  the channel grid renders every row under test; windowing is covered by the
  browser tests.

### UI module conventions
- Each module is a `create<Area>(ctx)` factory. `ctx` carries `dom`, `state`,
  `log`, `actions` and every constructed sibling module.
- Keep state private to the module that owns it; expose accessors instead.
  `web/js/ui/state.ts` is only for state that genuinely spans modules.
- Calls to siblings through `ctx` happen after construction, never in a
  factory body.
- Modules bind their own DOM listeners in a `bindEvents()`; `ui.ts` only binds
  what no single module owns.

## Rules for Agents
- Python modules call each other by importing, never through the globals. Test
  snippets (`harness.runPython`) see the package flattened into the globals by
  `tests/support/bridge_namespace.py`; production code never does.
- Prefer generic, parameterized flows based on selected CHIRP driver/module/class.
- Do not reintroduce radio-specific RPC methods when generic selected-radio methods can be used.
- Generic code never names a radio. Before treating a driver as a special
  case, ask whose rule it breaks: a driver using something CHIRP's own API
  allows (`"empty"` in `Memory.immutable`, `ExternalMemoryProperties`) is
  handled once in generic code, for every driver that does it. Only a driver
  that breaks CHIRP's own contract -- an upstream defect -- gets a workaround:
  - It lives in `web/python/webchirp_bridge/workarounds/`, one submodule per
    CHIRP driver module, named after it (`workarounds/uv5r.py`), naming the
    affected classes inside. Each submodule is listed in
    `RUNTIME_PYTHON_FILES` like any runtime module.
  - Generic code calls it only through a hook that `workarounds/__init__.py`
    defines and dispatches. A hook matches the radio's class MRO by module and
    class name, so a subclass inherits its parent's workaround and checking
    imports no driver. A new kind of workaround adds a hook there, never an
    `if` on a module, class, vendor or model at the call site.
  - Each one cites its FINDINGS.md entry (slug and CHIRP pin), and has a test
    in `tests/channels/` that runs the unpatched driver and fails once
    upstream fixes it, so a pin bump removes the workaround. Fix it upstream
    too where practical and link the CHIRP PR.
  - Shims for what Pyodide lacks (`serial_pipe`, the pre-import shims in
    `webchirp_bridge/__init__.py`) are not workarounds and stay where they
    are.
- Preserve debug visibility: full errors/tracebacks should be logged to the bottom debug panel.
- Avoid context pollution by spawning sub-agents when appropriate.
  - Use sub-agent sandboxing when a read-only task is to be executed.
  - Use sub-agents to produce a summary for a commit message.
- `radio-firmware.json` (repo root) records by hand whether a radio's firmware
  can be updated (no CHIRP driver knows it), keyed by vendor with `vendor|model`
  overrides. Never state a claim more strongly than its evidence: a vendor-level
  answer points at that vendor's download page, and only a model-level entry
  promises a download for that model. Record `unknown` rather than guessing.
- When you discover something new, or unexpected, put it in FINDINGS.md and
  nowhere else. CLAUDE.md holds instructions only: no findings, triage notes
  or explanations of why something happened.
- Analytics never sends user data — no file names, channel names, frequencies,
  search terms or coordinates.
- Sentry filtering (`web/js/sentry.ts`) drops an error in code only when it is
  never a defect and can be recognised by its class, where it was raised, or
  the browser. An error that only its wording tells apart from a defect stays
  reported, and is archived in Sentry if it is a known circumstance.
- `web/privacy.html` is the privacy policy Google Play requires of the Android
  app. A change to what the app collects, stores on the device or sends, or to
  where it sends it, updates that page and its effective date in the same PR;
  a new destination also goes into `tests/build/privacy-policy.mjs`.
- Avoid regressions in clone workflow:
  - Download should record the image on the selected radio's session.
  - Upload should use the session's image and fail clearly if the session holds
    none that came from the radio or a file (a synthetic export never counts).
  - Upload and binary export both run `runUploadPreflight(session)` first, for
    the session they then write to, and stop when its answer is `stale`: a
    value the driver refuses blocks them as a highlighted cell, never as a
    runtime error.
  - Prepare serial session before clone operations (buffer clear, control lines, settle delay).
  - When `SerialBridge` gives up a port for any reason other than `close()`,
    call `_losePort()`, never `_teardown()` alone. It reports `onPortLost`
    once, before awaiting the transport's close; that report is the only way
    the UI learns the port is gone.
  - Show a port chooser only from the click that asks for it, before that
    handler's first await: Connect calls `BrowserSerialBridge.choosePort()`,
    and `open()` takes the port it picked. Never make a chooser wait on the
    runtime call queue.

## Agent CLI
- For agent-operated real-radio reads, use `npm run radio:read -- --port <path> --module <driver_module> --class <driver_class> --format json|csv|img --output <file>`.
- For agent-operated real-radio writes, use `npm run radio:write -- --port <path> --module <driver_module> --class <driver_class> --format json|csv|img --input <file>`.
- Prefer `--format json` when the workflow needs rows, settings, normalized CSV, and binary image in one file.
- `--format img` means a CHIRP `.img` clone file and is clone-image only; expect it to fail clearly on radios that do not expose clone-mode image workflows.
- These commands aren't meant for the end user, they are for testing and development only.

## UI Expectations
- Make/model options must be sourced from CHIRP driver sources.
- Session status should be concise; detailed diagnostics belong in Debug Output.
- Keep controls and labels task-oriented and explicit.

## Other considerations
- webchirp.org is served by Cloudflare Pages. `.github/workflows/pages.yml`
  deploys the same `dist/` to GitHub Pages too, and which host answers for the
  domain is chosen in jasiek/webchirp-hosting (with the DNS, the Pages project
  and Cloudflare Web Analytics), not here. Until the GitHub Pages deploy is
  removed the site must work on either host, so nothing may depend on a custom
  HTTP header, a redirect rule or a cache lifetime, none of which GitHub Pages
  can set.
- `web/.well-known/assetlinks.json` is the Digital Asset Links statement for the
  Android app. Its fingerprints must include the Play App Signing key's
  SHA-256, not only the upload key's.
- Code that must behave differently inside the Android app asks
  `runsInAndroidApp()` (`web/js/android-app.ts`), never the user agent or
  `document.referrer`.
- `android/` is generated by Bubblewrap from `android/twa-manifest.json`; never
  edit the generated files by hand. `android/README.md` is the procedure for
  changing and releasing the app. Signing keys never enter the repository.
- We do not aim to support screen readers at this time.

## Change Process
- Use a worktree unless told otherwise, you may need to check out submodules.
- Raise a PR unless told otherwise.
- Commit after every change.
- Keep commits small and scoped to one functional fix/refactor when practical.
- Include clear commit messages that describe user-visible behavior or architectural impact.
- If model is other than Anthropic/OpenAI, add a Co-Authored-By: <model name and parameters> at the end of the commit message
- Never use backticks (`) anywhere in any generated command to execute.
- When on master, update RELEASE_NOTES.md based on PRs which were merged in with current date. Each entry is a single line: the user-visible change plus the PR number, no multi-sentence detail. At the same time run `npm run screenshots` to regenerate images/screenshot.png, images/screenshot-for-opengraph.png, web/images/social-preview.png and the two install-dialog screenshots, web/images/screenshot-wide.png and web/images/screenshot-narrow.png, from the current version of the app. When you do this, also consolidate/update FINDINGS.md so that it is always up to date.

## Code Review
- If you are an OpenAI agent, use Astra Medium when performing code review.
- If you're an Anthropic model, use Fable Medium.
- Always post a response to each comment when you receive feedback.

## Validation
Before committing, run `npm test` (syntax, pyright, tsc and the four suites).
Code conventions are enforced by tests rather than listed here:
`tests/build/source-conventions.mjs` (TypeScript), `tests/build/python-conventions.mjs`
(runtime Python) and, on a pull request, `scripts/check-pull-request.ts`. Each
failure names the file and line and says what to do.
