import type { GerritDiffResult, GerritFile } from "@t3tools/contracts";

type DiffFile = Pick<typeof GerritFile.Type, "path" | "status"> & {
  readonly oldPath?: string | null;
  readonly binary?: boolean;
  readonly diff?: GerritDiffResult;
};

type DiffOptions = {
  /** Paths whose last line is known to lack a newline on each side. Gerrit's decoded diff does not expose this information. */
  readonly noNewline?: Readonly<Record<string, { readonly old?: boolean; readonly new?: boolean }>>;
};

const quote = (path: string) => JSON.stringify(path);

/** Render the available Gerrit file diffs. Missing content is reported through `truncated`. */
export function renderGerritUnifiedDiff(
  files: ReadonlyArray<DiffFile>,
  options?: DiffOptions,
): {
  patch: string;
  truncated: boolean;
} {
  const output: string[] = [];
  let truncated = false;
  for (const file of files) {
    // Gerrit synthesizes this entry; it is not a file in either Git tree.
    if (file.path === "/COMMIT_MSG") continue;
    const added = file.status === "A";
    const deleted = file.status === "D";
    const moved = file.status === "R" || file.status === "C";
    const diff = file.diff;
    const oldPath = file.oldPath ?? (diff?.kind === "text" ? diff.oldPath : null) ?? file.path;
    const newPath = file.path;
    if (moved && oldPath === newPath) truncated = true;
    output.push(`diff --git ${quote(`a/${oldPath}`)} ${quote(`b/${newPath}`)}`);
    const submodule = diff?.kind === "submodule";
    const mode = submodule ? "160000" : "100644";
    if (added) output.push(`new file mode ${mode}`);
    if (deleted) output.push(`deleted file mode ${mode}`);
    if (moved && oldPath !== newPath) {
      const operation = file.status === "R" ? "rename" : "copy";
      output.push(`${operation} from ${quote(oldPath)}`, `${operation} to ${quote(newPath)}`);
    }
    if (file.binary || diff?.kind === "binary") {
      output.push(
        `Binary files ${added ? "/dev/null" : quote(`a/${oldPath}`)} and ${deleted ? "/dev/null" : quote(`b/${newPath}`)} differ`,
      );
      continue;
    }
    if (!diff || diff.kind !== "text") {
      // readDiff discards gitlink object IDs, so even a submodule patch is incomplete.
      truncated = true;
      continue;
    }
    output.push(
      `--- ${added ? "/dev/null" : quote(`a/${oldPath}`)}`,
      `+++ ${deleted ? "/dev/null" : quote(`b/${newPath}`)}`,
    );
    let oldLine = 0;
    let newLine = 0;
    let oldCount = 0;
    let newCount = 0;
    let body: string[] = [];
    const flush = () => {
      if (body.length === 0) return;
      output.push(
        `@@ -${oldLine + (oldCount === 0 ? 0 : 1)},${oldCount} +${newLine + (newCount === 0 ? 0 : 1)},${newCount} @@`,
        ...body,
      );
      oldLine += oldCount;
      newLine += newCount;
      oldCount = 0;
      newCount = 0;
      body = [];
    };
    const lastOld = diff.content.findLastIndex(
      (chunk) => (chunk.a?.length ?? 0) + (chunk.ab?.length ?? 0) > 0,
    );
    const lastNew = diff.content.findLastIndex(
      (chunk) => (chunk.b?.length ?? 0) + (chunk.ab?.length ?? 0) > 0,
    );
    const noNewline = options?.noNewline?.[file.path];
    const oldKnown = lastOld >= 0 && !diff.content.slice(lastOld).some((chunk) => chunk.skip);
    const newKnown = lastNew >= 0 && !diff.content.slice(lastNew).some((chunk) => chunk.skip);
    for (const [index, chunk] of diff.content.entries()) {
      for (const [i, line] of (chunk.ab ?? []).entries()) {
        const lastShared = i === chunk.ab!.length - 1;
        const oldMissing =
          lastShared &&
          index === lastOld &&
          !chunk.a?.length &&
          oldKnown &&
          noNewline?.old === true;
        const newMissing =
          lastShared &&
          index === lastNew &&
          !chunk.b?.length &&
          newKnown &&
          noNewline?.new === true;
        oldCount++;
        newCount++;
        if (oldMissing !== newMissing) {
          body.push(`-${line}`);
          if (oldMissing) body.push("\\ No newline at end of file");
          body.push(`+${line}`);
          if (newMissing) body.push("\\ No newline at end of file");
        } else {
          body.push(` ${line}`);
          if (oldMissing) body.push("\\ No newline at end of file");
        }
      }
      for (const [i, line] of (chunk.a ?? []).entries()) {
        body.push(`-${line}`);
        oldCount++;
        if (i === chunk.a!.length - 1 && index === lastOld && oldKnown && noNewline?.old)
          body.push("\\ No newline at end of file");
      }
      for (const [i, line] of (chunk.b ?? []).entries()) {
        body.push(`+${line}`);
        newCount++;
        if (i === chunk.b!.length - 1 && index === lastNew && newKnown && noNewline?.new)
          body.push("\\ No newline at end of file");
      }
      if (chunk.skip) {
        flush();
        oldLine += chunk.skip;
        newLine += chunk.skip;
        truncated = true;
      }
    }
    if ((noNewline?.old && !oldKnown) || (noNewline?.new && !newKnown)) truncated = true;
    flush();
  }
  return { patch: output.length ? `${output.join("\n")}\n` : "", truncated };
}
