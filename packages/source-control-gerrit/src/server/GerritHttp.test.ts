// @effect-diagnostics-next-line nodeBuiltinImport:off -- A loopback fixture exercises the real HTTP transport.
import * as NodeHttp from "node:http";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import {
  GerritReviewInput,
  GerritChangeKey,
  GerritChangeNumber,
  GerritInstallationId,
  GerritRepositoryScope,
  GitCommitOid,
} from "@t3tools/contracts";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as GerritHttp from "./GerritHttp.ts";

const decodeGerritInstallationId = Schema.decodeEffect(GerritInstallationId);
const decodeGerritRepositoryScope = Schema.decodeEffect(GerritRepositoryScope);
const decodeGerritChangeKey = Schema.decodeEffect(GerritChangeKey);
const decodeGerritChangeNumber = Schema.decodeEffect(GerritChangeNumber);
const decodeGitCommitOid = Schema.decodeEffect(GitCommitOid);
const decodeReviewInput = Schema.decodeUnknownEffect(GerritReviewInput);

const credentials = Redacted.make({ username: "FixtureUser", token: "fixture-private-token" });
const oid = "a".repeat(40);
const oldOid = "b".repeat(40);
const changeId = `I${"c".repeat(40)}`;
const person = {
  name: "Unregistered",
  email: "git@example.invalid",
  date: "2026-10-22 00:00:00.000000000",
  tz: 0,
};
const change = (number = 1) => ({
  project: "Team/Repo",
  branch: "Release/Next",
  change_id: changeId,
  _number: number,
  subject: "Read fixture",
  status: "NEW",
  owner: {},
  current_revision: oid,
  revisions: {
    [oid]: {
      _number: 3,
      commit: { parents: [{ commit: oldOid }], author: person, committer: person },
    },
    [oldOid]: { _number: 1, commit: { parents: [], author: person, committer: person } },
  },
  labels: { "Custom-Label": { pluginField: ["ignored"] } },
});
const json = (response: NodeHttp.ServerResponse, value: unknown) => {
  response.setHeader("Content-Type", "application/json");
  response.end(`)]}'\n${JSON.stringify(value)}`);
};
const fixture = Effect.fn("GerritHttp.test.fixture")(function* (handler: NodeHttp.RequestListener) {
  const server = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer(handler);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  const installation = yield* decodeGerritInstallationId(
    `http://127.0.0.1:${address.port}/Review/`,
  );
  const scope = yield* decodeGerritRepositoryScope({
    installation,
    project: "Team/Repo",
    branch: "Release/Next",
  });
  return { installation, scope, credentials };
});
const testLayer = GerritHttp.layer.pipe(Layer.provide(FetchHttpClient.layer));

it.live(
  "searches project names with the requested text and keeps authenticated URLs out of results",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const auth = yield* fixture((request, response) => {
        requests.push(request.url ?? "");
        json(response, { "Team/Test": {}, "team/testing": {}, "Team/Other": {} });
      });
      const http = yield* GerritHttp.GerritHttp;
      const projects = yield* http.searchProjects({ ...auth, query: "test" });
      expect(projects).toEqual(["Team/Test", "team/testing"]);
      const url = new URL(requests[0]!, "http://fixture.invalid");
      expect(url.pathname).toBe("/Review/a/projects/");
      expect(url.searchParams.get("m")).toBe("test");
      expect(requests[0]).not.toContain("fixture-private-token");
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "searches change-scoped reviewer suggestions without including groups or accounts without IDs",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const auth = yield* fixture((request, response) => {
        requests.push(request.url ?? "");
        if (request.url?.includes("suggest_reviewers"))
          json(response, [
            {
              account: {
                _account_id: 7,
                name: "Jane",
                username: "jane",
                email: "jane@example.invalid",
              },
              count: 1,
            },
            { group: { id: "group", name: "Team" }, count: 5 },
            { account: { name: "Redacted" }, count: 1 },
          ]);
        else json(response, change());
      });
      const http = yield* GerritHttp.GerritHttp;
      const input = yield* reviewInput(auth.installation);
      const rows = yield* http.review.suggestReviewers({
        ...auth,
        ...input,
        query: "Jane + @example",
        state: "CC",
      });
      expect(rows).toEqual([
        { _account_id: 7, name: "Jane", username: "jane", email: "jane@example.invalid" },
      ]);
      const count = requests.length;
      const wrongInput = { ...input, number: yield* decodeGerritChangeNumber(2) };
      const mismatch = yield* http.review
        .suggestReviewers({ ...auth, ...wrongInput, query: "Jane", state: "REVIEWER" })
        .pipe(Effect.flip);
      expect(mismatch.reason).toBe("identity-mismatch");
      expect(requests).toHaveLength(count + 1);
      const url = new URL(
        requests.find((entry) => entry.includes("suggest_reviewers"))!,
        "http://fixture.invalid",
      );
      expect(url.pathname).toBe("/Review/a/changes/1/suggest_reviewers");
      expect(url.searchParams.get("q")).toBe("Jane + @example");
      expect(url.searchParams.get("n")).toBe("20");
      expect(url.searchParams.has("exclude-groups")).toBe(true);
      expect(url.searchParams.get("reviewer-state")).toBe("CC");
    }).pipe(Effect.provide(testLayer)),
);

it.live("propagates reviewer suggestion read errors and omits group-only results", () =>
  Effect.gen(function* () {
    let fail = false;
    const auth = yield* fixture((request, response) => {
      if (!request.url?.includes("suggest_reviewers")) return json(response, change());
      if (fail) {
        response.statusCode = 403;
        response.end();
        return;
      }
      json(response, [{ group: { id: "group" }, count: 1 }, { account: {} }]);
    });
    const http = yield* GerritHttp.GerritHttp;
    const input = yield* reviewInput(auth.installation);
    expect(
      yield* http.review.suggestReviewers({ ...auth, ...input, query: "g", state: "REVIEWER" }),
    ).toEqual([]);
    fail = true;
    expect(
      (yield* http.review
        .suggestReviewers({ ...auth, ...input, query: "g", state: "REVIEWER" })
        .pipe(Effect.flip))._tag,
    ).toBe("GerritReadError");
  }).pipe(Effect.provide(testLayer)),
);

