import type {
  PullRequestComment,
  PullRequestDetail,
  PullRequestReviewThread,
} from "@t3tools/contracts";

export function gerritCommitMessageParts(message: string): {
  readonly body: string;
  readonly footers: ReadonlyArray<{ readonly key: string; readonly value: string }>;
} {
  const paragraphs = message
    .replaceAll("\r\n", "\n")
    .trim()
    .split(/\n{2,}/);
  const trailer = /^([A-Za-z][A-Za-z0-9-]*):\s+(.+)$/;
  const last = paragraphs.length > 1 ? paragraphs.at(-1) : undefined;
  const lines = last?.split("\n") ?? [];
  const footers =
    lines.length > 0 && lines.every((line) => trailer.test(line))
      ? lines.map((line) => {
          const [, key = "", value = ""] = trailer.exec(line) ?? [];
          return { key, value };
        })
      : [];
  const rest = footers.length > 0 ? paragraphs.slice(0, -1) : paragraphs;
  return {
    body: rest.slice(1).join("\n\n"),
    footers: footers.filter((footer) => footer.key.toLowerCase() !== "change-id"),
  };
}

type EditingSubject = Pick<
  PullRequestDetail,
  "author" | "capabilities" | "viewer" | "viewerPermissions"
>;

function sameLogin(one: string | null | undefined, other: string | null | undefined): boolean {
  if (one == null || other == null) return false;
  return one.trim().toLowerCase() === other.trim().toLowerCase();
}

export function canEditPullRequestChangeRequest(detail: EditingSubject): boolean {
  if (detail.capabilities.edit?.changeRequest !== true) return false;
  if (detail.viewerPermissions.editChangeRequest !== undefined) {
    return detail.viewerPermissions.editChangeRequest;
  }
  return (
    sameLogin(detail.viewer, detail.author?.login) ||
    detail.viewerPermissions.actions.includes("merge")
  );
}

export function canEditPullRequestMaintainerEdits(
  detail: Pick<
    PullRequestDetail,
    "state" | "capabilities" | "viewerPermissions" | "maintainerCanModify"
  >,
): boolean {
  return (
    detail.state === "open" &&
    detail.capabilities.edit?.maintainerEdits === true &&
    detail.viewerPermissions.maintainerEdits === true &&
    detail.maintainerCanModify !== undefined
  );
}

export interface MaintainerEditsChoice {
  readonly key: string;
  readonly observedAt: number | undefined;
  readonly value: boolean;
}

/**
 * A saved choice ends at the first host reading delivered after the save. Readers refresh once it
 * succeeds, which drops reads still in flight, so that reading started after the write.
 */
export function maintainerEditsChoiceInForce<
  Choice extends { readonly key: string; readonly observedAt: number | undefined },
>(
  choice: Choice | null,
  key: string,
  observedAt: number | undefined,
  saving: boolean,
): Choice | null {
  if (choice === null || choice.key !== key) return null;
  if (saving) return choice.observedAt === observedAt ? choice : { ...choice, observedAt };
  return observedAt !== undefined && choice.observedAt === observedAt ? choice : null;
}

/** A description written from this client, shown in place of the host's copy. */
export interface DescriptionDraft {
  readonly key: string;
  readonly observedAt: number | undefined;
  /** Null once the last save failed: until a host reading, nobody knows which saves landed. */
  readonly body: string | null;
  /** Saves still running. The host applies them in order, so the last one is `body`. */
  readonly saves: number;
}

/** Same lifetime as a maintainer edits choice: until the first host reading after the saves. */
export function descriptionDraftInForce(
  draft: DescriptionDraft | null,
  key: string,
  observedAt: number | undefined,
): DescriptionDraft | null {
  return maintainerEditsChoiceInForce(draft, key, observedAt, (draft?.saves ?? 0) > 0);
}

export function startDescriptionSave(
  draft: DescriptionDraft | null,
  detail: { readonly url: string; readonly observedAt?: number | undefined },
  body: string,
): DescriptionDraft {
  const saves = draft?.key === detail.url ? draft.saves : 0;
  return { key: detail.url, observedAt: detail.observedAt, body, saves: saves + 1 };
}

/** Each save writes the whole body, so a failure only loses `body` when no later save is running. */
export function settleDescriptionSave(
  draft: DescriptionDraft | null,
  key: string,
  saved: boolean,
): DescriptionDraft | null {
  if (draft === null || draft.key !== key || draft.saves === 0) return draft;
  const saves = draft.saves - 1;
  return { ...draft, saves, body: saved || saves > 0 ? draft.body : null };
}

/** Hosts do not support rewriting review summaries through comment mutations. */
export function canEditPullRequestComment(
  detail: EditingSubject,
  comment: Pick<PullRequestComment, "author" | "canEdit" | "kind">,
): boolean {
  if (detail.capabilities.edit?.comment !== true) return false;
  if (comment.kind !== "issue-comment" && comment.kind !== "review-comment") return false;
  if (comment.canEdit !== undefined) return comment.canEdit;
  return sameLogin(detail.viewer, comment.author?.login);
}

export function canResolvePullRequestThread(
  detail: Pick<PullRequestDetail, "viewerPermissions">,
  thread: Pick<PullRequestReviewThread, "canResolve">,
): boolean {
  return detail.viewerPermissions.resolve && thread.canResolve !== false;
}

/** Whether a reply may also resolve its conversation, both to offer the option and to send it. */
export function canResolveWithReply(
  detail: Pick<PullRequestDetail, "capabilities"> | undefined,
  thread: { readonly isResolved: boolean; readonly canResolve?: boolean } | undefined,
  allowed: boolean,
): boolean {
  return (
    allowed &&
    thread !== undefined &&
    !thread.isResolved &&
    thread.canResolve !== false &&
    detail?.capabilities.review.resolveWithReply === true
  );
}
