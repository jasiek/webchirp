"""Workarounds for ``chirp.drivers.ft1d`` (CHIRP pin ``7a4123ad``).

FINDINGS: ft1d-smartbeacon-low-speed-bound. ``_get_aprs_smartbeacon``
(chirp/chirp/drivers/ft1d.py) gives each SmartBeacon profile's low speed a
``get_max`` of ``min(30, int(high_val.get_value()) - 1)``, built as a lambda
inside its profile loop. The lambda reads ``high_val`` when called, so every
profile is bounded by the last profile's high speed, and when that high speed
never initialized -- every zeroed map -- it raises on ``int(None)``, which
failed a from-scratch FT5D binary export (Sentry WEBCHIRP-FRONTEND-2G).
``vx8.py`` builds the same lambda (``workarounds/vx8.py``). Once a CHIRP pin
fixes it, tests/channels/smartbeacon-low-speed-bound.mjs fails and this module
goes.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from chirp import settings as chirp_settings

if TYPE_CHECKING:
    from typing import Callable

    from chirp import chirp_common

# FT1Radio builds the SmartBeacon menu; every ft2d class (FT2D, FT2Dv2, FT3D,
# FT5D) inherits it from there.
CLASSES = ("FT1Radio",)

_PROFILES = 3


def _low_speed_max(
    low: chirp_settings.RadioSettingValueInteger,
    high: chirp_settings.RadioSettingValueInteger,
) -> Callable[[], int]:
    """The low-speed bound the driver means: below its own profile's high speed.

    Bound to the pair it is built for, so each profile reads its own high
    speed. A high speed that never initialized has no value to stay below, so
    the bound is the low speed's declared maximum -- the class's get_max, which
    the driver's instance attribute hides.
    """
    declared = int(chirp_settings.RadioSettingValueInteger.get_max(low))

    def bound() -> int:
        """Read the high speed at call time, as the driver's own bound does."""
        if not high.initialized:
            return declared
        return min(declared, int(high.get_value()) - 1)

    return bound


def bind_low_speed_bounds(
    settings_tree: chirp_settings.RadioSettings, memory_prefix: str
) -> None:
    """Replace each SmartBeacon low speed's bound with one bound to its own profile.

    ``memory_prefix`` is the memory struct the driver names its settings
    after (``aprs`` here, ``aprs2`` in vx8). A profile whose two settings the
    tree lacks is left as the driver built it.
    """
    by_name: dict[str, chirp_settings.RadioSetting] = {}
    for group in settings_tree:
        for setting in group.walk():
            by_name[str(setting.get_name())] = setting
    for profile in range(_PROFILES):
        path = "%s.smartbeaconing_profile[%d]" % (memory_prefix, profile)
        low = by_name.get(path + ".low_speed_mph")
        high = by_name.get(path + ".high_speed_mph")
        if low is None or high is None:
            continue
        low.value.get_max = _low_speed_max(low.value, high.value)


def get_settings(radio: chirp_common.Radio) -> chirp_settings.RadioSettings:
    """Read the driver's settings tree with each low speed bounded by its own profile."""
    settings_tree = radio.get_settings()
    bind_low_speed_bounds(settings_tree, "aprs")
    return settings_tree
