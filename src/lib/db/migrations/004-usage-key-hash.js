// usageHistory.keyHash (customer usage attribution). The portal matched rows
// by HMAC-hashing the stored plaintext apiKey in memory over the latest 1000
// rows — a scan cap that silently dropped customer rows once traffic exceeded
// 1000 requests since their last row. Storing the hash at write time makes the
// filter an indexed lookup with no cap. ponytail: one-time backfill covers
// existing rows with the default secret; deployments using a custom
// API_KEY_SECRET keep their historical rows unattributed (new rows fill in).
import crypto from "node:crypto";
import { getAdapter } from "../driver.js";

const migration = {
  version: 4,
  name: "usage-key-hash",
  async up() {
    const db = await getAdapter();
    const secret = process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";
    const rows = db.all(`SELECT id, apiKey FROM usageHistory WHERE apiKey IS NOT NULL AND keyHash IS NULL`);
    const update = db.transaction(() => {
      for (const r of rows) {
        const h = crypto.createHmac("sha256", secret).update(r.apiKey).digest("hex");
        db.run(`UPDATE usageHistory SET keyHash = ? WHERE id = ?`, [h, r.id]);
      }
    });
    update();
  },
};

export default migration;
