import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";
import { PullRequestThreadReply } from "./PullRequestThreadReply";

const mocks = vi.hoisted(() => ({ reply: vi.fn() }));
vi.mock(import("~/state/use-atom-command"), () => ({ useAtomCommand: () => mocks.reply }) as never);
vi.mock(import("~/state/pullRequests"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...((await original()) as object),
    pullRequestEnvironment: {
      replyToThread: { permissionAtom: () => allowed },
      setThreadResolution: { permissionAtom: () => allowed },
    },
  } as never;
});
vi.mock(
  import("~/state/session"),
  async (original) =>
    ({
      ...((await original()) as object),
      useEnvironmentScope: () => true,
      readEnvironmentScope: () => true,
    }) as never,
);
vi.mock(
  import("./PullRequestMarkdownTextarea"),
  () =>
    ({
      pullRequestCompletionScope: () => null,
      PullRequestMarkdownTextarea: (props: {
        value: string;
        onValueChange: (value: string) => void;
        "aria-label": string;
      }) => (
        <textarea
          aria-label={props["aria-label"]}
          value={props.value}
          onChange={(event) => props.onValueChange(event.target.value)}
        />
      ),
    }) as never,
);

const environmentId = EnvironmentId.make("environment");
const reference = { projectId: ProjectId.make("project"), repository: "repo", number: 7 };
const detail = {
  gerrit: {},
  state: "open",
  workspaceRoot: "/repo",
  capabilities: { review: { reply: true, resolveWithReply: true } },
  viewerPermissions: { comment: true, resolve: true },
} as unknown as PullRequestDetailView;

it.each([true, false])("posts one reply with resolve checked=%s", async (checked) => {
  mocks.reply.mockReset().mockResolvedValue({ _tag: "Success" });
  const refresh = vi.fn();
  await using screen = await render(
    <PullRequestThreadReply
      environmentId={environmentId}
      reference={reference}
      detail={detail}
      thread={{ id: "thread", isResolved: false }}
      onRefresh={refresh}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Reply" }));
  const resolve = screen.getByRole("checkbox", { name: "Resolve conversation" });
  await expect.element(resolve).toBeVisible();
  if (checked) await userEvent.click(resolve);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Reply to this conversation" }),
    "A reply",
  );
  await userEvent.click(screen.getByRole("button", { name: "Post reply" }));
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(mocks.reply).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      ...reference,
      threadId: "thread",
      body: "A reply",
      ...(checked ? { resolve: true } : {}),
    },
  });
});

it.each(["resolved", "unsupported"] as const)("hides resolve for %s threads", async (kind) => {
  mocks.reply.mockReset();
  const value =
    kind === "unsupported"
      ? {
          ...detail,
          capabilities: {
            ...detail.capabilities,
            review: { ...detail.capabilities.review, resolveWithReply: false },
          },
        }
      : detail;
  await using screen = await render(
    <PullRequestThreadReply
      environmentId={environmentId}
      reference={reference}
      detail={value}
      thread={{ id: "thread", isResolved: kind === "resolved" }}
      onRefresh={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Reply" }));
  await expect
    .element(screen.getByRole("checkbox", { name: "Resolve conversation" }))
    .not.toBeInTheDocument();
});
