"""The webchirp Python runtime: CHIRP driven from a browser through Pyodide.

Importing this package prepares the interpreter for ``import chirp``, which
is why the two shims live here rather than in the modules that need them:
Python runs ``__init__`` before any submodule, so whichever module the entry
point (``web/python/runtime_bridge.py``) happens to import first finds the
builtins and the ``serial`` stand-in already in place. Nothing else belongs
in this file; the runtime logic is in the submodules, each covering one
concern (loading CHIRP sources, channel rows, the serial pipe, ...), and the
entry point flattens their namespaces into the RPC globals.
"""

from __future__ import annotations

import builtins
import sys
import types
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from typing import Any

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
    through ``WebSerialPipe`` (web/python/webchirp_bridge/serial_pipe.py) — so
    the shim carries pyserial's public
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
