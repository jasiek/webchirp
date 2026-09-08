"""Web Serial transport, clone preparation, and progress reporting."""

from __future__ import annotations

from typing import Any, Optional

from chirp import chirp_common
import os
import runtime_support


async def webserial_connect(baudrate: int) -> Any:
    """Open serial transport via JS bridge and return normalized result."""
    result = await runtime_support.serial_open(int(baudrate))
    return runtime_support._js_to_py(result)


async def webserial_disconnect() -> Any:
    """Close serial transport via JS bridge and return normalized result."""
    result = await runtime_support.serial_close()
    return runtime_support._js_to_py(result)


async def webserial_txrx_hex(tx_hex: str, rx_bytes: int, timeout_ms: int) -> Any:
    """Send a hex payload and read a fixed-size response via JS bridge."""
    tx_result = await runtime_support.serial_write_hex(tx_hex)
    rx_result = await runtime_support.serial_read_hex(int(rx_bytes), int(timeout_ms))
    return {
        "tx": runtime_support._js_to_py(tx_result),
        "rx": runtime_support._js_to_py(rx_result),
    }


class WebSerialPipe:
    """Minimal pyserial-like API over JS bridge for CHIRP drivers."""

    def __init__(
        self,
        timeout: float = runtime_support.DEFAULT_SERIAL_PIPE_TIMEOUT,
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
        runtime_support._await_js(runtime_support.serial_write_bytes(list(payload)))
        return len(payload)

    def read(self, count: Any=1) -> Any:
        """Read up to count bytes from JS serial bridge with timeout semantics."""
        timeout_ms = max(1, int(float(self.timeout) * 1000))
        data = runtime_support._await_js(runtime_support.serial_read_bytes(int(count), timeout_ms))
        if hasattr(data, "to_py"):
            data = data.to_py()
        return bytes((int(x) & 0xFF) for x in data)

    def flush(self) -> Any:
        """Pyserial compatibility no-op."""
        return

    def reset_input_buffer(self) -> Any:
        """Clear pending inbound serial bytes in bridge buffers."""
        runtime_support._await_js(runtime_support.serial_reset_buffers())

    def reset_output_buffer(self) -> Any:
        """Pyserial compatibility no-op for write buffering."""
        return

    def flushInput(self) -> Any:
        """Legacy pyserial alias for reset_input_buffer()."""
        self.reset_input_buffer()

    def flushOutput(self) -> Any:
        """Legacy pyserial alias for reset_output_buffer()."""
        self.reset_output_buffer()

    @property
    def in_waiting(self) -> int:
        """Report bytes the JS bridge has buffered, as pyserial's in_waiting does.

        This used to be a hardcoded 0, which is not a harmless approximation:
        a driver that only reads when in_waiting is non-zero reads nothing at
        all, and one polling it against a deadline just spins until it expires.
        """
        result = runtime_support._js_to_py(runtime_support._await_js(runtime_support.serial_in_waiting(runtime_support.IN_WAITING_WAIT_MS)))
        try:
            return int(result["available"])
        except Exception:
            # Never let a malformed bridge reply raise out of an attribute
            # read; "nothing buffered" is what every caller already handles.
            return 0

    def inWaiting(self) -> int:
        """Legacy pyserial spelling of in_waiting, still called by anytone778uv."""
        return self.in_waiting

    def close(self) -> Any:
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
        self._set_framing("_bytesize", value, runtime_support.WEB_SERIAL_DATA_BITS, "bytesize")

    @property
    def stopbits(self) -> Optional[float]:
        return self._stopbits

    @stopbits.setter
    def stopbits(self, value: Optional[float]) -> None:
        self._set_framing("_stopbits", value, runtime_support.WEB_SERIAL_STOP_BITS, "stopbits")

    @property
    def parity(self) -> Optional[str]:
        return self._parity

    @parity.setter
    def parity(self, value: Optional[str]) -> None:
        self._set_framing("_parity", value, runtime_support.WEB_SERIAL_PARITY, "parity")

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
            runtime_support._log_debug(f"Serial {label}={value!r} has no Web Serial equivalent; port unchanged")
            return
        self._push_port_config()

    def _push_port_config(self) -> None:
        """Reopen the port with the pipe's current baud rate and framing.

        Unlike the control lines, this is *not* advisory. The radio has already
        switched by the time a driver assigns the new rate, so a port left
        behind cannot complete the clone -- and the failure would otherwise
        surface as an unexplained read timeout much later. Errors propagate.
        """
        runtime_support._await_js(
            runtime_support.serial_reconfigure(
                self._baudrate,
                runtime_support._web_serial_framing(runtime_support.WEB_SERIAL_DATA_BITS, self._bytesize),
                runtime_support._web_serial_framing(runtime_support.WEB_SERIAL_STOP_BITS, self._stopbits),
                runtime_support._web_serial_framing(runtime_support.WEB_SERIAL_PARITY, self._parity),
            )
        )

    def _push_signals(self) -> None:
        """Forward the current DTR/RTS state to the JS serial bridge.

        Control lines are advisory: some adapters and browsers cannot change
        them, and a clone that would otherwise work must not die because of
        that. Failures are logged to the debug panel instead of raised.
        """
        try:
            runtime_support._await_js(runtime_support.serial_set_signals(self._dtr, self._rts))
        except Exception as exc:
            runtime_support._log_debug(f"Serial control lines not applied (DTR/RTS): {exc}")

    def log(self, msg: Any) -> Any:
        """Forward driver log/status text to the browser debug console."""
        runtime_support.serial_log(str(msg))


def _serial_pipe_timeout_seconds() -> Any:
    """Resolve serial read timeout with optional env override."""
    raw = os.environ.get("WEBCHIRP_SERIAL_TIMEOUT_S", "")
    if not raw:
        return runtime_support.DEFAULT_SERIAL_PIPE_TIMEOUT
    try:
        value = float(raw)
    except Exception:
        return runtime_support.DEFAULT_SERIAL_PIPE_TIMEOUT
    if value <= 0:
        return runtime_support.DEFAULT_SERIAL_PIPE_TIMEOUT
    return value


def _make_status_logger() -> Any:
    """Build a status callback that forwards CHIRP reports to the UI progress display.

    Drivers report one status per transferred block; forwarding each report to
    the progress bar keeps it live, while the debug log only records message
    changes (phase transitions) instead of one line per block. The dedup state
    lives in this closure so it is scoped to one radio instance/operation: a
    driver that repeats the same message through a whole transfer must not
    suppress that message from the next transfer's log.
    """
    last_msg = None

    def _status_to_log(status: Any) -> Any:
        nonlocal last_msg
        msg = str(getattr(status, "msg", "") or "")
        cur = getattr(status, "cur", None)
        maxv = getattr(status, "max", None)
        try:
            if cur is None or maxv is None:
                runtime_support.serial_progress(-1, -1, msg)
            else:
                runtime_support.serial_progress(int(cur), int(maxv), msg)
        except Exception:
            pass  # A progress display failure must never break a clone.
        if msg and msg != last_msg:
            last_msg = msg
            runtime_support.serial_log(msg)

    return _status_to_log


def _ensure_clone_mode_radio(radio_cls: Any) -> Any:
    """Enforce clone-mode driver requirement for live serial workflows."""
    if not issubclass(radio_cls, chirp_common.CloneModeRadio):
        raise runtime_support.RuntimeUnsupportedError(
            "Selected radio is not a clone-mode driver; live serial clone is unsupported in this UI"
        )


def _driver_baud_rate(radio_cls: Any) -> Optional[int]:
    """Return the driver's declared serial line rate, or None when unusable.

    CHIRP drivers advertise BAUD_RATE as a plain class attribute, so it can be
    missing, None, or (in out-of-tree drivers) a non-numeric value. Callers
    need one shape they can hand both to the pipe and to the JS bridge.
    """
    try:
        baud = int(getattr(radio_cls, "BAUD_RATE", 0) or 0)
    except (TypeError, ValueError):
        return None
    return baud if baud > 0 else None


def _new_serial_pipe(radio_cls: type[chirp_common.Radio]) -> WebSerialPipe:
    """Build the pipe a clone runs over, seeded from the driver's declarations.

    Shared by every clone entry point so the pipe a driver sees is configured
    the same way -- and so the seeded line state stays in step with what
    ``_prepare_clone_session()`` asserts on the port.
    """
    return WebSerialPipe(
        timeout=_serial_pipe_timeout_seconds(),
        baudrate=_driver_baud_rate(radio_cls),
        dtr=bool(getattr(radio_cls, "WANTS_DTR", True)),
        rts=bool(getattr(radio_cls, "WANTS_RTS", True)),
    )


def _detect_radio_class(
    radio_cls: type[chirp_common.Radio], pipe: WebSerialPipe
) -> type[chirp_common.Radio]:
    """Let the driver talk to the radio and say which class really matches.

    CHIRP's clone dialog runs this before sync_in() (chirp/chirp/wxui/clone.py), and
    for several driver families it is not merely a variant lookup: ga510 and
    tdh8 send the program handshake from here and their download paths
    deliberately do not repeat it, so a clone that skips detection gets no
    response at all. leixen, h777, anytone778uv, tdm11 and uvk5 use it to pick
    the subclass whose codeplug layout matches the radio on the wire.

    Drivers with nothing to detect inherit DetectableInterface's base method,
    whose NotImplementedError means "use the class as selected". RadioError and
    friends are left to propagate so a failed handshake is reported rather than
    silently downgraded into a clone against the wrong class.
    """
    detect = getattr(radio_cls, "detect_from_serial", None)
    if not callable(detect):
        return radio_cls
    try:
        detected = detect(pipe)
    except NotImplementedError:
        return radio_cls
    if not isinstance(detected, type) or not issubclass(detected, chirp_common.Radio):
        runtime_support._log_debug(
            f"Driver detection returned {detected!r}, which is not a radio class; "
            f"continuing with {radio_cls.__name__}"
        )
        return radio_cls
    if detected is not radio_cls:
        label = " ".join(
            part
            for part in (
                str(getattr(detected, "VENDOR", "")),
                str(getattr(detected, "MODEL", "")),
                str(getattr(detected, "VARIANT", "")),
            )
            if part
        )
        runtime_support._log_debug(f"Radio detected as {label} ({detected.__name__})")
    return detected


def _create_radio_for_serial(radio_cls: type[chirp_common.Radio]) -> chirp_common.Radio:
    """Instantiate the radio actually on the wire, on a detection-shared pipe.

    Detection has to run on the same pipe the clone then uses: drivers that
    hand-shake during detection leave the radio in program mode and expect the
    instance they return to carry on from there (issue #81).
    """
    pipe = _new_serial_pipe(radio_cls)
    detected_cls = _detect_radio_class(radio_cls, pipe)
    _ensure_clone_mode_radio(detected_cls)
    radio = detected_cls(pipe)
    radio.status_fn = _make_status_logger()
    return radio


def _prepare_clone_session(radio_cls: Any) -> None:
    """Reset/prepare transport lines before clone operations for stability.

    Also hands the bridge the driver's declared BAUD_RATE. The port's line rate
    is latched when it opens, and the user may have connected with a different
    radio selected, so the rate has to be re-applied per clone rather than
    trusted from connect time (issue #76).
    """
    runtime_support._await_js(
        runtime_support.serial_prepare_clone(
            bool(getattr(radio_cls, "WANTS_DTR", True)),
            bool(getattr(radio_cls, "WANTS_RTS", True)),
            350,
            _driver_baud_rate(radio_cls) or 0,
        )
    )
