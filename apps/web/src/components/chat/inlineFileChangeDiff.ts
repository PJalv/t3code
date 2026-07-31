interface DiffFilePath {
  readonly name?: string | null | undefined;
  readonly prevName?: string | null | undefined;
}

function normalizePath(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function stripDiffPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function workspaceRelativePath(path: string, workspaceRoot: string | undefined): string {
  const normalizedPath = normalizePath(path);
  if (!workspaceRoot) {
    return normalizedPath;
  }

  const normalizedRoot = normalizePath(workspaceRoot);
  const pathForCompare = normalizedPath.toLowerCase();
  const rootForCompare = normalizedRoot.toLowerCase();
  if (pathForCompare.startsWith(`${rootForCompare}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

function comparablePaths(path: string, workspaceRoot: string | undefined): ReadonlySet<string> {
  const normalizedPath = stripDiffPrefix(workspaceRelativePath(path, workspaceRoot));
  const paths = new Set([normalizedPath.toLowerCase()]);
  const normalizedRoot = workspaceRoot ? normalizePath(workspaceRoot) : "";
  const workspaceLabel = normalizedRoot.split("/").at(-1);
  if (
    workspaceLabel &&
    normalizedPath.toLowerCase().startsWith(`${workspaceLabel.toLowerCase()}/`)
  ) {
    paths.add(normalizedPath.slice(workspaceLabel.length + 1).toLowerCase());
  }
  return paths;
}

function pathsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const path of left) {
    if (right.has(path)) {
      return true;
    }
  }
  return false;
}

export function selectInlineFileChangeDiffs<T extends DiffFilePath>(
  files: ReadonlyArray<T>,
  changedFiles: ReadonlyArray<string>,
  workspaceRoot: string | undefined,
): ReadonlyArray<T> {
  if (changedFiles.length === 0) {
    return files;
  }

  const changedPathSets = changedFiles.map((path) => comparablePaths(path, workspaceRoot));
  const matchingFiles = files.filter((file) => {
    const filePath = file.name ?? file.prevName;
    if (!filePath) {
      return false;
    }
    const diffPaths = comparablePaths(filePath, workspaceRoot);
    return changedPathSets.some((changedPaths) => pathsOverlap(diffPaths, changedPaths));
  });

  return matchingFiles.length > 0 ? matchingFiles : files;
}
