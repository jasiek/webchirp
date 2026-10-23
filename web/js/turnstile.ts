// Cloudflare Turnstile for the RepeaterBook query
// (https://developers.cloudflare.com/turnstile/). The API refuses a
// RepeaterBook query without a token it can verify, and a token is good for one
// request only, so the form holds one widget and takes a fresh token from it
// for every request it sends, preview or import.
//
// The site key is a deployment setting like the API base: index.html ships
// <meta name="webchirp-turnstile-site-key" content="">, scripts/build-dist.ts
// fills it from TURNSTILE_SITE_KEY, and a blank key renders no widget and sends
// no header -- the API only asks for one when it holds the matching secret.
//
// The script loads from Cloudflare on the first RepeaterBook open, never from
// the bundle: Cloudflare requires it be fetched from its own URL, and a page
// that never opens that form never contacts them.

const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TURNSTILE_SITE_KEY_META = "webchirp-turnstile-site-key";

/** The request header the API reads the token from. */
export const TURNSTILE_TOKEN_HEADER = "CF-Turnstile-Response";

// How long a request waits for the widget to produce a token. Long, because a
// challenge Cloudflare escalates to a checkbox waits on the user; bounded,
// because a widget that will never produce one (a key the domain is not
// allowed, a blocked script) would otherwise leave the button on "Querying..."
// for good.
export const TURNSTILE_TOKEN_TIMEOUT_MS = 60000;

/** The members of Cloudflare's turnstile global this module calls. */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

/** https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/ */
export interface TurnstileRenderOptions {
  sitekey: string;
  appearance?: "always" | "execute" | "interaction-only";
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: (code: string) => boolean | void;
  "timeout-callback"?: () => void;
}

/** One widget, handing out a distinct token per request. */
export interface TurnstileTokens {
  /** Resolves with a token no earlier caller was given. */
  next(): Promise<string>;
  /** Removes the widget; pending and later next() calls reject. */
  remove(): void;
}

// The deployment's site key, or "" when the meta tag is absent or blank.
export function resolveTurnstileSiteKey(): string {
  const meta = document.querySelector(`meta[name="${TURNSTILE_SITE_KEY_META}"]`);
  return String(meta?.getAttribute("content") || "").trim();
}

let scriptPromise: Promise<TurnstileApi> | null = null;

// Load Cloudflare's script once per page. A failed load is forgotten, so the
// next RepeaterBook open tries again rather than staying broken.
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (!scriptPromise) {
    scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.addEventListener("load", () => {
        if (window.turnstile) {
          resolve(window.turnstile);
        } else {
          reject(new Error("Cloudflare Turnstile loaded without its API."));
        }
      });
      script.addEventListener("error", () => {
        reject(new Error("Cloudflare Turnstile could not be loaded; a content blocker may be stopping challenges.cloudflare.com."));
      });
      document.head.appendChild(script);
    }).catch((error) => {
      scriptPromise = null;
      throw error;
    });
  }
  return scriptPromise;
}

// Render a widget into `container` and hand its tokens out one per request.
// A token nobody has asked for yet is kept for the next caller; a token handed
// out resets the widget, which starts on the next one straight away, so a
// request usually finds one waiting.
export function createTurnstileTokens(
  container: HTMLElement,
  siteKey: string,
  load: () => Promise<TurnstileApi> = loadTurnstile,
): TurnstileTokens {
  type Waiter = { resolve: (token: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  const waiters: Waiter[] = [];
  let ready: string | null = null;
  let removed = false;
  let widgetId: string | undefined;

  function settle(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    const index = waiters.indexOf(waiter);
    if (index >= 0) {
      waiters.splice(index, 1);
    }
  }

  function rejectAll(error: Error): void {
    for (const waiter of [...waiters]) {
      settle(waiter);
      waiter.reject(error);
    }
  }

  const api = load().then((turnstile) => {
    if (!removed) {
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        // Invisible unless Cloudflare wants the user to click something.
        appearance: "interaction-only",
        callback: (token) => {
          const waiter = waiters[0];
          if (!waiter) {
            ready = token;
            return;
          }
          settle(waiter);
          waiter.resolve(token);
          // Outside the callback: the widget is still delivering this token.
          queueMicrotask(() => {
            if (!removed) {
              turnstile.reset(widgetId);
            }
          });
        },
        // The widget renews an expired token by itself; the old one must not
        // be handed out meanwhile.
        "expired-callback": () => {
          ready = null;
        },
        // Turnstile retries by itself, but a request waiting now would wait out
        // the whole deadline for a retry that may never succeed (a key this
        // domain is not allowed to use fails every time). True tells the widget
        // the error was handled.
        "error-callback": (code) => {
          rejectAll(new Error(`Cloudflare Turnstile check failed (error ${code}).`));
          return true;
        },
        "timeout-callback": () => {
          rejectAll(new Error("The Cloudflare Turnstile check timed out before it was completed."));
        },
      });
    }
    return turnstile;
  });
  // A script that never loads fails whoever is waiting; next() rethrows it to
  // later callers through the same promise.
  api.catch((error) => rejectAll(error));

  async function next(): Promise<string> {
    const turnstile = await api;
    if (removed) {
      throw new Error("The Cloudflare Turnstile check was closed.");
    }
    if (ready !== null) {
      const token = ready;
      ready = null;
      turnstile.reset(widgetId);
      return token;
    }
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          settle(waiter);
          reject(new Error(`Cloudflare Turnstile did not issue a token within ${TURNSTILE_TOKEN_TIMEOUT_MS / 1000} s.`));
        }, TURNSTILE_TOKEN_TIMEOUT_MS),
      };
      waiters.push(waiter);
    });
  }

  function remove(): void {
    if (removed) {
      return;
    }
    removed = true;
    ready = null;
    rejectAll(new Error("The Cloudflare Turnstile check was closed."));
    api.then((turnstile) => {
      if (widgetId !== undefined) {
        turnstile.remove(widgetId);
      }
    }, () => {});
  }

  return { next, remove };
}
