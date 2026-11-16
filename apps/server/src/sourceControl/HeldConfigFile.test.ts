// @effect-diagnostics nodeBuiltinImport:off -- Local fixtures substitute path components.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HeldConfigError, withHeldConfigFile } from "./HeldConfigFile.ts";

it("rejects parent replacement and symlink components", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "held-config-"));
  try {
    const parent = NodePath.join(base, "config");
    await NodeFSP.mkdir(parent);
    const path = NodePath.join(parent, "gitconfig");
    await NodeFSP.writeFile(path, "[user]\n name = original\n");
    const before = await withHeldConfigFile(path, async (data) => data.toString());
    expect(before).toContain("original");
    await expect(
      withHeldConfigFile(path, async () => {
        await NodeFSP.rename(parent, NodePath.join(base, "held"));
        await NodeFSP.mkdir(parent);
        await NodeFSP.writeFile(path, "[user]\n name = replacement\n");
      }),
    ).rejects.toBeInstanceOf(HeldConfigError);
    await NodeFSP.symlink(parent, NodePath.join(base, "link"));
    await expect(
      withHeldConfigFile(NodePath.join(base, "link", "gitconfig"), async () => {}),
    ).rejects.toBeInstanceOf(HeldConfigError);
    await expect(
      withHeldConfigFile(NodePath.join(parent, "absent"), async () => {}),
    ).rejects.toBeInstanceOf(HeldConfigError);
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});
