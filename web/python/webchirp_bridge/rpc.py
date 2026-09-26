"""The RPC contract between the JS runtime client and the Python runtime.

``web/js/rpc-dispatch.mjs`` calls exactly one Python callable, ``rpc_dispatch``,
with a method name, one JSON object of named parameters and an optional JS
callback. ``RPC_METHODS`` is the whole surface that call can reach: a name per
runtime function, imported from the module that owns it. Nothing else in the
Pyodide globals is callable from JS, so a runtime function is reachable from
the browser if and only if it is listed here -- which is what makes the
listing greppable and lets ``tests/channels/rpc-contract.mjs`` prove that the
JS table (``RPC_METHODS`` in ``web/js/rpc-dispatch.mjs``) names the same
methods with the same parameters.

Keys are the functions' own names so that a search for ``parse_csv`` finds the
definition, this table and the JS call site in one pass; the JS side sends the
parameters under the Python parameter names for the same reason.
"""

from __future__ import annotations

import inspect
import json
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
from webchirp_bridge.row_validation import validate_rows_for_upload
from webchirp_bridge.serial_pipe import (
    webserial_connect,
    webserial_disconnect,
    webserial_txrx_hex,
)
from webchirp_bridge.session import close_session, open_session

if TYPE_CHECKING:
    from typing import Any, Callable

    from pyodide.ffi import JsProxy

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


async def rpc_dispatch(
    method: str, params_json: str, callback: JsProxy | None = None
) -> str:
    """Run one RPC method and return its result as JSON text.

    The single entry point JS calls: looks ``method`` up in ``RPC_METHODS``,
    decodes ``params_json`` (one JSON object) into keyword arguments, binds
    ``callback`` under ``CALLBACK_PARAM`` when one is given, awaits the result
    if the method is a coroutine function and serialises what comes back.
    Keyword binding is what makes a mismatch fail loudly: an unknown method or
    a misnamed parameter raises here instead of silently reading a stale
    interpreter global, which is what the string-built expressions this
    replaced did.
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
    return json.dumps(result)
