import assert from "node:assert/strict";
import test from "node:test";

import {
  callsignFromName,
  createCallsignLookup,
  parseLookupXml,
  pickLookupEntry,
} from "../../web/js/callsign-lookup.js";
import { installFakeDom } from "../support/fake-dom.mjs";
import { fakeXmlGlobals } from "../support/fake-xml.mjs";

// parseLookupXml runs on the browser's DOMParser, which node has not got.
installFakeDom({ globals: fakeXmlGlobals() });

function entry({ qra = "GB3KI", rx = "145.0375", tx = "145.6375", latitude = "51.370400", longitude = "1.128900", qth = "" } = {}) {
  return `<repeater><qra>${qra}</qra><qth>${qth}</qth>`
    + `<qrg type="rx">${rx}</qrg><qrg type="tx">${tx}</qrg>`
    + `<location><latitude>${latitude}</latitude><longitude>${longitude}</longitude></location>`
    + "</repeater>";
}

function response(entries) {
  return `<?xml version="1.0"?><rxf><perspective>repeater</perspective><repeaters>${entries.join("")}</repeaters></rxf>`;
}

test("callsignFromName accepts the callsign shapes a repeater name takes", () => {
  // The endpoint is case-sensitive -- /lookup/gb3km is a 404 where
  // /lookup/GB3KM is not -- so the gate normalizes as well as filters.
  assert.equal(callsignFromName(" gb3ki "), "GB3KI");
  for (const name of ["GB3IC", "W1AW", "DB0XYZ", "F5ZXX", "VK3RMM", "2E0ABC", "9A0ABC", "SR5PK"]) {
    assert.equal(callsignFromName(name), name, `${name} is a callsign`);
  }
});

test("callsignFromName rejects the preset channel names a codeplug is full of", () => {
  // These are the rows that would otherwise spend a request and a cached 404
  // each, for names no repeater directory could ever hold.
  for (const name of ["", "   ", "PMR 1", "GMRS 15R", "FRS 10", "Marine 16", "Home", "146.520", null, undefined]) {
    assert.equal(callsignFromName(name), "", `${name} is not a callsign`);
  }
});

test("parseLookupXml drops entries with no usable position", () => {
  // A directory entry without coordinates is not a partial answer for this
  // feature -- there is nothing to draw -- and 0,0 is what several sources
  // publish for "unknown" (GB3IC is one), which would map the Gulf of Guinea.
  const parsed = parseLookupXml(response([
    entry({ latitude: "0.000000", longitude: "0.000000" }),
    entry({ qra: "GB3AM", latitude: "51.650000", longitude: "-0.620000" }),
    entry({ qra: "GB3XX", latitude: "", longitude: "" }),
  ]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].qra, "GB3AM");
  assert.equal(parsed[0].latitude, 51.65);
  assert.equal(parsed[0].longitude, -0.62);
});

test("pickLookupEntry picks the entry nearest the row's frequency", () => {
  // W1AW is the real case: two machines 2 km apart under one callsign, told
  // apart only by frequency.
  const entries = parseLookupXml(response([
    entry({ qra: "W1AW", rx: "145.45000", tx: "144.85000", latitude: "41.69779968", longitude: "-72.72419739" }),
    entry({ qra: "W1AW", rx: "147.42500", tx: "146.82500", latitude: "41.69729960", longitude: "-72.72282930" }),
  ]));
  assert.equal(pickLookupEntry(entries, 147.425).latitude, 41.6972996);
  assert.equal(pickLookupEntry(entries, 145.45).latitude, 41.69779968);
  // Both sides are compared, because <perspective> decides which of rx/tx
  // holds the output frequency and the two upstreams behind this endpoint
  // disagree about it.
  assert.equal(pickLookupEntry(entries, 146.825).latitude, 41.6972996);
  // A blank or mid-edit Frequency cell still gets the directory's first answer.
  assert.equal(pickLookupEntry(entries, NaN).latitude, 41.69779968);
  assert.equal(pickLookupEntry([], 145.45), null);
});

function fakeFetch(bodies) {
  const requested = [];
  const fetchImpl = (url) => {
    requested.push(String(url));
    const body = bodies[String(url).split("/").pop()];
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
    }
    if (body instanceof Error) {
      return Promise.reject(body);
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
  };
  return { fetchImpl, requested };
}

test("a 404 is an answer, cached like any other", async () => {
  // Not an error: "this callsign is in no directory" is exactly what the map
  // needs to know, and the endpoint caches its 404s for 24h too.
  const { fetchImpl, requested } = fakeFetch({});
  const { lookup } = createCallsignLookup("https://api.example.com/lookup", { fetchImpl });
  assert.deepEqual(await lookup("GB3ZZ"), []);
  assert.deepEqual(await lookup("GB3ZZ"), []);
  assert.deepEqual(requested, ["https://api.example.com/lookup/GB3ZZ"]);
});

test("concurrent lookups of one callsign share a single request", async () => {
  const { fetchImpl, requested } = fakeFetch({ GB3KI: response([entry()]) });
  const { lookup } = createCallsignLookup("https://api.example.com/lookup", { fetchImpl });
  const [a, b] = await Promise.all([lookup("GB3KI"), lookup("gb3ki")]);
  assert.equal(a[0].qra, "GB3KI");
  assert.equal(b[0].qra, "GB3KI");
  assert.deepEqual(requested, ["https://api.example.com/lookup/GB3KI"]);
});

test("a failed lookup is retried on the next hover rather than cached", async () => {
  // A transient network failure must not cost the callsign its map for the
  // rest of the session, the way a 404 legitimately does.
  const bodies = { GB3KI: new Error("network down") };
  const { fetchImpl, requested } = fakeFetch(bodies);
  const { lookup } = createCallsignLookup("https://api.example.com/lookup", { fetchImpl });
  await assert.rejects(lookup("GB3KI"));
  bodies.GB3KI = response([entry()]);
  assert.equal((await lookup("GB3KI"))[0].qra, "GB3KI");
  assert.equal(requested.length, 2);
});

test("a name that is not a callsign resolves empty without a request", async () => {
  const { fetchImpl, requested } = fakeFetch({});
  const { lookup } = createCallsignLookup("https://api.example.com/lookup", { fetchImpl });
  assert.deepEqual(await lookup("PMR 1"), []);
  assert.deepEqual(requested, []);
});
