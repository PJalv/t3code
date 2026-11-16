import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GerritChangeId,
  type GerritChangeKey,
  type GerritCommitMapping,
  type GerritRepositoryScope,
  type GerritVisibleChanges,
  type GitCommitOid,
} from "@t3tools/contracts";

const decodeChangeId = Schema.decodeUnknownOption(GerritChangeId);

type InvalidIdentity = Extract<GerritCommitMapping, { kind: "invalid" }>;
type CommitIdentity =
  | { readonly kind: "valid"; readonly changeId: typeof GerritChangeId.Type }
  | InvalidIdentity;

export interface LocalCommit {
  readonly oid: GitCommitOid;
  readonly parents: ReadonlyArray<GitCommitOid>;
  readonly message: string;
}

export function commitIdentity(message: string): CommitIdentity {
  const paragraphs = message.replace(/(?:[ \t]*\r?\n)+$/, "").split(/\r?\n[ \t]*\r?\n/);
  const footer = paragraphs.length > 1 ? (paragraphs.at(-1) ?? "") : "";
  const lines = footer.split(/\r?\n(?![ \t])/);
  const identityLines = lines.filter((line) => /^change-id\b/i.test(line.trimStart()));
  const problems: InvalidIdentity["problems"][number][] = [];
  if (
    lines.some((line) => {
      const link = /^Link:[ \t]*(\S+)[ \t]*(?:\r?\n|$)/i.exec(line)?.[1];
      const url = link ? URL.parse(link) : null;
      return url !== null && /\/id\/I[^/]*$/.test(url.pathname);
    })
  ) {
    problems.push("unsupported-link-trailer");
  }
  if (identityLines.length === 0 && problems.length === 0) problems.push("missing-change-id");
  if (identityLines.length > 1) problems.push("duplicate-change-id");
  const ids = identityLines.map((line) => {
    const value = /^Change-Id:[ \t]*(.*?)[ \t]*$/i.exec(line)?.[1];
    return decodeChangeId(value);
  });
  if (ids.some(Option.isNone)) problems.push("malformed-change-id");
  const firstProblem = problems[0];
  if (firstProblem !== undefined) {
    return { kind: "invalid", problems: [firstProblem, ...problems.slice(1)] };
  }
  const id = ids[0];
  return id !== undefined && Option.isSome(id)
    ? { kind: "valid", changeId: id.value }
    : { kind: "invalid", problems: ["missing-change-id"] };
}

function sameChange(left: GerritChangeKey, right: GerritChangeKey): boolean {
  return (
    left.installation === right.installation &&
    left.project === right.project &&
    left.branch === right.branch &&
    left.changeId === right.changeId
  );
}

export function mapLocalCommits(input: {
  readonly commits: ReadonlyArray<LocalCommit>;
  readonly scope: GerritRepositoryScope;
  readonly visible: GerritVisibleChanges;
}) {
  const identified = input.commits.map((commit) => ({
    commit,
    identity: commitIdentity(commit.message),
  }));
  const counts = new Map<typeof GerritChangeId.Type, number>();
  for (const { identity } of identified) {
    if (identity.kind === "valid") {
      counts.set(identity.changeId, (counts.get(identity.changeId) ?? 0) + 1);
    }
  }
  return identified.map(({ commit, identity }) => {
    let mapping: GerritCommitMapping;
    if (identity.kind === "invalid") {
      mapping = identity;
    } else if ((counts.get(identity.changeId) ?? 0) > 1) {
      mapping = { kind: "invalid", problems: ["duplicate-local-change-id"] };
    } else {
      const key: GerritChangeKey = { ...input.scope, changeId: identity.changeId };
      const candidates = input.visible.changes.filter((change) => sameChange(change.key, key));
      const onlyMatch = candidates[0];
      if (input.visible.completeness === "partial") {
        mapping = { kind: "ambiguous", key, candidates, reason: "partial-visible-results" };
      } else if (candidates.length > 1) {
        mapping = { kind: "ambiguous", key, candidates, reason: "multiple-visible-matches" };
      } else if (onlyMatch !== undefined) {
        mapping = { kind: "mapped", change: onlyMatch };
      } else {
        mapping = { kind: "new-candidate", key };
      }
    }
    return { ...commit, mapping };
  });
}
