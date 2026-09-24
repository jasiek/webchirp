"""Loading CHIRP drivers and enumerating what they register.

The whole pinned CHIRP package is on the Pyodide filesystem before this
package loads: ``seedPyodideRuntime()`` (``web/js/python-sources.mjs``)
unpacks the archive built by ``scripts/build-chirp-bundle.mjs`` under
``/webchirp_runtime``, so every ``chirp.*`` module -- the ~190 drivers
included -- imports through Python's ordinary path finder, with no network
and no interpreter suspension. The helpers here import drivers on demand or
in bulk and read what registered with ``chirp.directory``: the catalog build
and the metadata-less image sweep both go through them.
"""

from __future__ import annotations

import asyncio
import importlib
from typing import TYPE_CHECKING

from chirp import (
    chirp_common,
    directory,
)

from webchirp_bridge.driver_cache import _driver_features
from webchirp_bridge.power_levels import _power_level_watts

if TYPE_CHECKING:
    from typing import Any, Callable, Iterable, Optional


def ensure_radio_module(module_short_name: str) -> None:
    """Force-import a selected driver module so downstream calls can use it."""
    importlib.import_module(f"chirp.drivers.{module_short_name}")


async def import_all_driver_modules(
    module_short_names: Iterable[Any],
    callback: Optional[Callable[[int, int, str], Any]] = None,
) -> dict[str, Any]:
    """Import every driver so CHIRP can detect images that carry no metadata.

    Detection walks ``directory.DRV_TO_RADIO`` and calls each driver's
    ``match_model``, so a driver that was never imported can never match. Images
    with a metadata trailer name their own driver, but older ones do not, and for
    those the only way to identify the radio is to have every driver registered.

    ``callback(done, total, module_short)`` is optional and reports after each
    module. It is named ``callback`` because that is the one argument
    ``rpc_dispatch`` (web/python/webchirp_bridge/rpc.py) passes outside the
    JSON parameters -- a JS function cannot cross the boundary as JSON.

    A coroutine, not for any I/O of its own but so the reported progress can
    paint. The imports read the mounted tree and never suspend the
    interpreter, so a plain loop would hold the browser's main thread from the
    first module to the last and the strip would jump from 0 to done. The
    ``asyncio.sleep(0)`` after each import hands control back to Pyodide's
    webloop -- a ``setTimeout`` hop on the JS event loop -- which is what lets
    the DOM update the callback just made reach the screen.
    """
    names = [str(name or "").strip() for name in module_short_names or []]
    names = [name for name in names if name]
    total = len(names)
    imported = []
    failed = {}
    for index, module_short in enumerate(names):
        try:
            ensure_radio_module(module_short)
            imported.append(module_short)
        except Exception as exc:
            failed[module_short] = f"{type(exc).__name__}: {exc}"
        if callback is not None:
            try:
                callback(index + 1, total, module_short)
            except Exception:
                pass  # Progress reporting must never abort the sweep.
        await asyncio.sleep(0)
    return {
        "imported": len(imported),
        "failed": failed,
        "registered": len(directory.DRV_TO_RADIO),
    }


def list_registered_radios(module_short_names: Iterable[Any]) -> list[dict[str, Any]]:
    """Import drivers and return radios from CHIRP's registration directory."""
    loaded_modules = set()
    for name in module_short_names or []:
        module_short = str(name or "").strip()
        if not module_short:
            continue
        try:
            ensure_radio_module(module_short)
            loaded_modules.add(module_short)
        except Exception:
            # Skip modules that cannot be imported in this runtime.
            continue

    seen = set()
    radios = []
    for radio_cls in directory.DRV_TO_RADIO.values():
        module_full = getattr(radio_cls, "__module__", "")
        if not module_full.startswith("chirp.drivers."):
            continue
        module_short = module_full.rsplit(".", 1)[-1]
        if loaded_modules and module_short not in loaded_modules:
            continue

        vendor = getattr(radio_cls, "VENDOR", None)
        model = getattr(radio_cls, "MODEL", None)
        if vendor is None or model is None:
            continue

        key = f"{module_short}:{radio_cls.__name__}"
        if key in seen:
            continue
        seen.add(key)

        baud_rate = getattr(radio_cls, "BAUD_RATE", None)
        try:
            baud_rate = int(baud_rate) if baud_rate is not None else None
        except Exception:
            baud_rate = None

        # directory.get_radio_by_image() matches image metadata against
        # VENDOR/MODEL/VARIANT over ``rclass.ALIASES + [rclass]``. Catalog
        # matching runs before any driver is imported, so it needs the same
        # identities recorded up front or it cannot be as precise as the
        # detection it front-runs.
        aliases = []
        for alias_cls in list(getattr(radio_cls, "ALIASES", []) or []) + [radio_cls]:
            alias_vendor = getattr(alias_cls, "VENDOR", None)
            alias_model = getattr(alias_cls, "MODEL", None)
            if alias_vendor is None or alias_model is None:
                continue
            identity = {
                "vendor": str(alias_vendor),
                "model": str(alias_model),
                "variant": str(getattr(alias_cls, "VARIANT", "") or ""),
            }
            if identity not in aliases:
                aliases.append(identity)

        entry = {
            "key": key,
            "module": module_short,
            "className": radio_cls.__name__,
            "vendor": str(vendor),
            "model": str(model),
            "baudRate": baud_rate,
            "isLiveRadio": bool(issubclass(radio_cls, chirp_common.LiveRadio)),
        }
        # Both fields are omitted at their default — an empty variant, and an
        # alias list holding nothing but the class's own identity — because the
        # catalog ships to every visitor and these would otherwise add ~50 kB
        # of "" and duplicated vendor/model to 551 entries. Consumers treat a
        # missing variant as empty and a missing alias list as the class's own
        # identity, which is exactly what those defaults mean.
        variant = str(getattr(radio_cls, "VARIANT", "") or "")
        if variant:
            entry["variant"] = variant
        if len(aliases) > 1:
            entry["aliases"] = aliases
        radios.append(entry)

    radios.sort(key=lambda r: (r["vendor"], r["model"], r["className"]))
    return radios


