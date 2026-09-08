"""CHIRP driver discovery, lazy source loading, and column metadata."""

from __future__ import annotations

from typing import Any


from chirp import chirp_common
from chirp import directory
import importlib.abc
import os
import sys
import traceback
import runtime_channels
import runtime_images
import runtime_support


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
    source = runtime_support._await_js(runtime_support.fetch_chirp_source(source_relpath))
    if hasattr(source, "to_py"):
        source = source.to_py()
    os.makedirs(os.path.dirname(runtime_path), exist_ok=True)
    with open(runtime_path, "w", encoding="utf-8") as f:
        f.write(str(source))


class ChirpCdnFinder(importlib.abc.MetaPathFinder):
    """Lazy materializer for missing chirp.* modules from jsDelivr."""

    def find_spec(self, fullname: Any, path: Any=None, target: Any=None) -> Any:
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
            runtime_support._log_debug(
                f"IMPORT FAIL {fullname} <- {source_relpath}: "
                f"{type(exc).__name__}: {exc}"
            )
            runtime_support._log_debug(traceback.format_exc())
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


_install_chirp_import_hook()


def import_all_driver_modules(module_short_names: Any, progress_cb: Any=None) -> Any:
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


def list_registered_radios(module_short_names: Any) -> Any:
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


def _driver_features(module_name: str, class_name: str) -> Any:
    """Return a driver's RadioFeatures, preferring the cached image.

    Some drivers read their capabilities out of the codeplug: ``Rt98Radio``
    advertises the PMR power levels (Low = 0.5W) on a blank instance and the
    full Low/Mid/High set once an image is parsed, so a blank instance reports
    levels the loaded radio does not have. CHIRP always takes features from the
    open image, so use the cached one when there is one.
    """
    if not module_name or not class_name:
        return None
    try:
        radio_cls = _import_radio_class(module_name, class_name)
    except Exception:
        return None

    image = runtime_images.LAST_IMAGE_BY_DRIVER.get(runtime_images._driver_cache_key(module_name, class_name))
    factories = [lambda: radio_cls(None), lambda: radio_cls("")]
    if image:
        image_cls = runtime_images._cached_image_class(module_name, class_name, radio_cls)
        factories.insert(0, lambda: runtime_images._radio_from_image_bytes(image_cls, image))
    for factory in factories:
        try:
            return factory().get_features()
        except Exception:
            continue
    return None


def _import_radio_class(
    module_name: str, class_name: str
) -> type[chirp_common.Radio]:
    """Resolve a radio class object from selected module/class names."""
    module = __import__(f"chirp.drivers.{module_name}", fromlist=[class_name])
    return getattr(module, class_name)


def _mk_enum(values: Any) -> Any:
    """Normalize CHIRP value lists into string enums for UI metadata."""
    return [str(v) for v in values] if values else []


def _power_level_watts(levels: Any) -> Any:
    """Map each advertised power level's label to its wattage.

    Driver labels carry no wattage — "L3" and "Mid1" say nothing on their own —
    so the UI shows this alongside them, in the same form an exported CSV uses
    (see `_watts_label`) so the grid and the file agree.

    A label maps to one wattage here, which is all `valid_power_levels` can tell
    us; drivers that reuse a label across bands (`vx6.POWER_LEVELS_220`) advertise
    only one of the two, so treat this as what the driver publishes rather than
    what a given channel transmits.
    """
    watts = {}
    for level in levels or []:
        label = str(level)
        try:
            formatted = runtime_channels._watts_label(level)
        except Exception:
            continue
        if formatted != label:
            watts[label] = formatted
    return watts


def _radio_supports_dv(rf: Any) -> Any:
    """Detect whether a radio's mode capabilities include D-STAR DV mode."""
    modes = {str(mode) for mode in (rf.valid_modes or [])}
    return "DV" in modes


