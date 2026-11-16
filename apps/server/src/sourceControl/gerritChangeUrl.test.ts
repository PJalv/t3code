import { expect, it } from "vite-plus/test";
import { changeFromUrl, changeNumberFromUrl, uniqueChangeFromUrl } from "./gerritChangeUrl.ts";

it("matches a change independently of a checkout and preserves the installation base path", () => {
  expect(
    uniqueChangeFromUrl("https://review.example/gerrit/c/team/project/+/42", [
      "https://other.example/",
      "https://review.example/gerrit/",
    ]),
  ).toEqual({
    installation: "https://review.example/gerrit/",
    project: "team/project",
    number: 42,
  });
  expect(
    changeNumberFromUrl(
      "https://review.example/gerrit/c/team/project/+/42",
      "https://review.example/gerrit/",
      "other/project",
    ),
  ).toBeNull();
});

it("accepts common patch set and file links and number-only routes", () => {
  const base = "https://review.example/gerrit/";
  for (const suffix of [
    "/3",
    "/3/src/file.ts",
    "/3/src/file.ts#b12",
    "/edit/a.txt?usp=email#comments",
    "?tab=comments",
  ]) {
    expect(changeFromUrl(`${base}c/team/project/+/42${suffix}`, base)).toEqual({
      project: "team/project",
      number: 42,
    });
  }
  expect(changeFromUrl(`${base}#/c/team/project/+/42/3/a.ts`, base)).toEqual({
    project: "team/project",
    number: 42,
  });
  expect(changeFromUrl(`${base}#/c/42/3`, base)).toEqual({ number: 42 });
  for (const route of ["42", "c/42", "42/3/a.ts#12"]) {
    expect(changeFromUrl(`${base}${route}`, base)).toEqual({ number: 42 });
    expect(changeNumberFromUrl(`${base}${route}`, base, "team/project")).toBeNull();
  }
  expect(uniqueChangeFromUrl(`${base}42`, ["https://review.example/", base])).toBeNull();
});

it("rejects ambiguous installations and unsafe or mismatched URLs", () => {
  expect(
    uniqueChangeFromUrl("https://review.example/gerrit/c/team/project/+/42", [
      "https://review.example/",
      "https://review.example/gerrit/",
    ]),
  ).toBeNull();
  for (const url of [
    "https://review.example/gerrit-extra/c/team/project/+/42",
    "https://evil.example/gerrit/c/team/project/+/42",
    "https://user@review.example/gerrit/c/team/project/+/42",
    "https://review.example/gerrit/c/team/project/+/42?",
    "https://review.example/gerrit/c/team/project/+/42?redirect=https://evil.example",
    "https://review.example/gerrit/c/team/project/+/42/3/../../evil",
    "https://review.example/gerrit/c/team/project/+/0",
    "https://review.example/gerrit/c/team/project/+/9007199254740992",
    "https://review.example/gerrit/c/team/project/+/42#/c/other/+/2",
    "https://review.example/gerrit/#/c/42/1/../../other",
  ])
    expect(changeFromUrl(url, "https://review.example/gerrit/")).toBeNull();
});
