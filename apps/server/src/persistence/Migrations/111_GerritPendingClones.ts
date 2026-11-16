import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE gerrit_pending_clones (
    project_id TEXT PRIMARY KEY NOT NULL,
    destination_path TEXT NOT NULL UNIQUE,
    installation TEXT NOT NULL,
    gerrit_project TEXT NOT NULL,
    uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1)),
    snapshot TEXT NOT NULL,
    gate_operation_id TEXT
  )`;
  yield* sql`CREATE TABLE gerrit_pending_clone_attempts (
    project_id TEXT NOT NULL REFERENCES gerrit_pending_clones(project_id) ON DELETE CASCADE,
    recovery_path TEXT NOT NULL,
    PRIMARY KEY (project_id, recovery_path)
  )`;
});
