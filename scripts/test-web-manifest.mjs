import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Guards the home-screen install contract. None of this is exercised by loading
// the page — a manifest that fails to parse, or an icon entry pointing at a file
// that was renamed, only shows up when a user tries to install the app and
// silently gets a browser shortcut instead of a WebAPK.
const WEB_DIR = path.join(process.cwd(), "web");
const MANIFEST_PATH = path.join(WEB_DIR, "manifest.webmanifest");

const manifestText = fs.readFileSync(MANIFEST_PATH, "utf8");

// PNG dimensions live in the IHDR chunk: 8-byte signature, 4-byte length,
// 4-byte type, then width and height as big-endian uint32s.
function pngSize(filePath) {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, header, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(
    header.subarray(0, 8).toString("latin1"),
    "\x89PNG\r\n\x1a\n",
    `${path.basename(filePath)} is not a PNG`,
  );
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

test("manifest.webmanifest is valid JSON with the fields Chrome needs to install", () => {
  const manifest = JSON.parse(manifestText);
  for (const field of ["name", "short_name", "start_url", "scope", "icons"]) {
    assert.ok(manifest[field], `manifest is missing ${field}`);
  }
  // Anything other than standalone/fullscreen leaves the app in a browser tab.
  assert.equal(manifest.display, "standalone");
  // theme_color paints the status bar and background_color the splash screen;
  // both must stay valid hex or Chrome ignores them without complaint.
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
});

test("every manifest icon exists at its declared size", () => {
  const manifest = JSON.parse(manifestText);
  for (const icon of manifest.icons) {
    const iconPath = path.join(WEB_DIR, icon.src);
    assert.ok(fs.existsSync(iconPath), `missing manifest icon: ${icon.src}`);
    const { width, height } = pngSize(iconPath);
    assert.equal(
      `${width}x${height}`,
      icon.sizes,
      `${icon.src} is ${width}x${height} but declares ${icon.sizes}`,
    );
  }
});

test("manifest carries the icon purposes Android installs need", () => {
  const manifest = JSON.parse(manifestText);
  const sizesFor = (purpose) => manifest.icons
    .filter((icon) => String(icon.purpose || "any").split(/\s+/).includes(purpose))
    .map((icon) => icon.sizes);

  // Chrome requires both 192 and 512 among the unmasked icons to install.
  assert.ok(sizesFor("any").includes("192x192"), "no 192x192 icon with purpose any");
  assert.ok(sizesFor("any").includes("512x512"), "no 512x512 icon with purpose any");
  // Without a maskable icon Android letterboxes the "any" icon inside a white
  // badge instead of filling the launcher shape.
  assert.ok(sizesFor("maskable").length > 0, "no maskable icon");
});

test("every page links the manifest and an iOS touch icon", () => {
  for (const page of ["index.html", "about.html"]) {
    const html = fs.readFileSync(path.join(WEB_DIR, page), "utf8");
    assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest"/, page);
    // iOS ignores manifest icons entirely and reads apple-touch-icon instead.
    assert.match(html, /<link rel="apple-touch-icon" href="([^"]+)"/, page);
    const [, touchIconSrc] = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/);
    assert.ok(
      fs.existsSync(path.join(WEB_DIR, touchIconSrc)),
      `${page} apple-touch-icon is missing: ${touchIconSrc}`,
    );
  }
});
