import {
  GERRIT_CHANGE_LEVEL_PATH,
  type PullRequestGerritComparison,
  type PullRequestGerritDetail,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/menu";

export function isGerritFilePath(path: string): boolean {
  return path !== GERRIT_CHANGE_LEVEL_PATH;
}

export function buildGerritComparison(
  detail: PullRequestGerritDetail,
  selection: PullRequestGerritComparison | undefined,
): PullRequestGerritComparison {
  const patchSet =
    selection && detail.patchSets.some((entry) => entry.number === selection.patchSet)
      ? selection.patchSet
      : detail.currentPatchSet;
  const base = selection?.base ?? "base";
  if (
    typeof base !== "string" &&
    "patchSet" in base &&
    (base.patchSet >= patchSet || !detail.patchSets.some((entry) => entry.number === base.patchSet))
  ) {
    return { patchSet, base: "base" };
  }
  return { patchSet, base };
}

export function PullRequestGerritPatchSets({
  detail,
  comparison,
  onChange,
}: {
  readonly detail: PullRequestGerritDetail;
  readonly comparison: PullRequestGerritComparison;
  readonly onChange: (comparison: PullRequestGerritComparison) => void;
}) {
  const base = comparison.base;
  const baseValue =
    typeof base === "string"
      ? base
      : "parent" in base
        ? `parent:${base.parent}`
        : `patchSet:${base.patchSet}`;
  const baseLabel =
    baseValue === "base"
      ? "Base"
      : baseValue.startsWith("parent:")
        ? `Parent ${baseValue.slice(7)}`
        : `Patch set ${baseValue.slice(9)}`;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="xs" variant="secondary" />}
          aria-label="Select patch set"
        >
          PS {comparison.patchSet}
          {comparison.patchSet === detail.currentPatchSet ? " (current)" : ""}{" "}
          <ChevronDownIcon className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={String(comparison.patchSet)}
            onValueChange={(value) =>
              onChange(buildGerritComparison(detail, { ...comparison, patchSet: Number(value) }))
            }
          >
            {detail.patchSets
              .toSorted((a, b) => b.number - a.number)
              .map((entry) => (
                <DropdownMenuRadioItem key={entry.number} value={String(entry.number)} closeOnClick>
                  Patch set {entry.number}{" "}
                  {entry.number === detail.currentPatchSet ? "(current)" : ""} ·{" "}
                  {entry.commit.slice(0, 7)}
                </DropdownMenuRadioItem>
              ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="xs" variant="secondary" />}
          aria-label="Select comparison base"
        >
          {baseLabel} <ChevronDownIcon className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={baseValue}
            onValueChange={(value) =>
              onChange({
                ...comparison,
                base:
                  value === "base"
                    ? "base"
                    : value.startsWith("parent:")
                      ? { parent: Number(value.slice(7)) }
                      : { patchSet: Number(value.slice(9)) },
              })
            }
          >
            <DropdownMenuRadioItem value="base" closeOnClick>
              Base
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="parent:1" closeOnClick>
              Parent 1
            </DropdownMenuRadioItem>
            {typeof base !== "string" && "parent" in base && base.parent !== 1 ? (
              <DropdownMenuRadioItem value={baseValue} closeOnClick>
                Parent {base.parent}
              </DropdownMenuRadioItem>
            ) : null}
            {detail.patchSets
              .filter((entry) => entry.number < comparison.patchSet)
              .toSorted((a, b) => b.number - a.number)
              .map((entry) => (
                <DropdownMenuRadioItem
                  key={entry.number}
                  value={`patchSet:${entry.number}`}
                  closeOnClick
                >
                  Patch set {entry.number}
                </DropdownMenuRadioItem>
              ))}
          </DropdownMenuRadioGroup>
          <label className="flex items-center gap-2 px-2 py-1 text-xs">
            Parent number{" "}
            <input
              aria-label="Parent number"
              className="w-14 rounded border border-border bg-background px-1"
              type="number"
              min={1}
              value={typeof base !== "string" && "parent" in base ? base.parent : 1}
              onChange={(event) => {
                const parent = Number(event.target.value);
                if (Number.isInteger(parent) && parent > 0)
                  onChange({ ...comparison, base: { parent } });
              }}
            />
          </label>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
