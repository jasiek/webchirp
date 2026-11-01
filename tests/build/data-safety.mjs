// Guards fastlane/data-safety.csv, the Play Console Data safety form that
// fastlane data_safety uploads (android/README.md). The upload replaces the
// whole form at once and Play only checks it after the fact, so an
// inconsistent file -- a data type declared without saying why it is
// collected, or answers left behind for a type no longer declared -- is caught
// here instead. Whether the answers match web/privacy.html is for review: a
// change to one changes the other in the same PR.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot, webDir } from "../support/repo-paths.mjs";

const FORM = path.join(repoRoot, "fastlane", "data-safety.csv");

// The export's rows as arrays of fields: RFC 4180 quoting, CRLF line ends.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function readForm() {
  const [header, ...rows] = parseCsv(await readFile(FORM, "utf8"));
  assert.equal(header[0], "Question ID (machine readable)", "not a Play Console Data safety export");
  return rows.map(([question, response, value, requirement]) => ({ question, response, value, requirement }));
}

// The data types the form declares, by response ID (PSL_CRASH_LOGS...).
function declaredTypes(rows) {
  return rows
    .filter((row) => row.question.startsWith("PSL_DATA_TYPES_") && row.value === "TRUE")
    .map((row) => row.response);
}

// The answered rows of one data type's usage block for question, which ends
// the question ID (PSL_DATA_USAGE_RESPONSES:<type>:<question>).
function usageAnswers(rows, type, question) {
  return rows.filter(
    (row) => row.question === `PSL_DATA_USAGE_RESPONSES:${type}:${question}` && row.value
  );
}

test("every required question is answered", async () => {
  const rows = await readForm();
  const unanswered = rows.filter((row) => row.requirement === "REQUIRED" && !row.value);
  assert.deepEqual(unanswered.map((row) => row.question), []);
});

test("every answer is TRUE, FALSE or a URL", async () => {
  const rows = await readForm();
  const odd = rows.filter((row) => row.value && !/^(TRUE|FALSE|https:\/\/\S+)$/.test(row.value));
  assert.deepEqual(odd.map((row) => `${row.question} ${row.value}`), []);
});

test("a single-choice question has at most one answer", async () => {
  const rows = await readForm();
  const chosen = new Map();
  for (const row of rows) {
    if (row.requirement === "SINGLE_CHOICE" && row.value === "TRUE") {
      chosen.set(row.question, (chosen.get(row.question) || 0) + 1);
    }
  }
  const several = [...chosen].filter(([, count]) => count > 1).map(([question]) => question);
  assert.deepEqual(several, []);
});

test("every declared data type says how it is handled and why", async () => {
  const rows = await readForm();
  const types = declaredTypes(rows);
  assert.ok(types.length > 0, "the form declares no data types but says the app collects data");
  for (const type of types) {
    assert.ok(
      usageAnswers(rows, type, "PSL_DATA_USAGE_COLLECTION_AND_SHARING").length > 0,
      `${type}: collected, shared or both?`
    );
    assert.equal(usageAnswers(rows, type, "PSL_DATA_USAGE_EPHEMERAL").length, 1, `${type}: ephemeral?`);
    assert.equal(
      usageAnswers(rows, type, "DATA_USAGE_USER_CONTROL").filter((row) => row.value === "TRUE").length,
      1,
      `${type}: required or optional?`
    );
    const collected = usageAnswers(rows, type, "PSL_DATA_USAGE_COLLECTION_AND_SHARING")
      .some((row) => row.response !== "PSL_DATA_USAGE_ONLY_SHARED");
    if (collected) {
      assert.ok(
        usageAnswers(rows, type, "DATA_USAGE_COLLECTION_PURPOSE").length > 0,
        `${type}: why is it collected?`
      );
    }
  }
});

test("no answers are left behind for an undeclared data type", async () => {
  const rows = await readForm();
  const types = new Set(declaredTypes(rows));
  const stray = rows.filter((row) => {
    const match = row.question.match(/^PSL_DATA_USAGE_RESPONSES:([A-Z_]+):/);
    return match && row.value && !types.has(match[1]);
  });
  assert.deepEqual(stray.map((row) => row.question), []);
});

test("the data deletion link points at a section of the privacy policy", async () => {
  const rows = await readForm();
  const link = rows.find((row) => row.question === "PSL_DATA_DELETION_URL")?.value || "";
  const match = link.match(/^https:\/\/webchirp\.org\/privacy\.html#([\w-]+)$/);
  assert.ok(match, `unexpected data deletion link: ${link}`);
  const policy = await readFile(path.join(webDir, "privacy.html"), "utf8");
  assert.ok(policy.includes(`id="${match[1]}"`), `privacy.html has no #${match[1]}`);
});
