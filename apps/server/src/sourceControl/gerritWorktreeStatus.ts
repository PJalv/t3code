export type WorktreeEntry = {
  readonly path: string;
  readonly status: string;
  readonly untracked: boolean;
  readonly unmerged: boolean;
};

const controlCharacters = /[\0\r\n]/;

function safeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 4096 || controlCharacters.test(path)) return false;
  if (path.startsWith("/") || path === ".git" || path.startsWith(".git/")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`. Rename records carry the original
 * path as an extra NUL token, which must be skipped rather than mistaken for a second entry.
 */
export function parseWorktreeStatus(output: string): ReadonlyArray<WorktreeEntry> | null {
  const tokens = output.split("\0");
  const entries: WorktreeEntry[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined || token === "") continue;
    if (token.length < 4) return null;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (!safeRelativePath(path)) return null;
    if (status.includes("R") || status.includes("C")) {
      if (index + 1 >= tokens.length) return null;
      index++;
    }
    entries.push({
      path,
      status,
      untracked: status === "??",
      unmerged: status.includes("U") || status === "AA" || status === "DD",
    });
  }
  return entries;
}
