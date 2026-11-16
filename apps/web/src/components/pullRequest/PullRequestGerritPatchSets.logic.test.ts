import { describe, expect, it } from "vite-plus/test";
import type { PullRequestGerritDetail } from "@t3tools/contracts";
import { buildGerritComparison, isGerritFilePath } from "./PullRequestGerritPatchSets";

const detail: PullRequestGerritDetail = {
  changeId: "I123",
  topic: null,
  isPrivate: false,
  isWip: false,
  currentPatchSet: 3,
  patchSets: [1, 2, 3].map((number) => ({
    number,
    commit: `commit${number}`,
    createdAt: "2025-01-01T00:00:00Z",
  })),
  labels: [],
  submitRequirements: [],
  submittable: null,
};

describe("Gerrit diff selection", () => {
  it("defaults to current against base and retains valid comparisons", () => {
    expect(buildGerritComparison(detail, undefined)).toEqual({ patchSet: 3, base: "base" });
    expect(buildGerritComparison(detail, { patchSet: 3, base: { patchSet: 1 } })).toEqual({
      patchSet: 3,
      base: { patchSet: 1 },
    });
    expect(buildGerritComparison(detail, { patchSet: 2, base: { parent: 2 } })).toEqual({
      patchSet: 2,
      base: { parent: 2 },
    });
  });
  it("drops a missing selection or invalid earlier patch set", () => {
    expect(buildGerritComparison(detail, { patchSet: 9, base: { patchSet: 3 } })).toEqual({
      patchSet: 3,
      base: "base",
    });
    expect(buildGerritComparison(detail, { patchSet: 1, base: { patchSet: 2 } })).toEqual({
      patchSet: 1,
      base: "base",
    });
  });
  it("excludes only the change-level path", () => {
    expect(isGerritFilePath("/PATCHSET_LEVEL")).toBe(false);
    expect(isGerritFilePath("src/PATCHSET_LEVEL")).toBe(true);
  });
});
