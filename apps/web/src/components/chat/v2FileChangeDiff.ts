export interface V2FileChangeDiffInput {
  readonly fileName: string;
  readonly diffStr?: string | undefined;
  readonly oldStr?: string | undefined;
  readonly newStr?: string | undefined;
}

function snapshotLines(text: string): { lines: string[]; hasTrailingNewline: boolean } {
  const hasTrailingNewline = text.endsWith("\n");
  const content = hasTrailingNewline ? text.slice(0, -1) : text;
  return { lines: text === "" ? [] : content.split("\n"), hasTrailingNewline };
}

/** Prefer the provider patch; otherwise encode both persisted snapshots losslessly. */
export function v2FileChangePatch(input: V2FileChangeDiffInput): string | null {
  if (input.diffStr?.trim()) return input.diffStr;
  if (input.newStr === undefined) return null;
  const path = input.fileName.replaceAll("\\", "/").replace(/^\/+/, "");
  const oldExists = input.oldStr !== undefined;
  const old = snapshotLines(input.oldStr ?? "");
  const next = snapshotLines(input.newStr ?? "");
  const range = (start: number, count: number) => `${count ? start : 0},${count}`;
  const body = [
    `@@ -${range(1, oldExists ? old.lines.length : 0)} +${range(1, next.lines.length)} @@`,
    ...(oldExists
      ? old.lines.flatMap((line, index) => [
          `-${line}`,
          ...(index === old.lines.length - 1 && !old.hasTrailingNewline
            ? ["\\ No newline at end of file"]
            : []),
        ])
      : []),
    ...next.lines.flatMap((line, index) => [
      `+${line}`,
      ...(index === next.lines.length - 1 && !next.hasTrailingNewline
        ? ["\\ No newline at end of file"]
        : []),
    ]),
  ];
  const header = oldExists ? `--- a/${path}\n+++ b/${path}` : `--- /dev/null\n+++ b/${path}`;
  return `${header}\n${body.join("\n")}`;
}
