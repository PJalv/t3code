import * as GerritHttp from "@t3tools/source-control-gerrit/server/GerritHttp";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHttpAuth from "../vcs/GitHttpAuth.ts";
import { credentialSecretName } from "./gerritBranchReviews.ts";

const decodeCredential = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GerritHttp.GerritHttpCredentialValue),
);

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Digest.Digest;
  let entries: ReadonlyArray<readonly [string, string]> | undefined;
  let generation = 0;
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.fn("GerritGitHttpAuth.refresh")(function* () {
    const currentGeneration = generation;
    const snapshot = yield* settings.getSettings;
    const values = yield* Effect.forEach(Object.values(snapshot.gerritConnections), (config) =>
      Effect.gen(function* () {
        if (config.authMode !== "http-basic") return [];
        const name = yield* credentialSecretName(crypto, config.installation);
        const secret = yield* secrets.get(name);
        if (Option.isNone(secret)) return [];
        const credential = yield* decodeCredential(new TextDecoder().decode(secret.value));
        const header = Buffer.from(`${credential.username}:${credential.token}`).toString("base64");
        return [
          [`http.${config.installation}.extraHeader`, `Authorization: Basic ${header}`] as const,
          [`http.${config.installation}.followRedirects`, "false"] as const,
        ];
      }).pipe(Effect.orElseSucceed(() => [])),
    );
    if (generation === currentGeneration) entries = values.flat();
  }, Effect.ignore);
  const invalidate = Effect.sync(() => {
    generation++;
    entries = undefined;
  });
  const changes = yield* settings.subscribeChanges;
  yield* changes.pipe(
    Stream.runForEach(() => invalidate),
    Effect.forkScoped,
  );
  return GitHttpAuth.GitHttpAuth.of({
    invalidate,
    entries: refreshLock.withPermits(1)(
      Effect.gen(function* () {
        if (entries === undefined) yield* refresh();
        return entries ?? [];
      }),
    ),
  });
});

export const layer = Layer.effect(GitHttpAuth.GitHttpAuth, make);
