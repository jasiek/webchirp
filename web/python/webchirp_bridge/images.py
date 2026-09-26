"""CHIRP ``.img`` files: loading one into a session, and exporting one from it.

Images cross the JS boundary as base64. Loading reads the metadata trailer
first so the browser can import just the matching driver, then falls back
to CHIRP's ``match_model`` sweep over every imported driver, and opens a new
radio session for whichever driver the image turns out to need; exporting
rebuilds a radio from the session's image and applies the grid's rows and
settings before serializing it, the same way an upload would.
"""

from __future__ import annotations

import base64
from typing import TYPE_CHECKING

from chirp import (
    chirp_common,
    directory,
)

from webchirp_bridge.clone import _ensure_clone_mode_radio
from webchirp_bridge.driver_cache import (
    _radio_from_image_bytes,
    _record_session_image,
    _temp_image_path,
)
from webchirp_bridge.radio_memories import (
    _apply_rows_to_radio_instance,
    _read_radio_payload,
)
from webchirp_bridge.radio_settings import _validate_and_apply_radio_settings
from webchirp_bridge.runtime_errors import ImageDetectionError, RuntimeUnsupportedError
from webchirp_bridge.session import ImageOrigin, open_radio_session, resolve_session

if TYPE_CHECKING:
    from typing import Any, Optional, Sequence
    from webchirp_bridge.channel_rows import Rows

def _decode_image_b64(image_b64: str) -> bytes:
    """Decode an image the browser sent as base64, refusing a malformed payload."""
    try:
        return base64.b64decode(str(image_b64 or ""), validate=True)
    except Exception as exc:
        raise RuntimeUnsupportedError("Invalid image base64 payload") from exc


def _image_payload(image: bytes) -> dict[str, Any]:
    """The two fields every image-returning reply shares: base64 text and byte size."""
    return {"imageBase64": base64.b64encode(bytes(image)).decode("ascii"), "size": len(image)}


def get_cached_image_base64(session_id: str) -> dict[str, Any]:
    """RPC: return the session's radio image as base64 text.

    Only an image read from the radio or a file counts; a synthetic export is
    not a codeplug anyone should save as one.
    """
    image = resolve_session(session_id).backing_image
    if not image:
        raise RuntimeUnsupportedError(
            "No cached radio image for this model. Download from radio first."
        )
    return _image_payload(image)


def export_image_base64(
    session_id: str,
    rows: Rows,
    settings_groups: Optional[Sequence[Any]] = None,
) -> dict[str, Any]:
    """RPC: build a CHIRP .img payload from rows for the session's clone-mode driver.

    With no image on the session the export starts from fabricated zero
    bytes. That file is returned to the user, and recorded on the session as
    ``ImageOrigin.SYNTHETIC`` so the runtime can say what the last export was
    made from -- but it never becomes a backing image, so the upload and
    settings gates stay closed (FINDINGS: offline-export-is-not-a-radio-image).
    """
    session = resolve_session(session_id)
    radio_cls = session.radio_cls
    _ensure_clone_mode_radio(radio_cls)
    base_image = session.backing_image
    origin = session.image_origin
    if not base_image:
        memsize = int(getattr(radio_cls, "_memsize", 0) or 0)
        if memsize <= 0:
            raise RuntimeUnsupportedError(
                "Driver does not expose memory size for offline image export"
            )
        base_image = bytes(memsize)
        origin = ImageOrigin.SYNTHETIC

    radio = _radio_from_image_bytes(session.image_cls, base_image)
    _apply_rows_to_radio_instance(radio, rows or [], session)
    settings_result = _validate_and_apply_radio_settings(
        radio, settings_groups or [], apply_changes=True
    )
    if not settings_result["valid"]:
        raise RuntimeUnsupportedError("Radio settings validation failed before export")
    image_data = _record_session_image(session, radio, origin)
    return {
        **_image_payload(image_data),
        "vendor": str(getattr(radio_cls, "VENDOR", "")),
        "model": str(getattr(radio_cls, "MODEL", "")),
        "variant": str(getattr(radio_cls, "VARIANT", "")),
        "settings": settings_result["settings"],
    }


def read_image_metadata_base64(image_b64: str) -> dict[str, Any]:
    """RPC: parse the CHIRP metadata trailer from a .img payload without importing drivers."""
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
    """RPC: load a CHIRP .img payload into a new session for the driver it detects.

    The image decides the driver, so the session is opened here rather than
    by the caller: the reply carries its ``sessionId`` for the browser to
    adopt in place of whatever radio was selected before the load, along with
    the rows, settings and radio identity the image holds.
    """
    raw_image = _decode_image_b64(image_b64)

    with _temp_image_path(raw_image, prefix="webchirp-") as image_path:
        try:
            radio = directory.get_radio_by_image(image_path)
        except Exception as exc:
            raise ImageDetectionError(f"Unable to detect radio from image: {exc}") from exc

    if not isinstance(radio, chirp_common.CloneModeRadio):
        raise RuntimeUnsupportedError("Loaded image is not a clone-mode CHIRP image")

    # get_radio_by_image may answer with a DynamicRadioAlias subclass; the
    # session is opened for the catalog's own class and records the alias as
    # the class that parses these bytes.
    base_cls = getattr(radio.__class__, "_orig_rclass", radio.__class__)
    module_short = str(base_cls.__module__).rsplit(".", 1)[-1]
    class_name = str(base_cls.__name__)
    session = open_radio_session(module_short, class_name)
    return {
        "sessionId": session.session_id,
        "module": module_short,
        "className": class_name,
        "vendor": str(getattr(radio.__class__, "VENDOR", "")),
        "model": str(getattr(radio.__class__, "MODEL", "")),
        "variant": str(getattr(radio.__class__, "VARIANT", "")),
        **_read_radio_payload(session, radio, ImageOrigin.FILE),
    }
