"""The JS globals Pyodide exposes to ``webchirp_bridge`` as the ``js`` module.

These are not Python functions: each is a JS function installed on
``globalThis`` by ``installSerialBridgeGlobals()`` in ``web/js/serial-globals.ts``
before the runtime boots -- by ``web/js/runtime-rpc.ts`` in the browser and by
``tests/support/radio-harness.mjs`` under Node, so both environments define the
same functions with the same argument handling -- and reached through
Pyodide's ``js`` proxy module. Pyright cannot see across that boundary, so the
bridge contract is declared here instead — which also makes this file the one
place the JS and Python halves of the serial bridge are written down together.
``tests/webusb/serial-globals.mjs`` fails when the names here and the installer
disagree.

Everything returns ``Any``: the values arrive as ``JsProxy`` objects (awaitable
for the async ones), and ``_js_to_py()`` is what converts them.
"""

from typing import Any

# Serial transport. The async ones resolve to a JsProxy result object.
def serial_open(baudrate: int) -> Any: ...
def serial_close() -> Any: ...
def serial_read_bytes(count: int, timeout_ms: int) -> Any: ...
def serial_read_hex(count: int, timeout_ms: int) -> Any: ...
def serial_write_bytes(data: Any) -> Any: ...
def serial_write_hex(hex_text: str) -> Any: ...

# Buffered-byte count, waiting up to wait_ms for the first byte when empty.
def serial_in_waiting(wait_ms: int) -> Any: ...

# Clone-session preparation: the driver's line rate (0 keeps the current one),
# buffer clear, control lines, settle delay.
def serial_prepare_clone(
    wants_dtr: bool,
    wants_rts: bool,
    settle_ms: int,
    baud_rate: int,
) -> Any: ...
def serial_reset_buffers() -> Any: ...

# Mid-clone port reconfiguration. The bridge reopens the port or changes it in
# place, as the transport's capabilities say; ``None`` leaves that option
# untouched.
def serial_reconfigure(
    baud_rate: int | None,
    data_bits: int | None,
    stop_bits: int | None,
    parity: str | None,
) -> Any: ...

# Mid-clone DTR/RTS changes. ``None`` leaves that line untouched.
def serial_set_signals(dtr: bool | None, rts: bool | None) -> Any: ...

# Diagnostics and clone progress, surfaced in the app's debug panel.
def serial_log(message: str) -> Any: ...
def serial_progress(cur: int, max: int, message: str) -> Any: ...
