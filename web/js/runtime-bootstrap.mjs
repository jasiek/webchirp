// Owns the one-time Pyodide bootstrap: memoizes the in-flight attempt, keeps the
// runtime handle hidden until the whole sequence has succeeded, and marks the
// errors it raises so callers can tell a broken runtime from an ordinary
// failure. Split out of runtime-rpc.js because that module imports Pyodide from
// a CDN at load time and so cannot be imported by the Node test suite.

// Errors raised while bootstrapping are recorded here. The RPC layer used to
// infer "the runtime is broken" from "the pyodide handle is still unset", which
// was wrong in both directions: a plain CDN fetch that runs before boot (the
// driver index) looked like a runtime crash, while a failure seeding the runtime
// bridge -- which happens after the handle is assigned -- did not look like one
// at all. A WeakSet rather than a property so the marker never reaches Sentry
// payloads or a JSON-serialized error.
const bootstrapFailures = new WeakSet();

// True when the error came out of the bootstrap sequence itself, so a caller can
// report a genuine runtime crash and stay quiet about everything else.
export function isBootstrapFailure(error) {
  return typeof error === "object" && error !== null && bootstrapFailures.has(error);
}

// Record an error as a bootstrap failure, normalizing non-Error throws so there
// is always an object identity to key the marker on.
function markBootstrapFailure(error) {
  const marked = error instanceof Error ? error : new Error(String(error));
  bootstrapFailures.add(marked);
  return marked;
}

// Build the bootstrap gate around a caller-supplied loadRuntime(), which must
// resolve to a fully seeded runtime and reject if any step of that fails.
export function createRuntimeBootstrap({ loadRuntime } = {}) {
  if (typeof loadRuntime !== "function") {
    throw new Error("createRuntimeBootstrap requires a loadRuntime() function");
  }

  let runtime = null;
  let attempt = null;

  // Resolve the runtime, starting the bootstrap at most once per outstanding
  // attempt. A rejected attempt is dropped instead of cached: memoizing the
  // promise memoized its rejection too, which turned one transient failure (a
  // blocked CDN, a tab that was briefly offline) into a permanent one until the
  // page was reloaded.
  async function ensure() {
    if (runtime) {
      return runtime;
    }
    if (!attempt) {
      attempt = (async () => {
        try {
          // Publish the handle only once the whole sequence has succeeded. A
          // runtime that loaded but failed to seed cannot run any bridge
          // function, and leaving it visible let callers reach a half-built
          // interpreter and fail later in a way that named the wrong culprit.
          const loaded = await loadRuntime();
          runtime = loaded;
          return loaded;
        } catch (error) {
          throw markBootstrapFailure(error);
        } finally {
          attempt = null;
        }
      })();
    }
    return attempt;
  }

  return {
    ensure,
    // The seeded runtime, or null while it has never finished bootstrapping.
    getRuntime: () => runtime,
  };
}
