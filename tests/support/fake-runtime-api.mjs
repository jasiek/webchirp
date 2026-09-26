// Session bookkeeping for hand-written runtime API stubs.
//
// The UI opens a radio session for every selection (web/js/ui/radio-session.js)
// and names it by sessionId on every radio-bound call, so a stub of the
// runtime API has to answer openRadioSession/closeRadioSession and read the
// id back into the radio it stands for. The fake-DOM tests are about the
// editor, not about session plumbing, and their stubs are written against
// ({ module, className }) payloads; this wrapper keeps them that way. It
// hands out ids, translates a call's sessionId back into the module and class
// the session was opened for, and stamps a sessionId onto a stubbed image
// load the way the real runtime does.
//
// A stub that defines openRadioSession or closeRadioSession itself keeps its
// own, so a test about the session calls can still observe them.

// Every runtime method that names a session. Kept in step with RUNTIME_METHODS
// in web/js/runtime-rpc.js.
const SESSION_BOUND_METHODS = [
  "normalizeRows",
  "validateRowsForUpload",
  "exportImage",
  "downloadSelectedRadio",
  "uploadSelectedRadio",
  "getRadioMetadata",
  "getChannelExtra",
  "getRadioSettings",
  "validateRadioSettings",
];

export function withRadioSessions(api) {
  const sessions = new Map();
  let counter = 0;

  // A new id for a driver, in a shape that names it for the assertion that
  // reads it and can never collide with an earlier one.
  function open(module, className) {
    counter += 1;
    const sessionId = `${module}:${className}#${counter}`;
    sessions.set(sessionId, { module, className });
    return sessionId;
  }

  // The (module, className) payload a stub expects, from the sessionId the UI
  // sent. An unknown or empty id (no radio selected) yields undefined fields,
  // which is what the stubs read a missing selection as.
  function translate(payload = {}) {
    const { sessionId, ...rest } = payload || {};
    if (sessionId === undefined) {
      return payload;
    }
    const radio = sessions.get(String(sessionId || ""));
    return { module: radio?.module, className: radio?.className, ...rest };
  }

  const wrapped = {
    ...api,
    openRadioSession: api.openRadioSession
      || (async ({ module, className }) => ({ sessionId: open(module, className) })),
    closeRadioSession: api.closeRadioSession
      || (async ({ sessionId }) => ({ closed: sessions.delete(String(sessionId || "")), sessionId })),
  };
  for (const name of SESSION_BOUND_METHODS) {
    if (typeof api[name] === "function") {
      wrapped[name] = (payload) => api[name](translate(payload));
    }
  }
  if (typeof api.loadImage === "function") {
    wrapped.loadImage = async (payload) => {
      const loaded = await api.loadImage(payload);
      if (loaded && loaded.module && !loaded.sessionId) {
        return { ...loaded, sessionId: open(loaded.module, loaded.className) };
      }
      return loaded;
    };
  }
  return wrapped;
}
