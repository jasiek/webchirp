// Minimal window stand-in shared by the analytics and error-reporting tests.
// Both modules take the window as an argument rather than reaching for the
// global, so a plain object with the handful of members they touch is enough:
// a hostname for the production-host gate, an event-listener registry a test
// can dispatch at and count, and the few browser APIs each module probes.
//
// Every consumer gets the full surface. The extra members are inert for a
// module that never calls them, and one shape means a test for either module
// can assert on listener bookkeeping the same way.

// Build a fake window.
//   hostname     - what location.hostname reports; defaults to production.
//   displayModes - the display-mode media queries that should match.
//   standalone   - navigator.standalone, or undefined to leave it unset (iOS
//                  home-screen launches are the only place it exists).
//   version      - what fetch("./version.json") resolves to; null makes the
//                  response not-ok, as a missing file would.
//   fetch        - an explicit fetch, when a test needs more than version.json.
// Also exposes `injected` (every node appended to document.head) and the
// `dispatch`/`listenerCount` helpers tests drive listeners through.
export function makeWindow({
  hostname = "codeplug.org",
  displayModes = [],
  standalone = undefined,
  version = { webchirpSha: "abc123" },
  fetch = async () => ({ ok: version !== null, json: async () => version }),
} = {}) {
  const listeners = new Map();
  const injected = [];
  return {
    location: { hostname },
    injected,
    document: {
      createElement: () => ({}),
      head: {
        appendChild(node) {
          injected.push(node);
        },
      },
    },
    navigator: standalone === undefined ? {} : { standalone },
    matchMedia: (query) => ({
      matches: displayModes.some((mode) => query === `(display-mode: ${mode})`),
    }),
    fetch,
    addEventListener(type, handler) {
      const existing = listeners.get(type) || [];
      existing.push(handler);
      listeners.set(type, existing);
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== handler));
    },
    // Iterates a copy: a handler that removes itself while running must not
    // shift the next one out from under the loop.
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) || [])]) {
        handler(event);
      }
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
}
