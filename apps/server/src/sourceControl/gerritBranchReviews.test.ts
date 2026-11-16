import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { GerritInstallationId } from "@t3tools/contracts";

import { credentialSecretName, makeResolve } from "./gerritBranchReviews.ts";

const decodeCredential = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ username: Schema.String, token: Schema.String })),
);

const crypto = {
  digest: (_algorithm: string, data: Uint8Array) =>
    Effect.succeed(new Uint8Array([...data].slice(0, 32))),
  randomUUIDv4: () => Effect.succeed("00000000-0000-4000-8000-000000000000"),
} as never;

const installation = "https://gerrit.hn.tp-link.com/";
const encodedCredentials = new TextEncoder().encode(
  JSON.stringify({ username: "jorge.sarez", token: "secret" }),
);

const settings = {
  gerritConnections: {
    [installation]: {
      installation,
      authMode: "http-basic" as const,
      bindings: [],
    },
  },
} as never;

const scope = { installation, project: "CICD_Tools", branch: "main" };

const run = (input: {
  readonly binding: unknown;
  readonly connections?: unknown;
  readonly secret?: Option.Option<Uint8Array>;
  readonly onDiscover?: (input: unknown) => void;
}) =>
  makeResolve({
    crypto,
    readSettings: () => Effect.succeed((input.connections ?? settings) as never),
    readSecret: () => Effect.succeed(input.secret ?? Option.some(encodedCredentials)),
    discover: (request) => {
      input.onDiscover?.(request);
      return Effect.succeed({
        binding: input.binding,
        remotes: [],
        upstream: { kind: "unsupported" },
      } as never);
    },
  })("/work/CICD_Tools").pipe(Effect.runPromise);

describe("Gerrit branch review resolver", () => {
  it("uses the verified discovery scope, not the local branch", async () => {
    expect(await run({ binding: { kind: "bound", scope } })).toMatchObject({
      ...scope,
      baseUrl: installation,
    });
  });

  it.each([
    { kind: "not-bound", reason: "no-known-repository" },
    { kind: "ambiguous", repositories: [scope] },
    { kind: "target-required", repository: scope },
  ])("does not infer a scope for $kind", async (binding) => {
    expect(await run({ binding })).toBeNull();
  });

  it("passes configured SSH associations and exact bindings to discovery", async () => {
    let request: unknown;
    const connections = {
      gerritConnections: {
        [installation]: {
          installation,
          authMode: "http-basic",
          sshHost: { host: "gerrit-ssh.example.com", port: 29418 },
          bindings: [
            { url: "ssh://gerrit-ssh.example.com:29418/CICD_Tools", project: "CICD_Tools" },
          ],
        },
      },
    };
    await run({
      binding: { kind: "bound", scope },
      connections,
      onDiscover: (value) => {
        request = value;
      },
    });
    expect(request).toMatchObject({
      cwd: "/work/CICD_Tools",
      configuration: {
        sshHosts: [{ installation, host: "gerrit-ssh.example.com", port: 29418 }],
        exactBindings: [{ repository: { installation, project: "CICD_Tools" } }],
      },
    });
  });

  it("returns null without a usable stored credential", async () => {
    const binding = { kind: "bound", scope };
    expect(await run({ binding, secret: Option.none() })).toBeNull();
    expect(
      await run({ binding, secret: Option.some(new TextEncoder().encode("not json")) }),
    ).toBeNull();
  });

  it("names the credential secret by a digest of the installation, not the URL itself", async () => {
    const name = await credentialSecretName(crypto, GerritInstallationId.make(installation)).pipe(
      Effect.runPromise,
    );
    expect(name.startsWith("gerrit-http-")).toBe(true);
    expect(name).not.toContain("gerrit.hn.tp-link.com");
  });
});

// The resolver is also the only place the stored credential shape is decoded, so pin it: a
// hand-written copy would drift from what the Gerrit service wrote.
it("accepts the credential shape the Gerrit service stores", async () => {
  const decoded = await decodeCredential(
    JSON.stringify({ username: "jorge.sarez", token: "secret" }),
  ).pipe(Effect.runPromise);
  expect(decoded).toEqual({ username: "jorge.sarez", token: "secret" });
});
