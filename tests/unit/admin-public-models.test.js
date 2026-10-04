// Admin public-model mapping API (spec §3.6): mark a combo as a public model.
// Admin session-gated; combo IDs stay server-side (admin UI sees combo names).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adminToken;

beforeAll(async () => {
  delete process.env.BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-admin-pub-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  adminToken = await createDashboardAuthToken();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function req(method = "GET", body) {
  return new Request("http://localhost:20128/api/admin/public-models", {
    method,
    headers: {
      ...(adminToken ? { cookie: `auth_token=${adminToken}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function seedCombo(name) {
  const combos = await import("@/lib/db/repos/combosRepo.js");
  return combos.createCombo({ name, models: ["claude/gate-test-model"] });
}

describe("/api/admin/public-models", () => {
  it("401 without an admin session", async () => {
    const mod = await import("@/app/api/admin/public-models/route.js");
    const res = await mod.GET(new Request("http://localhost:20128/api/admin/public-models"));
    expect([401, 403]).toContain(res.status);
  });

  it("POST upserts mapping; GET lists it with combo name; unknown combo → 400", async () => {
    const combo = await seedCombo("internal-pub-combo");
    const mod = await import("@/app/api/admin/public-models/route.js");

    const bad = await mod.POST(req("POST", { publicName: "glm-flash", comboId: "no-such-combo" }));
    expect(bad.status).toBe(400);

    const missing = await mod.POST(req("POST", { comboId: combo.id }));
    expect(missing.status).toBe(400);

    const up = await mod.POST(req("POST", { publicName: "glm-flash", comboId: combo.id, enabled: true }));
    expect(up.status).toBe(200);
    const row = await up.json();
    expect(row.publicName).toBe("glm-flash");
    expect(row.enabled).toBe(true);

    const list = await (await mod.GET(req())).json();
    expect(Array.isArray(list.publicModels)).toBe(true);
    const mapped = list.publicModels.find((m) => m.publicName === "glm-flash");
    expect(mapped.comboName).toBe("internal-pub-combo");
    expect(mapped.enabled).toBe(true);
  });

  it("POST toggles enabled=false; DELETE removes mapping", async () => {
    const combo = await seedCombo("internal-pub-combo-2");
    const mod = await import("@/app/api/admin/public-models/route.js");
    await mod.POST(req("POST", { publicName: "glm-pro", comboId: combo.id, enabled: true }));

    const off = await mod.POST(req("POST", { publicName: "glm-pro", comboId: combo.id, enabled: false }));
    const offRow = await off.json();
    expect(offRow.enabled).toBe(false);

    const del = await mod.DELETE(req("DELETE", null, ));
    expect([400, 404]).toContain(del.status); // no id → refused
    const del2 = await mod.DELETE(new Request(`http://localhost:20128/api/admin/public-models?id=${offRow.id}`, {
      method: "DELETE",
      headers: adminToken ? { cookie: `auth_token=${adminToken}` } : {},
    }));
    expect(del2.status).toBe(200);
    const list = await (await mod.GET(req())).json();
    expect(list.publicModels.find((m) => m.publicName === "glm-pro")).toBeUndefined();
  });

  it("GET includes autoPricing for rows without direct pricing (official × (1 − discount))", async () => {
    const pricing = await import("@/lib/db/repos/pricingRepo.js");
    const settings = await import("@/lib/db/repos/settingsRepo.js");
    // Member model official price: input 4, output 20 → at discount 0.5: 2 / 10
    await pricing.updatePricing({ openai: { "auto-price-model": { input: 4, output: 20, cached: 0.4, reasoning: 20 } } });
    await settings.updateSettings({ discountRate: 0.5 });
    vi.resetModules();

    const combos = await import("@/lib/db/repos/combosRepo.js");
    const combo = await combos.createCombo({ name: "internal-pub-combo-3", models: ["openai/auto-price-model"] });
    const mod = await import("@/app/api/admin/public-models/route.js");
    await mod.POST(req("POST", { publicName: "auto-priced", comboId: combo.id, enabled: true }));

    const list = await (await mod.GET(req())).json();
    const row = list.publicModels.find((m) => m.publicName === "auto-priced");
    expect(row.pricing).toBeNull();
    expect(Array.isArray(row.autoPricing)).toBe(true);
    const member = row.autoPricing.find((a) => a.model === "auto-price-model");
    expect(member).toBeTruthy();
    expect(member.sellInput).toBeCloseTo(2, 6);
    expect(member.sellOutput).toBeCloseTo(10, 6);

    // Direct-priced rows don't get autoPricing
    const direct = await mod.POST(req("POST", {
      publicName: "direct-priced", comboId: combo.id, enabled: true,
      pricing: { input: 1, output: 5 },
    }));
    expect(direct.status).toBe(200);
    const list2 = await (await mod.GET(req())).json();
    const row2 = list2.publicModels.find((m) => m.publicName === "direct-priced");
    expect(row2.pricing.input).toBe(1);
    expect(row2.autoPricing).toBeUndefined();
  });
});
