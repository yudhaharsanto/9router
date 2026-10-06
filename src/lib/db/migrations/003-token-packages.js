// Token packages (phase 2). For fresh DBs the shared TABLES declaration already
// built these — everything here is IF NOT EXISTS, so this migration is a no-op
// there and stamps schemaVersion = 3. For existing DBs it creates the new
// tables/indexes explicitly.
import { TABLES, buildCreateTableSql } from "../schema.js";

const PACKAGE_TABLES = ["tokenPackages", "customerPackages"];

export default {
  version: 3,
  name: "token-packages",
  up(db) {
    for (const name of PACKAGE_TABLES) {
      const def = TABLES[name];
      if (!def) throw new Error(`TABLES is missing token package table ${name}`);
      db.exec(buildCreateTableSql(name, def));
      for (const idx of def.indexes || []) db.exec(idx);
    }
  },
};
