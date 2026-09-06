// Fake Web Serial-shaped ports and transports for the BrowserSerialBridge
// tests. The bridge only ever sees a port through open/close/setSignals and a
// reader/writer pair, so one recording port with a few knobs stands in for
// every scenario the tests exercise: an adapter that disappears, a mid-clone
// reopen, a refused open, a line that delivers bytes at a chosen moment.
//
// The loopback fakes (createEchoPort, createChipLoopbackPort in
// test-loopback-harness.mjs) model a wire and stay separate on purpose.
import { tick } from "./globals.mjs";

// A minimal EventTarget: what navigator.serial / navigator.usb look like to
// the bridge's port-loss watch. listenerCount lets a test check the watch was
// torn down, emit lets it fire a disconnect.
export function makeEmitter(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(type, fn) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
    emit(type, event) {
      for (const fn of Array.from(listeners.get(type) || [])) {
        fn(event);
      }
    },
  };
}

// A port that records how it was opened, closed and signalled, and whose
// reader delivers exactly the chunks the test pushes — parking until then, as
// a real reader does, so the bridge's read loop behaves like a real one
// instead of spinning through the test.
//
// Options:
//   usbVendorId/usbProductId — what getInfo() reports
//   device          — the USBDevice behind a WebUSB port; left off when absent,
//                     the way the polyfilled CDC port keeps its device private
//   failOpenWhen    — (options, attempt) => message or null; a message makes
//                     that open() throw after it has been recorded
//   failSignalsWith — message every setSignals() throws with
//   deliverOnCancel — a chunk the adapter had already completed when a reopen
//                     began: a real reader hands it to the pending read()
//                     before the cancellation takes effect
//   deliverOnReopen — a chunk the reopened stream has ready the instant the
//                     new read loop asks for one
// The last two are the windows in which a mid-clone reopen can lose bytes.
//
// Records: opens (option copies), closes, signals (every call), written
// (every byte), plus opened/closed flags. push(bytes) puts a chunk on the line.
export function makeRecordingPort({
  usbVendorId = 0x0403,
  usbProductId = 0x6015,
  device,
  failOpenWhen = () => null,
  failSignalsWith = null,
  deliverOnCancel = null,
  deliverOnReopen = null,
} = {}) {
  // Chunks pushed that no read has consumed yet, and the read parked for one.
  const chunks = [];
  let pendingRead = null;
  let readers = 0;

  // Hand the parked read whatever it can have now: the next chunk, or the end
  // of the stream once the port is closed.
  function settle() {
    if (!pendingRead) {
      return;
    }
    if (chunks.length > 0) {
      const resolve = pendingRead;
      pendingRead = null;
      resolve({ value: chunks.shift(), done: false });
    } else if (port.closed) {
      const resolve = pendingRead;
      pendingRead = null;
      resolve({ done: true });
    }
  }

  // Each getReader() is a fresh reader; cancelling one ends only that reader,
  // so a loop left pinned to a cancelled reader reads nothing while the
  // reader a reopen created still sees the line.
  function getReader() {
    readers += 1;
    const reopened = readers > 1;
    let cancelled = false;
    if (reopened && deliverOnReopen) {
      chunks.push(Uint8Array.from(deliverOnReopen));
    }
    return {
      read() {
        if (cancelled) {
          return Promise.resolve({ done: true });
        }
        if (chunks.length > 0) {
          return Promise.resolve({ value: chunks.shift(), done: false });
        }
        if (port.closed) {
          return Promise.resolve({ done: true });
        }
        return new Promise((resolve) => {
          pendingRead = resolve;
        });
      },
      async cancel() {
        if (!reopened && deliverOnCancel) {
          port.push(deliverOnCancel);
          await tick();
        }
        cancelled = true;
        const resolve = pendingRead;
        pendingRead = null;
        resolve?.({ done: true });
      },
      releaseLock() {},
    };
  }

  const port = {
    opened: false,
    closed: false,
    opens: [],
    closes: 0,
    signals: [],
    written: [],
    getInfo: () => ({ usbVendorId, usbProductId }),
    async open(options = {}) {
      const failure = failOpenWhen(options, port.opens.length);
      port.opens.push({ ...options });
      if (failure) {
        throw new Error(failure);
      }
      port.opened = true;
      port.closed = false;
    },
    async close() {
      port.closes += 1;
      port.closed = true;
      settle();
    },
    async setSignals(signals) {
      if (failSignalsWith) {
        throw new Error(failSignalsWith);
      }
      port.signals.push({ ...signals });
    },
    push(bytes) {
      chunks.push(Uint8Array.from(bytes));
      settle();
    },
    readable: { getReader },
    writable: {
      getWriter: () => ({
        async write(bytes) {
          port.written.push(...bytes);
        },
        releaseLock() {},
      }),
    },
  };
  if (device !== undefined) {
    port.device = device;
  }
  return port;
}
