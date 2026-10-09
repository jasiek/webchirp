// Session bookkeeping for hand-written runtime API stubs.
//
// The UI opens a radio session for every selection (web/js/ui/radio-session.ts)
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
// in web/js/runtime-rpc.ts.
const SESSION_BOUND_METHODS = [
  "normalizeRows",
  "validateRowsForUpload",
  "normalizeAndValidateRows",
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
    // Every edit the grid commits is checked by the runtime; a stub that is
    // not about that accepts every value as typed.
    normalizeAndValidateRows: fakeRowCheck().normalizeAndValidateRows,
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

// A stand-in for the runtime's normalize_and_validate_rows
// (web/python/webchirp_bridge/row_validation.py), for fake-DOM tests about
// what the grid does with an answer rather than about the rules themselves,
// which tests/channels/row-normalization.mjs pins against the real runtime.
//
//   verdict(column, value, previous, { allowReadOnly, payload }) -> { value, accepted, note? }
//                 What one edit stores. Applied in order per row, each seeing
//                 what the edit before it stored, as the runtime does. The
//                 default stores every value as typed.
//   findings(row) -> { issues, warnings }
//                 What the driver says about the row the edits produced.
//   held          Answer nothing until the test calls release(), so a test
//                 can edit again, or change radio, while a check is in flight.
//
// calls records every payload, so a test can count the runtime calls a batch
// took.
export function fakeRowCheck({
  verdict = (_column, value) => ({ value, accepted: true }),
  findings = () => ({ issues: [], warnings: [] }),
  held = false,
} = {}) {
  const calls = [];
  const waiting = [];

  function answer(payload) {
    const { rows } = payload;
    return {
      rows: rows.map(({ row, edits }) => {
        const current = { ...row };
        const cells = edits.map(({ column, value, allowReadOnly }) => {
          const outcome = verdict(column, String(value ?? ""), current[column], { allowReadOnly: Boolean(allowReadOnly), payload });
          current[column] = outcome.value;
          return { column, value: outcome.value, accepted: outcome.accepted, note: outcome.note ?? "" };
        });
        return { cells, ...findings(current) };
      }),
    };
  }

  return {
    calls,
    async normalizeAndValidateRows(payload) {
      calls.push(payload);
      if (!held) {
        return answer(payload);
      }
      return new Promise((resolve) => {
        waiting.push({ payload, resolve });
      });
    },
    // Answer the held call at index (in the order they were made), or every
    // held call still waiting when index is omitted.
    release(index) {
      const entries = index === undefined ? waiting.splice(0) : waiting.splice(index, 1);
      for (const { payload, resolve } of entries) {
        resolve(answer(payload));
      }
    },
    // How many held calls are still waiting.
    get waiting() {
      return waiting.length;
    },
  };
}
