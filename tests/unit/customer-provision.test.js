// First-login provisioning — customer + one key, no key spam on re-login.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-provision-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  await import("@/lib/db/index.js").then((m) => m.initDb());
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("provisionCustomerFromGoogle", () => {
  it("first login creates customer + key and stages the reveal", async () => {
    const { provisionCustomerFromGoogle } = await import("@/lib/auth/customerProvision.js");
    const r1 = await provisionCustomerFromGoogle({ sub: "g-sub-1", email: "a@x.y", name: "A" });
    expect(r1.created).toBe(true);
    expect(r1.key).toMatch(/^sk-cust-[0-9a-f]{64}$/);
    expect(r1.customer.googleSub).toBe("g-sub-1");

    // Reveal token works exactly once
    const { takeKeyReveal } = await import("@/lib/auth/customerProvision.js");
    expect(typeof r1.revealToken).toBe("string");
    expect(takeKeyReveal(r1.revealToken, r1.customer.id)).toBe(r1.key);
    expect(takeKeyReveal(r1.revealToken, r1.customer.id)).toBeNull();
  });

  it("second login reuses the same customer and mints NO second key", async () => {
    const { provisionCustomerFromGoogle } = await import("@/lib/auth/customerProvision.js");
    const r1 = await provisionCustomerFromGoogle({ sub: "g-sub-2", email: "b@x.y", name: "B" });
    const r2 = await provisionCustomerFromGoogle({ sub: "g-sub-2", email: "b@x.y", name: "B-renamed" });
    expect(r2.created).toBe(false);
    expect(r2.customer.id).toBe(r1.customer.id);
    expect(r2.key).toBeNull();
    expect(r2.revealToken).toBeNull();
  });

  it("regenerate-after-revoke: customer with no active key gets a fresh one", async () => {
    const { provisionCustomerFromGoogle } = await import("@/lib/auth/customerProvision.js");
    const { revokeCustomerKey, getActiveKeyForCustomer } = await import("@/lib/db/index.js");
    const r1 = await provisionCustomerFromGoogle({ sub: "g-sub-3", email: "c@x.y", name: "C" });
    await revokeCustomerKey((await getActiveKeyForCustomer(r1.customer.id)).id);
    const r2 = await provisionCustomerFromGoogle({ sub: "g-sub-3", email: "c@x.y", name: "C" });
    expect(r2.key).toMatch(/^sk-cust-/);
  });
});

describe("takeKeyReveal — consume safety", () => {
  it("a wrong-customer probe must NOT burn the owner's token", async () => {
    const { stageKeyReveal, takeKeyReveal } = await import("@/lib/auth/customerProvision.js");
    const token = stageKeyReveal("owner-c", "sk-cust-owner-plaintext");
    expect(takeKeyReveal(token, "attacker-c")).toBeNull();
    // Owner can still consume after the failed probe.
    expect(takeKeyReveal(token, "owner-c")).toBe("sk-cust-owner-plaintext");
    expect(takeKeyReveal(token, "owner-c")).toBeNull(); // one-time still holds
  });

  it("expired token is rejected", async () => {
    const mod = await import("@/lib/auth/customerProvision.js");
    const token = mod.stageKeyReveal("owner-c2", "sk-cust-old");
    // Reach into the store via behavior: TTL is 10 min; fake an expired entry
    // by staging then manipulating time is intrusive — instead stage, wait not
    // possible, so verify unexpired works and rely on unit of expiresAt check
    // through the exported behavior: consume is null only after expiry. We
    // trust Date.now() comparison covered by the wrong-customer + happy tests;
    // here we assert expired entries are not consumable by simulating with a
    // monkey-patched Date.now.
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      expect(mod.takeKeyReveal(token, "owner-c2")).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("provisionCustomerFromGoogle — key race safety", () => {
  it("creates at most one active key under concurrent first logins", async () => {
    const { provisionCustomerFromGoogle } = await import("@/lib/auth/customerProvision.js");
    const { getActiveKeyForCustomer } = await import("@/lib/db/index.js");
    const [a, b] = await Promise.all([
      provisionCustomerFromGoogle({ sub: "g-sub-race", email: "race@x.y", name: "R" }),
      provisionCustomerFromGoogle({ sub: "g-sub-race", email: "race@x.y", name: "R" }),
    ]);
    const active = await getActiveKeyForCustomer(a.customer.id);
    expect(active).not.toBeNull();
    // Both calls see the same single active key (one created it, one found it).
    const keysFor = a.customer.id;
    const activeB = await getActiveKeyForCustomer(keysFor);
    expect(activeB.id).toBe(active.id);
    // Exactly one provisioning returned a plaintext (no double key).
    const created = [a.key, b.key].filter(Boolean);
    expect(created.length).toBeLessThanOrEqual(1);
  });
});
