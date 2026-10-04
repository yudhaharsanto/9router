// Customer billing tables (phase 1). For fresh DBs 001-initial already built
// these from the shared TABLES declaration — everything here is IF NOT EXISTS,
// so this migration is a no-op there and stamps schemaVersion = 2. For existing
// DBs at version 1 it creates the new tables/indexes explicitly.
import { TABLES, buildCreateTableSql } from "../schema.js";

const CUSTOMER_TABLES = [
  "customers",
  "customerKeys",
  "customerBalances",
  "ledger",
  "topups",
  "webhookEvents",
  "pricingVersions",
  "publicModels",
];

export default {
  version: 2,
  name: "customer-billing",
  up(db) {
    for (const name of CUSTOMER_TABLES) {
      const def = TABLES[name];
      if (!def) throw new Error(`TABLES is missing customer billing table ${name}`);
      db.exec(buildCreateTableSql(name, def));
      for (const idx of def.indexes || []) db.exec(idx);
    }
  },
};
