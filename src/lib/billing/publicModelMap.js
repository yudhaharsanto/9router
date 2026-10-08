// Public model ↔ combo mapping (spec §3.6): customers address combos by a
// public name; combo IDs and provider names never leave the server.
import { getComboById } from "@/lib/db/repos/combosRepo.js";
import { getPublicModelByName, listPublicModels } from "@/lib/db/repos/publicModelsRepo.js";

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
