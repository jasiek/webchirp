import assert from "node:assert/strict";
import test from "node:test";

import {
  CsvLinkError,
  fetchCsvLink,
  readCsvLink,
  sha256Hex,
} from "../../web/js/csv-link.ts";
import { keepUrlOutOfReports, scrubText } from "../../web/js/sentry.ts";

// The ?csv_url= link reader and downloader. A host that answers with CORS
// headers is not thereby trustworthy, so these pin the limits the download is
// held to: https only, no credentials or referrer, no redirects, a size cap,
// and the optional sha256 pin.
const GIST = "https://gist.githubusercontent.com/someone/abc/raw/def/club.csv";
const CSV = "Location,Name,Frequency\n0,CLUB,145.500000\n";

// A fetch that records its calls and answers with the given body and headers.
function fakeFetch({ body = CSV, status = 200, headers = {}, stream = true } = {}) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const response = new Response(bytes, { status, headers });
    if (!stream) {
      Object.defineProperty(response, "body", { value: null });
    }
    return response;
  }
  return { fetchImpl, calls };
}

test("a page without csv_url names no list", () => {
  assert.equal(readCsvLink("?radio=uv5r%3ABaofengUV5RGeneric", ""), null);
  assert.equal(readCsvLink("", ""), null);
});

test("a csv_url link is read with its optional sha256 pin", () => {
  const hash = "A".repeat(64);
  const link = readCsvLink(`?radio=x&csv_url=${encodeURIComponent(GIST)}`, `#sha256=${hash}`);
  assert.equal(link.url.href, GIST);
  assert.equal(link.sha256, "a".repeat(64));
  assert.equal(readCsvLink(`?csv_url=${encodeURIComponent(GIST)}`, "").sha256, null);
});

test("only https links are accepted", () => {
  for (const raw of ["http://example.com/a.csv", "data:text/csv,a", "file:///etc/passwd", "javascript:alert(1)"]) {
    assert.throws(() => readCsvLink(`?csv_url=${encodeURIComponent(raw)}`, ""), CsvLinkError, raw);
  }
  assert.throws(() => readCsvLink("?csv_url=not%20a%20url", ""), CsvLinkError);
});

test("a malformed sha256 pin is refused rather than ignored", () => {
  // Ignoring it would load unpinned content from a link its author meant to pin.
  assert.throws(
    () => readCsvLink(`?csv_url=${encodeURIComponent(GIST)}`, "#sha256=abc"),
    CsvLinkError,
  );
});

test("a look-alike Unicode host is shown in its punycode form", () => {
  // The confirmation names link.url.host, so this is what the user sees.
  const link = readCsvLink(`?csv_url=${encodeURIComponent("https://gіst.example/a.csv")}`, "");
  assert.match(link.url.host, /^xn--/);
});

test("the download sends no credentials or referrer and refuses redirects", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const text = await fetchCsvLink(readCsvLink(`?csv_url=${encodeURIComponent(GIST)}`, ""), fetchImpl);
  assert.equal(text, CSV);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GIST);
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.referrerPolicy, "no-referrer");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.mode, "cors");
  assert.ok(calls[0].init.signal, "the download can time out");
});

test("a failed request becomes a CsvLinkError naming the host", async () => {
  const link = readCsvLink(`?csv_url=${encodeURIComponent(GIST)}`, "");
  const refused = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(fetchCsvLink(link, refused), (error) => {
    assert.ok(error instanceof CsvLinkError);
    assert.match(error.message, /gist\.githubusercontent\.com/);
    assert.match(error.message, /CORS/);
    return true;
  });
  await assert.rejects(fetchCsvLink(link, fakeFetch({ status: 404 }).fetchImpl), /HTTP 404/);
});

test("an oversized list is refused by its declared length", async () => {
  const link = readCsvLink(`?csv_url=${encodeURIComponent(GIST)}`, "");
  const { fetchImpl } = fakeFetch({ headers: { "content-length": "5000000" } });
  await assert.rejects(fetchCsvLink(link, fetchImpl), CsvLinkError);
});

test("an oversized list is refused while streaming when no length is declared", async () => {
  const link = readCsvLink(`?csv_url=${encodeURIComponent(GIST)}`, "");
  const big = "x".repeat(2048);
  await assert.rejects(fetchCsvLink(link, fakeFetch({ body: big }).fetchImpl, { maxBytes: 1024 }), CsvLinkError);
  // And when there is no stream to read, by the whole body's size.
  await assert.rejects(
    fetchCsvLink(link, fakeFetch({ body: big, stream: false }).fetchImpl, { maxBytes: 1024 }),
    CsvLinkError,
  );
  assert.equal(await fetchCsvLink(link, fakeFetch({ body: CSV, stream: false }).fetchImpl), CSV);
});

test("a pinned list loads only when its content matches the pin", async () => {
  const good = await sha256Hex(new TextEncoder().encode(CSV));
  const pinned = readCsvLink(`?csv_url=${encodeURIComponent(GIST)}`, `#sha256=${good}`);
  assert.equal(await fetchCsvLink(pinned, fakeFetch().fetchImpl), CSV);

  const changed = fakeFetch({ body: `${CSV}1,EVIL,121.500000\n` }).fetchImpl;
  await assert.rejects(fetchCsvLink(pinned, changed), /does not match the sha256/);
});

test("a UTF-8 byte order mark is not part of the text", async () => {
  const link = readCsvLink(`?csv_url=${encodeURIComponent(GIST)}`, "");
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(CSV)]);
  assert.equal(await fetchCsvLink(link, fakeFetch({ body: withBom }).fetchImpl), CSV);
});

test("a registered URL is cleared from everything sent to Sentry", () => {
  // The path names whoever published the list; the query rule alone would
  // leave all of it but the query in place.
  const url = "https://example.org/clubs/w1aw/members.csv";
  keepUrlOutOfReports(`${url}#frag`);
  const scrubbed = scrubText(`GET ${url} failed; also ${url}#frag`);
  assert.doesNotMatch(scrubbed, /w1aw|example\.org/);
  assert.match(scrubbed, /\[private-url\]/);
});
