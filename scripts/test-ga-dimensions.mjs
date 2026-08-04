import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { CUSTOM_DIMENSIONS } from "../web/js/analytics.js";
import { parseArgs, planSync, validateDeclarations } from "./ga-dimensions.mjs";

// The sync script talks to a live GA property, so the parts worth testing are
// the plan it builds and the manifest it builds it from. The coverage test at
// the bottom is the one that earns its keep: a parameter added to a trackEvent
// call but not declared here is invisible in GA and nothing else would say so.
const JS_DIR = path.join(process.cwd(), "web", "js");

function existing(parameterName, scope, displayName, description = "") {
  return {
    name: `properties/1/customDimensions/${parameterName}`,
    parameterName,
    scope,
    displayName,
    description,
  };
}

test("the shipped declarations are valid", () => {
  assert.deepEqual(validateDeclarations(CUSTOM_DIMENSIONS), []);
});

test("invalid declarations are rejected with a reason each", () => {
  const errors = validateDeclarations([
    { parameterName: "9lives", displayName: "Nine", scope: "EVENT" },
    { parameterName: "ga_session", displayName: "Session", scope: "EVENT" },
    { parameterName: "no_scope", displayName: "No scope", scope: "GALAXY" },
    { parameterName: "no_name", displayName: "", scope: "EVENT" },
    { parameterName: "wordy", displayName: "Wordy", description: "x".repeat(151), scope: "EVENT" },
    { parameterName: "twice", displayName: "Twice", scope: "EVENT" },
    { parameterName: "twice", displayName: "Twice again", scope: "EVENT" },
  ]);
  assert.match(errors.join("\n"), /9lives: parameter name must start with a letter/);
  assert.match(errors.join("\n"), /ga_session: "ga_" is a reserved parameter prefix/);
  assert.match(errors.join("\n"), /no_scope: scope must be one of/);
  assert.match(errors.join("\n"), /no_name: display name is required/);
  assert.match(errors.join("\n"), /wordy: description exceeds 150 characters/);
  assert.match(errors.join("\n"), /twice: declared twice at EVENT scope/);
});

test("a user-scoped parameter name is held to the shorter limit", () => {
  const long = `u${"x".repeat(30)}`;
  assert.deepEqual(validateDeclarations([{ parameterName: long, displayName: "Long", scope: "EVENT" }]), []);
  assert.match(
    validateDeclarations([{ parameterName: long, displayName: "Long", scope: "USER" }]).join("\n"),
    /exceeds 24 characters for USER scope/,
  );
});

test("declaring past a property's limit is caught before any API call", () => {
  const many = Array.from({ length: 51 }, (_, index) => ({
    parameterName: `p_${index}`,
    displayName: `P ${index}`,
    scope: "EVENT",
  }));
  assert.match(validateDeclarations(many).join("\n"), /51 EVENT-scoped dimensions declared, but a property allows 50/);
});

test("missing dimensions are planned for creation", () => {
  const plan = planSync(CUSTOM_DIMENSIONS, []);
  assert.equal(plan.create.length, CUSTOM_DIMENSIONS.length);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.extra, []);
});

test("matching dimensions are left alone", () => {
  const property = CUSTOM_DIMENSIONS.map((dimension) =>
    existing(dimension.parameterName, dimension.scope, dimension.displayName, dimension.description),
  );
  const plan = planSync(CUSTOM_DIMENSIONS, property);
  assert.equal(plan.unchanged.length, CUSTOM_DIMENSIONS.length);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.update, []);
});

test("only the drifted fields are patched", () => {
  const declared = [{ parameterName: "radio_make", displayName: "Radio make", description: "Vendor.", scope: "EVENT" }];
  const plan = planSync(declared, [existing("radio_make", "EVENT", "radio make", "Vendor.")]);
  assert.equal(plan.update.length, 1);
  assert.deepEqual(plan.update[0].changes, { displayName: "Radio make" });
  assert.equal(plan.update[0].name, "properties/1/customDimensions/radio_make");

  // A description added in code where GA has none still counts as drift.
  const added = planSync(declared, [existing("radio_make", "EVENT", "Radio make")]);
  assert.deepEqual(added.update[0].changes, { description: "Vendor." });

  // GA returns no description field at all when it is empty.
  const bare = { name: "properties/1/customDimensions/x", parameterName: "x", scope: "EVENT", displayName: "X" };
  assert.equal(planSync([{ parameterName: "x", displayName: "X", scope: "EVENT" }], [bare]).unchanged.length, 1);
});

