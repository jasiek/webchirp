// The Android app (com.hf2j.webchirp): a Trusted Web Activity, published on
// Google Play, that opens this site full-screen in Chrome. Nothing on the page
// can ask Chrome whether it is running inside one, so the app says so in the
// URL it opens: its launcher icon opens the site with ANDROID_APP_LAUNCH_PARAMS
// (the startUrl in the app's Bubblewrap twa-manifest.json), and every URL the
// app opens, a webchirp.org link included, carries ANDROID_APP_LAUNCH_FLAG.
// The page remembers that for the rest of the tab's session, because a reload
// or a trip to about.html and back arrives without either.

// The query the app's launcher opens the site with. UTM parameters, as the web
// manifest's start_url uses for home-screen installs, so analytics attributes
// the app's sessions to it without any code of its own.
export const ANDROID_APP_LAUNCH_PARAMS: Readonly<Record<string, string>> = {
  utm_source: "android_app",
  utm_medium: "twa",
};

// The parameter the app's launcher adds to every URL it opens: Bubblewrap's
// firstRunFlag feature, "true" on the app's first open and "false" after. A
// webchirp.org link the app opens keeps its own query, without the UTM pair
// above, so this is what marks it.
export const ANDROID_APP_LAUNCH_FLAG = "android_app_first_open";

// The sessionStorage key that carries an app launch past the first page.
const SESSION_KEY = "webchirp-android-app";

// Whether a URL is one the app opened: it carries the launcher's flag, or
// every parameter of the launch query. All of them, so a link that happens to
// reuse one UTM value does not count as the app.
export function isAndroidAppLaunch(search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.has(ANDROID_APP_LAUNCH_FLAG)) {
    return true;
  }
  return Object.entries(ANDROID_APP_LAUNCH_PARAMS).every(([key, value]) => params.get(key) === value);
}

// Whether this page is running inside the Android app: launched by it now, or
// earlier in this tab's session. sessionStorage throws where site data is
// blocked; that only loses the memory, and the launch page itself still counts.
export function runsInAndroidApp(win: Window | null | undefined): boolean {
  if (isAndroidAppLaunch(win?.location?.search ?? "")) {
    try {
      win?.sessionStorage?.setItem(SESSION_KEY, "1");
    } catch {
      /* ignored */
    }
    return true;
  }
  try {
    return win?.sessionStorage?.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}
