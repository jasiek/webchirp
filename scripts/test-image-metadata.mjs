import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findCatalogRadioForImageMetadata,
  isImageDetectionFailure,
  loadImageWithDriverFallback,
} from "../web/js/image-metadata.mjs";
import { createTestRadioHarness } from "./test-radio-harness.mjs";

// The registered driver class for a Baofeng UV-5R image; the BaofengUV5R base
// class itself is not directory-registered, so this is what CHIRP detection
// and the radio catalog both use.
const TEST_RADIO = {
  module: "uv5r",
  className: "BaofengUV5RGeneric",
  vendor: "Baofeng",
  model: "UV-5R",
};

const CATALOG = [
  { module: "ft60", className: "FT60Radio", vendor: "Yaesu", model: "FT-60R" },
  { module: "uv5r", className: "BaofengUV5RGeneric", vendor: "Baofeng", model: "UV-5R" },
];

function makeTestRow() {
  return {
    Location: "1",
    Name: "PMR01",
    Frequency: "446.006250",
    Duplex: "",
    Offset: "0.000000",
    Tone: "",
    rToneFreq: "88.5",
    cToneFreq: "88.5",
    DtcsCode: "023",
    DtcsPolarity: "NN",
    RxDtcsCode: "023",
    CrossMode: "Tone->Tone",
    Mode: "NFM",
    TStep: "12.50",
    Skip: "",
    Power: "Low",
    Comment: "image-metadata-test",
  };
}

test("matches catalog radio by metadata driver class name", () => {
  const match = findCatalogRadioForImageMetadata(CATALOG, {
    hasMetadata: true,
    rclass: "BaofengUV5RGeneric",
    vendor: "Baofeng",
    model: "UV-5R",
  });
  assert.equal(match?.module, "uv5r");
  assert.equal(match?.className, "BaofengUV5RGeneric");
});

test("prefers class-name match over vendor/model match", () => {
  const catalog = [
    { module: "other", className: "OtherRadio", vendor: "Baofeng", model: "UV-5R" },
    { module: "uv5r", className: "BaofengUV5RGeneric", vendor: "Baofeng", model: "UV-5R" },
  ];
  const match = findCatalogRadioForImageMetadata(catalog, {
    hasMetadata: true,
    rclass: "BaofengUV5RGeneric",
    vendor: "Baofeng",
    model: "UV-5R",
  });
  assert.equal(match?.module, "uv5r");
});

test("falls back to vendor/model when class name is unknown", () => {
  const match = findCatalogRadioForImageMetadata(CATALOG, {
    hasMetadata: true,
    rclass: "RenamedLegacyClass",
    vendor: "Yaesu",
    model: "FT-60R",
  });
  assert.equal(match?.module, "ft60");
});

test("returns null for missing metadata or unknown radios", () => {
  assert.equal(findCatalogRadioForImageMetadata(CATALOG, { hasMetadata: false }), null);
  assert.equal(findCatalogRadioForImageMetadata(CATALOG, null), null);
  assert.equal(
    findCatalogRadioForImageMetadata(CATALOG, {
      hasMetadata: true,
      rclass: "NopeRadio",
      vendor: "Nope",
      model: "NP-1",
    }),
    null,
  );
  assert.equal(
    findCatalogRadioForImageMetadata(null, {
      hasMetadata: true,
      rclass: "BaofengUV5R",
      vendor: "Baofeng",
      model: "UV-5R",
    }),
    null,
  );
});

