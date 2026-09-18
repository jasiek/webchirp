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
//   broadcast    - false to leave BroadcastChannel off the window, as a browser
//                  without it (or with site data blocked) presents it.
// Also exposes `injected` (every node appended to document.head), `broadcasts`
// (every message posted to a channel) and the `dispatch`/`listenerCount`/
// `deliverBroadcast` helpers tests drive listeners through.
export function makeWindow({
  hostname = "codeplug.org",
  displayModes = [],
  standalone = undefined,
  version = { webchirpSha: "abc123" },
  fetch = async () => ({ ok: version !== null, json: async () => version }),
  broadcast = true,
} = {}) {
  const listeners = new Map();
  const injected = [];
  // One window stands in for one tab, so the channels it opens are collected
  // here and a test plays the part of the other tab by delivering to them.
  const broadcasts = [];
  const channels = [];
  class FakeBroadcastChannel {
    constructor(name) {
      this.name = String(name);
      this.onmessage = null;
      this.closed = false;
      channels.push(this);
    }

    postMessage(data) {
      broadcasts.push({ name: this.name, data });
    }

    close() {
      this.closed = true;
    }
  }
  return {
    broadcasts,
    BroadcastChannel: broadcast ? FakeBroadcastChannel : undefined,
    // What another tab on this origin posting the message looks like from here.
    deliverBroadcast(data) {
      for (const channel of channels) {
        if (!channel.closed && typeof channel.onmessage === "function") {
          channel.onmessage({ data });
        }
      }
    },
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
