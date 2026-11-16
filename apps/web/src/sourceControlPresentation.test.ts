import { describe, expect, it } from "vite-plus/test";
import { GerritIcon } from "./components/Icons";
import { getSourceControlPresentationForKind } from "./sourceControlPresentation";

describe("sourceControlPresentation", () => {
  it("uses the Gerrit mark for the native Gerrit provider", () => {
    expect(getSourceControlPresentationForKind("gerrit").Icon).toBe(GerritIcon);
  });
});
