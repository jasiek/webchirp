"""Driver image cache and selected-radio clone and image operations."""

from __future__ import annotations

from typing import Any, Optional, Sequence

from chirp import chirp_common
from chirp import directory
from chirp import memmap
import base64
import os
import tempfile
import runtime_channels
import runtime_drivers
import runtime_serial
import runtime_settings
import runtime_support
import runtime_validation

LAST_IMAGE_BY_DRIVER = {}
# Which class actually produced/parses LAST_IMAGE_BY_DRIVER[key]. Serial
# detection and image loading can both resolve the user's selection to a
# variant subclass with a different codeplug layout, so re-parsing the cached
# bytes with the selected parent class would decode the wrong fields.
IMAGE_CLASS_BY_DRIVER: dict[str, type] = {}
# Memory numbers the driver could not decode when this driver key's image was
# read. Upload and export rebuild a fresh radio from the cached bytes, and a
# decode failure that was one-shot or instance-local does not repeat on that
# instance -- so the read-before-erase guard alone would let the slot be erased
# for being absent from the grid. It was never in the grid to begin with, so it
# is recorded here at extraction time and subtracted from the erase candidates.
UNREADABLE_BY_DRIVER: dict[str, set[int]] = {}


def _driver_cache_key(module_name: str, class_name: str) -> str:
    """Build a stable key for cached image data by selected driver."""
    return f"{module_name}.{class_name}"


def _cache_driver_image(
    module_name: str, class_name: str, radio: chirp_common.Radio
) -> bytes:
    """Cache a radio's image bytes together with the class that owns them.

    The two entries are one fact split across two dicts -- consumers re-parse
    the bytes with the recorded class -- so they have to move together. That is
    why every writer goes through here and why serialization happens first: if
    save_mmap() raises, a caller that had already recorded the class would
    leave the *previous* download's bytes tagged with this radio's class, and a
    later upload or export would decode them against the wrong layout.
    """
    image = _image_bytes_from_radio(radio)
    driver_key = _driver_cache_key(module_name, class_name)
    IMAGE_CLASS_BY_DRIVER[driver_key] = radio.__class__
    LAST_IMAGE_BY_DRIVER[driver_key] = image
    return image


def _record_unreadable_channels(
    module_name: str, class_name: str, numbers: Sequence[int]
) -> None:
    """Record which memories failed to decode for this driver key.

    Always overwrites, including with an empty list: a later clean read of the
    same radio has to drop protection that no longer applies, or a slot stays
    un-erasable for the rest of the session.
    """
    UNREADABLE_BY_DRIVER[_driver_cache_key(module_name, class_name)] = set(numbers)


def _protected_channels(module_name: str, class_name: str) -> set[int]:
    """Return memory numbers that must not be erased for this driver key."""
    return UNREADABLE_BY_DRIVER.get(_driver_cache_key(module_name, class_name), set())


def _cached_image_class(
    module_name: str, class_name: str, radio_cls: type
) -> type:
    """Return the class that should re-parse this driver key's cached image.

    Falls back to the selected class when nothing has been cached under this
    key, or when the cache came from a path that had no better answer.
    """
    return (
        IMAGE_CLASS_BY_DRIVER.get(_driver_cache_key(module_name, class_name))
        or radio_cls
    )


def _radio_from_image_bytes(
    radio_cls: type[chirp_common.Radio], image_bytes: bytes
) -> chirp_common.Radio:
    """Load stored image bytes through CHIRP's driver file-loading path.

    This keeps reconstruction paired with ``_image_bytes_from_radio`` and lets
    each driver apply its normal file parsing and metadata handling.
    """
    with tempfile.NamedTemporaryFile(
        mode="wb", suffix=".img", prefix="webchirp-cache-", delete=False
    ) as image_file:
        image_path = image_file.name
        image_file.write(bytes(image_bytes))
    try:
        return radio_cls(image_path)
    finally:
        try:
            os.unlink(image_path)
        except Exception:
            pass


def _image_bytes_from_radio(radio: chirp_common.Radio) -> bytes:
    """Serialize through CHIRP without confusing a transport map for a file.

    Icom's ``get_mmap`` may flip high bits for clone transport, while
    ``save_mmap`` writes the internal file representation expected on reload.
    """
    with tempfile.NamedTemporaryFile(
        suffix=".img", prefix="webchirp-cache-", delete=False
    ) as image_file:
        image_path = image_file.name
    try:
        radio.save_mmap(image_path)
        with open(image_path, "rb") as image_file:
            return image_file.read()
    finally:
        try:
            os.unlink(image_path)
        except Exception:
            pass


def _has_cached_image(module_name: str, class_name: str) -> bool:
    """Report whether runtime currently has a cached image for this driver."""
    driver_key = _driver_cache_key(module_name, class_name)
    return driver_key in LAST_IMAGE_BY_DRIVER


