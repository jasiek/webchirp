"""Static checks of the runtime Python package's conventions.

tests/build/python-conventions.mjs runs this with ``python3 -I`` and asserts
that every list it prints is empty. Each check is a rule that used to live in
CLAUDE.md as prose; reading the source with ``ast`` lets a test hold the code
to it instead, so a new module or function cannot drift from it unnoticed.

Usage: python3 -I python_conventions.py <web/python directory>
Prints one JSON object: rule name -> list of "file:line description" strings.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

PACKAGE = "webchirp_bridge"


def _runtime_files(python_dir: Path) -> list[Path]:
    """The runtime entry point and every bridge module, in a stable order."""
    return [python_dir / "runtime_bridge.py", *sorted((python_dir / PACKAGE).glob("*.py"))]


def _type_checking_nodes(tree: ast.Module) -> set[int]:
    """ids of every node inside an ``if TYPE_CHECKING:`` block."""
    inside: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and "TYPE_CHECKING" in ast.unparse(node.test):
            inside.update(id(child) for child in ast.walk(node))
    return inside


def _functions(tree: ast.AST) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    """Every function and method definition, nested ones included."""
    return [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]


def _parameters(func: ast.FunctionDef | ast.AsyncFunctionDef) -> list[ast.arg]:
    """A function's parameters of every kind, in declaration order."""
    args = func.args
    extra = [a for a in (args.vararg, args.kwarg) if a is not None]
    return [*args.posonlyargs, *args.args, *args.kwonlyargs, *extra]


def check_future_annotations(name: str, tree: ast.Module) -> list[str]:
    """A module without the future import evaluates annotations at runtime,
    which is what makes moving annotation-only imports under TYPE_CHECKING
    unsafe; every module carries it so that move is always safe."""
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "__future__":
            if any(alias.name == "annotations" for alias in node.names):
                return []
    return [f"{name}:1 lacks 'from __future__ import annotations'"]


def check_signatures(name: str, tree: ast.Module) -> list[str]:
    """Every parameter but self/cls, and every return, carries a type."""
    found: list[str] = []
    for func in _functions(tree):
        untyped = [
            p.arg for p in _parameters(func) if p.annotation is None and p.arg not in ("self", "cls")
        ]
        if untyped:
            found.append(f"{name}:{func.lineno} {func.name}() leaves {', '.join(untyped)} untyped")
        if func.returns is None:
            found.append(f"{name}:{func.lineno} {func.name}() has no return annotation")
    return found


def check_radio_params_not_any(name: str, tree: ast.Module) -> list[str]:
    """A parameter named for a radio is typed with the CHIRP class, not Any."""
    found: list[str] = []
    for func in _functions(tree):
        for param in _parameters(func):
            if "radio" in param.arg and param.annotation is not None:
                if ast.unparse(param.annotation) in ("Any", "Optional[Any]", "type[Any]"):
                    found.append(
                        f"{name}:{func.lineno} {func.name}({param.arg}) is typed Any; "
                        "use chirp_common.Radio or the driver class"
                    )
    return found


def _annotation_name_ids(tree: ast.Module) -> set[int]:
    """ids of every node that sits inside an annotation."""
    roots: list[ast.expr] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            roots.extend(p.annotation for p in _parameters(node) if p.annotation is not None)
            if node.returns is not None:
                roots.append(node.returns)
        elif isinstance(node, ast.AnnAssign):
            roots.append(node.annotation)
    return {id(child) for root in roots for child in ast.walk(root)}


def check_annotation_only_imports(name: str, tree: ast.Module) -> list[str]:
    """A top-level import read only by annotations goes under TYPE_CHECKING,
    so it adds no runtime dependency (and no import cycle)."""
    guarded = _type_checking_nodes(tree)
    in_annotation = _annotation_name_ids(tree)
    used_in_annotation: set[str] = set()
    used_at_runtime: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            (used_in_annotation if id(node) in in_annotation else used_at_runtime).add(node.id)
    # __all__ and re-exports read names as strings; count those as runtime use.
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            used_at_runtime.add(node.value)
    found: list[str] = []
    for node in tree.body:
        if not isinstance(node, (ast.Import, ast.ImportFrom)) or id(node) in guarded:
            continue
        if isinstance(node, ast.ImportFrom) and node.module == "__future__":
            continue
        for alias in node.names:
            bound = (alias.asname or alias.name).split(".")[0]
            if bound in used_in_annotation and bound not in used_at_runtime:
                found.append(
                    f"{name}:{node.lineno} imports {bound} only for annotations; "
                    "move it under 'if TYPE_CHECKING:'"
                )
    return found


