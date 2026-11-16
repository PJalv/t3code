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
const isTargetError = Schema.is(GerritTarget.GerritTargetError);
const failed = (error: unknown) => {
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  const target = isTargetError(error) ? error : isTargetError(cause) ? cause : undefined;
  const closed =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "GerritDirectError" &&
    "reason" in error &&
    error.reason === "closed";
  return new OrchestratorMcpFailure({
    code: "invalid_request",
    message: closed
      ? "This Gerrit change is merged or abandoned; its review is closed. Do not retry."
      : (target?.message ?? "Gerrit operation failed. Read the change before retrying a mutation."),
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
    read_gerrit: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const request = yield* decodeRead(input, gerritDirectDecodeOptions).pipe(
          Effect.mapError(invalid),
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
        return publicValue(
          yield* service.act({ cwd: yield* cwd(), ...request }).pipe(Effect.mapError(failed)),
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
