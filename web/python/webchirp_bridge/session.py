"""The radio the user is working on, as one object that outlives an RPC call.

Every radio-bound RPC method takes a ``session_id`` and resolves it here. A
``RadioSession`` owns everything the runtime remembers about one radio
between calls: the driver the user selected, the class a clone's detection
or an image's metadata actually resolved to, the clone image and where it
came from, and the memory numbers the driver could not decode when that
image was read. Before this module those facts lived in three module-level
dicts keyed by ``module:class`` and were shared by every caller that named
the same driver, which is how a synthetic offline export came to satisfy the
upload gate and how switching radios could never let go of an old image.

The registry maps ids to open sessions. ``open_session`` and
``close_session`` are the only RPC methods here; JS opens one when a radio is
selected and closes it when the selection moves on, so a response for a
session that is no longer open can be told from a current one by identity.

The id is the only thing that crosses the JS boundary: a radio-bound RPC
method resolves it once, at its entry point, and everything below takes the
``RadioSession`` itself. The session is also the only place a driver is
instantiated from its state -- ``radio_instance()``, ``describing_instance()``
and ``features()`` -- and the only place a radio's bytes are recorded back
onto it (``record_radio()``), so no helper builds a radio from module and
class names or from bytes it fetched itself. The file plumbing those methods
use (CHIRP reads and writes images only through paths) is in
web/python/webchirp_bridge/radio_files.py, which imports nothing from here,
so the package graph stays acyclic.
"""

from __future__ import annotations

import importlib
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

from chirp import chirp_common

from webchirp_bridge.radio_files import (
    _blank_radio_instance,
    _image_bytes_from_radio,
    _radio_from_image_bytes,
)
from webchirp_bridge.jsbridge import _make_status_logger
from webchirp_bridge.runtime_errors import RuntimePreconditionError

if TYPE_CHECKING:
    from typing import Any, Callable, Iterable, Optional


class ImageOrigin(str, Enum):
    """Where a session's image bytes came from, which decides what they may back.

    Only bytes read from a radio or loaded from a file are evidence that the
    radio's settings, calibration and ident regions were ever seen; those two
    are the origins an upload may write from and a settings panel may parse.
    A ``SYNTHETIC`` image is what an offline export builds from zeroes when
    there is nothing else -- a file the user may keep, never a base for a
    hardware write (FINDINGS: offline-export-is-not-a-radio-image).
    """

    NONE = "none"
    RADIO = "radio"
    FILE = "file"
    SYNTHETIC = "synthetic"


# The origins whose bytes are a real codeplug: the upload gate, the settings
# gate and the image-backed instance builders all ask the same question.
BACKING_ORIGINS = frozenset({ImageOrigin.RADIO, ImageOrigin.FILE})


def _import_radio_class(
    module_name: str, class_name: str
) -> type[chirp_common.Radio]:
    """Resolve a radio class object from selected module/class names."""
    module = importlib.import_module(f"chirp.drivers.{module_name}")
    return getattr(module, class_name)


