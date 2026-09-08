"""Radio settings: CHIRP's settings tree as JSON, and JSON applied back.

CHIRP models settings as a tree of ``RadioSettingGroup`` containers holding
``RadioSetting`` leaves with typed values. The serializer flattens that into
JSON groups the settings panel can render; the applier walks the panel's
edits back onto a live tree, validates them the way CHIRP's own UI would,
and prunes what the driver cannot write. Settings need backing state -- an
image or a live session -- so the entry points report "unavailable" rather
than guessing from a blank instance.
"""

from __future__ import annotations

import copy
from typing import Any, Iterable, Optional, Sequence

from chirp import (
    chirp_common,
    settings as chirp_settings,
)

from webchirp_bridge.driver_cache import (
    _best_effort_radio_instance,
    _has_cached_image,
    _import_radio_class,
)
from webchirp_bridge.jsbridge import _log_debug


def _settings_unavailable_payload(
    message: str, requires_image: bool = False, error_text: str = ""
) -> dict[str, Any]:
    """Standard payload when radio-wide settings cannot currently be loaded."""
    return {
        "supported": False,
        "available": False,
        "requiresImage": bool(requires_image),
        "message": str(message or ""),
        "error": str(error_text or ""),
        "groups": [],
    }


SETTINGS_NEED_IMAGE_MESSAGE = (
    "Download from radio or load a codeplug image to edit radio-wide settings."
)
SETTINGS_NEED_STATE_MESSAGE = (
    "Radio-wide settings are unavailable until this driver's backing state is loaded."
)


def _settings_validation_payload(
    result: Optional[dict[str, Any]] = None,
    *,
    requires_image: bool = False,
    message: str = "",
    error_text: str = "",
) -> dict[str, Any]:
    """The validate_radio_settings reply.

    result is the outcome of _validate_and_apply_radio_settings when the
    settings could be checked; without it the reply says why they could not,
    and reports the payload as valid so an unavailable panel never blocks an
    upload of channels alone.
    """
    return {
        "valid": bool(result["valid"]) if result is not None else True,
        "issues": result["issues"] if result is not None else [],
        "settings": result["settings"] if result is not None else [],
        "available": result is not None,
        "requiresImage": bool(requires_image),
        "message": str(message or ""),
        "error": str(error_text or ""),
    }


def _setting_path(parts: Iterable[Any]) -> list[str]:
    """Normalize a settings path list into a JSON-safe list of strings."""
    return [str(part) for part in parts]


def _setting_issue(path: Sequence[Any], value_index: int, message: Any) -> dict[str, Any]:
    """One settings finding: the setting's path, which of its values, and why."""
    return {"path": _setting_path(path), "valueIndex": int(value_index), "message": str(message)}


def _serialize_setting_value(value: Any) -> dict[str, Any]:
    """Convert a CHIRP RadioSettingValue into UI-friendly JSON metadata."""
    current = value.get_value() if value.initialized else None
    data = {
        "mutable": bool(value.get_mutable()),
        "initialized": bool(value.initialized),
        "current": current,
    }

    def _serialize_numeric_bound(getter_name: str, attr_name: str) -> Optional[float]:
        getter = getattr(value, getter_name, None)
        # CHIRP's settings objects are untyped and expose these bounds either as
        # a getter or as a bare attribute depending on the value class, so what
        # comes back is genuinely unknown until the float() call.
        bound: Any = getter() if callable(getter) else None
        if bound is None:
            bound = getattr(value, attr_name, None)
        return float(bound) if bound is not None else None

    if isinstance(value, chirp_settings.RadioSettingValueBoolean):
        data["type"] = "boolean"
    elif isinstance(value, chirp_settings.RadioSettingValueMap):
        data["type"] = "enum"
        data["options"] = [str(option) for option in value.get_options()]
        data["mapped"] = True
    elif isinstance(value, chirp_settings.RadioSettingValueList):
        data["type"] = "enum"
        data["options"] = [str(option) for option in value.get_options()]
    elif isinstance(value, chirp_settings.RadioSettingValueInteger):
        data["type"] = "integer"
        data["min"] = int(value.get_min())
        data["max"] = int(value.get_max())
        data["step"] = int(value.get_step())
    elif isinstance(value, chirp_settings.RadioSettingValueFloat):
        data["type"] = "float"
        minimum = _serialize_numeric_bound("get_min", "_min")
        maximum = _serialize_numeric_bound("get_max", "_max")
        if minimum is not None:
            data["min"] = minimum
        if maximum is not None:
            data["max"] = maximum
    elif isinstance(value, chirp_settings.RadioSettingValueString):
        data["type"] = "string"
        data["minLength"] = int(value.minlength)
        data["maxLength"] = int(value.maxlength)
        data["charset"] = str(getattr(value, "_charset", "") or "")
        data["autopad"] = bool(value.autopad)
    else:
        data["type"] = value.__class__.__name__

    return data


