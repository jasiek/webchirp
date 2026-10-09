"""The RPC contract between the JS runtime client and the Python runtime.

``web/js/rpc-dispatch.ts`` calls exactly one Python callable, ``rpc_dispatch``,
with a method name, one JSON object of named parameters and an optional JS
callback. ``RPC_METHODS`` is the whole surface that call can reach: a name per
runtime function, imported from the module that owns it. Nothing else in the
Pyodide globals is callable from JS, so a runtime function is reachable from
the browser if and only if it is listed here -- which is what makes the
listing greppable and lets ``tests/channels/rpc-contract.mjs`` prove that the
JS table (``RPC_METHODS`` in ``web/js/rpc-dispatch.ts``) names the same
methods with the same parameters.

Keys are the functions' own names so that a search for ``parse_csv`` finds the
definition, this table and the JS call site in one pass; the JS side sends the
parameters under the Python parameter names for the same reason.

``rpc_dispatch`` never raises an ``Exception`` back across the boundary. Its
reply is always an envelope, ``{"ok": true, "result": ...}`` or ``{"ok": false,
"error": {...}}`` built by ``rpc_error_envelope``, so a failure reaches JS as
fields -- the class, its bases, its module, its message, its traceback and the
JS error underneath a ``JsException`` -- rather than as one Pyodide
``PythonError`` whose message is the whole traceback text. The JS half
(``web/js/rpc-dispatch.ts``) turns a failed envelope into a
``RuntimeCallError`` (``web/js/runtime-errors.ts``), which is what every
classifier in the UI tests by type.
"""

from __future__ import annotations

import inspect
import json
import traceback
from typing import TYPE_CHECKING

from webchirp_bridge.channel_extra import get_channel_extra
from webchirp_bridge.channel_rows import normalize_rows, parse_csv
from webchirp_bridge.chirp_loader import (
    ensure_radio_module,
    import_all_driver_modules,
    list_radio_features,
    list_registered_radios,
)
from webchirp_bridge.clone import download_selected_radio, upload_selected_radio
from webchirp_bridge.column_metadata import get_default_schema, get_radio_column_metadata
from webchirp_bridge.images import (
    export_image_base64,
    get_cached_image_base64,
    load_image_base64,
    read_image_metadata_base64,
)
from webchirp_bridge.radio_settings import get_radio_settings, validate_radio_settings
from webchirp_bridge.row_validation import (
    normalize_and_validate_rows,
    validate_rows_for_upload,
)
from webchirp_bridge.serial_pipe import (
    webserial_connect,
    webserial_disconnect,
    webserial_txrx_hex,
)
from webchirp_bridge.session import close_session, open_session

if TYPE_CHECKING:
    from typing import Any, Callable

    from pyodide.ffi import JsProxy

try:
    from pyodide.ffi import JsException
except ImportError:  # CPython (compileall, the type checker); never the runtime
    JsException = None

# The one parameter a method may take that is not JSON: a JS function. It
# arrives as ``rpc_dispatch``'s third argument and is bound under this name,
# so a method that wants one names its parameter ``callback``.
CALLBACK_PARAM = "callback"

# Every runtime function JS may call, by name. Grouped by owning module; the
# order is only for reading.
RPC_METHODS: dict[str, Callable[..., Any]] = {
    # web/python/webchirp_bridge/chirp_loader.py
    "ensure_radio_module": ensure_radio_module,
    "import_all_driver_modules": import_all_driver_modules,
    "list_registered_radios": list_registered_radios,
    "list_radio_features": list_radio_features,
    # web/python/webchirp_bridge/session.py
    "open_session": open_session,
    "close_session": close_session,
    # web/python/webchirp_bridge/column_metadata.py
    "get_default_schema": get_default_schema,
    "get_radio_column_metadata": get_radio_column_metadata,
    # web/python/webchirp_bridge/channel_rows.py
    "parse_csv": parse_csv,
    "normalize_rows": normalize_rows,
    # web/python/webchirp_bridge/row_validation.py
    "validate_rows_for_upload": validate_rows_for_upload,
    "normalize_and_validate_rows": normalize_and_validate_rows,
    # web/python/webchirp_bridge/channel_extra.py
    "get_channel_extra": get_channel_extra,
    # web/python/webchirp_bridge/radio_settings.py
    "get_radio_settings": get_radio_settings,
    "validate_radio_settings": validate_radio_settings,
    # web/python/webchirp_bridge/images.py
    "read_image_metadata_base64": read_image_metadata_base64,
    "load_image_base64": load_image_base64,
    "export_image_base64": export_image_base64,
    "get_cached_image_base64": get_cached_image_base64,
    # web/python/webchirp_bridge/serial_pipe.py
    "webserial_connect": webserial_connect,
    "webserial_disconnect": webserial_disconnect,
    "webserial_txrx_hex": webserial_txrx_hex,
    # web/python/webchirp_bridge/clone.py
    "download_selected_radio": download_selected_radio,
    "upload_selected_radio": upload_selected_radio,
}


def rpc_method_parameters(method: str) -> list[str]:
    """Name the parameters ``method`` takes, in declaration order.

    Read from the function's signature rather than kept in a second table, so
    the Python side has exactly one source of truth for the contract test to
    compare the JS table against.
    """
    return list(inspect.signature(RPC_METHODS[method]).parameters)


