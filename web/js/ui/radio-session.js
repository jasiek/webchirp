import { requireRuntimeApi } from "./state.js";

// The runtime session behind the selected radio.
//
// Every radio-bound runtime call names a session the Python runtime opened for
// one driver (web/python/webchirp_bridge/session.py); the session owns the
// clone image, the detected class and the undecodable channels between calls.
// This module owns the handle for the session of the radio the user is working
// on: selecting a radio opens one, selecting another closes it and opens the
// next, and an image load hands over the session the runtime opened for the
// driver the image named. A load's response is applied only while the handle
// it was made for is still the current one -- identity replaces the counters
// that used to guard against a slow load overwriting a newer selection.
//
// A handle is created synchronously so a selection can be made and rendered at
// once; its id arrives when the runtime answers, and every caller awaits idOf()
// before it needs one.
export function createRadioSession(ctx) {
  const { state, log } = ctx;

  // Close a handle's session in the runtime once its id is known. The id may
  // still be in flight when the selection moves on, so the close is chained on
  // it rather than on the handle; a session that never opened has nothing to
  // close and the rejection is swallowed with the open's own.
  function release(handle) {
    if (!handle || handle.closed) {
      return;
    }
    handle.closed = true;
    handle.ready
      .then((sessionId) => requireRuntimeApi(state).closeRadioSession({ sessionId }))
      .catch((error) => {
        log.logDebug(`RADIO SESSION close failed: ${error?.message || error}`);
      });
  }

  // Open a session for a radio, or adopt one the runtime already opened for it
  // (an image load). Reselecting the radio the current session is for keeps
  // that session -- and with it the image a download put there -- rather than
  // opening another; anything else closes the current session first, so a
  // response still in flight for it can be told from a current one.
  function open(radio, adoptedSessionId = "") {
    const current = state.radioSession;
    if (
      !adoptedSessionId
      && current
      && !current.closed
      && current.radio?.key === radio?.key
    ) {
      return current;
    }
    release(current);
    const handle = {
      radio,
      id: adoptedSessionId ? String(adoptedSessionId) : "",
      // Set once the session's metadata and settings have both been applied
      // to the editor; reselecting a loaded radio then needs no new calls
      // and keeps the user's unsaved edits.
      loaded: false,
      // Set while a metadata/settings load for this handle is in flight, so a
      // reselection meanwhile does not start a second one.
      loading: false,
      closed: false,
      ready: null,
    };
    if (adoptedSessionId) {
      handle.ready = Promise.resolve(handle.id);
    } else {
      handle.ready = Promise.resolve()
        .then(() => requireRuntimeApi(state).openRadioSession({
          module: radio.module,
          className: radio.className,
        }))
        .then((result) => {
          handle.id = String(result?.sessionId || "");
          if (!handle.id) {
            throw new Error("The runtime opened no radio session");
          }
          return handle.id;
        });
      // Only the callers that await the id should see a failed open; without
      // this the same rejection would also surface as an unhandled one.
      handle.ready.catch(() => {});
    }
    state.radioSession = handle;
    return handle;
  }

  // Close the current session, leaving no radio session open.
  function close() {
    release(state.radioSession);
    state.radioSession = null;
  }

  function current() {
    return state.radioSession;
  }

  // Whether a handle is still the one the editor is working with; the test a
  // load runs before applying its response.
  function isCurrent(handle) {
    return state.radioSession === handle;
  }

  // The runtime id of a handle, once the open has answered; "" for no handle.
  // A handle closed while its id was still in flight throws instead: the
  // selection has moved on, its session is being closed in the runtime, and a
  // call made for it now would only fail there and leave a runtime error in
  // the debug panel for a load nobody wants any more.
  async function idOf(handle) {
    if (!handle) {
      return "";
    }
    const sessionId = await handle.ready;
    if (handle.closed) {
      throw new Error(`Radio session ${sessionId} was closed before it was used`);
    }
    return sessionId;
  }

  // The current session's runtime id, for one-shot calls made on behalf of
  // whatever radio is selected at that moment.
  async function currentId() {
    return idOf(state.radioSession);
  }

  // Record that a handle's metadata and settings have been applied, so that
  // reselecting its radio is a no-op. Ignored for a handle that is no longer
  // current: its load was discarded, so nothing about it is loaded.
  function markLoaded(handle) {
    if (handle && isCurrent(handle)) {
      handle.loaded = true;
    }
  }

  return { open, close, current, isCurrent, idOf, currentId, markLoaded };
}
