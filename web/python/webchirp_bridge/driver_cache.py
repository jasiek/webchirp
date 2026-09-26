"""Radios built from a session's state, and the image plumbing behind them.

A download records the clone image it read on its ``RadioSession``
(web/python/webchirp_bridge/session.py); upload, export and the settings
panel rebuild a fresh radio from those bytes rather than keeping the
downloaded instance around. The instance builders here are the only place a
driver is constructed from a session's image or from nothing, so the
fallbacks for drivers that misbehave on blank state live here too, as does
the serialization that turns a radio back into the bytes a session keeps.
"""

from __future__ import annotations

import contextlib
import os
import tempfile
from typing import TYPE_CHECKING

from chirp import (
    chirp_common,
    memmap,
)

from webchirp_bridge.jsbridge import _make_status_logger

if TYPE_CHECKING:
    from typing import Callable, Iterator, Optional
    from webchirp_bridge.session import ImageOrigin, RadioSession


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


def _driver_radio_factories(
    session: RadioSession,
) -> list[Callable[[], chirp_common.Radio]]:
    """Ways to instantiate this session's driver, the most faithful to the radio first.

    The session's image comes first because some drivers read their
    capabilities out of the codeplug: ``Rt98Radio`` advertises the PMR power
    levels (Low = 0.5W) on a blank instance and the full Low/Mid/High set once
    an image is parsed, so a blank instance reports levels the loaded radio
    does not have. CHIRP always takes features from the open image, so
    anything describing the selected radio has to do the same. The two blank
    constructors behind it are the no-image fallbacks (see
    ``_blank_radio_instance``), kept as separate factories so a driver that
    refuses one is still reachable through the other.
    """
    radio_cls = session.radio_cls
    factories: list[Callable[[], chirp_common.Radio]] = [
        lambda: radio_cls(None),
        lambda: radio_cls(""),
    ]
    image = session.backing_image
    if image:
        image_cls = session.image_cls
        factories.insert(0, lambda: _radio_from_image_bytes(image_cls, image))
    return factories


def _cached_or_blank_radio_instance(
    session: Optional[RadioSession],
) -> Optional[chirp_common.Radio]:
    """The first instantiation of this session's driver that can describe itself.

    An instance only counts once ``get_features()`` works on it, because that
    is the one thing every caller wants from it: a driver that parses the
    session's image but cannot report features from it is no more usable than
    one that failed to parse at all, and both have to fall through to blank
    state. Returns None when nothing works, or when there is no session --
    callers that need an instance decide for themselves whether that is an
    error.
    """
    if session is None:
        return None
    for factory in _driver_radio_factories(session):
        try:
            radio = factory()
            radio.get_features()
            return radio
        except Exception:
            continue
    return None


def _driver_features(session: Optional[RadioSession]) -> Optional[chirp_common.RadioFeatures]:
    """Return the session driver's RadioFeatures, preferring its image."""
    radio = _cached_or_blank_radio_instance(session)
    return radio.get_features() if radio is not None else None


def _record_session_image(
    session: RadioSession, radio: chirp_common.Radio, origin: ImageOrigin
) -> bytes:
    """Serialize a radio and make its bytes the session's image.

    Every writer goes through here so serialization happens before the session
    changes: if save_mmap() raises, the session keeps the previous image and
    the class that parsed it, rather than the old bytes tagged with this
    radio's class -- which a later upload or export would decode against the
    wrong layout. The origin says what the bytes are evidence of; see
    ``ImageOrigin`` in web/python/webchirp_bridge/session.py.
    """
    image = _image_bytes_from_radio(radio)
    session.record_image(image, radio.__class__, origin)
    return image


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


def _best_effort_radio_instance(session: RadioSession) -> chirp_common.Radio:
    """Instantiate the session's radio from its image, else a best-effort blank state.

    The blank fallback for a clone-mode driver is a zeroed memory map of the
    driver's declared size, which parses where ``radio_cls(None)`` would leave
    the memory object unset; drivers without a size take the plain blank
    constructor. Only the session's backing image counts -- a synthetic export
    is never a base to read settings or channel extras from.
    """
    radio_cls = session.radio_cls
    base_image = session.backing_image

    if base_image is not None:
        radio = _radio_from_image_bytes(session.image_cls, base_image)
    elif issubclass(radio_cls, chirp_common.CloneModeRadio):
        memsize = int(getattr(radio_cls, "_memsize", 0) or 0)
        if memsize > 0:
            radio = radio_cls(memmap.MemoryMapBytes(bytes(memsize)))
        else:
            radio = _blank_radio_instance(radio_cls)
    else:
        radio = _blank_radio_instance(radio_cls)

    radio.status_fn = _make_status_logger()
    return radio
