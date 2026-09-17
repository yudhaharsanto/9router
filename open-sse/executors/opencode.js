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
// Canonical OpenCode id shapes: prefix + 12 hex + 14 Base62 (30 chars) — upstream
// rejects free-tier requests with malformed session/request ids (PR #4105).
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const OPENCODE_UA_RE = /opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

function base62(n) {
  let out = "";
  for (let i = 0; i < n; i += 1) out += BASE62[crypto.randomBytes(1)[0] % 62];
  return out;
}

// Descending-timestamp canonical id: hex(~nowMs*0x1000+counter) + random Base62.
function canonicalOpencodeId(prefix, counter) {
  const value = ~(Date.now() * 0x1000 + (counter & 0xfff));
  const timeBytes = Buffer.alloc(6);
  timeBytes.writeUIntBE(value >>> 0, 0, 6);
  return prefix + timeBytes.toString("hex") + base62(14);
}

let sessionCounter = 0;
function generateSessionId() {
  return canonicalOpencodeId("ses_", (sessionCounter += 1));
}

export function generateRequestId() {
  return canonicalOpencodeId("msg_", 1);
}

// Deterministically map foreign session ids to canonical 30-char form.
export function translateOpenCodeSessionId(sessionId, clientTool) {
  const trimmed = String(sessionId || "").trim();
  if (!trimmed) return "";
  if (OPENCODE_SESSION_RE.test(trimmed)) return trimmed;
  const tool = clientTool || "generic";
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${tool}\0${trimmed}`)
    .digest();
  let out = "ses_" + digest.subarray(0, 6).toString("hex");
  for (let i = 6; i < 20; i += 1) out += BASE62[digest[i] % 62];
  return out;
}

// Upstream requires User-Agent opencode >= 1.17.0 (PR #4105).
export function hasValidOpenCodeVersion(ua) {
  const m = OPENCODE_UA_RE.exec(String(ua || ""));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 1 || (major === 1 && minor >= 17);
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

function resolveOpencodeSession(body, credentials) {
  const headers = credentials?.rawHeaders || {};
  return resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
    generate: generateSessionId,
  });
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
    this._currentSessionId = null;
  }

  transformRequest(model, body, stream, credentials) {
    this._currentSessionId = resolveOpencodeSession(body, credentials);
    if (isResponsesModel(model)) {
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

    return {
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": translateOpenCodeSessionId(
        lower["x-opencode-session"] ||
          this._currentSessionId ||
          generateSessionId(),
        credentials?.clientTool,
      ),
      "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      Accept: stream ? "text/event-stream" : "*/*",
    };
  }
}