it.live("verifies self, version and native capabilities only under the authenticated mount", () =>
  Effect.gen(function* () {
    const requests: Array<{ path: string; method: string | undefined; auth: string | undefined }> =
      [];
    const auth = yield* fixture((request, response) => {
      requests.push({
        path: request.url ?? "",
        method: request.method,
        auth: request.headers.authorization,
      });
      if (request.url?.endsWith("capabilities"))
        json(response, { queryLimit: { min: 0, max: 500 }, customPlugin: true });
      else if (request.url?.endsWith("version")) json(response, "3.13.0-custom");
      else json(response, { _account_id: 42 });
    });
    const http = yield* GerritHttp.GerritHttp;
    const result = yield* http.verify(auth);
    expect(result.account).toEqual({ _account_id: 42 });
    expect(result.version).toEqual({ kind: "observed", value: "3.13.0-custom" });
    expect(result.capabilities).toEqual({
      kind: "observed",
      values: { queryLimit: { min: 0, max: 500 }, customPlugin: true },
    });
    expect(result.compatibility).toBe("unverified");
    expect(requests.map((r) => r.path)).toEqual([
      "/Review/a/accounts/self",
      "/Review/a/config/server/version",
      "/Review/a/accounts/self/capabilities",
    ]);
    expect(
      requests.every(
        (r) =>
          r.method === "GET" &&
          r.auth === `Basic ${Buffer.from("FixtureUser:fixture-private-token").toString("base64")}`,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-private-token");
  }).pipe(Effect.provide(testLayer)),
);

it.live.each(["BATCH", "INTERACTIVE"])(
  "preserves native %s priority with range and boolean capabilities",
  (priority) =>
    Effect.gen(function* () {
      const values = { priority, queryLimit: { min: 0, max: 500 }, createProject: true };
      const auth = yield* fixture((request, response) => {
        if (request.url?.endsWith("capabilities")) json(response, values);
        else if (request.url?.endsWith("version")) json(response, "3.13.0-custom");
        else json(response, { _account_id: 42 });
      });
      const result = yield* (yield* GerritHttp.GerritHttp).verify(auth);
      expect(result.capabilities).toEqual({ kind: "observed", values });
      expect(result.compatibility).toBe("unverified");
    }).pipe(Effect.provide(testLayer)),
);

it.live.each([{ priority: "UNSUPPORTED" }, { createProject: "BATCH" }, { priority: true }])(
  "keeps unsupported capability values %j unknown",
  (unsupported) =>
    Effect.gen(function* () {
      const auth = yield* fixture((request, response) => {
        if (request.url?.endsWith("capabilities"))
          json(response, { queryLimit: { min: 0, max: 500 }, createProject: true, ...unsupported });
        else if (request.url?.endsWith("version")) json(response, "3.13.0-custom");
        else json(response, { _account_id: 42 });
      });
      const result = yield* (yield* GerritHttp.GerritHttp).verify(auth);
      expect(result.capabilities).toMatchObject({
        kind: "unknown",
        error: { _tag: "GerritReadError", reason: "invalid-response" },
      });
      expect(result.compatibility).toBe("unverified");
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "reads current and historical patch sets without inventing Git accounts or label verdicts",
  () =>
    Effect.gen(function* () {
      const auth = yield* fixture((_request, response) => json(response, change()));
      const http = yield* GerritHttp.GerritHttp;
      const result = yield* http.getChange({
        ...auth,
        key: yield* decodeGerritChangeKey({ ...auth.scope, changeId }),
        number: yield* decodeGerritChangeNumber(1),
      });
      expect(result.currentPatchSet).toBe(3);
      expect(result.revisions.map((r) => [r.commit, r.patchSet])).toEqual([
        [oid, 3],
        [oldOid, 1],
      ]);
      expect(result.revisions[0].author).toEqual(person);
      expect(result.owner).toEqual({});
      expect(result).not.toHaveProperty("labels");
    }).pipe(Effect.provide(testLayer)),
);

it.live("escapes query grammar and percent-encodes exact project branch and Change-Id", () =>
  Effect.gen(function* () {
    const queries: string[] = [];
    const auth = yield* fixture((request, response) => {
      queries.push(request.url ?? "");
      json(response, []);
    });
    const http = yield* GerritHttp.GerritHttp;
    const scope = yield* decodeGerritRepositoryScope({
      ...auth.scope,
      project: 'Team/" OR project:Other\\Repo+%&',
      branch: 'Release/" OR status:merged',
    });
    yield* http.listChanges({
      ...auth,
      scope,
      changeId: (yield* decodeGerritChangeKey({ ...scope, changeId })).changeId,
    });
    const url = new URL(queries[0] ?? "", auth.installation);
    expect(url.pathname).toBe("/Review/a/changes/");
    expect(url.searchParams.get("q")).toBe(
      'project:"Team/\\" OR project:Other\\\\Repo+%&" branch:"Release/\\" OR status:merged" change:"' +
        changeId +
        '"',
    );
    expect(url.searchParams.getAll("q")).toHaveLength(1);
    expect(url.searchParams.getAll("o")).toContain("ALL_REVISIONS");
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "paginates using returned row counts and reports complete caller-visible observations",
  () =>
    Effect.gen(function* () {
      const starts: string[] = [];
      const auth = yield* fixture((request, response) => {
        const start =
          new URL(request.url ?? "", "http://fixture.invalid").searchParams.get("S") ?? "";
        starts.push(start);
        json(response, start === "0" ? [{ ...change(1), _more_changes: true }] : [change(2)]);
      });
      const result = yield* (yield* GerritHttp.GerritHttp).listChanges(auth);
      expect(starts).toEqual(["0", "1"]);
      expect(result.observation.completeness).toBe("complete-visible");
      expect(result.observation.changes.map((c) => c.revision.patchSet)).toEqual([3, 3]);
      expect(result.changes).toHaveLength(2);
    }).pipe(Effect.provide(testLayer)),
);

it.live.each([401, 403, 404, 429, 500])(
  "returns partial not complete when page 2 fails with %s",
  (status) =>
    Effect.gen(function* () {
      let count = 0;
      const auth = yield* fixture((_request, response) => {
        if (count++ === 0) json(response, [{ ...change(), _more_changes: true }]);
        else {
          response.statusCode = status;
          response.end("fixture-private-token arbitrary secret error body");
        }
      });
      const result = yield* (yield* GerritHttp.GerritHttp).listChanges(auth);
      expect(result.observation.completeness).toBe("partial");
      expect(result.changes).toHaveLength(1);
      expect(result.issue).toMatchObject({ _tag: "GerritReadError", status });
      expect(JSON.stringify(result)).not.toContain("fixture-private-token");
      expect(count).toBe(2);
    }).pipe(Effect.provide(testLayer)),
);

it.live("stops duplicate pagination without claiming a complete snapshot", () =>
  Effect.gen(function* () {
    let count = 0;
    const auth = yield* fixture((_request, response) => {
      count++;
      json(response, [{ ...change(), _more_changes: true }]);
    });
    const result = yield* (yield* GerritHttp.GerritHttp).listChanges(auth);
    expect(result.issue).toBe("duplicate-results");
    expect(result.observation.completeness).toBe("partial");
    expect(result.changes).toHaveLength(1);
    expect(count).toBe(2);
  }).pipe(Effect.provide(testLayer)),
);

it.live("bounds pagination even when the server always has another unique page", () =>
  Effect.gen(function* () {
    let count = 0;
    const auth = yield* fixture((_request, response) =>
      json(response, [{ ...change(++count), _more_changes: true }]),
    );
    const result = yield* (yield* GerritHttp.GerritHttp).listChanges(auth);
    expect(result.issue).toBe("page-limit");
    expect(result.observation.completeness).toBe("partial");
    expect(count).toBe(20);
  }).pipe(Effect.provide(testLayer)),
);

it.live.each([
  [401, "authentication"],
  [403, "forbidden"],
  [404, "not-found-or-hidden"],
  [429, "rate-limit"],
  [503, "http"],
] as const)(
  "normalizes HTTP %s without retaining body or nested request secrets",
  ([status, reason]) =>
    Effect.gen(function* () {
      const auth = yield* fixture((_request, response) => {
        response.statusCode = status;
        response.end("fixture-private-token");
      });
      const result = yield* (yield* GerritHttp.GerritHttp).verify(auth).pipe(Effect.flip);
      expect(result.reason).toBe(reason);
      expect(result).not.toHaveProperty("cause");
      expect(JSON.stringify(result)).not.toContain("fixture-private-token");
    }).pipe(Effect.provide(testLayer)),
);

it.live.each(["/review/a/accounts/self", "/Review/other", "http://localhost:1/steal"])(
  "does not follow redirect to %s",
  (target) =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const auth = yield* fixture((request, response) => {
        requests.push(request.url ?? "");
        response.writeHead(302, { Location: target });
        response.end();
      });
      const result = yield* (yield* GerritHttp.GerritHttp).verify(auth).pipe(Effect.flip);
      expect(result.reason).toBe("redirect");
      expect(requests).toEqual(["/Review/a/accounts/self"]);
    }).pipe(Effect.provide(testLayer)),
);

it.live.each([
  ["missing XSSI", '{"_account_id":1}', "invalid-response"],
  ["invalid JSON", ")]}'\nnot json fixture-private-token", "invalid-response"],
  ["missing semantic account id", ")]}'\n{}", "invalid-response"],
  ["oversized response", ")]}'\n" + "x".repeat(4 * 1024 * 1024), "oversize"],
] as const)("rejects %s", ([_name, body, reason]) =>
  Effect.gen(function* () {
    const auth = yield* fixture((_request, response) => response.end(body));
    const result = yield* (yield* GerritHttp.GerritHttp).verify(auth).pipe(Effect.flip);
    expect(result.reason).toBe(reason);
    expect(JSON.stringify(result)).not.toContain("fixture-private-token");
  }).pipe(Effect.provide(testLayer)),
);

it.live("represents unsupported version/capability reads as unknown", () =>
  Effect.gen(function* () {
    const auth = yield* fixture((request, response) => {
      if (request.url?.endsWith("self")) json(response, { _account_id: 42 });
      else {
        response.statusCode = 404;
        response.end();
      }
    });
    const result = yield* (yield* GerritHttp.GerritHttp).verify(auth);
    expect(result.version.kind).toBe("unknown");
    expect(result.capabilities.kind).toBe("unknown");
    expect(result.compatibility).toBe("unverified");
  }).pipe(Effect.provide(testLayer)),
);

it.live("rejects inconsistent current revisions, patch sets and lookup identities", () =>
  Effect.gen(function* () {
    let payload: unknown = { ...change(), current_revision: "d".repeat(40) };
    const auth = yield* fixture((_request, response) => json(response, payload));
    const http = yield* GerritHttp.GerritHttp;
    const input = {
      ...auth,
      key: yield* decodeGerritChangeKey({ ...auth.scope, changeId }),
      number: yield* decodeGerritChangeNumber(1),
    };
    expect((yield* http.getChange(input).pipe(Effect.flip)).reason).toBe("invalid-response");
    payload = {
      ...change(),
      revisions: {
        [oid]: { _number: 3, commit: { parents: [], author: person, committer: person } },
        [oldOid]: { _number: 3, commit: { parents: [], author: person, committer: person } },
      },
    };
    expect((yield* http.getChange(input).pipe(Effect.flip)).reason).toBe("invalid-response");
    payload = { ...change(), _number: 2 };
    expect((yield* http.getChange(input).pipe(Effect.flip)).reason).toBe("identity-mismatch");
    payload = { ...change(), project: "team/repo" };
    expect((yield* http.getChange(input).pipe(Effect.flip)).reason).toBe("identity-mismatch");
    payload = { ...change(), change_id: `I${"d".repeat(40)}` };
    expect((yield* http.getChange(input).pipe(Effect.flip)).reason).toBe("identity-mismatch");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("times out stalled HTTP headers through an interruptible Effect boundary", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const client = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const installation = yield* decodeGerritInstallationId("https://review.example/Review/");
    const task = yield* Effect.forkChild(
      Effect.gen(function* () {
        return yield* (yield* GerritHttp.GerritHttp).verify({ installation, credentials });
      }).pipe(
        Effect.provide(GerritHttp.layer),
        Effect.provideService(HttpClient.HttpClient, client),
      ),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("15 seconds");
    expect((yield* Fiber.join(task).pipe(Effect.flip)).reason).toBe("timeout");
  }),
);

it.live(
  "returns related remote revision metadata without inventing branch identity or a local graph",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const auth = yield* fixture((request, response) => {
        paths.push(request.url ?? "");
        if (request.url?.includes("/related"))
          json(response, {
            changes: [
              {
                project: "Team/Repo",
                change_id: changeId,
                _change_number: 1,
                _revision_number: 1,
                _current_revision_number: 3,
                status: "NEW",
                commit: {
                  commit: oldOid,
                  parents: [],
                  author: person,
                  subject: "Historical revision",
                },
              },
              {
                project: "Other/Project",
                commit: {
                  commit: oid,
                  parents: [{ commit: oldOid }],
                  author: person,
                  subject: "Untracked remote commit",
                },
              },
            ],
          });
        else json(response, change());
      });
      const key = yield* decodeGerritChangeKey({ ...auth.scope, changeId });
      const number = yield* decodeGerritChangeNumber(1);
      const revision = yield* decodeGitCommitOid(oldOid);
      const result = yield* (yield* GerritHttp.GerritHttp).getRelatedChanges({
        ...auth,
        key,
        number,
        revision,
      });
      expect(result.completeness).toBe("complete-visible");
      expect(result.anchor).toMatchObject({
        key,
        number,
        currentRevision: oid,
        currentPatchSet: 3,
        status: "NEW",
      });
      expect(result.revisions[0]).toMatchObject({
        installation: auth.installation,
        project: "Team/Repo",
        commit: oldOid,
        patchSet: 1,
        currentPatchSet: 3,
        author: person,
      });
      expect(result.revisions[0]).not.toHaveProperty("branch");
      expect(result.revisions[0]).not.toHaveProperty("committer");
      expect(result.revisions[1]).not.toHaveProperty("number");
      expect(result.revisions[1]).not.toHaveProperty("changeId");
      expect(result).not.toHaveProperty("graph");
      expect(paths[1]).toBe(`/Review/a/changes/1/revisions/${oldOid}/related`);
    }).pipe(Effect.provide(testLayer)),
);

it.live.each([true, false, undefined])(
  "preserves related WIP %s without deriving false from an older response",
  (workInProgress) =>
    Effect.gen(function* () {
      const auth = yield* fixture((request, response) => {
        if (request.url?.includes("/related"))
          json(response, {
            changes: [
              {
                project: "Team/Repo",
                change_id: changeId,
                _change_number: 1,
                _revision_number: 1,
                _current_revision_number: 3,
                status: "NEW",
                ...(workInProgress === undefined ? {} : { work_in_progress: workInProgress }),
                commit: { commit: oldOid, parents: [], author: person, subject: "Parent" },
              },
            ],
          });
        else json(response, change());
      });
      const result = yield* (yield* GerritHttp.GerritHttp).getRelatedChanges({
        ...auth,
        key: yield* decodeGerritChangeKey({ ...auth.scope, changeId }),
        number: yield* decodeGerritChangeNumber(1),
        revision: yield* decodeGitCommitOid(oldOid),
      });
      if (workInProgress === undefined)
        expect(result.revisions[0]).not.toHaveProperty("workInProgress");
      else expect(result.revisions[0]).toHaveProperty("workInProgress", workInProgress);
    }).pipe(Effect.provide(testLayer)),
);

it.live("rejects an unrelated revision before requesting related changes", () =>
  Effect.gen(function* () {
    let count = 0;
    const auth = yield* fixture((_request, response) => {
      count++;
      json(response, change());
    });
    const result = yield* (yield* GerritHttp.GerritHttp)
      .getRelatedChanges({
        ...auth,
        key: yield* decodeGerritChangeKey({ ...auth.scope, changeId }),
        number: yield* decodeGerritChangeNumber(1),
        revision: yield* decodeGitCommitOid("d".repeat(40)),
      })
      .pipe(Effect.flip);
    expect(result.reason).toBe("identity-mismatch");
    expect(count).toBe(1);
  }).pipe(Effect.provide(testLayer)),
);

it.live("represents an exhausted empty query as no caller-visible matches", () =>
  Effect.gen(function* () {
    const auth = yield* fixture((_request, response) => json(response, []));
    const result = yield* (yield* GerritHttp.GerritHttp).listChanges(auth);
    expect(result.changes).toEqual([]);
    expect(result.observation).toMatchObject({ changes: [], completeness: "complete-visible" });
  }).pipe(Effect.provide(testLayer)),
);

it.live("normalizes a dropped connection without automatic retry", () =>
  Effect.gen(function* () {
    let count = 0;
    const auth = yield* fixture((request) => {
      count++;
      request.socket.destroy();
    });
    const result = yield* (yield* GerritHttp.GerritHttp).verify(auth).pipe(Effect.flip);
    expect(result.reason).toBe("offline");
    expect(count).toBe(1);
    expect(result).not.toHaveProperty("cause");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("times out a stalled response body, not only the response headers", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const client = HttpClient.make((request) => {
      const response = HttpClientResponse.fromWeb(request, new Response());
      Object.defineProperty(response, "stream", {
        value: Stream.fromEffect(
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      });
      return Effect.succeed(response);
    });
    const installation = yield* decodeGerritInstallationId("https://review.example/Review/");
    const task = yield* Effect.forkChild(
      Effect.gen(function* () {
        return yield* (yield* GerritHttp.GerritHttp).verify({ installation, credentials });
      }).pipe(
        Effect.provide(GerritHttp.layer),
        Effect.provideService(HttpClient.HttpClient, client),
      ),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("15 seconds");
    expect((yield* Fiber.join(task).pipe(Effect.flip)).reason).toBe("timeout");
  }),
);

const reviewInput = Effect.fn("GerritHttp.test.reviewInput")(function* (
  installation: GerritInstallationId,
  revision = oid,
) {
  return yield* decodeReviewInput({
    key: { installation, project: "Team/Repo", branch: "Release/Next", changeId },
    number: 1,
    revision,
  });
});

it.live("maps legacy submit labels and patch-set-level comments without file paths", () =>
  Effect.gen(function* () {
    const auth = yield* fixture((request, response) => {
      const path = new URL(request.url ?? "", "http://fixture.invalid").pathname;
      if (path.endsWith("/comments"))
        json(response, {
          "/PATCHSET_LEVEL": [
            {
              id: "change-note",
              patch_set: 3,
              updated: "2026-10-29 18:23:02.000000000",
              unresolved: true,
              message: "needs ai code review",
              commit_id: oid,
            },
          ],
        });
      else if (
        path.endsWith("/actions") ||
        path.endsWith("/drafts") ||
        path.endsWith("/ported_comments")
      )
        json(response, {});
      else
        json(response, {
          ...change(),
          submit_requirements: [],
          submit_records: [
            {
              rule_name: "gerrit~DefaultSubmitRule",
              status: "OK",
              labels: [
                { label: "Code-Review", status: "MAY", applied_by: { _account_id: 1001 } },
                { label: "Security-Review", status: "MAY" },
                { label: "Verified", status: "IMPOSSIBLE" },
              ],
            },
          ],
        });
    });
    const http = yield* GerritHttp.GerritHttp;
    const result = yield* http.review.readReview({
      ...auth,
      ...(yield* reviewInput(auth.installation)),
    });
    expect(result.requirements).toEqual([
      expect.objectContaining({
        name: "Code-Review",
        status: "SATISFIED",
        source: "legacy-submit-rule",
      }),
      // Gerrit reports MAY for a label that is optional, so a missing vote there is not a blocker.
      expect.objectContaining({
        name: "Security-Review",
        status: "SATISFIED",
        source: "legacy-submit-rule",
        description: expect.stringContaining("optional"),
      }),
      expect.objectContaining({
        name: "Verified",
        status: "UNSATISFIED",
        source: "legacy-submit-rule",
      }),
    ]);
    expect(result.comments[0]).toMatchObject({
      id: "change-note",
      anchor: { path: null },
      unresolved: true,
      message: "needs ai code review",
    });
  }).pipe(Effect.provide(testLayer)),
);

it.live("keeps new-style submit requirements ahead of legacy records", () =>
  Effect.gen(function* () {
    const auth = yield* fixture((request, response) => {
      const path = request.url ?? "";
      if (
        ["/actions", "/comments", "/drafts", "/ported_comments"].some((suffix) =>
          path.endsWith(suffix),
        )
      )
        json(response, {});
      else
        json(response, {
          ...change(),
          submit_requirements: [{ name: "Policy", status: "SATISFIED" }],
          submit_records: [
            {
              rule_name: "legacy",
              status: "NOT_READY",
              labels: [{ label: "Security-Review", status: "NEED" }],
            },
          ],
        });
    });
    const http = yield* GerritHttp.GerritHttp;
    const result = yield* http.review.readReview({
      ...auth,
      ...(yield* reviewInput(auth.installation)),
    });
    expect(result.requirements).toEqual([{ name: "Policy", status: "SATISFIED" }]);
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "maps change-level comments and their publishing change message from the production payload shape",
  () =>
    Effect.gen(function* () {
      const auth = yield* fixture((request, response) => {
        const path = new URL(request.url ?? "", "http://fixture.invalid").pathname;
        if (path.endsWith("/accounts/1002042"))
          json(response, { _account_id: 1002042, name: "Alvin La" });
        else if (path.endsWith("/actions")) json(response, {});
        else if (path.endsWith("/ported_comments")) json(response, {});
        else if (path.endsWith("/comments"))
          json(response, {
            // Gerrit 3.13: change-level comments arrive under the synthetic /PATCHSET_LEVEL key
            // with no path or line, only patch_set, commit_id, and the publishing message id.
            "/PATCHSET_LEVEL": [
              {
                id: "change-level-1",
                patch_set: 2,
                commit_id: oid,
                message: "needs ai code review",
                author: { _account_id: 1000026, name: "Daniel Chen" },
                updated: "2025-06-01T10:00:00.000Z",
                unresolved: true,
                change_message_id: "cm-1",
              },
            ],
            "src/a.ts": [
              {
                id: "inline-1",
                patch_set: 2,
                line: 2890,
                message: "|| at start of second line",
                updated: "2025-06-01T10:00:00.000Z",
                unresolved: true,
                in_reply_to: "change-level-1",
                change_message_id: "cm-1",
              },
            ],
          });
        else if (path.endsWith("/drafts")) json(response, {});
        else
          json(response, {
            ...change(),
            messages: [
              {
                id: "cm-1",
                date: "2025-06-01T10:00:00.000Z",
                message: "Removed reviewer <GERRIT_ACCOUNT_1002042>.",
                tag: "autogenerated:gerrit:review",
                _revision_number: 2,
              },
            ],
          });
      });
      const http = yield* GerritHttp.GerritHttp;
      const result = yield* http.review.readReview({
        ...auth,
        ...(yield* reviewInput(auth.installation)),
      });
      const changeLevel = result.comments.find((c) => c.id === "change-level-1");
      expect(changeLevel).toMatchObject({
        anchor: { path: null, side: "REVISION" },
        changeMessageId: "cm-1",
        unresolved: true,
      });
      expect(changeLevel?.anchor.line).toBeUndefined();
      const inline = result.comments.find((c) => c.id === "inline-1");
      expect(inline).toMatchObject({
        anchor: { path: "src/a.ts", line: 2890 },
        inReplyTo: "change-level-1",
        changeMessageId: "cm-1",
      });
      expect(result.messages[0]?.tag).toBe("autogenerated:gerrit:review");
      expect(result.messages[0]?.message).toBe("Removed reviewer <GERRIT_ACCOUNT_1002042>.");
      expect(result.messageAccounts?.["1002042"]?.name).toBe("Alvin La");
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "preserves original historical anchors, unknown comment content, private drafts and copied ported positions",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const original = {
        id: "opaque%2Fcomment",
        patch_set: 1,
        side: "PARENT",
        parent: 1,
        line: 7,
        updated: "then",
        unresolved: true,
      };
      const auth = yield* fixture((request, response) => {
        paths.push(request.url ?? "");
        const path = new URL(request.url ?? "", "http://fixture.invalid").pathname;
        if (path.endsWith("/actions"))
          json(response, { "plugin~unknown": { enabled: true, label: "Plugin action" } });
        else if (path.endsWith("/ported_comments"))
          json(response, {
            "new.ts": [{ ...original, line: 20 }],
            "copy.ts": [{ ...original, line: 30 }],
          });
        else if (path.endsWith("/comments")) json(response, { "old.ts": [original] });
        else if (path.endsWith("/drafts"))
          json(response, {
            "private.ts": [
              { id: "private", patch_set: 3, message: "Unsent server draft", updated: "now" },
            ],
          });
        else
          json(response, {
            ...change(),
            permitted_labels: { "Custom-Label": ["-2", " 0", "+2"] },
            submit_requirements: [{ name: "Policy", status: "NOT_APPLICABLE" }],
          });
      });
      const http = yield* GerritHttp.GerritHttp;
      const result = yield* http.review.readReview({
        ...auth,
        ...(yield* reviewInput(auth.installation)),
      });
      expect(result.comments[0]).toMatchObject({
        patchSet: 1,
        revision: oldOid,
        message: null,
        anchor: { path: "old.ts", side: "PARENT", parent: 1, line: 7 },
      });
      expect(result.drafts[0]).toMatchObject({
        visibility: "server-draft",
        revision: oid,
        message: "Unsent server draft",
      });
      expect(
        result.portedComments.map((p) => [
          p.displayAnchor.path,
          p.displayAnchor.line,
          p.original?.anchor.path,
          p.original?.anchor.line,
        ]),
      ).toEqual([
        ["new.ts", 20, "old.ts", 7],
        ["copy.ts", 30, "old.ts", 7],
      ]);
      expect(result.permittedLabels).toEqual({ "Custom-Label": [-2, 0, 2] });
      expect(result.requirements).toEqual([{ name: "Policy", status: "NOT_APPLICABLE" }]);
      expect(result.checks.kind).toBe("not-configured");
      expect(paths.some((path) => path.endsWith("/checks"))).toBe(false);
    }).pipe(Effect.provide(testLayer)),
);

it.live("reads exact revision mergeability when change detail omits it", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const auth = yield* fixture((request, response) => {
      const path = request.url ?? "";
      paths.push(path);
      if (path.endsWith("/mergeable"))
        json(response, {
          mergeable: false,
          strategy: "recursive",
          submit_type: "REBASE_IF_NECESSARY",
        });
      else if (
        path.endsWith("/actions") ||
        path.endsWith("/comments") ||
        path.endsWith("/drafts") ||
        path.endsWith("/ported_comments")
      )
        json(response, {});
      else json(response, change());
    });
    const http = yield* GerritHttp.GerritHttp;
    const input = yield* reviewInput(auth.installation);
    const review = yield* http.review.readReview({ ...auth, ...input });
    expect(review.mergeable).toBe(false);
    expect(paths.some((path) => path.endsWith(`/revisions/${oid}/mergeable`))).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

it.live("keeps unsupported revision mergeability unknown without failing the review", () =>
  Effect.gen(function* () {
    const auth = yield* fixture((request, response) => {
      if ((request.url ?? "").endsWith("/mergeable")) {
        response.statusCode = 404;
        response.end();
      } else if (
        ["/actions", "/comments", "/drafts", "/ported_comments"].some((suffix) =>
          (request.url ?? "").endsWith(suffix),
        )
      )
        json(response, {});
      else json(response, change());
    });
    const http = yield* GerritHttp.GerritHttp;
    const review = yield* http.review.readReview({
      ...auth,
      ...(yield* reviewInput(auth.installation)),
    });
    expect(review.mergeable).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);

it.live("does not hide authentication failures as unavailable ported history", () =>
  Effect.gen(function* () {
    const auth = yield* fixture((request, response) => {
      if (request.url?.endsWith("/ported_comments")) {
        response.statusCode = 403;
        response.end();
      } else if (
        request.url?.endsWith("/actions") ||
        request.url?.endsWith("/comments") ||
        request.url?.endsWith("/drafts")
      )
        json(response, {});
      else json(response, change());
    });
    const http = yield* GerritHttp.GerritHttp;
    expect(
      (yield* http.review
        .readReview({ ...auth, ...(yield* reviewInput(auth.installation)) })
        .pipe(Effect.flip)).reason,
    ).toBe("forbidden");
  }).pipe(Effect.provide(testLayer)),
);

it.live("reads exact historical comparison files and encodes an entire odd filename once", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const path = "dir/a b%#?.ts";
    const auth = yield* fixture((request, response) => {
      paths.push(request.url ?? "");
      if (request.url?.includes("/files/") && request.url.includes("/diff"))
        json(response, {
          meta_a: { name: "old.ts" },
          meta_b: { name: path },
          diff_header: ["diff --git"],
          content: [{ ab: ["context"] }, { a: ["before"], b: ["after"] }],
        });
      else if (request.url?.includes("/files/"))
        json(response, {
          [path]: { status: "R", old_path: "old.ts", lines_inserted: 1, lines_deleted: 1 },
        });
      else json(response, change());
    });
    const http = yield* GerritHttp.GerritHttp;
    const input = yield* reviewInput(auth.installation);
    const files = yield* http.review.readFiles({
      ...auth,
      ...input,
      comparison: { kind: "revision", revision: yield* decodeGitCommitOid(oldOid) },
    });
    expect(files[0]).toMatchObject({
      path,
      status: "R",
      oldPath: "old.ts",
      inserted: 1,
      deleted: 1,
    });
    const diff = yield* http.review.readDiff({
      ...auth,
      ...input,
      comparison: { kind: "parent", parent: 1 },
      path,
    });
    expect(diff).toMatchObject({
      kind: "text",
      oldPath: "old.ts",
      newPath: path,
      content: [{ ab: ["context"] }, { a: ["before"], b: ["after"] }],
    });
    expect(paths.some((p) => p.includes("base=1"))).toBe(true);
    expect(
      paths.some((p) => p.includes(`/files/${encodeURIComponent(path)}/diff?parent=1&context=ALL`)),
    ).toBe(true);
    expect(
      (yield* http.review
        .readFiles({ ...auth, ...input, comparison: { kind: "parent", parent: 2 } })
        .pipe(Effect.flip)).reason,
    ).toBe("invalid-input");
    expect(
      (yield* http.review
        .readFiles({
          ...auth,
          ...input,
          comparison: { kind: "revision", revision: yield* decodeGitCommitOid("d".repeat(40)) },
        })
        .pipe(Effect.flip)).reason,
    ).toBe("identity-mismatch");
  }).pipe(Effect.provide(testLayer)),
);

it.live("distinguishes binary, submodule, oversized and unavailable historical diffs", () =>
  Effect.gen(function* () {
    let mode = "binary";
    const auth = yield* fixture((request, response) => {
      if (!request.url?.includes("/diff")) {
        json(response, change());
        return;
      }
      if (mode === "unavailable-history") {
        response.statusCode = 404;
        response.end();
      } else if (mode === "oversize") json(response, { text: "x".repeat(4_300_000) });
      else
        json(response, {
          diff_header: mode === "submodule" ? ["index a..b 160000"] : [],
          content: [],
          binary: mode === "binary",
        });
    });
    const http = yield* GerritHttp.GerritHttp;
    const input = {
      ...auth,
      ...(yield* reviewInput(auth.installation)),
      comparison: { kind: "base" as const },
      path: "file",
    };
    for (mode of ["binary", "submodule", "oversize", "unavailable-history"])
      expect((yield* http.review.readDiff(input)).kind).toBe(mode);
  }).pipe(Effect.provide(testLayer)),
);

it.live("reads the exact target branch tip", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const auth = yield* fixture((request, response) => {
      urls.push(request.url ?? "");
      json(response, { revision: oid });
    });
    const input = yield* reviewInput(auth.installation);
    const http = yield* GerritHttp.GerritHttp;
    expect(yield* http.readBranchTip({ ...auth, scope: input.key })).toBe(oid);
    expect(urls).toEqual(["/Review/a/projects/Team%2FRepo/branches/Release%2FNext"]);
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "reads the explicitly selected legacy checks profile through its real namespaced mount",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      let version = "3.10.8";
      let status = 200;
      let values: unknown = [
        {
          repository: "Team/Repo",
          change_number: 1,
          patch_set_id: 3,
          checker_uuid: "ci:build",
          checker_name: "Build",
          checker_status: "ENABLED",
          state: "RUNNING",
          message: "Running",
          created: "2026-10-22 00:00:00.000000000",
          updated: "2026-10-22 00:00:01.000000000",
        },
      ];
      const auth = yield* fixture((request, response) => {
        paths.push(request.url ?? "");
        if (request.url?.includes("/config/server/version")) json(response, version);
        else if (request.url?.includes("/checks~checks")) {
          response.statusCode = status;
          if (status === 200) json(response, values);
          else response.end("private plugin failure");
        } else if (
          ["/actions", "/comments", "/drafts", "/ported_comments"].some((suffix) =>
            request.url?.endsWith(suffix),
          )
        )
          json(response, {});
        else json(response, change());
      });
      const http = yield* GerritHttp.GerritHttp;
      const input = { ...auth, ...(yield* reviewInput(auth.installation)) };
      expect((yield* http.review.readReview(input)).checks.kind).toBe("not-configured");
      expect(paths.some((p) => p.includes("/config/server/version") || p.includes("/checks"))).toBe(
        false,
      );
      const configured = { ...input, checksProfile: "checks-rest-v1-3.10" as const };
      const checks = (yield* http.review.readReview(configured)).checks;
      expect(checks).toMatchObject({ kind: "available", profile: "checks-rest-v1-3.10", values });
      expect(paths).toContain(`/Review/a/changes/1/revisions/${oid}/checks~checks?o=CHECKER`);
      expect(paths.every((p) => p.startsWith("/Review/a/"))).toBe(true);
      paths.length = 0;
      version = "3.13.0";
      expect((yield* http.review.readReview(configured)).checks.kind).toBe("unavailable");
      expect(paths.some((p) => p.includes("/checks"))).toBe(false);
      version = "3.10.8";
      status = 404;
      expect((yield* http.review.readReview(configured)).checks.kind).toBe("unavailable");
      for (status of [401, 403])
        expect((yield* http.review.readReview(configured).pipe(Effect.flip)).reason).toBe(
          status === 401 ? "authentication" : "forbidden",
        );
      status = 200;
      values = [{ state: "SUCCESSFUL" }];
      expect((yield* http.review.readReview(configured)).checks.kind).toBe("unavailable");
      values = [
        {
          repository: "wrong",
          change_number: 1,
          patch_set_id: 3,
          checker_uuid: "ci:build",
          state: "SUCCESSFUL",
          created: "then",
          updated: "now",
        },
      ];
      expect((yield* http.review.readReview(configured).pipe(Effect.flip)).reason).toBe(
        "invalid-response",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "separates owning patch sets from native side content commits and preserves uncertain evidence",
  () =>
    Effect.gen(function* () {
      const parent = "d".repeat(40);
      const second = "e".repeat(40);
      const auto = "f".repeat(40);
      const native = (id: string, extra: Record<string, unknown>) => ({
        id,
        patch_set: 3,
        updated: "now",
        message: id,
        ...extra,
      });
      const comments = [
        native("default", { side: "PARENT", commit_id: parent }),
        native("revision", { commit_id: oid }),
        native("wrong-revision", { commit_id: parent }),
        native("missing-ps", { patch_set: undefined, commit_id: oid }),
        native("unknown-ps", { patch_set: 99, commit_id: parent }),
        native("bad-parent", { side: "PARENT", parent: 3, commit_id: parent }),
        native("wrong-parent", { side: "PARENT", parent: 1, commit_id: second }),
        native("selected-parent", { side: "PARENT", parent: 2, commit_id: second }),
        native("auto-merge", { side: "PARENT", commit_id: auto }),
        native("revision-parent", { parent: 1, commit_id: oid }),
      ];
      let merge = false;
      const auth = yield* fixture((request, response) => {
        if (request.url?.endsWith("/comments")) json(response, { "new.ts": comments });
        else if (request.url?.endsWith("/drafts")) json(response, { "new.ts": [comments[0]] });
        else if (request.url?.endsWith("/ported_comments"))
          json(response, { "ported.ts": [{ ...comments[0], line: 20, commit_id: auto }] });
        else if (request.url?.endsWith("/actions")) json(response, {});
        else {
          const value = change();
          json(response, {
            ...value,
            revisions: {
              ...value.revisions,
              [oid]: {
                ...value.revisions[oid],
                commit: {
                  ...value.revisions[oid]?.commit,
                  parents: (merge ? [parent, second] : [parent]).map((commit) => ({ commit })),
                },
              },
            },
          });
        }
      });
      const http = yield* GerritHttp.GerritHttp;
      const input = { ...auth, ...(yield* reviewInput(auth.installation)) };
      const single = yield* http.review.readReview(input);
      expect(single.comments[0]).toMatchObject({
        revision: oid,
        contentCommit: parent,
        identity: { kind: "known" },
      });
      expect(single.drafts[0]).toMatchObject({
        revision: oid,
        contentCommit: parent,
        visibility: "server-draft",
      });
      for (const id of [
        "wrong-revision",
        "bad-parent",
        "wrong-parent",
        "selected-parent",
        "auto-merge",
        "revision-parent",
      ])
        expect(single.comments.find((c) => c.id === id)).toMatchObject({
          identity: { kind: "contradictory" },
        });
      for (const id of ["missing-ps", "unknown-ps"])
        expect(single.comments.find((c) => c.id === id)).toMatchObject({
          revision: null,
          identity: { kind: "unknown" },
          contentCommit: expect.any(String),
        });
      merge = true;
      const result = yield* http.review.readReview(input);
      for (const id of ["selected-parent", "auto-merge"])
        expect(result.comments.find((c) => c.id === id)).toMatchObject({
          revision: oid,
          identity: { kind: "known" },
        });
      expect(result.portedComments[0]?.original).toEqual(result.comments[0]);
      expect(result.portedComments[0]?.original).toMatchObject({
        contentCommit: parent,
        anchor: { path: "new.ts" },
      });
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "reads moved numeric identity independently of stale branch and rejects numeric substitution",
  () =>
    Effect.gen(function* () {
      let number = 1;
      const auth = yield* fixture((_request, response) =>
        json(response, { ...change(number), branch: "moved" }),
      );
      const http = yield* GerritHttp.GerritHttp;
      const input = yield* reviewInput(auth.installation);
      expect((yield* http.getChangeByNumber({ ...auth, number: input.number })).key.branch).toBe(
        "moved",
      );
      expect((yield* http.getChange({ ...auth, ...input }).pipe(Effect.flip)).reason).toBe(
        "identity-mismatch",
      );
      number = 2;
      expect(
        (yield* http.getChangeByNumber({ ...auth, number: input.number }).pipe(Effect.flip)).reason,
      ).toBe("identity-mismatch");
    }).pipe(Effect.provide(testLayer)),
);

const polled = (number: number, overrides: Record<string, unknown> = {}) => ({
  ...change(number),
  current_revision_number: 3,
  updated: "2026-10-22 00:00:01.000000000",
  total_comment_count: 2,
  unresolved_comment_count: 1,
  labels: {
    "Code-Review": {
      all: [{ _account_id: 7, value: 2, date: "2026-10-22 00:00:01.000000000" }],
    },
  },
  messages: [{ id: "message-1", date: "2026-10-22 00:00:01.000000000", message: "hello" }],
  submit_requirements: [{ name: "Code-Review", status: "SATISFIED" }],
  mergeable: true,
  ...overrides,
});

it.live("reads all watched numbers from one batched query with the documented options", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const auth = yield* fixture((request, response) => {
      requests.push(request.url ?? "");
      json(response, [polled(5), polled(6)]);
    });
    const snapshot = yield* (yield* GerritHttp.GerritHttp).readWatchChanges({
      installation: auth.installation,
      credentials: auth.credentials,
      numbers: [yield* decodeGerritChangeNumber(5), yield* decodeGerritChangeNumber(6)],
    });
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!, auth.installation);
    expect(url.pathname).toBe("/Review/a/changes/");
    expect(url.searchParams.get("q")).toBe("change:5 OR change:6");
    expect(url.searchParams.get("n")).toBe("2");
    expect(url.searchParams.getAll("o")).toEqual(
      expect.arrayContaining([
        "CURRENT_REVISION",
        "DETAILED_LABELS",
        "MESSAGES",
        "SUBMIT_REQUIREMENTS",
      ]),
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.missing).toEqual([]);
    expect(snapshot.changes.map((item) => item.number)).toEqual([5, 6]);
    expect(snapshot.changes[0]).toMatchObject({
      installation: auth.installation,
      currentPatchSet: 3,
      updated: "2026-10-22 00:00:01.000000000",
      totalCommentCount: 2,
      unresolvedCommentCount: 1,
      mergeable: true,
      requirements: [{ name: "Code-Review", status: "SATISFIED" }],
    });
    expect(snapshot.changes[0]?.labels["Code-Review"]?.all?.[0]?.value).toBe(2);
    expect(snapshot.changes[0]?.messages[0]?.id).toBe("message-1");
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "paginates a batched query and reports an invisible change as missing instead of deleted",
  () =>
    Effect.gen(function* () {
      const starts: string[] = [];
      const auth = yield* fixture((request, response) => {
        const start =
          new URL(request.url ?? "", "http://fixture.invalid").searchParams.get("S") ?? "";
        starts.push(start);
        json(response, start === "0" ? [polled(5, { _more_changes: true })] : [polled(6)]);
      });
      const snapshot = yield* (yield* GerritHttp.GerritHttp).readWatchChanges({
        installation: auth.installation,
        credentials: auth.credentials,
        numbers: [
          yield* decodeGerritChangeNumber(5),
          yield* decodeGerritChangeNumber(6),
          yield* decodeGerritChangeNumber(7),
        ],
      });
      expect(starts).toEqual(["0", "1"]);
      expect(snapshot.changes.map((item) => item.number)).toEqual([5, 6]);
      expect(snapshot.missing).toEqual([7]);
      expect(snapshot.complete).toBe(false);
    }).pipe(Effect.provide(testLayer)),
);

it.live("bounds batched queries into documented chunks", () =>
  Effect.gen(function* () {
    const queries: string[] = [];
    const auth = yield* fixture((request, response) => {
      queries.push(
        new URL(request.url ?? "", "http://fixture.invalid").searchParams.get("q") ?? "",
      );
      json(response, []);
    });
    const numbers = Array.from({ length: 51 }, (_, index) => index + 1);
    const snapshot = yield* (yield* GerritHttp.GerritHttp).readWatchChanges({
      installation: auth.installation,
      credentials: auth.credentials,
      numbers: numbers as never,
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.split(" OR ")).toHaveLength(50);
    expect(queries[1]?.split(" OR ")).toHaveLength(1);
    expect(snapshot.missing).toEqual(numbers);
  }).pipe(Effect.provide(testLayer)),
);

it.live("rejects a row outside the requested numbers without leaking it", () =>
  Effect.gen(function* () {
    const auth = yield* fixture((_request, response) => {
      json(response, [polled(99)]);
    });
    const result = yield* (yield* GerritHttp.GerritHttp)
      .readWatchChanges({
        installation: auth.installation,
        credentials: auth.credentials,
        numbers: [yield* decodeGerritChangeNumber(5)],
      })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("invalid-response");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("searches compact authenticated pages with escaped literal operators", () => {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  let page = 0;
  const client = HttpClient.make((request) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    const rows =
      page++ === 0
        ? [
            {
              ...change(),
              updated: "2026-01-01 00:00:00.000000000",
              _more_changes: true,
              submittable: true,
              labels: { "Code-Review": { approved: { name: "Alice" } } },
            },
          ]
        : [];
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(`)]}'\n${JSON.stringify(rows)}`)),
    );
  });
  return Effect.gen(function* () {
    const installation = yield* decodeGerritInstallationId("https://review.example/Review/");
    const http = yield* GerritHttp.GerritHttp;
    const input = {
      installation,
      credentials,
      status: "open" as const,
      limit: 1,
      offset: 0,
      project: "Team/Repo",
      branch: "refs/heads/Release/Next",
      owner: 'alice" OR status:merged',
      search: 'fix \\ "it"',
    };
    const first = yield* http.searchChanges(input);
    expect(first.nextOffset).toBe(1);
    expect(first.completeness).toBe("more");
    expect(first.changes[0]).toMatchObject({
      installation,
      number: 1,
      project: "Team/Repo",
      submittable: true,
      reviewStatus: "approved",
    });
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get("q")).toBe(
      'status:open project:"Team/Repo" branch:"refs/heads/Release/Next" owner:"alice\\" OR status:merged" message:"fix \\\\ \\"it\\""',
    );
    expect(url.searchParams.get("n")).toBe("1");
    expect(url.searchParams.getAll("o")).toEqual(["DETAILED_ACCOUNTS", "LABELS", "SUBMITTABLE"]);
    expect(requests[0]!.authorization).toMatch(/^Basic /);
    const second = yield* http.searchChanges({ ...input, offset: first.nextOffset! });
    expect(second.nextOffset).toBeNull();
    expect(second.completeness).toBe("complete");
    expect(new URL(requests[1]!.url).searchParams.get("S")).toBe("1");
    yield* http.searchChanges({
      installation,
      credentials,
      status: "all",
      limit: 1,
      offset: 0,
      project: "Team/Repo",
      rawQuery: "owner:self status:merged",
    });
    expect(new URL(requests[2]!.url).searchParams.get("q")).toBe(
      '(status:open OR status:merged OR status:abandoned) project:"Team/Repo" (owner:self status:merged)',
    );
  }).pipe(Effect.provide(GerritHttp.layer), Effect.provideService(HttpClient.HttpClient, client));
});

it.effect(
  "reports truncation only when another page would exceed the search offset ceiling",
  () => {
    let more = true;
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            `)]}'\n${JSON.stringify([{ ...change(), updated: "now", _more_changes: more }])}`,
          ),
        ),
      ),
    );
    return Effect.gen(function* () {
      const installation = yield* decodeGerritInstallationId("https://review.example/Review/");
      const http = yield* GerritHttp.GerritHttp;
      const input = { installation, credentials, status: "open" as const, limit: 1, offset: 9999 };
      expect(yield* http.searchChanges(input)).toMatchObject({
        completeness: "more",
        nextOffset: 10000,
      });
      expect(yield* http.searchChanges({ ...input, offset: 10000 })).toMatchObject({
        completeness: "truncated",
        nextOffset: null,
        changes: [{ number: 1 }],
      });
      more = false;
      expect(yield* http.searchChanges({ ...input, offset: 10000 })).toMatchObject({
        completeness: "complete",
        nextOffset: null,
      });
      expect(
        (yield* http.searchChanges({ ...input, offset: 10001 }).pipe(Effect.flip)).reason,
      ).toBe("invalid-input");
    }).pipe(Effect.provide(GerritHttp.layer), Effect.provideService(HttpClient.HttpClient, client));
  },
);

it.effect("rejects invalid search terms, mismatched rows, and authentication failures", () => {
  let payload: unknown = [];
  let status = 200;
  let calls = 0;
  const client = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(`)]}'\n${JSON.stringify(payload)}`, { status }),
      ),
    );
  });
  return Effect.gen(function* () {
    const installation = yield* decodeGerritInstallationId("https://review.example/Review/");
    const http = yield* GerritHttp.GerritHttp;
    const input = { installation, credentials, status: "open" as const, limit: 10, offset: 0 };
    expect((yield* http.searchChanges({ ...input, project: "^.*" }).pipe(Effect.flip)).reason).toBe(
      "invalid-input",
    );
    expect(
      (yield* http.searchChanges({ ...input, topic: "x\nstatus:merged" }).pipe(Effect.flip)).reason,
    ).toBe("invalid-input");
    expect(calls).toBe(0);
    payload = [{ ...change(), updated: "now", status: "MERGED" }];
    expect((yield* http.searchChanges(input).pipe(Effect.flip)).reason).toBe("identity-mismatch");
    payload = [{ ...change(), updated: "now", project: "Other" }];
    expect(
      (yield* http.searchChanges({ ...input, project: "Team/Repo" }).pipe(Effect.flip)).reason,
    ).toBe("identity-mismatch");
    payload = [
      { ...change(), updated: "now", _more_changes: true },
      { ...change(2), updated: "now" },
    ];
    expect((yield* http.searchChanges(input).pipe(Effect.flip)).reason).toBe("identity-mismatch");
    payload = [
      { ...change(), updated: "now" },
      { ...change(), updated: "now" },
    ];
    expect((yield* http.searchChanges(input).pipe(Effect.flip)).reason).toBe("identity-mismatch");
    status = 401;
    expect((yield* http.searchChanges(input).pipe(Effect.flip)).reason).toBe("authentication");
    status = 403;
    expect((yield* http.searchChanges(input).pipe(Effect.flip)).reason).toBe("forbidden");
  }).pipe(Effect.provide(GerritHttp.layer), Effect.provideService(HttpClient.HttpClient, client));
});
