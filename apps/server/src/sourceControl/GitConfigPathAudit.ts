// @effect-diagnostics extendsNativeError:off -- Plain async helpers reject with native errors; callers map them.
// @effect-diagnostics nodeBuiltinImport:off -- Linux descriptor walks and statfs enforce the host trust boundary.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export class GitConfigPathAuditError extends Error {}
const knownFilesystems = new Set([0xef53, 0x9123683e, 0x01021994]);
const directoryFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW;
const fileFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | NodeFS.constants.O_NOFOLLOW;
const same = (a: NodeFS.Stats, b: NodeFS.Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.ctimeMs === b.ctimeMs;

/** A negative dependency is accepted only beneath a parent others cannot write. */
export async function auditGitConfigPath(
  path: string,
  serverUid: number,
  platform: NodeJS.Platform,
  directory = false,
): Promise<{ readonly missing: boolean }> {
  if (
    platform !== "linux" ||
    !NodePath.isAbsolute(path) ||
    path !== NodePath.normalize(path) ||
    path === "/" ||
    !Number.isSafeInteger(serverUid) ||
    serverUid < 0
  )
    throw new GitConfigPathAuditError();
  const parts = path.split("/").filter(Boolean);
  const held: NodeFSP.FileHandle[] = [];
  const identities: NodeFS.Stats[] = [];
  const revalidate = async (file: NodeFS.Stats | undefined, missingAt = parts.length - 1) => {
    const opened: NodeFSP.FileHandle[] = [];
    try {
      let cursor = await NodeFSP.open("/", directoryFlags);
      opened.push(cursor);
      if (!same(identities[0]!, await cursor.stat())) throw new GitConfigPathAuditError();
      for (let i = 0; i < missingAt; i++) {
        cursor = await NodeFSP.open(`/proc/self/fd/${cursor.fd}/${parts[i]!}`, directoryFlags);
        opened.push(cursor);
        if (!same(identities[i + 1]!, await cursor.stat())) throw new GitConfigPathAuditError();
      }
      if (!file) {
        try {
          const unexpected = await NodeFSP.open(
            `/proc/self/fd/${cursor.fd}/${parts[missingAt]!}`,
            missingAt === parts.length - 1 ? fileFlags : directoryFlags,
          );
          opened.push(unexpected);
          throw new GitConfigPathAuditError();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      } else {
        const reopened = await NodeFSP.open(
          `/proc/self/fd/${cursor.fd}/${parts.at(-1)!}`,
          directory ? directoryFlags : fileFlags,
        );
        opened.push(reopened);
        if (!same(file, await reopened.stat())) throw new GitConfigPathAuditError();
      }
    } finally {
      for (const handle of opened.toReversed()) await handle.close();
    }
  };
  try {
    let cursor = await NodeFSP.open("/", directoryFlags);
    held.push(cursor);
    for (let i = 0; ; i++) {
      const info = await cursor.stat();
      identities.push(info);
      if (!info.isDirectory() || (info.uid !== 0 && info.uid !== serverUid))
        throw new GitConfigPathAuditError();
      const fs = await NodeFSP.statfs(`/proc/self/fd/${cursor.fd}`);
      if (!knownFilesystems.has(fs.type)) throw new GitConfigPathAuditError();
      // On these POSIX-ACL filesystems the group mode bits include the ACL mask.
      const otherWritable = (info.mode & 0o022) !== 0;
      const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
      if (otherWritable && !stickyRoot) throw new GitConfigPathAuditError();
      const last = i === parts.length - 1;
      let child: NodeFSP.FileHandle;
      try {
        child = await NodeFSP.open(
          `/proc/self/fd/${cursor.fd}/${parts[i]!}`,
          last && !directory ? fileFlags : directoryFlags,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !otherWritable) {
          await revalidate(undefined, i);
          return { missing: true };
        }
        throw error;
      }
      held.push(child);
      if (last) {
        const file = await child.stat();
        if (
          (directory ? !file.isDirectory() : !file.isFile()) ||
          (file.uid !== 0 && file.uid !== serverUid) ||
          ((file.mode & 0o022) !== 0 &&
            !(directory && file.uid === 0 && (file.mode & 0o1000) !== 0))
        )
          throw new GitConfigPathAuditError();
        const fs = await NodeFSP.statfs(`/proc/self/fd/${child.fd}`);
        if (!knownFilesystems.has(fs.type)) throw new GitConfigPathAuditError();
        for (const [index, dir] of held.slice(0, -1).entries())
          if (!same(identities[index]!, await dir.stat())) throw new GitConfigPathAuditError();
        await revalidate(file);
        return { missing: false };
      }
      cursor = child;
    }
  } catch {
    throw new GitConfigPathAuditError();
  } finally {
    for (const handle of held.toReversed()) await handle.close();
  }
}
