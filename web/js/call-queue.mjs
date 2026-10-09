// FIFO queue that runs async tasks strictly one at a time.
//
// Runtime RPCs share mutable Pyodide interpreter state: the `_sel_*` globals
// and Python's module registry. A call can also suspend mid-import while the
// lazy import hook fetches driver source, which hands control back to the
// event loop; a second call entering the interpreter at that point re-executes
// the same driver module and CHIRP's registry rejects the duplicate
// registration ("Duplicate radio driver id"). Serializing the calls removes
// the overlap entirely.
/**
 * @returns {<T>(task: () => T|Promise<T>) => Promise<T>}  Runs task once every
 *   task enqueued before it has settled, and settles as task does.
 */
export function createCallQueue() {
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  /**
   * @template T
   * @param {() => T|Promise<T>} task
   * @returns {Promise<T>}
   */
  return function enqueue(task) {
    const result = chain.then(() => task());
    // Keep the chain alive after failures; the caller still sees the rejection.
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
