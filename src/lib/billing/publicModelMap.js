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