def _best_effort_radio_instance(module_name: str, class_name: str, require_cached: Any=False) -> Any:
    """Instantiate a radio with cached data when available, otherwise best-effort blank state."""
    radio_cls = runtime_drivers._import_radio_class(module_name, class_name)
    driver_key = _driver_cache_key(module_name, class_name)
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)

    def _fallback_constructor() -> Any:
        try:
            return radio_cls(None)
        except Exception:
            return radio_cls("")

    if base_image is not None:
        radio = _radio_from_image_bytes(
            _cached_image_class(module_name, class_name, radio_cls), base_image
        )
    elif issubclass(radio_cls, chirp_common.CloneModeRadio):
        memsize = int(getattr(radio_cls, "_memsize", 0) or 0)
        if memsize > 0:
            radio = radio_cls(memmap.MemoryMapBytes(bytes(memsize)))
        elif require_cached:
            raise runtime_support.RuntimeUnsupportedError(
                "No cached radio image for this model. Download from radio first."
            )
        else:
            radio = _fallback_constructor()
    else:
        radio = _fallback_constructor()

    radio.status_fn = runtime_serial._make_status_logger()
    return radio


def _download_selected_radio_sync(module_name: str, class_name: str) -> Any:
    """Run selected driver's sync_in and return rows + cached image state."""
    radio_cls = runtime_drivers._import_radio_class(module_name, class_name)
    runtime_serial._ensure_clone_mode_radio(radio_cls)

    runtime_serial._prepare_clone_session(radio_cls)
    radio = runtime_serial._create_radio_for_serial(radio_cls)
    radio.sync_in()
    # The image belongs to whatever detection settled on, not to the selection
    # the user made in the UI, and upload/export have to re-parse it as such.
    _cache_driver_image(module_name, class_name, radio)

    rows, unreadable = runtime_validation._radio_rows_from_instance(radio)
    _record_unreadable_channels(module_name, class_name, unreadable)
    csv_text = runtime_channels.normalize_rows(rows, module_name, class_name)
    settings_result = runtime_settings._validate_and_apply_radio_settings(radio, [], apply_changes=False)
    return {
        "rows": rows,
        "headers": runtime_support.CSV_HEADERS,
        "csvText": csv_text,
        "settings": settings_result["settings"],
        "unreadableChannels": unreadable,
    }


def _upload_selected_radio_sync(
    module_name: str,
    class_name: str,
    rows: runtime_support.Rows,
    settings_groups: Optional[Sequence[Any]] = None,
) -> dict[str, Any]:
    """Apply rows onto cached image and run selected driver's sync_out."""
    radio_cls = runtime_drivers._import_radio_class(module_name, class_name)
    runtime_serial._ensure_clone_mode_radio(radio_cls)
    driver_key = _driver_cache_key(module_name, class_name)
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    if not base_image:
        raise runtime_support.RuntimeUnsupportedError(
            "No cached radio image for this model. Download from radio first, then upload."
        )
    # CHIRP does not re-detect on upload -- the class that downloaded the image
    # is the one that writes it back, and drivers like ga510 send their own
    # program handshake from do_upload().
    image_cls = _cached_image_class(module_name, class_name, radio_cls)
    radio = _radio_from_image_bytes(image_cls, base_image)
    radio.status_fn = runtime_serial._make_status_logger()
    radio.set_pipe(runtime_serial._new_serial_pipe(image_cls))
    runtime_validation._apply_rows_to_radio_instance(radio, rows, module_name, class_name)
    settings_result = runtime_settings._validate_and_apply_radio_settings(
        radio, settings_groups or [], apply_changes=True
    )
    if not settings_result["valid"]:
        raise runtime_support.RuntimeUnsupportedError("Radio settings validation failed before upload")
    runtime_serial._prepare_clone_session(image_cls)
    radio.sync_out()
    _cache_driver_image(module_name, class_name, radio)
    return {"uploaded": True, "settings": settings_result["settings"]}


async def download_selected_radio(module_name: str, class_name: str) -> dict[str, Any]:
    """Async wrapper for selected-radio download operation."""
    return _download_selected_radio_sync(module_name, class_name)


async def upload_selected_radio(
    module_name: str,
    class_name: str,
    rows: runtime_support.Rows,
    settings_groups: Optional[Sequence[Any]] = None,
) -> dict[str, Any]:
    """Async wrapper for selected-radio upload operation."""
    return _upload_selected_radio_sync(module_name, class_name, rows, settings_groups)


def get_cached_image_base64(module_name: str, class_name: str) -> Any:
    """Return cached clone image bytes for a driver as base64 text."""
    driver_key = _driver_cache_key(module_name, class_name)
    image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    if not image:
        raise runtime_support.RuntimeUnsupportedError(
            "No cached radio image for this model. Download from radio first."
        )
    return {
        "imageBase64": base64.b64encode(bytes(image)).decode("ascii"),
        "size": len(image),
    }