test("binary image metadata drives radio model selection", async (t) => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const harness = await createTestRadioHarness({ repoRoot });

  // Build a metadata-tagged image without importing any driver. The payload is
  // deliberately garbage: metadata parsing must not require driver code.
  const craftedImage = await harness.runPythonJson(
    `
_meta_blob = base64.b64encode(json.dumps(json.loads(_meta_json)).encode())
_img = (b"\\x00" * int(_payload_size)) + chirp_common.CloneModeRadio.MAGIC + _meta_blob
json.dumps({"imageBase64": base64.b64encode(_img).decode("ascii")})
    `,
    {
      _meta_json: JSON.stringify({
        rclass: TEST_RADIO.className,
        vendor: TEST_RADIO.vendor,
        model: TEST_RADIO.model,
        variant: "",
      }),
      _payload_size: 0x1808,
    },
  );

  await t.test("reads vendor/model/class from the metadata trailer", async () => {
    const metadata = await harness.runPythonJson(
      "json.dumps(read_image_metadata_base64(_image_b64))",
      { _image_b64: craftedImage.imageBase64 },
    );
    assert.equal(metadata.hasMetadata, true);
    assert.equal(metadata.rclass, TEST_RADIO.className);
    assert.equal(metadata.vendor, TEST_RADIO.vendor);
    assert.equal(metadata.model, TEST_RADIO.model);
  });

  await t.test("applies CHIRP model-compat renames to metadata", async () => {
    const metadata = await harness.runPythonJson(
      `
_meta_blob = base64.b64encode(json.dumps({"rclass": "RT5RRadio", "vendor": "Retevis", "model": "RT-5R"}).encode())
_img = b"\\x00" * 32 + chirp_common.CloneModeRadio.MAGIC + _meta_blob
json.dumps(read_image_metadata_base64(base64.b64encode(_img).decode("ascii")))
      `,
    );
    assert.equal(metadata.hasMetadata, true);
    assert.equal(metadata.vendor, "Retevis");
    assert.equal(metadata.model, "RT5R");
  });

  await t.test("reports images without a metadata trailer", async () => {
    const metadata = await harness.runPythonJson(
      `json.dumps(read_image_metadata_base64(base64.b64encode(b"\\x00" * 64).decode("ascii")))`,
    );
    assert.equal(metadata.hasMetadata, false);
  });

  await t.test("image load fails while the metadata's driver is not imported", async () => {
    // This is the gap the metadata-driven module import closes: CHIRP image
    // detection only sees drivers that are already imported.
    await assert.rejects(
      harness.runPythonJson("json.dumps(load_image_base64(_image_b64))", {
        _image_b64: craftedImage.imageBase64,
      }),
      /Unsupported model/,
    );
  });

  await t.test("metadata selects the driver module to import, then load detects it", async () => {
    // Mirror handleLoadImage: parse metadata, match it against the catalog,
    // import the matched module, then run CHIRP image detection.
    const metadata = await harness.runPythonJson(
      "json.dumps(read_image_metadata_base64(_image_b64))",
      { _image_b64: craftedImage.imageBase64 },
    );
    const match = findCatalogRadioForImageMetadata(CATALOG, metadata);
    assert.equal(match?.module, TEST_RADIO.module);
    await harness.runPythonJson(
      `
ensure_radio_module(_sel_module)
json.dumps({"imported": True})
      `,
      { _sel_module: match.module },
    );

    // Round-trip through a real exported image so the loaded rows are valid.
    const exported = await harness.exportCodeplugBinary(
      TEST_RADIO.module,
      TEST_RADIO.className,
      [makeTestRow()],
    );
    const loaded = await harness.loadCodeplugBinary(exported.image);
    assert.equal(loaded.module, TEST_RADIO.module);
    assert.equal(loaded.className, TEST_RADIO.className);
    assert.equal(loaded.vendor, TEST_RADIO.vendor);
    assert.equal(loaded.model, TEST_RADIO.model);
    const names = (loaded.rows || []).map((row) => String(row.Name || ""));
    assert.ok(names.includes("PMR01"));
  });

  await t.test("image saved by an unregistered base class resolves by vendor/model", async () => {
    // BaofengUV5R is a non-registered base class; an image tagged with it must
    // still match the registered Baofeng UV-5R catalog entry via vendor/model.
    const exported = await harness.exportCodeplugBinary(
      TEST_RADIO.module,
      "BaofengUV5R",
      [makeTestRow()],
    );
    const metadata = await harness.runPythonJson(
      "json.dumps(read_image_metadata_base64(_image_b64))",
      { _image_b64: exported.imageBase64 },
    );
    assert.equal(metadata.rclass, "BaofengUV5R");
    const match = findCatalogRadioForImageMetadata(CATALOG, metadata);
    assert.equal(match?.module, TEST_RADIO.module);
    assert.equal(match?.className, TEST_RADIO.className);

    const loaded = await harness.loadCodeplugBinary(exported.image);
    assert.equal(loaded.module, TEST_RADIO.module);
    assert.equal(loaded.className, TEST_RADIO.className);
  });
});

