# webchirp

Prototype for running parts of [CHIRP](https://github.com/kk7ds/chirp) in the browser with a CHIRP-like UI.

## What is implemented

- `chirp` is included as a git submodule at `/Users/jps/github/webchirp/chirp`
- Browser UI with a channel-memory table inspired by CHIRP
- Python runtime in-browser (Pyodide) running CHIRP code (`generic_csv` driver)
- CSV import/parse via CHIRP Python code
- CSV export/normalization via CHIRP Python code
- Web Serial bridge (browser serial in JS, called from Python in Pyodide)
- Python-driven TX/RX serial transaction path (`serialConnect`, `serialTxRx`)
- BF-888 protocol flow (download/upload) using CHIRP BF-888 logic and memory model

## Run the prototype

From `/Users/jps/github/webchirp`:

```bash
python -m http.server 8000
```

Open [http://localhost:8000/web/index.html](http://localhost:8000/web/index.html).

Serial access requires a browser with Web Serial support and a secure context
(`http://localhost` works).

For BF-888:

1. Click `Connect` at 9600 baud and select the programming port.
2. Click `Download BF-888` to read channels into the table.
3. Edit values and click `Upload BF-888` to write back.

## Architecture

- Frontend: `/Users/jps/github/webchirp/web/index.html` + `/Users/jps/github/webchirp/web/app.js`
- Python worker bridge: `/Users/jps/github/webchirp/web/py-worker.js`
- CHIRP source loaded into Pyodide FS directly from the submodule:
  - `/chirp/chirp/__init__.py`
  - `/chirp/chirp/chirp_common.py`
  - `/chirp/chirp/directory.py`
  - `/chirp/chirp/drivers/generic_csv.py`
  - and required dependencies (`errors.py`, `util.py`, `memmap.py`)

## Important scope note

This MVP proves in-browser execution of CHIRP Python logic for file-backed workflows.

BF-888 is wired with its protocol and memory image handling, but this is still
a prototype path focused on one model. Other radios remain unsupported until
their clone protocols and edge cases are implemented.

## Next phase (recommended)

1. Validate BF-888 against multiple cable/radio variants and harden timeout/ACK retries.
2. Preserve and edit BF-888 radio settings (not just memory channels) in the UI.
3. Add driver capability flags and expand model support incrementally.
