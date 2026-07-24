import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REPEATER_API_BASE,
  buildRepeaterEndpoints,
} from "../web/js/datasources.js";

test("buildRepeaterEndpoints derives both source URLs from a base", () => {
  const endpoints = buildRepeaterEndpoints("https://proxy.example.com");
  assert.deepEqual(endpoints, {
    przemienniki: {
      apiUrl: "https://proxy.example.com/przemienniki",
      metaUrl: "https://proxy.example.com/przemienniki/meta",
    },
    repeaterbook: {
      apiUrl: "https://proxy.example.com/repeaterbook",
      metaUrl: "https://proxy.example.com/repeaterbook/meta",
    },
  });
});

test("buildRepeaterEndpoints trims whitespace and trailing slashes", () => {
  const endpoints = buildRepeaterEndpoints("  https://proxy.example.com/  ");
  assert.equal(endpoints.przemienniki.apiUrl, "https://proxy.example.com/przemienniki");
  assert.equal(endpoints.repeaterbook.metaUrl, "https://proxy.example.com/repeaterbook/meta");
});

test("buildRepeaterEndpoints returns null for a blank or null base", () => {
  assert.equal(buildRepeaterEndpoints(""), null);
  assert.equal(buildRepeaterEndpoints("   "), null);
  assert.equal(buildRepeaterEndpoints(null), null);
});

test("buildRepeaterEndpoints falls back to the default base when called with no argument", () => {
  assert.deepEqual(buildRepeaterEndpoints(undefined), buildRepeaterEndpoints(DEFAULT_REPEATER_API_BASE));
});

test("the default base points at the codeplug.org proxy", () => {
  assert.equal(DEFAULT_REPEATER_API_BASE, "https://api.codeplug.org");
  const endpoints = buildRepeaterEndpoints();
  assert.equal(endpoints.przemienniki.metaUrl, "https://api.codeplug.org/przemienniki/meta");
});
