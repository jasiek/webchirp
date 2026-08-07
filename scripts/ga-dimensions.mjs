// Sync the GA4 property's custom dimensions with the declarations in
// web/js/analytics.js, via the Google Analytics Admin API v1beta.
//
// GA4 reports only show event parameters that have been registered as custom
// dimensions, registration is not retroactive, and the console is the only
// place most people ever do it — so the property drifts from the code silently.
// This makes the code the source of truth: `npm run ga:dimensions` prints the
// diff, `-- --apply` closes it.
//
// Deliberately dependency-free. The official @google-analytics/admin client
// pulls in gRPC and a large tree for what is four REST calls, and this repo
// ships two runtime dependencies.
//
// The Admin API takes no API key — it is OAuth only. Auth, first match wins:
//   GA_ACCESS_TOKEN                 an OAuth token you already have
//   GOOGLE_APPLICATION_CREDENTIALS  path to a service-account key JSON
//   application-default credentials from `gcloud auth application-default
//     login --scopes=<SCOPE below>`
// The identity needs Editor (or Administrator) on the GA property, granted in
// GA Admin > Property access management — Cloud IAM roles do not grant it.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { CUSTOM_DIMENSIONS, MEASUREMENT_ID } from "../web/js/analytics.js";

const execFileAsync = promisify(execFile);

const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/analytics.edit";

// Documented GA4 limits for a standard property. Archived dimensions release
// their slot, which is why archiving exists and deletion does not.
const SCOPE_LIMITS = { EVENT: 50, USER: 25, ITEM: 10 };
const NAME_LIMITS = { EVENT: 40, USER: 24, ITEM: 40 };
const RESERVED_PREFIXES = ["ga_", "google_", "firebase_"];

// ---------------------------------------------------------------------------
// Pure logic — everything below main() is I/O, everything here is testable.
// ---------------------------------------------------------------------------

export function validateDeclarations(declarations) {
  const errors = [];
  const seen = new Set();

  for (const dimension of declarations) {
    const { parameterName, displayName, description = "", scope } = dimension;
    const label = parameterName || "(unnamed)";

    if (!SCOPE_LIMITS[scope]) {
      errors.push(`${label}: scope must be one of ${Object.keys(SCOPE_LIMITS).join(", ")}`);
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(parameterName || "")) {
      errors.push(`${label}: parameter name must start with a letter and be alphanumeric or underscores`);
    }
    const nameLimit = NAME_LIMITS[scope] || NAME_LIMITS.EVENT;
    if ((parameterName || "").length > nameLimit) {
      errors.push(`${label}: parameter name exceeds ${nameLimit} characters for ${scope} scope`);
    }
    for (const prefix of RESERVED_PREFIXES) {
      if ((parameterName || "").toLowerCase().startsWith(prefix)) {
        errors.push(`${label}: "${prefix}" is a reserved parameter prefix`);
      }
    }
    if (!displayName) {
      errors.push(`${label}: display name is required`);
    } else if (!/^[A-Za-z0-9_ ]+$/.test(displayName)) {
      // The API rejects anything else — punctuation, parentheses, dashes.
      errors.push(`${label}: display name must only contain letters, digits, underscores or spaces`);
    }
    if ((displayName || "").length > 82) {
      errors.push(`${label}: display name exceeds 82 characters`);
    }
    if (description.length > 150) {
      errors.push(`${label}: description exceeds 150 characters`);
    }
    // GA keys a dimension by parameter name and scope together, so the same
    // parameter can legitimately exist at two scopes.
    const key = `${scope}:${parameterName}`;
    if (seen.has(key)) {
      errors.push(`${label}: declared twice at ${scope} scope`);
    }
    seen.add(key);
  }

  for (const [scope, limit] of Object.entries(SCOPE_LIMITS)) {
    const count = declarations.filter((dimension) => dimension.scope === scope).length;
    if (count > limit) {
      errors.push(`${count} ${scope}-scoped dimensions declared, but a property allows ${limit}`);
    }
  }

  return errors;
}

