// Browser-reported connectivity state. This deliberately listens only to the
// platform's online/offline signal: a failed directory request says something
// about that service, not whether the whole device has a network connection.
export function createConnectivity(ctx) {
  const { dom } = ctx;
  let online = true;

  // Publish one browser state to both its global badge and the only controls
  // that require a network, keeping display and behaviour on the same value.
  function setOnline(nextOnline) {
    online = Boolean(nextOnline);
    dom.offlineIndicatorEl.hidden = online;
    ctx.repeaterQuery.setOnline(online);
  }

  // Seed the state for a page that loads while offline, then follow only the
  // browser's connectivity events; request outcomes never enter this module.
  function bindEvents() {
    window.addEventListener("online", () => setOnline(true));
    window.addEventListener("offline", () => setOnline(false));
    setOnline(navigator.onLine !== false);
  }

  // Expose the current browser signal for diagnostics without allowing other
  // modules to mutate the module-owned state.
  function isOnline() {
    return online;
  }

  return { bindEvents, isOnline };
}
