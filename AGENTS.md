# AGENTS.md

## Purpose
This repository hosts a browser-based CHIRP interface (`web/`) that executes CHIRP Python code in Pyodide and communicates with radios via Web Serial.

## Core Architecture
- `web/app.js`: Browser UI and Web Serial bridge implementation.
- `web/js/runtime-rpc.js`: Main-thread runtime RPC layer and Pyodide bootstrap.
- `web/js/ui.js`: Composes the UI modules and exposes `createUiController()`.
- `web/js/ui/`: One module per UI area — `channel-table`, `settings-panel`,
  `radio-catalog`, `repeater-query`, `codeplug-io`, `serial-actions`, plus the
  shared `dom`, `state`, `debug-log`, `issue-report`, `format`, `analytics` and
  `channel-values` helpers.
- `web/python/runtime_bridge.py`: Versioned Python runtime logic (no embedded Python in JS files).
- `chirp/`: Upstream CHIRP source as a git submodule.

### UI module conventions
- Each module is a `create<Area>(ctx)` factory. `ctx` carries `dom`, `state`,
  `log`, `actions` and every constructed sibling module.
- Keep state private to the module that owns it; expose accessors instead.
  `web/js/ui/state.js` is only for state that genuinely spans modules.
- Call siblings through `ctx` (`ctx.table.render()`) or `ctx.actions`, never by
  importing them — that keeps the module graph free of cycles. Such calls must
  happen after construction, never in a factory body.
- Modules bind their own DOM listeners in a `bindEvents()`; `ui.js` only binds
  what no single module owns.
- Query document elements in `web/js/ui/dom.js`, not in feature modules.

## Rules for Agents
- Keep Python and JavaScript separated. Put runtime Python code in `web/python/*.py`.
- Prefer generic, parameterized flows based on selected CHIRP driver/module/class.
- Do not reintroduce radio-specific RPC methods when generic selected-radio methods can be used.
- Preserve debug visibility: full errors/tracebacks should be logged to the bottom debug panel.
- Avoid context pollution by spawning sub-agents when appropriate. Use sub-agent sandboxing when a read-only task is to be executed.
  - Use sub-agents to produce a summary for a commit message.
- When you discover something new, or unexpected, put it in FINDINGS.md
- Avoid regressions in clone workflow:
  - Download should cache the image for the selected driver.
  - Upload should use cached image and fail clearly if no cached image exists.
  - Prepare serial session before clone operations (buffer clear, control lines, settle delay).

## Agent CLI
- For agent-operated real-radio reads, use `npm run radio:read -- --port <path> --module <driver_module> --class <driver_class> --format json|csv|img --output <file>`.
- For agent-operated real-radio writes, use `npm run radio:write -- --port <path> --module <driver_module> --class <driver_class> --format json|csv|img --input <file>`.
- Prefer `--format json` when the workflow needs rows, settings, normalized CSV, and binary image in one file.
- `--format img` means a CHIRP `.img` clone file and is clone-image only; expect it to fail clearly on radios that do not expose clone-mode image workflows.

## UI Expectations
- Make/model options must be sourced from CHIRP driver sources.
- Session status should be concise; detailed diagnostics belong in Debug Output.
- Keep controls and labels task-oriented and explicit.

## Change Process
- Commit after every change.
- Keep commits small and scoped to one functional fix/refactor when practical.
- Include clear commit messages that describe user-visible behavior or architectural impact.
- Never modify RELEASE_NOTES.md when on a branch. When on master, update RELEASE_NOTES.md based on PRs which were merged in with current date. Each entry is a single line: the user-visible change plus the PR number, no multi-sentence detail. At the same time run `npm run screenshots` to regenerate images/screenshot.png, images/screenshot-for-opengraph.png, and web/images/social-preview.png from the current version of the app.

# PR Behaviour
- When submitting a PR, in the PR description include any new dependencies which were added.

## Validation
Before committing, run relevant checks:
- `node --check web/app.js`
- `node --check web/js/runtime-rpc.js`
- `python -m py_compile web/python/runtime_bridge.py`
- `npm run test:channels`
