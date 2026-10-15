// The analytics consent banner: the one place a visitor says yes or no to
// Google Analytics. web/js/analytics.ts owns the choice -- storing it, and
// loading or stopping the vendor tag -- and calls in here only to show and
// hide the question, so this module builds DOM and nothing else.
//
// It is built here rather than written into each page's markup because every
// page that loads analytics needs it -- index.html and about.html, and the
// generated radio and licensing pages too -- and one builder cannot drift
// between them. It is shown only past the production-host gate, so dev
// servers, forks and the screenshot run never see it.
//
// What the rules ask of it (Google Play's User Data policy, ePrivacy/PECR):
// Accept and Decline look the same and neither is focused or pre-selected,
// and the banner leaves only through one of them -- no timeout, no close
// button, no dismissal on scroll -- so no choice is ever inferred.

/** What the visitor answered: "granted" to Accept, "denied" to Decline. */
export type ConsentChoice = "granted" | "denied";

// The id of the banner while it is on the page.
export const CONSENT_BANNER_ID = "analytics-consent";

// The page controls that reopen the banner ("Cookie settings" in each page's
// footer). Markup carries them hidden; analytics.ts reveals them on the
// production host, the only place there is a choice to change.
export const CONSENT_SETTINGS_SELECTOR = "[data-analytics-consent-settings]";

// Root-relative rather than "./": the banner also shows on the generated
// pages under radios/ and licensing/, where "./" names the wrong directory.
// Root is always right, because the banner only ever shows on the production
// hosts, which serve the site at the root.
export const PRIVACY_POLICY_HREF = "/privacy.html";

// The buttons in the order they appear, Decline first so the refusal is never
// the one a visitor has to look for.
const CHOICES: readonly (readonly [ConsentChoice, string])[] = [
  ["denied", "Decline"],
  ["granted", "Accept"],
];

// Remove the banner, if it is showing.
export function hideConsentBanner(doc: Document | null | undefined): void {
  if (typeof doc?.getElementById === "function") {
    doc.getElementById(CONSENT_BANNER_ID)?.remove();
  }
}

// Show the banner, replacing one already showing, and call onChoice with the
// visitor's answer. current is the choice already made, when the banner was
// reopened from Cookie settings, so the text can say what is in force; it
// selects nothing. Returns the banner, or null on a document without a body.
export function showConsentBanner(
  doc: Document | null | undefined,
  current: ConsentChoice | null,
  onChoice: (choice: ConsentChoice) => void,
): HTMLElement | null {
  if (!doc?.body || typeof doc.createElement !== "function") {
    return null;
  }
  hideConsentBanner(doc);
  const banner = doc.createElement("section");
  banner.id = CONSENT_BANNER_ID;
  banner.className = "consent-banner";
  banner.setAttribute("aria-label", "Analytics consent");

  const text = doc.createElement("p");
  text.className = "consent-banner-text";
  text.append(
    "May WebCHIRP use Google Analytics cookies to count which radios and features get used? "
    + "Nothing is sent to Google Analytics unless you accept. ",
  );
  if (current) {
    text.append(`Right now you ${current === "granted" ? "accept" : "decline"}. `);
  }
  const link = doc.createElement("a");
  link.href = PRIVACY_POLICY_HREF;
  // A new tab, so reading the policy never navigates away from unsaved
  // channel edits in the app.
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Privacy policy";
  text.append(link);

  const actions = doc.createElement("div");
  actions.className = "consent-banner-actions";
  for (const [choice, label] of CHOICES) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "consent-banner-button";
    button.dataset.consent = choice;
    button.textContent = label;
    button.addEventListener("click", () => onChoice(choice));
    actions.append(button);
  }

  banner.append(text, actions);
  doc.body.append(banner);
  return banner;
}
