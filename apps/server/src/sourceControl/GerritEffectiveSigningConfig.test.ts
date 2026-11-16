// @effect-diagnostics nodeBuiltinImport:off -- Real local Git fixtures verify config resolution.
import { expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { parseEffectiveSigningConfig } from "./GerritEffectiveSigningConfig.ts";

it("resolves real included and repository Git config in effective order", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gerrit-config-"));
  const env = {
    PATH: process.env.PATH,
    HOME: base,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) => NodeChildProcess.execFileSync("git", args, { cwd: base, env });
  try {
    git("init", "--quiet");
    const key = "B".repeat(40);
    await NodeFSP.writeFile(
      NodePath.join(base, "included"),
      `[user]\n signingkey = ${key}!\n[gpg]\n program = /earlier\n`,
    );
    git("config", "--local", "include.path", NodePath.join(base, "included"));
    git("config", "--local", "gpg.openpgp.program", "/winner");
    const config = git("config", "--includes", "--null", "--show-origin", "--show-scope", "--list");
    expect(parseEffectiveSigningConfig(config)).toEqual({
      format: "openpgp",
      fingerprint: key,
      program: "/winner",
      commitSign: undefined,
    });
    for (const value of ["", "0", "2", "-2", "1k", "yes", "no"]) {
      git("config", "--local", "commit.gpgsign", value);
      const expected =
        git("config", "--type=bool", "--get", "commit.gpgsign").toString().trim() === "true";
      expect(
        parseEffectiveSigningConfig(
          git("config", "--includes", "--null", "--show-origin", "--show-scope", "--list"),
        ).commitSign,
      ).toBe(expected);
    }
    git("config", "--local", "gpg.format", "OpenPGP");
    expect(() =>
      parseEffectiveSigningConfig(
        git("config", "--includes", "--null", "--show-origin", "--show-scope", "--list"),
      ),
    ).toThrow();
    git("config", "--local", "gpg.format", "ssh");
    expect(() =>
      parseEffectiveSigningConfig(
        git("config", "--includes", "--null", "--show-origin", "--show-scope", "--list"),
      ),
    ).toThrow();
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});

it("follows ordered Git settings and preserves subsection case without launching anything", () => {
  const key = "A".repeat(40);
  const entry = (scope: string, origin: string, name: string, value?: string) =>
    `${scope}\0${origin}\0${name}${value === undefined ? "" : `\n${value}`}\0`;
  const base = entry("local", "file:repo", "user.signingkey", `${key}!`);
  const bytes = (s: string) => Buffer.from(s);
  expect(
    parseEffectiveSigningConfig(
      bytes(
        base +
          entry("system", "file:system", "gpg.program", "/host/first") +
          entry("local", "file:included", "gpg.openpgp.program", "/host/last") +
          entry("local", "file:repo", "gpg.OpenPGP.program", "/ignored") +
          entry("local", "file:repo", "unrelated.flag") +
          entry("local", "file:repo", "commit.gpgsign"),
      ),
    ),
  ).toEqual({ format: "openpgp", program: "/host/last", fingerprint: key, commitSign: true });
  expect(
    parseEffectiveSigningConfig(
      bytes(
        base +
          entry("global", "file:global", "gpg.openpgp.program", "first") +
          entry("local", "file:repo", "gpg.program", "last"),
      ),
    ).program,
  ).toBe("last");
  expect(() =>
    parseEffectiveSigningConfig(bytes(base + entry("local", "file:repo", "gpg.format", "ssh"))),
  ).toThrow();
  expect(() =>
    parseEffectiveSigningConfig(bytes(entry("local", "file:repo", "user.signingkey", key))),
  ).toThrow();
  expect(() =>
    parseEffectiveSigningConfig(bytes(base + entry("local", "file:repo", "gpg.program"))),
  ).toThrow();
  expect(() => parseEffectiveSigningConfig(Buffer.from([255, 0]))).toThrow();
  expect(
    parseEffectiveSigningConfig(bytes(base + entry("local", "file:repo", "commit.gpgsign", "")))
      .commitSign,
  ).toBe(false);
  expect(
    parseEffectiveSigningConfig(bytes(base + entry("local", "file:repo", "commit.gpgsign", "2")))
      .commitSign,
  ).toBe(true);
  expect(() =>
    parseEffectiveSigningConfig(bytes(base + entry("local", "file:repo", "gpg.format", "OpenPGP"))),
  ).toThrow();
});
