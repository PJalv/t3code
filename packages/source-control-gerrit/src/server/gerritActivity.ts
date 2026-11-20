import { GERRIT_CHANGE_LEVEL_PATH } from "@t3tools/contracts";
import type {
  GerritComment,
  GerritReviewDetail,
  PullRequestActor,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import type { ProviderChangeRequestActivity } from "@t3tools/source-control-core/server/PullRequestProvider";

import { gerritAccountActor } from "./gerritAccount.ts";

type ActivityInput = Pick<GerritReviewDetail, "messages" | "comments" | "portedComments"> &
  Partial<Pick<GerritReviewDetail, "messageAccounts">> & {
    /** Only pass drafts belonging to the viewer. They are never exposed as published comments. */
    readonly drafts?: ReadonlyArray<GerritComment>;
    readonly patchSets?: ReadonlyArray<{
      readonly number: number;
      readonly commit: string;
      readonly created?: string | undefined;
      readonly fallbackDate?: string | undefined;
      readonly uploader?: GerritComment["author"] | undefined;
    }>;
  };

export interface GerritActivityThread {
  readonly id: string;
  readonly rootCommentId: string;
  readonly comments: ReadonlyArray<GerritComment>;
  readonly resolution: "resolved" | "unresolved" | "unknown";
}

export interface GerritActivity extends ProviderChangeRequestActivity {
  /** Native comments retained for Gerrit operations. */
  readonly gerritThreads: ReadonlyArray<GerritActivityThread>;
}

/** Gerrit change messages name accounts as `<GERRIT_ACCOUNT_n>` placeholders. */
export function messageWithAccounts(
  message: string,
  accounts: GerritReviewDetail["messageAccounts"],
): string {
  return message.replace(/<GERRIT_ACCOUNT_(\d+)>/g, (_placeholder, id: string) => {
    const account = accounts?.[id];
    return account?.name || account?.display_name || account?.username || `account ${id}`;
  });
}

function actor(account: GerritComment["author"] | undefined): PullRequestActor | null {
  const mapped = account ? gerritAccountActor(account) : null;
  return mapped ? { ...mapped, isBot: account?.tags?.includes("SERVICE_USER") ?? false } : null;
}

function gerritAnchor(comment: GerritComment) {
  return {
    patchSet: comment.patchSet,
    revision: comment.revision,
    ...(comment.anchor.parent !== undefined ? { parent: comment.anchor.parent } : {}),
    ...(comment.anchor.range !== undefined ? { range: comment.anchor.range } : {}),
  };
}

function date(value: string): string {
  // Gerrit timestamps without a zone are UTC; retain sub-millisecond precision.
  const match = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)?$/.exec(value);
  return match ? `${match[1]}T${match[2]}${match[3] ?? ""}${match[4] ?? "Z"}` : value;
}

function orderDate(value: string): string {
  return date(value).replace(
    /(T\d\d:\d\d:\d)(?:\.(\d+))?(Z)$/,
    (_, time: string, fraction: string | undefined, zone: string) =>
      `${time}.${(fraction ?? "").padEnd(9, "0")}${zone}`,
  );
}

/**
 * Thread IDs are `gerrit:` plus the URI-encoded root comment ID. A reply must re-read the
 * thread and select its latest published comment; the root is not necessarily the reply target.
 */