@dataclass
class RadioSession:
    """One radio's state between RPC calls; see the module docstring.

    ``radio_cls`` is what the user selected. ``detected_cls`` is set when a
    clone's ``detect_from_serial`` or an image's metadata resolves that
    selection to a variant subclass with a different codeplug layout: the
    cached bytes belong to that class and must be re-parsed by it, never by
    the parent the user picked (FINDINGS: detection-is-part-of-the-clone).
    ``unreadable_channels`` are the numbers ``get_memory`` raised on when the
    image was read; they were never in the grid, so their absence from the
    rows is not a deletion and the upload path must not erase them.
    """

    session_id: str
    module_name: str
    class_name: str
    radio_cls: type[chirp_common.Radio]
    detected_cls: Optional[type[chirp_common.Radio]] = None
    image: Optional[bytes] = None
    image_origin: ImageOrigin = ImageOrigin.NONE
    unreadable_channels: set[int] = field(default_factory=set)

    @classmethod
    def for_driver(cls, module_name: str, class_name: str) -> RadioSession:
        """A session-shaped view of a driver that was never opened.

        For callers that describe a driver without a user working on it -- the
        catalog's feature sweep -- so the instance builders have one parameter
        type. It is not registered and carries no state; its id is empty.
        """
        return cls(
            session_id="",
            module_name=module_name,
            class_name=class_name,
            radio_cls=_import_radio_class(module_name, class_name),
        )

    @property
    def image_cls(self) -> type[chirp_common.Radio]:
        """The class that parses this session's image: the detected one, else the selected."""
        return self.detected_cls or self.radio_cls

    @property
    def has_backing_image(self) -> bool:
        """Whether the session holds bytes that were read from a radio or a file."""
        return self.image is not None and self.image_origin in BACKING_ORIGINS

    @property
    def backing_image(self) -> Optional[bytes]:
        """The image an upload may write and a settings panel may parse, or None.

        A synthetic image is deliberately not returned: it is stored so the
        session can say what the last export was made from, but nothing that
        needs a real codeplug may build on it.
        """
        return self.image if self.has_backing_image else None

    def record_image(
        self,
        image: bytes,
        parsed_by: type[chirp_common.Radio],
        origin: ImageOrigin,
    ) -> None:
        """Adopt image bytes together with the class that produced them.

        The bytes and the class are one fact: re-parsing the bytes with any
        other class decodes the wrong fields. Callers serialize before calling
        this, so a failed ``save_mmap`` leaves the previous image and its class
        intact rather than tagging old bytes with a new class.
        """
        self.image = bytes(image)
        self.image_origin = origin
        self.detected_cls = parsed_by if parsed_by is not self.radio_cls else None

    def record_radio(self, radio: chirp_common.Radio, origin: ImageOrigin) -> bytes:
        """Serialize a radio and make its bytes this session's image.

        Every writer goes through here so serialization happens before the
        session changes: if ``save_mmap()`` raises, the session keeps the
        previous image and the class that parsed it, rather than the old bytes
        tagged with this radio's class -- which a later upload or export would
        decode against the wrong layout. The origin says what the bytes are
        evidence of; see ``ImageOrigin``.
        """
        image = _image_bytes_from_radio(radio)
        self.record_image(image, radio.__class__, origin)
        return image

    def radio_instance(self) -> chirp_common.Radio:
        """The radio every read and write of this session's state goes through.

        Built from the backing image when there is one, by the class that
        parsed it, so a detected variant's layout is honoured. Without one, the
        best blank state the driver has: a clone-mode driver's declared memory
        size as zeroes, loaded through CHIRP's own file path so the driver
        picks its map type and parses where ``radio_cls(None)`` would leave the
        map unset; drivers without a size take the plain blank constructor. A
        synthetic export is never the base -- it is not a codeplug anyone read.
        An image that will not parse raises rather than falling back: this is
        the instance rows and settings are read from and written to, and blank
        state here would silently be a different radio (see
        ``describing_instance`` for the tolerant builder).
        """
        radio_cls = self.radio_cls
        base_image = self.backing_image
        if base_image is not None:
            radio = _radio_from_image_bytes(self.image_cls, base_image)
        elif issubclass(radio_cls, chirp_common.CloneModeRadio) and self.memory_size > 0:
            radio = _radio_from_image_bytes(radio_cls, bytes(self.memory_size))
        else:
            radio = _blank_radio_instance(radio_cls)
        radio.status_fn = _make_status_logger()
        return radio

    def describing_instance(self) -> Optional[chirp_common.Radio]:
        """The first instantiation of this driver that can describe itself, or None.

        For everything derived from ``get_features()``: the image comes first
        because some drivers read their capabilities out of the codeplug --
        ``Rt98Radio`` advertises the PMR power levels (Low = 0.5W) blank and
        the full Low/Mid/High set once an image is parsed, and CHIRP always
        takes features from the open image. An instance only counts once
        ``get_features()`` works on it, since that is the one thing every
        caller wants; one that parses the image but cannot report features from
        it falls through to the two blank constructors like a failed parse
        (FINDINGS: blank-instances-misreport-state). None when nothing works --
        callers decide whether that is an error.
        """
        radio_cls = self.radio_cls
        factories: list[Callable[[], chirp_common.Radio]] = [
            lambda: radio_cls(None),
            lambda: radio_cls(""),
        ]
        image = self.backing_image
        if image:
            image_cls = self.image_cls
            factories.insert(0, lambda: _radio_from_image_bytes(image_cls, image))
        for factory in factories:
            try:
                radio = factory()
                radio.get_features()
                return radio
            except Exception:
                continue
        return None

    def features(self) -> Optional[chirp_common.RadioFeatures]:
        """This driver's RadioFeatures, read from its image when it has one, else None."""
        radio = self.describing_instance()
        return radio.get_features() if radio is not None else None

    @property
    def memory_size(self) -> int:
        """The clone image size the driver declares, or 0 for one that declares none."""
        return int(getattr(self.radio_cls, "_memsize", 0) or 0)

    def record_unreadable_channels(self, numbers: Iterable[int]) -> None:
        """Record which memories failed to decode when the image was read.

        Always overwrites, including with nothing: a later clean read of the
        same radio has to drop protection that no longer applies, or a slot
        stays un-erasable for the rest of the session.
        """
        self.unreadable_channels = {int(number) for number in numbers}

    def describe(self) -> dict[str, Any]:
        """The session as JSON for the browser and the tests: identity and state, no bytes."""
        return {
            "sessionId": self.session_id,
            "module": self.module_name,
            "className": self.class_name,
            "detectedClass": self.detected_cls.__name__ if self.detected_cls else "",
            "imageOrigin": self.image_origin.value,
            "hasBackingImage": self.has_backing_image,
            "imageSize": len(self.image) if self.image is not None else 0,
            "unreadableChannels": sorted(self.unreadable_channels),
        }


