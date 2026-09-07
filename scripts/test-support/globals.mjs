// Shared helpers for tests that stand in browser globals (navigator) and step
// the event loop by hand. The bridge and the WebUSB drivers reach their
// transports through globalThis.navigator, so nearly every serial test has to
// replace it; keeping the replacement in one place means the restore logic is
// written once and not forgotten.

// Replace globalThis.navigator with a fake for the rest of the process. Only
// for files that never need the real one back; prefer withNavigator().
export function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
}

// Replace globalThis.navigator for the duration of one test, restoring the
// previous descriptor (or its absence) in t.after so later tests — including
// Pyodide boots that read the real navigator — start from a clean global.
export function withNavigator(t, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  setNavigator(value);
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, "navigator", previous);
    } else {
      delete globalThis.navigator;
    }
  });
}

// Let one macrotask turn pass so promise-driven machinery — a ReadableStream's
// pull, the bridge's read loop — runs between two steps of a test. Stream
// pulls are invoked off a microtask and await transfers, so a plain await is
// not enough; setImmediate runs after every pending microtask has drained.
export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
