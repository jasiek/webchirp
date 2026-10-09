// tests/support/index-page.mjs reuses one parsed page per test file, so it is
// what keeps one test's stubs out of the next: a stub assigned straight onto
// the window, navigator or document the page hands out, or onto a global after
// the page was installed, must be gone when the next test runs. The first test
// below plants them and the second checks for them, so the pair runs in file
// order on purpose (node:test runs a file's tests in sequence).
import assert from "node:assert/strict";
import test from "node:test";

import { installIndexPage } from "../support/index-page.mjs";

// What the first test replaced, captured before it did, for the second to
// compare against.
const original = {};

test("a test may stub the page's window, navigator, document and globals directly", () => {
  const { window, navigator, document } = installIndexPage();
  original.confirm = window.confirm;
  original.userAgent = navigator.userAgent;
  original.fetch = globalThis.fetch;
  original.innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
  original.hadAlert = Object.prototype.hasOwnProperty.call(window, "alert");

  window.leakedStub = "from the first test";
  window.confirm = () => true;
  // A getter replaced and a property removed, the shapes an assignment
  // cannot make.
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => 123 });
  delete window.alert;
  navigator.clipboard = { writeText: async () => {} };
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Leaked/1.0" });
  document.leakedStub = "from the first test";
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async () => "leaked" });

  assert.equal(window.leakedStub, "from the first test");
  assert.equal(window.innerWidth, 123);
});

test("the next test finds every one of them put back", () => {
  const { window, navigator, document } = installIndexPage();

  assert.equal(window.leakedStub, undefined);
  assert.equal(window.confirm, original.confirm);
  assert.deepEqual(Object.getOwnPropertyDescriptor(window, "innerWidth"), original.innerWidthDescriptor);
  assert.equal(Object.prototype.hasOwnProperty.call(window, "alert"), original.hadAlert);
  assert.equal(navigator.clipboard, undefined);
  assert.equal(navigator.userAgent, original.userAgent);
  assert.equal(document.leakedStub, undefined);
  assert.equal(globalThis.fetch, original.fetch);
});

test("a global a test stubs before installing the page lasts for that test", (t) => {
  // tests/channels/repeater-adapters.mjs stubs fetch, then builds the
  // adapters, which installs the page; the stub is that test's own setup.
  const stub = async () => "stubbed";
  const previous = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  t.after(() => Object.defineProperty(globalThis, "fetch", previous));
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: stub });

  installIndexPage();

  assert.equal(globalThis.fetch, stub);
});
