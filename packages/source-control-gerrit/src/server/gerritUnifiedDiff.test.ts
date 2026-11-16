import { describe, expect, it } from "@effect/vitest";
import { renderGerritUnifiedDiff } from "./gerritUnifiedDiff.ts";
import type { GerritDiffResult } from "@t3tools/contracts";

const text = (
  content: Extract<GerritDiffResult, { kind: "text" }>["content"],
): GerritDiffResult => ({ kind: "text", header: [], oldPath: null, newPath: null, content });

describe("renderGerritUnifiedDiff", () => {
  it.each([
    ["M", '--- "a/file"\n+++ "b/file"', "@@ -1,1 +1,1 @@"],
    ["A", '--- /dev/null\n+++ "b/file"', "@@ -0,0 +1,1 @@"],
    ["D", '--- "a/file"\n+++ /dev/null', "@@ -1,1 +0,0 @@"],
  ])("renders %s headers and hunk coordinates", (status, headers, hunk) => {
    const content =
      status === "A"
        ? [{ b: ["new"] }]
        : status === "D"
          ? [{ a: ["old"] }]
          : [{ a: ["old"], b: ["new"] }];
    const result = renderGerritUnifiedDiff([{ path: "file", status, diff: text(content) }]);
    expect(result.truncated).toBe(false);
    expect(result.patch).toContain(headers);
    expect(result.patch).toContain(hunk);
  });

  it.each([
    ["R", "rename"],
    ["C", "copy"],
  ])("renders %s metadata with escaped paths", (status, operation) => {
    const { patch } = renderGerritUnifiedDiff([
      { path: "new\tfile", oldPath: "old file", status, diff: text([{ ab: ["same"] }]) },
    ]);
    expect(patch).toContain(`${operation} from "old file"\n${operation} to "new\\tfile"`);
    expect(patch).toContain('diff --git "a/old file" "b/new\\tfile"');
  });

  it("preserves context and positions across skipped lines and reports truncation", () => {
    const result = renderGerritUnifiedDiff([
      {
        path: "f",
        status: "M",
        diff: text([
          { skip: 4 },
          { ab: ["context"], a: ["before"], b: ["after"] },
          { skip: 2 },
          { b: ["tail"] },
        ]),
      },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.patch).toContain(
      "@@ -5,2 +5,2 @@\n context\n-before\n+after\n@@ -8,0 +9,1 @@\n+tail\n",
    );
  });

  it("marks known missing final newlines", () => {
    const result = renderGerritUnifiedDiff(
      [{ path: "f", status: "M", diff: text([{ a: ["before"], b: ["after"] }]) }],
      { noNewline: { f: { old: true, new: true } } },
    );
    expect(result.patch).toContain(
      "-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n",
    );
  });

  it("reports binary, unavailable, submodule and missing content honestly", () => {
    for (const kind of ["oversize", "unavailable-history", "submodule"] as const) {
      const result = renderGerritUnifiedDiff([
        { path: "f", status: "M", diff: { kind, reason: "unavailable" } },
      ]);
      expect(result.truncated).toBe(true);
      if (kind === "submodule") {
        expect(
          renderGerritUnifiedDiff([
            { path: "f", status: "A", diff: { kind, reason: "unavailable" } },
          ]).patch,
        ).toContain("new file mode 160000");
      }
    }
    expect(renderGerritUnifiedDiff([{ path: "f", status: "M" }]).truncated).toBe(true);
    const binary = renderGerritUnifiedDiff([{ path: "f", status: "M", binary: true }]);
    expect(binary).toEqual({
      patch: 'diff --git "a/f" "b/f"\nBinary files "a/f" and "b/f" differ\n',
      truncated: false,
    });
  });

  it("omits the commit-message pseudo-file", () => {
    expect(renderGerritUnifiedDiff([{ path: "/COMMIT_MSG", status: "M" }])).toEqual({
      patch: "",
      truncated: false,
    });
  });
});
