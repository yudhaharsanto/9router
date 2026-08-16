import { SAML } from "@node-saml/node-saml";
import { getSettings } from "../db/repos/settingsRepo.js";
import { makeKv } from "../db/helpers/kvStore.js";

// Server-side record of issued AuthnRequest IDs. The IdP ACS callback is a
// cross-site POST, so SameSite=Lax cookies never arrive with it — the cookie
// check alone can't protect against replay. We store the requestId instead.
const samlRequestKv = makeKv("samlRequestIds");
const SAML_REQUEST_TTL_MS = 10 * 60 * 1000; // matches saml_state cookie maxAge

export async function registerSamlRequestId(requestId) {
  if (!requestId) return;
  await samlRequestKv.set(requestId, String(Date.now()));
}

// Returns true once, then deletes — a second validation with the same
// requestId (replay) fails.
export async function consumeSamlRequestId(requestId) {
  if (!requestId) return false;
  const created = Number(await samlRequestKv.get(requestId)) || 0;
  await samlRequestKv.remove(requestId);
  if (!created) return false;
  return Date.now() - created < SAML_REQUEST_TTL_MS;
}

/**
 * Formats a raw Base64 string or unformatted X.509 certificate into standard PEM format.
 * @param {string} certStr
 * @returns {string}
 */
export function formatX509Certificate(certStr) {
  if (!certStr || typeof certStr !== "string") return "";
  const clean = certStr
    .replace(/-----BEGIN CERTIFICATE-----/gi, "")
    .replace(/-----END CERTIFICATE-----/gi, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");

  if (!clean) return "";

  const lines = clean.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * Checks whether SAML configuration has essential parameters (entryPoint & cert).
 * @param {object} settings
 * @returns {boolean}
 */
export function isSamlConfigured(settings) {
  const mode = settings?.authMode;
  const samlEnabled = mode === "saml" || mode === "sso" || mode === "both";
  return Boolean(samlEnabled && settings?.samlEntryPoint && settings?.samlCert);
}

/**
 * Fetches settings and returns runtime status + settings.
 * @returns {Promise<{ configured: boolean, settings: object }>}
 */
export async function getSamlRuntimeConfig() {
  const settings = await getSettings();
  return {
    configured: isSamlConfigured(settings),
    settings,
  };
}

/**
 * Creates a configured `@node-saml/node-saml` SAML instance with security defaults.
 * @param {object} settings
 * @param {string} origin
 * @returns {SAML}
 */
const DUMMY_FALLBACK_CERT =
  "-----BEGIN CERTIFICATE-----\nMIIC...DUMMY...\n-----END CERTIFICATE-----";

function trimTrailingSlashes(str) {
  return (str || "").replace(/\/+$/, "");
}

// Only trust forwarding headers when the TCP peer is a local reverse proxy
// (same rule as loginLimiter TRUST_PROXY). Otherwise a client-supplied
// Host/x-forwarded-host would redirect post-login to an attacker's origin.
function isTrustedRequestHost(host) {
  if (!host) return false;
  const hostname = (
    host.startsWith("[") ? host.slice(1).split("]")[0] : host.split(":")[0]
  ).toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    process.env.TRUST_PROXY === "true"
  );
}

/**
 * Resolves the public Base URL / Origin for SAML requests.
 * Respects settings.baseUrl, process.env.BASE_URL, x-forwarded-proto, and x-forwarded-host.
 * @param {Request} request
 * @param {object} settings
 * @returns {string}
 */
export function getSamlBaseUrl(request, settings) {
  const configuredBaseUrl =
    (settings?.baseUrl || "").trim() ||
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "";

  if (configuredBaseUrl) {
    return trimTrailingSlashes(configuredBaseUrl);
  }

  if (request) {
    const forwardedProto = request?.headers?.get?.("x-forwarded-proto") || "";
    const forwardedHost = request?.headers?.get?.("x-forwarded-host") || "";
    const host = forwardedHost || request?.headers?.get?.("host") || "";
    if (host && isTrustedRequestHost(host)) {
      const protocol = (
        forwardedProto ||
        new URL(request.url).protocol ||
        "http:"
      ).replace(/:$/, "");
      return `${protocol}://${host}`.replace(/\/+$/, "");
    }
    if (request.url && isTrustedRequestHost(new URL(request.url).host)) {
      return trimTrailingSlashes(new URL(request.url).origin);
    }
  }

  return "http://localhost:20128";
}

export function createSamlInstance(settings, origin) {
  const cert =
    formatX509Certificate(settings?.samlCert || "") || DUMMY_FALLBACK_CERT;
  const callbackUrl = `${origin}/api/auth/saml/acs`;
  return new SAML({
    entryPoint: settings?.samlEntryPoint || "https://example.com/sso",
    issuer: settings?.samlIssuer || "urn:9router:sp",
    idpCert: cert,
    cert: cert,
    callbackUrl: callbackUrl,
    acceptedClockSkewMs: 60000,
    wantAssertionsSigned: true,
    validateInResponseTo: "never",
    requestIdExpirationMs: 28800000, // 8 hours
  });
}

/**
 * Builds SAML AuthnRequest redirect URL and returns { authorizeUrl, requestId }.
 * @param {Request} request
 * @param {object} settings
 * @returns {Promise<{ authorizeUrl: string, requestId: string }>}
 */
export async function buildSamlAuthorizeUrl(request, settings) {
  const origin = getSamlBaseUrl(request, settings);
  const samlInstance = createSamlInstance(settings, origin);

  const xml = await samlInstance.generateAuthorizeRequestAsync(false, false);
  const match = xml.match(/ID="([^"]+)"/);
  const requestId = match ? match[1] : "";

  await registerSamlRequestId(requestId);

  const authorizeUrl = await samlInstance._requestToUrlAsync(
    xml,
    null,
    "authorize",
    {},
  );

  return { authorizeUrl, requestId };
}

