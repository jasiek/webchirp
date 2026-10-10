This repository hosts a browser-based CHIRP interface (`web/`) that executes CHIRP Python code in Pyodide and communicates with radios via Web Serial.

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
- `web/js/ui/`: One module per UI area — `channel-table`, `settings-panel`,
  `radio-catalog`, `radio-session`, `repeater-query`, `codeplug-io`,
  `serial-actions`, plus the shared `dom`, `state`, `debug-log`, `issue-report`,
  `format`, `analytics` and `channel-values` helpers. `radio-session` owns the
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
  `state.radioSession`. `channel-values` holds only the row and
  column-metadata types. `repeater-query` is one modal shell for every
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
  `radio_memories`, `radio_settings`, `column_metadata`,
  `images`, plus `jsbridge` (JS-boundary helpers), `runtime_errors` and `rpc`
  (the `RPC_METHODS` table and `rpc_dispatch`). `__init__.py` only installs
  the shims CHIRP needs before import. No embedded Python in JS files.
- Offline use: `web/sw.ts` is the service worker. `build-dist` bundles it to an
  unhashed `dist/sw.js` at the root, and `web/js/offline.ts` registers it
  (built site only, never the dev server). Its logic is in
  `web/js/offline-cache.ts`. A page load, and any file whose name does not
  change with its content, comes from the network first, falling back to the
  cache after `NETWORK_TIMEOUT_MS`. Hashed files and pinned CDN files are
  served from the cache first. After each page load the worker caches the
  build that `asset-manifest.json`'s `offline` section describes: the root
  pages and `OFFLINE_DATA_FILES` with their digests, every immutable name, and
  `OFFLINE_CDN_URLS` (`web/js/cdn-urls.ts`, the one home of the jsDelivr URLs).
  The new build replaces the current one only once every file is cached. A
  new file the app fetches at runtime under a fixed name belongs in
  `OFFLINE_DATA_FILES`, and a new CDN dependency in `cdn-urls.ts`. Offline
  analytics (`offline_ready`, `offline_cache_failed`, `offline_launches`)
  is sent from `offline.ts`. A launch the worker answered from the cache
  cannot be sent at the time, so it is counted in localStorage and reported
  by the next page the network serves. That page's other events are queued
  the same way (`deferAnalytics` / `replayDeferredAnalytics` in
  `web/js/analytics.ts`, newest `REPLAY_LIMIT` kept) and replayed with
  `delivery: "offline_replay"`.
- `chirp/`: Upstream CHIRP source as a git submodule. The runtime never reads it
  file by file: `scripts/build-chirp-bundle.ts` (`npm run build:chirp`, run by `dev`
  and `build:dist`) zips the pinned `chirp/chirp` package -- minus `wxui`, `cli`,
  `sources`, `locale`, `share` and `stock_configs`, which nothing imports -- into the
  ignored `web/chirp/chirp-<pin>.zip` with a `chirp-<pin>.json` manifest (pin, driver
  module list, sizes). `seedPyodideRuntime()` (`web/js/python-sources.ts`) mounts it
  with `pyodide.unpackArchive` under `/webchirp_runtime`, so every `chirp.*` import is
  a plain file import that never suspends the interpreter; the driver list everywhere
  comes from the manifest. The Node harness (`tests/support/chirp-bundle-source.mjs`)
  builds the same archive in-process from the submodule.
- `tests/`: The node:test suite, one directory per suite — `channels` and
  `settings` boot Pyodide (the clone tests use JSPI, which Node 25 has on by
  default: no flag), `webusb` and `build` do not. `manual` holds the two tests npm test never
  runs (`rsgb-live` needs the network, `hw-radio` needs a radio on a serial
  port). `support` holds shared fixtures and the two harnesses, not tests.
- `scripts/`: Build, coverage and CLI tooling only. No tests live here.
- `scripts/build-dist.ts` (`npm run build:dist`) builds the Pages tree. The
  entry points are the module scripts and stylesheets the HTML pages load, and
  esbuild bundles them: ESM with code splitting, unminified, linked source maps,
  and every JS output in `dist/js/` named `name.<hash>.js`. Pages are pointed at
  their outputs through esbuild's metafile. Runtime Python files are copied as
  `name.<sha256:10>.py`, and the bundle gets their URLs from a generated
  replacement for `web/js/runtime-python-urls.ts`. The CHIRP archive pair and
  every other file are copied as they are. The jsDelivr modules (Pyodide,
  Sentry, web-serial-polyfill) stay external. `scripts/retain-deployed-assets.ts`
  knows both hashed name shapes.
