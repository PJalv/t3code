// @effect-diagnostics nodeBuiltinImport:off -- The fixture changes local POSIX modes and ACLs.
import { expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { auditGitConfigPath, GitConfigPathAuditError } from "./GitConfigPathAudit.ts";

const hook = vi.hoisted(() => ({
  afterStatfs: undefined as ((path: string) => Promise<void>) | undefined,
  unknownFilesystem: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    statfs: (async (...args: Parameters<typeof original.statfs>) => {
      const result = await original.statfs(...args);
      await hook.afterStatfs?.(String(args[0]));
      return hook.unknownFilesystem ? { ...result, type: 0x6969 } : result;
    }) as typeof original.statfs,
  };
});

it("audits real POSIX modes and ACL masks; rejects unsafe missing entries and substitution", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "git-config-audit-"));
  const uid = process.getuid!();
  try {
    const dir = NodePath.join(base, "dir");
    await NodeFSP.mkdir(dir, { mode: 0o700 });
    const target = NodePath.join(dir, "config");
    await NodeFSP.writeFile(target, "[core]\n bare = false\n", { mode: 0o600 });
    expect(await auditGitConfigPath(target, uid, HostProcess.Platform.defaultValue())).toEqual({
      missing: false,
    });
    hook.unknownFilesystem = true;
    await expect(
      auditGitConfigPath(target, uid, HostProcess.Platform.defaultValue()),
    ).rejects.toBeInstanceOf(GitConfigPathAuditError);
    hook.unknownFilesystem = false;
    expect(
      await auditGitConfigPath(
        NodePath.join(dir, "missing"),
        uid,
        HostProcess.Platform.defaultValue(),
      ),
    ).toEqual({
      missing: true,
    });
    await NodeFSP.chmod(dir, 0o777);
    await expect(
      auditGitConfigPath(target, uid, HostProcess.Platform.defaultValue()),
    ).rejects.toBeInstanceOf(GitConfigPathAuditError);
    await NodeFSP.chmod(dir, 0o700);
    await NodeFSP.symlink(dir, NodePath.join(base, "link"));
    await expect(
      auditGitConfigPath(
        NodePath.join(base, "link", "config"),
        uid,
        HostProcess.Platform.defaultValue(),
      ),
    ).rejects.toBeInstanceOf(GitConfigPathAuditError);
    await expect(
      auditGitConfigPath(
        NodePath.join(NodeOS.tmpdir(), `missing-audit-${process.pid}`),
        uid,
        HostProcess.Platform.defaultValue(),
      ),
    ).rejects.toBeInstanceOf(GitConfigPathAuditError);
    const present = NodeChildProcess.spawnSync("setfacl", ["--version"], { stdio: "ignore" });
    if (present.status === 0) {
      NodeChildProcess.execFileSync("setfacl", ["-m", "u:65534:rw-", target]);
      expect((await NodeFSP.stat(target)).mode & 0o020).not.toBe(0);
      await expect(
        auditGitConfigPath(target, uid, HostProcess.Platform.defaultValue()),
      ).rejects.toBeInstanceOf(GitConfigPathAuditError);
      NodeChildProcess.execFileSync("setfacl", ["-b", target]);
      await NodeFSP.chmod(target, 0o600);
    } else process.emitWarning("setfacl unavailable: real extended ACL check not run");
    hook.afterStatfs = async (fdPath) => {
      if ((await NodeFSP.readlink(fdPath)) !== target) return;
      hook.afterStatfs = undefined;
      await NodeFSP.rename(dir, NodePath.join(base, "old"));
      await NodeFSP.mkdir(dir, { mode: 0o700 });
      await NodeFSP.writeFile(target, "replacement", { mode: 0o600 });
    };
    await expect(
      auditGitConfigPath(target, uid, HostProcess.Platform.defaultValue()),
    ).rejects.toBeInstanceOf(GitConfigPathAuditError);
  } finally {
    hook.afterStatfs = undefined;
    hook.unknownFilesystem = false;
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});
