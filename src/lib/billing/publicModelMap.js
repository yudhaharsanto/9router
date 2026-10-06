// Public model ↔ combo mapping (spec §3.6): customers address combos by a
// public name; combo IDs and provider names never leave the server.
import { getComboById } from "@/lib/db/repos/combosRepo.js";
import { getPublicModelByName, listPublicModels } from "@/lib/db/repos/publicModelsRepo.js";
import { listPackages } from "@/lib/db/repos/packagesRepo.js";

// Resolve a client-supplied model string to a public model's combo members.
// Provider/model strings ("claude/x") are never public names → null.
export async function resolvePublicModelRequest(modelStr) {
  if (!modelStr || typeof modelStr !== "string" || modelStr.includes("/")) return null;
  const pub = await getPublicModelByName(modelStr);
  if (!pub || !pub.enabled) return null;
  const combo = await getComboById(pub.comboId);
  if (!combo || !Array.isArray(combo.models) || combo.models.length === 0) return null;
  return { models: combo.models, comboId: pub.comboId, publicName: pub.publicName };
}

// Token-package model names: a package's models[] are customer-facing names
// that route through the package's own combo. Checked when no public model
// matches; public models keep precedence. Returns the same shape as
// resolvePublicModelRequest, plus packageId for the billing gate.
export async function resolvePackageModel(modelStr) {
  if (!modelStr || typeof modelStr !== "string" || modelStr.includes("/")) return null;
  for (const pkg of await listPackages({ activeOnly: true })) {
    let models = [];
    try { models = JSON.parse(pkg.models) || []; } catch { models = []; }
    if (models.includes("*") || !models.includes(modelStr) || !pkg.comboId) continue;
    const combo = await getComboById(pkg.comboId);
    if (!combo || !Array.isArray(combo.models) || combo.models.length === 0) continue;
    return { models: combo.models, comboId: pkg.comboId, publicName: modelStr, packageId: pkg.id };
  }
  return null;
}

// Reverse map for the customer portal: an upstream model name (combo member,
// e.g. "combo/glm-flash") → the enabled public name exposing it. Unlike
// resolvePublicModelRequest this must accept "/" — usage rows store upstream
// names. First enabled public model wins (a model exposed by two public names
// is a config smell; portal shows one row either way).
export async function resolvePublicModelName(upstreamModel) {
  if (!upstreamModel || typeof upstreamModel !== "string") return null;
  const models = await listPublicModels({ enabledOnly: true });
  for (const m of models) {
    const combo = await getComboById(m.comboId);
    for (const member of combo?.models || []) {
      // Members are provider-prefixed ("ih/combo/glm-flash"); usage rows store
      // the bare model ("combo/glm-flash"). Compare both forms.
      if (member === upstreamModel || member.slice(member.indexOf("/") + 1) === upstreamModel) {
        return m.publicName;
      }
    }
  }
  // Package model names: a combo reachable only through a token package maps
  // to the package's customer-facing model name, so portal usage rows show
  // the name the customer actually called.
  for (const pkg of await listPackages({ activeOnly: true })) {
    if (!pkg.comboId) continue;
    let covered = [];
    try { covered = JSON.parse(pkg.models) || []; } catch { covered = []; }
    if (covered.includes("*")) continue;
    const combo = await getComboById(pkg.comboId);
    for (const member of combo?.models || []) {
      if (member === upstreamModel || member.slice(member.indexOf("/") + 1) === upstreamModel) {
        return covered.find((c) => c !== "*") || null;
      }
    }
  }
  return null;
}

// [OI]-format catalog limited to enabled public models. Only publicName is
// ever serialized — comboId stays server-side.
export async function customerModelsList() {
  const models = await listPublicModels({ enabledOnly: true });
  return models.map((m) => ({
    id: m.publicName,
    object: "model",
    created: Math.floor(new Date(m.createdAt || Date.now()).getTime() / 1000),
    owned_by: "9router",
  }));
}
