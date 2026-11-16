import { describe, expect, it } from "vite-plus/test";

import { parseWorktreeStatus } from "./gerritWorktreeStatus.ts";

describe("parseWorktreeStatus", () => {
  it("skips the original path of a rename and flags untracked and unmerged entries", () => {
    expect(
      parseWorktreeStatus(" M edited.txt\0R  new.txt\0old.txt\0?? fresh.txt\0UU both.txt\0"),
    ).toEqual([
      { path: "edited.txt", status: " M", untracked: false, unmerged: false },
      { path: "new.txt", status: "R ", untracked: false, unmerged: false },
      { path: "fresh.txt", status: "??", untracked: true, unmerged: false },
      { path: "both.txt", status: "UU", untracked: false, unmerged: true },
    ]);
  });

  it("rejects paths that escape the checkout or touch .git", () => {
    expect(parseWorktreeStatus(" M ../outside.txt\0")).toBeNull();
    expect(parseWorktreeStatus(" M .git/config\0")).toBeNull();
    expect(parseWorktreeStatus(" M /abs.txt\0")).toBeNull();
  });
});
