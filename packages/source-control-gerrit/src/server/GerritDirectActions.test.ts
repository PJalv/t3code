import { it } from "@effect/vitest";
import { GerritInstallationId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vite-plus/test";
import * as GerritHttp from "./GerritHttp.ts";
import { makeDirectActions } from "./GerritDirectActions.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const changeId = `I${"c".repeat(40)}`;
const target = { number: 1 };
const auth = {
  installation: Schema.decodeSync(GerritInstallationId)("https://review.example/Review/"),
  credentials: Redacted.make({ username: "user", token: "secret" }),
};
const comment = {
  path: "src/file",
  message: "hello",
  side: "REVISION" as const,
  line: 4,
  unresolved: true,
};
const setup = (response: string, status = 200) => {
  const requests: Array<{
    url: string;
    method: string;
    body: unknown;
    authorization: string | undefined;
  }> = [];
  const client = HttpClient.make((request) => {
    requests.push({
      url: request.url,
      method: request.method,
      body: request.body,
      authorization: request.headers.authorization,
    });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(status === 204 ? null : `)]}'\n${response}`, { status }),
      ),
    );
  });
  return {
    requests,
    layer: GerritHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
  };
};
const make = Effect.fn("GerritDirectActions.test.make")(function* () {
  const http = yield* GerritHttp.GerritHttp;
  return makeDirectActions(http.directWrite, () =>
    Effect.succeed({ key: { project: "Team/Repo", changeId } }),
  );
});
const change = (status: string, number = 1, branch = "main") =>
  `{"_number":${number},"project":"Team/Repo","branch":"${branch}","status":"${status}"}`;
