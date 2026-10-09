/** What a thrown value may carry; any of it may be missing. */
export interface ErrorFields {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  /** A Node system error's code ("ENOENT"), or a GeolocationPositionError's number. */
  code?: unknown;
}

// The fields a thrown value may carry, read without trusting its type: anything
// can be thrown, and reading a field off a primitive (or a missing one) gives
// undefined, which is what every reader here already expects.
export function errorFields(error: unknown): ErrorFields {
  return (error ?? {}) as ErrorFields;
}

// Preserve exception messages as well as frames: some browsers omit the
// message from Error.stack, and Pyodide stores its Python traceback in message.
/**
 * @param error Anything thrown: an Error, a string, a plain object.
 */
export function errorDetails(error: unknown): string {
  if (!error) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  const { name, message, stack } = errorFields(error);
  if (typeof stack === "string" && stack.length > 0) {
    const text = typeof message === "string" ? message : "";
    if (text && !stack.includes(text)) {
      const prefix = typeof name === "string" && name ? `${name}: ` : "";
      return `${prefix}${text}\n${stack}`;
    }
    return stack;
  }
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