def upload_image_base64(module_name: str, class_name: str, image_b64: str) -> Any:
    """Upload an explicit full-image payload through the selected clone driver."""
    radio_cls = runtime_drivers._import_radio_class(module_name, class_name)
    runtime_serial._ensure_clone_mode_radio(radio_cls)
    try:
        raw_image = base64.b64decode(str(image_b64 or ""), validate=True)
    except Exception as exc:
        raise runtime_support.RuntimeUnsupportedError("Invalid image base64 payload") from exc

    radio = _radio_from_image_bytes(radio_cls, raw_image)
    radio.status_fn = runtime_serial._make_status_logger()
    radio.set_pipe(runtime_serial._new_serial_pipe(radio_cls))
    runtime_serial._prepare_clone_session(radio_cls)
    radio.sync_out()

    # This image came from the caller, parsed as the selected class, so it
    # replaces any variant class a previous download had recorded.
    _cache_driver_image(module_name, class_name, radio)
    return {"uploaded": True, "size": len(raw_image)}


def export_image_base64(
    module_name: str,
    class_name: str,
    rows: runtime_support.Rows,
    settings_groups: Optional[Sequence[Any]] = None,
) -> dict[str, Any]:
    """Build a CHIRP .img payload from rows for selected clone-mode driver."""
    radio_cls = runtime_drivers._import_radio_class(module_name, class_name)
    runtime_serial._ensure_clone_mode_radio(radio_cls)
    driver_key = _driver_cache_key(module_name, class_name)
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)
    had_cached_image = bool(base_image)
    if not base_image:
        memsize = int(getattr(radio_cls, "_memsize", 0) or 0)
        if memsize <= 0:
            raise runtime_support.RuntimeUnsupportedError(
                "Driver does not expose memory size for offline image export"
            )
        base_image = bytes(memsize)

    radio = _radio_from_image_bytes(
        _cached_image_class(module_name, class_name, radio_cls), base_image
    )
    runtime_validation._apply_rows_to_radio_instance(radio, rows or [], module_name, class_name)
    settings_result = runtime_settings._validate_and_apply_radio_settings(
        radio, settings_groups or [], apply_changes=True
    )
    if not settings_result["valid"]:
        raise runtime_support.RuntimeUnsupportedError("Radio settings validation failed before export")
    # An offline export starts from fabricated zero bytes, not from the radio.
    # Return that file to the user, but do not let it satisfy the upload gate or
    # expose synthetic radio-wide settings as though they had been downloaded.
    image_data = (
        _cache_driver_image(module_name, class_name, radio)
        if had_cached_image
        else _image_bytes_from_radio(radio)
    )
    return {
        "imageBase64": base64.b64encode(image_data).decode("ascii"),
        "size": len(image_data),
        "vendor": str(getattr(radio_cls, "VENDOR", "")),
        "model": str(getattr(radio_cls, "MODEL", "")),
        "variant": str(getattr(radio_cls, "VARIANT", "")),
        "settings": settings_result["settings"],
    }


def read_image_metadata_base64(image_b64: str) -> Any:
    """Parse the CHIRP metadata trailer from a .img payload without importing drivers."""
    try:
        raw_image = base64.b64decode(str(image_b64 or ""), validate=True)
    except Exception as exc:
        raise runtime_support.RuntimeUnsupportedError("Invalid image base64 payload") from exc

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
    try:
        raw_image = base64.b64decode(str(image_b64 or ""), validate=True)
    except Exception as exc:
        raise runtime_support.RuntimeUnsupportedError("Invalid image base64 payload") from exc

    with tempfile.NamedTemporaryFile(
        mode="wb", suffix=".img", prefix="webchirp-", delete=False
    ) as f:
        image_path = f.name
        f.write(raw_image)

    try:
        radio = directory.get_radio_by_image(image_path)
    except Exception as exc:
        raise runtime_support.ImageDetectionError(f"Unable to detect radio from image: {exc}") from exc
    finally:
        try:
            os.unlink(image_path)
        except Exception:
            pass

    if not isinstance(radio, chirp_common.CloneModeRadio):
        raise runtime_support.RuntimeUnsupportedError("Loaded image is not a clone-mode CHIRP image")

    base_cls = getattr(radio.__class__, "_orig_rclass", radio.__class__)
    module_short = str(base_cls.__module__).rsplit(".", 1)[-1]
    class_name = str(base_cls.__name__)
    _cache_driver_image(module_short, class_name, radio)
    rows, unreadable = runtime_validation._radio_rows_from_instance(radio)
    _record_unreadable_channels(module_short, class_name, unreadable)
    settings_result = runtime_settings._validate_and_apply_radio_settings(radio, [], apply_changes=False)
    return {
        "module": module_short,
        "className": class_name,
        "vendor": str(getattr(radio.__class__, "VENDOR", "")),
        "model": str(getattr(radio.__class__, "MODEL", "")),
        "variant": str(getattr(radio.__class__, "VARIANT", "")),
        "rows": rows,
        "headers": runtime_support.CSV_HEADERS,
        "settings": settings_result["settings"],
        "unreadableChannels": unreadable,
    }
