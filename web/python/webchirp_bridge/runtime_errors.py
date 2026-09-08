"""Errors the runtime raises on its own account, as opposed to CHIRP's.

Both derive from ``chirp.errors.RadioError`` so that every caller -- and
every JS-side classifier, which only ever sees the flattened traceback text
-- treats them like any other radio failure, while the class names stay
distinct enough to be matched on (``web/js/image-metadata.mjs`` retries on
``ImageDetectionError`` by name).
"""

from __future__ import annotations

from chirp import errors


class RuntimeUnsupportedError(errors.RadioError):
    pass


class ImageDetectionError(RuntimeUnsupportedError):
    """No imported driver claims this image.

    Split out from the generic error because it is the *only* image failure the
    all-drivers sweep can fix, and the browser gates its retry on this class
    name (`isImageDetectionFailure`, `web/js/image-metadata.mjs`). Renaming it
    without updating that predicate silently disables the backstop, so
    `scripts/test-metadataless-image-load.mjs` pins the two together.
    """
