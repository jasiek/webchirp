import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createBrowserCdnPythonSource,
  createFilesystemPythonSource,
  seedPyodideRuntime,
} from "../web/js/python-sources.mjs";

test("browser runtime siblings load beside a custom bridge URL", async () => {
  const urls = [];
  const provider = createBrowserCdnPythonSource({
    runtimeBridgePath: "https://example.test/app/python/runtime_bridge.py",
    fetchTextImpl: async (url) => { urls.push(url); return url; },
  });
  const modules = await provider.fetchRuntimeModules();
  assert.equal(Object.keys(modules).length, 7);
  for (const [name, source] of Object.entries(modules)) {
    assert.equal(source, `https://example.test/app/python/${name}`);
  }
  assert.equal(urls.length, 7);
});

test("filesystem runtime siblings use stable source filenames", async () => {
  const provider = createFilesystemPythonSource({
    chirpPackageDir: "/repo/chirp/chirp",
    runtimeBridgePath: "/repo/web/python/runtime_bridge.py",
    readText: async (file) => file,
    readDirNames: async () => [],
    joinPath: path.join,
  });
  const modules = await provider.fetchRuntimeModules();
  for (const [name, source] of Object.entries(modules)) {
    assert.equal(source, `/repo/web/python/${name}`);
  }
});

test("seeding writes every sibling before executing the bridge", async () => {
  const files = new Map();
  let executed = false;
  await seedPyodideRuntime({
    FS: {
      mkdir() {},
      writeFile(file, source) { files.set(file, source); },
    },
    async runPythonAsync(source) {
      assert.equal(source, "bridge");
      assert.equal(files.get("/webchirp_runtime/runtime_support.py"), "support");
      assert.ok(files.has("/webchirp_runtime/chirp/chirp_common.py"));
      executed = true;
    },
  }, {
    async fetchChirpSource() { return "chirp"; },
    async fetchRuntimeBridge() { return "bridge"; },
    async fetchRuntimeModules() { return { "runtime_support.py": "support" }; },
    async listDriverModules() { return []; },
  });
  assert.equal(executed, true);
});
