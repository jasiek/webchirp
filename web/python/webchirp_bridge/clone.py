"""Clone sessions: downloading from and uploading to a connected radio.

A clone runs a driver's blocking ``sync_in``/``sync_out`` over a
``WebSerialPipe``, after the serial session has been prepared (buffers
cleared, control lines asserted, settle delay) and, where the driver
supports it, after detecting which model is actually on the wire. Download
caches the image it read; upload refuses to run without one, so a codeplug
is never written from a blank instance.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

from chirp import chirp_common
from js import serial_prepare_clone

from webchirp_bridge.channel_rows import CSV_HEADERS, Rows, normalize_rows
from webchirp_bridge.driver_cache import (
    LAST_IMAGE_BY_DRIVER,
    _cache_driver_image,
    _cached_image_class,
    _driver_cache_key,
    _import_radio_class,
    _radio_from_image_bytes,
    _record_unreadable_channels,
)
from webchirp_bridge.jsbridge import _await_js, _log_debug, _make_status_logger
from webchirp_bridge.radio_memories import (
    _apply_rows_to_radio_instance,
    _radio_rows_from_instance,
)
from webchirp_bridge.radio_settings import _validate_and_apply_radio_settings
from webchirp_bridge.runtime_errors import RuntimeUnsupportedError
from webchirp_bridge.serial_pipe import WebSerialPipe, _serial_pipe_timeout_seconds


def _ensure_clone_mode_radio(radio_cls):
    """Enforce clone-mode driver requirement for live serial workflows."""
    if not issubclass(radio_cls, chirp_common.CloneModeRadio):
        raise RuntimeUnsupportedError(
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
        _log_debug(
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
        _log_debug(f"Radio detected as {label} ({detected.__name__})")
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
    _await_js(
        serial_prepare_clone(
            bool(getattr(radio_cls, "WANTS_DTR", True)),
            bool(getattr(radio_cls, "WANTS_RTS", True)),
            350,
            _driver_baud_rate(radio_cls) or 0,
        )
    )


def _download_selected_radio_sync(module_name: str, class_name: str):
    """Run selected driver's sync_in and return rows + cached image state."""
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)

    _prepare_clone_session(radio_cls)
    radio = _create_radio_for_serial(radio_cls)
    radio.sync_in()
    # The image belongs to whatever detection settled on, not to the selection
    # the user made in the UI, and upload/export have to re-parse it as such.
    _cache_driver_image(module_name, class_name, radio)

    rows, unreadable = _radio_rows_from_instance(radio)
    _record_unreadable_channels(module_name, class_name, unreadable)
    csv_text = normalize_rows(rows, module_name, class_name)
    settings_result = _validate_and_apply_radio_settings(radio, [], apply_changes=False)
    return {
        "rows": rows,
        "headers": CSV_HEADERS,
        "csvText": csv_text,
        "settings": settings_result["settings"],
        "unreadableChannels": unreadable,
    }


def _upload_selected_radio_sync(
    module_name: str,
    class_name: str,
    rows: Rows,
    settings_groups: Optional[Sequence[Any]] = None,
) -> dict[str, Any]:
    """Apply rows onto cached image and run selected driver's sync_out."""
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)
    driver_key = _driver_cache_key(module_name, class_name)
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    if not base_image:
        raise RuntimeUnsupportedError(
            "No cached radio image for this model. Download from radio first, then upload."
        )
    # CHIRP does not re-detect on upload -- the class that downloaded the image
    # is the one that writes it back, and drivers like ga510 send their own
    # program handshake from do_upload().
    image_cls = _cached_image_class(module_name, class_name, radio_cls)
    radio = _radio_from_image_bytes(image_cls, base_image)
    radio.status_fn = _make_status_logger()
    radio.set_pipe(_new_serial_pipe(image_cls))
    _apply_rows_to_radio_instance(radio, rows, module_name, class_name)
    settings_result = _validate_and_apply_radio_settings(
        radio, settings_groups or [], apply_changes=True
    )
    if not settings_result["valid"]:
        raise RuntimeUnsupportedError("Radio settings validation failed before upload")
    _prepare_clone_session(image_cls)
    radio.sync_out()
    _cache_driver_image(module_name, class_name, radio)
    return {"uploaded": True, "settings": settings_result["settings"]}


async def download_selected_radio(module_name: str, class_name: str) -> dict[str, Any]:
    """Async wrapper for selected-radio download operation."""
    return _download_selected_radio_sync(module_name, class_name)


async def upload_selected_radio(
    module_name: str,
    class_name: str,
    rows: Rows,
    settings_groups: Optional[Sequence[Any]] = None,
) -> dict[str, Any]:
    """Async wrapper for selected-radio upload operation."""
    return _upload_selected_radio_sync(module_name, class_name, rows, settings_groups)
