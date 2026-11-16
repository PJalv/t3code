import { describe, expect, it } from "vite-plus/test";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { gerritRouteBack, parseGerritRoute } from "./gerritRoute.logic";

const source = { environmentId: "env-1", installation: "https://review.example/" };
const change = {
  key: {
    installation: "https://review.example/",
    project: "team/project",
    branch: "main",
    changeId: `I${"a".repeat(40)}`,
  },
  number: 123,
};

describe("Gerrit route", () => {
  it("restores a complete canonical selection after URL serialization", () => {
    const state = { ...source, change };
    const url = defaultStringifySearch({ gerrit: state });
    const parsed = defaultParseSearch(url) as Record<string, unknown>;
    expect(parseGerritRoute(parsed.gerrit)).toEqual(state);
  });
  it("does not select partial, malformed, or conflicting changes", () => {
    for (const invalid of [
      { ...change, number: 0 },
      { ...change, key: { ...change.key, branch: "" } },
      { ...change, key: { ...change.key, installation: "https://other.example/" } },
      { number: 123 },
    ])
      expect(parseGerritRoute({ ...source, change: invalid })).toEqual(source);
  });
  it("closes the detail before leaving the Gerrit list on Escape", () => {
    const state = parseGerritRoute({ ...source, change });
    expect(state).toBeDefined();
    const list = gerritRouteBack(state!);
    expect(list).toEqual(source);
    expect(gerritRouteBack(list!)).toBeUndefined();
  });
  it("rejects malformed sources", () => {
    expect(
      parseGerritRoute({ environmentId: "", installation: "https://review.example/" }),
    ).toBeUndefined();
    expect(
      parseGerritRoute({ environmentId: "env-1", installation: "../invalid" }),
    ).toBeUndefined();
    expect(parseGerritRoute("review")).toBeUndefined();
  });
});
