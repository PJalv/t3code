import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  GerritDirectTarget,
  GerritDirectAction,
  GerritDirectNotify,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
];
const actInput = Schema.Struct({
  target: GerritDirectTarget,
  action: GerritDirectAction,
  revision: Schema.optionalKey(Schema.String),
  notify: Schema.optionalKey(GerritDirectNotify),
});
// MCP needs an object root, so read and upload expose flat parameters; the handlers decode them
// into the strict per-mode unions and reject fields that do not belong to the chosen mode.
const readParameters = Schema.Struct({
  mode: Schema.Literals(["change", "diff", "reviewers", "search"]),
  target: Schema.optionalKey(GerritDirectTarget).annotate({
    description: "Change number or URL. Required unless mode is search.",
  }),
  revision: Schema.optionalKey(Schema.String).annotate({
    description: "Patch set number or commit for change and diff. Defaults to the current one.",
  }),
  includeDrafts: Schema.optionalKey(Schema.Boolean),
  path: Schema.optionalKey(Schema.String).annotate({ description: "File path, for diff." }),
  base: Schema.optionalKey(Schema.String).annotate({
    description: "Patch set to diff against, for diff.",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description: "Gerrit search query for search, or name or email for reviewers.",
  }),
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(Schema.String),
});
const uploadParameters = Schema.Struct({
  kind: Schema.Literals(["new", "patch-set"]),
  branch: Schema.optionalKey(Schema.String).annotate({
    description: "Destination branch. Required for new.",
  }),
  number: Schema.optionalKey(Schema.Int).annotate({
    description: "Change to update, for patch-set. Pass number or url.",
  }),
  url: Schema.optionalKey(Schema.String).annotate({
    description: "Change URL to update, for patch-set. Pass number or url.",
  }),
  commit: Schema.optionalKey(Schema.String).annotate({ description: "Defaults to HEAD." }),
  topic: Schema.optionalKey(Schema.String),
  reviewers: Schema.optionalKey(Schema.Array(Schema.String)),
  cc: Schema.optionalKey(Schema.Array(Schema.String)),
  wip: Schema.optionalKey(Schema.Boolean),
  private: Schema.optionalKey(Schema.Boolean),
});
export const GerritDirectToolkit = Toolkit.make(
  Tool.make("read_gerrit", {
    description:
      "Read or search Gerrit changes, review details, diffs, and reviewer candidates. The server comes from the current checkout or change URL.",
    parameters: readParameters,
    success: Schema.Unknown,
    failure: OrchestratorMcpFailure,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Strict, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("act_gerrit", {
    description:
      "Perform one Gerrit review or change action, then return its current state. Use `read_gerrit` for allowed votes and comment IDs.",
    parameters: actInput,
    success: Schema.Unknown,
    failure: OrchestratorMcpFailure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Strict, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("upload_gerrit", {
    description:
      "Push a commit from this thread's checkout to Gerrit as a new change or patch set. The checkout remote selects the server and project.",
    parameters: uploadParameters,
    success: Schema.Unknown,
    failure: OrchestratorMcpFailure,
    dependencies: [...dependencies, Orchestrator.OrchestratorV2, SecureRandom.SecureRandom],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Strict, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);
export { actInput };
