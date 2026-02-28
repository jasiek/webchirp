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
python -m http.server 8000
```

Open [http://localhost:8000/web/index.html](http://localhost:8000/web/index.html).

Serial access requires a browser with Web Serial support and a secure context
(`http://localhost` works).

For radio cloning:

1. Choose `Radio make` and `Radio model` from dropdowns (loaded from CHIRP sources).
2. Click `Connect` (baud is prefilled when available from selected driver).
3. Click `Download Radio` to read channels into the table.
4. Edit values and click `Upload Radio` to write back.

## Command-line hardware test (UV-5R flow)

You can run the serial hardware regression sequence from Node.js using the
local `chirp/` checkout and the `serialport` package:

```bash
npm run test:hw -- --port /dev/tty.usbserial-XXXX
```

Optional flags:

- `--module uv5r` (default)
- `--class BaofengUV5R` (default)
- `--baud 9600` (auto-uses driver BAUD_RATE when omitted)
- `--post-clone-delay-ms 3000` (wait after clone operations for radio reboot)

The test sequence is:

1. Download current radio image and save it to a temporary backup file.
2. Erase all channels.
3. Upload a synthetic PMR446 channel plan.
4. Download again and verify readback matches the synthetic rows.
5. Restore the original backup image in a `finally` block (even on failure).

## Architecture

- Frontend: `/Users/jps/github/webchirp/web/index.html` + `/Users/jps/github/webchirp/web/app.js`
- Main-thread runtime bridge: `/Users/jps/github/webchirp/web/js/runtime-rpc.js`
- Versioned Python runtime code: `/Users/jps/github/webchirp/web/python/runtime_bridge.py`
- CHIRP source loaded into Pyodide FS directly from the submodule:
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
  participant PY as runtime_bridge.py
  participant S as serial.js
  participant R as Radio

  Note over APP,UI: app.js wires UI -> runtime-rpc and serial bridge on page load

  U->>UI: Select make/model, click Connect
  UI->>RPC: callWorker("serialConnect", baudRate)
  RPC->>PY: webserial_connect(baud)
  PY->>RPC: serial_open(...)
  RPC->>S: handleSerialRpc("open")
  S-->>R: Open Web Serial port
  S-->>RPC: connected
  RPC-->>UI: connected/status

  U->>UI: Click Download Radio
  UI->>RPC: callWorker("downloadSelectedRadio", module,class)
  RPC->>PY: download_selected_radio(...)
  PY->>RPC: serial_prepare_clone(...)
  RPC->>S: prepareClone(DTR/RTS, settle)
  S-->>R: Set control lines + settle
  S-->>RPC: prepared
  PY-->>R: sync_in() via serial read/write
  PY->>PY: Cache image in LAST_IMAGE_BY_DRIVER
  PY-->>RPC: rows + headers
  RPC-->>UI: Populate editable memory table

  U->>UI: Edit channels, click Upload Radio
  UI->>RPC: callWorker("uploadSelectedRadio", module,class,rows)
  RPC->>PY: upload_selected_radio(...)

  alt Cached image exists
    PY->>RPC: serial_prepare_clone(...)
    RPC->>S: prepareClone(...)
    S-->>R: Set control lines + settle
    PY->>PY: Apply edited rows to cached image
    PY-->>R: sync_out() via serial read/write
    PY->>PY: Refresh cached image
    PY-->>RPC: uploaded=true
    RPC-->>UI: Show upload success
  else No cached image
    PY-->>RPC: Error: download required first
    RPC-->>UI: Show clear failure in Debug Output
  end

```
