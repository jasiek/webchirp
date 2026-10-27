// Capture what the Python runtime writes to the debug panel while fn runs.
//
// The panel is serial_log on the jsbridge module that owns it: _log_debug
// resolves the name there, so patching the flattened global would miss it.
// The real serial_log is put back whether fn resolves or throws.
const CAPTURE = `
_captured_debug_log = []
_real_serial_log = jsbridge.serial_log
jsbridge.serial_log = lambda message: _captured_debug_log.append(str(message))
`;
const RELEASE = `
jsbridge.serial_log = _real_serial_log
json.dumps(_captured_debug_log)
`;

/**
 * Run fn with the debug panel captured; hand back what fn returned and every
 * line the runtime logged meanwhile.
 * @template T
 * @param {{ runPython(python: string): Promise<any> }} harness
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ result: T, log: string[] }>}
 */
export async function withCapturedDebugLog(harness, fn) {
  await harness.runPython(CAPTURE);
  let result;
  try {
    result = await fn();
  } catch (error) {
    await harness.runPython(RELEASE);
    throw error;
  }
  return { result, log: JSON.parse(await harness.runPython(RELEASE)) };
}
