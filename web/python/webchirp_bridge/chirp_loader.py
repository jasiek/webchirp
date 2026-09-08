"""Loading CHIRP itself: the lazy import hook and driver enumeration.

Only a handful of core CHIRP files are seeded into the Pyodide filesystem
before this package loads (``CORE_CHIRP_RELATIVE_FILES`` in
``web/js/python-sources.mjs``). Every other ``chirp.*`` module -- above all
the ~150 driver modules -- is fetched on first import by ``ChirpCdnFinder``,
installed here at import time. The enumeration helpers build on that: the
catalog build and the metadata-less image sweep both import drivers in bulk
and read what registered with ``chirp.directory``.
"""

from __future__ import annotations

import importlib
import importlib.abc
import os
import sys
import traceback
import types
from typing import Any, Callable, Iterable, Optional, Sequence

from chirp import (
    chirp_common,
    directory,
)
from js import fetch_chirp_source

from webchirp_bridge.jsbridge import _await_js, _js_to_py, _log_debug


def _chirp_source_relpath(fullname: str) -> str:
    """Map a Python module name to the corresponding CHIRP CDN file path."""
    if fullname in ("chirp", "chirp.__init__"):
        return "/chirp/__init__.py"
    if fullname == "chirp.drivers":
        return "/chirp/drivers/__init__.py"
    return "/" + fullname.replace(".", "/") + ".py"


def _chirp_runtime_path(fullname: str) -> str:
    """Map a Python module name to its destination in Pyodide runtime FS."""
    if fullname in ("chirp", "chirp.__init__"):
        return "/webchirp_runtime/chirp/__init__.py"
    if fullname == "chirp.drivers":
        return "/webchirp_runtime/chirp/drivers/__init__.py"
    return "/webchirp_runtime/" + fullname.replace(".", "/") + ".py"


def _ensure_chirp_module_file(fullname: str) -> None:
    """Materialize a missing chirp module file into local runtime FS."""
    runtime_path = _chirp_runtime_path(fullname)
    if os.path.exists(runtime_path):
        return
    source_relpath = _chirp_source_relpath(fullname)
    source = _js_to_py(_await_js(fetch_chirp_source(source_relpath)))
    os.makedirs(os.path.dirname(runtime_path), exist_ok=True)
    with open(runtime_path, "w", encoding="utf-8") as f:
        f.write(str(source))


class ChirpCdnFinder(importlib.abc.MetaPathFinder):
    """Lazy materializer for missing chirp.* modules from jsDelivr."""

    def find_spec(
        self,
        fullname: str,
        path: Optional[Sequence[str]] = None,
        target: Optional[types.ModuleType] = None,
    ) -> None:
        """Ensure module file exists before regular import resolution proceeds.

        A failure here is reported rather than swallowed (issue #100). Returning
        ``None`` handed the import back to ``PathFinder``, whose only verdict is
        ``ModuleNotFoundError: No module named 'chirp.drivers.x'`` -- which hides
        every cause that is not "no such module": a jsDelivr 404, an offline
        network, or the missing JSPI support that makes ``_await_js`` raise on
        Safari and older Firefox. The traceback goes to the debug panel and the
        raised ``ImportError`` names the source path, so both surfaces carry the
        real cause. Raising ``ImportError`` rather than the narrower
        ``ModuleNotFoundError`` (its subclass) leaves every caller that catches
        ``ImportError`` unaffected -- which is all of them here, since nothing
        in the runtime or in CHIRP's importable modules matches the subclass.
        """
        if fullname != "chirp" and not fullname.startswith("chirp."):
            return None
        source_relpath = _chirp_source_relpath(fullname)
        try:
            _ensure_chirp_module_file(fullname)
        except Exception as exc:
            _log_debug(
                f"IMPORT FAIL {fullname} <- {source_relpath}: "
                f"{type(exc).__name__}: {exc}"
            )
            _log_debug(traceback.format_exc())
            raise ImportError(
                f"Could not load CHIRP source for {fullname} "
                f"from {source_relpath}: {exc}",
                name=fullname,
            ) from exc
        return None


def _install_chirp_import_hook() -> None:
    """Install the lazy CHIRP import hook once per runtime session."""
    if any(isinstance(f, ChirpCdnFinder) for f in sys.meta_path):
        return
    # Prepend so missing chirp modules are materialized before PathFinder runs.
    sys.meta_path.insert(0, ChirpCdnFinder())


def ensure_radio_module(module_short_name: str) -> None:
    """Force-import a selected driver module so downstream calls can use it."""
    importlib.import_module(f"chirp.drivers.{module_short_name}")


# The drivers package has to exist before the finder does. The seeded
# /webchirp_runtime/chirp/drivers/ carries no __init__.py, so this import binds
# ``chirp.drivers`` as a namespace package -- exactly what happened when the
# runtime was one file and ``generic_csv`` was imported ahead of the hook.
# Left to the finder, the first driver import would fetch upstream's
# ``chirp/chirp/drivers/__init__.py`` instead, which globs the directory into
# ``__all__`` and adds a CDN round trip to every boot.
import chirp.drivers  # noqa: E402, F401

_install_chirp_import_hook()


def import_all_driver_modules(
    module_short_names: Iterable[Any],
    progress_cb: Optional[Callable[[int, int, str], Any]] = None,
) -> dict[str, Any]:
    """Import every driver so CHIRP can detect images that carry no metadata.

    Detection walks ``directory.DRV_TO_RADIO`` and calls each driver's
    ``match_model``, so a driver that was never imported can never match. Images
    with a metadata trailer name their own driver, but older ones do not, and for
    those the only way to identify the radio is to have every driver registered.

    ``progress_cb(done, total, module_short)`` is optional and reports after each
    module. This loop is synchronous, but every import suspends the interpreter
    on a CDN fetch (``ChirpCdnFinder``), so the browser event loop runs in
    between and the reported progress actually paints — the same reason CHIRP's
    synchronous clone loops can drive a progress bar through ``serial_progress``.
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
        if progress_cb is not None:
            try:
                progress_cb(index + 1, total, module_short)
            except Exception:
                pass  # Progress reporting must never abort the sweep.
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
