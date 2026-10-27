"""Errors the runtime raises on its own account, as opposed to CHIRP's.

They all derive from ``chirp.errors.RadioError`` so that every caller treats
them like any other radio failure, while the class names stay distinct enough
to be matched on. The JS side sees each one as a ``RuntimeCallError``
(``web/js/runtime-errors.ts``) carrying the class name and its bases, as
``rpc_error_envelope`` (``web/python/webchirp_bridge/rpc.py``) sends them, and
tests it with ``isPythonError`` -- ``web/js/image-metadata.ts`` retries on
``ImageDetectionError`` that way. A subclass therefore still matches its base.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from chirp import errors

if TYPE_CHECKING:
    from typing import Any, Optional, Sequence


class RuntimeUnsupportedError(errors.RadioError):
    # What the browser needs beyond the message, as JSON-safe data, or None.
    # rpc_error_envelope sends it as the envelope's ``details``, and JS reads it
    # as the RuntimeCallError's ``pythonDetails``.
    details: Optional[dict[str, Any]] = None


class ImageDetectionError(RuntimeUnsupportedError):
    """No imported driver claims this image.

    Split out from the generic error because it is the *only* image failure the
    all-drivers sweep can fix, and the browser gates its retry on this class
    (`isImageDetectionFailure`, `web/js/image-metadata.ts`). Renaming it
    without updating that predicate silently disables the backstop, so
    `tests/channels/metadataless-image-load.mjs` pins the two together.
    """


class RuntimePreconditionError(RuntimeUnsupportedError):
    """A step the user has not taken yet, not a defect.

    Raised where an operation is refused because the session is missing
    something only the user can supply -- today, every guard that can only be
    cleared by downloading from the radio first, of which pressing Upload on a
    fresh page is the one users actually hit. The message is an instruction
    ("Download from radio first"), the fix is entirely in the user's hands, and
    nothing about it wants a developer's attention.

    Split out from the generic error for the same reason ``ImageDetectionError``
    is: the class is the contract the JS side matches on, and its message is
    user-facing copy that must stay free to change. ``isIgnoredError`` in
    ``web/js/sentry.ts`` matches it by type and drops the event, keeping one
    Sentry report per user who pressed the buttons out of order from burying the
    real failures. The debug panel still prints it in full.
    ``tests/channels/precondition-errors.mjs`` pins the two together.
    """


class SettingsRefusedError(RuntimePreconditionError):
    """The radio refused a setting value the user edited.

    Raised by export and upload when CHIRP or the driver rejects an edited
    setting -- a frequency outside its band, an option the list does not
    hold. The message names the setting and carries the driver's own reason,
    and the fix is the user's: correct the value in Settings and try again.
    It derives from ``RuntimePreconditionError`` so the browser shows it as a
    notice and Sentry drops it. A refusal the runtime cannot pin on an edit
    is never raised as this class, so it stays reported.

    ``details["issues"]`` lists every refused value in the shape the upload
    preflight reports (path, valueIndex, message), so the Settings panel marks
    the same fields red whichever of the two caught them.
    """

    def __init__(self, message: str, issues: Sequence[dict[str, Any]]) -> None:
        """Keep the refused values' issues beside the message for the browser."""
        super().__init__(message)
        self.details = {"issues": [dict(issue) for issue in issues]}
