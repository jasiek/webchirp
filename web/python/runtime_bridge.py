"""Entry point of the webchirp Python runtime, executed into Pyodide's globals.

``seedPyodideRuntime()`` in ``web/js/python-sources.mjs`` writes the
``webchirp_bridge`` package into the Pyodide filesystem and then runs this file
with ``runPythonAsync`` -- it is executed, not imported, so every name it binds
lands in the interpreter's globals namespace. That namespace is the RPC
surface: each expression ``web/js/runtime-rpc.js`` evaluates
(``json.dumps(parse_csv(_csv_input))``) and each ``harness.runPython()`` call
in the tests resolves its names there. The runtime logic itself lives in the
package modules, one per concern; this file only puts the interpreter in the
state they expect and then flattens their namespaces into that one, so a
caller need not know which module a function lives in.
"""

from __future__ import annotations

# The RPC expressions serialize their results with json.dumps(), so the module
# has to be a global even though no bridge module needs it.
import json  # noqa: F401
import sys
from typing import TYPE_CHECKING

# The package and the seeded CHIRP sources both live under this directory (the
# JS side writes them there); the guard keeps a re-run from stacking entries.
if "/webchirp_runtime" not in sys.path:
    sys.path.insert(0, "/webchirp_runtime")

import webchirp_bridge  # noqa: E402
from webchirp_bridge import (  # noqa: E402
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
    runtime_errors,
    serial_pipe,
)

if TYPE_CHECKING:
    import types
    from typing import Any

# Every module whose names make up the RPC namespace, the package itself
# included for the shims it installs. Order is irrelevant: no two modules
# define the same name, and each imports what it needs itself.
BRIDGE_MODULES: tuple[types.ModuleType, ...] = (
    webchirp_bridge,
    jsbridge,
    runtime_errors,
    chirp_loader,
    driver_cache,
    power_levels,
    channel_rows,
    row_validation,
    radio_memories,
    serial_pipe,
    radio_settings,
    clone,
    images,
    column_metadata,
)


def _export_bridge_namespace(
    target: dict[str, Any], modules: tuple[types.ModuleType, ...]
) -> None:
    """Copy each module's namespace, private names included, into ``target``.

    Private helpers are exported on purpose: the tests reach for them
    (``_import_radio_class``, ``LAST_IMAGE_BY_DRIVER``) and so do the harness
    snippets in ``scripts/test-radio-harness.mjs``, and an explicit export
    list would have to be kept in step with every helper they touch. Dunder
    names stay behind so the globals keep their own ``__name__`` and
    ``__builtins__``. Values are shared rather than copied, so mutating
    ``LAST_IMAGE_BY_DRIVER`` through the global mutates the cache the modules
    use -- but *rebinding* a global does not reach them; a test that swaps a
    callable patches the owning module's attribute instead
    (``scripts/test-chirp-import-errors.mjs``).
    """
    for module in modules:
        for name, value in vars(module).items():
            if not name.startswith("__"):
                target[name] = value


_export_bridge_namespace(globals(), BRIDGE_MODULES)
