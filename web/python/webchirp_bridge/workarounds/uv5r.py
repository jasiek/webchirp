"""Workarounds for ``chirp.drivers.uv5r`` (CHIRP pin ``7a4123ad``).

FINDINGS: uv5r-reports-a-finished-override-upload-as-an-error. With its Range
Override Parameter set, uv5r's ``_do_upload`` (chirp/chirp/drivers/uv5r.py)
writes every range and then reports the finished upload by raising a
RadioError that says it is not an error and asks for CHIRP to be restarted.
Passed on, it showed the user a failed upload after a complete write (Sentry
WEBCHIRP-FRONTEND-22). Upstream fix: kk7ds/chirp#1677. Once a CHIRP pin
carries it, tests/channels/uv5r-all-range-upload.mjs fails and this module
goes.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from chirp import errors

from webchirp_bridge.jsbridge import _log_debug

if TYPE_CHECKING:
    from chirp import chirp_common

# BaofengUV5R's sync_out runs _do_upload; every other class in uv5r.py, and
# bjuv55.BaojieBJUV55Radio, inherits it from there.
CLASSES = ("BaofengUV5R",)


def sync_out(radio: chirp_common.CloneModeRadio) -> None:
    """Run the driver's sync_out, taking its finished-override report as success.

    The driver's own state tells that report from a real failure, so no
    message is matched: it clears ``_all_range_flag`` on the line before that
    raise and nowhere else on the upload path, so every other RadioError --
    sync_out's wrapping of an unexpected exception included -- leaves the flag
    set. Nothing here needs the restart: the next upload parses the session's
    image afresh, which clears the flag again.
    """
    all_range = getattr(radio, "_all_range_flag", None) is True
    try:
        radio.sync_out()
    except errors.RadioError:
        if all_range and getattr(radio, "_all_range_flag", None) is False:
            _log_debug(
                "The driver reported its finished range-override upload as a "
                "RadioError; the upload completed."
            )
            return
        raise
