import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";

const COMMITS = 2000;

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Huge pull request",
  body: "",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: Array.from({ length: COMMITS }, (_, index) => ({
    oid: `${index.toString(16).padStart(7, "0")}${"0".repeat(33)}`,
    messageHeadline: `Commit number ${index}`,
    committedDate: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
  })),
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

it.each([false, true])(
  "labels a discussion and initially collapses it only when resolved=%s",
  async (resolved) => {
    const value: PullRequestDetailView = {
      ...detail,
      commits: [],
      reviewThreads: [
        {
          id: "status-thread",
          path: "/PATCHSET_LEVEL",
          line: null,
          side: "right",
          isResolved: resolved,
          isOutdated: false,
          comments: [
            {
              id: "status-root",
              author: detail.author,
              body: "Discussion status body",
              createdAt: "2026-10-01T00:00:00Z",
              url: null,
            },
          ],
        },
      ],
    };
    await using screen = await render(
      <div style={{ height: 600 }}>
        <PullRequestTimelineTab
          scrollerRef={() => {}}
          environmentId={EnvironmentId.make("environment")}
          reference={value}
          detail={value}
          order="oldest"
          onOpenCommit={() => {}}
          onRefresh={() => {}}
        />
      </div>,
    );
    await expect
      .element(screen.getByText(resolved ? "Resolved" : "Unresolved", { exact: true }))
      .toBeVisible();
    if (resolved) {
      await expect
        .element(screen.getByText("Discussion status body", { exact: true }))
        .not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /Resolved/ }));
    }
    await expect.element(screen.getByText("Discussion status body", { exact: true })).toBeVisible();
  },
);

it("shows Gerrit votes without expanding comment groups", async () => {
  const value: PullRequestDetailView = {
    ...detail,
    provider: SourceControlProviderKind.make("gerrit"),
    commits: [],
    comments: [1, -1, 2, -2].map((vote, index) => ({
      id: `vote-${index}`,
      kind: "review" as const,
      author: { login: `reviewer-${index}`, name: `Reviewer ${index}`, avatarUrl: null },
      body: `Vote ${index}`,
      createdAt: `2026-10-01T00:0${index}:00Z`,
      url: null,
      path: null,
      reviewState: index === 2 ? "DISMISSED" : index === 3 ? "CHANGES_REQUESTED" : "COMMENTED",
      vote: { label: "Code-Review", value: vote },
    })),
  };
  await using screen = await render(
    <div style={{ height: 1000 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        environmentId={EnvironmentId.make("environment")}
        reference={value}
        detail={value}
        order="oldest"
        onOpenCommit={() => {}}
        onRefresh={() => {}}
      />
    </div>,
  );
  for (const score of ["+1", "−1", "+2", "−2"]) {
    await expect.element(screen.getByText(score, { exact: true })).toBeVisible();
  }
  await expect.element(screen.getByText("Reviewer 0", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("reviewer-0", { exact: true })).not.toBeInTheDocument();
});

it("mounts only the timeline rows near the viewport of a huge pull request", async () => {
  await using screen = await render(
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={detail}
        environmentId={EnvironmentId.make("environment")}
        reference={detail}
        order="oldest"
        onOpenCommit={() => {}}
        onRefresh={() => {}}
      />
    </div>,
  );
  await expect.element(screen.getByText("Commit number 0")).toBeVisible();
  const mounted = screen.container.querySelectorAll("button").length;
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(COMMITS / 10);
});

it.each(["review", "issue-comment", "resolved-reply"] as const)(
  "reveals a linked %s below the virtual viewport",
  async (kind) => {
    const url = `${detail.url}#${kind === "review" ? "pullrequestreview-123" : kind === "issue-comment" ? "issuecomment-123" : "discussion_r123"}`;
    const linkedDetail: PullRequestDetailView = {
      ...detail,
      comments:
        kind === "resolved-reply"
          ? []
          : [
              {
                id: "linked",
                kind,
                author: detail.author,
                body: "Linked reply",
                createdAt: "2026-10-01T00:00:00Z",
                url,
                path: null,
                reviewState: kind === "review" ? "CHANGES_REQUESTED" : null,
              },
            ],
      reviewThreads:
        kind !== "resolved-reply"
          ? []
          : [
              {
                id: "thread",
                path: "src/test.ts",
                line: 5,
                side: "right",
                isResolved: true,
                isOutdated: false,
                comments: [
                  {
                    id: "root",
                    author: detail.author,
                    body: "Root comment",
                    createdAt: "2026-10-01T00:00:00Z",
                    url: `${detail.url}#discussion_r122`,
                  },
                  {
                    id: "reply",
                    author: detail.author,
                    body: "Linked reply",
                    createdAt: "2026-10-01T00:01:00Z",
                    url,
                  },
                ],
              },
            ],
    };
    const settled = vi.fn();
    await using screen = await render(
      <div style={{ height: 600 }}>
        <PullRequestTimelineTab
          scrollerRef={() => {}}
          detail={linkedDetail}
          environmentId={EnvironmentId.make("environment")}
          reference={detail}
          order="oldest"
          onOpenCommit={() => {}}
          onRefresh={() => {}}
          revealUrl={url}
          onRevealSettled={settled}
        />
      </div>,
    );
    await expect.element(screen.getByText("Linked reply", { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(url));
    await screen.rerender(
      <div style={{ height: 600 }}>
        <PullRequestTimelineTab
          scrollerRef={() => {}}
          detail={linkedDetail}
          environmentId={EnvironmentId.make("environment")}
          reference={detail}
          order="oldest"
          onOpenCommit={() => {}}
          onRefresh={() => {}}
          onRevealSettled={settled}
        />
      </div>,
    );
    await expect.element(screen.getByText("Linked reply", { exact: true })).toBeVisible();
  },
);

it("gives each comment and review a heading for screen reader navigation", async () => {
  const commented: PullRequestDetailView = {
    ...detail,
    commits: [],
    comments: [
      {
        id: "review",
        kind: "review",
        author: { login: "bob", name: null, avatarUrl: null },
        body: "Looks good",
        createdAt: "2026-10-01T00:00:00Z",
        url: `${detail.url}#pullrequestreview-1`,
        path: null,
        reviewState: "APPROVED",
      },
      {
        id: "comment",
        kind: "issue-comment",
        author: { login: "alice", name: null, avatarUrl: null },
        body: "One question",
        createdAt: "2026-10-01T00:01:00Z",
        url: `${detail.url}#issuecomment-2`,
        path: null,
        reviewState: null,
      },
    ],
  };
  await using screen = await render(
    <div style={{ height: 600 }}>
      <PullRequestTimelineTab
        scrollerRef={() => {}}
        detail={commented}
        environmentId={EnvironmentId.make("environment")}
        reference={detail}
        order="oldest"
        onOpenCommit={() => {}}
        onRefresh={() => {}}
      />
    </div>,
  );
  await expect.element(screen.getByRole("heading", { name: /bob approved/i })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /1 comment/ }));
  await expect.element(screen.getByText("One question", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: /alice commented/ })).toBeVisible();
});