- The browser code and the tooling are TypeScript (`web/app.ts`,
  `web/js/**/*.ts`, `scripts/*.ts`); `tests/` stays `.mjs` and imports the `.ts`
  modules. Nothing compiles them: Node runs them by stripping the types, the
  dev server (`scripts/dev-server.ts`, `npm run dev`) answers a request for a
  `.ts` file with that file type-stripped by esbuild's transform API
  (`text/javascript`, inline source map) and serves everything else static,
  and `scripts/build-dist.ts` bundles them with esbuild. Pages load their `.ts`
  entries by name (`<script type="module" src="./app.ts">`); no `.js` request
  is mapped onto a `.ts` file.
- `tsconfig.json` (browser code, lib.dom, no Node types) and
  `scripts/tsconfig.json` (tooling, with `@types/node`, plus `allowJs` for the
  `tests/support` modules the scripts import) are the two projects
  `npm run check:js` runs, both with `strict` on: every parameter is typed, a
  null-initialised variable carries its `T|null` type, and a value that can be
  null is checked before use rather than cast. A caught value is `unknown`;
  read its fields through `errorFields()` (`web/js/error-details.ts`).
  `web/js/types/browser-globals.d.ts` declares the
  browser APIs lib.dom lacks (Web Serial, WebUSB, Web Bluetooth, JSPI, gtag);
  `web/js/types/ui-context.d.ts` names every member of the UI `ctx`.

### Test conventions
- `tests/e2e` is the browser suite: Playwright (`playwright.config.mjs`),
  Chromium only, against `dist/` built by `npm run build:dist` and served by
  `scripts/dev-server.ts` in its Pages mode (`WEB_ROOT=dist SERVE_AS=pages`).
  Run it with `npm run test:e2e` after a one-time
  `npx playwright install chromium`. `npm test` and coverage leave it out on
  purpose (`NON_SUITE_DIRS` in `scripts/coverage.ts`): it needs the browser
  and the network, because Pyodide comes from jsDelivr. CI runs it in its own
  workflow (`.github/workflows/e2e.yml`). Drive the app with the page-side
  steps in `scripts/app-driver.ts`, which `scripts/update-screenshots.ts` uses
  too, and route any third-party API to a fixture with `page.route()`.
- Each suite is globbed, not listed: `npm run test:channels` runs
  `tests/channels/*.mjs`. **Adding a test is dropping a file into a suite
  directory — never edit `package.json` for it.** `scripts/coverage.ts`
  discovers the same directories, and fails if a suite exists that no npm
  script runs.
- Name a test for what it covers, without a `test-` prefix; the directory
  already says it is a test (`tests/channels/channel-list.mjs`).
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
  Dispatch at the element a user would touch and let it bubble; never set an
  event's `target`. A module handed a partial `ctx.dom` gets index.html's
  elements through `pageElement(name)`; an element the page lacks is created
  explicitly by the test, with a comment saying why. jsdom does no layout, so
  the channel grid renders every row under test; windowing is covered by the
  browser tests.

### UI module conventions
- Each module is a `create<Area>(ctx)` factory. `ctx` carries `dom`, `state`,
  `log`, `actions` and every constructed sibling module.
- Keep state private to the module that owns it; expose accessors instead.
  `web/js/ui/state.ts` is only for state that genuinely spans modules.
- Call siblings through `ctx` (`ctx.table.render()`) or `ctx.actions`, never by
  importing them — that keeps the module graph free of cycles. Such calls must
  happen after construction, never in a factory body.
- Modules bind their own DOM listeners in a `bindEvents()`; `ui.ts` only binds
  what no single module owns.
- Query document elements in `web/js/ui/dom.ts`, not in feature modules.

## Rules for Agents
- Keep Python and JavaScript separated. Put runtime Python code in
  `web/python/webchirp_bridge/*.py`; a new module must be listed in `RUNTIME_PYTHON_FILES`
  (`web/js/python-sources.ts`) so it is seeded into Pyodide; its URL follows from that
  list (`web/js/runtime-python-urls.ts`, which the dist build replaces with the hashed
  URLs). The module graph must stay acyclic; call across modules by importing, never
  through the globals.
- A new RPC method is a function registered in `RPC_METHODS`
  (`web/python/webchirp_bridge/rpc.py`) and listed with its parameter names in
  `RPC_METHODS` (`web/js/rpc-dispatch.ts`); `tests/channels/rpc-contract.mjs` fails when
  the two disagree. JS calls it by name with named parameters -- never by evaluating a
  Python expression string or writing an interpreter global. Nothing else in the package
  is callable from JS. Test snippets (`harness.runPython`) see the package flattened into
  the globals by `tests/support/bridge_namespace.py`; production code never does.
