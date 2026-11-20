import { describe, expect, it } from "vite-plus/test";
import { gtFallback } from "gt-react";
import { changeRequestTermKind } from "./changeRequestTerm";

describe("change request terminology", () => {
  it.each([
    ["change", "cr"],
    ["change request", "cr"],
    ["merge request", "mr"],
    ["pull request", "pr"],
  ] as const)("selects the translated noun for %s", (singular, expected) => {
    expect(changeRequestTermKind({ singular })).toBe(expected);
  });

  it("does not fall back to a pull request for Gerrit in a translated sentence", () => {
    expect(
      gtFallback("{term, select, cr {Änderungsanfrage} mr {Merge-Anfrage} other {Pull-Anfrage}}", {
        term: changeRequestTermKind({ singular: "change" }),
        $locale: "de",
      }),
    ).toBe("Änderungsanfrage");
  });
});
