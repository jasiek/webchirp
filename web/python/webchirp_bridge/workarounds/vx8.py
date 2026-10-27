"""Workarounds for ``chirp.drivers.vx8`` (CHIRP pin ``7a4123ad``).

FINDINGS: ft1d-smartbeacon-low-speed-bound. ``VX8DRadio._get_aprs_smartbeacon``
(chirp/chirp/drivers/vx8.py) builds the same late-bound low-speed lambda as
ft1d.py, under the ``aprs2`` memory struct, so a from-scratch VX-8DR or VX-8GE
binary export failed the same way. The fix is ft1d's, given vx8's setting
names. Once a CHIRP pin fixes it, tests/channels/smartbeacon-low-speed-bound.mjs
fails and this module goes.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from webchirp_bridge.workarounds.ft1d import bind_low_speed_bounds

if TYPE_CHECKING:
    from chirp import chirp_common, settings as chirp_settings

# VX8DRadio builds the SmartBeacon menu and VX8GERadio inherits it; the VX-8R
# (VX8Radio) has none.
CLASSES = ("VX8DRadio",)


def get_settings(radio: chirp_common.Radio) -> chirp_settings.RadioSettings:
    """Read the driver's settings tree with each low speed bounded by its own profile."""
    settings_tree = radio.get_settings()
    bind_low_speed_bounds(settings_tree, "aprs2")
    return settings_tree
