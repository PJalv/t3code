import {
  GerritCloneSelection,
  ProjectCloneSnapshot as ProjectCloneSnapshotSchema,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type {
  ProjectCloneSnapshot,
  ProjectCloneStage,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectId,
  SourceControlCloneProtocol,
  SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import {
  OrchestrationDispatchCommandError,
  PROJECT_CLONE_DETAIL_MAX_LENGTH,
  PROJECT_CLONE_ERROR_MAX_LENGTH,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import type { ProjectConflictError, ProjectServiceError } from "./ProjectService.ts";

export class ProjectCloneTracker extends Context.Service<
  ProjectCloneTracker,
  {
    readonly start: (
      input: ProjectCloneStartInput,
      hooks: ProjectCloneHooks,
    ) => Effect.Effect<
      ProjectCloneStartResult,
      SourceControlRepositoryError | OrchestrationDispatchCommandError
    >;
    /** Interrupts a running clone and deletes the partial checkout. */
    readonly cancel: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly retry: (projectId: ProjectId) => Effect.Effect<boolean, SourceControlRepositoryError>;
    /** Stops tracking, interrupts any running clone and removes unfinished checkouts. */
    readonly discard: (projectId: ProjectId) => Effect.Effect<void>;
    readonly get: (projectId: ProjectId) => Effect.Effect<ProjectCloneSnapshot | null>;
    readonly stream: Stream.Stream<ReadonlyArray<ProjectCloneSnapshot>>;
  }
>()("t3/project/ProjectCloneTracker") {}

export interface ProjectCloneHooks {
  /** Fails with `ProjectConflictError` when another project already owns the destination. */
  readonly createProject: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly createdAt: string;
    readonly pendingGerrit: boolean;
  }) => Effect.Effect<void, OrchestrationDispatchCommandError | ProjectConflictError>;
  readonly validatePublished?: (projectId: ProjectId) => Effect.Effect<void, ProjectServiceError>;
  readonly onCloned: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<void>;
}

const DONE_RETENTION = "30 seconds";
// Git prints nothing while a transfer waits on the network, and the kernel can
// take 15+ minutes to give up on a dead connection. Without this the banner
// keeps showing the last transfer speed as if data were still arriving.
const STALL_AFTER = "20 seconds";

function clampText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface TrackedClone {
  readonly snapshot: ProjectCloneSnapshot;
  readonly fiber: Fiber.Fiber<unknown, unknown> | null;
  readonly hooks: ProjectCloneHooks | null;
  readonly input: {
    /** What git is given; may carry credentials and never leaves the server. */
    readonly cloneUrl: string;
    readonly destinationPath: string;
    readonly repository: SourceControlRepositoryInfo | null;
    readonly protocol: SourceControlCloneProtocol;
    readonly gerrit?: ProjectCloneStartInput["gerrit"];
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const sql = yield* SqlClient.SqlClient;
  const snapshotJson = Schema.fromJsonString(ProjectCloneSnapshotSchema);
  const decodeGerrit = Schema.decodeEffect(GerritCloneSelection);
  const encodeSnapshot = Schema.encodeEffect(snapshotJson);
  // A previous process may still own the native publisher. Fence its later writes
  // before exposing recovery state; only a future proven reconciliation may clear it.
  yield* sql`UPDATE gerrit_pending_clones SET uncertain = 1 WHERE json_extract(snapshot, '$.phase') <> 'done'`.pipe(
    Effect.orDie,
  );
  const rows = yield* sql<{
    readonly snapshot: string;
    readonly installation: string;
    readonly gerrit_project: string;
    readonly uncertain: number;
  }>`SELECT snapshot, installation, gerrit_project, uncertain FROM gerrit_pending_clones`.pipe(
    Effect.orDie,
  );
  const restored = new Map<ProjectId, TrackedClone>();
  for (const row of rows) {
    const snapshot = yield* Schema.decodeEffect(snapshotJson)(row.snapshot).pipe(Effect.orDie);
    const gerrit = yield* decodeGerrit({
      installation: row.installation,
      project: row.gerrit_project,
    }).pipe(Effect.orDie);
    const attempts = yield* sql<{
      readonly recovery_path: string;
    }>`SELECT recovery_path FROM gerrit_pending_clone_attempts WHERE project_id = ${snapshot.projectId} ORDER BY rowid`.pipe(
      Effect.orDie,
    );
    const recovered =
      row.uncertain === 1
        ? {
            ...snapshot,
            ...(attempts.length
              ? {
                  recoveryPaths: attempts.map((attempt) => attempt.recovery_path),
                  recoveryPath: attempts[attempts.length - 1]!.recovery_path,
                }
              : {}),
            phase: "failed" as const,
            recoveryRequired: true,
            stalled: false,
            error:
              "Clone recovery requires inspection. Publication may have completed; inspect both paths before taking action.",
          }
        : snapshot;
    restored.set(snapshot.projectId, {
      snapshot: recovered,
      fiber: null,
      hooks: null,
      input: {
        cloneUrl: "",
        destinationPath: snapshot.destinationPath,
        repository: null,
        protocol: "auto",
        gerrit,
      },
    });
    if (row.uncertain === 1) {
      const encoded = yield* encodeSnapshot(recovered).pipe(Effect.orDie);
      yield* sql`UPDATE gerrit_pending_clones SET snapshot = ${encoded} WHERE project_id = ${snapshot.projectId} AND uncertain = 1`.pipe(
        Effect.orDie,
      );
    }
  }
  const clones = yield* Ref.make(restored);
  const changes = yield* PubSub.unbounded<ReadonlyArray<ProjectCloneSnapshot>>();
  const retentionFibers = new Map<ProjectId, Fiber.Fiber<unknown, never>>();
  let sequence = Math.max(0, ...Array.from(restored.values(), (entry) => entry.snapshot.sequence));
  const cloneScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(cloneScope, Exit.void));
  // Serialize actions on the shared entry and directory so retries cannot race clones.
  const actionLock = yield* Semaphore.make(1);
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => actionLock.withPermits(1)(effect);

  const list = Ref.get(clones).pipe(
    Effect.map((current) => Array.from(current.values(), (tracked) => tracked.snapshot)),
  );
  const publish = list.pipe(Effect.flatMap((snapshots) => PubSub.publish(changes, snapshots)));

  const isFenced = (projectId: ProjectId) =>
    sql<{
      readonly uncertain: number;
    }>`SELECT uncertain FROM gerrit_pending_clones WHERE project_id = ${projectId}`.pipe(
      Effect.map((rows) => rows[0]?.uncertain === 1),
      Effect.orDie,
    );

  const persist = (tracked: TrackedClone) => {
    const gerrit = tracked.input.gerrit;
    if (!gerrit) return Effect.void;
    const snapshot = {
      ...tracked.snapshot,
      remoteUrl: "gerrit:pending",
      repository: null,
      detail: null,
      error:
        tracked.snapshot.error === null
          ? null
          : "The Gerrit clone requires attention. Inspect the recovery paths.",
    };
    return encodeSnapshot(snapshot).pipe(
      Effect.flatMap(
        (
          encoded,
        ) => sql`INSERT INTO gerrit_pending_clones (project_id, destination_path, installation, gerrit_project, uncertain, snapshot)
      VALUES (${snapshot.projectId}, ${snapshot.destinationPath}, ${gerrit.installation}, ${gerrit.project}, ${snapshot.recoveryRequired ? 1 : 0}, ${encoded})
      ON CONFLICT(project_id) DO UPDATE SET
        snapshot = CASE WHEN gerrit_pending_clones.uncertain = 1 THEN gerrit_pending_clones.snapshot ELSE excluded.snapshot END,
        uncertain = MAX(gerrit_pending_clones.uncertain, excluded.uncertain)`,
      ),
      Effect.orDie,
      Effect.asVoid,
    );
  };

  const modify = (
    projectId: ProjectId,
    mutate: (tracked: TrackedClone) => TrackedClone,
    durable = true,
  ): Effect.Effect<ProjectCloneSnapshot | null> =>
    Ref.modify(clones, (current) => {
      const existing = current.get(projectId);
      if (!existing) return [null, current] as const;
      const nextTracked = mutate(existing);
      const nextSnapshot = { ...nextTracked.snapshot, sequence: ++sequence };
      const next = new Map(current);
      next.set(projectId, { ...nextTracked, snapshot: nextSnapshot });
      return [nextSnapshot, next] as const;
    }).pipe(
      Effect.tap((snapshot) =>
        snapshot
          ? Ref.get(clones).pipe(
              Effect.flatMap((current) => {
                const entry = current.get(projectId);
                return entry && durable
                  ? persist(entry).pipe(
                      Effect.andThen(
                        entry.input.gerrit
                          ? isFenced(projectId).pipe(
                              Effect.flatMap((fenced) =>
                                fenced
                                  ? Ref.update(clones, (map) => {
                                      const latest = map.get(projectId);
                                      if (!latest || latest.snapshot.recoveryRequired) return map;
                                      const next = new Map(map);
                                      next.set(projectId, {
                                        ...latest,
                                        snapshot: {
                                          ...latest.snapshot,
                                          phase: "failed",
                                          recoveryRequired: true,
                                          stalled: false,
                                          error:
                                            "Publication outcome is unknown. Inspect both paths before taking action.",
                                        },
                                      });
                                      return next;
                                    })
                                  : Effect.void,
                              ),
                            )
                          : Effect.void,
                      ),
                    )
                  : Effect.void;
              }),
              Effect.andThen(publish),
            )
          : Effect.void,
      ),
    );

  const clearRetention = (projectId: ProjectId) => {
    const fiber = retentionFibers.get(projectId);
    retentionFibers.delete(projectId);
    return fiber ? Fiber.interrupt(fiber).pipe(Effect.ignore) : Effect.void;
  };

  const remove = Effect.fn("ProjectCloneTracker.remove")(function* (projectId: ProjectId) {
    const tracked = (yield* Ref.get(clones)).get(projectId);
    if (tracked?.input.gerrit) {
      const deleted = yield* sql<{
        readonly project_id: string;
      }>`DELETE FROM gerrit_pending_clones WHERE project_id = ${projectId} AND uncertain = 0 RETURNING project_id`.pipe(
        Effect.orDie,
      );
      if (deleted.length === 0) return;
    }
    yield* Ref.update(clones, (current) => {
      if (!current.has(projectId)) return current;
      const next = new Map(current);
      next.delete(projectId);
      return next;
    });
    yield* publish;
  });

  const scheduleRemoval = Effect.fn("ProjectCloneTracker.scheduleRemoval")(function* (
    projectId: ProjectId,
  ) {
    yield* clearRetention(projectId);
    const fiber = yield* remove(projectId).pipe(
      Effect.delay(DONE_RETENTION),
      Effect.ensuring(
        Effect.sync(() => {
          if (retentionFibers.get(projectId) === fiber) retentionFibers.delete(projectId);
        }),
      ),
      Effect.forkDetach,
    );
    retentionFibers.set(projectId, fiber);
  });

  const progress = (
    projectId: ProjectId,
    update: {
      readonly stage: ProjectCloneStage;
      readonly percent: number | null;
      readonly detail: string | null;
    },
  ) =>
    Ref.get(clones).pipe(
      Effect.flatMap((current) =>
        modify(
          projectId,
          (tracked) => ({
            ...tracked,
            snapshot: {
              ...tracked.snapshot,
              stage: update.stage,
              percent: update.percent,
              detail:
                update.detail === null
                  ? null
                  : clampText(update.detail, PROJECT_CLONE_DETAIL_MAX_LENGTH),
              stalled: false,
            },
          }),
          current.get(projectId)?.snapshot.stage !== update.stage,
        ),
      ),
      Effect.asVoid,
    );

  const markStalled = (projectId: ProjectId) =>
    modify(
      projectId,
      (tracked) => ({
        ...tracked,
        snapshot: { ...tracked.snapshot, stalled: true },
      }),
      false,
    ).pipe(Effect.asVoid);

  /** Marks the clone stalled once, then waits for git to speak again. */
  const watchForStall = (projectId: ProjectId, pulses: Queue.Dequeue<void>) =>
    Queue.take(pulses).pipe(
      Effect.timeoutOption(STALL_AFTER),
      Effect.flatMap((pulse) =>
        Option.isSome(pulse)
          ? Effect.void
          : markStalled(projectId).pipe(Effect.andThen(Queue.take(pulses))),
      ),
      Effect.forever,
    );

  const finish = Effect.fn("ProjectCloneTracker.finish")(function* (
    projectId: ProjectId,
    phase: "done" | "failed" | "cancelled",
    error: string | null,
    remoteUrl?: string,
  ) {
    const endedAt = yield* nowIso;
    yield* modify(projectId, (tracked) => ({
      ...tracked,
      fiber: null,
      snapshot: {
        ...tracked.snapshot,
        phase,
        ...(remoteUrl === undefined ? {} : { remoteUrl }),
        endedAt,
        percent: phase === "done" ? 100 : tracked.snapshot.percent,
        stalled: false,
        error: error === null ? null : clampText(error, PROJECT_CLONE_ERROR_MAX_LENGTH),
      },
    }));
    if (phase === "done" && !(yield* get(projectId))?.recoveryRequired)
      yield* scheduleRemoval(projectId);
  });

  const markUncertain = (projectId: ProjectId) =>
    modify(projectId, (tracked) => ({
      ...tracked,
      snapshot: {
        ...tracked.snapshot,
        phase: "failed",
        recoveryRequired: true,
        stalled: false,
        error: "Publication outcome is unknown. Inspect both paths before taking action.",
      },
    })).pipe(Effect.asVoid);

  const cloneWatchingForStall = Effect.fn("ProjectCloneTracker.cloneWatchingForStall")(function* (
    projectId: ProjectId,
    tracked: TrackedClone,
  ) {
    const pulses = yield* Queue.sliding<void>(1);
    yield* watchForStall(projectId, pulses).pipe(Effect.forkScoped);
    return yield* repositories.cloneRepository(
      {
        remoteUrl: tracked.input.cloneUrl,
        destinationPath: tracked.input.destinationPath,
        protocol: tracked.input.protocol,
        ...(tracked.input.gerrit ? { gerrit: tracked.input.gerrit } : {}),
      },
      {
        onProgress: (update) =>
          Queue.offer(pulses, undefined).pipe(Effect.andThen(progress(projectId, update))),
        onRecoveryPath: (recoveryPath, remoteUrl) =>
          sql`INSERT OR IGNORE INTO gerrit_pending_clone_attempts (project_id, recovery_path) VALUES (${projectId}, ${recoveryPath})`.pipe(
            Effect.orDie,
            Effect.andThen(
              modify(projectId, (entry) => ({
                ...entry,
                snapshot: {
                  ...entry.snapshot,
                  recoveryPath,
                  recoveryPaths: [...(entry.snapshot.recoveryPaths ?? []), recoveryPath],
                  remoteUrl,
                },
              })),
            ),
            Effect.asVoid,
          ),
        onPublished: (remoteUrl) =>
          (tracked.hooks?.validatePublished?.(projectId) ?? Effect.void).pipe(
            Effect.matchEffect({
              onSuccess: () => finish(projectId, "done", null, remoteUrl),
              onFailure: () => markUncertain(projectId),
            }),
          ),
        onPublicationFailure: () => markUncertain(projectId),
        timeoutMs: null,
      },
    );
  }, Effect.scoped);

  /**
   * `onExit` records outcomes even on interruption; `matchCause` would be skipped.
   * Mark the clone done before the post-clone hook so a late Cancel cannot remove it.
   */
  const runClone = (projectId: ProjectId, tracked: TrackedClone) =>
    cloneWatchingForStall(projectId, tracked).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? get(projectId).pipe(
              Effect.flatMap((snapshot) =>
                snapshot?.phase === "done" || snapshot?.recoveryRequired
                  ? Effect.void
                  : tracked.input.gerrit
                    ? markUncertain(projectId)
                    : finish(projectId, "done", null, exit.value.remoteUrl),
              ),
            )
          : get(projectId).pipe(
              Effect.flatMap((snapshot) =>
                snapshot?.phase === "done" || snapshot?.recoveryRequired
                  ? Effect.void
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? tracked.input.gerrit
                      ? markUncertain(projectId)
                      : finish(projectId, "cancelled", null)
                    : tracked.input.gerrit && publicationMayBeUncertain(exit.cause)
                      ? markUncertain(projectId)
                      : finish(projectId, "failed", describeCloneFailure(exit.cause)),
              ),
            ),
      ),
      Effect.flatMap(() =>
        get(projectId).pipe(
          Effect.flatMap((snapshot) =>
            snapshot?.phase === "done" && tracked.hooks
              ? tracked.hooks
                  .onCloned({ projectId, workspaceRoot: tracked.input.destinationPath })
                  .pipe(Effect.ignoreCause({ log: true }))
              : Effect.void,
          ),
        ),
      ),
      Effect.ignoreCause(),
    );

  const launch = Effect.fn("ProjectCloneTracker.launch")(function* (projectId: ProjectId) {
    const current = yield* Ref.get(clones);
    const tracked = current.get(projectId);
    if (!tracked) return;
    const fiber = yield* runClone(projectId, tracked).pipe(Effect.forkIn(cloneScope));
    yield* Ref.update(clones, (map) => {
      const existing = map.get(projectId);
      if (!existing) return map;
      const next = new Map(map);
      next.set(projectId, { ...existing, fiber });
      return next;
    });
  });

  const moveClaim = (from: ProjectId, to: ProjectId) =>
    Ref.modify(clones, (current) => {
      const claim = current.get(from);
      if (!claim || current.has(to)) return [false, current] as const;
      const next = new Map(current);
      next.delete(from);
      next.set(to, { ...claim, snapshot: { ...claim.snapshot, projectId: to } });
      return [true, next] as const;
    });

  const start: ProjectCloneTracker["Service"]["start"] = Effect.fn("ProjectCloneTracker.start")(
    function* (input, hooks) {
      const prepared = yield* repositories.prepareClone(input);
      const startedAt = yield* nowIso;
      const snapshot: ProjectCloneSnapshot = {
        projectId: input.projectId,
        remoteUrl: prepared.remoteUrl,
        destinationPath: prepared.destinationPath,
        repository: prepared.repository,
        ...(input.gerrit ? { gerritPending: true } : {}),
        phase: "running",
        stage: "connecting",
        percent: null,
        detail: null,
        stalled: false,
        error: null,
        startedAt,
        endedAt: null,
        sequence: ++sequence,
      };
      const claimed = yield* Ref.modify(clones, (current) => {
        const conflict = Array.from(current.values()).some(
          (tracked) =>
            tracked.snapshot.projectId === input.projectId ||
            tracked.input.destinationPath === prepared.destinationPath,
        );
        if (conflict) return [false, current] as const;
        const next = new Map(current);
        next.set(input.projectId, {
          snapshot,
          fiber: null,
          hooks,
          input: {
            cloneUrl: prepared.cloneUrl,
            destinationPath: prepared.destinationPath,
            repository: prepared.repository,
            protocol: input.protocol ?? "auto",
            ...(input.gerrit ? { gerrit: input.gerrit } : {}),
          },
        });
        return [true, next] as const;
      });
      const alreadyInProgress = new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider: input.provider ?? SourceControlProviderKind.make("unknown"),
        detail: "A clone into this destination is already in progress.",
      });
      if (!claimed) return yield* alreadyInProgress;
      // Finish or release the claim despite disconnects; a claim without a fiber cannot be cancelled or retried.
      const projectId = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* clearRetention(input.projectId);
          const entry = (yield* Ref.get(clones)).get(input.projectId);
          if (entry) yield* persist(entry);
          // Register before creation so racing thread.create and project.delete see the clone.
          const projectId = yield* hooks
            .createProject({
              projectId: input.projectId,
              title: input.title,
              workspaceRoot: prepared.destinationPath,
              createdAt: input.createdAt,
              pendingGerrit: Boolean(input.gerrit),
            })
            .pipe(
              Effect.as(input.projectId),
              // A failed clone's project still owns its empty folder after a restart
              // forgets the clone; clone for that project instead.
              Effect.catchTags({
                ProjectConflictError: (conflict) =>
                  moveClaim(input.projectId, conflict.conflictingProjectId).pipe(
                    Effect.flatMap((moved) =>
                      moved ? Effect.succeed(conflict.conflictingProjectId) : alreadyInProgress,
                    ),
                  ),
              }),
            );
          yield* publish;
          yield* launch(projectId);
          return projectId;
        }).pipe(Effect.tapError(() => remove(input.projectId))),
      );
      return {
        projectId,
        cwd: prepared.destinationPath,
        remoteUrl: prepared.remoteUrl,
        repository: prepared.repository,
      };
    },
  );

  const get: ProjectCloneTracker["Service"]["get"] = (projectId) =>
    Ref.get(clones).pipe(
      Effect.flatMap((current) => {
        const tracked = current.get(projectId);
        if (!tracked) return Effect.succeed(null);
        if (!tracked.input.gerrit) return Effect.succeed(tracked.snapshot);
        return isFenced(projectId).pipe(
          Effect.map((fenced) =>
            fenced
              ? {
                  ...tracked.snapshot,
                  phase: "failed" as const,
                  recoveryRequired: true,
                  stalled: false,
                  error: "Publication outcome is unknown. Inspect both paths before taking action.",
                }
              : tracked.snapshot,
          ),
        );
      }),
    );

  const cancel: ProjectCloneTracker["Service"]["cancel"] = Effect.fn("ProjectCloneTracker.cancel")(
    function* (projectId) {
      const current = yield* Ref.get(clones);
      const tracked = current.get(projectId);
      if (!tracked || tracked.snapshot.phase !== "running" || !tracked.fiber) return false;
      // Finish cancellation despite disconnects to avoid dead fibers behind running snapshots.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Fiber.interrupt(tracked.fiber!);
          const after = yield* get(projectId);
          if (after?.phase === "done") return false;
          if (after?.phase === "running") yield* finish(projectId, "cancelled", null);
          if (!tracked.input.gerrit)
            yield* repositories.discardClone(tracked.input.destinationPath).pipe(Effect.ignore);
          return true;
        }),
      );
    },
  );

  const retry: ProjectCloneTracker["Service"]["retry"] = Effect.fn("ProjectCloneTracker.retry")(
    function* (projectId) {
      const current = yield* Ref.get(clones);
      const tracked = current.get(projectId);
      if (
        !tracked ||
        tracked.input.gerrit ||
        tracked.snapshot.recoveryRequired ||
        !tracked.hooks ||
        (tracked.snapshot.phase !== "failed" && tracked.snapshot.phase !== "cancelled")
      ) {
        return false;
      }
      yield* repositories.discardClone(tracked.input.destinationPath);
      const startedAt = yield* nowIso;
      yield* modify(projectId, (entry) => ({
        ...entry,
        snapshot: {
          ...entry.snapshot,
          phase: "running",
          stage: "connecting",
          percent: null,
          detail: null,
          stalled: false,
          error: null,
          startedAt,
          endedAt: null,
        },
      }));
      if ((yield* get(projectId))?.recoveryRequired) return false;
      yield* launch(projectId);
      return true;
    },
  );

  const discard: ProjectCloneTracker["Service"]["discard"] = Effect.fn(
    "ProjectCloneTracker.discard",
  )(function* (projectId) {
    const current = yield* Ref.get(clones);
    const tracked = current.get(projectId);
    if (!tracked || tracked.snapshot.recoveryRequired || tracked.input.gerrit) return;
    if (tracked.fiber) yield* Fiber.interrupt(tracked.fiber);
    // Git may have finished while the interrupt was landing; the project
    // is going away either way, but a complete checkout is the user's.
    const after = yield* get(projectId);
    if (after?.recoveryRequired) return;
    if (after?.phase !== "done" && !tracked.input.gerrit) {
      yield* repositories.discardClone(tracked.input.destinationPath).pipe(Effect.ignore);
    }
    yield* clearRetention(projectId);
    yield* remove(projectId);
  });

  const stream: ProjectCloneTracker["Service"]["stream"] = Stream.callback<
    ReadonlyArray<ProjectCloneSnapshot>
  >(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* list);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((snapshots) =>
            Effect.sync(() => Queue.offerUnsafe(mailbox, snapshots)),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  // Forwarders retain the underlying operation spans.
  return ProjectCloneTracker.of({
    start: Effect.fnUntraced(function* (input, hooks) {
      return yield* locked(start(input, hooks));
    }),
    cancel: Effect.fnUntraced(function* (projectId) {
      return yield* locked(cancel(projectId));
    }),
    retry: Effect.fnUntraced(function* (projectId) {
      return yield* locked(retry(projectId));
    }),
    discard: Effect.fnUntraced(function* (projectId) {
      return yield* locked(discard(projectId));
    }),
    get,
    stream,
  });
});

