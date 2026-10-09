# Findings

Non-obvious facts the code and tests do not record: upstream CHIRP defects we route around,
external API, browser and platform behaviour, measurements, and the reasons behind decisions.
Each entry starts with a **bold slug** (grep target; some are cited from code) and its discovery
date. If a comment, test or CLAUDE.md already states it, it does not belong here.

The CHIRP pin is `7a4123ad` (2026-10-07). Corpus counts were measured at `29592824` or earlier
and drift on each bump.

## CHIRP / Pyodide runtime

- **async-pyproxy-calls-behave-like-runPythonAsync** (2026-09-24): `pyodide.ffi.run_sync` inside a coroutine called through a `PyProxy` works exactly as under `runPythonAsync`, so `callPromising` is not needed. `pyodide.isPyProxy` does not exist in 0.27, which is why `rpc-dispatch.ts` duck-types on `destroy`.
- **no-jspi-browsers-lose-only-the-clone-path** (2026-09-24): also lacking JSPI: Firefox ESR. Triage: `run_sync` fails with `RuntimeError: WebAssembly stack switching not supported in this JavaScript runtime`; `pyodide.ffi.can_run_sync()` answers the same question from Python. Reproduce on Firefox by setting `javascript.options.wasm_js_promise_integration` to false. Firefox 152+ has both JSPI and native `navigator.serial`.
- **static-driver-catalog** (2026-06-23): unofficial mode never falls back to live enumeration because its releases register colliding classes in one registry; it reports the catalog unavailable instead.
- **f4hwn-release-archive-is-bundled-lazily** (2026-09-22): v4.3.0 to v4.3.2 shipped identical driver bytes. The drivers declare neither `_memsize` nor `match_model`, so WebCHIRP cannot build an offline image or detect a metadata-less image for them. Nobody has tested real-radio clones with them.
- **f4hwn-image-selection-is-required** (2026-09-23): all v5 releases share one vendor/model/class identity, so image metadata cannot identify the release; a successful load does not prove the user picked the right one.
- **upstream-tests-skip-power** (2026-07-29): CHIRP has no byte-level image round-trip test, and `test_brute_force.py::test_get_set_all`'s `assertEqualMem` (`chirp/tests/base.py`) skips `power` (`# FIXME`), so power round-trip bugs go unnoticed upstream (e.g. `ftm7250d.FTM7250Radio` swaps Hi and Low). `chirp/tests/driver_xfails.yaml` lists only brute-force xfails, so every image in `chirp/tests/images/` should detect and load cleanly.
- **idrp-never-registers** (2026-07-30): `idrp.IDRPx000V` has no `@directory.register` upstream, so it is missing from the catalog even in desktop CHIRP; the pyserial shim makes it import, not register.
- **blank-instances-misreport-state** (2026-03-14): `radio_cls(None)` is not a smaller parsed instance: `get_settings()` can throw on it, and `get_features()` can differ (power levels, `valid_bands` of `(0, 0)`). Derive anything feature-based from the session's image, never from a blank instance.
- **upstream-get-max-defect** (2026-03-14): `RadioSettingValueFloat.get_max()` has no `return` (`chirp/chirp/settings.py`), which is why float bounds fall back to `_max`.
- **parse-freq-negative-defect** (2026-07-30): upstream `chirp_common.parse_freq()` always adds the fractional part: `"-0.600000"` → +600000, `"-5.600000"` → −4400000. `to_MHz(float())` gets the sign right but truncates. Reject negative offsets before parsing (the grid's frequency regex has no sign for this reason).
- **a-python-loop-paints-only-when-it-yields** (2026-07-30): a loop that must show progress takes a callback and yields per iteration inside one RPC; do not split it into one RPC per item.
- **the-first-yield-moves-python-off-the-jspi-stack** (2026-09-26): in Chrome the per-import yield makes the 194-module sweep ~7× faster (~1.0 s vs ~6.9 s). One yield before the loop is enough and the yields cost nothing. Node shows no difference, so no test can catch a regression. Hypothesis: a dispatched call runs on a JSPI suspendable stack where every Wasm-to-JS call (each FS syscall) pays a stack switch, and the first `await` moves the rest onto the ordinary stack. Rule: a long synchronous stretch dispatched from JS yields once before it starts.
- **all-driver-import-mechanics** (2026-07-30): at the current pin every module imports, but keep the per-module skip reporting: grepping for `import serial` cannot judge importability (`hf90`/`tmv71_ll` import it inside functions).
- **transport-disconnect-events-name-different-things** (2026-08-24): a radio switched off behind a cable that stays connected fires no disconnect event on any transport; it shows up only as a clone timeout.
- **shim-owes-pyserial-return-values-not-just-methods** (2026-09-05): drivers consume `WebSerialPipe` return values, not just method names (issue #79). When auditing the shim, grep drivers for code that *uses* a return value, not for the method names.
- **framing-is-set-after-open-but-never-mid-clone** (2026-09-05, CHIRP `80d93fe5`): every `parity`/`stopbits`/`bytesize` assignment comes after the port opened but before the operation's first byte (`tg_uv2p`/`tk8180` two stop bits; `tk280`/`ft2800`/`tk760g`/`tk8102`/`hg_uv98` even parity; `ft450d` all four). Deliberately ignored: `xonxoff` (no driver assigns it), `rtscts` (only ever `False`), `tk3140`'s `pipe.databits` typo (dead on real pyserial too). Expect probe loops that reopen up to six times (`thd72`/`thd74`/`tmv71`, `ts480`/`ts590`, `tmd710`). `icf.start_hispeed_clone` switches to 38400 mid-clone for 11 Icom modules with `_can_hispeed = True`. `tmd710` formats `pipe.baudrate` with `%i`, so the pipe must be seeded from `BAUD_RATE`.
- **runtime-errors-cross-as-an-envelope** (2026-09-29): V8 formats `Error.stack` at construction, before a subclass sets `name`, so a `RuntimeCallError`'s stack still begins `Error: ...`; build its detail from the envelope, not from `stack`. `harness.runPython()` snippets bypass the dispatcher and reject with Pyodide's `PythonError` text; a test that wants the typed error calls `harness.rpc()`.
- **undecodable-memories-couple-download-to-erase** (2026-09-06): checking readability just before erasing is not enough, because upload rebuilds a fresh instance from the image and a one-off decode failure may not repeat; hence the numbers are recorded at extraction. Upstream renders error rows instead; we return `unreadableChannels`, because a placeholder row could be mistaken for a writable one.
- **offline-export-is-not-a-radio-image** (2026-09-07): an `.img` exported with no image on the session is built on a zeroed `_memsize` base and never saw the radio's settings, calibration or ident regions, so it must never back an upload or settings parse.

## Channel grid / CSV

- **csv-radio-is-not-a-round-trip-surface** (2026-07-30): `generic_csv.CSVRadio` is CHIRP's import/export vehicle, not a lossless staging format; a header-only CSV raises `InvalidDataError("No channels found")`, so never route the empty-grid schema through it.
- **power-labels-beat-watts-in-rows** (2026-07-30): rows carry power as the driver's label because 8 driver classes collapse distinct levels onto one watt string after 1-dp rounding (e.g. `retevis_rt21.RT619Radio`), and CHIRP itself shows labels except for `has_variable_power` radios. Radio writes are unaffected by band-keyed level lists: those drivers re-resolve power from frequency.
- **rows-not-bytes-for-round-trip** (2026-07-29): load→export rarely preserves image bytes (padding and unused regions move) even when every row is identical; compare rows field by field, treat byte-identity as a bonus.
- **grid-cost-is-option-lists** (2026-07-27): the virtualized `tbody` holds spacer rows, so DOM readers must select `tr[data-row-idx]`, never index `tbody.children`.
- **grid-width-comes-from-its-editors** (2026-09-08): never give one grid column `width: 100%`: it squeezes the others instead of letting the grid scroll.
- **markup-defaults-are-the-boot-state** (2026-08-02): `index.html` markup is what users see during Pyodide boot and after an `init()` failure, so every JS-toggled element's markup default must be its pre-runtime state.
- **cell-rules-live-in-python-only** (2026-10-09): measured in Chrome on the dev server, a committed cell's round trip is ~6 ms median (max ~14 ms over 20) once warm and ~67 ms for the first commit after selecting a UV-5R-family radio (radio built from zeroes) -- the only case over the 50 ms budget. Some driver messages map to no column (`Tx freq … out of supported range`): they reach Debug Output but highlight no cell. `normalize_rows` stays separate: it renders CSV export text through `import_logic`, a different job.
- **optional-fields-need-novalidate** (2026-09-14): any form with per-field opt-in (apply checkboxes) must be `novalidate` and validate ticked fields itself; jsdom has no constraint validation, so tests can only assert the attribute.

## Radio images (.img) & metadata

- **wrong-match-is-worse-than-no-match** (2026-07-23): since CHIRP 29592824 (2026-09-29) `CloneModeRadio.match_model()` returns False by default, so the all-drivers sweep only detects a metadata-less image through a driver that implements `match_model()` itself (h777, many Icom ic*/id*, external formats such as tk8160 .dat, thd72 .mc4, ft1d/ft70 ADMS). Any other metadata-less image fails even after the sweep; that is upstream's intent, not our bug.
- **image-corpus-measurements-need-fresh-runtimes** (2026-07-30): driver imports accumulate in one Pyodide session, so walking `chirp/tests/images/` in one runtime does not measure each image's own load path: measure per image, or import every driver once and assert the matcher resolves either CHIRP's own detection or nothing. Corpus counts (2026-09-14: 361 images, 108 without a trailer, the 253 with one all agreeing with detection) predate CHIRP 29592824; re-measure after every submodule bump.

## Repeater directories

- **rsgb-etcc-api-shape** (2026-07-31): `https://api-beta.rsgb.online` documents itself as HTML at `/`. Endpoints are `/<name>/<arg>`, and the arg is mandatory: leave it out and you get the HTML index. `/band/`, `/locator/`, `/callsign/`, `/keeper/` and `/all/<anything>` return `{"data":[…]}`. `/aprs/<call>` returns `{"callsign","passcode"}` without the wrapper.
- **rsgb-locator-lookup-is-not-a-prefix-search** (2026-07-31): about 26% of records carry only a 4-character locator, so an exact 6-character `/locator/` query misses about a quarter of the directory.
- **rsgb-record-semantics** (2026-07-31): `type` is an undocumented code. Use `tx == rx` to spot simplex stations instead. `dbwErp` is in dBW.
- **rsgb-has-no-lat-lon** (2026-07-31): `extraDetails.ngr` is an OS grid reference on OSGB36, so comparing it with a WGS84 fix needs a datum shift. Over the UK, a 6-character box is about 4.6 km N-S by 4.5–6 km E-W (not the equatorial 9.3 km). A 4-character centre can be about 70 km from the station.
- **coep-blocks-plain-cross-origin-images** (2026-08-17): under the dev server's COEP, a plain cross-origin `<img>` is blocked silently (`ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep`). Pages sends no COEP, so the failure only shows locally. A new cross-origin asset needs a CORS-mode load against an upstream that sends ACAO, or an upstream that sends `Cross-Origin-Resource-Policy: cross-origin`.
- **irts-api-mostly-matches-the-shared-rxf-contract** (2026-08-27): IRTS is api.codeplug.org's own route, not a proxy. It speaks the same RXF contract as the proxied directories and covers `ie` and `gb` (Northern Ireland included).
- **only-the-range-bounds-an-rxf-query** (2026-09-19): measured on RepeaterBook: an unfiltered query returned the whole directory (18.4 MB), `country=us` 10.1 MB and lat/lon/`range=30` returned 68 KB. Adding `country` to a position changed nothing, so only the range bounds the answer. A country-only query (even for the US) is still allowed on purpose, so small countries can be imported whole.
- **rxf-perspective-governs-ctcss-not-just-qrg** (2026-09-06): a perspective mistake in tone handling stays hidden whenever both tones are equal. That is how issue #103 slipped through.
- **repeater-record-modes** (2026-10-09): `REPEATER_MODES` is closed over the spellings the four sources were seen sending live. No source reports AM, so AM is left out. Recheck the live spellings before adding a mode.
- **one-repeater-row-builder** (2026-10-09): besides the fixture snapshot, parity with the retired builders was checked once, locally, against live answers. The data was przemienniki.net `country=pl` (646 entries), RepeaterBook within 80 km of New York, IRTS `ie` and `gb`, and RSGB IO82/IO83/IO91/IO93. It held except for the three known differences.

## WebUSB serial adapters

- **ch340-version-not-bcddevice** (2026-07-28): branch CH340/CH341 behaviour on the chip version (vendor request `0x5F`), never on USB `bcdDevice`: a 0x1a86:0x7523 cable reporting `bcdDevice 0xc233` still reports version 0x30/0x31.
- **loopback-cannot-verify-baud** (2026-08-15): to check a divisor on hardware, cross-wire a second adapter running at a known rate; a TX-to-RX jumper on one adapter cannot catch a wrong rate.
- **one-bulk-in-transfer-at-a-time-drops-bytes** (2026-08-17): FT232R measurement, the one not in the driver comments: with one transfer outstanding, 2 of 30 runs lost bytes (Pixel 10, Chrome 151, 115200). Failure rates are low, down to about 7% per run, so a clean run proves nothing: the fix rests on reproducing the loss plus the structural argument. A bare pump benchmark catches the loss less often than the full loopback suite.
- **driving-the-loopback-page-on-a-phone** (2026-08-17): chip defects show up on phones, which no CI covers. Rig: wireless adb (`adb pair <host>:<pairingPort> <code>`, then `adb connect <host>:<connectPort>`; the two ports differ, both come from `adb mdns services`, and pairing is advertised only while the dialog is open). `adb reverse tcp:8000 tcp:8000` serves `npm run dev`; `http://localhost:8000` is a secure context on Android, so WebUSB works without HTTPS. `adb forward tcp:9222 localabstract:chrome_devtools_remote`, then CDP: `Target.createTarget` (Chrome for Android has no `/json/new`), `Runtime.evaluate` with `userGesture: true` for `requestDevice()`, then `import()` the driver and loop `runLoopbackSuite`. One run takes about 21 s.
- **cp210x-requests-are-interface-addressed** (2026-08-19): WebUSB rejects an interface-recipient control transfer unless `index` names a claimed interface. Take the number from the descriptor: hardcoding 0 addresses the wrong port on CP2105/CP2108.
- **webusb-bulk-out-failures-do-not-reject** (2026-08-19): `transferOut()` resolves with `{status, bytesWritten}` and does not reject, so a bare `await device.transferOut(...)` treats stalled and short writes as success. Only CP2102 checks the result. FTDI, PL2303 and CH340 still use the unchecked form; fixing them needs a separate pass verified on hardware.
- **cp210x-holds-flow-control-in-a-block-nothing-resets** (2026-08-19): `IFC_ENABLE` disable/enable does not reset the `SET_FLOW` block, so handshaking and XON/XOFF left by a previous host driver persist into our session unless the block is rewritten.
- **baud-rate-is-latched-at-open** (2026-09-05): Web Serial has no in-place re-rate, and `getInfo()` does not report the rate. The only way is `close()` + `open()` on the same `SerialPort`, which needs no user gesture or chooser because permission belongs to the port object.
- **webusb-chip-ports-are-8n1-only** (2026-09-05): real framing support for the four chip drivers is per-chip encoding work (FTDI `SIO_SET_DATA`, PL2303 line coding, CH340 LCR, CP210x `LINE_CTL`) and needs hardware to verify; until then they declare `capabilities.framing: false`.
- **serial-transport-contract** (2026-10-07): get `SerialPortMock` from `serialport`'s re-export. `@serialport/binding-mock` is only a transitive dependency, so tests must not import it directly.

## Hosting & deployment

- **retention-deadlocks-a-cname-only-domain-move** (2026-09-19): when moving domains, set the new one out of band first and wait for the Pages API's `https_certificate.state` to read `approved` before landing the `CNAME` commit. Any other push to `master` in between redeploys the old `CNAME` and flips the domain back.
- **build-dist-hashes-dependency-first** (2026-09-08): esbuild code splitting is a correctness requirement, not an optimisation. `index.html` loads `analytics.ts`, `sentry.ts` and `install-prompt.ts` as entries and the app imports all three too, so without splitting each would run twice with two copies of its state (two gtag loaders, an `initSentry` whose SDK `captureError` never sees).
- **radio-specs-are-researched-not-generated** (2026-09-24): research rules for `radio-specs.json`. **Driver bands are not radio bands**: Chinese HT drivers accept wide ranges whatever the market version. **"Dual watch" is not dual receive**: only true second-receiver radios (Kenwood TH-D7x/TM-V71, Icom IC-W32/ID-51, Wouxun KG-UV8D/9D, Yaesu FT-8x00) are `true`. **Maker figures are often inflated**, so when sources conflict, leave the field null. Leave `min` power null when only a maximum is published. Do not cut a continuous range at conventional band edges, and check manuals for receive gaps (US cellular 824–894 MHz, Yaesu 729–800 MHz) that rigpix flattens. `1.25 m` means only 219–225 MHz or a set sold as a 220 rig; 200–260 MHz on unlocked Chinese HTs is `Other`.
- **esbuild-cut-the-module-waterfall** (2026-10-08): measured on the day it landed. dist/ went from 70 JS files (801,244 bytes) to 12 (486,618 bytes, plus 1.28 MB of maps that only devtools and Sentry fetch). `index.html` went from 66 same-origin JS requests at load (763,982 bytes) to 10 (460,432). The serial test page went from 13 to 3. `about.html` and the model pages went from 1 request to 2, with fewer bytes. Pyodide is not bundled from npm because the npm package resolves to 0.27.7 while `PYODIDE_INDEX_URL` serves 0.27.2's wasm and stdlib, and a loader must match its wasm. Minification also stays off because it would mangle the `constructor.name` that `assertSerialTransport` labels ports with.

## PWA / install

- **pwa-install-needs-no-service-worker** (2026-08-02): Chrome installs without a service worker (since 108 on Android, 112 on desktop). The manifest plus 192 and 512 icons is enough for a WebAPK, so do not add a pass-through worker. A worker would only buy deterministic caching, since a WebAPK uses Chrome's evictable HTTP cache. Doing that is real offline work: Pyodide and `web-serial-polyfill` come from jsDelivr, and it would have to fit the hashed-asset retention scheme.
- **installable-is-not-discoverable** (2026-09-18): headless Chrome on localhost fires `beforeinstallprompt`, which is why the Install button appears in `web/images/screenshot-narrow.png`.
- **webapk-start-url-changes-take-days** (2026-08-05): a `start_url` change takes a day or more to reach installed apps. Chrome re-reads the manifest about once a day and then queues a WebAPK re-mint, and until then hits carry the old `dl`. Check `location.href` in the running app first, and use a fresh install to confirm the manifest.

## Analytics

- **the-second-production-domain-is-apex-only** (2026-09-19): `codeplug.org` 301-redirects to `webchirp.org`. Neither `www.codeplug.org` nor `www.webchirp.org` resolves (NXDOMAIN, rechecked 2026-10-09). To serve `www.webchirp.org`, add the DNS record and the entry on both `ANALYTICS_HOSTS` and `SENTRY_HOSTS` together. The `api.codeplug.org` CORS allowlist lives on the server and can't be tested from here. It matches exact origins (scheme included, `Vary: Origin`), accepts `https://codeplug.org` and `https://webchirp.org`, and rejects both `www` names. A `www` host would therefore send telemetry while every repeater query failed.
- **pwa-traffic-needs-a-marker-on-every-hit** (2026-08-03): GA4 ignores custom parameters set with `gtag("set", …)`, so they must ride on each event. A unit test can pin the gtag call shape but not the payload. To verify for real, inspect the collect URL's `ep.*` params over `chrome://inspect`. GA sends custom params whether or not they are registered, so a param missing there was never attached. Headless Chromium ignores emulated `display-mode`.
- **ga-custom-dimensions-are-syncable** (2026-08-04): `ga:dimensions` checks `displayName` locally because Admin API creates run one at a time with no rollback. Turning the measurement ID into a property ID needs account-level visibility, hence `--property`.
- **ga-event-scoped-slots-are-a-one-way-budget** (2026-08-07): EVENT-scoped dimensions are capped at 50, and a dimension's `parameterName` and scope can never change. Prefer adding a dimension to an event that already fires over minting a new event.
- **browser-brand-takes-two-sources-and-an-async-probe** (2026-09-08): browser and OS are not declared as custom dimensions because GA has them built in.

## Error reporting (Sentry)

- **sentry-tracing-is-not-a-call-graph, and profiling cannot work here** (2026-09-06): tracing records SDK-instrumented spans (page load, fetches, interactions): "what took how long", never "who called whom". Only profiling (`browserProfilingIntegration`) gives sampled call stacks, and it needs the JS Self-Profiling API, which browsers expose only under a `Document-Policy: js-profiling` HTTP header. There is no `<meta>` equivalent and GitHub Pages headers are fixed, so profiling is impossible short of leaving Pages. The error stack trace is the practical substitute; Sentry fetches the public linked source maps itself (nothing is uploaded).
- **sentry-metrics-are-a-second-pipeline, not a second kind of event** (2026-09-08): in `@sentry/browser` 10.x, `Sentry.metrics.*` ride the trace pipeline but don't need tracing enabled. The SDK batches them (1000 items or a 5 s idle flush), so a metric recorded during page unload can be lost.
- **metrics-inherit-the-transport-and-nothing-else** (2026-09-08): errors get browser/OS from the default `httpContextIntegration`, but metrics skip event processors. With `sendDefaultPii: false`, Sentry's server-side UA/IP inference is `"never"`. So every dimension a metric needs (`browser`, `platform` included) has to be attached explicitly.

## GitHub PR gotchas

- **pr-refs-go-stale** (2026-07-22): a PR's `base.sha` is fixed at creation, and `headRefOid` can stop syncing after pushes. Fix it by retargeting the base and back (`gh pr edit N --base <other>`, then `--base master`). `GET /repos/{owner}/{repo}/compare/master...<head>` always shows the true diff. Debug in this order: `git ls-remote`, then the compare API, then `headRefOid`.

## Test suite

- **test-support-is-the-shared-fixture-home** (2026-09-06): when a shared fixture almost fits, add an option or a subclass rather than copying it.
- **ui-tests-run-on-index-html-in-jsdom** (2026-10-09): why jsdom, what it costs, and traps the support code does not already explain:
  - **Choice**: on three converted files (median of five, M1 Pro) jsdom 29.1.1 and happy-dom 20.14.5 cost about the same CPU (1.07/2.08/1.21 s vs 1.08/2.15/1.31 s), but happy-dom failed two bulk-edit tests. jsdom 30.x is out: its `engines` excludes Node 25.
  - **Cost**: importing jsdom is ~270 ms wall / ~400 ms CPU per test process (a compile cache saves only ~50 ms); parsing the page ~60 ms per file, resetting it ~3.5 ms per test. The ui-* wall time (~17 s) is bound by ui-repeater-modal's real-timer debounce waits (~14.5 s), not the DOM.
  - **Traps**: a disabled button ignores `click()` (index.html ships Download and Upload disabled); `emit()` reads `defaultPrevented` synchronously like a browser, so a `preventDefault()` after an `await` fails; never dispatch both at the element and at a delegating ancestor (the handler runs twice now that events bubble).
- **suites-are-directories-not-lists** (2026-09-09): when moving test files in bulk, also grep string literals: some tests pass module paths to a dynamic `import()`, and fixture sources built as strings in `tests/build/build-dist.mjs` must stay relative to their temp dir.
- **browser-tests-run-on-dist-as-pages-serves-it** (2026-10-09): `npm run test:e2e` takes ~13 s locally, ~9 s of it `build:dist`; Pyodide and the CHIRP archive arrive in about a second on a good connection.
  - Pyodide is fetched at startup, not on the first radio selection (`ui.init()` loads the default schema through Python), despite what the timeout comment in `playwright.config.mjs` says. The grid header is no sign a radio's driver answered, because the default schema already fills it.
  - Headless Chromium at `http://127.0.0.1` is a secure context exposing `navigator.serial`, `.usb` and JSPI; `about:blank` exposes none.
  - Passing page-side steps as source works because Node's type stripping and Playwright's loader both leave `Function.prototype.toString()` as plain JavaScript.
  - With a 1,000-channel codeplug at 1400x900 the grid kept 38 rows in the DOM.
- **v8-coverage-omits-files-no-test-loaded** (2026-09-08): `--test-coverage-include` does not force-load unimported modules. When coverage "goes up", check the file count too.
- **two-coverage-denominators-and-why** (2026-09-08): anything that reports a coverage percentage must say which denominator it uses (every physical line vs code lines only).
- **v8-line-coverage-counts-comments-and-blanks** (2026-09-08): Node's lcov emits a `DA` record for every physical line, comments and blanks included, so the JS line % is not statement coverage and is not comparable with coverage.py's Python figure. Branch and function % are unaffected.
- **jspi-needs-no-flag-on-node-25** (2026-10-09): Node 25.2.1 has JSPI on by default, and all four suites also pass unflagged on Node 26.8.2.
  - Proof the clone path uses JSPI: `node --no-experimental-wasm-jspi tests/channels/clone-baud-plumbing.mjs` fails `run_sync` with `RuntimeError: WebAssembly stack switching not supported`; unflagged it passes.
  - **V8 flags given to `node --test` do not reach the per-file child processes**, so the old flag on `test:channels`/`test:settings` was always a no-op. To disable a V8 feature for a test, run the file directly.

## TypeScript and type checking

- **sources-are-typescript-run-by-stripping** (2026-10-09): what the conversion taught:
  - Node's stripping replaces annotations with whitespace, so line/column numbers are unchanged and V8 coverage measures the `.ts` files with no source map (coverage figures moved by tenths of a point). dist/ kept its shape: 12 JS files, ~460 KB.
  - **`node --check` does not reliably strip types**: under `"type": "module"` it parses as CommonJS first and retries as stripped ESM only when the first error looks like module syntax, so a file whose first error is a type annotation fails. Hence `check:syntax` covers only `.mjs`.
  - `rewriteRelativeImportExtensions` is the alternative to `allowImportingTsExtensions` only for a project that compiles to `.js`.
  - The JSDoc-to-TypeScript codemod ran on a throwaway `typescript@5.9` install, because TypeScript 7 has no JavaScript API.
  - Under `useDefineForClassFields`, redeclaring an inherited property (an `Error` subclass's `name`) shadows the prototype's, so inherited properties are not redeclared.
  - JSDoc was looser at the edges: a `{}` default, an `[]` inferring `never[]`, and a trailing parameter JSDoc treated as optional all needed real types.
  - Dead code left alone: `web/js/ui/serial-actions.ts` logs `IDENT ${result.ident}` after a download, but no Python download result carries `ident`.
- **tsc-runs-two-projects-because-node-types-are-global** (2026-10-08): `scripts/tsconfig.json` includes only `web/js/types/browser-globals.d.ts`, because including `web/js/types/` whole pulls in `ui-context.d.ts`, and through it every UI module, into the Node check.
- **typescript-7-ships-tsc-as-a-native-binary** (2026-10-08): `typescript@7` is the Go port with no JavaScript API. The `typescript` package is a launcher; the compiler and its `lib.*.d.ts` live in a per-platform optional dependency (`@typescript/typescript-<platform>`), so an install with `--omit=optional` has no `tsc`. Look for lib files under `node_modules/@typescript/`, not `node_modules/typescript/lib`.
- **strict-landed-with-the-typescript-conversion** (2026-10-08): under JSDoc, `noImplicitAny` would have been ~1700 errors. `tests/` is excluded from tsc because, checked under the scripts config, it has hundreds of errors, nearly all where fakes stand in for DOM and USB types.
- **strict-null-checks-found-declarations-not-defects** (2026-10-09): the 238 distinct errors were cleared at 87 sites, mostly declarations (one variable typed `null` caused up to 20 errors) and guards. No reachable crash turned up: every null was already prevented by a caller or the platform. Rule: a value non-null by an invariant is passed down as a parameter rather than asserted at each use.
- **pyodide-types-come-from-a-newer-npm-patch** (2026-10-08): the `pyodide` npm dependency resolves to 0.27.7 while the CDN pin is 0.27.2, so the types the `tsconfig.json` `paths` mapping supplies are a patch release away from the module the browser loads.

## Process

- **dom-elements-are-a-checked-contract** (2026-07-27): don't put `?.`/`if (!el)` guards on DOM lookups; they hide removed markup. Leftover drift: `serialTxRx` in `RUNTIME_METHODS` (`web/js/runtime-rpc.ts`) has no caller, and its `#serial-transaction` markup is gone.
- **python-reachability-is-not-a-python-grep** (2026-09-09): before calling a `webchirp_bridge` function unused, grep the whole tree, `.mjs` included: test `runPython` snippets reach helpers by name (e.g. `_power_label_map_for_radio` is called only from `tests/channels/channel-round-trip.mjs`). After deleting a function, re-read the seam: a partial delete once left an orphaned tail after the previous function's `return`, and neither `compileall` nor pyright flags unreachable code.
- **worktree-needs-submodule-init** (2026-07-27): a fresh worktree has an empty `chirp/`, so every Pyodide-backed test fails with `Invalid CHIRP source dir`, which looks like a regression. `git submodule update --init` is fast because it reuses `.git/modules/chirp`.
- **worktree-borrows-the-parent-node_modules** (2026-09-24): worktrees under `.claude/worktrees/` resolve `node_modules` by walking up to the parent checkout. A probe script must live inside the worktree (one in `/private/tmp` gets `ERR_MODULE_NOT_FOUND`), and a dependency bump in the parent changes what every worktree tests against.
- **asdf-python-unset** (2026-07-23): `python3` depends on the machine having an asdf Python; the fallback is `/usr/bin/python3 -m compileall -q web/python`. Adding python to `.tool-versions` is not free, because the workflows feed that file to `actions/setup-node`.

## api.codeplug.org /cities (gazetteer)

`GET /cities?q=<prefix>[&lat=&lon=]` returns `{ query, results: [{ id, name, region, country, cc, lat, lon, population?, kind, score }] }`.

- **cities-no-filters** (2026-09-13): there is no country filter: `cc` and `country` are ignored. `limit` is capped at 20, which is also the default.
- **cities-cors** (2026-09-13): `http://localhost:<port>` origins are allowed, unlike on `/przemienniki` and `/repeaterbook`.

## api.codeplug.org /lookup (per-callsign position)

- **lookup-cors** (2026-09-16): allows `https://codeplug.org` and any `http://localhost:<port>` or `http://127.0.0.1:<port>`. Other origins, `https://jasiek.github.io` included, get HTTP 403 with an empty body rather than a response that lacks the CORS header.

## Cost of previewing a repeater query

- **preview-cost** (2026-09-13): measured: `api.codeplug.org/przemienniki` costs one request of about 9 kB (30 km) to 15 kB (100 km) and takes about 210 ms. An RSGB `/locator/<square>` takes about 290 ms per square (about 76 kB).

## Country licensing guides

The coverage audit is `LICENSING_RESEARCH_SUMMARY.md`. Guide data is in `licensing-*.json` at the repo root.

### Sources and stale facts (2026-09)

- **licensing-input-list**: the analytics country export (81 places plus `(not set)`) is only a list of inputs; `(not set)` cannot get a page.
- **licensing-no-society**: where no national society website can be verified (e.g. Myanmar's BARTS no longer exists per the IARU directory), say so and link the IARU directory. Never invent one.
- **licensing-cept-vs-tr6101**: CEPT membership and T/R 61-01 visitor operation are separate facts (`licensing-cept.json` records both). A visitor right depends on the licence class and is not a resident licence.
- **licensing-stale-sources**: these older sources must not be used for new applicants (the guide data holds the current facts):
  - Poland: UKE fee pages from before 2026-05-01.
  - Mexico: IFT (now an archive; CRT handles it). The 2026 CRT lineamientos were only a consultation draft.
  - France: forms showing the €46 tax (removed 2019).
  - Japan: the ¥5,100 4th-class exam fee (¥5,700 from 2026-10-01; the guide names both dates).
  - China: the repealed 2012 rule.
  - Vietnam: the older RFD regional process.
  - Singapore: visitor-licence fees or times for resident applications.
  - Moldova: the ANRCETI procedure.
  - Taiwan: NCC pages saying the application window is 1 year (it is 10).

### Research tooling (2026-10)

- **research-reddit-blocked**: WebFetch, curl, the in-app browser and Claude in Chrome all refuse reddit.com (in Chrome it is a safety rule, not a site permission). boards.ie, Whirlpool and funkbasis need a login or bot check. First-hand reports are mostly on national-language boards and blogs (URE foro, zendamateur.com, s5tech.net, naaran.com, vocus.cc, onair.jp, Naver blogs, f4mby.fr), and most Latin American and Asian ones in Facebook groups; cite those only when public, because the Chrome profile is signed in.
- **research-websearch-budget**: WebSearch allows about 200 calls, which parallel agents exhaust in minutes. Google in Chrome has no budget and supports `tbs=cdr:1,cd_min:1/1/2025` for 2025+ results, so it is better for forum reports. Google indexes very few 2025+ first-hand posts in Ukrainian, Baltic languages, Kazakh or Kyrgyz.
