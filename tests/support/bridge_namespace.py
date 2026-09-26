"""Test-only flattening of the webchirp_bridge package into Pyodide's globals.

Executed into the interpreter's globals by tests/support/radio-harness.mjs
right after web/python/runtime_bridge.py has seeded the runtime. The
production entry point binds one name, ``rpc_dispatch``; the ~100
``harness.runPython()`` snippets across tests/ predate that and reach for
``parse_csv(...)``, ``_import_radio_class(...)``, ``resolve_session(...)``
and ``json`` as bare globals. Rewriting every one of them to import from its
owning module was judged not worth the churn, so the flattening moved here,
where nothing that ships can depend on it.

Private names are exported on purpose: the snippets reach for them and an
export list would have to be kept in step with every helper they touch.
Values are shared rather than copied, so a ``RadioSession`` a snippet
resolves through the global is the object the modules use -- but *rebinding*
a global does not reach them; a test that swaps a callable patches the owning
module's attribute instead (tests/channels/chirp-import-errors.mjs).

Deliberately not under web/python/: nothing here ships to the browser.
"""

from __future__ import annotations

# The RPC snippets serialize their results with json.dumps(), so the module
# has to be a global even though no bridge module needs it.
import json  # noqa: F401
from typing import TYPE_CHECKING

import webchirp_bridge
from webchirp_bridge import (
    channel_extra,
    channel_rows,
    chirp_loader,
    clone,
    column_metadata,
    driver_cache,
    images,
    jsbridge,
    power_levels,
    radio_memories,
    radio_settings,
    row_validation,
    rpc,
    runtime_errors,
    serial_pipe,
    session,
)

if TYPE_CHECKING:
    import types
    from typing import Any

# Every module whose names the test snippets may use, the package itself
# included for the shims it installs. Order is irrelevant: no two modules
# define the same public name, and each imports what it needs itself.
_BRIDGE_MODULES: tuple[types.ModuleType, ...] = (
    webchirp_bridge,
    jsbridge,
    runtime_errors,
    session,
    chirp_loader,
    driver_cache,
    power_levels,
    channel_rows,
    channel_extra,
    row_validation,
    radio_memories,
    serial_pipe,
    radio_settings,
    clone,
    images,
    column_metadata,
    rpc,
)


def _export_bridge_namespace(
    target: dict[str, Any], modules: tuple[types.ModuleType, ...]
) -> None:
    """Copy each module's namespace, private names included, into ``target``.

    Dunder names stay behind so the globals keep their own ``__name__`` and
    ``__builtins__``. ``rpc_dispatch`` is already there from the entry point
    and is copied again unchanged.
    """
    for module in modules:
        for name, value in vars(module).items():
            if not name.startswith("__"):
                target[name] = value


_export_bridge_namespace(globals(), _BRIDGE_MODULES)
