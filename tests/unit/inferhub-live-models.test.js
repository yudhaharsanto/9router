// Inferhub declares its catalog in the registry (modelsFetcher) because
// UI-created connections never store providerSpecificData.baseUrl. This pins the
// provider route to that registry endpoint instead of a 400/derived URL.
// Self-isolating: DATA_DIR points at a temp dir so seeding never touches ~/.9router.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let GET;
let createProviderConnection;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-inferhub-"));
  vi.resetModules();
  ({ GET } = await import("@/app/api/providers/[id]/models/route.js"));
  ({ createProviderConnection } = await import("@/models/index.js"));
});

afterAll(() => {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Inferhub model catalog", () => {
  it("resolves the registry catalog for a connection with no baseUrl", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [{ id: "ocg/glm-5.2" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const conn = await createProviderConnection({
      provider: "inferhub",
      authType: "apikey",
      apiKey: "sk-airo-test",
      name: `inferhub-${Date.now()}`,
      testStatus: "active",
    });

    const res = await GET(
      new Request(`http://localhost/api/providers/${conn.id}/models`),
      { params: Promise.resolve({ id: conn.id }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.map((model) => model.id)).toContain("ocg/glm-5.2");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.inferhub.dev/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-airo-test" }),
      }),
    );
  });
});