// Diff declarations against what the property already has. Never decides to
// archive on its own: extras are reported and the caller opts in.
export function planSync(declarations, existing) {
  const byKey = new Map(existing.map((dimension) => [`${dimension.scope}:${dimension.parameterName}`, dimension]));
  const plan = { create: [], update: [], unchanged: [], conflicts: [], extra: [] };

  for (const declared of declarations) {
    const current = byKey.get(`${declared.scope}:${declared.parameterName}`);
    if (!current) {
      // A same-name dimension at another scope blocks creation: GA rejects a
      // duplicate parameter name across scopes even though it keys by both.
      const clash = existing.find((dimension) => dimension.parameterName === declared.parameterName);
      if (clash) {
        plan.conflicts.push({
          declared,
          current: clash,
          reason: `already exists with ${clash.scope} scope; scope is immutable, so this needs archiving and recreating by hand`,
        });
        continue;
      }
      plan.create.push(declared);
      continue;
    }

    const changes = {};
    if (current.displayName !== declared.displayName) {
      changes.displayName = declared.displayName;
    }
    if ((current.description || "") !== (declared.description || "")) {
      changes.description = declared.description || "";
    }
    if (Object.keys(changes).length === 0) {
      plan.unchanged.push(current);
    } else {
      plan.update.push({ name: current.name, declared, current, changes });
    }
  }

  const declaredKeys = new Set(declarations.map((dimension) => `${dimension.scope}:${dimension.parameterName}`));
  for (const dimension of existing) {
    if (!declaredKeys.has(`${dimension.scope}:${dimension.parameterName}`)) {
      plan.extra.push(dimension);
    }
  }

  return plan;
}

export function parseArgs(argv) {
  const options = { property: process.env.GA_PROPERTY_ID || "", apply: false, archiveExtra: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--archive-extra") {
      options.archiveExtra = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--property") {
      options.property = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--property=")) {
      options.property = arg.slice("--property=".length);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  // Accept "properties/123", "123" or a console URL fragment.
  options.property = String(options.property).replace(/^properties\//, "").trim();
  return options;
}

// ---------------------------------------------------------------------------
// Auth and API
// ---------------------------------------------------------------------------

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

// Self-signed JWT bearer flow (RFC 7523), which is all a service account needs
// to mint an access token — no client library required.
async function tokenFromServiceAccount(keyPath) {
  const key = JSON.parse(await readFile(keyPath, "utf8"));
  if (!key.client_email || !key.private_key) {
    throw new Error(`${keyPath} is not a service-account key (no client_email/private_key)`);
  }
  const issued = Math.floor(Date.now() / 1000);
  const claims = {
    iss: key.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: issued,
    exp: issued + 3600,
  };
  const input = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(key.private_key).toString("base64url");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${input}.${signature}`,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${body.error_description || body.error || response.status}`);
  }
  return body.access_token;
}