// CHIRP's own detection compares VENDOR/MODEL/VARIANT across
// `rclass.ALIASES + [rclass]`. The catalog matcher runs before any driver is
// imported and must be no less precise, because a resolved-but-wrong match
// suppresses the all-drivers sweep that would have found the right driver.
const VARIANT_CATALOG = [
  {
    module: "uvk5",
    className: "UVK5Radio",
    vendor: "Quansheng",
    model: "UV-K5",
    variant: "",
    aliases: [{ vendor: "Quansheng", model: "UV-K5", variant: "" }],
  },
  {
    module: "uvk5",
    className: "OSFWUVK5Radio",
    vendor: "Quansheng",
    model: "UV-K5",
    variant: "OSFW",
    aliases: [{ vendor: "Quansheng", model: "UV-K5", variant: "OSFW" }],
  },
  {
    module: "uvk5_egzumer",
    className: "UVK5RadioEgzumer",
    vendor: "Quansheng",
    model: "UV-K5",
    variant: "egzumer",
    aliases: [{ vendor: "Quansheng", model: "UV-K5", variant: "egzumer" }],
  },
];

test("variant separates drivers that share a vendor and model", () => {
  // Quansheng_UV-K5_egzumer.img used to resolve to uvk5.OSFWUVK5Radio, which
  // then failed detection with "Unsupported model Quansheng UV-K5".
  const match = findCatalogRadioForImageMetadata(VARIANT_CATALOG, {
    hasMetadata: true,
    rclass: "DynamicRadioAlias",
    vendor: "Quansheng",
    model: "UV-K5",
    variant: "egzumer",
  });
  assert.equal(match?.module, "uvk5_egzumer");
  assert.equal(match?.className, "UVK5RadioEgzumer");
});

test("an empty variant means empty, not any", () => {
  const match = findCatalogRadioForImageMetadata(VARIANT_CATALOG, {
    hasMetadata: true,
    rclass: "DynamicRadioAlias",
    vendor: "Quansheng",
    model: "UV-K5",
    variant: "",
  });
  assert.equal(match?.className, "UVK5Radio");
});

test("an unrecorded variant is ambiguous and declines to guess", () => {
  // No variant recorded: CHIRP would match any of the three. Returning one of
  // them would suppress the sweep, so this must resolve to nothing.
  for (const variant of [null, undefined]) {
    assert.equal(
      findCatalogRadioForImageMetadata(VARIANT_CATALOG, {
        hasMetadata: true,
        rclass: "DynamicRadioAlias",
        vendor: "Quansheng",
        model: "UV-K5",
        variant,
      }),
      null,
    );
  }
});

test("a class-name match that contradicts the recorded identity does not win", () => {
  // Kenwood_TS-480_CloneMode.img stamps rclass TS480Radio, which is the
  // live-mode driver's class name; the clone-mode driver is TS480_CRadio.
  const catalog = [
    {
      module: "kenwood_live",
      className: "TS480Radio",
      vendor: "Kenwood",
      model: "TS-480_LiveMode",
      variant: "",
      isLiveRadio: true,
      aliases: [{ vendor: "Kenwood", model: "TS-480_LiveMode", variant: "" }],
    },
    {
      module: "ts480",
      className: "TS480_CRadio",
      vendor: "Kenwood",
      model: "TS-480_CloneMode",
      variant: "",
      isLiveRadio: false,
      aliases: [{ vendor: "Kenwood", model: "TS-480_CloneMode", variant: "" }],
    },
  ];
  const match = findCatalogRadioForImageMetadata(catalog, {
    hasMetadata: true,
    rclass: "TS480Radio",
    vendor: "Kenwood",
    model: "TS-480_CloneMode",
    variant: "",
  });
  assert.equal(match?.module, "ts480", "identity must outrank a stale class name");
});

test("aliases are matched, as CHIRP matches them", () => {
  const catalog = [
    {
      module: "retevis_rt21",
      className: "RT21Radio",
      vendor: "Retevis",
      model: "RT21",
      variant: "",
      aliases: [
        { vendor: "Retevis", model: "RT21", variant: "" },
        { vendor: "Retevis", model: "RB17", variant: "" },
      ],
    },
  ];
  const match = findCatalogRadioForImageMetadata(catalog, {
    hasMetadata: true,
    rclass: "DynamicRadioAlias",
    vendor: "Retevis",
    model: "RB17",
    variant: "",
  });
  assert.equal(match?.className, "RT21Radio");
});

