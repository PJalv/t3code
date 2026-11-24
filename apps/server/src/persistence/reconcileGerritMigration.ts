import * as Effect from "effect/Effect";
import type * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

// Remove only the fork's obsolete ledger entry so upstream's ids run before the idempotent adopt.
export const reconcileGerritMigration = Effect.fn("reconcileGerritMigration")(
  function* (
    currentId: number,
    validate: Effect.Effect<
      void,
      Migrator.MigrationError | SqlError,
      SqlClient.SqlClient
    >,
    throughId?: number,
  ) {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
    if (tables.length === 0) return;
    const legacy = yield* sql`
    SELECT migration_id FROM effect_sql_migrations
    WHERE name = 'GerritPendingClones' AND migration_id < ${currentId}
      AND migration_id <= ${throughId ?? currentId}
  `;
    if (legacy.length === 0) return;
    // A rejected history must leave the ledger intact for the previous build.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        DELETE FROM effect_sql_migrations
        WHERE name = 'GerritPendingClones' AND migration_id < ${currentId}
          AND migration_id <= ${throughId ?? currentId}
      `;
        yield* validate;
      }),
    );
  },
);
