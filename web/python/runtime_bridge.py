"""Entry point of the webchirp Python runtime, executed into Pyodide's globals.

``seedPyodideRuntime()`` in ``web/js/python-sources.mjs`` writes the
``webchirp_bridge`` package into the Pyodide filesystem and then runs this file
with ``runPythonAsync`` -- it is executed, not imported, so every name it binds
lands in the interpreter's globals namespace. It binds exactly one that JS
uses: ``rpc_dispatch``, the single callable through which
``web/js/rpc-dispatch.mjs`` reaches every runtime function listed in
``RPC_METHODS`` (``web/python/webchirp_bridge/rpc.py``). The runtime logic
itself lives in the package modules, one per concern; this file only puts the
interpreter in the state they expect and imports the dispatcher. Nothing else
is flattened into the globals, so the module a function lives in is the only
place it can be called from -- the tests that need more import it from there
(``tests/support/bridge_namespace.py``).
"""

from __future__ import annotations

import sys

# The package and the seeded CHIRP sources both live under this directory (the
# JS side writes them there); the guard keeps a re-run from stacking entries.
if "/webchirp_runtime" not in sys.path:
    sys.path.insert(0, "/webchirp_runtime")

from webchirp_bridge.rpc import rpc_dispatch  # noqa: E402, F401

# Executed into the globals, so leave nothing behind but the dispatcher.
del sys
