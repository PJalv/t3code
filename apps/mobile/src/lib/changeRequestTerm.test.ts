import { expect, it } from "vite-plus/test";
import { changeRequestTermKind } from "./changeRequestTerm";

it.each([
  ["change", "cr"],
  ["change request", "cr"],
  ["merge request", "mr"],
  ["pull request", "pr"],
] as const)("selects the translated noun for %s", (singular, expected) => {
  expect(changeRequestTermKind({ singular })).toBe(expected);
});
