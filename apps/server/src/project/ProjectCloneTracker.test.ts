import {
  GerritInstallationId,
  GerritProjectName,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  OrchestrationDispatchCommandError,
  ProjectId,
  projectCloneProgressSummary,
  type SourceControlCloneProtocol,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import { ProjectConflictError } from "./ProjectService.ts";
import { ProjectNotFoundError } from "./ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { parseGitCloneProgressLine } from "./gitCloneProgress.ts";

const projectId = ProjectId.make("project-1");
const startInput = {
  projectId,
  title: "t3code",
  createdAt: "2026-01-01T00:00:00.000Z",
  remoteUrl: "git@github.com:octocat/t3code.git",
  destinationPath: "/workspace/t3code",
};

function makeHarness(options?: {
  readonly clone?: SourceControlRepositoryService.SourceControlRepositoryService["Service"]["cloneRepository"];
  readonly prepare?: SourceControlRepositoryService.SourceControlRepositoryService["Service"]["prepareClone"];
}) {
  const created: Array<{ projectId: ProjectId; workspaceRoot: string }> = [];
  const cloned: Array<ProjectId> = [];
  const discarded: Array<string> = [];
  const hooks: ProjectCloneTracker.ProjectCloneHooks = {
    createProject: (input) =>
      Effect.sync(() => {
        created.push({ projectId: input.projectId, workspaceRoot: input.workspaceRoot });
      }),
    onCloned: (input) => Effect.sync(() => void cloned.push(input.projectId)),
  };
  const layer = ProjectCloneTracker.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(
      Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
        prepareClone:
          options?.prepare ??
          ((input) =>
            Effect.succeed({
              destinationPath: input.destinationPath,
              remoteUrl: input.remoteUrl ?? "",
              cloneUrl: input.remoteUrl ?? "",
              repository: null,
            })),
        cloneRepository:
          options?.clone ??
          ((input) =>
            Effect.succeed({
              cwd: input.destinationPath,
              remoteUrl: input.remoteUrl ?? "",
              repository: null,
            })),
        discardClone: (destination) => Effect.sync(() => void discarded.push(destination)),
      }),
    ),
  );
  return { layer, hooks, created, cloned, discarded };
}