def _serialize_setting_node(node: Any, path_parts: list[Any]) -> dict[str, Any]:
    """Serialize a CHIRP settings tree node for browser rendering."""
    if isinstance(node, chirp_settings.RadioSetting):
        raw_values = node.value if isinstance(node.value, list) else [node.value]
        values = []
        all_mutable = True
        for value_index, value in enumerate(raw_values):
            serialized = _serialize_setting_value(value)
            serialized["index"] = int(value_index)
            values.append(serialized)
            all_mutable = all_mutable and bool(serialized["mutable"])

        current_value = values[0]["current"] if len(values) == 1 else None
        warning = node.get_warning(current_value) if len(values) == 1 else None
        return {
            "kind": "setting",
            "id": str(node.get_name()),
            "label": str(node.get_shortname()),
            "doc": getattr(node, "__doc__", None),
            "path": _setting_path(path_parts + [node.get_name()]),
            "mutable": bool(all_mutable),
            "volatile": bool(getattr(node, "volatile", False)),
            "warning": warning,
            "values": values,
        }

    children = [_serialize_setting_node(child, path_parts + [node.get_name()]) for child in node]
    return {
        "kind": "group",
        "id": str(node.get_name()),
        "label": str(node.get_shortname()),
        "doc": getattr(node, "__doc__", None),
        "path": _setting_path(path_parts + [node.get_name()]),
        "children": children,
    }


def _serialize_radio_settings(settings_tree: Iterable[Any]) -> list[dict[str, Any]]:
    """Serialize the top-level RadioSettings collection."""
    return [_serialize_setting_node(group, []) for group in settings_tree]


def _settings_container_children(container: Any) -> list[Any]:
    """List a settings container's child nodes in tree order.

    CHIRP hands us three shapes of container and only two of them index by
    name: `RadioSettings` (a list subclass with a name-aware `__getitem__`),
    `RadioSettingGroup` (a name dict), and the bare `list` some drivers return
    from `get_settings()` -- `icf520.py:1417` returns `list(RadioSettingGroup(
    "top", ...))`, which indexes only by integer. Position is the one form of
    addressing all three answer to.
    """
    if isinstance(container, chirp_settings.RadioSettingGroup):
        return list(container.values())
    return list(container)


def _match_serialized_child(
    actual_children: Sequence[Any], child_id: str, position: int
) -> Optional[Any]:
    """Resolve the CHIRP node a serialized child refers to, position first.

    Names are not unique: `kguv920pa.py:770` names its Repeater group
    "rmt_grp" alongside the Remote Control group of the same name, and
    `retevis_ha2.py:1212` has two "aprsinfo" groups. A name lookup returns the
    first of the pair every time, so every setting under the second was
    reported as missing from the image. The tree we replay onto is built by
    the same driver code from the same bytes, so the child at the same
    position is the right one, and the name is a consistency check rather
    than the lookup key.

    The name scan is only a fallback for two trees that genuinely differ in
    shape, and it refuses an ambiguous name rather than guessing: with a
    duplicate name and a shifted shape, taking the first match would write an
    edited value into the wrong group. Reporting the mismatch is the safer
    failure -- it stops the upload instead of silently miswriting it.
    """
    if 0 <= position < len(actual_children):
        candidate = actual_children[position]
        if str(candidate.get_name()) == child_id:
            return candidate
    named = [
        candidate
        for candidate in actual_children
        if str(candidate.get_name()) == child_id
    ]
    return named[0] if len(named) == 1 else None


def _setting_value_at(setting: Any, value_index: int) -> Optional[Any]:
    """Return the CHIRP value object a serialized value index addresses."""
    try:
        return setting[value_index] if len(setting) > 1 else setting.value
    except Exception:
        return None


def _setting_value_is_mutable(setting: Any, value_index: int) -> bool:
    """Report whether the selected CHIRP setting value accepts updates."""
    target = _setting_value_at(setting, value_index)
    if target is None:
        return False
    return bool(getattr(target, "get_mutable", lambda: True)())


