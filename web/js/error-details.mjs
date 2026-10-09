// Preserve exception messages as well as frames: some browsers omit the
// message from Error.stack, and Pyodide stores its Python traceback in message.
/**
 * @param {any} error  Anything thrown: an Error, a string, a plain object.
 * @returns {string}
 */
export function errorDetails(error) {
  if (!error) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error.stack === "string" && error.stack.length > 0) {
    const message = typeof error.message === "string" ? error.message : "";
    if (message && !error.stack.includes(message)) {
      const name = typeof error.name === "string" && error.name ? `${error.name}: ` : "";
      return `${name}${message}\n${error.stack}`;
    }
    return error.stack;
  }
  if (typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