export function mapGerritActivity(input: ActivityInput): GerritActivity {
  const byId = new Map<string, GerritComment>();
  for (const comment of input.comments) {
    if (comment.visibility === "published" && !byId.has(comment.id)) byId.set(comment.id, comment);
  }
  // Ported rows are alternate locations, not new comments. Use the original only when missing.
  for (const ported of input.portedComments) {
    const original = ported.original;
    if (original?.visibility === "published" && !byId.has(original.id))
      byId.set(original.id, original);
  }
  for (const draft of input.drafts ?? []) {
    if (draft.visibility === "server-draft" && !byId.has(draft.id)) byId.set(draft.id, draft);
  }
  const rootFor = (comment: GerritComment): string => {
    const visited = new Set<string>();
    let current = comment;
    while (true) {
      if (visited.has(current.id)) return [...visited].sort()[0] ?? current.id;
      visited.add(current.id);
      if (current.inReplyTo === null) return current.id;
      const parent = byId.get(current.inReplyTo);
      if (!parent) return current.inReplyTo;
      current = parent;
    }
  };
  const groups = new Map<string, GerritComment[]>();
  for (const comment of byId.values()) {
    const root = rootFor(comment);
    const group = groups.get(root) ?? [];
    group.push(comment);
    groups.set(root, group);
  }
  const gerritThreads: GerritActivityThread[] = [...groups]
    .map(([rootCommentId, comments]) => {
      comments.sort(
        (a, b) =>
          orderDate(a.updated).localeCompare(orderDate(b.updated)) || a.id.localeCompare(b.id),
      );
      const published = comments.filter((comment) => comment.visibility === "published");
      const last = published.at(-1);
      const previous = published.at(-2);
      const ambiguous = last && previous && orderDate(last.updated) === orderDate(previous.updated);
      const resolution: GerritActivityThread["resolution"] =
        !last || ambiguous || last.unresolved === null
          ? "unknown"
          : last.unresolved
            ? "unresolved"
            : "resolved";
      return {
        id: `gerrit:${encodeURIComponent(rootCommentId)}`,
        rootCommentId,
        comments,
        resolution,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const reviewThreads: PullRequestReviewThread[] = [];
  for (const thread of gerritThreads) {
    const root =
      thread.comments.find((comment) => comment.id === thread.rootCommentId) ?? thread.comments[0];
    if (!root) continue;
    reviewThreads.push({
      id: thread.id,
      path: root.anchor.path ?? GERRIT_CHANGE_LEVEL_PATH,
      gerrit: gerritAnchor(root),
      ...(thread.comments.every((comment) => comment.visibility === "server-draft")
        ? { isDraft: true }
        : {}),
      line: root.anchor.line && root.anchor.line > 0 ? root.anchor.line : null,
      side: root.anchor.side === "PARENT" ? "left" : "right",
      isResolved: thread.resolution === "resolved",
      isOutdated: false,
      ...(thread.resolution === "unknown" ? { canResolve: false } : {}),
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        gerrit: gerritAnchor(comment),
        ...(comment.visibility === "server-draft" ? { isDraft: true } : {}),
        author: actor(comment.author),
        body: comment.message ?? "",
        createdAt: date(comment.updated),
        url: null,
      })),
    });
  }
  const linkedComments = new Map<string, GerritComment[]>();
  for (const comment of byId.values()) {
    if (comment.visibility !== "published" || !comment.changeMessageId) continue;
    const linked = linkedComments.get(comment.changeMessageId) ?? [];
    linked.push(comment);
    linkedComments.set(comment.changeMessageId, linked);
  }
  const messages = input.messages.flatMap((message) => {
    let body = messageWithAccounts(message.message, input.messageAccounts);
    // PostReviewOp puts its receipt before user prose; later count paragraphs belong to the user.
    const summary = /^(Patch Set \d+:[^\n]*)\n\n\(([1-9]\d*) comments?\)(?=\n\n|$)/.exec(body);
    const linked = linkedComments.get(message.id) ?? [];
    // Gerrit can link older comments to a later message, so the ID alone is not publish evidence.
    if (
      summary &&
      linked.length === Number(summary[2]) &&
      message.author?._account_id !== undefined &&
      linked.every(
        (comment) =>
          comment.author?._account_id === message.author?._account_id &&
          date(comment.updated) === date(message.date) &&
          comment.message !== null &&
          (!comment.identity || comment.identity.kind === "known"),
      )
    ) {
      body = summary[1] + body.slice(summary[0].length);
      if (/^Patch Set \d+:\s*$/.test(body)) return [];
    }
    const vote = /^Patch Set \d+:[^\n]*\bCode-Review([+-][12])(?=\s|$)/.exec(body)?.[1];
    const reset =
      /^Patch Set \d+:[^\n]*(?:^|\s)(?:-Code-Review|Code-Review(?:\+0|\s*0))(?=\s|$)/.test(body);
    return [
      {
        id: message.id,
        kind: vote || reset ? ("review" as const) : ("issue-comment" as const),
        ...(vote ? { vote: { label: "Code-Review", value: Number(vote) } } : {}),
        author: actor(message.author),
        body,
        createdAt: date(message.date),
        url: null,
        path: null,
        // Only the extreme Code-Review values approve or block in Gerrit; ±1 is advisory.
        reviewState:
          vote === "+2"
            ? "APPROVED"
            : vote === "-2"
              ? "CHANGES_REQUESTED"
              : vote || reset
                ? "COMMENTED"
                : null,
      },
    ];
  });
  const sorted = messages.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  // A later Code-Review vote replaces the author's earlier one, so only their latest verdict stands.
  const latestVote = new Map<string, string>();
  for (const message of sorted) {
    if (message.kind === "review" && message.author)
      latestVote.set(message.author.login, message.id);
  }
  const comments = sorted.map((message) =>
    message.kind === "review" &&
    message.author &&
    latestVote.get(message.author.login) !== message.id &&
    message.reviewState !== "COMMENTED"
      ? { ...message, reviewState: "DISMISSED" }
      : message,
  );
  return {
    comments,
    commentCount: comments.length,
    commentsTruncated: false,
    reviewThreadsTruncated: false,
    reviewThreads,
    commits: [...(input.patchSets ?? [])]
      .sort((a, b) => a.number - b.number)
      .map((patchSet) => {
        const upload = input.messages.find((message) =>
          new RegExp(`^Uploaded patch set ${patchSet.number}(?:\\D|$)`, "i").test(message.message),
        );
        const uploader = actor(patchSet.uploader ?? upload?.author);
        return {
          oid: patchSet.commit,
          messageHeadline: `Patch set ${patchSet.number}`,
          committedDate: date(
            patchSet.created ?? upload?.date ?? patchSet.fallbackDate ?? "1970-01-01T00:00:00Z",
          ),
          authors: uploader ? [uploader] : [],
        };
      }),
    gerritThreads,
  };
}
