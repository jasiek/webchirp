import { createHash } from "node:crypto";
import { access, cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, "dist");
const WEB_DIR = path.join(ROOT, "web");
const HASHED_EXTS = new Set([".js", ".css", ".py"]);
const REWRITE_EXTS = new Set([".html", ".js", ".css"]);
// Assets whose absence is invisible at runtime until a user notices something
// missing: the manifest and its icons only matter when someone tries to install
// the app to a home screen, which no test page load exercises.
const REQUIRED_WEB_FILES = [
  "js/datasources.js",
  "manifest.webmanifest",
  "images/icon-192.png",
  "images/icon-512.png",
  "images/icon-maskable-512.png",
  "images/apple-touch-icon.png",
];

function toPosix(relPath) {
  return relPath.split(path.sep).join("/");
}

function contentHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

// Quote a literal reference so it can be embedded in the boundary-anchored
// matcher below; asset paths contain "." and "-", which are regex syntax.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A reference has to stand alone, so neither neighbour may be a character that
// could extend a path. Plain substring matching conflates spellings that only
// look alike: "/js/rsgb.js" occurs inside a comment mentioning "web/js/rsgb.js",
// and "./analytics.js" occurs inside the import of "../analytics.js" — which
// rewrote prose and invented dependency edges between unrelated modules.
function referenceMatcher(form) {
  return new RegExp(`(?<![\\w./-])${escapeRegExp(form)}(?![\\w./-])`, "g");
}

// Every spelling a file at `fromRel` could use to point at `targetRel` (both
// dist-relative POSIX paths). Sources use three shapes: site-absolute
// ("/js/ui.js"), dist-root-relative ("./js/ui.js", what the pages at the root
// write) and relative to the referencing file ("./ui/format.js", what a module
// writes). The shapes depend only on the path, so form `i` of an asset and form
// `i` of its hashed name are the same reference before and after renaming.
function referenceForms(fromRel, targetRel) {
  const forms = [`/${targetRel}`, `./${targetRel}`];
  let relative = path.posix.relative(path.posix.dirname(fromRel), targetRel);
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  forms.push(relative);
  return forms;
}

// The single pass that both discovers which assets a file references and points
// those references at their hashed names. `nameOf` returns the hashed path for
// an asset, or a falsy value to leave the reference as it is — which is how the
// discovery pass runs, so the graph can never disagree with what the rewrite
// later does. Longest spelling first, so a shorter one can never claim part of
// a longer one.
function substituteReferences(fromRel, text, assetRels, nameOf) {
  const candidates = [];
  for (const assetRel of assetRels) {
    referenceForms(fromRel, assetRel).forEach((form, formIndex) => {
      candidates.push({ form, formIndex, assetRel });
    });
  }
  candidates.sort((a, b) => b.form.length - a.form.length);

  const referenced = new Set();
  let out = text;
  for (const { form, formIndex, assetRel } of candidates) {
    if (!referenceMatcher(form).test(out)) {
      continue;
    }
    referenced.add(assetRel);
    const hashedRel = nameOf(assetRel);
    if (!hashedRel) {
      continue;
    }
    const replacement = referenceForms(fromRel, hashedRel)[formIndex];
    out = out.replace(referenceMatcher(form), () => replacement);
  }
  return { referenced: [...referenced], text: out };
}

// Where the hashed copy of `rel` lands, keeping its directory and extension.
function hashedRelFor(rel, hash) {
  const ext = path.extname(rel);
  const dir = path.posix.dirname(rel);
  const name = `${path.posix.basename(rel, ext)}.${hash}${ext}`;
  return dir === "." ? name : `${dir}/${name}`;
}

// Tarjan's strongly-connected-components algorithm. It emits a component only
// after every component reachable from it, so walking the result in order names
// dependencies before the files that import them — which is the whole point: a
// file cannot be hashed until its dependencies' hashed names are known. Import
// cycles come back as components with more than one member (and a file naming
// itself as a component with a self edge); those cannot be named after their own
// bytes and are handled separately by the caller.
function stronglyConnectedComponents(nodes, edgesOf) {
  const index = new Map();
  const lowLink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  // One depth-first step: assign the node its index, follow its edges, and on
  // the way back out emit the component it roots, if it roots one.
  function visit(node) {
    index.set(node, counter);
    lowLink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edgesOf(node)) {
      if (!index.has(next)) {
        visit(next);
        lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(next)));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node), index.get(next)));
      }
    }
    if (lowLink.get(node) === index.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  }

  for (const node of nodes) {
    if (!index.has(node)) {
      visit(node);
    }
  }
  return components;
}

