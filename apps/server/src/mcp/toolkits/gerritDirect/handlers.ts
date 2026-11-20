import {
  CommandId,
  OrchestratorMcpFailure,
  gerritDirectDecodeOptions,
  GerritDirectReadRequest,
  GerritDirectUploadInput,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as GerritDirectRead from "../../../sourceControl/GerritDirectRead.ts";
import * as GerritDirectService from "../../../sourceControl/GerritDirectService.ts";
import * as GerritTarget from "../../../sourceControl/GerritTarget.ts";
import * as GerritWatchCompletion from "../../../sourceControl/GerritWatchCompletion.ts";
import { GerritDirectUploadError } from "../../../sourceControl/GerritDirectUpload.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { actInput, GerritDirectToolkit } from "./tools.ts";

const decodeRead = Schema.decodeUnknownEffect(GerritDirectReadRequest);
const decodeAct = Schema.decodeUnknownEffect(actInput);
const decodeUpload = Schema.decodeUnknownEffect(GerritDirectUploadInput);

const denied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "An active Gerrit thread session is required.",
  });
const invalid = () =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: "Invalid Gerrit input." });
const invalidRead = (input: { mode: string; target?: unknown; path?: string; query?: string }) => {
  const message =
    input.mode !== "search" && input.target === undefined
      ? "read_gerrit requires target for this mode. Pass a change number or URL."
      : input.mode === "diff" && !input.path
        ? "read_gerrit mode diff requires path. Read mode change for available file paths."
        : input.mode === "reviewers" && !input.query
          ? "read_gerrit mode reviewers requires a name or email in query."
          : "Invalid Gerrit read input. Use only fields supported by the selected mode.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
};
const isTargetError = Schema.is(GerritTarget.GerritTargetError);
const isUploadError = Schema.is(GerritDirectUploadError);
const failed = (error: unknown) => {
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  const target = isTargetError(error) ? error : isTargetError(cause) ? cause : undefined;
  const signing =
    typeof cause === "object" &&
    cause !== null &&
    "reason" in cause &&
    cause.reason === "commit-signing";
  const closed =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "GerritDirectError" &&
    "reason" in error &&
    error.reason === "closed";
  return new OrchestratorMcpFailure({
    code: "invalid_request",
    message: signing
      ? "Commit signing failed; no upload was attempted. Check the saved signing passphrase and key."
      : closed
        ? "This Gerrit change is merged or abandoned; its review is closed. Do not retry."
        : (target?.message ??
          (isUploadError(cause) ? cause.message : undefined) ??
          "Gerrit operation failed. Read the change before retrying a mutation."),
  });
};

// The direct services still use legacy host response types with internal installation keys.
// Undefined fields are dropped because MCP structured content must be plain JSON.
const publicValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) => item !== undefined && key !== "installation" && key !== "installationId",
      )
      .map(([key, item]) => [key, publicValue(item)]),
  );
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const read = yield* GerritDirectRead.GerritDirectRead;
  const service = yield* GerritDirectService.GerritDirectService;
  const completion = yield* GerritWatchCompletion.GerritWatchCompletion;
  const cwd = Effect.fn("GerritDirectHandlers.cwd")(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (
      scope.client !== undefined ||
      scope.thread === undefined ||
      !scope.capabilities.has("gerrit")
    )
      return yield* denied();
    const thread = yield* threads
      .getThreadShell(scope.thread.threadId)
      .pipe(Effect.mapError(denied));
    if (thread === null || thread.deletedAt !== null) return yield* denied();
    const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(denied));
    if (Option.isNone(project) || project.value.deletedAt !== null) return yield* denied();
    return thread.worktreePath ?? project.value.workspaceRoot;
  });
  return {
    fetch_gerrit_patch_set: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        return yield* service
          .fetchPatchSet({ cwd: yield* cwd(), target: input.target })
          .pipe(Effect.mapError(failed));
      }),
    ),
    fetch_gerrit_branch: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        return yield* service
          .fetchBranch({ cwd: yield* cwd(), branch: input.branch })
          .pipe(Effect.mapError(failed));
      }),
    ),
    amend_gerrit_signed: McpToolAccess.actsAsCaller(() =>
      Effect.gen(function* () {
        yield* service.amendSigned({ cwd: yield* cwd() }).pipe(Effect.mapError(failed));
        return { amended: true };
      }),
    ),
    read_gerrit: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const request = yield* decodeRead(input, gerritDirectDecodeOptions).pipe(
          Effect.mapError(() => invalidRead(input)),
        );
        return publicValue(
          yield* read.read({ cwd: yield* cwd(), request }).pipe(Effect.mapError(failed)),
        );
      }),
    ),
    act_gerrit: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const request = yield* decodeAct(input, gerritDirectDecodeOptions).pipe(
          Effect.mapError(invalid),
        );
        const checkout = yield* cwd();
        const scope = yield* McpInvocationContext.McpInvocationContext;
        return publicValue(
          yield* service.act({ cwd: checkout, ...request }).pipe(
            Effect.provideService(GerritWatchCompletion.NativeAction, (action, write) =>
              completion.action(scope.thread!.threadId, action, write),
            ),
            Effect.mapError(failed),
          ),
        );
      }),
    ),
    upload_gerrit: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const upload = yield* decodeUpload(input, gerritDirectDecodeOptions).pipe(
          Effect.mapError(invalid),
        );
        const uploaded = yield* service
          .upload({ cwd: yield* cwd(), upload })
          .pipe(Effect.mapError(failed));
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (scope.thread !== undefined) {
          const linked = yield* Effect.gen(function* () {
            const change = uploaded.change;
            if (change === null) return false;
            const engine = yield* Orchestrator.OrchestratorV2;
            const crypto = yield* SecureRandom.SecureRandom;
            const server = new URL(change.key.installation);
            yield* engine.dispatch({
              type: "thread.pull-request.link",
              commandId: CommandId.make(`server:gerrit-upload:${yield* crypto.uuidV4()}`),
              threadId: scope.thread!.threadId,
              host: server.host,
              repository: change.key.project,
              number: change.number,
              url: `${change.key.installation.replace(/\/$/u, "")}/c/${change.key.project}/+/${change.number}`,
              source: "agent",
            });
            return true;
          }).pipe(Effect.orElseSucceed(() => false));
          if (!linked) {
            return publicValue({
              ...uploaded,
              linkError: "Upload succeeded, but the change could not be linked to the thread.",
            });
          }
        }
        return publicValue(uploaded);
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof GerritDirectToolkit.tools>;
});
export const layer = McpToolAccess.toLayer(GerritDirectToolkit, make);