def _is_exempt_from_comment(func: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """Dunders and property accessors say what they are by their names."""
    if func.name.startswith("__") and func.name.endswith("__"):
        return True
    for decorator in func.decorator_list:
        text = ast.unparse(decorator)
        if text == "property" or text.endswith((".setter", ".getter", ".deleter")):
            return True
    return False


def check_function_comments(name: str, tree: ast.Module, lines: list[str]) -> list[str]:
    """Module-level functions and methods say what they do and why, in a
    docstring or a comment directly above them. Closures are exempt: the
    function that holds them carries the explanation."""
    candidates: list[ast.FunctionDef | ast.AsyncFunctionDef] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            candidates.append(node)
        elif isinstance(node, ast.ClassDef):
            candidates.extend(
                n for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            )
    found: list[str] = []
    for func in candidates:
        if _is_exempt_from_comment(func) or ast.get_docstring(func):
            continue
        first = func.decorator_list[0].lineno if func.decorator_list else func.lineno
        above = lines[first - 2].strip() if first >= 2 else ""
        if not above.startswith("#"):
            found.append(f"{name}:{func.lineno} {func.name}() has no docstring or comment")
    return found


def _package_imports(tree: ast.Module, guarded: set[int]) -> set[str]:
    """Bridge modules this module imports at runtime (TYPE_CHECKING excluded)."""
    deps: set[str] = set()
    for node in ast.walk(tree):
        if id(node) in guarded:
            continue
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level == 1:
                deps.update([module.split(".")[0]] if module else [a.name for a in node.names])
            elif module == PACKAGE:
                deps.update(a.name for a in node.names)
            elif module.startswith(PACKAGE + "."):
                deps.add(module.split(".")[1])
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith(PACKAGE + "."):
                    deps.add(alias.name.split(".")[1])
    return deps


def check_import_cycles(graph: dict[str, set[str]]) -> list[str]:
    """The bridge modules' runtime import graph has no cycle."""
    cycles: list[str] = []
    state: dict[str, int] = {}
    stack: list[str] = []

    # Depth-first search; a back edge to a module still on the stack is a cycle.
    def visit(module: str) -> None:
        state[module] = 1
        stack.append(module)
        for dep in sorted(graph.get(module, ())):
            if dep not in graph or dep == module:
                continue
            if state.get(dep) == 1:
                cycles.append(" -> ".join([*stack[stack.index(dep):], dep]))
            elif not state.get(dep):
                visit(dep)
        stack.pop()
        state[module] = 2

    for module in sorted(graph):
        if not state.get(module):
            visit(module)
    return cycles


def run(python_dir: Path) -> dict[str, list[str]]:
    """Every check over every runtime file, keyed by rule."""
    report: dict[str, list[str]] = {
        "future_annotations": [],
        "signatures": [],
        "radio_params_not_any": [],
        "annotation_only_imports": [],
        "function_comments": [],
        "import_cycles": [],
    }
    graph: dict[str, set[str]] = {}
    for path in _runtime_files(python_dir):
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        name = str(path.relative_to(python_dir))
        report["future_annotations"] += check_future_annotations(name, tree)
        report["signatures"] += check_signatures(name, tree)
        report["radio_params_not_any"] += check_radio_params_not_any(name, tree)
        report["annotation_only_imports"] += check_annotation_only_imports(name, tree)
        report["function_comments"] += check_function_comments(name, tree, source.split("\n"))
        if path.parent.name == PACKAGE:
            graph[path.stem] = _package_imports(tree, _type_checking_nodes(tree))
    report["import_cycles"] = check_import_cycles(graph)
    report["modules_seen"] = sorted(graph)
    return report


if __name__ == "__main__":
    print(json.dumps(run(Path(sys.argv[1]))))