# Every open session by id. Sessions are opened and closed by the browser (and
# by the test harness), so an entry here is a radio someone is still working on.
_SESSIONS: dict[str, RadioSession] = {}


def _new_session_id(module_name: str, class_name: str) -> str:
    """An id that names its driver for the debug panel and is unique per interpreter.

    The random suffix rather than a counter: the isolated Quansheng runtime
    boots one interpreter per release, and an id that only counted would be
    reused by the next interpreter for the same driver while the JS side still
    maps ids to interpreters.
    """
    return f"{module_name}.{class_name}:{uuid.uuid4().hex[:12]}"


def open_radio_session(module_name: str, class_name: str) -> RadioSession:
    """Open and register a session for a driver, importing its class first.

    The import is what makes an unknown module or class fail here, at
    selection time, rather than on the first radio-bound call. Shared by the
    RPC method and by the image loader, which opens a session for whichever
    driver the image turns out to need.
    """
    module = str(module_name or "").strip()
    cls_name = str(class_name or "").strip()
    if not module or not cls_name:
        raise RuntimePreconditionError("A radio session needs a driver module and class.")
    session = RadioSession(
        session_id=_new_session_id(module, cls_name),
        module_name=module,
        class_name=cls_name,
        radio_cls=_import_radio_class(module, cls_name),
    )
    _SESSIONS[session.session_id] = session
    return session


def open_session(module_name: str, class_name: str) -> dict[str, Any]:
    """RPC: open a session for the selected driver and return its id."""
    return open_radio_session(module_name, class_name).describe()


def close_session(session_id: str) -> dict[str, Any]:
    """RPC: forget a session and its image.

    Idempotent on purpose: the browser closes the previous session whenever
    the selection moves on, without waiting to learn whether that session ever
    finished opening, so closing an id that is not open is not an error.
    """
    session = _SESSIONS.pop(str(session_id or ""), None)
    return {"closed": session is not None, "sessionId": str(session_id or "")}


def resolve_session(session_id: str) -> RadioSession:
    """The open session for an id, or a precondition error naming it.

    A ``RuntimePreconditionError`` because a call for a closed session is the
    app's own bookkeeping catching up with a selection that moved on, not a
    defect worth a bug report: the browser drops the response anyway.
    """
    session = _SESSIONS.get(str(session_id or ""))
    if session is None:
        raise RuntimePreconditionError(
            f"Radio session {str(session_id or '') or '(none)'} is not open: "
            "it was closed or never opened. Select a radio first."
        )
    return session


def resolve_optional_session(session_id: str) -> Optional[RadioSession]:
    """Like ``resolve_session`` but an empty id means "no radio selected".

    For the two methods that work without a radio -- CSV export and the row
    preflight fall back to CHIRP's generic CSV driver -- so that a blank id is
    a choice and only an id that names a closed session is an error.
    """
    if not str(session_id or "").strip():
        return None
    return resolve_session(session_id)


def open_session_ids() -> list[str]:
    """The ids currently open, for tests that check a session was let go of."""
    return sorted(_SESSIONS)
