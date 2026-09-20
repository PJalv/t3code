export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Reads Git's NUL-delimited numstat output without decoding display paths. */
export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;

    let path = record.slice(counts[0].length);
    if (path.length === 0) {
      // Renames and copies use two more records: the source and destination.
      path = records[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;

    files.push({
      path,
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const filesByPath = new Map<string, { path: string; additions: number; deletions: number }>();
  let path: string | undefined;
  for (const line of normalized.split("\n")) {
    if (line.startsWith("+++ ")) {
      const candidate = line.slice(4).split("\t", 1)[0]!;
      path = candidate === "/dev/null" ? undefined : candidate;
      if (path?.startsWith("b/")) path = path.slice(2);
      continue;
    }
    // Count only hunk body lines; headers and file metadata are not changes.
    if (
      path === undefined ||
      line.startsWith("@@") ||
      line.startsWith("--- ") ||
      line.startsWith("diff ") ||
      line.startsWith("Index:") ||
      line.startsWith("===") ||
      line.startsWith("\\\\")
    )
      continue;
    const existing = filesByPath.get(path) ?? { path, additions: 0, deletions: 0 };
    if (line.startsWith("+")) existing.additions += 1;
    else if (line.startsWith("-")) existing.deletions += 1;
    else continue;
    filesByPath.set(path, existing);
  }
  return [...filesByPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}
