import { describe, expect, it } from "vite-plus/test";
import { v2FileChangePatch } from "./v2FileChangeDiff";

describe("v2FileChangePatch", () => {
  it("prefers the original provider patch", () => {
    expect(v2FileChangePatch({ fileName: "src/a.ts", diffStr: "patch", newStr: "new" })).toBe(
      "patch",
    );
  });
  it("builds a unified patch from persisted old/new snapshots", () => {
    expect(v2FileChangePatch({ fileName: "src/a.ts", oldStr: "old\n", newStr: "new\n" })).toContain(
      "-old\n+new",
    );
  });
  it("preserves missing final newlines on both snapshots", () => {
    const patch = v2FileChangePatch({ fileName: "src/a.ts", oldStr: "old", newStr: "new" });
    expect(patch).toContain(
      "-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
    );
  });
  it("uses zero-line ranges for empty-file creation and truncation", () => {
    expect(v2FileChangePatch({ fileName: "empty.txt", newStr: "" })).toContain("@@ -0,0 +0,0 @@");
    expect(v2FileChangePatch({ fileName: "empty.txt", oldStr: "old\n", newStr: "" })).toContain(
      "@@ -1,1 +0,0 @@",
    );
  });
  it("preserves a file containing one blank line", () => {
    expect(v2FileChangePatch({ fileName: "blank.txt", newStr: "\n" })).toContain(
      "@@ -0,0 +1,1 @@\n+",
    );
  });
  it("does not infer deletion from a missing new snapshot", () => {
    expect(v2FileChangePatch({ fileName: "src/a.ts", oldStr: "unchanged\n" })).toBeNull();
    expect(v2FileChangePatch({ fileName: "src/a.ts" })).toBeNull();
  });
});