def _serialized_value_matches(target: Any, next_value: Any) -> bool:
    """Report whether a serialized value already equals CHIRP's current one.

    Writing back a value the driver itself emitted is a no-op at best and a
    validation failure at worst, because CHIRP's read and write sides are not
    symmetric. `RadioSettingValueString.set_value()` autopads to maxlength, so
    a driver that narrows the charset afterwards (`retevis_c2.py:1189`) rejects
    the padded string it just handed us; a `RadioSettingValueList` whose stored
    index is outside its own options rejects the option it just reported. Only
    values the user actually changed are worth writing.
    """
    try:
        current = target.get_value()
    except Exception:
        return False
    if current is None:
        return False
    if current == next_value:
        return True
    return str(current) == str(next_value)


def _apply_serialized_settings(
    actual_container: Any,
    payload_children: Optional[Sequence[Any]],
    issues: list[dict[str, Any]],
    prefix: list[str],
) -> None:
    """Apply serialized UI settings onto a fresh CHIRP settings tree."""
    children = payload_children or []
    actual_children = _settings_container_children(actual_container)
    for position, payload in enumerate(children):
        child_id = str(payload.get("id", ""))
        if not child_id:
            continue
        actual_child = _match_serialized_child(actual_children, child_id, position)
        if actual_child is None:
            issues.append(
                _setting_issue(
                    prefix + [child_id], 0, "Setting is not available for this radio image."
                )
            )
            continue

        path = prefix + [child_id]
        if payload.get("kind") == "group":
            _apply_serialized_settings(actual_child, payload.get("children") or [], issues, path)
            continue

        if not isinstance(actual_child, chirp_settings.RadioSetting):
            issues.append(
                _setting_issue(path, 0, "Payload expected a setting but CHIRP returned a group.")
            )
            continue

        payload_values = payload.get("values") or []
        for value_index, value_payload in enumerate(payload_values):
            if not _setting_value_is_mutable(actual_child, value_index):
                continue
            target = _setting_value_at(actual_child, value_index)
            if target is None:
                continue
            # An uninitialized value is one CHIRP could not load: the driver
            # built it from image content its own validation rejects, and
            # `RadioSettingGroup.__init__` logged and swallowed the error
            # (`settings.py:80-90`), leaving `_current` at None. It serializes
            # as null, and replaying null reaches `len(None)` inside
            # set_value(). Desktop CHIRP strips these before applying
            # (`chirp/chirp/wxui/settingsedit.py:177-190`); skipping them is
            # the same rule.
            if not bool(getattr(target, "initialized", True)):
                continue
            # Past that guard the live value exists, so a null in the payload
            # is not CHIRP declining to load it -- it is a payload that lost a
            # value the radio has. Skipping would silently keep the old one
            # and report the upload as clean, so say so instead. Measured
            # across every upstream image that carries settings, a serialized
            # null and an uninitialized target always coincide, so this
            # reports a malformed payload rather than a driver quirk.
            next_value = value_payload.get("current")
            if next_value is None:
                issues.append(_setting_issue(path, value_index, "Setting has no value to write."))
                continue
            if _serialized_value_matches(target, next_value):
                continue
            try:
                target.set_value(next_value)
            except Exception as exc:
                issues.append(_setting_issue(path, value_index, exc))


def _settings_child_is_writable(setting: Any) -> bool:
    """Report whether CHIRP can write every value of one setting back.

    A value is unwritable when it is immutable, or when it never initialized:
    the driver built it from image content its own validation rejects, so
    `RadioSettingGroup.__init__` logged the failure and swallowed it
    (`settings.py:493-504`), leaving `_current` at None. Desktop CHIRP applies
    the same two-part test in `_remove_dead_settings`
    (`chirp/chirp/wxui/settingsedit.py:177-190`), and drops the whole setting
    when any one of its values fails -- a multi-value setting is written as a
    unit.
    """
    for value in setting:
        if not bool(getattr(value, "get_mutable", lambda: True)()):
            return False
        if not bool(getattr(value, "initialized", True)):
            return False
    return True


def _remove_settings_child(container: Any, element: Any) -> None:
    """Detach one child from whichever container shape CHIRP handed us.

    `RadioSettingGroup` deletes by element (`settings.py:591-593`), while a
    `RadioSettings` root and the bare list `icf520` returns are plain lists.
    """
    if isinstance(container, chirp_settings.RadioSettingGroup):
        del container[element]
    else:
        container.remove(element)


