// Guards the Digital Asset Links statement (web/.well-known/assetlinks.json)
// that lets the Android app open the site full-screen as a Trusted Web
// Activity. Android fetches it from the origin's root when the app launches
// and never says why it rejected one: a malformed statement, a fingerprint
// that is not the signing key's, or a deploy that left the file out all look
// the same on a phone, as a URL bar above the app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { repoRoot, webDir } from "../support/repo-paths.mjs";

const ASSET_LINKS_PATH = path.join(webDir, ".well-known", "assetlinks.json");
// The relation a Trusted Web Activity (and an Android App Link) is verified by.
const HANDLE_ALL_URLS = "delegate_permission/common.handle_all_urls";
// An Android application id: two or more dot-separated identifiers, each
// starting with a letter.
const PACKAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
// The Play Store app's application id. Play never lets a published app change
// it, so the statement must keep naming exactly this one; pinned here so that
// editing it is a deliberate change in two places, not a slip in one.
const ANDROID_APP_ID = "com.hf2j.webchirp";
// A SHA-256 certificate digest as keytool and Play Console print it: 32
// upper-case hex bytes joined by colons.
const FINGERPRINT_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

// The parsed statement list.
function statements() {
  return JSON.parse(readFileSync(ASSET_LINKS_PATH, "utf8"));
}

test("assetlinks.json delegates URL handling to an Android app", () => {
  const list = statements();
  assert.ok(Array.isArray(list), "assetlinks.json must be a JSON array of statements");
  assert.ok(list.length > 0, "assetlinks.json names no app");
  for (const statement of list) {
    assert.ok(Array.isArray(statement.relation), "a statement's relation must be an array");
    assert.ok(statement.relation.includes(HANDLE_ALL_URLS), `a statement lacks ${HANDLE_ALL_URLS}`);
    assert.equal(statement.target?.namespace, "android_app");
    assert.match(statement.target.package_name, PACKAGE_NAME_RE);
    assert.ok(
      Array.isArray(statement.target.sha256_cert_fingerprints),
      `${statement.target.package_name}: sha256_cert_fingerprints must be an array`,
    );
  }
  assert.ok(
    list.some((statement) => statement.target.package_name === ANDROID_APP_ID),
    `assetlinks.json does not name the Play Store app ${ANDROID_APP_ID}`,
  );
});

// An empty list is allowed: it verifies no build of the app, which is the
// state before Play Console has generated the app signing key. Once it has,
// that key's fingerprint is the one that matters -- Play re-signs every
// install with it, so a list holding only the upload key verifies nothing a
// user downloads.
test("every certificate fingerprint is a SHA-256 digest", () => {
  for (const statement of statements()) {
    const { package_name: packageName, sha256_cert_fingerprints: fingerprints } = statement.target;
    for (const fingerprint of fingerprints) {
      assert.match(
        fingerprint,
        FINGERPRINT_RE,
        `${packageName}: not a colon-separated upper-case SHA-256 digest: ${fingerprint}`,
      );
    }
    assert.equal(new Set(fingerprints).size, fingerprints.length, `${packageName}: duplicate fingerprint`);
  }
});

// upload-artifact leaves out dot-prefixed files and directories unless
// include-hidden-files is true. Without it the deploy has no .well-known/
// while every build check still passes, because dist/ has it.
test("the deployed artifact keeps dot-directories, so .well-known/ is deployed", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "pages.yml"), "utf8");
  const uploads = workflow.split("uses: actions/upload-artifact@").slice(1);
  assert.equal(uploads.length, 1, "pages.yml should upload exactly one artifact");
  // The step's with: block ends at the next step or job.
  const step = uploads[0].split(/\n\s*- |\n\n/)[0];
  assert.match(step, /include-hidden-files: true/, "upload-artifact drops .well-known/ unless include-hidden-files is true");
});
