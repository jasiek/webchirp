// A channel list named by a link: codeplug.org/?csv_url=<https URL>, with an
// optional #sha256=<hex> pinning the file's content. This module reads the
// link and downloads the file under the limits below; it has no DOM, so the
// confirmation the user gives before anything reaches the grid lives in
// web/js/ui/codeplug-io.ts.
//
// A host answering with Access-Control-Allow-Origin is not a vouching for its
// content -- anyone can serve a CSV from a gist or a bucket that sends it -- so
// everything here treats the file as untrusted input: https only, no cookies,
// no referrer, no redirects to a host the user was not shown, a size cap, and
// an optional hash a club can put in the link so the list cannot change under
// it after it is shared.

// The query parameter carrying the list's URL.
export const CSV_LINK_PARAM = "csv_url";

// The largest file accepted. A full 1000-channel CHIRP CSV is about 150 KB, so
// this leaves room for any real radio while keeping a hostile file from
// freezing the tab in the parser or the grid.
export const CSV_LINK_MAX_BYTES = 1_000_000;

// The most channels a linked list may hold once parsed; the byte cap alone
// would still admit tens of thousands of minimal rows.
export const CSV_LINK_MAX_ROWS = 10_000;

// How long the download may take before it is abandoned.
export const CSV_LINK_TIMEOUT_MS = 30_000;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

// A link the app refuses, or a download that did not produce a file. The
// message is written for the user: none of these is a defect in the app, so
// they are shown and logged but never reported to Sentry.
export class CsvLinkError extends Error {
  override name = "CsvLinkError";
}

export type CsvLink = {
  url: URL;
  // Lower-case hex, or null when the link does not pin the content.
  sha256: string | null;
};

// Read the channel-list link out of a page's query and fragment. Null when the
// page names no list; a CsvLinkError when it names one the app will not fetch.
// The fragment is used for the hash because a browser never sends it to any
// server, so pinning the content does not change what the host sees.
export function readCsvLink(search: string, hash: string): CsvLink | null {
  const raw = new URLSearchParams(search).get(CSV_LINK_PARAM);
  if (raw === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CsvLinkError("The channel list link is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new CsvLinkError("Channel lists can only be loaded from https:// addresses.");
  }
  const pinned = new URLSearchParams(String(hash || "").replace(/^#/, "")).get("sha256");
  if (pinned !== null && !SHA256_HEX.test(pinned)) {
    throw new CsvLinkError("The link's sha256 value is not a 64-character hex SHA-256 hash.");
  }
  return { url, sha256: pinned === null ? null : pinned.toLowerCase() };
}

// Download a linked channel list and return its text. Credentials and the
// referrer are withheld because the host has no business knowing who opened
// the link or from where, and a redirect is refused because the user is asked
// to trust the host the link names, not wherever that host forwards to.
export async function fetchCsvLink(
  link: CsvLink,
  fetchImpl: typeof fetch,
  { maxBytes = CSV_LINK_MAX_BYTES, timeoutMs = CSV_LINK_TIMEOUT_MS } = {},
): Promise<string> {
  const host = link.url.host;
  let response: Response;
  try {
    response = await fetchImpl(link.url.href, {
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // fetch reports a CORS refusal, a redirect, a DNS failure and a timeout
    // all as the same TypeError, by design, so the message names every cause.
    throw new CsvLinkError(
      `Could not download the channel list from ${host}. The address may be wrong, `
      + "the host may redirect or not allow other sites to read it (CORS), "
      + "or the connection failed.",
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new CsvLinkError(`${host} answered the channel list request with HTTP ${response.status}.`);
  }
  const bytes = await readCapped(response, maxBytes, host);
  if (link.sha256 !== null) {
    const actual = await sha256Hex(bytes);
    if (actual !== link.sha256) {
      throw new CsvLinkError(
        `The channel list from ${host} does not match the sha256 in the link, `
        + "so it has changed since the link was made. It was not loaded.",
      );
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

// Read a response body, giving up as soon as it passes maxBytes. The declared
// length is checked first so an honest oversized response is refused without
// being read, and the stream is counted as well because the header can be
// absent or wrong.
async function readCapped(response: Response, maxBytes: number, host: string): Promise<Uint8Array> {
  const tooLarge = () => new CsvLinkError(
    `The channel list from ${host} is larger than ${Math.round(maxBytes / 1000)} KB, `
    + "which is more than any radio holds. It was not loaded.",
  );
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge();
  }
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > maxBytes) {
      throw tooLarge();
    }
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Lower-case hex SHA-256 of some bytes, for comparing against a pinned link.
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
