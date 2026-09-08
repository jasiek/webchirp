"""The pyserial stand-in CHIRP drivers talk to, backed by Web Serial.

Drivers read, write and reconfigure ``self.pipe`` as if it were a
``serial.Serial``; ``WebSerialPipe`` answers for every attribute they touch,
in pyserial's spelling and with pyserial's return values, and forwards each
to the JS serial bridge through the callables in ``web/python/typings/js.pyi``.
The ``webserial_*`` functions are the app's own connect, disconnect and
loopback-probe entry points, which do not go through a driver at all.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from js import (
    serial_close,
    serial_in_waiting,
    serial_log,
    serial_open,
    serial_read_bytes,
    serial_read_hex,
    serial_reconfigure,
    serial_reset_buffers,
    serial_set_signals,
    serial_write_bytes,
    serial_write_hex,
)

from webchirp_bridge.jsbridge import _await_js, _js_to_py, _log_debug


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
# in web/python/webchirp_bridge/__init__.py carries its constants); Web
# Serial's open() takes words and whole
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


async def webserial_connect(baudrate: int) -> Any:
    """Open serial transport via JS bridge and return normalized result."""
    result = await serial_open(int(baudrate))
    return _js_to_py(result)


async def webserial_disconnect() -> Any:
    """Close serial transport via JS bridge and return normalized result."""
    result = await serial_close()
    return _js_to_py(result)


async def webserial_txrx_hex(tx_hex: str, rx_bytes: int, timeout_ms: int) -> dict[str, Any]:
    """Send a hex payload and read a fixed-size response via JS bridge."""
    tx_result = await serial_write_hex(tx_hex)
    rx_result = await serial_read_hex(int(rx_bytes), int(timeout_ms))
    return {
        "tx": _js_to_py(tx_result),
        "rx": _js_to_py(rx_result),
    }


class WebSerialPipe:
    """Minimal pyserial-like API over JS bridge for CHIRP drivers."""

    def __init__(
        self,
        timeout: float = DEFAULT_SERIAL_PIPE_TIMEOUT,
        baudrate: Optional[int] = None,
        dtr: Optional[bool] = None,
        rts: Optional[bool] = None,
    ) -> None:
        """Expose a minimal pyserial-like pipe for CHIRP clone-mode drivers.

        ``baudrate``/``dtr``/``rts`` seed the port state without touching the
        port. The seeds describe what the port was already opened with -- the
        UI connects at the driver's ``BAUD_RATE`` -- so seeding is what makes a
        later assignment of the *same* value correctly a no-op, and
        ``_prepare_clone_session()`` remains the one place that asserts the
        driver's wanted lines with the settle delay a radio needs. Later writes
        -- ``setDTR()``, ``setRTS()``, or assigning ``baudrate`` and the framing
        properties -- are driver-initiated and do reach the port.
        """
        self.timeout = timeout
        self._baudrate = None if baudrate is None else int(baudrate)
        self._bytesize = None
        self._stopbits = None
        self._parity = None
        self._dtr = None if dtr is None else bool(dtr)
        self._rts = None if rts is None else bool(rts)

    def write(self, data: "str | bytes | bytearray | memoryview") -> int:
        """Write bytes to the JS serial bridge and report the byte count.

        pyserial's ``Serial.write`` returns how many bytes went out, and some
        CHIRP drivers validate that value: ``puxing_px888k.pipewrite`` aborts
        the clone with "operation returned <None>" when it is ``None``, and
        ``tk11`` treats a falsy count as a failed transfer. The bridge either
        transfers every byte or raises, so a call that returns normally wrote
        the whole payload (issue #79).
        """
        if isinstance(data, str):
            data = data.encode("latin1")
        payload = bytes(data)
        _await_js(serial_write_bytes(list(payload)))
        return len(payload)

    def read(self, count: int = 1) -> bytes:
        """Read up to count bytes from JS serial bridge with timeout semantics."""
        timeout_ms = max(1, int(float(self.timeout) * 1000))
        data = _await_js(serial_read_bytes(int(count), timeout_ms))
        if hasattr(data, "to_py"):
            data = data.to_py()
        return bytes((int(x) & 0xFF) for x in data)

    def flush(self) -> None:
        """Pyserial compatibility no-op."""
        return

    def reset_input_buffer(self) -> None:
        """Clear pending inbound serial bytes in bridge buffers."""
        _await_js(serial_reset_buffers())

    def reset_output_buffer(self) -> None:
        """Pyserial compatibility no-op for write buffering."""
        return

    def flushInput(self) -> None:
        """Legacy pyserial alias for reset_input_buffer()."""
        self.reset_input_buffer()

    def flushOutput(self) -> None:
        """Legacy pyserial alias for reset_output_buffer()."""
        self.reset_output_buffer()

    @property
    def in_waiting(self) -> int:
        """Report bytes the JS bridge has buffered, as pyserial's in_waiting does.

        This used to be a hardcoded 0, which is not a harmless approximation:
        a driver that only reads when in_waiting is non-zero reads nothing at
        all, and one polling it against a deadline just spins until it expires.
        """
        result = _js_to_py(_await_js(serial_in_waiting(IN_WAITING_WAIT_MS)))
        try:
            return int(result["available"])
        except Exception:
            # Never let a malformed bridge reply raise out of an attribute
            # read; "nothing buffered" is what every caller already handles.
            return 0

    def inWaiting(self) -> int:
        """Legacy pyserial spelling of in_waiting, still called by anytone778uv."""
        return self.in_waiting

    def close(self) -> None:
        """Pyserial compatibility no-op; UI owns port lifecycle."""
        return

    # ``value`` defaults to True to match pyserial, whose setRTS()/setDTR()
    # take an optional level. CHIRP drivers rely on that default: thd72 calls
    # ``self.pipe.setRTS()`` bare and only guards against AttributeError, so a
    # required argument here aborts the clone with a TypeError (issue #77).
    def setRTS(self, value: bool = True) -> None:
        """Assert or clear RTS on the port, pyserial-style."""
        self._rts = bool(value)
        self._push_signals()

    def setDTR(self, value: bool = True) -> None:
        """Assert or clear DTR on the port, pyserial-style."""
        self._dtr = bool(value)
        self._push_signals()

    # pyserial exposes the lines as writable properties as well as setters, and
    # drivers use both spellings (thd72 falls back to ``pipe.rts = True``), so
    # both have to reach the port rather than just recording a boolean.
    @property
    def rts(self) -> Optional[bool]:
        return self._rts

    @rts.setter
    def rts(self, value: bool) -> None:
        self.setRTS(value)

    @property
    def dtr(self) -> Optional[bool]:
        return self._dtr

    @dtr.setter
    def dtr(self, value: bool) -> None:
        self.setDTR(value)

    # Drivers reconfigure the port part-way through a clone: thd72 jumps to
    # 57600 immediately after the "0M PROGRAM" handshake, and the radio has
    # already switched by the time the assignment runs, so a pipe that merely
    # remembers the number leaves the two ends talking past each other. These
    # are properties rather than plain attributes for that reason alone.
    @property
    def baudrate(self) -> Optional[int]:
        return self._baudrate

    @baudrate.setter
    def baudrate(self, value: Optional[int]) -> None:
        rate = None if value is None else int(value)
        if rate == self._baudrate:
            return
        self._baudrate = rate
        if rate is not None:
            self._push_port_config()

    @property
    def bytesize(self) -> Optional[int]:
        return self._bytesize

    @bytesize.setter
    def bytesize(self, value: Optional[int]) -> None:
        self._set_framing("_bytesize", value, WEB_SERIAL_DATA_BITS, "bytesize")

    @property
    def stopbits(self) -> Optional[float]:
        return self._stopbits

    @stopbits.setter
    def stopbits(self, value: Optional[float]) -> None:
        self._set_framing("_stopbits", value, WEB_SERIAL_STOP_BITS, "stopbits")

    @property
    def parity(self) -> Optional[str]:
        return self._parity

    @parity.setter
    def parity(self, value: Optional[str]) -> None:
        self._set_framing("_parity", value, WEB_SERIAL_PARITY, "parity")

    def _set_framing(self, attr: str, value: Any, table: dict, label: str) -> None:
        """Record a framing change and push it, keeping the pyserial value.

        The attribute keeps what the driver assigned so a read-back matches
        pyserial; only the push is skipped when the value has no Web Serial
        equivalent, and that skip is logged rather than silent.
        """
        if value == getattr(self, attr):
            return
        setattr(self, attr, value)
        if value is None:
            return
        if value not in table:
            _log_debug(f"Serial {label}={value!r} has no Web Serial equivalent; port unchanged")
            return
        self._push_port_config()

    def _push_port_config(self) -> None:
        """Reopen the port with the pipe's current baud rate and framing.

        Unlike the control lines, this is *not* advisory. The radio has already
        switched by the time a driver assigns the new rate, so a port left
        behind cannot complete the clone -- and the failure would otherwise
        surface as an unexplained read timeout much later. Errors propagate.
        """
        _await_js(
            serial_reconfigure(
                self._baudrate,
                _web_serial_framing(WEB_SERIAL_DATA_BITS, self._bytesize),
                _web_serial_framing(WEB_SERIAL_STOP_BITS, self._stopbits),
                _web_serial_framing(WEB_SERIAL_PARITY, self._parity),
            )
        )

    def _push_signals(self) -> None:
        """Forward the current DTR/RTS state to the JS serial bridge.

        Control lines are advisory: some adapters and browsers cannot change
        them, and a clone that would otherwise work must not die because of
        that. Failures are logged to the debug panel instead of raised.
        """
        try:
            _await_js(serial_set_signals(self._dtr, self._rts))
        except Exception as exc:
            _log_debug(f"Serial control lines not applied (DTR/RTS): {exc}")

    def log(self, msg: Any) -> None:
        """Forward driver log/status text to the browser debug console."""
        serial_log(str(msg))


def _serial_pipe_timeout_seconds() -> float:
    """Resolve serial read timeout with optional env override."""
    raw = os.environ.get("WEBCHIRP_SERIAL_TIMEOUT_S", "")
    if not raw:
        return DEFAULT_SERIAL_PIPE_TIMEOUT
    try:
        value = float(raw)
    except Exception:
        return DEFAULT_SERIAL_PIPE_TIMEOUT
    if value <= 0:
        return DEFAULT_SERIAL_PIPE_TIMEOUT
    return value
