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

export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
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
  "before-interactive-callback"?: () => void;
  "after-interactive-callback"?: () => void;
}

/**
 * Where the widget stands, for a control that has to wait on it:
 *   checking:    the script is loading or a challenge is running.
 *   interactive: Cloudflare is asking the user to tick its box.
 *   ready:       a token is held for the next request.
 *   expired:     a held token ran out unused; the widget renews it by itself.
 *   timed-out:   the box went unticked too long; the widget starts over.
 *   failed:      the widget reported Cloudflare's error code; it retries.
 *   unavailable: the script could not be loaded at all.
 */
export type TurnstileState =
  | { kind: "checking" | "interactive" | "ready" | "expired" | "timed-out" | "unavailable" }
  | { kind: "failed"; code: string };

/** One widget, handing out a distinct token per request. */
export interface TurnstileTokens {
  /** Resolves with a token no earlier caller was given. */
  next(): Promise<string>;
  /** Removes the widget; pending and later next() calls reject. */
  remove(): void;
  /** Where the widget stands now. */
  state(): TurnstileState;
  /** Whether a next() call is still waiting for its token. */
  waiting(): boolean;
  /** Calls listener after every change to state() or waiting(); returns its unsubscribe. */
  subscribe(listener: () => void): () => void;
}

// Why a request would have to wait for the widget, as one sentence for the
// control it holds back, or "" when a token is waiting for it. One wording for
// the Query API button and the map caption alike.
export function turnstileWaitReason(state: TurnstileState): string {
  switch (state.kind) {
    case "ready":
      return "";
    case "checking":
      return "Checking you're not a bot...";
    case "interactive":
      return "Tick “Verify you are human” below to continue.";
    case "expired":
      return "The bot check expired; checking again...";
    case "timed-out":
      return "The bot check timed out; checking again...";
    case "failed":
      return `The bot check failed (Cloudflare error ${state.code}); retrying...`;
    case "unavailable":
      return "The bot check could not load; a content blocker may be stopping challenges.cloudflare.com.";
  }
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
// request usually finds one waiting. state() and subscribe() are for the
// control that would send one: it can say why it is waiting before it is used.
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
  // What the widget last reported, other than a token: state() reads "ready"
  // whenever one is held, whatever came before it.
  let widgetState: TurnstileState = { kind: "checking" };
  const listeners = new Set<() => void>();

  function changed(): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function report(next: TurnstileState): void {
    widgetState = next;
    changed();
  }

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
            changed();
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
          report({ kind: "checking" });
        },
        // The widget renews an expired token by itself; the old one must not
        // be handed out meanwhile.
        "expired-callback": () => {
          ready = null;
          report({ kind: "expired" });
        },
        // Turnstile retries by itself, but a request waiting now would wait out
        // the whole deadline for a retry that may never succeed (a key this
        // domain is not allowed to use fails every time). True tells the widget
        // the error was handled.
        "error-callback": (code) => {
          rejectAll(new Error(`Cloudflare Turnstile check failed (error ${code}).`));
          report({ kind: "failed", code: String(code) });
          return true;
        },
        "timeout-callback": () => {
          rejectAll(new Error("The Cloudflare Turnstile check timed out before it was completed."));
          report({ kind: "timed-out" });
        },
        // The box appears only now: until this the check runs unseen, and
        // after it a ticked box still has the challenge to finish.
        "before-interactive-callback": () => {
          report({ kind: "interactive" });
        },
        "after-interactive-callback": () => {
          report({ kind: "checking" });
        },
      });
    }
    return turnstile;
  });
  // A script that never loads fails whoever is waiting.
  api.catch((error) => {
    rejectAll(error);
    report({ kind: "unavailable" });
  });

  // Hand a token issued before anyone asked to the first request waiting.
  function handOutReady(turnstile: TurnstileApi): void {
    const waiter = waiters[0];
    if (ready === null || !waiter) {
      return;
    }
    const token = ready;
    ready = null;
    settle(waiter);
    waiter.resolve(token);
    turnstile.reset(widgetId);
    report({ kind: "checking" });
  }

  // The request is registered, and its deadline started, before the script is
  // awaited: a script request that stalls without loading or failing must
  // still end at the deadline, and remove() must still be able to end it.
  function next(): Promise<string> {
    if (removed) {
      return Promise.reject(new Error("The Cloudflare Turnstile check was closed."));
    }
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          settle(waiter);
          reject(new Error(`Cloudflare Turnstile did not issue a token within ${TURNSTILE_TOKEN_TIMEOUT_MS / 1000} s.`));
          changed();
        }, TURNSTILE_TOKEN_TIMEOUT_MS),
      };
      waiters.push(waiter);
      changed();
      api.then(handOutReady, (error) => {
        settle(waiter);
        reject(error);
      });
    });
  }

  function remove(): void {
    if (removed) {
      return;
    }
    removed = true;
    ready = null;
    listeners.clear();
    rejectAll(new Error("The Cloudflare Turnstile check was closed."));
    api.then((turnstile) => {
      if (widgetId !== undefined) {
        turnstile.remove(widgetId);
      }
    }, () => {});
  }

  return {
    next,
    remove,
    state: () => (ready !== null ? { kind: "ready" } : widgetState),
    waiting: () => waiters.length > 0,
    subscribe(listener) {
      if (!removed) {
        listeners.add(listener);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
