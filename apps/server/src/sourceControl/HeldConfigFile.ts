// @effect-diagnostics extendsNativeError:off -- Plain async helpers reject with native errors; callers map them.
// @effect-diagnostics nodeBuiltinImport:off -- Linux descriptor walks reject substituted path components.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";

export class HeldConfigError extends Error {}
const sameDirectory = (a: NodeFS.Stats, b: NodeFS.Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
const sameFile = (a: NodeFS.Stats, b: NodeFS.Stats) =>
  sameDirectory(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const openDir = (path: string) =>
  NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
  );

/** Walk from the filesystem root and keep every parent held until the caller finishes. */
export async function withHeldConfigFile<T>(
  path: string,
  use: (data: Buffer, stat: NodeFS.Stats, fd: number) => Promise<T>,
): Promise<T> {
  if (
    HostProcess.Platform.defaultValue() !== "linux" ||
    !NodePath.isAbsolute(path) ||
    path !== NodePath.normalize(path) ||
    path === "/"
  )
    throw new HeldConfigError();
  const names = path.split("/").filter(Boolean);
  const held: NodeFSP.FileHandle[] = [];
  try {
    let parent = await openDir("/");
    held.push(parent);
    const stats = [await parent.stat()];
    for (const part of names.slice(0, -1)) {
      parent = await openDir(`/proc/self/fd/${parent.fd}/${part}`);
      held.push(parent);
      stats.push(await parent.stat());
    }
    const file = await NodeFSP.open(
      `/proc/self/fd/${parent.fd}/${names.at(-1)!}`,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    held.push(file);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new HeldConfigError();
    const data = await file.readFile();
    if (data.length !== stat.size || !sameFile(stat, await file.stat()))
      throw new HeldConfigError();
    const result = await use(data, stat, file.fd);
    const again: NodeFSP.FileHandle[] = [];
    try {
      let cursor = await openDir("/");
      again.push(cursor);
      if (!sameDirectory(stats[0]!, await cursor.stat())) throw new HeldConfigError();
      for (const [i, part] of names.slice(0, -1).entries()) {
        cursor = await openDir(`/proc/self/fd/${cursor.fd}/${part}`);
        again.push(cursor);
        if (!sameDirectory(stats[i + 1]!, await cursor.stat())) throw new HeldConfigError();
      }
      const reopened = await NodeFSP.open(
        `/proc/self/fd/${cursor.fd}/${names.at(-1)!}`,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
      );
      again.push(reopened);
      if (!sameFile(stat, await reopened.stat()) || !sameFile(stat, await file.stat()))
        throw new HeldConfigError();
    } finally {
      for (const handle of again.toReversed()) await handle.close();
    }
    return result;
  } catch {
    throw new HeldConfigError();
  } finally {
    for (const handle of held.toReversed()) await handle.close();
  }
}
