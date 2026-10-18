"""Workarounds for upstream CHIRP driver defects, reached only through hooks.

Generic code never names a radio. A driver that breaks CHIRP's own contract
gets a workaround in this package: one submodule per CHIRP driver module,
named after it, whose ``CLASSES`` names the classes of that module it fixes.
Generic code calls one of the hooks below, never a submodule. A hook finds a
radio's workaround by the module and class name of each class on the radio's
MRO, so a subclass -- in any driver module -- inherits its parent's
workaround, and matching imports no driver. A new kind of workaround adds a
hook here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from webchirp_bridge.workarounds import ft1d, kguv9dplus, uv5r, vx8

if TYPE_CHECKING:
    import types
    from typing import Callable, Optional, TypeVar

    from chirp import chirp_common, settings as chirp_settings

    _Workaround = TypeVar("_Workaround")


def _class_keys(workaround: types.ModuleType) -> list[tuple[str, str]]:
    """The (CHIRP module, class name) pairs a workaround submodule applies to.

    The submodule is named after the driver module it works around, so
    ``workarounds/uv5r.py`` names classes of ``chirp.drivers.uv5r``.
    """
    driver_module = "chirp.drivers." + workaround.__name__.rsplit(".", 1)[1]
    return [(driver_module, name) for name in workaround.CLASSES]


def _for_class(
    table: dict[tuple[str, str], _Workaround], radio_cls: type[chirp_common.Radio]
) -> Optional[_Workaround]:
    """The workaround the nearest class on ``radio_cls``'s MRO has, if any."""
    for klass in radio_cls.__mro__:
        found = table.get((klass.__module__, klass.__name__))
        if found is not None:
            return found
    return None


# The sync_out hook's workarounds: each one runs the driver's sync_out itself.
_SYNC_OUT: dict[tuple[str, str], Callable[[chirp_common.CloneModeRadio], None]] = {
    key: uv5r.sync_out for key in _class_keys(uv5r)
}


def sync_out(radio: chirp_common.CloneModeRadio) -> None:
    """Upload with the driver's sync_out, through its class's workaround if it has one."""
    workaround = _for_class(_SYNC_OUT, type(radio))
    if workaround is None:
        radio.sync_out()
    else:
        workaround(radio)


# The get_settings hook's workarounds: each one reads the driver's settings
# tree itself and repairs it before anything serializes or applies it.
_GET_SETTINGS: dict[
    tuple[str, str], Callable[[chirp_common.Radio], chirp_settings.RadioSettings]
] = {
    **{key: ft1d.get_settings for key in _class_keys(ft1d)},
    **{key: kguv9dplus.get_settings for key in _class_keys(kguv9dplus)},
    **{key: vx8.get_settings for key in _class_keys(vx8)},
}


def get_settings(radio: chirp_common.Radio) -> chirp_settings.RadioSettings:
    """Read the driver's settings tree, through its class's workaround if it has one."""
    workaround = _for_class(_GET_SETTINGS, type(radio))
    if workaround is None:
        return radio.get_settings()
    return workaround(radio)