def _exception_chain(exc: BaseException) -> list[BaseException]:
    """List ``exc`` and every exception below it, outermost first.

    Follows ``__cause__``, then ``__context__``, as the traceback does, so a
    driver's ``RadioError`` raised while handling a serial or checksum failure
    leads to that failure. Guarded against a cycle, which Python allows.
    """
    chain: list[BaseException] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _js_cause(exc: BaseException) -> dict[str, str] | None:
    """Name the JS error behind ``exc``, if a rejected JS call raised it.

    A JS rejection that Python awaits -- a serial operation, the port chooser --
    arrives as a ``JsException``, which keeps the JS error's ``name`` and
    ``message`` as attributes. Those are what the browser branches on (a
    dismissed chooser is recognised by its name), so they are lifted out here
    rather than left for JS to parse back out of the traceback. Walks the
    exception chain because a driver may re-raise a serial failure as a
    ``RadioError`` of its own, and that is the exception that reaches the
    dispatcher; the first ``JsException`` found is the answer.
    """
    for current in _exception_chain(exc):
        if JsException is not None and isinstance(current, JsException):
            return {
                "name": str(getattr(current, "name", "") or ""),
                "message": str(getattr(current, "message", "") or ""),
            }
    return None


def _python_causes(exc: BaseException) -> list[dict[str, str]]:
    """Name each exception ``exc`` was raised from or while handling.

    A driver often catches a specific failure and re-raises a generic one --
    ``iradio_uv_5118plus`` turns "Block failed checksum!" into "Failed to read
    block" -- so the outer message alone can hide what went wrong. JS
    classifies a failure by what it said (``classifyErrorKind``,
    ``web/js/ui/analytics.ts``), and these messages are part of what it said;
    the traceback's frames, which are not, stay out.
    """
    return [
        {"type": type(current).__name__, "message": str(current)}
        for current in _exception_chain(exc)[1:]
    ]


def rpc_error_envelope(exc: Exception) -> dict[str, Any]:
    """Describe one failed call as the fields JS classifies it by.

    The one place a Python exception is turned into what crosses the boundary.
    Before it, Pyodide flattened every failure into a ``PythonError`` whose
    message was the traceback text, and each JS classifier re-derived the class
    from that text with a regex. Here the class is sent as data: ``type`` and
    ``module`` name it, ``bases`` lists every class above it up to
    ``BaseException`` (``object`` excluded) so JS can match a subclass by the
    base it tests for, ``message`` is ``str(exc)`` alone -- the sentence a user
    can be shown -- and ``traceback`` is the full formatted text the debug panel
    prints. ``causes`` names the exceptions it was chained from, nearest first
    (``_python_causes``), and ``js`` is the JS error under a ``JsException``
    (``_js_cause``), or ``None``.
    """
    cls = type(exc)
    return {
        "type": cls.__name__,
        "bases": [base.__name__ for base in cls.__mro__[1:] if base is not object],
        "module": cls.__module__,
        "message": str(exc),
        "traceback": "".join(traceback.format_exception(exc)),
        "causes": _python_causes(exc),
        "js": _js_cause(exc),
    }


async def _call_rpc_method(
    method: str, params_json: str, callback: JsProxy | None
) -> Any:
    """Run one RPC method and return its result, raising whatever it raises.

    Looks ``method`` up in ``RPC_METHODS``, decodes ``params_json`` (one JSON
    object) into keyword arguments, binds ``callback`` under ``CALLBACK_PARAM``
    when one is given and awaits the result if the method is a coroutine
    function. Keyword binding is what makes a mismatch fail loudly: an unknown
    method or a misnamed parameter raises here instead of silently reading a
    stale interpreter global, which is what the string-built expressions this
    replaced did. Split from ``rpc_dispatch`` so that one ``try`` there turns
    every failure -- a malformed call as much as a failing method -- into an
    envelope.
    """
    try:
        function = RPC_METHODS[method]
    except KeyError:
        known = ", ".join(sorted(RPC_METHODS))
        raise ValueError(f"Unknown RPC method {method!r}; known methods: {known}") from None
    kwargs = json.loads(params_json)
    if not isinstance(kwargs, dict):
        raise TypeError(
            f"RPC method {method!r} expects a JSON object of named parameters, "
            f"got {type(kwargs).__name__}"
        )
    if callback is not None:
        kwargs[CALLBACK_PARAM] = callback
    result = function(**kwargs)
    if inspect.isawaitable(result):
        result = await result
    return result


async def rpc_dispatch(
    method: str, params_json: str, callback: JsProxy | None = None
) -> str:
    """Run one RPC method and return its outcome as a JSON envelope.

    The single entry point JS calls. Success is ``{"ok": true, "result": ...}``;
    any ``Exception`` -- from the method, from decoding the call, or from
    serialising the result -- is ``{"ok": false, "error": ...}`` as built by
    ``rpc_error_envelope``, so the Python coroutine never rejects on the JS
    side. Only ``Exception`` is caught: ``KeyboardInterrupt``, ``SystemExit``
    and the other bare ``BaseException`` subclasses mean the interpreter is
    being torn down and must keep propagating rather than be reported as one
    failed call.
    """
    try:
        result = await _call_rpc_method(method, params_json, callback)
        return json.dumps({"ok": True, "result": result})
    except Exception as exc:
        return json.dumps({"ok": False, "error": rpc_error_envelope(exc)})
