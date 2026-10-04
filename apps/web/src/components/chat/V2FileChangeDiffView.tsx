import type { CodeViewDiffItem } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { V2FileChangeDiffInput } from "./v2FileChangeDiff";
import { v2FileChangePatch } from "./v2FileChangeDiff";
import { getRenderablePatch } from "../../lib/diffRendering";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";

export function V2FileChangeDiffView({
  item,
  cacheKey,
}: {
  readonly item: V2FileChangeDiffInput & { readonly id: string };
  readonly cacheKey: string;
}) {
  const { diffStr, fileName, newStr, oldStr } = item;
  const patch = useMemo(
    () => v2FileChangePatch({ diffStr, fileName, newStr, oldStr }),
    [diffStr, fileName, newStr, oldStr],
  );
  const items = useMemo(() => {
    if (!patch) return [];
    const parsed = getRenderablePatch(patch, cacheKey);
    return parsed?.kind === "files"
      ? (parsed.files.map((file, index) => ({
          id: `${cacheKey}:${index}`,
          type: "diff" as const,
          fileDiff: file,
        })) satisfies CodeViewDiffItem[])
      : [];
  }, [cacheKey, patch]);
  if (!patch) return null;
  if (!items.length)
    return (
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-2xs">{patch}</pre>
    );
  return (
    <StyledDiffCodeView
      className="max-h-96 overflow-auto rounded border border-border/50"
      items={items}
      options={{ diffStyle: "unified" }}
    />
  );
}
