import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Earlier fork builds recorded GerritPendingClones at ids upstream later took (97, 103, ...).
// Dropping that row lets the migrator run upstream's ids; the idempotent current migration
// then adopts the existing tables and their rows.
export const reconcileGerritMigration = Effect.fn("reconcileGerritMigration")(function* (
  currentId: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE name = 'GerritPendingClones' AND migration_id < ${currentId}
  `;
});
