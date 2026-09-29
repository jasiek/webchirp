"""The file detour between a radio instance and its image bytes.

CHIRP parses bytes only through a driver's own loader (``radio_cls(path)``),
detects a radio (``get_radio_by_image``) and serializes (``save_mmap``) via a
file path, so every image that passes through the runtime takes this detour.
This module is that detour and nothing else: a throwaway path, a radio from
bytes, bytes from a radio, and the blank constructor CHIRP's model picker
uses. Which of them a radio is built with is the session's decision
(``RadioSession.radio_instance()`` and friends in
web/python/webchirp_bridge/session.py); this module imports nothing from
there so the session can import it.
"""

from __future__ import annotations

import contextlib
import os
import tempfile
from typing import TYPE_CHECKING

from chirp import chirp_common

if TYPE_CHECKING:
    from typing import Iterator, Optional


def _blank_radio_instance(radio_cls: type[chirp_common.Radio]) -> chirp_common.Radio:
    """Instantiate a driver with no image, the way CHIRP's model picker does.

    radio_cls(None) is the documented blank constructor, but a few drivers
    only accept a path-like argument and fail on None; the empty string is the
    fallback that gets those to a usable blank state (FINDINGS:
    blank-instances-misreport-state).
    """
    try:
        return radio_cls(None)
    except Exception:
        return radio_cls("")


@contextlib.contextmanager
def _temp_image_path(
    data: Optional[bytes] = None, prefix: str = "webchirp-cache-"
) -> Iterator[str]:
    """A throwaway .img path for CHIRP to read or write, removed on exit.

    CHIRP only parses bytes through a driver's own loader (``radio_cls(path)``),
    detects a radio (``get_radio_by_image``) or serializes (``save_mmap``) via a
    file path, so every image that passes through the runtime takes this
    detour. ``data`` seeds the file when CHIRP is the one reading it.
    """
    with tempfile.NamedTemporaryFile(
        mode="wb", suffix=".img", prefix=prefix, delete=False
    ) as image_file:
        image_path = image_file.name
        if data is not None:
            image_file.write(bytes(data))
    try:
        yield image_path
    finally:
        with contextlib.suppress(Exception):
            os.unlink(image_path)


def _radio_from_image_bytes(
    radio_cls: type[chirp_common.Radio], image_bytes: bytes
) -> chirp_common.Radio:
    """Load stored image bytes through CHIRP's driver file-loading path.

    This keeps reconstruction paired with ``_image_bytes_from_radio`` and lets
    each driver apply its normal file parsing and metadata handling.
    """
    with _temp_image_path(image_bytes) as image_path:
        return radio_cls(image_path)


def _image_bytes_from_radio(radio: chirp_common.Radio) -> bytes:
    """Serialize through CHIRP without confusing a transport map for a file.

    Icom's ``get_mmap`` may flip high bits for clone transport, while
    ``save_mmap`` writes the internal file representation expected on reload.
    """
    with _temp_image_path() as image_path:
        radio.save_mmap(image_path)
        with open(image_path, "rb") as image_file:
            return image_file.read()
