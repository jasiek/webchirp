# AGENTS.md

## Purpose
This repository hosts a browser-based CHIRP interface (`web/`) that executes CHIRP Python code in Pyodide and communicates with radios via Web Serial.

## Core Architecture
- `web/app.js`: Browser UI and Web Serial bridge implementation.
- `web/py-worker.js`: Worker RPC layer and Pyodide bootstrap.
- `web/python/runtime_bridge.py`: Versioned Python runtime logic (no embedded Python in JS files).
- `chirp/`: Upstream CHIRP source as a git submodule.

## Rules for Agents
- Keep Python and JavaScript separated. Put runtime Python code in `web/python/*.py`.
- Prefer generic, parameterized flows based on selected CHIRP driver/module/class.
- Do not reintroduce radio-specific RPC methods when generic selected-radio methods can be used.
- Preserve debug visibility: full errors/tracebacks should be logged to the bottom debug panel.
- Avoid regressions in clone workflow:
  - Download should cache the image for the selected driver.
  - Upload should use cached image and fail clearly if no cached image exists.
  - Prepare serial session before clone operations (buffer clear, control lines, settle delay).

## UI Expectations
- Make/model options must be sourced from CHIRP driver sources.
- Session status should be concise; detailed diagnostics belong in Debug Output.
- Keep controls and labels task-oriented and explicit.

## Change Process
- Commit after every change.
- Keep commits small and scoped to one functional fix/refactor when practical.
- Include clear commit messages that describe user-visible behavior or architectural impact.

## Validation
Before committing, run relevant checks:
- `node --check web/app.js`
- `node --check web/py-worker.js`
- `python -m py_compile web/python/runtime_bridge.py`

If checks generate `__pycache__`, remove it before committing.