def _describe_features(features: chirp_common.RadioFeatures) -> dict[str, Any]:
    """Flatten the RadioFeatures fields that describe a radio to a reader.

    Only the fields that say something about the radio itself rather than about
    how the grid should behave: how many channels it holds, how long a channel
    name may be, which modes and bands it covers, whether it has CTCSS/DCS, what
    it transmits at, and whether it exposes radio-wide settings. The tuning
    steps, cross modes and skip values that ``column_metadata`` needs are left
    out -- they constrain an edit, they do not describe the model.
    """
    bounds = tuple(getattr(features, "memory_bounds", None) or (0, 0))
    bands = []
    for band in getattr(features, "valid_bands", None) or []:
        try:
            low, high = int(band[0]), int(band[1])
        except Exception:
            continue
        # A degenerate range is a driver that does not know its limits without
        # an image rather than a radio that covers nothing: ``icw32`` reads
        # them out of the codeplug and reports (0, 0) blank (FINDINGS:
        # blank-instances-misreport-state). Recording it would put "0 Hz" on a
        # page; leaving it out lets the caller see the radio has nothing to say
        # about its coverage.
        if high <= low:
            continue
        bands.append([low, high])
    return {
        "memoryBounds": [int(bounds[0]), int(bounds[1])],
        "nameLength": int(getattr(features, "valid_name_length", 0) or 0),
        # Sorted, not in the driver's order, because several drivers build these
        # as ``list(set(...))`` (``ft817.py:443``, ``id31.py:212``) and a set of
        # strings iterates in a different order in every Python process. Left
        # alone, the artifact and the pages generated from it would change on
        # every rebuild with nothing behind the diff. Nothing downstream reads
        # order as meaning -- this describes a radio rather than driving a
        # dropdown, which is what ``column_metadata`` is for.
        "modes": sorted(str(mode) for mode in getattr(features, "valid_modes", None) or []),
        "bands": bands,
        # The empty string in valid_tmodes is "no tone", which is not a
        # capability worth listing next to Tone/TSQL/DTCS.
        "toneModes": sorted(
            str(tmode) for tmode in getattr(features, "valid_tmodes", None) or [] if tmode
        ),
        "powerLevels": _power_level_watts(getattr(features, "valid_power_levels", None)),
        "hasSettings": bool(getattr(features, "has_settings", False)),
    }


def list_radio_features(
    module_short_names: Iterable[Any],
) -> dict[str, dict[str, Any]]:
    """Describe every catalogued radio from its driver's own RadioFeatures.

    A companion sweep to ``list_registered_radios``: that one records which
    radios exist, this one records what each can do. Built for the static
    per-model pages, which need per-model facts rather than a shared template,
    and which must not invent them -- every value here is what the driver
    itself advertises.

    Failures are returned rather than raised: a driver that cannot describe
    itself on a blank instance is a page the generator should skip, not a build
    that stops on radio 300 of 554.
    """
    features_by_key: dict[str, Any] = {}
    failed: dict[str, str] = {}
    for entry in list_registered_radios(module_short_names):
        key = entry["key"]
        try:
            features = _driver_features(entry["module"], entry["className"])
        except Exception as exc:
            failed[key] = f"{type(exc).__name__}: {exc}"
            continue
        if features is None:
            failed[key] = "driver could not be instantiated"
            continue
        try:
            features_by_key[key] = _describe_features(features)
        except Exception as exc:
            failed[key] = f"{type(exc).__name__}: {exc}"
    return {"features": features_by_key, "failed": failed}
