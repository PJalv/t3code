import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { makeBranchReviews } from "./GerritBranchReviews.ts";
import * as GerritHttp from "./GerritHttp.ts";

const changeId = `I${"a".repeat(40)}`;
const commit = "c".repeat(40);
const installation = "http://127.0.0.1:46139/";
const project = "native-proof-01";
const branch = "refs/heads/main";

const credentials = Redacted.make({ username: "admin", token: "secret" }) as never;

const change = {
  key: { installation, project, branch, changeId },
  number: 62,
  subject: "T3 UI auto-link probe",
  status: "NEW" as const,
  workInProgress: false,
  owner: { _account_id: 1000000 },
  currentRevision: commit as never,
  currentPatchSet: 1 as never,
  revisions: [
    {
      commit: commit as never,
      patchSet: 1 as never,
      created: "2026-10-26 11:33:00.000000000",
      uploader: { _account_id: 1000000 },
      ref: "refs/changes/62/62/1",
      kind: "REWORK" as const,
    },
  ],
};

/** Records what the adapter asked the HTTP client for, so the assertions can check the query. */
const httpStub = (input: {
  readonly changes?: ReadonlyArray<typeof change>;
  readonly fail?: boolean;
}) =>
  ({
    listChanges: (request: unknown) =>
      input.fail === true
        ? Effect.fail(new GerritHttp.GerritReadError({ reason: "forbidden" }))
        : Effect.sync(() => {
            recorded.push(request);
            return {
              changes: input.changes ?? [change],
              observation: { completeness: "complete-visible" as const, observedAt: "now" },
            };
          }),
    getChangeByNumber: () => Effect.succeed(change),
  }) as never;
const recorded: Array<unknown> = [];

const scope = { installation, project, branch, baseUrl: installation, credentials };

const adapter = (input: {
  readonly message: string;
  readonly tip: string | null;
  readonly changes?: ReadonlyArray<typeof change>;
  readonly fail?: boolean;
  readonly scope?: typeof scope | null;
}) =>
  makeBranchReviews({
    http: httpStub({
      ...(input.changes === undefined ? {} : { changes: input.changes }),
      ...(input.fail === undefined ? {} : { fail: input.fail }),
    }),
    resolve: () => Effect.succeed(input.scope === undefined ? scope : input.scope),
    git: (_cwd, args) =>
      Effect.succeed(
        args.includes("rev-parse") ? (input.tip === null ? "" : input.tip) : input.message,
      ),
    localCommits: {} as never,
  });

const request = {
  cwd: "/tmp/g3-clone-final",
  headSelector: "main",
  state: "open" as const,
  limit: 1,
};

describe("Gerrit branch review linkage", () => {
  it.effect("reports the change whose Change-Id is on the branch tip", () =>
    Effect.gen(function* () {
      recorded.length = 0;
      const reviews = adapter({
        tip: commit,
        message: `T3 UI auto-link probe\n\nChange-Id: ${changeId}\n`,
      });
      const result = yield* reviews.listChangeRequests(request);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        provider: "gerrit",
        number: 62,
        title: "T3 UI auto-link probe",
        url: `${installation}c/${project}/+/62`,
        state: "open",
        headSha: commit,
      });
      // The lookup must be scoped to this project, branch, and exact Change-Id.
      expect(recorded[0]).toMatchObject({ scope: { project, branch }, changeId });
    }),
  );

  it.effect("reports nothing when the tip carries no Change-Id", () =>
    Effect.gen(function* () {
      recorded.length = 0;
      const reviews = adapter({ tip: commit, message: "no trailer here\n" });
      expect(yield* reviews.listChangeRequests(request)).toEqual([]);
      expect(recorded).toHaveLength(0);
    }),
  );

  it.effect("reports nothing when the branch has no local tip", () =>
    Effect.gen(function* () {
      recorded.length = 0;
      const reviews = adapter({ tip: null, message: "" });
      expect(yield* reviews.listChangeRequests(request)).toEqual([]);
    }),
  );

  it.effect("reports nothing for a repository with no Gerrit binding", () =>
    Effect.gen(function* () {
      recorded.length = 0;
      const reviews = adapter({
        tip: commit,
        message: `x\n\nChange-Id: ${changeId}\n`,
        scope: null,
      });
      expect(yield* reviews.listChangeRequests(request)).toEqual([]);
      expect(recorded).toHaveLength(0);
    }),
  );

  it.effect("ignores a change that shares the Change-Id but not the project or branch", () =>
    Effect.gen(function* () {
      recorded.length = 0;
      const reviews = adapter({
        tip: commit,
        message: `x\n\nChange-Id: ${changeId}\n`,
        changes: [{ ...change, key: { ...change.key, branch: "refs/heads/other" } }],
      });
      expect(yield* reviews.listChangeRequests(request)).toEqual([]);
    }),
  );

  it.effect("does not claim a change when Gerrit refuses the read", () =>
    Effect.gen(function* () {
      recorded.length = 0;
      const reviews = adapter({
        tip: commit,
        message: `x\n\nChange-Id: ${changeId}\n`,
        fail: true,
      });
      const result = yield* Effect.result(reviews.listChangeRequests(request));
      expect(result._tag).toBe("Failure");
    }),
  );

  // git prints a trailing newline. Passing it into the next command's argv makes git reject the
  // revision as ambiguous, which used to surface as "git log failed" against a healthy checkout.
  it.effect("trims the tip revision before using it in the next git command", () =>
    Effect.gen(function* () {
      recorded.length = 0;
      const seen: Array<ReadonlyArray<string>> = [];
      const reviews = makeBranchReviews({
        http: httpStub({ changes: [change] }),
        resolve: () => Effect.succeed(scope),
        git: (_cwd, args) => {
          seen.push(args);
          return Effect.succeed(
            args.includes("rev-parse") ? `${commit}\n` : "subject\n\nChange-Id: " + changeId,
          );
        },
        localCommits: {} as never,
      });
      yield* reviews.listChangeRequests(request);
      const logArgs = seen.find((args) => args.includes("log"));
      expect(logArgs).toBeDefined();
      expect(logArgs?.at(-1)).toBe(commit);
      expect(logArgs?.at(-1)).not.toContain("\n");
    }),
  );

  // Gerrit serves a project below the installation root. Fetching from the bare installation URL
  // fails with "repository not found", and no test covered this path before, so the bug shipped.
  it.effect("fetches a patch set from the project URL, not the installation root", () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<string>> = [];
      const reviews = makeBranchReviews({
        http: httpStub({ changes: [change] }),
        resolve: () => Effect.succeed(scope),
        git: (_cwd, args) => {
          seen.push(args);
          return Effect.succeed(args.includes("rev-parse") ? `${commit}\n` : "subject");
        },
        localCommits: {} as never,
      });
      yield* reviews.checkoutChangeRequest({ ...request, reference: `#${String(change.number)}` });
      const fetchArgs = seen.find((args) => args.includes("fetch"));
      expect(fetchArgs).toBeDefined();
      expect(fetchArgs).toContain(`${scope.installation.replace(/\/+$/, "")}/a/${scope.project}`);
      expect(fetchArgs).not.toContain(scope.installation);
    }),
  );

  it.effect("refuses to create a change over HTTP", () =>
    Effect.gen(function* () {
      const reviews = adapter({ tip: commit, message: "" });
      const result = yield* Effect.result(
        reviews.createChangeRequest({
          cwd: "/tmp/g3-clone-final",
          baseRefName: "main",
          headSelector: "main",
          title: "t",
          bodyFile: "/tmp/body",
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
