# webchirp 📻

Prototype for running parts of [CHIRP](https://github.com/kk7ds/chirp) in the browser with a CHIRP-like UI.

# This is live and running on [codeplug.org](https://codeplug.org)

![](images/screenshot.png)

## What is implemented

- `chirp` is included as a git submodule at `chirp/`
- Browser UI with a CHIRP-inspired **Channels** table and a **Settings** editor,
  switchable with tabs.
- Python runtime in-browser (Pyodide) running unmodified CHIRP driver code.
- Radio picked by searching CHIRP's driver catalog — including the alternate
  vendor/model names a driver is rebadged under — served from a prebuilt static
  catalog (`web/radio-catalog.json`) with live enumeration as a fallback. The
  sidebar names the radio in use.
- Selection-aware **Download Radio** / **Upload Radio** using the selected CHIRP
  clone-mode driver (`sync_in`/`sync_out`), with the clone image cached per driver.
- Radio settings read and validated through the selected driver
  (`get_radio_settings` / `validate_radio_settings`).
- Channel editing: insert / remove / move, copy / cut / paste, plus GMRS, FRS,
  and PMR446 band-preset generators.
- Repeater imports from external data sources (RepeaterBook, Przemienniki).
- CSV import/export and CHIRP `.img` clone-file import/export, all round-tripped
  through CHIRP Python code.
- Web Serial bridge (browser serial in JS, called from Python in Pyodide) with a
  WebUSB fallback path (FTDI / PL2303 / CH340 / CP2102 chip drivers) for
  browsers without native Web Serial.
- Upload preflight that validates edited rows before any bytes are written.

## Run the prototype

From the repository root:

```bash
npm run dev
```

Open [http://127.0.0.1:8000/](http://127.0.0.1:8000/).

Serial access requires a browser with Web Serial support and a secure context
(`http://localhost` works).

There are two connect buttons:

- **Connect** uses native Web Serial when available, otherwise WebUSB.
- **Connect via WebUSB** forces the WebUSB path. Use this when native Web Serial
  exists but cannot drive your adapter — notably Chrome on Android, which now
  exposes `navigator.serial` but only supports a limited set of devices (not
  FTDI/PL2303-class USB UART chips). There is no way to detect this in advance,
  hence the explicit button.

Over WebUSB a single device chooser is shown and the selected adapter is
dispatched to a chip-specific driver:

- **FTDI** adapters (FT231X, FT232R, ...) use a built-in FTDI-over-WebUSB
  driver, verified end-to-end on Android Chrome with an FT231X cable and a
  Baofeng UV-5R.
- **Prolific PL2303** adapters use a built-in PL2303-over-WebUSB driver that
  detects the chip generation (01/HX/TA/TB and the newer HXN family:
  GC/GB/GT/GL/GE/GS) and applies the matching init and register map. Also
  verified end-to-end on Android Chrome.
- **WCH CH340/CH341** adapters use a built-in CH340-over-WebUSB driver that
  reads the chip version to pick the right register map and probes for the
  clone-silicon prescaler quirk. Enumeration and baud/line configuration are
  verified against a real adapter; a full clone against a radio has not been
  exercised yet, so the bulk read path is still untested.
- **Silicon Labs CP2102** adapters use a built-in CP2102-over-WebUSB driver
  that reads the part number to pick the right baud generator, disables every
  handshake and byte transformation the chip can do on its own, and is the one
  WebUSB driver that can also *read* the input control lines. Verified on
  Android Chrome against a real CP2102 cable. Its scope is the **single-UART**
  parts that speak the vendor protocol — CP2101/2/3/4/9 and CP2102N; the
  multi-UART CP2105/CP2108 are turned away, and the **CP2102C** enumerates as
  USB CDC-ACM so it is handled by the polyfill path below instead.
- **USB CDC-ACM** devices are dispatched to Google's `web-serial-polyfill`.
  This path is wired up but untested — most radio programming cables are not
  CDC-ACM.
- Other vendor-specific UART bridges are **not supported** over WebUSB; they
  need chip-specific drivers that have not been written yet (see
  `web/js/ftdi-webusb.js`, `web/js/pl2303-webusb.js`, `web/js/ch340-webusb.js`
  and `web/js/cp2102-webusb.js` for the pattern) and still require native Web
  Serial on desktop.

`npm run dev` serves with cross-origin isolation headers (`COOP`/`COEP`) so
Pyodide synchronous JS bridging can use `SharedArrayBuffer` without warnings.

For radio cloning:

1. Type your radio's make, model or the name it is rebadged under into
   `Search radios` and pick it from the suggestions. The sidebar's
   `Selected radio` readout names what the rest of the app will act on.
2. Click `Connect` (baud is prefilled when available from selected driver).
3. Click `Download Radio` to read channels into the table.
4. Edit values and click `Upload Radio` to write back.

## Command-line codeplug read/write

You can read or write a real-radio codeplug from the command line using the same
runtime bridge (`web/python/runtime_bridge.py`) and local CHIRP source loading
path used by the Node tests. This is the intended agent-facing CLI for scripted
radio access.

From the repository root:

```bash
npm run radio:read -- --port /dev/ttyUSB0 --module uv5r --class BaofengUV5R --format json --output /tmp/uv5r.json
npm run radio:write -- --port /dev/ttyUSB0 --module uv5r --class BaofengUV5R --format json --input /tmp/uv5r.json
```

Optional flags:

- `--baud 9600` to override the driver's default baud.
- `--chirp-dir /path/to/chirp` (or `WEBCHIRP_CHIRP_DIR=/path/to/chirp`) to load CHIRP sources from a custom directory.
- `--serial-timeout-s 2.0` to override serial read timeout used by the runtime bridge.

Supported formats:

- `--format json`: read/write a JSON object containing `rows`, `headers`, `csvText`, `settings`, and binary `imageBase64`.
- `--format csv`: read/write CHIRP-normalized CSV text.
- `--format img`: read/write CHIRP `.img` clone files.

The flow is:
1. Open serial on the selected port.
2. `radio:read` runs `download_selected_radio(module, class)` and caches the clone image in runtime before writing the requested output format.
3. `radio:write` reads JSON/CSV/IMG input and uploads it through `upload_selected_radio(...)`; `.img` input is first loaded through CHIRP image detection so the cached image and selected driver stay aligned.
4. Disconnect serial.

## Hardware E2E CLI test (read then write same codeplug)

The older live smoke test still exists:

```bash
npm run test:hw -- --port /dev/ttyUSB0 --module uv5r --class BaofengUV5R
```

Use `radio:read` / `radio:write` for deterministic agent workflows and
format-specific codeplug files.

## Adapter loopback test (no radio needed)

`web/serial-test.html` checks a USB-serial adapter and the driver behind it —
FTDI, PL2303, CH340, the CDC polyfill or native Web Serial — by writing bytes
and requiring them straight back. Bridge **TX to RX** on the adapter, then open
the page (`npm run dev`, then http://localhost:8000/serial-test.html). It is
not linked from the app: it is a bench tool, not a user feature.

It cannot verify baud rate — both directions clock off the same divisor, so a
wrong one still echoes perfectly. The same cases run against fake hardware in
`npm run test:webusb`, with no adapter attached.

## Architecture

- Entry point / wiring: `web/app.js` connects the UI controller, runtime RPC
  client, and serial bridge.
- UI controller: `web/js/ui.js` (channel table, settings editor, clipboard,
  status/debug panels).
- Serial bridge: `web/js/serial.js` (native Web Serial) with WebUSB chip drivers
  in `web/js/ftdi-webusb.js`, `web/js/pl2303-webusb.js`,
  `web/js/ch340-webusb.js` and `web/js/cp2102-webusb.js`.
- Main-thread runtime RPC client + Pyodide bootstrap: `web/js/runtime-rpc.js`
  (runs on the main thread — there is no Web Worker).
- Python source providers: `web/js/python-sources.mjs`.
- Versioned Python runtime code: `web/python/runtime_bridge.py`.
- Browser runtime loads CHIRP source files into Pyodide from jsDelivr (revision-pinned).
- Command-line runtime can load CHIRP source files from a local directory:
  - `WEBCHIRP_CHIRP_DIR=/path/to/chirp npm run test:channels`
- Core CHIRP files preloaded into Pyodide (see `CORE_CHIRP_RELATIVE_FILES` in
  `web/js/python-sources.mjs`):
  - `chirp/__init__.py`, `chirp/errors.py`, `chirp/util.py`, `chirp/memmap.py`
  - `chirp/chirp_common.py`, `chirp/directory.py`, `chirp/settings.py`
  - `chirp/pyPEG.py`, `chirp/bitwise_grammar.py`, `chirp/bitwise.py`
  - `chirp/drivers/generic_csv.py`, `chirp/drivers/h777.py`
  - Any other driver module is fetched on demand when its radio is selected.

## Important scope note

The file-backed workflows (CSV, `.img`, settings) run unmodified CHIRP Python
logic in the browser and are the most exercised paths.

Live browser serial executes the selected CHIRP clone-mode driver
(`sync_in`/`sync_out`) through a generalized pyserial-like bridge, and has been
verified end-to-end (e.g. Baofeng UV-5R). Compatibility with any given radio
still depends on that driver's expectations and on browser transport limits, so
treat an untested radio as unverified.

## Sequence diagram (sketch) of how it all works

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant UI as ui.js
  participant RPC as runtime-rpc.js
  participant SRC as python-sources.mjs
  participant PY as runtime_bridge.py<br/>(Pyodide)
  participant S as serial.js<br/>(Web Serial / WebUSB)
  participant R as Radio

  Note over UI,S: app.js wires the UI controller, main-thread RPC client, and serial bridge

  U->>UI: Open page
  UI->>RPC: listRadios()
  alt Static catalog matches pinned CHIRP revision
    RPC->>RPC: Load web/radio-catalog.json
  else Missing / stale
    RPC->>SRC: listDriverModules() + seedPyodideRuntime()
    SRC-->>RPC: Driver module list + runtime bridge source
    RPC->>PY: list_registered_radios(...)
    PY-->>RPC: radios[]
  end
  RPC-->>UI: Load searchable radio catalog

  U->>UI: Search for and select a radio, click Connect
  UI->>RPC: serialConnect(baudRate)
  RPC->>PY: webserial_connect(baud)
  PY->>RPC: serial_open(...)
  RPC->>S: handleSerialRpc("open")
  S-->>R: Open serial port (Web Serial or WebUSB)
  S-->>RPC: connected
  RPC-->>UI: connected/status

  U->>UI: Click Download Radio
  UI->>RPC: downloadSelectedRadio({module, className})
  RPC->>PY: ensure_radio_module(module)
  RPC->>PY: download_selected_radio(module, className)
  PY->>RPC: serial_prepare_clone(...)
  RPC->>S: prepareClone(DTR/RTS, settle)
  S-->>R: Set control lines + settle
  S-->>RPC: prepared
  loop sync_in() serial exchange
    PY->>RPC: serial_write_bytes / serial_read_bytes
    RPC->>S: writeBytes / readBytes
    S-->>R: TX/RX bytes
    R-->>S: TX/RX bytes
    S-->>RPC: bytes
    RPC-->>PY: bytes
  end
  PY->>PY: Cache image in LAST_IMAGE_BY_DRIVER
  PY-->>RPC: rows + headers + settings
  RPC-->>UI: Populate editable Channels table + Settings editor

  U->>UI: Edit channels/settings, click Upload Radio
  UI->>RPC: validateRowsForUpload({rows, module, className})
  RPC->>PY: validate_rows_for_upload(...)
  PY-->>RPC: valid + issues

  alt Preflight invalid
    RPC-->>UI: Block upload + highlight invalid cells
  else Preflight valid
    UI->>RPC: uploadSelectedRadio({module, className, rows, settings})
    RPC->>PY: ensure_radio_module(module)
    RPC->>PY: upload_selected_radio(module, className, rows, settings)

    alt Cached image exists
      PY->>PY: Apply edited rows + settings to cached image
      PY->>RPC: serial_prepare_clone(...)
      RPC->>S: prepareClone(...)
      loop sync_out() serial exchange
        PY->>RPC: serial_write_bytes / serial_read_bytes
        RPC->>S: writeBytes / readBytes
        S-->>R: TX/RX bytes
        R-->>S: TX/RX bytes
        S-->>RPC: bytes
        RPC-->>PY: bytes
      end
      PY->>PY: Refresh cached image
      PY-->>RPC: uploaded=true
      RPC-->>UI: Show upload success
    else No cached image
      PY-->>RPC: Error: download required first
      RPC-->>UI: Show clear failure in Debug Output
    end
  end

  Note over UI,PY: The RPC client logs full stack traces to Debug Output on runtime errors

```
