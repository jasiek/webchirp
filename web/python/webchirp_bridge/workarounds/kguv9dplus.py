"""Workarounds for ``chirp.drivers.kguv9dplus`` (CHIRP pin ``7a4123ad``).

FINDINGS: drivers-refuse-their-own-settings. The driver shows a stored
frequency of 0 as "" (``int2freq``, ``short2freq``), and four kinds of setting
have an apply callback that parses "" back as 0 Hz and refuses it as outside
its range (``freq2int``, ``freq2short``): each VFO band's Rx frequency, the FM
broadcast channels, and each area's scan start and scan end. So
``set_settings(get_settings())`` -- the round trip upstream's
``test_same_settings`` (chirp/tests/test_settings.py) requires -- fails on an
image holding a 0 in any of them, and every write that ran ``set_settings()``
failed on a frequency nobody edited (Sentry WEBCHIRP-FRONTEND-2D, -2E). Once a
CHIRP pin fixes them, tests/channels/kguv9dplus-empty-frequency.mjs fails and
this module goes.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from typing import Callable

    from chirp import chirp_common, settings as chirp_settings

# KGUV9DPlusRadio builds these settings and KGUV9PXRadio rebuilds them under
# the same names; every other class in the module inherits from one of the two.
CLASSES = ("KGUV9DPlusRadio",)

# The settings whose apply callback refuses the "" the driver shows for 0, by
# the names the driver gives them: "vfo_a.band_150.freq" (_band_tab), "fm_1"
# to "fm_20" (_fm_tab), and "settings.a.scan_st" and "settings.a.scan_end"
# (the area tab).
_REFUSE_EMPTY = re.compile(r"vfo_[ab]\.band_\d+\.freq|fm_\d+|settings\.[ab]\.scan_(?:st|end)")


def _write_unless_still_empty(setting: chirp_settings.RadioSetting) -> Callable[[], None]:
    """The setting's apply callback, skipped while its value is still empty.

    Installed only on a setting that read as empty, so skipping writes
    nothing over the 0 the image already holds; a frequency typed in its
    place goes to the driver's own callback, range check and all.
    """
    run = setting.run_apply_callback

    def apply() -> None:
        if str(setting.value).strip():
            run()

    return apply


def keep_empty_frequencies(settings_tree: chirp_settings.RadioSettings) -> None:
    """Leave each frequency the driver showed as empty as read, unless edited.

    A frequency the image holds keeps the driver's callback, so clearing one
    is still refused, as desktop CHIRP refuses it.
    """
    for group in settings_tree:
        for setting in group.walk():
            if not _REFUSE_EMPTY.fullmatch(str(setting.get_name())):
                continue
            if str(setting.value).strip():
                continue
            # An instance attribute shadows the method, which is what the
            # driver's set_settings() calls (chirp/chirp/settings.py:647-648).
            setattr(setting, "run_apply_callback", _write_unless_still_empty(setting))


def get_settings(radio: chirp_common.Radio) -> chirp_settings.RadioSettings:
    """Read the driver's settings tree with its empty frequencies left as read."""
    settings_tree = radio.get_settings()
    keep_empty_frequencies(settings_tree)
    return settings_tree
