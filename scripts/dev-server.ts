// The development server: web/ as it is on disk, with the isolation headers
// the app expects, plus one transform. The sources are TypeScript, which no
// browser loads, so a request for a .ts file is answered with that file
// type-stripped by esbuild's transform API -- as JavaScript, with an inline
// source map back to the .ts -- and everything else is served static. The
// pages name the .ts entries they load (<script type="module"
// src="./app.ts">) and the modules import each other by their .ts names, so
// the URL a browser asks for is always the file on disk: nothing maps a .js
// request onto a .ts file. scripts/build-dist.ts reads the same script tags
// and hands the same entries to esbuild for dist/.
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

import * as esbuild from "esbuild";

const webRootDir = path.resolve(process.cwd(), "web");
const port = Number.parseInt(process.env.PORT || "8000", 10);
const host = process.env.HOST || "127.0.0.1";

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".xml": "application/xml; charset=utf-8",
  ".zip": "application/zip",
};

function resolveRequestPath(urlPath: string): string | null {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0] || "/");
  const normalizedPath = cleanPath.startsWith("/web/")
    ? cleanPath.slice("/web".length)
    : cleanPath;
  const requested = normalizedPath === "/" ? "/index.html" : normalizedPath;
  const fsPath = path.resolve(webRootDir, `.${requested}`);
  if (!fsPath.startsWith(webRootDir)) {
    return null;
  }
  return fsPath;
}

// Transformed .ts sources by path, each with the mtime it was built from, so a
// reload after an edit rebuilds only the file that changed.
const transformCache = new Map<string, { mtimeMs: number; code: string }>();

// A .ts source as the JavaScript a browser can run: types stripped, nothing
// else changed (no bundling, no downlevelling past the target the browser code
// is checked for), and an inline source map so devtools shows the .ts.
// verbatimModuleSyntax matches tsconfig.json and Node's own stripping: every
// import not marked type survives, so the browser sees exactly the imports
// Node does.
async function transformTypeScript(filePath: string, stat: fs.Stats): Promise<string> {
  const cached = transformCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.code;
  }
  const source = await fs.promises.readFile(filePath, "utf8");
  const result = await esbuild.transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
    sourcemap: "inline",
    sourcefile: path.relative(webRootDir, filePath).split(path.sep).join("/"),
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  });
  transformCache.set(filePath, { mtimeMs: stat.mtimeMs, code: result.code });
  return result.code;
}

function applyIsolationHeaders(res: ServerResponse): void {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

const server = createServer((req, res) => {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    applyIsolationHeaders(res);
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return;
  }

  const filePath = resolveRequestPath(req.url || "/");
  if (!filePath) {
    applyIsolationHeaders(res);
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    applyIsolationHeaders(res);
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return;
  }

  if (stat.isDirectory()) {
    applyIsolationHeaders(res);
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts" && !filePath.endsWith(".d.ts")) {
    transformTypeScript(filePath, stat).then(
      (code) => {
        applyIsolationHeaders(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Content-Length", Buffer.byteLength(code));
        res.end(method === "HEAD" ? undefined : code);
      },
      (error) => {
        // A syntax error in a source: say so in the terminal and the
        // response, rather than serving a module the browser cannot parse.
        console.error(error);
        applyIsolationHeaders(res);
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(String(error?.message || error));
      },
    );
    return;
  }
  const contentType = MIME_BY_EXT[ext] || "application/octet-stream";
  applyIsolationHeaders(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", stat.size);
  if (method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`webchirp dev server listening at http://${host}:${port}/`);
});
