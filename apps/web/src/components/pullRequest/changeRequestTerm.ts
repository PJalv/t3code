import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

/**
 * Selects the noun in translated sentences, so each language writes the whole sentence per host
 * term. `cr` reads "change", Gerrit's word, and carries Gerrit's verbs (submit, abandon, restore).
 */
export type ChangeRequestTermKind = "mr" | "cr" | "pr";

export function changeRequestTermKind(
  terminology: Pick<ChangeRequestTerminology, "singular">,
): ChangeRequestTermKind {
  if (terminology.singular === "merge request") return "mr";
  if (terminology.singular === "change request" || terminology.singular === "change") return "cr";
  return "pr";
}
