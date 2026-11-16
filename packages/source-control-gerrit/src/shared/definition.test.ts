import { describe, expect, it } from "vite-plus/test";
import { definition } from "./definition.ts";

describe("Gerrit change URLs", () => {
  const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

  it("reads projects, prefixes, ports, and patch-set suffixes", () => {
    expect(parse("https://review.example:8443/prefix/a/c/Team/Repo/+/123/2")).toEqual({
      host: "review.example",
      authority: "review.example:8443",
      repository: "team/repo",
      number: 123,
      repositoryUrl: "https://review.example:8443/prefix/Team/Repo",
    });
  });

  it("reads shorthand routes without a project", () => {
    for (const path of ["/#/c/123", "/c/123", "/prefix/a/c/123"]) {
      expect(parse(`https://review.example${path}`)).toMatchObject({
        host: "review.example",
        repository: "",
        number: 123,
      });
    }
  });

  it("rejects invalid numbers, unrelated routes, and non-HTTP URLs", () => {
    for (const url of [
      "https://review.example/c/repo/+/0",
      "https://review.example/other#/c/123",
      "https://review.example/c/repo/+/9007199254740992",
      "https://review.example/team/repo/pull/123",
      "ssh://review.example/c/repo/+/123",
    ])
      expect(parse(url), url).toBeNull();
  });

  it("builds change URLs below the server root, keeping the project's case", () => {
    const url = (remoteUrl?: string) =>
      definition.changeRequestUrl({
        host: "review.example",
        repository: "Team/Repo",
        number: 7,
        remoteUrl,
      });
    expect(url("https://review.example/prefix/a/Team/Repo")).toBe(
      "https://review.example/prefix/c/Team/Repo/+/7",
    );
    expect(url("https://review.example/Team/Repo.git")).toBe(
      "https://review.example/c/Team/Repo/+/7",
    );
    expect(url("ssh://user@review.example:29418/Team/Repo")).toBe(
      "https://review.example/c/Team/Repo/+/7",
    );
  });
});
