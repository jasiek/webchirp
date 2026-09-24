// The RPC contract between JS and Python, checked from both ends.
//
// JS reaches the Python runtime through one callable, rpc_dispatch
// (web/python/webchirp_bridge/rpc.py), by method name and named parameters.
// The names live in two tables that must agree: RPC_METHODS in
// web/js/rpc-dispatch.mjs (what JS may ask for, and with which parameters)
// and RPC_METHODS in web/python/webchirp_bridge/rpc.py (which function
// answers). Nothing at runtime compares them -- a method added on one side
// only fails the first time it is called -- so this test does, and it also
// pins the two properties the design rests on: the entry point binds nothing
// but the dispatcher into Pyodide's globals, and no call writes anything into
// them on its way through.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  RPC_CALLBACK_PARAM,
  RPC_METHODS,
  prepareRpcCall,
} from "../../web/js/rpc-dispatch.mjs";
import { sharedHarness } from "../support/chirp.mjs";
import { repoRoot } from "../support/repo-paths.mjs";

// Both Python tables at once, decoded: each method's parameter names in
// declaration order, and the name the bound function itself carries.
async function pythonContract(harness) {
  return harness.runPythonJson(`
from webchirp_bridge.rpc import CALLBACK_PARAM, RPC_METHODS, rpc_method_parameters
json.dumps({
  "callbackParam": CALLBACK_PARAM,
  "methods": {
    name: {"params": rpc_method_parameters(name), "function": fn.__name__}
    for name, fn in RPC_METHODS.items()
  },
})
  `);
}

// Every .js/.mjs under the given directories, for the call-site scan.
function sourceFiles(dirs) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.m?js$/.test(entry.name)) {
        found.push(full);
      }
    }
  };
  for (const dir of dirs) {
    walk(dir);
  }
  return found;
}

test("the JS and Python RPC tables name the same methods with the same parameters", async () => {
  const harness = await sharedHarness();
  const python = await pythonContract(harness);

  assert.equal(python.callbackParam, RPC_CALLBACK_PARAM);
  assert.deepEqual(
    Object.keys(RPC_METHODS).sort(),
    Object.keys(python.methods).sort(),
    "RPC_METHODS in web/js/rpc-dispatch.mjs and web/python/webchirp_bridge/rpc.py differ",
  );
  for (const [name, params] of Object.entries(RPC_METHODS)) {
    assert.deepEqual(
      [...params],
      python.methods[name].params,
      `${name}: JS sends different parameters from what the Python function declares`,
    );
    // Keys are the functions' own names so one grep finds definition, table
    // and call sites; a key that names a different function breaks that.
    assert.equal(python.methods[name].function, name, `${name} is bound to another function`);
  }
});

test("every RPC method has a JS caller outside the table that declares it", () => {
  const files = sourceFiles([
    path.join(repoRoot, "web", "js"),
    path.join(repoRoot, "tests", "support"),
    path.join(repoRoot, "scripts"),
  ]).filter((file) => !file.endsWith("rpc-dispatch.mjs"));
  const sources = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const unused = Object.keys(RPC_METHODS).filter((name) => !sources.includes(`"${name}"`));
  assert.deepEqual(unused, [], "RPC methods nothing calls; delete them or call them");
});

test("the entry point binds only rpc_dispatch into the interpreter globals", async () => {
  const harness = await sharedHarness();
  const entryPoint = fs.readFileSync(path.join(repoRoot, "web", "python", "runtime_bridge.py"), "utf8");
  // Re-run the entry point into a fresh namespace rather than inspecting the
  // live globals, which tests/support/bridge_namespace.py has flattened the
  // whole package into by the time a test runs.
  const bound = await harness.runPythonJson(
    `
_ns = {"__name__": "rpc_contract_probe"}
exec(_entry_source, _ns)
json.dumps(sorted(name for name in _ns if not name.startswith("__")))
    `,
    { _entry_source: entryPoint },
  );
  // "annotations" is the from __future__ import every runtime file carries.
  assert.deepEqual(bound, ["annotations", "rpc_dispatch"]);
});

test("a dispatched call leaves nothing behind in the interpreter globals", async () => {
  const harness = await sharedHarness();
  const before = await harness.runPythonJson("json.dumps(sorted(globals()))");
  await harness.rpc("get_default_schema");
  await harness.rpc("parse_csv", { csv_text: "Location,Name,Frequency\n0,Test,145.500000\n" });
  const seen = [];
  await harness.rpc("import_all_driver_modules", {
    module_short_names: ["h777"],
    callback: (done, total, moduleShort) => seen.push([done, total, moduleShort]),
  });
  const after = await harness.runPythonJson("json.dumps(sorted(globals()))");
  assert.deepEqual(after, before);
  assert.deepEqual(seen, [[1, 1, "h777"]], "the callback crosses as the one non-JSON argument");
});

test("the browser runtime client writes no argument globals and evaluates no expression strings", () => {
  const source = fs.readFileSync(path.join(repoRoot, "web", "js", "runtime-rpc.js"), "utf8");
  assert.equal(source.includes("globals.set("), false, "runtime-rpc.js sets an interpreter global");
  assert.equal(source.includes("runPython"), false, "runtime-rpc.js evaluates a Python string");
});

test("a call that does not match the contract is refused before it crosses", async () => {
  assert.throws(() => prepareRpcCall("no_such_method", {}), /Unknown RPC method no_such_method/);
  assert.throws(
    () => prepareRpcCall("parse_csv", {}),
    /parse_csv takes \(csv_text\), got \(\)/,
  );
  assert.throws(
    () => prepareRpcCall("parse_csv", { csv_text: "", extra: 1 }),
    /parse_csv takes \(csv_text\), got \(csv_text, extra\)/,
  );
  assert.throws(
    () => prepareRpcCall("parse_csv", { csv_text: "", callback: () => {} }),
    /parse_csv takes no callback/,
  );
  assert.throws(
    () => prepareRpcCall("import_all_driver_modules", { module_short_names: [], callback: "no" }),
    /callback must be a function/,
  );
  // The callback is the one optional slot: the JSON parameters are checked
  // exactly, and only they cross as JSON.
  assert.deepEqual(prepareRpcCall("import_all_driver_modules", { module_short_names: ["x"] }), {
    paramsJson: '{"module_short_names":["x"]}',
    callback: null,
  });

  // The Python side refuses on its own too, for a caller that bypasses the
  // JS table.
  const harness = await sharedHarness();
  await assert.rejects(
    harness.runPython('await rpc_dispatch("no_such_method", "{}")'),
    /Unknown RPC method 'no_such_method'/,
  );
  await assert.rejects(
    harness.runPython('await rpc_dispatch("parse_csv", "[]")'),
    /expects a JSON object of named parameters/,
  );
});
