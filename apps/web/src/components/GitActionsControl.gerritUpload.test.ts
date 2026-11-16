import { describe, expect, it } from "vite-plus/test";
import {
  GerritTargetBranch,
  GitCommitOid,
  GerritChangeId,
  GerritInstallationId,
  GerritProjectName,
  GerritChangeNumber,
  GerritPatchSetNumber,
  type GerritDeliveryCheckout,
} from "@t3tools/contracts";
import { buildGerritUploadInput } from "./GitActionsControl.logic";

const key = {
  installation: GerritInstallationId.make("https://review.example/"),
  project: GerritProjectName.make("project"),
  branch: GerritTargetBranch.make("main"),
  changeId: GerritChangeId.make(`I${"a".repeat(40)}`),
};
const head = GitCommitOid.make("b".repeat(40));
const base = { localBranch: "feature", head, subject: "Subject", files: [] };
const options = {
  branch: " stable ",
  topic: " topic ",
  reviewers: "alice, bob@example.com",
  cc: "carol dave",
  wip: true,
  private: true,
};

describe("buildGerritUploadInput", () => {
  it("builds a new change upload with options", () => {
    const context: GerritDeliveryCheckout = { kind: "new-change", key, ...base };
    expect(buildGerritUploadInput(context, options)).toEqual({
      kind: "new",
      branch: "stable",
      commit: head,
      topic: "topic",
      reviewers: ["alice", "bob@example.com"],
      cc: ["carol", "dave"],
      wip: true,
      private: true,
    });
  });
  it("uses the matching change for a patch set and omits unset options", () => {
    const context: GerritDeliveryCheckout = {
      kind: "ready",
      change: {
        key,
        number: GerritChangeNumber.make(42),
        revision: {
          commit: GitCommitOid.make("c".repeat(40)),
          patchSet: GerritPatchSetNumber.make(3),
        },
      },
      ...base,
      topic: null,
      workInProgress: false,
    };
    expect(
      buildGerritUploadInput(context, {
        branch: "other",
        topic: "",
        reviewers: "",
        cc: "",
        wip: false,
        private: false,
      }),
    ).toEqual({ kind: "patch-set", number: 42, commit: head });
  });
  it("uses the configured branch when none is entered", () => {
    expect(
      buildGerritUploadInput({ kind: "new-change", key, ...base }, { ...options, branch: " " }),
    ).toMatchObject({ kind: "new", branch: "main" });
  });
});
