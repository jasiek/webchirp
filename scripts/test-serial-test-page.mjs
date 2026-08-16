import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  BAUD_CHECKBOX_SELECTOR,
  ELEMENT_IDS,
  describePort,
} from "../web/js/serial-test-page.js";

// serial-test.html is a hand-maintained page with no framework between it and
// its controller, so the same drift that motivated test-dom-selectors.mjs
// applies: an id renamed on one side is invisible until someone opens the page.
const HTML = fs.readFileSync(path.join(process.cwd(), "web", "serial-test.html"), "utf8");

test("every element the diagnostics page queries exists in its markup", () => {
  const missing = Object.values(ELEMENT_IDS).filter((id) => !HTML.includes(`id="${id}"`));
  assert.deepEqual(missing, [], "serial-test.html is missing elements the controller requires");
});

test("the baud checkboxes the controller reads are present and pre-selected", () => {
  // The selector is a container class plus an input type, so scope to that
  // container and count its checkboxes rather than trying to parse CSS.
  const [, containerClass] = BAUD_CHECKBOX_SELECTOR.match(/^\.([\w-]+)\s/);
  const containerAt = HTML.indexOf(containerClass);
  assert.notEqual(containerAt, -1, `no .${containerClass} container for the baud checkboxes`);

  const block = HTML.slice(containerAt, HTML.indexOf("</fieldset>", containerAt));
  const checkboxes = block.match(/type="checkbox"/g) || [];
  assert.ok(checkboxes.length >= 4, `expected several baud checkboxes, found ${checkboxes.length}`);
  assert.match(block, /value="9600" checked/);
  assert.match(block, /value="115200" checked/);
});

test("the page loads no analytics and does not offer itself for install", () => {
  // A hardware-debugging page must not mint page_view traffic, and it is not
  // part of the installable app.
  assert.ok(!HTML.includes("js/analytics.js"), "diagnostics page must not load analytics");
  assert.ok(!HTML.includes("manifest.webmanifest"), "diagnostics page must not link the manifest");
  assert.ok(!HTML.includes("pyodide"), "diagnostics page must not pull in the Python runtime");
});

test("the encoding declaration stays inside the first 1024 bytes", () => {
  // Same constraint the other pages are held to: a comment block above
  // <meta charset> pushes it out of the window browsers actually scan.
  const at = HTML.indexOf("charset");
  assert.ok(at >= 0 && at < 1024, `charset declared at byte ${at}`);
});

test("describePort names the chip driver behind a WebUSB port", () => {
  // The page's reason to exist: knowing which driver your cable resolved to.
  class Ch340SerialPort {
    getInfo() {
      return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
    }
  }
  assert.equal(
    describePort(new Ch340SerialPort(), "webusb"),
    "WCH CH340/CH341 (WebUSB driver) — USB 0x1a86:0x7523",
  );

  class FtdiSerialPort {
    getInfo() {
      return { usbVendorId: 0x0403, usbProductId: 0x6015 };
    }
  }
  assert.match(describePort(new FtdiSerialPort(), "webusb"), /^FTDI \(WebUSB driver\)/);
});

test("describePort separates the two ports that both call themselves SerialPort", () => {
  // Native Web Serial and the CDC polyfill share a constructor name, so only
  // the transport tells them apart — and mislabelling them would send someone
  // debugging the wrong driver.
  class SerialPort {
    getInfo() {
      return { usbVendorId: 0x2341, usbProductId: 0x0043 };
    }
  }
  assert.match(describePort(new SerialPort(), "webserial"), /^Native Web Serial \(OS driver\)/);
  assert.match(describePort(new SerialPort(), "webusb"), /^USB CDC-ACM \(web-serial-polyfill\)/);
});

test("describePort survives a port that reports no USB identity", () => {
  // Native ports for on-board UARTs return an empty getInfo(), and a port that
  // has never been opened may throw from it.
  class SerialPort {
    getInfo() {
      return {};
    }
  }
  assert.equal(describePort(new SerialPort(), "webserial"), "Native Web Serial (OS driver)");

  class ThrowingPort {
    getInfo() {
      throw new Error("not opened");
    }
  }
  assert.equal(describePort(new ThrowingPort(), "webserial"), "Native Web Serial (OS driver)");
});
