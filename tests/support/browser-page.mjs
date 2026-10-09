// What the browser tests (tests/e2e) watch on a Playwright page besides the
// page itself: what it reports in the console, and where it goes on the
// network.

// The hosts a page of this app may reach in a test: the server under test,
// and jsDelivr, which serves Pyodide, Sentry's SDK and the Web Serial
// polyfill to every visitor.
const ALLOWED_HOSTS = new Set(["127.0.0.1", "cdn.jsdelivr.net"]);

// Collects what a clean page load must not produce: console errors and
// warnings, uncaught exceptions, and failed requests. The returned array fills
// as the page runs; a test asserts it is still empty at the end.
export function watchConsole(page) {
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    problems.push(`uncaught: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
  });
  return problems;
}

// Records every request the page makes to a host other than the server under
// test and jsDelivr, so a test can assert that nothing reached a real
// third-party service. Requests a test routes to a fixture are answered by
// Playwright and recorded all the same, so pair this with page.route() and
// expect only the routed URLs.
export function watchThirdPartyRequests(page) {
  const requests = [];
  page.on("request", (request) => {
    const { hostname } = new URL(request.url());
    if (!ALLOWED_HOSTS.has(hostname) && !request.url().startsWith("data:")) {
      requests.push(request.url());
    }
  });
  return requests;
}