async function accessToken() {
  if (process.env.GA_ACCESS_TOKEN) {
    return process.env.GA_ACCESS_TOKEN;
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return tokenFromServiceAccount(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }
  try {
    // Deliberately the application-default token, not `gcloud auth
    // print-access-token`: the latter is gcloud's own credential and carries
    // only cloud-platform scope, which the Admin API rejects. ADC honours
    // whatever --scopes the login asked for.
    const { stdout } = await execFileAsync("gcloud", ["auth", "application-default", "print-access-token"]);
    return stdout.trim();
  } catch {
    throw new Error(
      "No credentials. Set GA_ACCESS_TOKEN, or GOOGLE_APPLICATION_CREDENTIALS to a service-account key, "
        + `or run: gcloud auth application-default login --scopes=${SCOPE}`,
    );
  }
}

async function api(token, path, { method = "GET", body, query } = {}) {
  const url = new URL(`${ADMIN_API}/${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = parsed.error?.message || response.statusText;
    throw new Error(`${method} ${path} failed (${response.status}): ${message}`);
  }
  return parsed;
}

async function listAll(token, path, key, query = {}) {
  const items = [];
  let pageToken;
  do {
    const page = await api(token, path, { query: { pageSize: "200", ...query, ...(pageToken ? { pageToken } : {}) } });
    items.push(...(page[key] || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

// Find the property whose web data stream carries our measurement id, so the
// script needs no configuration beyond credentials.
async function resolveProperty(token) {
  const summaries = await listAll(token, "accountSummaries", "accountSummaries");
  const properties = summaries.flatMap((summary) => summary.propertySummaries || []);
  if (properties.length === 0) {
    throw new Error("The authenticated identity can see no GA4 properties.");
  }
  for (const summary of properties) {
    const streams = await listAll(token, `${summary.property}/dataStreams`, "dataStreams");
    const match = streams.find((stream) => stream.webStreamData?.measurementId === MEASUREMENT_ID);
    if (match) {
      const id = summary.property.replace(/^properties\//, "");
      console.log(`Resolved ${MEASUREMENT_ID} to property ${id} (${summary.displayName})`);
      return id;
    }
  }
  throw new Error(
    `No visible property has a web stream for ${MEASUREMENT_ID}. Pass --property <id> if the identity `
      + "only has access to the property and not its account summary.",
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: npm run ga:dimensions [-- <options>]

Syncs the GA4 property's custom dimensions with CUSTOM_DIMENSIONS in
web/js/analytics.js. Prints the diff and changes nothing unless --apply.

  --property <id>   Numeric GA4 property id (default: $GA_PROPERTY_ID, else
                    resolved from the measurement id in analytics.js)
  --apply           Create and update dimensions on the property
  --archive-extra   Also archive dimensions the app no longer declares
  --json            Emit the plan as JSON instead of prose
`;

function describe(plan) {
  const lines = [];
  for (const dimension of plan.create) {
    lines.push(`  create   ${dimension.parameterName} (${dimension.scope}) — "${dimension.displayName}"`);
  }
  for (const entry of plan.update) {
    const fields = Object.keys(entry.changes).join(", ");
    lines.push(`  update   ${entry.declared.parameterName} (${fields})`);
  }
  for (const entry of plan.conflicts) {
    lines.push(`  CONFLICT ${entry.declared.parameterName} — ${entry.reason}`);
  }
  for (const dimension of plan.extra) {
    lines.push(`  extra    ${dimension.parameterName} (${dimension.scope}) — on the property, not declared here`);
  }
  if (plan.unchanged.length > 0) {
    lines.push(`  ${plan.unchanged.length} already in sync`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const errors = validateDeclarations(CUSTOM_DIMENSIONS);
  if (errors.length > 0) {
    throw new Error(`CUSTOM_DIMENSIONS is invalid:\n  ${errors.join("\n  ")}`);
  }

  const token = await accessToken();
  const propertyId = options.property || (await resolveProperty(token));
  const property = `properties/${propertyId}`;

  const existing = await listAll(token, `${property}/customDimensions`, "customDimensions");
  const plan = planSync(CUSTOM_DIMENSIONS, existing);

  if (options.json) {
    console.log(JSON.stringify({ property, ...plan }, null, 2));
  } else {
    console.log(`${property}: ${existing.length} custom dimensions defined`);
    console.log(describe(plan) || "  nothing to do");
  }

  const archiving = options.archiveExtra ? plan.extra : [];
  const pending = plan.create.length + plan.update.length + archiving.length;
  if (!options.apply) {
    if (pending > 0) {
      console.log(`\nDry run. Re-run with --apply to make ${pending} change(s).`);
    }
    // Conflicts need a human either way, so surface them as a failure.
    if (plan.conflicts.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  for (const dimension of plan.create) {
    await api(token, `${property}/customDimensions`, { method: "POST", body: dimension });
    console.log(`created ${dimension.parameterName}`);
  }
  for (const entry of plan.update) {
    await api(token, entry.name, {
      method: "PATCH",
      body: entry.changes,
      query: { updateMask: Object.keys(entry.changes).join(",") },
    });
    console.log(`updated ${entry.declared.parameterName}`);
  }
  for (const dimension of archiving) {
    // Archive, not delete — the API has no delete, and archiving keeps the
    // collected data while releasing the slot.
    await api(token, `${dimension.name}:archive`, { method: "POST", body: {} });
    console.log(`archived ${dimension.parameterName}`);
  }

  if (plan.extra.length > 0 && !options.archiveExtra) {
    console.log(`\n${plan.extra.length} undeclared dimension(s) left alone. Pass --archive-extra to archive them.`);
  }
  if (plan.conflicts.length > 0) {
    process.exitCode = 1;
  }
}

// Only run when invoked directly, so the tests can import the pure helpers.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
