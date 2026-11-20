import { describe, expect, it, vi } from "vite-plus/test";
import type { MessageResolver } from "../../i18n/messages";
vi.mock("react-native", () => ({ View: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null, AppTextInput: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => null }));
vi.mock("./usePullRequestDiff", () => ({ pullRequestTarget: () => null }));
import {
  filterGerritPatchSetFile,
  gerritRequirementStatus,
  gerritVoteOptions,
} from "./PullRequestGerritSection";
import { buildReviewParsedDiff } from "../review/reviewModel";

describe("Gerrit presentation", () => {
  it("resolves requirement labels with the caller’s active locale", () => {
    const resolve = vi.fn(() => "Erfüllt") as unknown as MessageResolver;
    expect(gerritRequirementStatus("satisfied", resolve)).toBe("Erfüllt");
    expect(resolve).toHaveBeenCalledOnce();
    expect(gerritRequirementStatus("satisfied")).toBe("Satisfied");
  });
  it("uses only distinct permitted vote values", () => {
    expect(gerritVoteOptions([0, -1, 2, 0])).toEqual([
      { value: "2", label: "+2" },
      { value: "0", label: "0" },
      { value: "-1", label: "-1" },
    ]);
    expect(gerritVoteOptions([])).toEqual([]);
  });
  it("does not treat an unknown requirement as satisfied", () => {
    expect(gerritRequirementStatus("unknown")).toBe("Unavailable");
    expect(gerritRequirementStatus(null)).toBe("Unavailable");
    expect(gerritRequirementStatus("satisfied")).toBe("Satisfied");
    expect(gerritRequirementStatus("unsatisfied")).toBe("Unsatisfied");
  });
  it("removes only the patch-set-level pseudo file", () => {
    const parsed = buildReviewParsedDiff(
      "diff --git a/one b/one\n--- a/one\n+++ b/one\n@@ -1 +1 @@\n-old\n+new\n",
      "pr",
    );
    if (parsed.kind !== "files") throw new Error("Expected files");
    const input = {
      ...parsed,
      files: [{ ...parsed.files[0]!, path: "/PATCHSET_LEVEL" }, ...parsed.files],
      fileCount: 2,
      additions: 2,
      deletions: 2,
    };
    expect(filterGerritPatchSetFile(input)).toMatchObject({
      files: parsed.files,
      fileCount: 1,
      additions: 1,
      deletions: 1,
    });
    expect(filterGerritPatchSetFile(parsed)).toBe(parsed);
  });
});