describe("ProjectCloneTracker", () => {
  it.live("preserves a failed private attempt and destination across tracker restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "gerrit-recovery-restart-" });
        const stage = path.join(parent, ".t3-gerrit-clone-stage");
        const checkout = path.join(stage, "checkout");
        const destination = path.join(parent, "destination");
        yield* fs.makeDirectory(checkout, { recursive: true });
        yield* fs.makeDirectory(destination);
        yield* fs.writeFileString(path.join(checkout, "recovery-marker"), "preserve attempt");
        yield* fs.writeFileString(path.join(destination, "user-marker"), "do not replace");
        const callbackReturned = Deferred.makeUnsafe<void>();
        const failure = new SourceControlRepositoryError({
          operation: "publishGerritClone",
          provider: SourceControlProviderKind.make("gerrit"),
          detail: "publication failed",
        });
        const repositories = Layer.mock(
          SourceControlRepositoryService.SourceControlRepositoryService,
        )({
          prepareClone: (input) =>
            Effect.succeed({
              destinationPath: input.destinationPath,
              remoteUrl: "https://review.example/team/project",
              cloneUrl: "https://review.example/team/project",
              repository: null,
            }),
          cloneRepository: (_input, options) =>
            (
              options?.onRecoveryPath?.(stage, "https://review.example/team/project") ?? Effect.void
            ).pipe(
              Effect.andThen(options?.onPublicationFailure?.(failure) ?? Effect.void),
              Effect.andThen(Deferred.succeed(callbackReturned, undefined)),
              Effect.andThen(Effect.fail(failure)),
            ),
          discardClone: () => Effect.die("must not delete either path"),
        });
        const hooks: ProjectCloneTracker.ProjectCloneHooks = {
          createProject: () => Effect.void,
          onCloned: () => Effect.void,
        };
        yield* Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const tracker = yield* ProjectCloneTracker.make;
              yield* tracker.start(
                {
                  ...startInput,
                  destinationPath: destination,
                  gerrit: {
                    installation: GerritInstallationId.make("https://review.example/"),
                    project: GerritProjectName.make("team/project"),
                  },
                },
                hooks,
              );
              yield* Deferred.await(callbackReturned);
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const tracker = yield* ProjectCloneTracker.make;
              expect(yield* tracker.get(projectId)).toMatchObject({
                phase: "failed",
                recoveryRequired: true,
                recoveryPath: stage,
                destinationPath: destination,
              });
              expect(yield* tracker.retry(projectId)).toBe(false);
              yield* tracker.discard(projectId);
              expect(yield* fs.readFileString(path.join(checkout, "recovery-marker"))).toBe(
                "preserve attempt",
              );
              expect(yield* fs.readFileString(path.join(destination, "user-marker"))).toBe(
                "do not replace",
              );
            }),
          );
        }).pipe(Effect.provide(Layer.merge(repositories, SqlitePersistence.layerMemory)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("fences a live publisher across concurrent cancellation and restart", () => {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const cancelling = Deferred.makeUnsafe<void>();
    const published = Deferred.makeUnsafe<void>();
    let deletions = 0;
    const repositories = Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      prepareClone: (input) =>
        Effect.succeed({
          destinationPath: input.destinationPath,
          remoteUrl: "https://review.example/team/project",
          cloneUrl: "https://review.example/team/project",
          repository: null,
        }),
      cloneRepository: (input, options) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* (
              options?.onRecoveryPath?.(
                "/workspace/attempt-1",
                "https://review.example/team/project",
              ) ?? Effect.void
            );
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            yield* (
              options?.onRecoveryPath?.(
                "/workspace/attempt-2",
                "https://review.example/team/project",
              ) ?? Effect.void
            );
            yield* options?.onPublished?.("https://review.example/team/project") ?? Effect.void;
            yield* Deferred.succeed(published, undefined);
            return {
              cwd: input.destinationPath,
              remoteUrl: "https://review.example/team/project",
              repository: null,
            };
          }),
        ),
      discardClone: () =>
        Effect.sync(() => {
          deletions++;
        }),
    });
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      createProject: () => Effect.void,
      onCloned: () => Effect.void,
    };
    return Effect.scoped(
      Effect.gen(function* () {
        const first = yield* ProjectCloneTracker.make;
        yield* first.start(
          {
            ...startInput,
            gerrit: {
              installation: GerritInstallationId.make("https://review.example/"),
              project: GerritProjectName.make("team/project"),
            },
          },
          hooks,
        );
        yield* Deferred.await(started);
        const cancellingFiber = yield* Deferred.succeed(cancelling, undefined).pipe(
          Effect.andThen(first.cancel(projectId)),
          Effect.forkChild,
        );
        yield* Deferred.await(cancelling);
        const restarted = yield* ProjectCloneTracker.make;
        expect(yield* restarted.get(projectId)).toMatchObject({
          recoveryRequired: true,
          phase: "failed",
        });
        expect(yield* restarted.retry(projectId)).toBe(false);
        yield* restarted.discard(projectId);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(published);
        yield* Fiber.join(cancellingFiber);
        expect(yield* first.get(projectId)).toMatchObject({
          recoveryRequired: true,
          phase: "failed",
        });
        const restartedAgain = yield* ProjectCloneTracker.make;
        expect(yield* restartedAgain.get(projectId)).toMatchObject({
          recoveryRequired: true,
          recoveryPaths: ["/workspace/attempt-1", "/workspace/attempt-2"],
        });
        expect(yield* restartedAgain.retry(projectId)).toBe(false);
        yield* restartedAgain.discard(projectId);
        expect(deletions).toBe(0);
      }),
    ).pipe(Effect.provide(Layer.merge(repositories, SqlitePersistence.layerMemory)));
  });

  it.effect("restores an interrupted Gerrit clone as uncertain without replay or deletion", () => {
    const started = Deferred.makeUnsafe<void>();
    let clones = 0;
    let deletions = 0;
    const repositories = Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      prepareClone: (input) =>
        Effect.succeed({
          destinationPath: input.destinationPath,
          remoteUrl: "https://review.example/team/project",
          cloneUrl: "https://user:secret@review.example/team/project",
          repository: null,
        }),
      cloneRepository: (_input, options) =>
        Effect.sync(() => {
          clones++;
        }).pipe(
          Effect.andThen(
            options?.onRecoveryPath?.(
              "/workspace/.t3-gerrit-clone-1",
              "https://review.example/team/project",
            ) ?? Effect.void,
          ),
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
        ),
      discardClone: () =>
        Effect.sync(() => {
          deletions++;
        }),
    });
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      createProject: () => Effect.void,
      onCloned: () => Effect.void,
    };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let running = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* ProjectCloneTracker.make;
          yield* tracker.start(
            {
              ...startInput,
              gerrit: {
                installation: GerritInstallationId.make("https://review.example/"),
                project: GerritProjectName.make("team/project"),
              },
            },
            hooks,
          );
          yield* Deferred.await(started);
          const rows = yield* sql<{ snapshot: string }>`SELECT snapshot FROM gerrit_pending_clones`;
          running = rows[0]!.snapshot;
          expect(running).not.toContain("secret");
        }),
      );
      // Restore the last committed running row to model an abrupt process loss.
      yield* sql`UPDATE gerrit_pending_clones SET snapshot = ${running}`;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* ProjectCloneTracker.make;
          expect(yield* tracker.get(projectId)).toMatchObject({
            phase: "failed",
            recoveryRequired: true,
            recoveryPath: "/workspace/.t3-gerrit-clone-1",
          });
          expect(yield* tracker.retry(projectId)).toBe(false);
          yield* tracker.discard(projectId);
          expect(yield* tracker.get(projectId)).not.toBeNull();
          expect(clones).toBe(1);
          expect(deletions).toBe(0);
        }),
      );
    }).pipe(Effect.provide(repositories.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });
  it.effect("creates the project first and reports the clone through the stream", () => {
    const release = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.gen(function* () {
          yield* (
            options?.onProgress?.({ stage: "receiving", percent: 40, detail: "1 MiB" }) ??
              Effect.void
          );
          yield* Deferred.await(release);
          return {
            cwd: input.destinationPath,
            remoteUrl: "https://review.example/a/project",
            repository: null,
          };
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const collected = yield* tracker.stream.pipe(
        Stream.takeUntil((clones) => clones[0]?.phase === "done"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const result = yield* tracker.start(startInput, harness.hooks);
      expect(result.cwd).toBe("/workspace/t3code");
      expect(harness.created).toEqual([{ projectId, workspaceRoot: "/workspace/t3code" }]);

      yield* Effect.yieldNow;
      const running = yield* tracker.get(projectId);
      expect(running).toMatchObject({ phase: "running", stage: "receiving", percent: 40 });

      yield* Deferred.succeed(release, undefined);
      const lists = yield* Fiber.join(collected);
      const final = lists.at(-1)?.[0];
      expect(final).toMatchObject({
        phase: "done",
        percent: 100,
        remoteUrl: "https://review.example/a/project",
      });
      expect(harness.cloned).toEqual([projectId]);

      yield* TestClock.adjust("31 seconds");
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("flags a clone stalled when git goes quiet and clears it when git speaks", () => {
    const release = Deferred.makeUnsafe<void>();
    const resumed = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.gen(function* () {
          const report = options?.onProgress ?? (() => Effect.void);
          yield* report({ stage: "receiving", percent: 24, detail: "168.80 MiB | 20.69 MiB/s" });
          yield* Deferred.await(resumed);
          yield* report({ stage: "receiving", percent: 25, detail: "170.00 MiB | 1.00 MiB/s" });
          yield* Deferred.await(release);
          return { cwd: input.destinationPath, remoteUrl: input.remoteUrl ?? "", repository: null };
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.stalled).toBe(false);

      yield* TestClock.adjust("19 seconds");
      expect((yield* tracker.get(projectId))?.stalled).toBe(false);
      yield* TestClock.adjust("1 second");
      const stalled = yield* tracker.get(projectId);
      expect(stalled).toMatchObject({ stalled: true, percent: 24 });
      expect(projectCloneProgressSummary(stalled!)).toBe("Receiving objects · 24% · Stalled");

      yield* Deferred.succeed(resumed, undefined);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(projectId)).toMatchObject({ stalled: false, percent: 25 });

      yield* TestClock.adjust("20 seconds");
      expect((yield* tracker.get(projectId))?.stalled).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(projectId)).toMatchObject({ phase: "done", stalled: false });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a failed clone with git's own explanation and retries it", () => {
    const protocols: Array<SourceControlCloneProtocol | undefined> = [];
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.suspend(() => {
          protocols.push(input.protocol);
          return protocols.length === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "fatal: repository not found",
                }),
              )
            : (options?.onPublished?.(input.remoteUrl ?? "") ?? Effect.void).pipe(
                Effect.as({
                  cwd: input.destinationPath,
                  remoteUrl: input.remoteUrl ?? "",
                  repository: null,
                }),
              );
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start({ ...startInput, protocol: "ssh" }, harness.hooks);
      yield* Effect.yieldNow;
      const failed = yield* tracker.get(projectId);
      expect(failed).toMatchObject({ phase: "failed", error: "fatal: repository not found" });

      expect(yield* tracker.retry(projectId)).toBe(true);
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(protocols).toEqual(["ssh", "ssh"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("flags a clone stalled when git goes quiet and clears it when git speaks", () => {
    const release = Deferred.makeUnsafe<void>();
    const resumed = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.gen(function* () {
          const report = options?.onProgress ?? (() => Effect.void);
          yield* report({ stage: "receiving", percent: 24, detail: "168.80 MiB | 20.69 MiB/s" });
          yield* Deferred.await(resumed);
          yield* report({ stage: "receiving", percent: 25, detail: "170.00 MiB | 1.00 MiB/s" });
          yield* Deferred.await(release);
          return { cwd: input.destinationPath, remoteUrl: input.remoteUrl ?? "", repository: null };
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.stalled).toBe(false);

      yield* TestClock.adjust("19 seconds");
      expect((yield* tracker.get(projectId))?.stalled).toBe(false);
      yield* TestClock.adjust("1 second");
      const stalled = yield* tracker.get(projectId);
      expect(stalled).toMatchObject({ stalled: true, percent: 24 });
      expect(projectCloneProgressSummary(stalled!)).toBe("Receiving objects · 24% · Stalled");

      yield* Deferred.succeed(resumed, undefined);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(projectId)).toMatchObject({ stalled: false, percent: 25 });

      yield* TestClock.adjust("20 seconds");
      expect((yield* tracker.get(projectId))?.stalled).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(projectId)).toMatchObject({ phase: "done", stalled: false });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a failed Gerrit clone without replaying it", () => {
    const identity = {
      installation: GerritInstallationId.make("https://review.example/"),
      project: GerritProjectName.make("team/project"),
    };
    const identities: unknown[] = [];
    let attempts = 0;
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.suspend(() => {
          attempts += 1;
          identities.push(input.gerrit);
          return attempts === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "fatal: repository not found",
                }),
              )
            : (options?.onPublished?.(input.remoteUrl ?? "") ?? Effect.void).pipe(
                Effect.as({
                  cwd: input.destinationPath,
                  remoteUrl: input.remoteUrl ?? "",
                  repository: null,
                }),
              );
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start({ ...startInput, gerrit: identity }, harness.hooks);
      yield* Effect.yieldNow;
      const failed = yield* tracker.get(projectId);
      expect(failed).toMatchObject({ phase: "failed", error: "fatal: repository not found" });

      expect(yield* tracker.retry(projectId)).toBe(false);
      expect(harness.discarded).toEqual([]);
      expect((yield* tracker.get(projectId))?.phase).toBe("failed");
      expect(attempts).toBe(1);
      expect(identities).toEqual([identity]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("preserves a completed Gerrit checkout when hook setup fails", () => {
    let prepared = false;
    const identity = {
      installation: GerritInstallationId.make("https://review.example/"),
      project: GerritProjectName.make("team/project"),
    };
    const harness = makeHarness({
      prepare: (input) =>
        Effect.suspend(() => {
          if (prepared)
            return Effect.fail(
              new SourceControlRepositoryError({
                operation: "cloneRepository",
                provider: SourceControlProviderKind.make("gerrit"),
                detail: "Destination path already exists and is not empty.",
              }),
            );
          prepared = true;
          return Effect.succeed({
            destinationPath: input.destinationPath,
            cloneUrl: input.remoteUrl ?? "",
            remoteUrl: input.remoteUrl ?? "",
            repository: null,
          });
        }),
      clone: (_input, options) =>
        (
          options?.onRecoveryPath?.("/workspace/.stage", "https://review.example/a/project") ??
          Effect.void
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new SourceControlRepositoryError({
                operation: "installGerritCloneHook",
                provider: SourceControlProviderKind.make("gerrit"),
                detail: "Checkout preserved.",
              }),
            ),
          ),
        ),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const failed = yield* tracker.stream.pipe(
        Stream.filter((clones) => clones[0]?.phase === "failed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* tracker.start({ ...startInput, gerrit: identity }, harness.hooks);
      yield* Fiber.join(failed);
      expect(yield* tracker.get(projectId)).toMatchObject({
        error: "Checkout preserved.",
        recoveryPath: "/workspace/.stage",
        remoteUrl: "https://review.example/a/project",
      });
      expect(yield* tracker.retry(projectId)).toBe(false);
      expect(harness.discarded).toEqual([]);
      yield* tracker.discard(projectId);
      expect(harness.discarded).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not mark publication done if project validation fails", () => {
    const callbackReturned = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (input, options) =>
        (options?.onPublished?.("https://review.example/team/project") ?? Effect.void).pipe(
          Effect.andThen(Deferred.succeed(callbackReturned, undefined)),
          Effect.as({
            cwd: input.destinationPath,
            remoteUrl: "https://review.example/team/project",
            repository: null,
          }),
        ),
    });
    const hooks = {
      ...harness.hooks,
      validatePublished: () => Effect.fail(new ProjectNotFoundError({ projectId })),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(
        {
          ...startInput,
          gerrit: {
            installation: GerritInstallationId.make("https://review.example/"),
            project: GerritProjectName.make("team/project"),
          },
        },
        hooks,
      );
      yield* Deferred.await(callbackReturned);
      expect(yield* tracker.get(projectId)).toMatchObject({
        phase: "failed",
        recoveryRequired: true,
      });
      expect(yield* tracker.retry(projectId)).toBe(false);
      expect(harness.cloned).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("records publication before cancellation can report an incomplete clone", () => {
    const published = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (_input, options) => {
        expect(options?.allowExistingGerritDestination).not.toBe(true);
        return (options?.onPublished?.("https://review.example/a/project") ?? Effect.void).pipe(
          Effect.andThen(Deferred.succeed(published, undefined)),
          Effect.andThen(Effect.never),
        );
      },
    });
    const identity = {
      installation: GerritInstallationId.make("https://review.example/"),
      project: GerritProjectName.make("project"),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start({ ...startInput, gerrit: identity }, harness.hooks);
      yield* Deferred.await(published);
      expect(yield* tracker.get(projectId)).toMatchObject({
        phase: "done",
        remoteUrl: "https://review.example/a/project",
      });
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(harness.discarded).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports cancellation as unapplied if publication wins the interrupt race", () => {
    const started = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (_input, options) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(
            () => options?.onPublished?.("https://review.example/a/project") ?? Effect.void,
          ),
        ),
    });
    const identity = {
      installation: GerritInstallationId.make("https://review.example/"),
      project: GerritProjectName.make("team/project"),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start({ ...startInput, gerrit: identity }, harness.hooks);
      yield* Deferred.await(started);
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(yield* tracker.get(projectId)).toMatchObject({ phase: "done" });
      expect(harness.discarded).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "persists publication failure before the callback returns and blocks recovery actions",
    () => {
      const callbackReturned = Deferred.makeUnsafe<void>();
      const harness = makeHarness({
        clone: (_input, options) => {
          const failure = new SourceControlRepositoryError({
            operation: "publishGerritClone",
            provider: SourceControlProviderKind.make("gerrit"),
            detail: "unknown",
          });
          return (options?.onPublicationFailure?.(failure) ?? Effect.void).pipe(
            Effect.andThen(Deferred.succeed(callbackReturned, undefined)),
            Effect.andThen(Effect.never),
          );
        },
      });
      return Effect.gen(function* () {
        const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
        yield* tracker.start(
          {
            ...startInput,
            gerrit: {
              installation: GerritInstallationId.make("https://review.example/"),
              project: GerritProjectName.make("team/project"),
            },
          },
          harness.hooks,
        );
        yield* Deferred.await(callbackReturned);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          snapshot: string;
        }>`SELECT snapshot FROM gerrit_pending_clones WHERE project_id = ${projectId}`;
        expect(rows[0]?.snapshot).toContain('"recoveryRequired":true');
        expect(yield* tracker.get(projectId)).toMatchObject({
          phase: "failed",
          recoveryRequired: true,
        });
        expect(yield* tracker.retry(projectId)).toBe(false);
        yield* tracker.discard(projectId);
        expect(yield* tracker.get(projectId)).not.toBeNull();
        expect(harness.discarded).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("treats a lost publication failure callback as uncertain", () => {
    const failed = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: () =>
        Effect.fail(
          new SourceControlRepositoryError({
            operation: "publishGerritClone",
            provider: SourceControlProviderKind.make("gerrit"),
            detail: "unknown",
          }),
        ),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const snapshots = yield* tracker.stream.pipe(
        Stream.filter((items) => items[0]?.recoveryRequired === true),
        Stream.take(1),
        Stream.runCollect,
        Effect.andThen(Deferred.succeed(failed, undefined)),
        Effect.forkChild,
      );
      yield* tracker.start(
        {
          ...startInput,
          gerrit: {
            installation: GerritInstallationId.make("https://review.example/"),
            project: GerritProjectName.make("team/project"),
          },
        },
        harness.hooks,
      );
      yield* Deferred.await(failed);
      expect(yield* tracker.retry(projectId)).toBe(false);
      yield* tracker.discard(projectId);
      expect(yield* tracker.get(projectId)).toMatchObject({ recoveryRequired: true });
      yield* Fiber.join(snapshots);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("registers Gerrit clones without permitting an existing destination", () => {
    const started = Deferred.makeUnsafe<void>();
    let pendingGerrit = false;
    let allowExisting: boolean | undefined;
    const harness = makeHarness({
      clone: (_input, options) => {
        allowExisting = options?.allowExistingGerritDestination;
        return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      },
    });
    const hooks = {
      ...harness.hooks,
      createProject: (input: Parameters<typeof harness.hooks.createProject>[0]) =>
        Effect.sync(() => {
          pendingGerrit = input.pendingGerrit;
        }),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(
        {
          ...startInput,
          gerrit: {
            installation: GerritInstallationId.make("https://review.example/"),
            project: GerritProjectName.make("team/project"),
          },
        },
        hooks,
      );
      yield* Deferred.await(started);
      expect(pendingGerrit).toBe(true);
      expect(allowExisting).not.toBe(true);
      expect(yield* tracker.cancel(projectId)).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not discard a selected Gerrit destination on cancellation", () => {
    const started = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (_input, options) =>
        (
          options?.onRecoveryPath?.(
            "/workspace/.t3-gerrit-clone-1",
            "https://review.example/a/project",
          ) ?? Effect.void
        ).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
    });
    const identity = {
      installation: GerritInstallationId.make("https://review.example/"),
      project: GerritProjectName.make("team/project"),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start({ ...startInput, gerrit: identity }, harness.hooks);
      yield* Deferred.await(started);
      expect(yield* tracker.cancel(projectId)).toBe(true);
      expect(yield* tracker.get(projectId)).toMatchObject({
        phase: "failed",
        recoveryRequired: true,
        recoveryPath: "/workspace/.t3-gerrit-clone-1",
        remoteUrl: "https://review.example/a/project",
      });
      expect(harness.discarded).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("cancel interrupts the clone and removes the partial checkout", () => {
    const harness = makeHarness({ clone: () => Effect.never });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;

      expect(yield* tracker.cancel(projectId)).toBe(true);
      expect((yield* tracker.get(projectId))?.phase).toBe("cancelled");
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(yield* tracker.retry(projectId)).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a cancel that lands after git finished keeps the checkout", () => {
    const gate = Deferred.makeUnsafe<void>();
    const harness = makeHarness();
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      onCloned: () => Deferred.await(gate),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(harness.discarded).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("hands git the credential-bearing URL while snapshots carry the redacted one", () => {
    const cloneUrls: Array<string> = [];
    const harness = makeHarness({
      clone: (input) =>
        Effect.sync(() => {
          cloneUrls.push(input.remoteUrl ?? "");
          return { cwd: input.destinationPath, remoteUrl: "", repository: null };
        }),
    });
    const layer = ProjectCloneTracker.layer.pipe(
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          prepareClone: (input) =>
            Effect.succeed({
              destinationPath: input.destinationPath,
              remoteUrl: "https://github.com/octocat/t3code.git",
              cloneUrl: "https://user:s3cret@github.com/octocat/t3code.git",
              repository: null,
            }),
          cloneRepository: (input) =>
            Effect.sync(() => {
              cloneUrls.push(input.remoteUrl ?? "");
              return { cwd: input.destinationPath, remoteUrl: "", repository: null };
            }),
          discardClone: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const result = yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect(result.remoteUrl).toBe("https://github.com/octocat/t3code.git");
      expect(cloneUrls).toEqual(["https://user:s3cret@github.com/octocat/t3code.git"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("discard forgets a project's clone when the project is deleted", () => {
    const harness = makeHarness({ clone: () => Effect.never });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      yield* tracker.discard(projectId);
      expect(yield* tracker.get(projectId)).toBeNull();
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("releases the claim when project creation fails", () => {
    const harness = makeHarness();
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      createProject: () =>
        Effect.fail(new OrchestrationDispatchCommandError({ message: "workspace root exists" })),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const error = yield* Effect.flip(tracker.start(startInput, hooks));
      expect(error.message).toContain("workspace root exists");
      expect(yield* tracker.get(projectId)).toBeNull();
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clones for the project that already owns the empty destination", () => {
    const owner = ProjectId.make("project-stranded");
    const harness = makeHarness();
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      createProject: (input) =>
        Effect.fail(
          new ProjectConflictError({
            projectId: input.projectId,
            workspaceRoot: input.workspaceRoot,
            conflictingProjectId: owner,
          }),
        ),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const result = yield* tracker.start(startInput, hooks);
      expect(result.projectId).toBe(owner);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(owner)).toMatchObject({
        projectId: owner,
        destinationPath: "/workspace/t3code",
        phase: "done",
      });
      expect(harness.cloned).toEqual([owner]);
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a fresh clone into a failed clone's destination supersedes it", () => {
    let attempts = 0;
    const harness = makeHarness({
      clone: (input) =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "fatal: repository not found",
                }),
              )
            : Effect.succeed({
                cwd: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                repository: null,
              }),
        ),
    });
    // The failed clone's project still owns the destination.
    const conflictingHooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      createProject: (input) =>
        Effect.fail(
          new ProjectConflictError({
            projectId: input.projectId,
            workspaceRoot: input.workspaceRoot,
            conflictingProjectId: projectId,
          }),
        ),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("failed");

      const second = ProjectId.make("project-2");
      const result = yield* tracker.start({ ...startInput, projectId: second }, conflictingHooks);
      expect(result.projectId).toBe(projectId);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(yield* tracker.get(second)).toBeNull();
      expect(harness.cloned).toEqual([projectId]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses a second clone into a destination that is still cloning", () => {
    const harness = makeHarness({ clone: () => Effect.never });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      const error = yield* Effect.flip(
        tracker.start({ ...startInput, projectId: ProjectId.make("project-2") }, harness.hooks),
      );
      expect(error.message).toContain("already in progress");
      expect((yield* tracker.get(projectId))?.phase).toBe("running");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not create a project when the clone cannot be prepared", () => {
    const harness = makeHarness();
    const layer = ProjectCloneTracker.layer.pipe(
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          prepareClone: () =>
            Effect.fail(
              new SourceControlRepositoryError({
                operation: "cloneRepository",
                provider: SourceControlProviderKind.make("unknown"),
                detail: "Destination path already exists and is not empty.",
              }),
            ),
        }),
      ),
    );
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const error = yield* Effect.flip(tracker.start(startInput, harness.hooks));
      expect(error.message).toContain("not empty");
      expect(harness.created).toEqual([]);
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(layer));
  });
});

describe("parseGitCloneProgressLine", () => {
  it("parses git's transfer counters and ignores other output", () => {
    expect(
      parseGitCloneProgressLine("Receiving objects:  45% (4500/10000), 12.30 MiB | 5.00 MiB/s"),
    ).toEqual({ stage: "receiving", percent: 45, detail: "12.30 MiB | 5.00 MiB/s" });
    expect(
      parseGitCloneProgressLine("Receiving objects: 100% (5/5), 40.00 MiB | 1.40 MiB/s, done."),
    ).toEqual({ stage: "receiving", percent: 100, detail: "40.00 MiB | 1.40 MiB/s" });
    expect(parseGitCloneProgressLine("Resolving deltas: 100% (700/700), done.")).toEqual({
      stage: "resolving",
      percent: 100,
      detail: null,
    });
    expect(parseGitCloneProgressLine("remote: Compressing objects:  12% (3/25)")).toEqual({
      stage: "counting",
      percent: 12,
      detail: null,
    });
    expect(parseGitCloneProgressLine("Updating files:  78% (2104/2700)")).toEqual({
      stage: "checkout",
      percent: 78,
      detail: null,
    });
    expect(
      parseGitCloneProgressLine("Filtering content:  66% (2/3), 11.92 MiB | 1009.00 KiB/s"),
    ).toEqual({ stage: "checkout", percent: 66, detail: "11.92 MiB | 1009.00 KiB/s" });
    expect(parseGitCloneProgressLine("remote: Enumerating objects: 10, done.")).toEqual({
      stage: "counting",
      percent: null,
      detail: null,
    });
    expect(parseGitCloneProgressLine("Cloning into 't3code'...")).toBeNull();
    expect(parseGitCloneProgressLine("fatal: repository not found")).toBeNull();
  });
});
