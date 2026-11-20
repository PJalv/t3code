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
const repoPath = Schema.optionalKey(Schema.String).annotate({
  description:
    "Optional. A file or folder inside a nested git repo of this thread's workspace, such as one checkout in a `repo` workspace. Absolute or relative to the thread's folder. Defaults to the thread's folder.",
});
const actInput = Schema.Struct({
  target: GerritDirectTarget,
  action: GerritDirectAction,
  revision: Schema.optionalKey(Schema.String),
  notify: Schema.optionalKey(GerritDirectNotify),
});
// MCP needs an object root, so read and upload expose flat parameters; the handlers decode them
// into the strict per-mode unions and reject fields that do not belong to the chosen mode.
const readParameters = Schema.Struct({
  mode: Schema.Literals(["change", "comments", "diff", "reviewers", "search"]),
  target: Schema.optionalKey(GerritDirectTarget).annotate({
    description: "Change number or URL. Required unless mode is search.",
  }),
  revision: Schema.optionalKey(Schema.String).annotate({
    description: "Patch set number or commit for change and diff. Defaults to the current one.",
  }),
  includeDrafts: Schema.optionalKey(Schema.Boolean),
  path: Schema.optionalKey(Schema.String).annotate({
    description: "Required when mode is diff. Use a path returned by mode change.",
  }),
  base: Schema.optionalKey(Schema.String).annotate({
    description: "Patch set to diff against, for diff.",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description:
      "Required when mode is reviewers: name or email. Optional for search: a Gerrit query such as `owner:self status:merged`, scoped to the checkout's project; without one, search lists open changes.",
  }),
  limit: Schema.optionalKey(Schema.Int),
  cursor: Schema.optionalKey(Schema.String).annotate({
    description: "For comments, pass nextCursor to continue through comments and long bodies.",
  }),
  repoPath,
});
const uploadParameters = Schema.Struct({
  kind: Schema.Literals(["new", "patch-set"]),
  branch: Schema.optionalKey(Schema.String).annotate({
    description:
      "Destination branch for new. Defaults to the branch the current branch tracks on the Gerrit remote.",
  }),
  number: Schema.optionalKey(Schema.Int).annotate({
    description: "Change to update, for patch-set. Pass number or url.",
  }),
  url: Schema.optionalKey(Schema.String).annotate({
    description: "Change URL to update, for patch-set. Pass number or url.",
  }),
  commit: Schema.optionalKey(Schema.String).annotate({ description: "Defaults to HEAD." }),
  topic: Schema.optionalKey(Schema.String),
  repoPath,
  reviewers: Schema.optionalKey(Schema.Array(Schema.String)),
  cc: Schema.optionalKey(Schema.Array(Schema.String)),
  wip: Schema.optionalKey(Schema.Boolean),
  private: Schema.optionalKey(Schema.Boolean),
  dryRun: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Return the upload plan without pushing.",
  }),
});
export const GerritDirectToolkit = Toolkit.make(
  Tool.make("fetch_gerrit_patch_set", {
    description:
      "Fetch and verify the current Gerrit patch set into a local ref without changing the checkout. Use the returned ref as baseRef for a thread worktree handoff or launch.",
    parameters: Schema.Struct({ target: GerritDirectTarget, repoPath }),
    success: Schema.Unknown,
    failure: OrchestratorMcpFailure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Strict, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("fetch_gerrit_branch", {
    description:
      "Fetch a Gerrit branch into this thread's checkout as <remote>/<branch> using the saved Gerrit login, for example to rebase onto the latest master. Use it instead of git fetch, which has no Gerrit credentials here.",
    parameters: Schema.Struct({
      branch: Schema.String.annotate({ description: "Branch name, such as master." }),
      repoPath,
    }),
    success: Schema.Unknown,
    failure: OrchestratorMcpFailure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Strict, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("amend_gerrit_signed", {
    description:
      "Amend HEAD with already staged files and sign it using the saved GPG passphrase. Operates in this thread's bound checkout; never disables signing.",
    parameters: Schema.Struct({ confirm: Schema.Literal(true), repoPath }),
    success: Schema.Unknown,
    failure: OrchestratorMcpFailure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Strict, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
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
    parameters: Schema.Struct({ ...actInput.fields, repoPath }),
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
      "Push a commit from this thread's checkout to Gerrit as a new change or patch set. The checkout remote selects the server and project. Every commit not yet on <remote>/<branch> is pushed and needs a Change-Id; pass dryRun to list them without pushing.",
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