def get_radio_column_metadata(module_name: str, class_name: str) -> Any:
    """Build CHIRP-derived column editability/options metadata for the UI."""
    radio_cls = _import_radio_class(module_name, class_name)
    try:
        radio = radio_cls(None)
    except Exception:
        radio = radio_cls("")
    rf = radio.get_features()
    lo, hi = rf.memory_bounds

    col = {}
    col["Location"] = {
        "kind": "int",
        "editable": False,
        "min": int(lo),
        "max": int(hi),
    }
    col["Name"] = {
        "kind": "text",
        "editable": bool(rf.has_name),
        "maxLength": int(rf.valid_name_length),
        "validChars": str(rf.valid_characters),
    }
    col["Frequency"] = {
        "kind": "freq",
        "editable": True,
        "bands": [[int(a), int(b)] for (a, b) in (rf.valid_bands or [])],
    }
    col["Duplex"] = {
        "kind": "enum",
        "editable": True,
        "options": _mk_enum(rf.valid_duplexes),
    }
    col["Offset"] = {
        "kind": "freq",
        "editable": bool(rf.has_offset),
        "bands": [[int(a), int(b)] for (a, b) in (rf.valid_bands or [])],
    }
    col["Tone"] = {
        "kind": "enum",
        "editable": True,
        "options": _mk_enum(rf.valid_tmodes),
    }
    col["rToneFreq"] = {
        "kind": "enum",
        "editable": True,
        "options": [f"{float(x):.1f}" for x in (rf.valid_tones or [])],
    }
    col["cToneFreq"] = {
        "kind": "enum",
        "editable": bool(rf.has_ctone),
        "options": [f"{float(x):.1f}" for x in (rf.valid_tones or [])],
    }
    col["DtcsCode"] = {
        "kind": "enum",
        "editable": bool(rf.has_dtcs),
        "options": [f"{int(x):03d}" for x in (rf.valid_dtcs_codes or [])],
    }
    col["RxDtcsCode"] = {
        "kind": "enum",
        "editable": bool(rf.has_rx_dtcs),
        "options": [f"{int(x):03d}" for x in (rf.valid_dtcs_codes or [])],
    }
    col["DtcsPolarity"] = {
        "kind": "enum",
        "editable": bool(rf.has_dtcs_polarity),
        "options": _mk_enum(rf.valid_dtcs_pols),
    }
    col["CrossMode"] = {
        "kind": "enum",
        "editable": bool(rf.has_cross),
        "options": _mk_enum(rf.valid_cross_modes),
    }
    col["Mode"] = {
        "kind": "enum",
        "editable": bool(rf.has_mode),
        "options": _mk_enum(rf.valid_modes),
    }
    col["TStep"] = {
        "kind": "enum",
        "editable": bool(rf.has_tuning_step),
        "options": [f"{float(x):.2f}" for x in (rf.valid_tuning_steps or [])],
    }
    col["Skip"] = {
        "kind": "enum",
        "editable": True,
        "options": _mk_enum(rf.valid_skips),
    }
    col["Power"] = {
        "kind": "enum",
        "editable": True,
        "options": _mk_enum(rf.valid_power_levels),
        "optionWatts": _power_level_watts(rf.valid_power_levels),
    }
    col["Comment"] = {
        "kind": "text",
        # Clone-mode radios without native comments use CHIRP's image metadata
        # hooks, so their comments are just as editable as driver-backed ones.
        "editable": bool(
            rf.has_comment
            or isinstance(radio, chirp_common.ExternalMemoryProperties)
        ),
    }
    col["URCALL"] = {"kind": "text", "editable": False}
    col["RPT1CALL"] = {"kind": "text", "editable": False}
    col["RPT2CALL"] = {"kind": "text", "editable": False}
    col["DVCODE"] = {"kind": "text", "editable": False}

    headers = list(runtime_support.CSV_HEADERS)
    if not _radio_supports_dv(rf):
        headers = [h for h in headers if h not in runtime_support.DV_ONLY_HEADERS]

    return {
        "headers": headers,
        "columns": col,
    }
