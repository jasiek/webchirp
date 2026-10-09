// Owns the one-time Pyodide bootstrap: memoizes the in-flight attempt, keeps the
// runtime handle hidden until the whole sequence has succeeded, and marks the
// errors it raises so callers can tell a broken runtime from an ordinary
// failure. Split out of web/js/runtime-rpc.ts because that module imports Pyodide from
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
export function isBootstrapFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && bootstrapFailures.has(error);
}

// Record an error as a bootstrap failure, normalizing non-Error throws so there
// is always an object identity to key the marker on. The RPC layer preserves
// that identity when rethrowing, so downstream action handling can avoid
// capturing the same bootstrap failure a second time.
/**
 * @returns The error itself, or an Error wrapping a non-Error throw.
 */
export function markBootstrapFailure(error: unknown): Error {
  const marked = error instanceof Error ? error : new Error(String(error));
  bootstrapFailures.add(marked);
  return marked;
}

// Report a bootstrap failure at most once per failed attempt.
//
// Deduplication has to key on the failure, not on a latch. A boolean latch
// cleared on a successful bootstrap can never re-arm: ensure() caches the
// runtime once it succeeds, so a success is never followed by another failure,
// and the clear is unreachable in every case that would matter. That let a
// first loadPyodide failure permanently silence a second, distinct
// seedPyodideRuntime failure on the retry.
//
// Every call queued behind one attempt rejects with the same error object, so
// error identity is exactly the attempt: it collapses the queue into one report
// while still reporting the next attempt's different failure. The return value
// says whether this failure has been reported at all, now or earlier, so the
// caller can stop the action-level funnel capturing the same crash twice.
/**
 * @param reportCrash Told the failure's detail once.
 * @returns 
 *   Whether the error is a bootstrap failure (and so has been reported).
 */
export function createBootstrapCrashReporter(
  reportCrash: (detail: string) => void,
): (error: unknown, detail: string) => boolean {
  if (typeof reportCrash !== "function") {
    throw new Error("createBootstrapCrashReporter requires a reportCrash() function");
  }

  let lastReported: unknown = null;

  return function reportBootstrapCrash(error, detail) {
    if (!isBootstrapFailure(error)) {
      return false;
    }
    if (error === lastReported) {
      return true;
    }
    lastReported = error;
    reportCrash(detail);
    return true;
  };
}

export interface RuntimeBootstrap<T> {
  /** The seeded runtime, booting it if needed. */
  ensure: () => Promise<T>;
  /** The seeded runtime, or null before boot. */
  getRuntime: () => T | null;
}

// Build the bootstrap gate around a caller-supplied loadRuntime(), which must
// resolve to a fully seeded runtime and reject if any step of that fails.
export function createRuntimeBootstrap<T>(
  { loadRuntime }: { loadRuntime?: () => Promise<T> } = {},
): RuntimeBootstrap<T> {
  if (typeof loadRuntime !== "function") {
    throw new Error("createRuntimeBootstrap requires a loadRuntime() function");
  }

  // Bound after the check above so the closures below see a function.
  const load = loadRuntime;
  let runtime: T | null = null;
  let attempt: Promise<T> | null = null;

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
          const loaded = await load();
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
