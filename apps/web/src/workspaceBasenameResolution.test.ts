import { describe, expect, it, vi } from "vite-plus/test";
import {
  cachedWorkspaceBasenameLookup,
  collectWorkspaceBasenameCandidates,
} from "./workspaceBasenameResolution";

describe("workspace basename pre-resolution", () => {
  it("keeps only unique bare path candidates, including image destinations", () => {
    expect(
      collectWorkspaceBasenameCandidates([
        "draft.png",
        "draft.png",
        "src/draft.png",
        "/tmp/draft.png",
        "https://host/draft.png",
      ]),
    ).toEqual(new Set(["draft.png"]));
  });
  it("reuses an in-flight lookup for repeated streaming references", async () => {
    const lookup = vi.fn(async (name: string) => `src/${name}`);
    const cache = new Map<string, Promise<string | null>>();
    await expect(
      Promise.all([
        cachedWorkspaceBasenameLookup(cache, "a.png", lookup),
        cachedWorkspaceBasenameLookup(cache, "a.png", lookup),
      ]),
    ).resolves.toEqual(["src/a.png", "src/a.png"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
