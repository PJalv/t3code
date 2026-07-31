import { describe, expect, it } from "vite-plus/test";

import { selectInlineFileChangeDiffs } from "./inlineFileChangeDiff";

describe("selectInlineFileChangeDiffs", () => {
  const files = [{ name: "a/tplink/test.nix" }, { name: "a/tplink/other.nix" }];

  it("selects the diff matching an absolute provider file path", () => {
    expect(
      selectInlineFileChangeDiffs(files, ["/home/pjalv/work/tplink/test.nix"], "/home/pjalv/work"),
    ).toEqual([{ name: "a/tplink/test.nix" }]);
  });

  it("matches paths that include the workspace directory label", () => {
    expect(
      selectInlineFileChangeDiffs(files, ["work/tplink/test.nix"], "/home/pjalv/work"),
    ).toEqual([{ name: "a/tplink/test.nix" }]);
  });

  it("keeps the complete turn patch when provider paths cannot be correlated", () => {
    expect(selectInlineFileChangeDiffs(files, ["outside/unknown.nix"], "/home/pjalv/work")).toEqual(
      files,
    );
  });
});
