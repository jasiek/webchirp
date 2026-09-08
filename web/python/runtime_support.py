"""Runtime bootstrap, shared row types, and JavaScript interop helpers."""

from __future__ import annotations

import asyncio
import base64
import builtins
import copy
import importlib
import importlib.abc
import json
import os
import re
import sys
import tempfile
import traceback
import types
from typing import Any, Literal, Optional, Sequence

sys.path.insert(0, "/webchirp_runtime")


def _install_gettext_builtins() -> None:
    """Provide the translation builtins CHIRP expects from its wx frontend.

    CHIRP modules call ``_()``/``ngettext()`` as builtins, which upstream only
    installs when ``chirp.wxui`` boots. We never translate, so pass the source
    strings straight through instead of pulling in a locale machinery.
    """
    # A REPL leaves ``builtins._`` bound to the last result, so only a callable
    # counts as an already-installed translator.
    if not callable(getattr(builtins, "_", None)):
        builtins._ = lambda message: message
    if not callable(getattr(builtins, "ngettext", None)):
        builtins.ngettext = (
            lambda singular, plural, n: singular if n == 1 else plural
        )


_install_gettext_builtins()


def _install_pyserial_shim() -> None:
    """Provide a stand-in ``serial`` module so pyserial-importing drivers load.

    Pyodide has no pyserial, so drivers that ``import serial`` at module scope
    (tg_uv2p, idrp) would fail to import and never register with CHIRP's
    directory. They only need the module's constants — radio I/O always goes
    through :class:`WebSerialPipe` — so the shim carries pyserial's public
    constants and a ``Serial`` class that refuses construction with a clear
    error instead of failing with ``ModuleNotFoundError`` at import time.
    """
    try:
        import serial  # noqa: F401
        return
    except ImportError:
        pass

    shim = types.ModuleType("serial")
    shim.__doc__ = "Minimal pyserial stand-in for the webchirp Pyodide runtime."

    shim.FIVEBITS = 5
    shim.SIXBITS = 6
    shim.SEVENBITS = 7
    shim.EIGHTBITS = 8
    shim.PARITY_NONE = "N"
    shim.PARITY_EVEN = "E"
    shim.PARITY_ODD = "O"
    shim.PARITY_MARK = "M"
    shim.PARITY_SPACE = "S"
    shim.STOPBITS_ONE = 1
    shim.STOPBITS_ONE_POINT_FIVE = 1.5
    shim.STOPBITS_TWO = 2

    class SerialException(OSError):
        """Matches pyserial's base exception type."""

    class SerialTimeoutException(SerialException):
        """Matches pyserial's write-timeout exception type."""

    class Serial:
        """Unusable port stand-in: this runtime drives radios via WebSerialPipe."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            raise SerialException(
                "pyserial is unavailable in the browser runtime; "
                "radio I/O goes through the Web Serial bridge"
            )

    shim.SerialException = SerialException
    shim.SerialTimeoutException = SerialTimeoutException
    shim.Serial = Serial
    sys.modules["serial"] = shim


_install_pyserial_shim()

from chirp import (
    chirp_common,
    directory,
    errors,
    import_logic,
    memmap,
    settings as chirp_settings,
)
from chirp.drivers.generic_csv import CSVRadio
from js import (
    fetch_chirp_source,
    serial_close,
    serial_in_waiting,
    serial_prepare_clone,
    serial_progress,
    serial_reset_buffers,
    serial_set_signals,
    serial_log,
    serial_open,
    serial_read_bytes,
    serial_read_hex,
    serial_reconfigure,
    serial_write_bytes,
    serial_write_hex,
)

try:
    from pyodide.ffi import run_sync as pyodide_run_sync
except Exception:
    pyodide_run_sync = None

# A channel as it crosses the JS/Python boundary: one JSON object per channel,
# keyed by CSV header name (``CSV_HEADERS`` below, from
# ``chirp_common.Memory.CSV_FORMAT``) with text values — "Location": "25",
# "Frequency": "443.000000", "Duplex": "+". It is the grid's row, serialized by
# ``setRowsJsonGlobal()`` in ``web/js/runtime-rpc.js`` and parsed here with
# ``json.loads``, so every value a header names is a string.
#
# The value type is ``Any`` rather than ``str`` because a row may also carry
# non-header keys the editor rides along on it — currently the ``__geo``
# sidecar (``web/js/row-geo.js``), an object, which is why the type cannot
# promise ``str`` for arbitrary keys. Nothing here reads those: every consumer
# below projects a row through ``CSV_HEADERS`` and ignores the rest, which is
# what keeps the sidecar out of a codeplug.
Row = dict[str, Any]
Rows = list[Row]

# Driver extras ride on channel rows under a key that is not a CSV header, the
# same way repeater coordinates do in web/js/row-geo.js. Everything that
# serializes rows reads header keys only, so the sidecar never reaches a CSV or
# a codeplug; it travels with the row object while the grid is open.
ROW_EXTRA_KEY = "__extra"

# One invalid cell reported by the upload preflight: which row, which column,
# and CHIRP's own message for it.
ValidationIssue = dict[str, Any]
ValidationMessage = str | Exception
RowChangeAction = Literal["skip", "erase", "set"]

CSV_HEADERS = list(chirp_common.Memory.CSV_FORMAT)
DV_ONLY_HEADERS = ["URCALL", "RPT1CALL", "RPT2CALL", "DVCODE"]
DEFAULT_EXPORT_POWER = "50W"
# Duplex values CHIRP drivers actually emit. chirp_common has no single
# constant for these: RadioFeatures defaults valid_duplexes to ["", "+", "-"],
# and drivers extend it with "split" and "off".
DUPLEX_VALUES = ("", "+", "-", "split", "off")
DEFAULT_SERIAL_PIPE_TIMEOUT = 1.2
# How long ``WebSerialPipe.in_waiting`` parks waiting for the first byte when
# the bridge buffer is empty. pyserial answers in_waiting from a local buffer,
# so drivers poll it in tight loops -- ``anytone778uv.send_serial_command()``
# spins on it for up to 0.5 s per clone block -- but here each read is a JSPI
# round trip into JS, and a truthful non-blocking answer would cost thousands
# of them per block. The bridge instead waits on its read event, which settles
# as soon as bytes arrive, so this only bounds how long an *idle* line is
# allowed to hold up one poll. It has to stay well under the shortest deadline
# a driver polls against (0.5 s for anytone778uv) or a live radio would look
# silent.
IN_WAITING_WAIT_MS = 40

# pyserial spells the framing options as single letters and floats (the shim
# above carries its constants); Web Serial's open() takes words and whole
# numbers, and supports a narrower set. Values with no entry here -- 5/6 data
# bits, 1.5 stop bits, mark/space parity -- have no Web Serial equivalent, so
# they are left at the port's current setting rather than guessed at: a wrong
# framing corrupts every byte, where an unchanged one merely fails to help.
WEB_SERIAL_DATA_BITS = {7: 7, 8: 8}
WEB_SERIAL_STOP_BITS = {1: 1, 2: 2}
WEB_SERIAL_PARITY = {"N": "none", "E": "even", "O": "odd"}


def _web_serial_framing(table: dict, value: Any) -> Any:
    """Translate one pyserial framing value, or None when there is no mapping."""
    if value is None:
        return None
    return table.get(value)


def _log_debug(message: Any) -> None:
    """Send a diagnostic line to the browser debug panel without ever raising."""
    try:
        serial_log(str(message))
    except Exception:
        pass  # Diagnostics must never break the operation being diagnosed.


def _js_to_py(value: Any) -> Any:
    """Convert a JsProxy to a native Python object when possible."""
    if hasattr(value, "to_py"):
        return value.to_py()
    return value


def _await_js(awaitable: Any) -> Any:
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


class RuntimeUnsupportedError(errors.RadioError):
    pass


class ImageDetectionError(RuntimeUnsupportedError):
    """No imported driver claims this image.

    Split out from the generic error because it is the *only* image failure the
    all-drivers sweep can fix, and the browser gates its retry on this class
    name (`isImageDetectionFailure`, `web/js/image-metadata.mjs`). Renaming it
    without updating that predicate silently disables the backstop, so
    `scripts/test-metadataless-image-load.mjs` pins the two together.
    """
