// Driver-specific per-channel settings ride along on channel rows under a key
// that is not a CSV header, the same way repeater coordinates do in
// web/js/row-geo.js. Everything that serializes rows (TSV clipboard, CSV
// export, the Python upload path) reads header keys only, so the sidecar never
// leaks into a codeplug; it travels with the row while the grid is open.
//
// The key is shared with the runtime, which fills it on download and replays it
// on upload -- ROW_EXTRA_KEY in web/python/webchirp_bridge/channel_extra.py.
// The two spellings have to agree.
const EXTRA_KEY = "__extra";

// The values a row carries, or null when it carries none. A channel created in
// the grid, imported from CSV or pasted over a slot has no sidecar and is
// entitled to the driver's defaults, which is what null says.
export function rowExtras(row) {
  const values = row?.[EXTRA_KEY];
  return values && typeof values === "object" ? values : null;
}

// Merge edited values into whatever the row already carries rather than
// replacing the mapping: a row moved here from another driver may hold settings
// this driver never described, and the upload path ignores names the
// destination memory does not have. Dropping them here would instead lose them
// the moment someone opened the editor.
export function setRowExtras(row, values) {
  if (!row || !values || typeof values !== "object") {
    return;
  }
  // An empty write is not a write: a row that has no settings of its own must
  // not gain an empty sidecar, because the sidecar's absence is what tells the
  // upload path to leave the driver's defaults alone for that channel.
  if (Object.keys(values).length === 0) {
    return;
  }
  row[EXTRA_KEY] = { ...(rowExtras(row) || {}), ...values };
}
