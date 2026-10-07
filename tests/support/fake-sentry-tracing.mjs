// SDK factories shared by reporting tests: record configuration without patching
// Node's fetch or creating real spans in tests of unrelated UI behavior.
export const fakeSentryTracing = {
  browserTracingIntegration: (options) => ({ name: "BrowserTracing", options }),
  spanStreamingIntegration: () => ({ name: "SpanStreaming" }),
  withStreamedSpan: (callback) => callback,
};
