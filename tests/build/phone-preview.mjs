// npm run phone (scripts/phone-preview.ts) opens the dev server on a phone
// over adb. What it reads from adb, and which phone it picks or why it picks
// none, is checked here; adb itself needs a phone, so the rest is manual.
import assert from "node:assert/strict";
import test from "node:test";

import { choosePhone, parseAdbDevices, phoneUrl } from "../../scripts/phone-preview.ts";

test("adb devices output is read into serials and states", () => {
  const output = "List of devices attached\nSERIAL0001\tdevice\nSERIAL0002\tunauthorized\n\n";
  assert.deepEqual(parseAdbDevices(output), [
    { serial: "SERIAL0001", state: "device" },
    { serial: "SERIAL0002", state: "unauthorized" },
  ]);
  assert.deepEqual(parseAdbDevices("List of devices attached\n\n"), []);
});

test("the one authorized phone is chosen", () => {
  const phone = { serial: "A", state: "device" };
  assert.deepEqual(choosePhone([phone], undefined), phone);
});

test("ANDROID_SERIAL picks one of several phones", () => {
  const devices = [{ serial: "A", state: "device" }, { serial: "B", state: "device" }];
  assert.match(String(choosePhone(devices, undefined)), /set ANDROID_SERIAL/);
  assert.deepEqual(choosePhone(devices, "B"), devices[1]);
  assert.match(String(choosePhone(devices, "C")), /does not list C/);
});

test("a phone that cannot be used says what to do on it", () => {
  assert.match(String(choosePhone([], undefined)), /USB debugging/);
  assert.match(String(choosePhone([{ serial: "A", state: "unauthorized" }], undefined)), /tap Allow/);
  assert.match(String(choosePhone([{ serial: "A", state: "offline" }], undefined)), /A is offline/);
});

test("the page opens on the phone's own localhost", () => {
  assert.equal(phoneUrl(8123, ""), "http://localhost:8123/");
  assert.equal(phoneUrl(8000, "/serial-test.html?x=1"), "http://localhost:8000/serial-test.html?x=1");
});
