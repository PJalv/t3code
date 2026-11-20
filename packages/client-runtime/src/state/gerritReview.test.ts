import {
  type GerritConnection,
  GerritConnectionConfig,
  GerritProjectName,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import {
  gerritConnectionConfigFromFields,
  gerritCredentialSaveMode,
  gerritTerminalGitCommandTemplate,
} from "./gerritReview.ts";

it("copies an explicit secret-free template with shell-safe arguments and no guessed launcher or home", () => {
  const template = gerritTerminalGitCommandTemplate("https://review.example/proxy/", "env-1");
  expect(template).toContain("# TEMPLATE: edit before running");
  expect(template?.split("\n").at(-1)).toBe(
    "'<T3-LAUNCHER>' gerrit copy-terminal-credential --base-dir '<T3-HOME>' --installation 'https://review.example/proxy/' --environment-id 'env-1'",
  );
  expect(
    gerritTerminalGitCommandTemplate("https://review.example/a'$(id)/", "env-1")
      ?.split("\n")
      .at(-1),
  ).toBe(
    "'<T3-LAUNCHER>' gerrit copy-terminal-credential --base-dir '<T3-HOME>' --installation 'https://review.example/a'\\''$(id)/' --environment-id 'env-1'",
  );
  for (const installation of [
    "http://review.example/",
    "https://alice:secret@review.example/",
    "https://review.example/?token=secret",
    "https://review.example/#secret",
  ]) {
    expect(gerritTerminalGitCommandTemplate(installation, "env-1")).toBeNull();
  }
  expect(gerritTerminalGitCommandTemplate("https://review.example/", "env';echo bad")).toBeNull();
});

const scope = {
  installation: "https://review.example/Review/",
  project: "Team/Repo",
  branch: "Release/Next",
};
const decodeConfigOption = Schema.decodeUnknownOption(GerritConnectionConfig);
const decodeProject = Schema.decodeSync(GerritProjectName);
const config = Schema.decodeSync(GerritConnectionConfig)({
  installation: scope.installation,
  authMode: "http-basic",
  bindings: [
    { url: "ssh://user@review-alias:29418/Team/Repo", project: "Team/Repo" },
    { url: "ssh://user@review-alias:29418/Other/Repo", project: "Other/Repo" },
  ],
});
const connection = {
  config,
  credentialPresent: true,
  verification: "not-tested",
} satisfies GerritConnection;

it("preserves every hidden remote binding when settings omit mapping fields", () => {
  const bindings = [
    { url: "ssh://review.example/Team/Repo", project: decodeProject("Team/Repo") },
    { url: "https://review.example/Other/Repo", project: decodeProject("Other/Repo") },
  ];
  const saved = [{ config: { ...config, bindings } }];
  const result = Option.getOrThrow(
    gerritConnectionConfigFromFields(
      { installation: config.installation, sshHost: "ssh.example" },
      saved,
    ),
  );
  expect(result.bindings).toEqual(bindings);
  expect(
    Option.getOrThrow(gerritConnectionConfigFromFields({ installation: config.installation }, []))
      .bindings,
  ).toEqual([]);
  expect(
    Option.getOrThrow(
      gerritConnectionConfigFromFields(
        { installation: config.installation, remote: "", project: "" },
        saved,
      ),
    ).bindings,
  ).toEqual(bindings.slice(1));
});

it("selects the legacy checks profile only explicitly and preserves or removes its saved choice", () => {
  const fields = {
    installation: scope.installation,
    remote: config.bindings[0]?.url ?? "",
    project: "Team/Repo",
  };
  const selected = Option.getOrThrow(
    gerritConnectionConfigFromFields({ ...fields, checksProfile: "checks-rest-v1-3.10" }, [
      connection,
    ]),
  );
  expect(selected.checksProfile).toBe("checks-rest-v1-3.10");
  const saved = [{ config: selected }];
  expect(Option.getOrThrow(gerritConnectionConfigFromFields(fields, saved)).checksProfile).toBe(
    "checks-rest-v1-3.10",
  );
  expect(
    Option.getOrThrow(gerritConnectionConfigFromFields({ ...fields, checksProfile: "none" }, saved))
      .checksProfile,
  ).toBeUndefined();
  expect(
    Option.getOrThrow(gerritConnectionConfigFromFields(fields, [])).checksProfile,
  ).toBeUndefined();
});

it("keeps only credentials belonging to the selected configured installation", () => {
  const input = {
    installation: "https://one.example/",
    connections: [{ config: { installation: "https://one.example/" }, credentialPresent: true }],
    username: "",
    token: "",
  };
  expect(gerritCredentialSaveMode(input)).toBe("keep");
  expect(gerritCredentialSaveMode({ ...input, installation: "https://other.example/" })).toBe(
    "invalid",
  );
  expect(
    gerritCredentialSaveMode({
      ...input,
      connections: [{ ...input.connections[0]!, credentialPresent: false }],
    }),
  ).toBe("invalid");
  expect(gerritCredentialSaveMode({ ...input, username: "name" })).toBe("invalid");
  expect(gerritCredentialSaveMode({ ...input, token: "token" })).toBe("invalid");
  expect(gerritCredentialSaveMode({ ...input, username: "name", token: "token" })).toBe("replace");
});

it("saves an explicit SSH username independently of HTTP credentials", () => {
  const fields = {
    installation: scope.installation,
    remote: "",
    project: "",
    sshHost: "ssh.example",
    sshUsername: "ssh-user",
    sshPort: "2222",
  };
  const selected = Option.getOrThrow(gerritConnectionConfigFromFields(fields, []));
  expect(selected.sshHost).toEqual({ host: "ssh.example", username: "ssh-user", port: 2222 });
  expect(
    Option.getOrThrow(
      gerritConnectionConfigFromFields(
        { installation: scope.installation, remote: "", project: "" },
        [{ config: selected }],
      ),
    ).sshHost,
  ).toEqual(selected.sshHost);
  expect(
    Option.isNone(gerritConnectionConfigFromFields({ ...fields, sshUsername: "-unsafe" }, [])),
  ).toBe(true);
  expect(Option.isNone(gerritConnectionConfigFromFields({ ...fields, sshHost: "" }, []))).toBe(
    true,
  );
  expect(Option.isNone(gerritConnectionConfigFromFields({ ...fields, sshPort: "65536" }, []))).toBe(
    true,
  );
});

it("rejects unverified checks profile names at the contract boundary", () => {
  for (const checksProfile of ["checks-ui", "auto", "checks-rest-v1-3.13"]) {
    expect(decodeConfigOption({ ...config, checksProfile })._tag).toBe("None");
  }
});

it("normalizes the installation without dropping untouched exact bindings", () => {
  const result = gerritConnectionConfigFromFields(
    {
      installation: "https://REVIEW.example/Review",
      remote: config.bindings[0]?.url ?? "",
      project: "Team/Repo",
    },
    [connection],
  );
  expect(Option.getOrThrow(result)).toEqual(config);
  expect(
    Option.getOrThrow(
      gerritConnectionConfigFromFields(
        { installation: scope.installation, remote: "", project: "" },
        [connection],
      ),
    ).bindings,
  ).toEqual(config.bindings.slice(1));
  expect(
    Option.isNone(
      gerritConnectionConfigFromFields(
        { installation: "https://user:secret@review.example/Review/", remote: "", project: "" },
        [],
      ),
    ),
  ).toBe(true);
});
