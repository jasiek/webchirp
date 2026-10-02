"""Errors the runtime raises on its own account, as opposed to CHIRP's.

They all derive from ``chirp.errors.RadioError`` so that every caller treats
them like any other radio failure, while the class names stay distinct enough
to be matched on. The JS side sees each one as a ``RuntimeCallError``
(``web/js/runtime-errors.mjs``) carrying the class name and its bases, as
``rpc_error_envelope`` (``web/python/webchirp_bridge/rpc.py``) sends them, and
tests it with ``isPythonError`` -- ``web/js/image-metadata.mjs`` retries on
``ImageDetectionError`` that way. A subclass therefore still matches its base.
"""

from __future__ import annotations

from chirp import errors


class RuntimeUnsupportedError(errors.RadioError):
    pass


class ImageDetectionError(RuntimeUnsupportedError):
    """No imported driver claims this image.

    Split out from the generic error because it is the *only* image failure the
    all-drivers sweep can fix, and the browser gates its retry on this class
    (`isImageDetectionFailure`, `web/js/image-metadata.mjs`). Renaming it
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
    ``web/js/sentry.js`` matches it by type and drops the event, keeping one
    Sentry report per user who pressed the buttons out of order from burying the
    real failures. The debug panel still prints it in full.
    ``tests/channels/precondition-errors.mjs`` pins the two together.
    """
