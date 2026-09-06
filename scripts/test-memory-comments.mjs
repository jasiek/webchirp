import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTestRadioHarness } from "./test-radio-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repoRoot, "chirp/tests/images/Baofeng_UV-5R.img");

// UV-5R comments live in CloneModeRadio's metadata trailer rather than its
// channel bytes. Exercise the same read, edit, clear, and erase operations a
// desktop-created image takes through the browser bridge.
const MEMORY_COMMENT_PROBE = `
import base64, json

ensure_radio_module("uv5r")
_clean = load_image_base64(_image_b64)
_module = _clean["module"]
_class_name = _clean["className"]
_target = int(_clean["rows"][0]["Location"])
_key = "%04i_comment" % _target
_radio_cls = _import_radio_class(_module, _class_name)

# Seed an image exactly as desktop CHIRP does when a driver has no native
# comment field: the channel stays in the memory map and its comment goes in
# the image metadata trailer.
_radio = _radio_from_image_bytes(_radio_cls, base64.b64decode(_image_b64))
_memory = _radio.get_memory(_target)
_memory.comment = "desktop comment"
_radio.set_memory_extra(_memory)
_seeded_image = _image_bytes_from_radio(_radio)
_seeded_b64 = base64.b64encode(_seeded_image).decode("ascii")

_loaded = load_image_base64(_seeded_b64)
_loaded_row = next(_row for _row in _loaded["rows"] if int(_row["Location"]) == _target)
_loaded_comment = _loaded_row["Comment"]
_column_metadata = get_radio_column_metadata(_module, _class_name)

_loaded_row["Comment"] = "edited in webchirp"
_edited = export_image_base64(_module, _class_name, _loaded["rows"], _loaded["settings"])
_edited_loaded = load_image_base64(_edited["imageBase64"])
_edited_row = next(_row for _row in _edited_loaded["rows"] if int(_row["Location"]) == _target)
_edited_comment = _edited_row["Comment"]
_, _edited_metadata = chirp_common.CloneModeRadio._strip_metadata(
    base64.b64decode(_edited["imageBase64"])
)

_edited_row["Comment"] = ""
_cleared = export_image_base64(
    _module, _class_name, _edited_loaded["rows"], _edited_loaded["settings"]
)
_cleared_loaded = load_image_base64(_cleared["imageBase64"])
_cleared_row = next(_row for _row in _cleared_loaded["rows"] if int(_row["Location"]) == _target)
_, _cleared_metadata = chirp_common.CloneModeRadio._strip_metadata(
    base64.b64decode(_cleared["imageBase64"])
)

# Reload the seeded state, then omit the row to exercise WebCHIRP's delete
# semantics and CHIRP's separate erase_memory_extra hook.
_erase_source = load_image_base64(_seeded_b64)
_remaining_rows = [
    _row for _row in _erase_source["rows"]
    if int(_row["Location"]) != _target
]
_erased = export_image_base64(
    _module, _class_name, _remaining_rows, _erase_source["settings"]
)
_erased_loaded = load_image_base64(_erased["imageBase64"])
_, _erased_metadata = chirp_common.CloneModeRadio._strip_metadata(
    base64.b64decode(_erased["imageBase64"])
)

json.dumps({
    "target": _target,
    "loadedComment": _loaded_comment,
    "commentEditable": _column_metadata["columns"]["Comment"]["editable"],
    "editedComment": _edited_comment,
    "editedMetadataComment": (_edited_metadata.get("mem_extra") or {}).get(_key),
    "clearedComment": _cleared_row["Comment"],
    "clearedMetadataHasKey": _key in (_cleared_metadata.get("mem_extra") or {}),
    "erasedRowPresent": any(
        int(_row["Location"]) == _target for _row in _erased_loaded["rows"]
    ),
    "erasedMetadataHasKey": _key in (_erased_metadata.get("mem_extra") or {}),
})
`;

test("clone-image metadata comments survive load, edit, clear, and erase", async () => {
  const harness = await createTestRadioHarness({ repoRoot });
  const raw = await fs.readFile(fixturePath);
  const result = await harness.runPythonJson(MEMORY_COMMENT_PROBE, {
    _image_b64: raw.toString("base64"),
  });

  assert.equal(result.loadedComment, "desktop comment");
  assert.equal(result.commentEditable, true);
  assert.equal(result.editedComment, "edited in webchirp");
  assert.equal(result.editedMetadataComment, "edited in webchirp");
  assert.equal(result.clearedComment, "");
  assert.equal(result.clearedMetadataHasKey, false);
  assert.equal(result.erasedRowPresent, false);
  assert.equal(result.erasedMetadataHasKey, false);
});
