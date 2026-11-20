import { describe, expect, it, vi } from "vite-plus/test";
import type { MessageResolver } from "~/i18n/messages";
import {
  gerritCommitMessageParts,
  gerritRequirementStatus,
  gerritRequirementTone,
  gerritVoteOptions,
  gerritSummaryControls,
  gerritTopicValue,
} from "./PullRequestGerritSummary";

describe("Gerrit presentation", () => {
  it("resolves requirement labels with the caller’s active locale", () => {
    const resolve = vi.fn(() => "Erfüllt") as unknown as MessageResolver;
    expect(gerritRequirementStatus("satisfied", resolve)).toBe("Erfüllt");
    expect(resolve).toHaveBeenCalledOnce();
    expect(gerritRequirementStatus("satisfied")).toBe("Satisfied");
  });
  it("gates topic and privacy on both permissions and normalizes cleared topics", () => {
    const permissions = {
      setTopic: true,
      setPrivate: false,
      setWip: false,
      setCommitMessage: false,
      cherryPick: false,
      rebase: false,
      rebaseChain: false,
      abandon: false,
      restore: false,
      submit: false,
    };
    expect(gerritSummaryControls(true, permissions)).toEqual({ topic: true, private: false });
    expect(gerritSummaryControls(false, { ...permissions, setPrivate: true })).toEqual({
      topic: false,
      private: false,
    });
    expect(gerritSummaryControls(true, undefined)).toEqual({ topic: false, private: false });
    expect(gerritSummaryControls(true, { ...permissions, setPrivate: true }).private).toBe(true);
    expect(gerritTopicValue("  topic  ")).toBe("topic");
    expect(gerritTopicValue("  ")).toBeNull();
  });
  it("only offers reported vote values, sorted and formatted", () => {
    expect(gerritVoteOptions([-1, 0, 2, 2])).toEqual([
      { value: "2", label: "+2" },
      { value: "0", label: "0" },
      { value: "-1", label: "-1" },
    ]);
    expect(gerritVoteOptions([2, -1], { "+2": "Looks good to me, approved" })).toEqual([
      { value: "2", label: "+2 Looks good to me, approved" },
      { value: "-1", label: "-1" },
    ]);
    expect(gerritVoteOptions([])).toEqual([]);
  });
  it("does not present unavailable requirements as satisfied", () => {
    expect(gerritRequirementStatus("satisfied")).toBe("Satisfied");
    expect(gerritRequirementStatus("unsatisfied")).toBe("Not met");
    expect(gerritRequirementStatus("not-applicable")).toBe("Not applicable");
    expect(gerritRequirementStatus("override")).toBe("Overridden");
    expect(gerritRequirementStatus("error")).toBe("Error");
    expect(gerritRequirementStatus("unknown")).toBe("Unknown");
    expect(gerritRequirementStatus(null)).toBe("Unavailable");
    expect(gerritRequirementStatus("future-status")).toBe("Unavailable");
  });
  it("colors requirements by outcome and never shows unknown as satisfied", () => {
    expect(gerritRequirementTone("satisfied")).toBe("success");
    expect(gerritRequirementTone("unsatisfied")).toBe("warning");
    expect(gerritRequirementTone("error")).toBe("error");
    expect(gerritRequirementTone("override")).toBe("info");
    expect(gerritRequirementTone("unknown")).toBe("secondary");
    expect(gerritRequirementTone(null)).toBe("secondary");
  });
  it("separates the commit body from its subject and trailers", () => {
    expect(
      gerritCommitMessageParts(
        "feat: subject\n\nWhy it changed.\n\nChange-Id: I1\nSigned-off-by: A <a@example.com>\n",
      ),
    ).toEqual({
      body: "Why it changed.",
      footers: [{ key: "Signed-off-by", value: "A <a@example.com>" }],
    });
    expect(gerritCommitMessageParts("feat: subject\n\nChange-Id: I1")).toEqual({
      body: "",
      footers: [],
    });
    // A last paragraph with prose is body text, not a trailer block.
    expect(gerritCommitMessageParts("s\n\nNote: this is prose\nand continues").footers).toEqual([]);
    expect(gerritCommitMessageParts("only a subject")).toEqual({ body: "", footers: [] });
  });
});
