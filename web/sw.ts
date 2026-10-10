// The service worker that lets WebCHIRP load without a network. All of its
// behaviour lives in web/js/offline-cache.ts; this file only connects it to
// the worker's events.
//
// scripts/build-dist.ts bundles this into dist/sw.js under a fixed name at the
// site root: a worker controls only the pages at or below its own URL, and the
// browser finds a new version by fetching the same URL again (bypassing the
// HTTP cache, so Pages' ten-minute max-age does not delay an update). The dev
// server never serves it -- there is no sw.js in web/ -- and
// web/js/offline.ts does not register it there.
import { createOfflineCache } from "./js/offline-cache.ts";
import type { OfflineMessage } from "./js/offline-cache.ts";

// lib.dom has no worker globals, and lib.webworker cannot be loaded beside it,
// so the members this file uses are declared here.
interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  /** The id of the page a navigation creates; empty for a subresource. */
  readonly resultingClientId: string;
  respondWith(response: Promise<Response>): void;
}

interface MessageEventLike extends ExtendableEventLike {
  // Whatever a page posted: checked before use.
  readonly data: unknown;
  readonly source: { readonly id: string; postMessage(message: OfflineMessage): void } | null;
}

interface ServiceWorkerScope {
  readonly registration: { readonly scope: string };
  readonly clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled: boolean }):
      Promise<ReadonlyArray<{ postMessage(message: OfflineMessage): void }>>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

const worker = globalThis as unknown as ServiceWorkerScope;

const offline = createOfflineCache({
  scope: worker.registration.scope,
  caches,
  fetch: (input, init) => fetch(input, init),
  notify(message) {
    // Uncontrolled pages too: the page that registered this worker is not
    // controlled by it until clients.claim() below has run.
    worker.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => clients.forEach((client) => client.postMessage(message)))
      .catch(() => {});
  },
});

// Take over at once rather than waiting for every tab to close: the worker
// holds no state a page depends on, only caches that every version reads the
// same way (and a layout change renames them).
worker.addEventListener("install", (event) => {
  event.waitUntil(worker.skipWaiting());
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(worker.clients.claim().then(() => offline.sync()));
});

worker.addEventListener("fetch", (event) => {
  const response = offline.respond(event.request, event.resultingClientId);
  if (response) {
    event.respondWith(response);
  }
  // Every page load checks for a newer deploy and caches it in the
  // background; the page itself never waits on that.
  if (event.request.mode === "navigate") {
    event.waitUntil(offline.sync());
  }
});

// A page asking which build it could load offline, and how it was itself
// loaded (web/js/offline.ts reports both).
worker.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown } | null;
  if (data?.type !== "webchirp-offline-status" || !event.source) {
    return;
  }
  const source = event.source;
  event.waitUntil(offline.state().then(({ current }) => {
    source.postMessage({
      type: "webchirp-offline",
      event: "status",
      buildHash: current?.buildHash || null,
      servedFrom: offline.pageSource(source.id),
    });
  }));
});