def _prune_dead_settings(container: Any) -> list[str]:
    """Drop settings CHIRP cannot write, and report what was dropped.

    Drivers differ in how defensive their `set_settings` is. `uv5r.py:2156`
    writes every element it is handed straight through
    (`setattr(obj, setting, element.value)`), so an uninitialized value reaches
    `int(None)` in `bitwise.py` and aborts the upload -- for a setting the user
    never touched, on a radio whose byte is merely outside the range the driver
    declares. Desktop CHIRP never hands those to a driver at all, so neither do
    we; pruning a copy keeps them in the tree we serialize back to the UI.

    `RadioSetting` subclasses `RadioSettingGroup`, so the isinstance order
    matters: recursing into a setting would walk its values, not settings.
    """
    dropped: list[str] = []
    for element in _settings_container_children(container):
        if isinstance(element, chirp_settings.RadioSetting):
            if _settings_child_is_writable(element):
                continue
            _remove_settings_child(container, element)
            dropped.append(str(element.get_name()))
        elif isinstance(element, chirp_settings.RadioSettingGroup):
            dropped.extend(_prune_dead_settings(element))
    return dropped


def _validate_and_apply_radio_settings(
    radio: chirp_common.Radio,
    serialized_groups: Sequence[dict[str, Any]],
    apply_changes: bool = False,
) -> dict[str, Any]:
    """Validate serialized settings against a fresh CHIRP settings tree."""
    rf = radio.get_features()
    if not bool(getattr(rf, "has_settings", False)):
        return {"valid": True, "issues": [], "settings": []}

    settings_tree = radio.get_settings()
    issues = []
    _apply_serialized_settings(settings_tree, serialized_groups, issues, [])
    if issues:
        return {"valid": False, "issues": issues, "settings": _serialize_radio_settings(settings_tree)}
    if apply_changes:
        # Prune a copy, not the tree itself: the serialized reply below still
        # has to show the user every setting the radio reported, including the
        # ones CHIRP declined to load.
        writable_tree = copy.deepcopy(settings_tree)
        dropped = _prune_dead_settings(writable_tree)
        if dropped:
            _log_debug(
                "Skipping %d setting(s) CHIRP cannot write: %s"
                % (len(dropped), ", ".join(dropped))
            )
        radio.set_settings(writable_tree)
    return {"valid": True, "issues": [], "settings": _serialize_radio_settings(settings_tree)}


def get_radio_settings(module_name: str, class_name: str) -> dict[str, Any]:
    """Build CHIRP settings-group metadata for the UI when supported."""
    radio_cls = _import_radio_class(module_name, class_name)
    if issubclass(radio_cls, chirp_common.CloneModeRadio) and not _has_cached_image(
        module_name, class_name
    ):
        return _settings_unavailable_payload(SETTINGS_NEED_IMAGE_MESSAGE, requires_image=True)

    radio = _best_effort_radio_instance(module_name, class_name)
    rf = radio.get_features()
    if not bool(getattr(rf, "has_settings", False)):
        return _settings_unavailable_payload(
            "This radio does not expose radio-wide settings."
        )
    try:
        settings_tree = radio.get_settings()
    except Exception as exc:
        return _settings_unavailable_payload(SETTINGS_NEED_STATE_MESSAGE, error_text=str(exc))
    return {
        "supported": True,
        "available": True,
        "requiresImage": False,
        "message": "",
        "error": "",
        "groups": _serialize_radio_settings(settings_tree),
    }


def validate_radio_settings(
    module_name: str, class_name: str, settings_groups: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    """Validate serialized radio settings using CHIRP's typed value objects."""
    radio_cls = _import_radio_class(module_name, class_name)
    if issubclass(radio_cls, chirp_common.CloneModeRadio) and not _has_cached_image(
        module_name, class_name
    ):
        return _settings_validation_payload(
            requires_image=True, message=SETTINGS_NEED_IMAGE_MESSAGE
        )
    radio = _best_effort_radio_instance(module_name, class_name, require_cached=False)
    try:
        result = _validate_and_apply_radio_settings(radio, settings_groups or [], apply_changes=False)
    except Exception as exc:
        return _settings_validation_payload(
            message=SETTINGS_NEED_STATE_MESSAGE, error_text=str(exc)
        )
    return _settings_validation_payload(result)