async function main() {
  await rm(DIST_DIR, { recursive: true, force: true });
  await cp(WEB_DIR, DIST_DIR, {
    recursive: true,
    filter: (src) => path.basename(src) !== "__pycache__",
  });

  for (const relPath of REQUIRED_WEB_FILES) {
    const expectedPath = path.join(DIST_DIR, relPath);
    try {
      await access(expectedPath);
    } catch {
      throw new Error(`Missing required dist asset: ${toPosix(path.relative(DIST_DIR, expectedPath))}`);
    }
  }

  const distRels = (await walkFiles(DIST_DIR))
    .map((filePath) => toPosix(path.relative(DIST_DIR, filePath)))
    .sort();
  const hashedRels = distRels.filter((rel) => HASHED_EXTS.has(path.extname(rel)));
  const hashedSet = new Set(hashedRels);

  // Read every file that can carry a reference once; both the graph and the
  // rewrite work off this same text.
  const sources = new Map();
  for (const rel of distRels) {
    if (REWRITE_EXTS.has(path.extname(rel))) {
      sources.set(rel, await readFile(path.join(DIST_DIR, rel), "utf8"));
    }
  }

  const deps = new Map();
  for (const rel of distRels) {
    const text = sources.get(rel);
    deps.set(
      rel,
      text === undefined ? [] : substituteReferences(rel, text, hashedRels, () => null).referenced,
    );
  }

  const hashedRelByRel = new Map();
  // The hashed name an asset has been given, or undefined while it is still
  // unnamed — which is what leaves a not-yet-processed reference alone.
  const nameOf = (assetRel) => hashedRelByRel.get(assetRel);

  // Write an asset out under its hashed name and drop the unhashed original,
  // so nothing in dist/ is reachable at a name that carries no digest.
  async function emit(rel, hashedRel, content) {
    await writeFile(path.join(DIST_DIR, hashedRel), content);
    await rm(path.join(DIST_DIR, rel));
  }

  // Name each asset after the bytes it is actually served as, which means
  // rewriting its dependency references first. Hashing before the rewrite (as
  // this did until issue #114) let a dependency-only change alter an importer's
  // bytes while leaving its URL alone, so a browser holding the cached importer
  // kept importing a dependency name the new deploy no longer emits — a 404 on a
  // module import, which is a blank app rather than a stale one.
  for (const component of stronglyConnectedComponents(hashedRels, (rel) =>
    deps.get(rel).filter((dep) => dep !== rel),
  )) {
    const cyclic = component.length > 1 || deps.get(component[0]).includes(component[0]);
    if (!cyclic) {
      const rel = component[0];
      const text = sources.get(rel);
      const content =
        text === undefined
          ? await readFile(path.join(DIST_DIR, rel))
          : substituteReferences(rel, text, hashedRels, nameOf).text;
      const hashedRel = hashedRelFor(rel, contentHash(content));
      hashedRelByRel.set(rel, hashedRel);
      await emit(rel, hashedRel, content);
      continue;
    }
    // Members of an import cycle each depend on every other member's name, so
    // none of them can be named after its own bytes. Name the whole group after
    // one digest of everything that determines all of their bytes instead: the
    // members' pre-rewrite contents plus the hashed names of what they reference
    // outside the cycle. Same name still implies same bytes; it is only coarser,
    // since a change to one member renames every member.
    const members = [...component].sort();
    const memberSet = new Set(members);
    const external = members
      .flatMap((rel) => deps.get(rel).filter((dep) => !memberSet.has(dep)))
      .map(nameOf)
      .sort();
    const hash = contentHash(
      JSON.stringify([members.map((rel) => [rel, sources.get(rel)]), external]),
    );
    for (const rel of members) {
      hashedRelByRel.set(rel, hashedRelFor(rel, hash));
    }
    for (const rel of members) {
      const content = substituteReferences(rel, sources.get(rel), hashedRels, nameOf).text;
      await emit(rel, hashedRelByRel.get(rel), content);
    }
  }

  // The pages are rewritten but never hashed, so they come last, once every
  // asset they name has a name.
  for (const [rel, text] of sources) {
    if (hashedSet.has(rel)) {
      continue;
    }
    const rewritten = substituteReferences(rel, text, hashedRels, nameOf).text;
    if (rewritten !== text) {
      await writeFile(path.join(DIST_DIR, rel), rewritten, "utf8");
    }
  }

  const replacements = [];
  for (const rel of hashedRels) {
    const hashedRel = hashedRelByRel.get(rel);
    replacements.push([`./${rel}`, `./${hashedRel}`]);
    replacements.push([`/${rel}`, `/${hashedRel}`]);
  }
  replacements.sort((a, b) => b[0].length - a[0].length);

  // Every hashed name now covers its own emitted bytes and, transitively, those
  // of everything it imports, so a digest over the name list is a digest of the
  // whole build.
  const buildHash = contentHash(JSON.stringify([...replacements].sort()));
  const manifest = {
    buildHash,
    generatedAt: new Date().toISOString(),
    assets: Object.fromEntries(replacements),
  };
  await writeFile(
    path.join(DIST_DIR, "asset-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
