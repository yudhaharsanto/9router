// Phase 6: public model ↔ combo mapping + response masking (spec §3.6).
// Customers see only public model names; combo IDs and provider names never
// leave the server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pub-model-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function seedPublicModel(publicName, comboName) {
  const combos = await import("@/lib/db/repos/combosRepo.js");
  const pub = await import("@/lib/db/repos/publicModelsRepo.js");
  const combo = await combos.createCombo({
    name: comboName,
    models: ["claude/gate-test-model", "openai/gpt-test"],
    strategy: "fallback",
  });
  const row = await pub.upsertPublicModel({ publicName, comboId: combo.id, enabled: true });
  return { combo, row };
}

describe("publicModelMap", () => {
  it("resolvePublicModelRequest: public name → combo models + publicName", async () => {
    await seedPublicModel("glm-5.3-flash", "internal-combo-a");
    const { resolvePublicModelRequest } = await import("@/lib/billing/publicModelMap.js");
    const resolved = await resolvePublicModelRequest("glm-5.3-flash");
    expect(resolved).toBeTruthy();
    expect(resolved.models).toEqual(["claude/gate-test-model", "openai/gpt-test"]);
    expect(resolved.publicName).toBe("glm-5.3-flash");
  });

  it("resolvePublicModelRequest: disabled or unknown → null", async () => {
    const { combo, row } = await seedPublicModel("masked-model", "internal-combo-b");
    const pub = await import("@/lib/db/repos/publicModelsRepo.js");
    await pub.upsertPublicModel({ publicName: "masked-model", comboId: combo.id, enabled: false });
    const { resolvePublicModelRequest } = await import("@/lib/billing/publicModelMap.js");
    expect(await resolvePublicModelRequest("masked-model")).toBeNull();
    expect(await resolvePublicModelRequest("no-such-public-model")).toBeNull();
    // provider/model format never resolves as a public model
    expect(await resolvePublicModelRequest("claude/sonnet-4")).toBeNull();
  });

  it("customerModelsList: only enabled public names, no provider/combo leakage", async () => {
    await seedPublicModel("pub-one", "internal-combo-c");
    const { customerModelsList } = await import("@/lib/billing/publicModelMap.js");
    const list = await customerModelsList();
    expect(Array.isArray(list)).toBe(true);
    const ids = list.map((m) => m.id);
    expect(ids).toContain("pub-one");
    expect(ids).not.toContain("internal-combo-c");
    for (const m of list) {
      expect(m.object).toBe("model");
      expect(m.owned_by).toBe("9router");
      expect(JSON.stringify(m)).not.toContain("internal-combo");
    }
  });
});
