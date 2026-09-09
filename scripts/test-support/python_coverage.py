"""coverage.py instrumentation for the Pyodide-hosted webchirp_bridge package.

Executed into Pyodide's globals by scripts/test-support/python-coverage.mjs.
The runtime namespace is flat (web/python/runtime_bridge.py flattens the
package into it), so these names sit alongside the bridge's own and are
prefixed to keep them out of its way.

Deliberately not under web/python/: nothing here ships to the browser. It
exists so npm run coverage can measure the Python half of the runtime, and it
is seeded only when scripts/test-radio-harness.mjs is asked for coverage.

web/python/runtime_bridge.py itself is not measurable. It is the one runtime
file that is executed as a string rather than imported, so CPython compiles it
under the name "<exec>" and coverage cannot map it to a path. The merge step
reports it as uninstrumented rather than silently dropping it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Annotation-only, and gated so it is not imported at runtime: coverage is
    # loaded into Pyodide by _webchirp_coverage_start(), so importing it at
    # module scope would fail on the seed that happens before loadPackage().
    import coverage

# Where seedPyodideRuntime() writes the package inside Pyodide's filesystem.
_PACKAGE_DIR = "/webchirp_runtime/webchirp_bridge"

# The live Coverage object between start and fragment, or None outside that
# window. Named concretely rather than as Any so a reader knows what it holds.
_coverage: coverage.Coverage | None = None


def _webchirp_coverage_start() -> None:
    """Begin tracing every module of the bridge package.

    Uses include= rather than source=. Coverage has to start before
    seedPyodideRuntime() writes the package, and source= resolves a path that
    does not exist yet as a module name instead, then reports "No data was
    collected" -- a silent zero rather than an error.
    """
    global _coverage
    import coverage

    _coverage = coverage.Coverage(data_file=None, include=[f"{_PACKAGE_DIR}/*"])
    _coverage.start()


def _webchirp_coverage_fragment() -> str:
    """Stop tracing and return this process's slice of the result as JSON.

    Every .py in the package is analysed, not only the ones that were imported,
    so a module this process never loaded is reported with all of its
    statements missing rather than omitted. Otherwise Python coverage would
    have the same blind spot V8 coverage has, where an unloaded file is absent
    from the denominator instead of scoring zero.

    Paths are Pyodide filesystem paths; the caller maps them back to
    web/python/. Line numbers are absolute and need no adjustment.
    """
    if _coverage is None:
        return json.dumps({})
    _coverage.stop()
    files: dict[str, dict[str, list[int]]] = {}
    for path in sorted(Path(_PACKAGE_DIR).glob("*.py")):
        name = str(path)
        # analysis2() parses the file whether or not it was ever imported, and
        # returns (filename, statements, excluded, missing, missing_formatted).
        _, statements, _excluded, missing, _formatted = _coverage.analysis2(name)
        executed = sorted(set(statements) - set(missing))
        files[name] = {"statements": sorted(statements), "executed": executed}
    return json.dumps(files)