/**
 * Validates SAML POST response from IdP ACS callback and returns user profile.
 * @param {Request} request
 * @param {object} body - Parsed form body or object containing SAMLResponse
 * @param {string} expectedRequestId - Request ID stored in saml_state cookie
 * @param {object} settings
 * @returns {Promise<object>}
 */
export async function validateSamlResponse(
  request,
  body,
  expectedRequestId,
  settings,
) {
  if (!settings?.samlCert) {
    throw new Error(
      "IdP X.509 Certificate (samlCert) is missing or not configured",
    );
  }

  const origin = getSamlBaseUrl(request, settings);
  const samlInstance = createSamlInstance(settings, origin);

  const container =
    typeof body === "object" && body !== null ? body : { SAMLResponse: body };
  const rawSamlResponse = container.SAMLResponse;

  if (!rawSamlResponse) {
    throw new Error("Missing SAMLResponse parameter in assertion POST body");
  }

  // Replay protection: the response's InResponseTo must match a requestId
  // issued by /api/auth/saml/start (stored server-side, consumed once).
  const xml = Buffer.from(rawSamlResponse, "base64").toString("utf8");
  const inResponseTo =
    (xml.match(/InResponseTo=["']([^"']+)["']/i) || [])[1] || null;

  if (!inResponseTo) {
    throw new Error("SAML assertion missing InResponseTo (replay protection)");
  }
  if (!(await consumeSamlRequestId(inResponseTo))) {
    throw new Error(
      "InResponseTo does not match any issued request (possible replay)",
    );
  }
  if (expectedRequestId && inResponseTo !== expectedRequestId) {
    throw new Error(
      `InResponseTo mismatch: expected ${expectedRequestId}, received ${inResponseTo}`,
    );
  }

  const result = await samlInstance.validatePostResponseAsync({
    SAMLResponse: rawSamlResponse,
  });
  const profile = result?.profile || result;

  return profile;
}

/**
 * Generates standard SP XML Metadata.
 * @param {string} origin
 * @param {object} settings
 * @returns {string}
 */
export function generateSamlMetadata(origin, settings) {
  const samlInstance = createSamlInstance(settings, origin);
  return samlInstance.generateServiceProviderMetadata();
}

/**
 * Extracts email claim from SAML profile assertion.
 * @param {object} profile
 * @param {object} settings
 * @returns {string}
 */
export function pickSamlEmail(profile = {}, settings = {}) {
  if (!profile) return "";

  // 1. Configured custom attribute
  const customAttr = settings.samlAttributeEmail;
  if (customAttr && profile[customAttr]) {
    const val = profile[customAttr];
    return Array.isArray(val) ? val[0] : String(val);
  }

  // 2. Common email claims
  const emailKeys = [
    "email",
    "emailAddress",
    "mail",
    "nameID",
    "nameId",
    "upn",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  ];

  for (const key of emailKeys) {
    if (profile[key]) {
      const val = profile[key];
      return Array.isArray(val) ? val[0] : String(val);
    }
  }

  // 3. Fallback: check attributes object if present
  if (profile.attributes) {
    for (const key of emailKeys) {
      if (profile.attributes[key]) {
        const val = profile.attributes[key];
        return Array.isArray(val) ? val[0] : String(val);
      }
    }
  }

  return "";
}

/**
 * Extracts display name claim from SAML profile assertion.
 * @param {object} profile
 * @param {object} settings
 * @returns {string}
 */
export function pickSamlDisplayName(profile = {}, settings = {}) {
  if (!profile) return "";

  // 1. Configured custom attribute
  const customAttr = settings.samlAttributeName;
  if (customAttr && profile[customAttr]) {
    const val = profile[customAttr];
    return Array.isArray(val) ? val[0] : String(val);
  }

  // 2. Common name claims
  const nameKeys = [
    "displayName",
    "name",
    "cn",
    "commonName",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  ];

  for (const key of nameKeys) {
    if (profile[key]) {
      const val = profile[key];
      return Array.isArray(val) ? val[0] : String(val);
    }
  }

  // 3. Combined givenName + surname
  if (profile.givenName || profile.sn || profile.surname) {
    const given = profile.givenName || "";
    const surname = profile.sn || profile.surname || "";
    const combined = `${given} ${surname}`.trim();
    if (combined) return combined;
  }

  // 4. Fallback to email
  return pickSamlEmail(profile, settings);
}
