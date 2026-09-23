import { createRuntimeBootstrap } from "./runtime-bootstrap.mjs";

// Keep conflicting driver releases in separate interpreters. Calls are serialized
// by the RPC queue; ordinary CHIRP mode continues sharing one interpreter.
export function createSelectedDriverRuntime({ loadRuntime, isolated = false }) {
  let bootstrap = createRuntimeBootstrap({ loadRuntime });
  let selectedModule = "";

  // Reuse the interpreter for the same release, including its cached clone image.
  async function select(moduleName) {
    if (isolated && selectedModule && selectedModule !== moduleName) {
      const next = createRuntimeBootstrap({ loadRuntime });
      const runtime = await next.ensure();
      bootstrap = next;
      selectedModule = moduleName;
      return runtime;
    }
    const runtime = await bootstrap.ensure();
    selectedModule = moduleName;
    return runtime;
  }

  return { ensure: () => bootstrap.ensure(), select };
}
