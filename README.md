# webchirp 📻

Prototype for running parts of [CHIRP](https://github.com/kk7ds/chirp) in the browser with a CHIRP-like UI.

# This is live and running on [codeplug.org](https://codeplug.org)

![](images/screenshot-2026-02-21.png)

## What is implemented

- `chirp` is included as a git submodule at `/Users/jps/github/webchirp/chirp`
- Browser UI with a channel-memory table inspired by CHIRP
- Python runtime in-browser (Pyodide) running CHIRP code (`generic_csv` driver)
- CSV import/parse via CHIRP Python code
- CSV export/normalization via CHIRP Python code
- Web Serial bridge (browser serial in JS, called from Python in Pyodide)
- Python-driven TX/RX serial transaction path (`serialConnect`, `serialTxRx`)
- Radio make/model dropdowns populated from CHIRP driver source files
- Selection-aware download/upload actions using selected CHIRP clone-mode driver

## Run the prototype

From `/Users/jps/github/webchirp`:

```bash
npm run dev
```

Open [http://127.0.0.1:8000/](http://127.0.0.1:8000/).

Serial access requires a browser with Web Serial support and a secure context
(`http://localhost` works).

`npm run dev` serves with cross-origin isolation headers (`COOP`/`COEP`) so
Pyodide synchronous JS bridging can use `SharedArrayBuffer` without warnings.

For radio cloning:

1. Choose `Radio make` and `Radio model` from dropdowns (loaded from CHIRP sources).
2. Click `Connect` (baud is prefilled when available from selected driver).
3. Click `Download Radio` to read channels into the table.
4. Edit values and click `Upload Radio` to write back.

## Hardware E2E CLI test (read then write same codeplug)

You can run a command-line end-to-end clone test against a real radio using the
same Python runtime bridge (`web/python/runtime_bridge.py`) and filesystem CHIRP
source provider used by Node tests.

From `/Users/jps/github/webchirp`:

```bash
npm run test:hw -- --port /dev/ttyUSB0 --module uv5r --class BaofengUV5R
```

Optional flags:

- `--baud 9600` to override the driver's default baud.
- `--chirp-dir /path/to/chirp` (or `WEBCHIRP_CHIRP_DIR=/path/to/chirp`) to load CHIRP sources from a custom directory.
- `--serial-timeout-s 2.0` to override serial read timeout used by the runtime bridge.
- `--reboot-delay-ms 5000` to wait between download and upload (useful when radios need reboot time after programming mode).

The flow is:
1. Open serial on the selected port.
2. Run `download_selected_radio(module, class)` (caches image in runtime).
3. Run `upload_selected_radio(module, class, downloaded_rows)` to write back unchanged data.
4. Disconnect serial.

## Architecture

- Frontend: `/Users/jps/github/webchirp/web/index.html` + `/Users/jps/github/webchirp/web/app.js`
- Main-thread runtime bridge: `/Users/jps/github/webchirp/web/js/runtime-rpc.js`
- Python source providers: `/Users/jps/github/webchirp/web/js/python-sources.mjs`
- Versioned Python runtime code: `/Users/jps/github/webchirp/web/python/runtime_bridge.py`
- Browser runtime loads CHIRP source files into Pyodide from jsDelivr (revision-pinned).
- Command-line runtime can load CHIRP source files from a local directory:
  - `WEBCHIRP_CHIRP_DIR=/path/to/chirp npm run test:channels`
- Core CHIRP files preloaded into Pyodide include:
  - `/chirp/chirp/__init__.py`
  - `/chirp/chirp/chirp_common.py`
  - `/chirp/chirp/directory.py`
  - `/chirp/chirp/drivers/generic_csv.py`
  - and required dependencies (`errors.py`, `util.py`, `memmap.py`)

## Important scope note

This MVP proves in-browser execution of CHIRP Python logic for file-backed workflows.

Live browser serial now attempts to execute the selected CHIRP clone-mode
driver (`sync_in`/`sync_out`) through a generalized pyserial-like bridge.
Compatibility still depends on driver expectations and browser transport limits.

## Sequence diagram (sketch) of how it all works

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant UI as ui.js
  participant APP as app.js
  participant RPC as runtime-rpc.js
  participant SRC as python-sources.mjs
  participant PY as runtime_bridge.py
  participant S as serial.js
  participant R as Radio

  Note over APP,UI: app.js wires UI controller + runtime RPC client + serial bridge

  U->>UI: Open page
  UI->>RPC: callWorker("listRadios")
  RPC->>SRC: listDriverModules() + seedPyodideRuntime()
  SRC-->>RPC: Driver module list + runtime bridge source
  RPC->>PY: list_registered_radios(...)
  PY-->>RPC: radios[]
  RPC-->>UI: Populate make/model dropdowns

  U->>UI: Select make/model, click Connect
  UI->>RPC: callWorker("serialConnect", baudRate)
  RPC->>PY: webserial_connect(baud)
  PY->>RPC: serial_open(...)
  RPC->>S: handleSerialRpc("open")
  S-->>R: Open Web Serial port
  S-->>RPC: connected
  RPC-->>UI: connected/status

  U->>UI: Click Download Radio
  UI->>RPC: callWorker("downloadSelectedRadio", {module,className})
  RPC->>PY: ensure_radio_module(module)
  RPC->>PY: download_selected_radio(module,className)
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
  PY-->>RPC: rows + headers
  RPC-->>UI: Populate editable memory table

  U->>UI: Edit channels, click Upload Radio
  UI->>RPC: callWorker("validateRowsForUpload", {rows,module,className})
  RPC->>PY: validate_rows_for_upload(...)
  PY-->>RPC: valid + issues

  alt Preflight invalid
    RPC-->>UI: Block upload + highlight invalid cells
  else Preflight valid
    UI->>RPC: callWorker("uploadSelectedRadio", {module,className,rows})
    RPC->>PY: ensure_radio_module(module)
    RPC->>PY: upload_selected_radio(module,className,rows)

    alt Cached image exists
      PY->>PY: Apply edited rows to cached image
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

  Note over UI,PY: callWorker() logs full stack traces to Debug Output on runtime errors

```