test("undeclared dimensions are reported, never archived by the plan", () => {
  const plan = planSync([], [existing("legacy_param", "EVENT", "Legacy")]);
  assert.equal(plan.extra.length, 1);
  assert.equal(plan.extra[0].parameterName, "legacy_param");
  assert.deepEqual(plan.create, []);
});

test("a scope change is a conflict, because scope is immutable", () => {
  const declared = [{ parameterName: "display_mode", displayName: "Display mode", scope: "EVENT" }];
  const plan = planSync(declared, [existing("display_mode", "USER", "Display mode")]);
  assert.deepEqual(plan.create, []);
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /scope is immutable/);
});

test("arguments parse, including the property id in its various shapes", () => {
  assert.deepEqual(parseArgs(["--property", "properties/12345"]).property, "12345");
  assert.deepEqual(parseArgs(["--property=12345"]).property, "12345");
  const options = parseArgs(["--apply", "--archive-extra", "--json"]);
  assert.equal(options.apply, true);
  assert.equal(options.archiveExtra, true);
  assert.equal(options.json, true);
  assert.equal(parseArgs([]).apply, false, "changes must never be the default");
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument: --nope/);
});

// Pull the top-level keys out of every `trackEvent(name, { ... })` call so the
// coverage check below reads the calls themselves rather than a hand-kept list.
function trackedParams(source) {
  const names = new Set();
  for (let start = source.indexOf("trackEvent("); start !== -1; start = source.indexOf("trackEvent(", start + 1)) {
    let depth = 0;
    let objectStart = -1;
    for (let index = start + "trackEvent".length; index < source.length; index += 1) {
      const char = source[index];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      } else if (char === "{" && depth === 1) {
        objectStart = index;
        break;
      }
    }
    if (objectStart === -1) {
      continue;
    }
    let braces = 0;
    for (let index = objectStart; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") {
        braces += 1;
      } else if (char === "}") {
        braces -= 1;
        if (braces === 0) {
          break;
        }
      } else if (braces === 1 && /[A-Za-z_]/.test(char) && /[{,\s]/.test(source[index - 1])) {
        const key = source.slice(index).match(/^[A-Za-z_]\w*(?=\s*:)/);
        if (key) {
          names.add(key[0]);
        }
      }
    }
  }
  return names;
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.m?js$/.test(entry.name) ? [full] : [];
  });
}

test("the scanner finds the parameters a call actually sends", () => {
  assert.deepEqual([...trackedParams('trackEvent("e", { a: 1, b: "x" });')], ["a", "b"]);
  assert.deepEqual([...trackedParams('trackEvent("e", {}, win);')], []);
  assert.deepEqual([...trackedParams('trackEvent(name);\nconst other = { c: 1 };')], []);
  assert.deepEqual([...trackedParams('trackEvent("e", { a: { nested: 1 }, b: 2 });')], ["a", "b"]);
});

test("every parameter the app sends is declared as a custom dimension", () => {
  const declared = new Set(CUSTOM_DIMENSIONS.map((dimension) => dimension.parameterName));
  const sent = new Set();
  for (const file of sourceFiles(JS_DIR)) {
    for (const name of trackedParams(fs.readFileSync(file, "utf8"))) {
      sent.add(name);
    }
  }

  assert.ok(sent.size > 0, "found no trackEvent parameters — the scanner is broken, not the app");
  const undeclared = [...sent].filter((name) => !declared.has(name));
  assert.deepEqual(
    undeclared,
    [],
    `these parameters are sent but not declared in CUSTOM_DIMENSIONS, so GA will drop them: ${undeclared.join(", ")}`,
  );
});
