import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import "../../index.css";
import { PullRequestSpeedActions, PullRequestSpeedModeContext } from "./PullRequestSpeedActions";

vi.mock(import("~/state/pullRequests"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return { pullRequestEnvironment: { runAction: { permissionAtom: () => allowed } } } as never;
});
vi.mock(
  import("./usePullRequestActions"),
  () =>
    ({
      usePullRequestActionRunner: () => ({ actionPending: false, perform: vi.fn() }),
      usePullRequestDefaultMergeMethodResolver: () => () => undefined,
    }) as never,
);

it.each([true, false])(
  "gates the Gerrit quick Submit action when submittable=%s",
  async (submittable) => {
    const entry = {
      environmentId: EnvironmentId.make("environment"),
      projectId: ProjectId.make("project"),
      host: "review.example.com",
      repository: "repo",
      number: 7,
      state: "open" as const,
      isDraft: false,
      provider: SourceControlProviderKind.make("gerrit"),
      gerritSubmittable: submittable,
    };
    await using screen = await render(
      <PullRequestSpeedModeContext value={true}>
        <PullRequestSpeedActions
          entry={entry}
          hostActions={new Set(["close", "merge"])}
          terminology={sourceControlClients.get("gerrit").changeRequest}
        />
      </PullRequestSpeedModeContext>,
    );
    await expect.element(screen.getByRole("button", { name: "Abandon #7" })).toBeVisible();
    if (submittable) {
      await expect.element(screen.getByRole("button", { name: "Submit #7" })).toBeVisible();
    } else {
      await expect
        .element(screen.getByRole("button", { name: /^(Submit|Merge) #7$/ }))
        .not.toBeInTheDocument();
    }
  },
);
