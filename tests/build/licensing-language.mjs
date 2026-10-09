import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { transformSync } from "esbuild";

import { repoRoot } from "../support/repo-paths.mjs";

test("flag selection switches both views and the document language", async () => {
  const buttons = ["native", "en"].map((language) => ({
    dataset: { licensingLanguage: language },
    attributes: { "aria-pressed": String(language === "native") },
    // Retain the registered click listener so the test can activate each flag.
    addEventListener(_event, listener) { this.click = listener; },
    // Capture the button's accessibility state after a click.
    setAttribute(name, value) { this.attributes[name] = value; },
  }));
  const panels = [
    { dataset: { licensingPanel: "native", pageTitle: "Native | WebCHIRP" },
      lang: "fa", dir: "rtl", hidden: false },
    { dataset: { licensingPanel: "en", pageTitle: "English | WebCHIRP" },
      lang: "en", dir: "ltr", hidden: true },
  ];
  const document = {
    title: "Native | WebCHIRP",
    documentElement: { lang: "fa", dir: "rtl" },
    // Return the controls or panels requested by the production script.
    querySelectorAll(selector) {
      return selector === "[data-licensing-language]" ? buttons : panels;
    },
  };
  // The source is TypeScript; strip it the way the dev server does before
  // running it as the classic script a vm context expects.
  const source = await readFile(path.join(repoRoot, "web", "js", "licensing-language.ts"), "utf8");
  const script = transformSync(source, { loader: "ts" }).code;
  runInNewContext(script, { document });

  buttons[1].click();
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, false]);
  assert.deepEqual(buttons.map((button) => button.attributes["aria-pressed"]), ["false", "true"]);
  assert.deepEqual(document.documentElement, { lang: "en", dir: "ltr" });
  assert.equal(document.title, "English | WebCHIRP");

  buttons[0].click();
  assert.deepEqual(panels.map((panel) => panel.hidden), [false, true]);
  assert.deepEqual(document.documentElement, { lang: "fa", dir: "rtl" });
  assert.equal(document.title, "Native | WebCHIRP");
});
