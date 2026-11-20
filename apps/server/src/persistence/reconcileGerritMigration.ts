import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

// These definitions are frozen from the pre-rebase 097_GerritPendingClones migration.
const legacyTables = [
  `CREATE TABLE gerrit_pending_clones (
    project_id TEXT PRIMARY KEY NOT NULL,
    destination_path TEXT NOT NULL UNIQUE,
    installation TEXT NOT NULL,
    gerrit_project TEXT NOT NULL,
    uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1)),
    snapshot TEXT NOT NULL,
    gate_operation_id TEXT
  )`,
  `CREATE TABLE gerrit_pending_clone_attempts (
    project_id TEXT NOT NULL REFERENCES gerrit_pending_clones(project_id) ON DELETE CASCADE,
    recovery_path TEXT NOT NULL,
    PRIMARY KEY (project_id, recovery_path)
  )`,
];

export const assertLegacyGerritSchema = Effect.fn("assertLegacyGerritSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{ readonly type: string; readonly sql: string | null }>`
    SELECT type, sql FROM sqlite_schema
    WHERE tbl_name IN ('gerrit_pending_clones', 'gerrit_pending_clone_attempts')
  `;
  const definitions = objects.filter((row) => row.type === "table").map((row) => row.sql);
  // Exact DDL also checks defaults, CHECK/UNIQUE constraints and the cascading foreign key.
  if (
    definitions.length !== 2 ||
    !legacyTables.every((ddl) => definitions.includes(ddl)) ||
    objects.some((row) => row.type !== "table" && (row.type !== "index" || row.sql !== null))
  ) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: "Cannot upgrade legacy Gerrit migration 97 with unexpected pending-clone schema.",
    });
  }
});

export const reconcileGerritMigration = Effect.fn("reconcileGerritMigration")(function* (
  manifest: ReadonlyArray<readonly [number, string]>,
  replay: Effect.Effect<
    ReadonlyArray<readonly [number, string]>,
    Migrator.MigrationError | SqlError,
    SqlClient.SqlClient
  >,
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return [];
  const legacy = yield* sql`
    SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 97 AND name = 'GerritPendingClones'
  `;
  if (legacy.length === 0 || (throughId !== undefined && throughId < 97)) return [];

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      // Another startup may have finished the repair while this connection waited for the lock.
      if (!history.some((row) => row.migration_id === 97 && row.name === "GerritPendingClones"))
        return [];
      const expected = [
        ...manifest.filter(([id]) => id < 97),
        [97, "GerritPendingClones"] as const,
      ];
      if (
        (throughId !== undefined && throughId < 102) ||
        history.length !== expected.length ||
        !history.every(
          (row, index) =>
            row.migration_id === expected[index]?.[0] && row.name === expected[index]?.[1],
        )
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message:
            "Cannot upgrade legacy Gerrit migration 97 without its exact history and migrations through 102.",
        });
      }
      yield* assertLegacyGerritSchema();
      // Never move 97 straight to 102: the migrator would then skip upstream 97-101.
      // Keep removal and replay atomic so a failed upgrade restores the old ledger and schema.
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 97 AND name = 'GerritPendingClones'`;
      const executed = yield* replay;
      // Migrator can swallow a ledger conflict as "already running"; never commit just the delete.
      if (executed.length !== 6 || executed[5]?.[0] !== 102) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Legacy Gerrit migration replay did not complete migrations 97 through 102.",
        });
      }
      return executed;
    }),
  );
});
