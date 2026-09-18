import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { normalizeMuseSparkResponsesBody } from "../translator/formats/responsesApi.js";

export const OPENCODE_DEFAULT_UA = "opencode/1.18.31";
const OPENCODE_UA = OPENCODE_DEFAULT_UA;
const MAX_SESSION_LENGTH = 256;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
// Canonical OpenCode id shapes: prefix + 12 hex + 14 Base62 (30 chars) — upstream
// rejects free-tier requests with malformed session/request ids (PR #4105).
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const OPENCODE_UA_RE = /opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i;
const BASE62_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let out = "";
  for (let i = 0; i < 14; i += 1) out += BASE62_CHARS[bytes[i] % 62];
  return out;
}

function timeHex(value) {
  return Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
}

let lastTimestamp = 0;
let counter = 0;

// Descending-timestamp canonical OpenCode session id (ses_ + 12 hex + 14 Base62).
export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter += 1;
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(counter));
  return `ses_${timeHex(value)}${unstableRandom()}`;
}

// Canonical OpenCode request id (msg_ + 12 hex + 14 Base62).
export function generateRequestId(timestamp = Date.now()) {
  const value = BigInt(timestamp) * 0x1000n + 1n;
  return `msg_${timeHex(value)}${unstableRandom()}`;
}

// Deterministically map foreign session ids to canonical 30-char form.
export function translateSessionId(sessionId, clientTool = "") {
  if (
    typeof sessionId === "string" &&
    OPENCODE_SESSION_RE.test(sessionId.trim())
  ) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  const timePart = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i += 1) randomPart += BASE62_CHARS[digest[i] % 62];
  return `ses_${timePart}${randomPart}`;
}

// Upstream requires User-Agent opencode >= 1.17.0 (PR #4105).
export function hasValidOpenCodeVersion(ua) {
  const m = OPENCODE_UA_RE.exec(String(ua || ""));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 1 || (major === 1 && minor >= 17);
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

// Only case-insensitive canonical native headers pass through unmodified.
function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

// Upstream free-tier gate (verified live against /zen/v1/{chat/completions,responses}
// with `Authorization: Bearer public`): requests must look like the official
// OpenCode agentic client even when UA/session shape are already valid.
// - stream must be true (stream:false → 403 FreeTierError);
// - tools must include the file-search quartet {bash, glob, grep, read}
//   (0–3 present → 403; extra tools are allowed).
const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  const fn =
    tool.function &&
    typeof tool.function === "object" &&
    !Array.isArray(tool.function)
      ? tool.function
      : null;
  const raw = typeof tool.name === "string" ? tool.name : fn?.name;
  return typeof raw === "string" ? raw.trim() : "";
}

// Merge the upstream-mandated quartet into the body, preserving caller tools
// verbatim. `flat` selects the Responses tool shape (name one level up) instead
// of the Chat Completions shape (nested under `function`).
function ensureFingerprintTools(body, flat) {
  if (!body || typeof body !== "object") return;
  const present = new Set();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const name = toolNameOf(tool);
      if (name) present.add(name);
    }
  } else {
    body.tools = [];
  }
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    const decl = {
      type: "function",
      name,
      description: `OpenCode built-in ${name} tool`,
      parameters: { type: "object", properties: {} },
    };
    body.tools.push(
      flat
        ? decl
        : {
            type: "function",
            function: {
              name,
              description: decl.description,
              parameters: decl.parameters,
            },
          },
    );
    present.add(name);
  }
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "")
    .replace(/\([^()]+\)\s*$/, "")
    .trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function resolveOpencodeSession(
  body,
  credentials,
  providerSessionId,
  clientTool,
) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;
  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }
  const resolved =
    incoming ||
    normalizeSession(providerSessionId) ||
    resolveSessionId({
      headers,
      body,
      connectionId: credentials?.connectionId,
      scope: "opencode",
      generate: generateSessionId,
    });
  return translateSessionId(resolved, clientTool);
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning =
    current && typeof current === "object" && !Array.isArray(current)
      ? current
      : null;
  const requestedEffort =
    typeof body.reasoning_effort === "string"
      ? body.reasoning_effort
      : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if (
    (effort === "max" || effort === "ultra") &&
    supportedLevels?.length &&
    !supportedLevels.includes(effort)
  ) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  prepareRequestCredentials({
    body,
    credentials,
    providerSessionId,
    clientTool,
  } = {}) {
    const sourceCredentials = credentials || {};
    const resolved = resolveOpencodeSession(
      body,
      sourceCredentials,
      providerSessionId,
      clientTool,
    );
    return {
      ...sourceCredentials,
      [SESSION_FIELD]: resolved,
    };
  }

  async execute(args) {
    return super.execute({
      ...args,
      credentials: this.prepareRequestCredentials(args),
    });
  }

  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object" && model && !body.model) {
      body.model = model;
    }
    if (body && typeof body === "object") {
      // Free-tier fingerprint: upstream rejects non-streaming requests outright.
      body.stream = true;
      ensureFingerprintTools(body, isResponsesModel(model));
    }
    if (isResponsesModel(model) && body && typeof body === "object") {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined)
          body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined)
          body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      normalizeMuseSparkResponsesBody(body, baseModelId(model));
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model)
      ? `${base}/zen/v1/responses`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpenCodeVersion(downstreamUa);
    const session =
      credentials?.[SESSION_FIELD] ||
      this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    return {
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": session,
      "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      Accept: stream ? "text/event-stream" : "*/*",
    };
  }
}