const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

/**
 * Every dispatch transport (WebSocket, HTTP) runs this before normalizing so no
 * client can start a thread on an empty tree, and no attachment copies are made
 * for a command that is about to be refused.
 */
export const rejectCommandsDuringClone = Effect.fn("ProjectCloneTracker.rejectCommandsDuringClone")(
  function* (
    tracker: ProjectCloneTracker["Service"],
    command: {
      readonly type: string;
      readonly projectId?: ProjectId;
      readonly bootstrap?: unknown;
    },
  ): Effect.fn.Return<void, OrchestrationDispatchCommandError> {
    const projectId =
      command.type === "thread.create" || command.type === "project.delete"
        ? (command.projectId ?? null)
        : command.type === "thread.turn.start"
          ? bootstrapProjectId(command.bootstrap)
          : null;
    if (projectId === null) return;
    const clone = yield* tracker.get(projectId);
    if (clone === null || clone.phase === "done") return;
    if (command.type === "project.delete" && !clone.recoveryRequired && !clone.gerritPending)
      return;
    return yield* new OrchestrationDispatchCommandError({
      message:
        clone.phase === "running"
          ? "The repository is still being cloned."
          : "The repository was not cloned. Retry the clone first.",
    });
  },
);

function bootstrapProjectId(bootstrap: unknown): ProjectId | null {
  if (typeof bootstrap !== "object" || bootstrap === null) return null;
  const createThread = (bootstrap as { createThread?: { projectId?: ProjectId } }).createThread;
  return createThread?.projectId ?? null;
}

function publicationMayBeUncertain(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.squash(cause);
  return !isSourceControlRepositoryError(error) || error.operation === "publishGerritClone";
}

function describeCloneFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (isSourceControlRepositoryError(error)) return error.detail;
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The repository could not be cloned.";
}

export const layer = Layer.effect(ProjectCloneTracker, make);
