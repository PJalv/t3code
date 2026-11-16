import {
  EnvironmentId,
  type PullRequestListInput,
  type PullRequestListStatsInput,
} from "@t3tools/contracts";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentQueryTarget } from "~/state/pullRequests";
import {
  useRoutePullRequestList,
  useRoutePullRequestListStats,
} from "./useRoutePullRequestQueries";

const queries = vi.hoisted(() => ({ list: vi.fn(), stats: vi.fn() }));
vi.mock("~/state/pullRequests", () => ({
  usePullRequestList: queries.list,
  usePullRequestListStats: queries.stats,
}));

it("unsubscribes every PR query on the Gerrit route and resumes them on return", () => {
  const environmentId = EnvironmentId.make("environment");
  const lists = (["main", "baseline", "authored", "reviewing", "facets"] as const).map((query) => [
    {
      environmentId,
      input: { state: "open", involvement: "all", limit: 99, query } satisfies PullRequestListInput,
    },
  ]);
  const stats: ReadonlyArray<EnvironmentQueryTarget<PullRequestListStatsInput>> = [
    { environmentId, input: { refs: [] } },
  ];
  function Page({ gerrit }: { gerrit: boolean }) {
    useRoutePullRequestList(gerrit, lists[0]!);
    useRoutePullRequestList(gerrit, lists[1]!);
    useRoutePullRequestList(gerrit, lists[2]!);
    useRoutePullRequestList(gerrit, lists[3]!);
    useRoutePullRequestList(gerrit, lists[4]!);
    useRoutePullRequestListStats(gerrit, stats);
    return null;
  }

  queries.list.mockClear();
  queries.stats.mockClear();
  renderToString(<Page gerrit={false} />);
  expect(queries.list.mock.calls.map(([targets]) => targets)).toEqual(lists);
  expect(queries.stats).toHaveBeenLastCalledWith(stats);

  queries.list.mockClear();
  queries.stats.mockClear();
  renderToString(<Page gerrit />);
  expect(queries.list.mock.calls.map(([targets]) => targets)).toEqual([[], [], [], [], []]);
  expect(queries.stats).toHaveBeenLastCalledWith([]);

  queries.list.mockClear();
  queries.stats.mockClear();
  renderToString(<Page gerrit={false} />);
  expect(queries.list.mock.calls.map(([targets]) => targets)).toEqual(lists);
  expect(queries.stats).toHaveBeenLastCalledWith(stats);
});
