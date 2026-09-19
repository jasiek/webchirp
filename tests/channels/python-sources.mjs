import assert from "node:assert/strict";
import test from "node:test";

import {
  PYTHON_SOURCE_MAX_ATTEMPTS,
  RUNTIME_PYTHON_FILES,
  createBrowserCdnPythonSource,
  fetchWithRetry,
} from "../../web/js/python-sources.mjs";

// The retry policy around the runtime's source fetches. A boot is a burst of
// parallel GETs and one rejected request aborts the whole Promise.all, so these
// pin down which failures get a second attempt, which do not, and that the
// deadline closes the connection rather than leaving an attempt pending. The
// provider's board is fully injectable (fetchImpl/sleepImpl/randomImpl/onRetry)
// so none of this touches the network or a real clock.

const PYTHON_RUNTIME_URLS = Object.fromEntries(
  RUNTIME_PYTHON_FILES.map((name) => [name, `/assets/python/${name}`]),
);

function textResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function jsonResponse(value, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(value),
    json: async () => value,
  };
}

function sourceWith(overrides = {}) {
  return createBrowserCdnPythonSource({
    runtimeFileUrls: PYTHON_RUNTIME_URLS,
    sleepImpl: async () => {},
    ...overrides,
  });
}

test("a transient transport failure is retried until it succeeds", async () => {
  let calls = 0;
  const retries = [];
  const source = sourceWith({
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        throw new TypeError("Failed to fetch");
      }
      return textResponse("chirp source");
    },
    onRetry: (message) => retries.push(message),
  });

  const text = await source.fetchRuntimeFile("runtime_bridge.py");

  assert.equal(text, "chirp source");
  assert.equal(calls, 3);
  assert.equal(retries.length, 2);
  assert.match(retries[0], /^RETRY /);
  assert.match(retries[0], /attempt 1\/3/);
  assert.match(retries[1], /attempt 2\/3/);
});

test("a retryable HTTP status is retried", async () => {
  let calls = 0;
  const source = sourceWith({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return textResponse("busy", { ok: false, status: 503 });
      }
      if (calls === 2) {
        return textResponse("slow down", { ok: false, status: 429 });
      }
      return textResponse("ok");
    },
  });

  assert.equal(await source.fetchRuntimeFile("runtime_bridge.py"), "ok");
  assert.equal(calls, 3);
});

test("a permanent 4xx is not retried and keeps its message", async () => {
  let calls = 0;
  const source = sourceWith({
    fetchImpl: async () => {
      calls += 1;
      return textResponse("missing", { ok: false, status: 404 });
    },
  });

  await assert.rejects(
    source.fetchRuntimeFile("runtime_bridge.py"),
    /Failed to fetch \/assets\/python\/runtime_bridge\.py: 404/,
  );
  assert.equal(calls, 1);
});

test("retries stop at the attempt cap and surface the last failure", async () => {
  let calls = 0;
  const source = sourceWith({
    maxAttempts: 4,
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError("offline");
    },
  });

  await assert.rejects(source.fetchRuntimeFile("runtime_bridge.py"), /offline/);
  assert.equal(calls, 4);
  assert.equal(PYTHON_SOURCE_MAX_ATTEMPTS, 3);
});

test("fetchChirpSource retries and reports the pinned CDN URL on failure", async () => {
  let calls = 0;
  const source = sourceWith({
    fetchImpl: async (url) => {
      calls += 1;
      return { ok: false, status: 500, url, text: async () => "", json: async () => ({}) };
    },
    maxAttempts: 2,
  });

  await assert.rejects(
    source.fetchChirpSource("/chirp/memmap.py"),
    /Failed to fetch https:\/\/cdn\.jsdelivr\.net\/gh\/kk7ds\/chirp@\w+\/chirp\/memmap\.py: 500/,
  );
  assert.equal(calls, 2);
});

test("listDriverModules retries the index fetch and still parses names", async () => {
  let calls = 0;
  const source = sourceWith({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return textResponse("boom", { ok: false, status: 500 });
      }
      return jsonResponse({
        files: [
          { name: "/chirp/drivers/uv5r.py" },
          { name: "/chirp/drivers/__init__.py" },
          { name: "/chirp/other.py" },
        ],
      });
    },
  });

  assert.deepEqual(await source.listDriverModules(), ["uv5r"]);
  assert.equal(calls, 2);
});

test("an attempt that never settles is aborted at the deadline", async () => {
  // fetch() resolves on headers, so the plugin only rejects because it honours
  // the signal the provider hands it -- which is the behaviour under test.
  let calls = 0;
  const source = sourceWith({
    timeoutMs: 20,
    maxAttempts: 2,
    fetchImpl: (url, { signal } = {}) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  });

  await assert.rejects(
    source.fetchRuntimeFile("runtime_bridge.py"),
    /timed out after 20 ms/,
  );
  assert.equal(calls, 2);
});

test("a deadline abandons the connection instead of leaving a fetch in flight", async () => {
  let aborted = false;
  const source = sourceWith({
    timeoutMs: 20,
    maxAttempts: 1,
    fetchImpl: (url, { signal } = {}) => new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    }),
  });

  await assert.rejects(source.fetchRuntimeFile("runtime_bridge.py"), /timed out/);
  assert.equal(aborted, true);
});

test("backoff grows exponentially and carries jitter", async () => {
  const waits = [];
  await assert.rejects(
    fetchWithRetry("https://example.test/x", async () => {
      throw new TypeError("offline");
    }, {
      maxAttempts: 3,
      baseBackoffMs: 200,
      sleepImpl: async (ms) => waits.push(ms),
      randomImpl: () => 1,
    }),
    /offline/,
  );

  // 200 * 1.5 (full jitter), then 400 * 1.5.
  assert.deepEqual(waits, [300, 600]);
});

test("a successful attempt never sleeps", async () => {
  const waits = [];
  const value = await fetchWithRetry("https://example.test/x", async () => "ok", {
    sleepImpl: async (ms) => waits.push(ms),
  });

  assert.equal(value, "ok");
  assert.deepEqual(waits, []);
});