- Prefer generic, parameterized flows based on selected CHIRP driver/module/class.
- Do not reintroduce radio-specific RPC methods when generic selected-radio methods can be used.
- Preserve debug visibility: full errors/tracebacks should be logged to the bottom debug panel.
- Newly added functions need a comment as to what they do and why.
- Sources are TypeScript with erasable syntax only (`erasableSyntaxOnly`), so
  Node and the dev server run them by stripping types: no `enum` (use an
  `as const` object), no `namespace`, no constructor parameter properties, and
  an import used only as a type is `import type` (`verbatimModuleSyntax`).
  Relative imports name the `.ts` file (`import { x } from "./y.ts"`), because
  Node resolves the specifier as written; `allowImportingTsExtensions` lets tsc
  accept it. New exported functions have typed signatures (parameters and
  return type). An explicit `any` belongs only where data arrives untyped --
  JSON from Python, the network or a file, a Pyodide proxy -- with a comment
  saying so; prefer a real type, then `unknown`.
- Nothing in the dist build reads comments: esbuild resolves the imports and
  the page rewrite touches only the `src`/`href` of the tags that load a module
  or stylesheet. So the old rule about spelling module paths in comments (and
  its test) is retired.
- Python functions must have type signatures.
- An import used only in annotations goes under `if TYPE_CHECKING:` so it adds no
  runtime dependency; every module has `from __future__ import annotations`, which is
  what makes that safe. Type radio-shaped parameters with the CHIRP class, not `Any`.
- Avoid context pollution by spawning sub-agents when appropriate.
  - Use sub-agent sandboxing when a read-only task is to be executed.
  - Use sub-agents to produce a summary for a commit message.
- Whether a radio's firmware can be updated is not in the catalog and cannot be:
  no CHIRP driver knows it. `radio-firmware.json` (repo root) records it by hand,
  keyed by vendor with `vendor|model` overrides, and `scripts/build-model-pages.ts`
  turns it into a section on each model page. Never state a claim more strongly than
  its evidence: a vendor-level answer points at that vendor's download page, and only
  a model-level entry promises a download for that model. Record `unknown` rather than
  guessing; an unknown radio gets no section. Adding a vendor to the catalog without
  an answer fails `tests/build/radio-firmware.mjs`.
- When you discover something new, or unexpected, put it in FINDINGS.md.
- Analytics goes through `trackEvent` in `web/js/ui/analytics.ts`; never reach
  `gtag` directly. Every parameter an event sends must be declared in
  `CUSTOM_DIMENSIONS` (`web/js/analytics.ts`) or GA collects it and shows it
  nowhere, and never send user data — no file names, channel names, frequencies,
  search terms or coordinates.
- When on a worktree other than the master branch run a dev server on a port other than 8000.
- Avoid regressions in clone workflow:
  - Download should record the image on the selected radio's session.
  - Upload should use the session's image and fail clearly if the session holds
    none that came from the radio or a file (a synthetic export never counts).
  - Prepare serial session before clone operations (buffer clear, control lines, settle delay).

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
- This is currently hosted on GitHub Pages = we can't set custom http headers on files, and can't control cache time.
- We do not aim to support screen readers at this time.

## Change Process
- Use a worktree unless told otherwise, you may need to check out submodules.
- Raise a PR unless told otherwise.
- Commit after every change.
- Keep commits small and scoped to one functional fix/refactor when practical.
- Include clear commit messages that describe user-visible behavior or architectural impact.
- Never include agent session ID links in any commit message.
- If model is other than Anthropic/OpenAI, add a Co-Authored-By: <model name and parameters> at the end of the commit message
- Never use backticks (`) anywhere in any generated command to execute.
- Never modify RELEASE_NOTES.md when on a branch. When on master, update RELEASE_NOTES.md based on PRs which were merged in with current date. Each entry is a single line: the user-visible change plus the PR number, no multi-sentence detail. At the same time run `npm run screenshots` to regenerate images/screenshot.png, images/screenshot-for-opengraph.png, and web/images/social-preview.png from the current version of the app. When generating a screenshot, query the RSGB API channels for locator IO82MM. When you do this, also consolidate/update FINDINGS.md so that it is always up to date.

## Code Review
- If you are an OpenAI agent, use Astra Medium when performing code review.
- If you're an Anthropic model, use Fable Medium.
- Always post a response to each comment when you receive feedback.

# PR Behaviour
- When submitting a PR, in the PR description include any new dependencies which were added.

## Validation
Before committing, run syntax checks, typechecking and all tests.
`npm test` covers syntax (`check:syntax`, `node --check` over the `.mjs`
tests; tsc parses the `.ts` sources), Python types (`check:types`, pyright),
TypeScript types (`check:js`, tsc with `strict` over both projects) and the four
automatic suites.