const cases = [
  [
    "review",
    '{"labels":{"Code-Review":0}}',
    (a: ReturnType<typeof makeDirectActions>) =>
      a.review(auth, target, {
        labels: { "Code-Review": 0 },
        comments: [comment],
        drafts: [{ ...comment, id: "draft" }],
        notify: "ALL",
      }),
    "/revisions/current/review",
    "POST",
  ],
  [
    "reply",
    "{}",
    (a: ReturnType<typeof makeDirectActions>) =>
      a.reply(auth, target, { comment: { ...comment, inReplyTo: "prior" } }),
    "/revisions/current/review",
    "POST",
  ],
  [
    "resolve",
    "{}",
    (a: ReturnType<typeof makeDirectActions>) =>
      a.resolve(auth, target, { comment: { ...comment, inReplyTo: "prior" } }),
    "/revisions/current/review",
    "POST",
  ],
  [
    "save draft",
    '{"id":"d","path":"src/file","message":"hello","side":"REVISION","line":4,"unresolved":true}',
    (a: ReturnType<typeof makeDirectActions>) => a.saveDraft(auth, target, { id: "d", comment }),
    "/revisions/current/drafts/d",
    "PUT",
  ],
  [
    "delete draft",
    "",
    (a: ReturnType<typeof makeDirectActions>) => a.deleteDraft(auth, target, "d"),
    "/revisions/current/drafts/d",
    "DELETE",
  ],
  [
    "topic",
    '"topic"',
    (a: ReturnType<typeof makeDirectActions>) => a.setTopic(auth, target, "topic"),
    "/topic",
    "PUT",
  ],
  [
    "clear topic",
    "",
    (a: ReturnType<typeof makeDirectActions>) => a.setTopic(auth, target, null),
    "/topic",
    "PUT",
  ],
  [
    "add reviewer",
    '{"input":"7","reviewers":[{"_account_id":7}]}',
    (a: ReturnType<typeof makeDirectActions>) =>
      a.addReviewer(auth, target, { reviewer: "7", state: "REVIEWER" }),
    "/reviewers",
    "POST",
  ],
  [
    "add CC",
    '{"input":"7","ccs":[{"_account_id":7}]}',
    (a: ReturnType<typeof makeDirectActions>) =>
      a.addReviewer(auth, target, { reviewer: "7", state: "CC" }),
    "/reviewers",
    "POST",
  ],
  [
    "remove reviewer",
    "",
    (a: ReturnType<typeof makeDirectActions>) => a.removeReviewer(auth, target, { reviewer: "7" }),
    "/reviewers/7/delete",
    "POST",
  ],
  [
    "wip",
    "",
    (a: ReturnType<typeof makeDirectActions>) => a.setWip(auth, target, true),
    "/wip",
    "POST",
  ],
  [
    "ready",
    "",
    (a: ReturnType<typeof makeDirectActions>) => a.setWip(auth, target, false),
    "/ready",
    "POST",
  ],
  [
    "private",
    "",
    (a: ReturnType<typeof makeDirectActions>) => a.setPrivate(auth, target, true),
    "/private",
    "PUT",
  ],
  [
    "unprivate",
    "",
    (a: ReturnType<typeof makeDirectActions>) => a.setPrivate(auth, target, false),
    "/private",
    "DELETE",
  ],
  [
    "commit message",
    '"ok"',
    (a: ReturnType<typeof makeDirectActions>) =>
      a.setCommitMessage(auth, target, `Subject\n\nChange-Id: ${changeId}`),
    "/message",
    "PUT",
  ],
  [
    "abandon",
    change("ABANDONED"),
    (a: ReturnType<typeof makeDirectActions>) => a.abandon(auth, target),
    "/abandon",
    "POST",
  ],
  [
    "restore",
    change("NEW"),
    (a: ReturnType<typeof makeDirectActions>) => a.restore(auth, target),
    "/restore",
    "POST",
  ],
  [
    "submit",
    change("MERGED"),
    (a: ReturnType<typeof makeDirectActions>) => a.submit(auth, target),
    "/submit",
    "POST",
  ],
  [
    "rebase",
    change("NEW"),
    (a: ReturnType<typeof makeDirectActions>) => a.rebase(auth, target, { base: "2" }),
    "/rebase",
    "POST",
  ],
  [
    "rebase chain",
    `{"rebased_changes":[${change("NEW")}]}`,
    (a: ReturnType<typeof makeDirectActions>) => a.rebaseChain(auth, target),
    "/rebase:chain",
    "POST",
  ],
  [
    "cherry-pick",
    change("NEW", 2, "other"),
    (a: ReturnType<typeof makeDirectActions>) =>
      a.cherryPick(auth, target, { destination: "other" }),
    "/revisions/current/cherrypick",
    "POST",
  ],
] as const;
it.effect.each(cases)("%s", ([name, response, run, path, method]) => {
  const fixture = setup(response, response === "" ? 204 : 200);
  return Effect.gen(function* () {
    const actions = yield* make();
    const result = yield* run(actions);
    expect(fixture.requests).toHaveLength(1);
    expect(new URL(fixture.requests[0]!.url).pathname).toBe(`/Review/a/changes/1${path}`);
    expect(fixture.requests[0]!.method).toBe(method);
    expect(fixture.requests[0]!.authorization).toMatch(/^Basic /);
    const body = fixture.requests[0]!.body;
    if (name === "review" || name === "resolve" || name === "rebase") {
      expect(body).toBeInstanceOf(HttpBody.Uint8Array);
      const decoded = yield* decodeJson(
        new TextDecoder().decode((body as HttpBody.Uint8Array).body),
      );
      if (name === "review")
        expect(decoded).toMatchObject({
          labels: { "Code-Review": 0 },
          drafts: "KEEP",
          notify: "ALL",
          comments: {
            "src/file": [{ message: "hello", line: 4, side: "REVISION" }, { id: "draft" }],
          },
        });
      if (name === "resolve")
        expect(decoded).toMatchObject({
          comments: { "src/file": [{ in_reply_to: "prior", unresolved: false, message: "Done" }] },
        });
      if (name === "rebase") expect(decoded).toEqual({ base: "2" });
    }
    if (name === "cherry-pick")
      expect(result).toEqual({ number: 2, url: "https://review.example/Review/c/Team/Repo/+/2" });
  }).pipe(Effect.provide(fixture.layer));
});
it.effect("server rejection is a failure", () => {
  const fixture = setup("", 403);
  return Effect.gen(function* () {
    const actions = yield* make();
    const error = yield* actions.submit(auth, target).pipe(Effect.flip);
    expect(error.reason).toBe("forbidden");
  }).pipe(Effect.provide(fixture.layer));
});
it.effect("rebase chain has no sequential fallback on unsupported hosts", () => {
  const fixture = setup("", 404);
  return Effect.gen(function* () {
    const actions = yield* make();
    const error = yield* actions.rebaseChain(auth, target).pipe(Effect.flip);
    expect(error.reason).toBe("unsupported");
    expect(fixture.requests).toHaveLength(1);
  }).pipe(Effect.provide(fixture.layer));
});
it.effect("rejects a changed Change-Id before sending", () => {
  const fixture = setup('"ok"');
  return Effect.gen(function* () {
    const actions = yield* make();
    const error = yield* actions
      .setCommitMessage(
        auth,
        target,
        "Subject\n\nChange-Id: I0000000000000000000000000000000000000000",
      )
      .pipe(Effect.flip);
    expect(error.reason).toBe("invalid-input");
    expect(fixture.requests).toHaveLength(0);
  }).pipe(Effect.provide(fixture.layer));
});
