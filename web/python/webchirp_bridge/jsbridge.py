"""The seam between Python and the JS half of the bridge.

Everything that crosses into ``web/js/runtime-rpc.js`` from CHIRP-facing code
passes through here: converting ``JsProxy`` values, waiting synchronously on
a JS promise (CHIRP's clone loops are blocking), and the two channels the app
shows the user -- the debug panel (``_log_debug``) and the progress strip
(``_make_status_logger``). The JS callables themselves are declared in
``web/python/typings/js.pyi``.
"""

from __future__ import annotations

import asyncio

from js import (
    serial_log,
    serial_progress,
)


try:
    from pyodide.ffi import run_sync as pyodide_run_sync
except Exception:
    pyodide_run_sync = None


def _log_debug(message) -> None:
    """Send a diagnostic line to the browser debug panel without ever raising."""
    try:
        serial_log(str(message))
    except Exception:
        pass  # Diagnostics must never break the operation being diagnosed.


def _js_to_py(value):
    """Convert a JsProxy to a native Python object when possible."""
    if hasattr(value, "to_py"):
        return value.to_py()
    return value


def _await_js(awaitable):
    """Synchronously wait for a JS Promise from Python code paths."""
    if pyodide_run_sync:
        return pyodide_run_sync(awaitable)
    loop = asyncio.get_event_loop()
    if not loop.is_running():
        return loop.run_until_complete(awaitable)
    raise RuntimeError(
        "No synchronous Promise bridge available in this runtime; "
        "cannot execute blocking CHIRP serial drivers"
    )


def _make_status_logger():
    """Build a status callback that forwards CHIRP reports to the UI progress display.

    Drivers report one status per transferred block; forwarding each report to
    the progress bar keeps it live, while the debug log only records message
    changes (phase transitions) instead of one line per block. The dedup state
    lives in this closure so it is scoped to one radio instance/operation: a
    driver that repeats the same message through a whole transfer must not
    suppress that message from the next transfer's log.
    """
    last_msg = None

    def _status_to_log(status):
        nonlocal last_msg
        msg = str(getattr(status, "msg", "") or "")
        cur = getattr(status, "cur", None)
        maxv = getattr(status, "max", None)
        try:
            if cur is None or maxv is None:
                serial_progress(-1, -1, msg)
            else:
                serial_progress(int(cur), int(maxv), msg)
        except Exception:
            pass  # A progress display failure must never break a clone.
        if msg and msg != last_msg:
            last_msg = msg
            serial_log(msg)

    return _status_to_log
