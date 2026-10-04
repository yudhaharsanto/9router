// Customer repos — get-or-create, status transitions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cust-repos-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("customersRepo", () => {
  it("creates a customer on first login", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "sub-1", email: "a@b.c", name: "A" });
    expect(c.id).toBeTruthy();
    expect(c.googleSub).toBe("sub-1");
    expect(c.status).toBe("active");
  });

  it("returns the same customer for the same googleSub (no duplicate)", async () => {
    const first = await db.getOrCreateCustomer({ googleSub: "sub-2", email: "x@y.z", name: "X" });
    const second = await db.getOrCreateCustomer({ googleSub: "sub-2", email: "x@y.z", name: "X" });
    expect(second.id).toBe(first.id);
    const rows = await db.getOrCreateCustomer({ googleSub: "sub-2" });
    expect(rows.id).toBe(first.id);
  });

  it("refreshes email/name on existing customer when they change", async () => {
    await db.getOrCreateCustomer({ googleSub: "sub-3", email: "old@x.y", name: "Old" });
    const updated = await db.getOrCreateCustomer({ googleSub: "sub-3", email: "new@x.y", name: "New" });
    expect(updated.email).toBe("new@x.y");
    expect(updated.name).toBe("New");
  });

  it("getCustomerById returns null for unknown id", async () => {
    expect(await db.getCustomerById("nope")).toBeNull();
  });

  it("setCustomerStatus rejects invalid status", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "sub-4" });
    await expect(db.setCustomerStatus(c.id, "hacked")).rejects.toThrow();
  });

  it("setCustomerStatus('disabled') persists", async () => {
    const c = await db.getOrCreateCustomer({ googleSub: "sub-5" });
    await db.setCustomerStatus(c.id, "disabled");
    expect((await db.getCustomerById(c.id)).status).toBe("disabled");
  });
});
