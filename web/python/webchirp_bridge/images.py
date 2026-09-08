"""CHIRP ``.img`` files: loading, exporting, and writing one to a radio.

Images cross the JS boundary as base64. Loading reads the metadata trailer
first so the browser can import just the matching driver, then falls back
to CHIRP's ``match_model`` sweep over every imported driver; exporting
rebuilds a radio from the cached image and applies the grid's rows and
settings before serializing it, the same way an upload would.
"""

from __future__ import annotations

import base64
from typing import Any, Optional, Sequence

from chirp import (
    chirp_common,
    directory,
)

from webchirp_bridge.channel_rows import CSV_HEADERS, Rows
from webchirp_bridge.clone import (
    _ensure_clone_mode_radio,
    _new_serial_pipe,
    _prepare_clone_session,
)
from webchirp_bridge.driver_cache import (
    LAST_IMAGE_BY_DRIVER,
    _cache_driver_image,
    _cached_image_class,
    _driver_cache_key,
    _image_bytes_from_radio,
    _import_radio_class,
    _radio_from_image_bytes,
    _record_unreadable_channels,
    _temp_image_path,
)
from webchirp_bridge.jsbridge import _make_status_logger
from webchirp_bridge.radio_memories import (
    _apply_rows_to_radio_instance,
    _radio_rows_from_instance,
)
from webchirp_bridge.radio_settings import _validate_and_apply_radio_settings
from webchirp_bridge.runtime_errors import ImageDetectionError, RuntimeUnsupportedError


def _decode_image_b64(image_b64: str) -> bytes:
    """Decode an image the browser sent as base64, refusing a malformed payload."""
    try:
        return base64.b64decode(str(image_b64 or ""), validate=True)
    except Exception as exc:
        raise RuntimeUnsupportedError("Invalid image base64 payload") from exc


def _image_payload(image: bytes) -> dict[str, Any]:
    """The two fields every image-returning reply shares: base64 text and byte size."""
    return {"imageBase64": base64.b64encode(bytes(image)).decode("ascii"), "size": len(image)}


def get_cached_image_base64(module_name: str, class_name: str) -> dict[str, Any]:
    """Return cached clone image bytes for a driver as base64 text."""
    driver_key = _driver_cache_key(module_name, class_name)
    image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    if not image:
        raise RuntimeUnsupportedError(
            "No cached radio image for this model. Download from radio first."
        )
    return _image_payload(image)


def upload_image_base64(module_name: str, class_name: str, image_b64: str) -> dict[str, Any]:
    """Upload an explicit full-image payload through the selected clone driver."""
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)
    raw_image = _decode_image_b64(image_b64)

    radio = _radio_from_image_bytes(radio_cls, raw_image)
    radio.status_fn = _make_status_logger()
    radio.set_pipe(_new_serial_pipe(radio_cls))
    _prepare_clone_session(radio_cls)
    radio.sync_out()

    # This image came from the caller, parsed as the selected class, so it
    # replaces any variant class a previous download had recorded.
    _cache_driver_image(module_name, class_name, radio)
    return {"uploaded": True, "size": len(raw_image)}


def export_image_base64(
    module_name: str,
    class_name: str,
    rows: Rows,
    settings_groups: Optional[Sequence[Any]] = None,
) -> dict[str, Any]:
    """Build a CHIRP .img payload from rows for selected clone-mode driver."""
    radio_cls = _import_radio_class(module_name, class_name)
    _ensure_clone_mode_radio(radio_cls)
    driver_key = _driver_cache_key(module_name, class_name)
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    had_cached_image = bool(base_image)
    if not base_image:
        memsize = int(getattr(radio_cls, "_memsize", 0) or 0)
        if memsize <= 0:
            raise RuntimeUnsupportedError(
                "Driver does not expose memory size for offline image export"
            )
        base_image = bytes(memsize)

    radio = _radio_from_image_bytes(
        _cached_image_class(module_name, class_name, radio_cls), base_image
    )
    _apply_rows_to_radio_instance(radio, rows or [], module_name, class_name)
    settings_result = _validate_and_apply_radio_settings(
        radio, settings_groups or [], apply_changes=True
    )
    if not settings_result["valid"]:
        raise RuntimeUnsupportedError("Radio settings validation failed before export")
    # An offline export starts from fabricated zero bytes, not from the radio.
    # Return that file to the user, but do not let it satisfy the upload gate or
    # expose synthetic radio-wide settings as though they had been downloaded.
    image_data = (
        _cache_driver_image(module_name, class_name, radio)
        if had_cached_image
        else _image_bytes_from_radio(radio)
    )
    return {
        **_image_payload(image_data),
        "vendor": str(getattr(radio_cls, "VENDOR", "")),
        "model": str(getattr(radio_cls, "MODEL", "")),
        "variant": str(getattr(radio_cls, "VARIANT", "")),
        "settings": settings_result["settings"],
    }


def read_image_metadata_base64(image_b64: str) -> dict[str, Any]:
    """Parse the CHIRP metadata trailer from a .img payload without importing drivers."""
    raw_image = _decode_image_b64(image_b64)

    _, metadata = chirp_common.CloneModeRadio._strip_metadata(raw_image)
    if not metadata:
        return {"hasMetadata": False}

    vendor = str(metadata.get("vendor", "") or "")
    model = str(metadata.get("model", "") or "")
    vendor, model = directory.MODEL_COMPAT.get((vendor, model), (vendor, model))
    variant = metadata.get("variant")
    return {
        "hasMetadata": True,
        "rclass": str(metadata.get("rclass", "") or ""),
        "vendor": vendor,
        "model": model,
        # None (no variant recorded) and "" (an explicitly empty variant) are
        # different to CHIRP: get_radio_by_image skips the variant comparison
        # for the former and demands VARIANT == "" for the latter. Collapsing
        # them here would make catalog matching disagree with detection.
        "variant": None if variant is None else str(variant),
    }


def load_image_base64(image_b64: str) -> dict[str, Any]:
    """Load a CHIRP .img payload, detect driver, and return rows + radio identity."""
    raw_image = _decode_image_b64(image_b64)

    with _temp_image_path(raw_image, prefix="webchirp-") as image_path:
        try:
            radio = directory.get_radio_by_image(image_path)
        except Exception as exc:
            raise ImageDetectionError(f"Unable to detect radio from image: {exc}") from exc

    if not isinstance(radio, chirp_common.CloneModeRadio):
        raise RuntimeUnsupportedError("Loaded image is not a clone-mode CHIRP image")

    base_cls = getattr(radio.__class__, "_orig_rclass", radio.__class__)
    module_short = str(base_cls.__module__).rsplit(".", 1)[-1]
    class_name = str(base_cls.__name__)
    _cache_driver_image(module_short, class_name, radio)
    rows, unreadable = _radio_rows_from_instance(radio)
    _record_unreadable_channels(module_short, class_name, unreadable)
    settings_result = _validate_and_apply_radio_settings(radio, [], apply_changes=False)
    return {
        "module": module_short,
        "className": class_name,
        "vendor": str(getattr(radio.__class__, "VENDOR", "")),
        "model": str(getattr(radio.__class__, "MODEL", "")),
        "variant": str(getattr(radio.__class__, "VARIANT", "")),
        "rows": rows,
        "headers": CSV_HEADERS,
        "settings": settings_result["settings"],
        "unreadableChannels": unreadable,
    }
