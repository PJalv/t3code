export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Reads Git's NUL-delimited numstat output without decoding display paths. */
export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];

  const parsedPatches = parsePatchFiles(normalized);
  const filesByPath = new Map<string, TurnDiffFileSummary>();
  for (const patch of parsedPatches) {
    for (const file of patch.files) {
      const existing = filesByPath.get(file.name);
      const additions = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
      const deletions = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
      filesByPath.set(file.name, {
        path: file.name,
        additions: (existing?.additions ?? 0) + additions,
        deletions: (existing?.deletions ?? 0) + deletions,
      });
    }
  }

  return [...filesByPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}
