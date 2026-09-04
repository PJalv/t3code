import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";

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
