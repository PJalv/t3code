import * as Schema from "effect/Schema";

export const GerritHookInput = Schema.Struct({ cwd: Schema.String.check(Schema.isNonEmpty()) });
export const GerritHookSource = Schema.Struct({
  version: Schema.Literal("3.10.2"),
  source: Schema.Literal(
    "https://gerrit.googlesource.com/gerrit/+/refs/tags/v3.10.2/resources/com/google/gerrit/server/tools/root/hooks/commit-msg",
  ),
  sha256: Schema.Literal("056bce3d91a208d433d3e3e07d427c9b6d9b3d32d67d5f03d3a8115ff32b5b64"),
  license: Schema.Literal("Apache-2.0"),
});
export const GerritHookDiagnosis = Schema.Struct({
  repository: Schema.String,
  destination: Schema.String,
  source: GerritHookSource,
  state: Schema.Literals(["missing", "official", "custom", "unsafe"]),
  issues: Schema.Array(Schema.String),
  configuration: Schema.String,
  fingerprint: Schema.String,
});
export type GerritHookDiagnosis = typeof GerritHookDiagnosis.Type;
export class GerritHookError extends Schema.TaggedError<GerritHookError>()("GerritHookError", {
  reason: Schema.Literals([
    "authority",
    "invalid-input",
    "local-read",
    "unsafe",
    "conflict",
    "stale",
    "expired",
    "filesystem",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `Gerrit commit-msg hook setup stopped: ${this.reason}.`;
  }
}
