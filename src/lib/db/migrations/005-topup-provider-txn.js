// topups.takoTxnId → topups.providerTxnId. The column now holds the ShopeePay
// gateway transaction id claimed by the poller (same UNIQUE anchor, different
// provider). Guarded because versioned migrations run BEFORE the additive
// schema sync: on a fresh DB the table does not exist yet and schema.js
// already declares the new name.
import { getAdapter } from "../driver.js";

const migration = {
  version: 5,
  name: "topup-provider-txn",
  async up() {
    const db = await getAdapter();
    let columns = [];
    try {
      columns = db.all(`PRAGMA table_info(topups)`);
    } catch {
      return; // table not created yet (fresh DB) — nothing to rename
    }
    const names = new Set(columns.map((c) => c.name));
    if (!names.has("takoTxnId") || names.has("providerTxnId")) return;
    db.exec(`ALTER TABLE topups RENAME COLUMN takoTxnId TO providerTxnId`);
  },
};

export default migration;
