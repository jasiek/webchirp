// npm run dev with TURNSTILE_BYPASS_TOKEN set writes the token into the page's
// bypass-token meta tag (scripts/dev-turnstile-bypass.ts), so RepeaterBook
// queries against the production API get past its Turnstile check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  fillTurnstileBypassToken,
  readTurnstileBypassToken,
  TURNSTILE_BYPASS_TOKEN_META,
} from "../../scripts/dev-turnstile-bypass.ts";
import { repoRoot } from "../support/repo-paths.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("an unset or blank TURNSTILE_BYPASS_TOKEN reads as no token", () => {
  assert.equal(readTurnstileBypassToken({}), "");
  assert.equal(readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: "  " }), "");
});

test("a 32-character Bearer token is read as it is", () => {
  assert.equal(readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: TOKEN }), TOKEN);
  assert.equal(readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: ` ${TOKEN}\n` }), TOKEN);
});

test("a token the API would refuse fails the dev server at startup", () => {
  // The API requires exactly 32 characters.
  assert.throws(() => readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: "short" }), /must be 32 characters, got 5/);
  assert.throws(() => readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: `${TOKEN}0` }), /got 33/);
  // Right length, but not something a Bearer credential, or an HTML
  // attribute, can carry.
  assert.throws(() => readTurnstileBypassToken({ TURNSTILE_BYPASS_TOKEN: `"><script>${"x".repeat(22)}` }), /not a Bearer token/);
});

test("index.html's blank tag is filled, and nothing else on the page changes", () => {
  const page = readFileSync(path.join(repoRoot, "web", "index.html"), "utf8");
  const blank = `<meta name="${TURNSTILE_BYPASS_TOKEN_META}" content="" />`;
  assert.ok(page.includes(blank), "index.html ships the bypass-token tag blank");
  const filled = fillTurnstileBypassToken(page, TOKEN);
  assert.equal(filled, page.replace(blank, `<meta name="${TURNSTILE_BYPASS_TOKEN_META}" content="${TOKEN}" />`));
});

test("a page without the tag is served unchanged", () => {
  const page = '<!doctype html>\n<meta name="description" content="" />\n';
  assert.equal(fillTurnstileBypassToken(page, TOKEN), page);
});