test("several drivers claiming one identity resolve to nothing", () => {
  const catalog = [
    { module: "a", className: "ARadio", vendor: "V", model: "M", variant: "", aliases: [] },
    { module: "b", className: "BRadio", vendor: "V", model: "M", variant: "", aliases: [] },
  ];
  assert.equal(
    findCatalogRadioForImageMetadata(catalog, {
      hasMetadata: true,
      rclass: "Unknown",
      vendor: "V",
      model: "M",
      variant: "",
    }),
    null,
  );
});

// Pyodide surfaces a Python exception as its formatted traceback, so the class
// name is what the retry gate reads. scripts/test-metadataless-image-load.mjs
// pins this shape against the real runtime.
function pythonError(className, message) {
  return new Error(
    'Traceback (most recent call last):\n  File "<exec>", line 1443, in load_image_base64\n'
    + `${className}: ${message}\n`,
  );
}

test("only a detection failure counts as one", () => {
  assert.equal(
    isImageDetectionFailure(
      pythonError("ImageDetectionError", "Unable to detect radio from image: Unsupported model"),
    ),
    true,
  );
  assert.equal(
    isImageDetectionFailure(
      pythonError("RuntimeUnsupportedError", "Loaded image is not a clone-mode CHIRP image"),
    ),
    false,
  );
  assert.equal(isImageDetectionFailure(null), false);
});

// The matcher can still be wrong in ways the catalog cannot see, so detection
// after a fast-path resolve must fall back to the sweep rather than surfacing
// the failure. Without it, resolving the wrong driver is worse than resolving
// none, because it skips the sweep that would have succeeded.
test("detection failure after a resolved match retries against all drivers", async () => {
  const calls = [];
  let attempt = 0;
  const result = await loadImageWithDriverFallback({
    resolvedDriver: { module: "uvk5", className: "OSFWUVK5Radio" },
    loadImage: () => {
      attempt += 1;
      calls.push(`load:${attempt}`);
      if (attempt === 1) {
        throw pythonError(
          "ImageDetectionError",
          "Unable to detect radio from image: Unsupported model Quansheng UV-K5",
        );
      }
      return { module: "uvk5_egzumer" };
    },
    importDriversForDetection: () => {
      calls.push("sweep");
      return Promise.resolve();
    },
    log: (line) => calls.push(`log:${line.includes("retrying") ? "retry" : "other"}`),
  });

  assert.deepEqual(calls, ["load:1", "log:retry", "sweep", "load:2"]);
  assert.deepEqual(result, { module: "uvk5_egzumer" });
});

// The sweep is the slowest thing the app does (every driver fetched
// individually from a CDN, seconds even when it stops early). Spending it on a
// failure it cannot possibly fix just delays the real error.
test("a failure the sweep cannot fix is surfaced without sweeping", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      loadImageWithDriverFallback({
        resolvedDriver: { module: "uv5r", className: "BaofengUV5RGeneric" },
        loadImage: () => {
          calls.push("load");
          throw pythonError(
            "RuntimeUnsupportedError",
            "Loaded image is not a clone-mode CHIRP image",
          );
        },
        importDriversForDetection: () => {
          calls.push("sweep");
          return Promise.resolve();
        },
      }),
    /not a clone-mode CHIRP image/,
  );
  assert.deepEqual(calls, ["load"]);
});

test("a successful resolved match never imports every driver", async () => {
  const calls = [];
  const result = await loadImageWithDriverFallback({
    resolvedDriver: { module: "uv5r", className: "BaofengUV5RGeneric" },
    loadImage: () => {
      calls.push("load");
      return { module: "uv5r" };
    },
    importDriversForDetection: () => {
      calls.push("sweep");
      return Promise.resolve();
    },
  });

  assert.deepEqual(calls, ["load"], "the sweep is the slowest thing the app does");
  assert.deepEqual(result, { module: "uv5r" });
});

test("an unresolved image sweeps first, and a failure there is surfaced", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      loadImageWithDriverFallback({
        resolvedDriver: null,
        loadImage: () => {
          calls.push("load");
          throw new Error("Unable to detect radio from image");
        },
        importDriversForDetection: () => {
          calls.push("sweep");
          return Promise.resolve();
        },
      }),
    /Unable to detect radio from image/,
  );
  // One sweep, one attempt: there is nothing left to fall back to.
  assert.deepEqual(calls, ["sweep", "load"]);
});
