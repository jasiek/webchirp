"""Per-driver state that outlives one RPC call, and radios built from it.

A download caches the clone image it read; upload, export and the settings
panel rebuild a fresh radio from those bytes rather than keeping the
downloaded instance around, so the cache -- keyed by ``module:class`` -- is
the runtime's memory of the radio between calls. Alongside the bytes it
records which class actually parsed them (detection can resolve to a
variant subclass) and which memory numbers could not be decoded, both of
which the later calls need to reproduce the download faithfully. The
instance builders here are the only place a driver is constructed from an
image or from nothing, so the fallbacks for drivers that misbehave on blank
state live here too.
"""

from __future__ import annotations

import os
import tempfile
from typing import Optional, Sequence

from chirp import (
    chirp_common,
    memmap,
)

from webchirp_bridge.jsbridge import _make_status_logger
from webchirp_bridge.runtime_errors import RuntimeUnsupportedError


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


def _driver_features(module_name: str, class_name: str) -> Optional[chirp_common.RadioFeatures]:
    """Return a driver's RadioFeatures, preferring the cached image.

    Some drivers read their capabilities out of the codeplug: ``Rt98Radio``
    advertises the PMR power levels (Low = 0.5W) on a blank instance and the
    full Low/Mid/High set once an image is parsed, so a blank instance reports
    levels the loaded radio does not have. CHIRP always takes features from the
    open image, so use the cached one when there is one.
    """
    if not module_name or not class_name:
        return None
    try:
        radio_cls = _import_radio_class(module_name, class_name)
    except Exception:
        return None

    image = LAST_IMAGE_BY_DRIVER.get(_driver_cache_key(module_name, class_name))
    factories = [lambda: radio_cls(None), lambda: radio_cls("")]
    if image:
        image_cls = _cached_image_class(module_name, class_name, radio_cls)
        factories.insert(0, lambda: _radio_from_image_bytes(image_cls, image))
    for factory in factories:
        try:
            return factory().get_features()
        except Exception:
            continue
    return None


def _import_radio_class(
    module_name: str, class_name: str
) -> type[chirp_common.Radio]:
    """Resolve a radio class object from selected module/class names."""
    module = __import__(f"chirp.drivers.{module_name}", fromlist=[class_name])
    return getattr(module, class_name)


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


def _best_effort_radio_instance(
    module_name: str, class_name: str, require_cached: bool = False
) -> chirp_common.Radio:
    """Instantiate a radio with cached data when available, otherwise best-effort blank state."""
    radio_cls = _import_radio_class(module_name, class_name)
    driver_key = _driver_cache_key(module_name, class_name)
    base_image = LAST_IMAGE_BY_DRIVER.get(driver_key)

    def _fallback_constructor() -> chirp_common.Radio:
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
            raise RuntimeUnsupportedError(
                "No cached radio image for this model. Download from radio first."
            )
        else:
            radio = _fallback_constructor()
    else:
        radio = _fallback_constructor()

    radio.status_fn = _make_status_logger()
    return radio
